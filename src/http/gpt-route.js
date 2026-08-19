// http/gpt-route.js — the gpt-* leg of the one door (DL-4819).
//
// teamclaude is the org's single gateway: a caller says `--model gpt-5.6-sol`
// against the same base URL it uses for Claude, and it works. This module is the
// whole of that: one predicate, one relay, one models-list merge. Everything
// about account selection, quota, the pool, the ledger and the Deck belongs to
// the Claude path and is deliberately untouched — a gpt request is served by a
// subscription-backed sibling proxy on this host, spends none of the Claude pool,
// and so never enters it.
//
// The leg speaks the Anthropic API shape natively (`/v1/messages`, SSE,
// `/v1/messages/count_tokens`), so this is a byte-for-byte relay, not a
// translation. The only rewrite is the credential header: the caller's proxy key
// is replaced by the leg's own.
//
// Dialled with node:http ON PURPOSE. The fork installs undici's EnvHttpProxyAgent
// globally (infra/egress.js) so every `fetch` leaves via the egress sidecar; the
// leg is a same-host tailnet address that must NOT go through it, and NO_PROXY's
// CIDR form is not reliably honoured by that agent. node:http reads no proxy env,
// so this dial is direct by construction rather than by exclusion list.
//
// Rollback: delete this file and its two call sites (http/server.js dispatch,
// http/forward.js models merge). The Claude path is byte-identical without it.
//   covered by: test/gpt-route.test.mjs

import http from 'node:http';
import https from 'node:https';
import { parseRequestModel } from '../model.js';

// Config over code (system-design.md): the leg's address, the family pattern and
// the credential are data. Defaults describe the live D1DX deployment so a plain
// boot needs no config edit; a different host or a second family is a config row,
// never a branch here.
const DEFAULTS = {
  enabled: true,
  match: '^gpt-',
  origin: 'http://100.107.1.17:8317',
  apiKey: 'x',
  timeoutMs: 900000,
  modelsCacheSec: 60,
};

let ROUTE = { ...DEFAULTS, pattern: new RegExp(DEFAULTS.match) };

function envOverride(name) {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

// Resolve once at server construction. Precedence: env → config.gptRoute →
// defaults. An unparseable `match` is a config error the operator must see, so it
// throws at boot rather than silently falling back to the default pattern.
export function configureGptRoute(config = {}) {
  const c = config.gptRoute || {};
  const enabledRaw = envOverride('TEAMCLAUDE_GPT_ENABLED') ?? c.enabled ?? DEFAULTS.enabled;
  const merged = {
    enabled: enabledRaw !== false && enabledRaw !== 'false' && enabledRaw !== '0',
    match: envOverride('TEAMCLAUDE_GPT_MATCH') ?? c.match ?? DEFAULTS.match,
    origin: envOverride('TEAMCLAUDE_GPT_ORIGIN') ?? c.origin ?? DEFAULTS.origin,
    apiKey: envOverride('TEAMCLAUDE_GPT_KEY') ?? c.apiKey ?? DEFAULTS.apiKey,
    timeoutMs: Number(envOverride('TEAMCLAUDE_GPT_TIMEOUT_MS') ?? c.timeoutMs ?? DEFAULTS.timeoutMs),
    modelsCacheSec: Number(c.modelsCacheSec ?? DEFAULTS.modelsCacheSec),
  };
  ROUTE = { ...merged, pattern: new RegExp(merged.match) };
  modelsCache = { at: 0, entries: null };
  return ROUTE;
}

export function gptRouteConfig() {
  return ROUTE;
}

// True when this request names a model of the routed family. The model is read
// with the same byte-exact streaming parser the Claude path uses (model.js), so a
// `"model"` appearing in conversation text can never be mistaken for the field.
export function isGptRequest(body) {
  if (!ROUTE.enabled) return false;
  if (!body || !body.length) return false;
  const model = parseRequestModel(body);
  return typeof model === 'string' && ROUTE.pattern.test(model);
}

function legTarget(path) {
  const url = new URL(ROUTE.origin);
  const isTls = url.protocol === 'https:';
  return {
    mod: isTls ? https : http,
    options: {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isTls ? 443 : 80),
      path: `${url.pathname.replace(/\/$/, '')}${path}`,
      method: 'POST',
    },
  };
}

const DROP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'upgrade', 'proxy-authorization', 'proxy-authenticate', 'content-length',
  'accept-encoding', 'x-api-key', 'authorization',
]);

const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length']);

function errorBody(message) {
  return JSON.stringify({ type: 'error', error: { type: 'proxy_error', message } });
}

// Relay one gpt request to the leg and stream the answer straight back. Streaming
// and non-streaming are the same code path — the leg's bytes are the client's
// bytes. A leg that is down or slow fails loud with a 502 naming it, never a
// silent fall-through onto the Claude pool (which cannot serve this model at all).
export function forwardGptRequest(req, res, body) {
  const { mod, options } = legTarget(req.url);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (DROP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  headers['x-api-key'] = ROUTE.apiKey;
  headers['content-length'] = Buffer.byteLength(body);

  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

    const upstream = mod.request({ ...options, method: req.method, headers }, (up) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (DROP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
        outHeaders[k] = v;
      }
      res.writeHead(up.statusCode || 502, outHeaders);
      up.pipe(res);
      up.on('end', done);
      up.on('error', () => { res.destroy(); done(); });
    });

    // destroy(err) is what turns the timeout into the 502 below — node emits
    // 'error' with the given error. Never reduce this to a bare destroy(): the
    // client would then hang with no response at all.
    upstream.setTimeout(ROUTE.timeoutMs, () => {
      upstream.destroy(new Error(`gpt leg timeout after ${ROUTE.timeoutMs}ms`));
    });

    // A client that hangs up mid-answer — an interrupted agent turn, a closed
    // terminal — must take the leg request down with it. Without this the leg
    // keeps generating into a socket nobody reads until the timeout, and a retry
    // storm stacks those up against a subscription quota.
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });

    upstream.on('error', (err) => {
      console.error(`[TeamClaude] gpt leg error (${ROUTE.origin}):`, err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(errorBody(`gpt leg unreachable at ${ROUTE.origin}: ${err.message}`));
      } else {
        res.destroy();
      }
      done();
    });

    upstream.end(body);
  });
}

// ── /v1/models merge ────────────────────────────────────────────────────────
// The gateway's model list must name every model it can actually serve, or a
// client's model discovery hides half the door. The Claude half comes from the
// forwarded upstream answer; this adds the leg's half, in the same Anthropic
// shape, without a second Claude round-trip. Cached briefly — the leg's catalog
// changes on the order of releases, and a list call must not cost two hops.

let modelsCache = { at: 0, entries: null };

function anthropicShape(entry) {
  const id = entry?.id;
  if (typeof id !== 'string' || !ROUTE.pattern.test(id)) return null;
  const createdSec = Number(entry.created);
  return {
    type: 'model',
    id,
    display_name: id,
    created_at: Number.isFinite(createdSec)
      ? new Date(createdSec * 1000).toISOString()
      : new Date(0).toISOString(),
  };
}

function fetchLegModels() {
  const { mod, options } = legTarget('/v1/models');
  return new Promise((resolve) => {
    const req = mod.request(
      { ...options, method: 'GET', headers: { 'x-api-key': ROUTE.apiKey, accept: 'application/json' } },
      (up) => {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString());
            const list = Array.isArray(parsed?.data) ? parsed.data : [];
            resolve(list.map(anthropicShape).filter(Boolean));
          } catch { resolve(null); }
        });
        up.on('error', () => resolve(null));
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error('models timeout')));
    req.on('error', (err) => {
      console.error(`[TeamClaude] gpt leg models fetch failed (${ROUTE.origin}):`, err.message);
      resolve(null);
    });
    req.end();
  });
}

export async function legModelEntries() {
  if (!ROUTE.enabled) return [];
  const now = Date.now();
  if (modelsCache.entries && now - modelsCache.at < ROUTE.modelsCacheSec * 1000) return modelsCache.entries;
  const entries = await fetchLegModels();
  if (entries) modelsCache = { at: now, entries };
  return entries || modelsCache.entries || [];
}

export function isModelsPath(url) {
  if (!ROUTE.enabled || typeof url !== 'string') return false;
  return url === '/v1/models' || url.startsWith('/v1/models?');
}

// Merge the leg's ids into a forwarded Anthropic models payload. Anything that is
// not the expected `{data:[…]}` JSON — an error body, a non-JSON answer — is
// returned untouched: the merge must never be able to corrupt the Claude answer.
export async function mergeModelsBody(buf) {
  if (!ROUTE.enabled) return buf;
  let parsed;
  try { parsed = JSON.parse(buf.toString()); } catch { return buf; }
  if (!parsed || !Array.isArray(parsed.data)) return buf;
  const entries = await legModelEntries();
  if (!entries.length) return buf;
  const seen = new Set(parsed.data.map((m) => m?.id));
  const added = entries.filter((m) => !seen.has(m.id));
  if (!added.length) return buf;
  parsed.data = [...parsed.data, ...added];
  return Buffer.from(JSON.stringify(parsed));
}

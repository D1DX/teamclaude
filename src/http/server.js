// http/server.js — the proxy's front door: the HTTP listener, the proxy-key auth
// gate, the local health/build endpoints, and the top-level routing that hands
// each request to the ops surface (http/admin.js), the raw token relay, or the
// forwarding path (http/forward.js). Owns nothing about account selection or
// upstream shape — it only routes.
//   covered by: test/all-throttled-hold.test.mjs (drives createProxyServer end
//   to end: auth-exempt localhost, health short-circuit, the /v1/messages path).

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { BUILD } from '../version.js';
import { handleAdminRoute } from './admin.js';
import { forwardRequest, relayRaw, relayStream, isClientCredentialPath, configureForward } from './forward.js';
import { configureProviders, resolveUpstream } from '../providers/provider.js';
import { configureGptRoute, isGptRequest, forwardGptRequest } from './gpt-route.js';
import '../providers/anthropic.js'; // self-registers the default 'anthropic' adapter

// #81 (4fc849a): constant-time proxy-key comparison. A plain `!==` leaks the
// match length via early-exit timing; timingSafeEqual doesn't. Returns false on
// any type/length mismatch (a missing header is `undefined`) before comparing.
export function safeKeyEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function createProxyServer(accountManager, config, hooks = {}) {
  // The default upstream for the RAW passthrough paths (token relay + #83 client-
  // credential streams). The per-account forward path resolves its own origin via
  // the provider adapter (§7); the literal lives once, under providers/.
  const upstream = resolveUpstream(config);
  const proxyApiKey = config.proxy?.apiKey;
  // D1DX (D-1728): per-request full-body dumps are OFF unless `logRequests` is
  // explicitly true. This nulls the dump dir, so all the per-request log-section
  // building + writeRequestLog calls below short-circuit on `if (logDir)`. The
  // daily operational log (switches/throttles/binds/errors) is written separately
  // via the console tee in index.js (resolveLogDir) and is unaffected.
  const logDir = (config.logRequests === true && config.logDir) ? config.logDir : null;
  let requestCounter = 0;

  // D1DX patch (D-1741): resolve the all-throttled hold knobs once, before serving.
  configureForward(config);
  // Provider seam (§7): fold config.upstream into the default adapter's origin.
  configureProviders(config);
  // DL-4819: resolve the gpt-* leg (origin, family pattern, credential) once.
  configureGptRoute(config);

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Auth check — skip for localhost connections
      const clientKey = req.headers['x-api-key'];
      const remoteAddr = req.socket.remoteAddress;
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      if (proxyApiKey && !safeKeyEqual(clientKey, proxyApiKey) && !isLocal) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        }));
        return;
      }

      // Ops surface (/teamclaude/* + /capacity) — served locally, never upstream.
      if (await handleAdminRoute(req, res, { accountManager, config, upstream, reloadAccounts: hooks.reloadAccounts })) return;

      // D1DX patch (D-1903): local health endpoint. A bare `GET`/`HEAD /` (and
      // `/health`) is a connectivity probe Claude Code / monitors fire ~every 30s.
      // Anthropic returns 404 for it, so WITHOUT this short-circuit every probe is
      // forwarded upstream on a real Max account — burning a token refresh + a
      // selection + a real upstream round-trip, AND emitting a
      // `GET / → <acct> (404)` oplog line (23% of the daily log on 2026-06-05) +
      // consuming the all-throttled path during saturation (234 spurious 429s that
      // day). Answer it locally with 200, no routing, and return BEFORE the request
      // counter / onRequest* hooks so it never reaches an account or the log.
      if ((req.method === 'GET' || req.method === 'HEAD') && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok', service: 'teamclaude', build: BUILD }));
        return;
      }

      // Let client token refresh requests pass through to upstream untouched.
      // The proxy manages its own tokens via ensureTokenFresh(); intercepting
      // or rewriting client refreshes would cause token rotation conflicts.
      if (req.method === 'POST' && req.url === '/v1/oauth/token') {
        await relayRaw(req, res, upstream);
        return;
      }

      // #83 (d723417): client-credential passthrough — Remote Control (/v1/code/*)
      // and attachment transfers (/api/oauth/files/*, /api/oauth/file_upload) are
      // bound to the client's own claude.ai identity. Relay them with the client's
      // credential (streamed), never a rotated account token (which 403s). Handled
      // BEFORE the request counter / inference hooks — these are passthroughs, not
      // pooled inference.
      if (isClientCredentialPath(req.url)) {
        await relayStream(req, res, upstream);
        return;
      }

      // Buffer request body (needed for retry on 429, and to read the model)
      const bodyChunks = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk);
      }
      const body = Buffer.concat(bodyChunks);

      // DL-4819 — one door: a request naming a model of the gpt-* family is
      // served by the sibling openai leg on this host, which speaks the same
      // Anthropic shape. It is answered BEFORE the request counter and the
      // inference hooks on purpose: it selects no account, spends no pool quota
      // and books no ledger entry, so counting it as a pool request would put a
      // request the Claude accounts never saw into their books. Proxy-key auth
      // (above) still gates it — the gateway has one front door, not two.
      if (isGptRequest(body)) {
        await forwardGptRequest(req, res, body);
        return;
      }

      // Track request
      const reqId = ++requestCounter;
      hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

      const ctx = { account: null, status: null };
      try {
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error('[TeamClaude] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'proxy_error', message: 'Internal proxy error' },
          }));
        }
      } finally {
        hooks.onRequestEnd?.(reqId, {
          method: req.method, path: req.url,
          account: ctx.account, status: ctx.status,
        });
      }
    } catch (err) {
      console.error('[TeamClaude] Unhandled error:', err);
    }
  });

  return server;
}

import http from 'node:http';
import { createProxyServer } from '../src/http/server.js';

// DL-4819 — one door: the gateway serves the gpt-* family from the sibling
// openai leg on the same host, and publishes those ids in /v1/models beside the
// Claude ids. What must hold:
//   • a gpt-* model goes to the LEG, with the LEG's credential, never to a Claude
//     account (which cannot serve it);
//   • a Claude model still goes to the Claude upstream with the pooled account
//     token — the route must not bleed into the pooled path;
//   • streamed bytes survive byte-exact;
//   • /v1/models carries BOTH families;
//   • a non-`{data:[…]}` models body is returned untouched (the merge can never
//     corrupt the Claude answer);
//   • a dead leg fails loud with a 502 naming it, never a silent fall-through.

// Env overrides outrank config by design; a stray one would silently re-point
// these fixtures at the live deployment.
for (const k of ['TEAMCLAUDE_GPT_ORIGIN', 'TEAMCLAUDE_GPT_MATCH', 'TEAMCLAUDE_GPT_KEY', 'TEAMCLAUDE_GPT_ENABLED', 'TEAMCLAUDE_GPT_TIMEOUT_MS']) {
  delete process.env[k];
}

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const ACCT_TOKEN = 'acct-pooled-token';
const LEG_KEY = 'leg-static-key';
const SSE = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

function makeAM() {
  return {
    accounts: [{ index: 0, name: 'a0', type: 'oauth', credential: ACCT_TOKEN, status: 'active', quota: {} }],
    switchThreshold: 0.98,
    selected: 0,
    getAccountForSession() { this.selected++; return this.accounts[0]; },
    ensureTokenFresh() {}, updateQuota() {}, markRateLimited() {},
    noteSuccess() {}, noteAccountSuccess() {}, updateUsage() {}, getStatus() { return {}; },
    noteInflightStart() {}, noteInflightEnd() {},
    tryReserveInflight() { return true; },
    allThrottledBackoff() { return 1; }, allHardCapped() { return false; },
  };
}

// Mock Claude upstream: /v1/models → an Anthropic-shape list; else echo what it saw.
function startUpstream() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5' }], has_more: false }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ served_by: 'claude-upstream', sawAuth: req.headers['authorization'] || null }));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// Mock openai leg: speaks the Anthropic shape, records the credential it saw.
function startLeg() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.6-sol', created: 1783616400, object: 'model', owned_by: 'openai' }] }));
        return;
      }
      if (b.includes('"stream":true')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(SSE);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        served_by: 'gpt-leg',
        sawKey: req.headers['x-api-key'] || null,
        sawVersion: req.headers['anthropic-version'] || null,
        sawPath: req.url,
      }));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function startProxy(am, upstreamPort, legOrigin) {
  const server = createProxyServer(am, {
    upstream: `http://127.0.0.1:${upstreamPort}`,
    proxy: {},
    gptRoute: { origin: legOrigin, apiKey: LEG_KEY, modelsCacheSec: 0 },
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

function req(port, path, method = 'GET', payload = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(payload === null ? undefined : JSON.stringify(payload));
  });
}

const upstream = await startUpstream();
const upPort = upstream.address().port;
const leg = await startLeg();
const legOrigin = `http://127.0.0.1:${leg.address().port}`;

// ── a gpt-* model is served by the leg, with the LEG's credential ────────────
{
  const am = makeAM();
  const proxy = await startProxy(am, upPort, legOrigin);
  const { status, buf } = await req(proxy.address().port, '/v1/messages', 'POST',
    { model: 'gpt-5.6-sol', max_tokens: 16, messages: [{ role: 'user', content: 'say ok' }] });
  const j = JSON.parse(buf.toString());
  ok('gpt-* model reached the leg', status === 200 && j.served_by === 'gpt-leg');
  ok('gpt-* request carried the leg credential', j.sawKey === LEG_KEY);
  ok('gpt-* request kept the anthropic-version header', j.sawVersion === '2023-06-01');
  ok('gpt-* request kept its path', j.sawPath === '/v1/messages');
  ok('gpt-* request selected NO Claude account', am.selected === 0);
  proxy.close();
}

// ── /v1/messages/count_tokens on a gpt model routes the same way ─────────────
{
  const am = makeAM();
  const proxy = await startProxy(am, upPort, legOrigin);
  const { buf } = await req(proxy.address().port, '/v1/messages/count_tokens', 'POST',
    { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] });
  const j = JSON.parse(buf.toString());
  ok('count_tokens on a gpt model reached the leg', j.served_by === 'gpt-leg' && j.sawPath === '/v1/messages/count_tokens');
  ok('count_tokens on a gpt model selected NO Claude account', am.selected === 0);
  proxy.close();
}

// ── streamed bytes survive the relay byte-exact ──────────────────────────────
{
  const proxy = await startProxy(makeAM(), upPort, legOrigin);
  const { status, buf } = await req(proxy.address().port, '/v1/messages', 'POST',
    { model: 'gpt-5.6-sol', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'say ok' }] });
  ok('streamed gpt response relayed byte-exact', status === 200 && buf.toString() === SSE);
  proxy.close();
}

// ── REGRESSION: a Claude model still takes the pooled path ───────────────────
{
  const am = makeAM();
  const proxy = await startProxy(am, upPort, legOrigin);
  const { status, buf } = await req(proxy.address().port, '/v1/messages', 'POST',
    { model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'say ok' }] });
  const j = JSON.parse(buf.toString());
  ok('claude model still served by the Claude upstream', status === 200 && j.served_by === 'claude-upstream');
  ok('claude model still carries the pooled account token', j.sawAuth === `Bearer ${ACCT_TOKEN}`);
  ok('claude model still selects an account', am.selected === 1);
  proxy.close();
}

// ── a model merely CONTAINING "gpt-" is not the gpt family ───────────────────
{
  const proxy = await startProxy(makeAM(), upPort, legOrigin);
  const { buf } = await req(proxy.address().port, '/v1/messages', 'POST',
    { model: 'claude-not-gpt-5', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] });
  ok('anchored match — "claude-not-gpt-5" stays on the Claude path', JSON.parse(buf.toString()).served_by === 'claude-upstream');
  proxy.close();
}

// ── /v1/models carries BOTH families ─────────────────────────────────────────
{
  const proxy = await startProxy(makeAM(), upPort, legOrigin);
  const { status, buf } = await req(proxy.address().port, '/v1/models');
  const j = JSON.parse(buf.toString());
  const ids = j.data.map(m => m.id);
  ok('/v1/models still lists the claude ids', status === 200 && ids.includes('claude-opus-5'));
  ok('/v1/models now lists the gpt ids', ids.includes('gpt-5.6-sol'));
  ok('/v1/models gpt entries carry the Anthropic model shape',
    j.data.find(m => m.id === 'gpt-5.6-sol')?.type === 'model');
  ok('/v1/models keeps the rest of the upstream payload', j.has_more === false);
  proxy.close();
}

// ── a models body that is not `{data:[…]}` is returned untouched ─────────────
{
  const odd = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not json at all');
  });
  await new Promise(r => odd.listen(0, '127.0.0.1', r));
  const proxy = await startProxy(makeAM(), odd.address().port, legOrigin);
  const { buf } = await req(proxy.address().port, '/v1/models');
  ok('non-JSON models body passes through untouched', buf.toString() === 'not json at all');
  proxy.close(); odd.close();
}

// ── a dead leg fails loud, and never falls through to a Claude account ───────
{
  const am = makeAM();
  const proxy = await startProxy(am, upPort, 'http://127.0.0.1:1');
  const { status, buf } = await req(proxy.address().port, '/v1/messages', 'POST',
    { model: 'gpt-5.6-sol', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] });
  const j = JSON.parse(buf.toString());
  ok('dead leg returns 502, not a Claude answer', status === 502 && j.error?.type === 'proxy_error');
  ok('dead leg names the leg in the error', /127\.0\.0\.1:1/.test(j.error.message));
  ok('dead leg did NOT fall through to a Claude account', am.selected === 0);
  proxy.close();
}

// ── a dead leg leaves the models merge harmless ──────────────────────────────
{
  const proxy = await startProxy(makeAM(), upPort, 'http://127.0.0.1:1');
  const { status, buf } = await req(proxy.address().port, '/v1/models');
  const ids = JSON.parse(buf.toString()).data.map(m => m.id);
  ok('dead leg still serves the claude model list', status === 200 && ids.includes('claude-opus-5'));
  proxy.close();
}

upstream.close();
leg.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

import http from 'node:http';
import { createProxyServer } from '../src/http/server.js';

// DL-3106 parity DoD: the per-account override (D-2655 GLM/OpenRouter apikey leg)
// behaves IDENTICALLY after the provider-seam extraction. Drives a real proxy end
// to end with a mock upstream that ECHOES what it received, and asserts the seam
// reproduces the pre-seam outbound shape byte-for-byte: the account's own upstream
// origin, Bearer auth (no x-api-key), and the body's model + provider rewritten.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

// Mock upstream: echoes the path, the Authorization + x-api-key it saw, and the
// received JSON body (so we can prove model/provider were rewritten).
function startUpstream() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      let body = null; try { body = JSON.parse(b || '{}'); } catch { body = { _unparsed: b }; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, type: 'message',
        sawPath: req.url,
        sawAuth: req.headers['authorization'] || null,
        sawApiKey: req.headers['x-api-key'] || null,
        sawModel: body.model ?? null,
        sawProvider: body.provider ?? null,
      }));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// Stub AccountManager serving ONE D-2655 apikey account whose own upstream is the
// mock. The seam's baseUrl(account) must route to account.upstream, so the mock
// port is injected at request time via the account record.
function makeAM(account) {
  return {
    accounts: [account],
    switchThreshold: 0.98,
    getAccountForSession() { return account; },
    ensureTokenFresh() {}, updateQuota() {}, markRateLimited() {},
    noteSuccess() {}, noteAccountSuccess() {}, updateUsage() {}, getStatus() { return {}; },
    noteInflightStart() {}, noteInflightEnd() {},
    tryReserveInflight() { return true; },
    allThrottledBackoff() { return 1; }, allHardCapped() { return false; },
  };
}

function startProxy(am, upstreamPort) {
  // config.upstream = the DEFAULT (anthropic-equivalent) origin; the D-2655 account
  // overrides it with its OWN upstream, which the seam must honor.
  const server = createProxyServer(am, { upstream: 'http://127.0.0.1:1', proxy: {} });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

function req(port, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj);
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'proxy-key-from-client' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

const upstream = await startUpstream();
const upPort = upstream.address().port;

// ── D-2655 apikey leg: model + provider rewrite, alt upstream, Bearer auth ────
{
  const glm = {
    index: 0, name: 'glm-openrouter', type: 'apikey', status: 'active', quota: {},
    credential: 'glm-key', upstream: `http://127.0.0.1:${upPort}`,
    model: 'z-ai/glm-5.2', provider: 'z-ai',
  };
  const proxy = await startProxy(makeAM(glm), upPort);
  const { status, json } = await req(proxy.address().port, '/v1/messages', { model: 'claude-sonnet-5', messages: [] });
  ok('D-2655 leg reaches its OWN upstream (baseUrl honored the override)', status === 200 && json.sawPath === '/v1/messages');
  ok('D-2655 leg rewrote body.model to the account model', json.sawModel === 'z-ai/glm-5.2');
  ok('D-2655 leg pinned body.provider (OpenRouter routing)', json.sawProvider === 'z-ai');
  ok('D-2655 leg sent Bearer auth', json.sawAuth === 'Bearer glm-key');
  ok('D-2655 leg sent NO x-api-key (proxy key stripped, not forwarded)', json.sawApiKey === null);
  proxy.close();
}

upstream.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

import http from 'node:http';
import { createProxyServer } from '../src/server.js';

// D1DX (D-1741): all-throttled HOLD-and-wait. Integration test — spins the real
// proxy with a stub AccountManager + a mock upstream, drives /v1/messages and a
// non-inference path, and asserts the proxy HOLDS instead of returning an
// agent-aborting 429. Timing margins are generous (this Mac runs many sessions).
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

// Stub AccountManager exposing only what forwardRequest/holdForThrottle touch.
function makeAM({ account = null, hardCapped = false, backoff = 1 } = {}) {
  return {
    accounts: [{
      index: 0, name: 'a0', type: 'oauth', credential: 'tok', status: 'active',
      quota: hardCapped ? { unifiedStatus: 'rejected' } : {},
    }],
    switchThreshold: 0.98,
    _account: account,
    getAccountForSession() { return this._account; },
    allThrottledBackoff() { return backoff; },
    allHardCapped() { return hardCapped; }, // D1DX (D-2179): folded into the class
    ensureTokenFresh() {}, updateQuota() {}, markRateLimited() {},
    noteSuccess() {}, noteAccountSuccess() {}, updateUsage() {}, getStatus() { return {}; },
    noteInflightStart() {}, noteInflightEnd() {}, // D1DX (D-1903)
    atInflightCap() { return false; }, // D1DX (D-2226): legacy, superseded by tryReserveInflight
    tryReserveInflight() { return true; }, // D-2286: atomic dispatch probe-gate — reserve succeeds by default
  };
}

// Mock upstream that returns 200 JSON for any request.
function startUpstream() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, type: 'message' }));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function startProxy(am, upstreamPort, cfg = {}) {
  const server = createProxyServer(am, {
    upstream: `http://127.0.0.1:${upstreamPort}`,
    proxy: {},
    allThrottledHoldBudgetSec: 0.6,
    holdPollSec: 0.2,
    ...cfg,
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// Fire one request, return { status, ms }.
function req(port, path, method = 'POST') {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method,
      headers: { 'content-type': 'application/json' } }, res => {
      res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - start }));
    });
    r.on('error', reject);
    r.end(method === 'GET' ? undefined : JSON.stringify({ model: 'x', messages: [] }));
  });
}

const upstream = await startUpstream();
const upPort = upstream.address().port;

// ── Case A: inference, all throttled, never recovers → HELD to budget, then 429 ──
{
  const am = makeAM({ account: null, hardCapped: false });
  const proxy = await startProxy(am, upPort);
  const { status, ms } = await req(proxy.address().port, '/v1/messages?beta=true');
  ok('A inference held (not immediate) then 429 at budget', status === 429 && ms >= 450);
  proxy.close();
}

// ── Case B: NON-inference path → immediate 429 (no hold) ────────────────────
{
  const am = makeAM({ account: null, hardCapped: false });
  const proxy = await startProxy(am, upPort);
  const { status, ms } = await req(proxy.address().port, '/v1/foo');
  ok('B non-inference returns immediate 429 (< one poll)', status === 429 && ms < 150);
  proxy.close();
}

// ── Case C: inference, genuinely hard-capped → immediate 429 (no pointless hold) ──
{
  const am = makeAM({ account: null, hardCapped: true });
  const proxy = await startProxy(am, upPort);
  const { status, ms } = await req(proxy.address().port, '/v1/messages');
  ok('C genuine hard-cap returns immediate 429 (< one poll)', status === 429 && ms < 150);
  proxy.close();
}

// ── Case D: inference, throttled then an account frees mid-hold → HELD then 200 ──
{
  const am = makeAM({ account: null, hardCapped: false });
  const proxy = await startProxy(am, upPort);
  setTimeout(() => { am._account = am.accounts[0]; }, 200); // recovers within budget
  const { status, ms } = await req(proxy.address().port, '/v1/messages');
  ok('D held through transient throttle, served 200 on recovery', status === 200 && ms >= 150);
  proxy.close();
}

// ── Case E (D-2226/D-2286): account available but AT the in-flight cap → HELD for a
//    slot on its OWN account (probe-gate hold, no rebind), then 200 when a slot frees ──
{
  const am = makeAM({ account: null });
  am._account = am.accounts[0];                 // the account IS available...
  let capped = true;
  am.tryReserveInflight = () => !capped;        // ...but saturated → the probe-gate holds (D-2286)
  setTimeout(() => { capped = false; }, 200);   // one of its in-flight requests finishes
  const proxy = await startProxy(am, upPort);
  const { status, ms } = await req(proxy.address().port, '/v1/messages');
  ok('E warm-slot held until a slot frees, then served 200 (no rebind)', status === 200 && ms >= 150);
  proxy.close();
}

upstream.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

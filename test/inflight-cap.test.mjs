import http from 'node:http';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';

// D1DX (D-1903): two changes.
//   A) local GET/HEAD / (+ /health) health endpoint — answered locally with 200,
//      never routed to an account / never forwarded upstream / never logged.
//   B) per-account concurrent in-flight cap — _pickAccountForBinding steers a new
//      binding off an account already at the in-flight cap so bursts spread.
// No real network: a mock upstream with a hit-counter proves health never routes,
// and the cap is unit-tested directly on AccountManager.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

// ── Part A: health endpoint (integration) ───────────────────────────────────

// Mock upstream that counts every request it receives + returns 200 JSON.
function startUpstream() {
  const state = { hits: 0 };
  const srv = http.createServer((req, res) => {
    state.hits++;
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, type: 'message' }));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, state })));
}

// Stub AM exposing only what forwardRequest touches when a request DOES route.
function makeAM() {
  const acct = { index: 0, name: 'a0', type: 'oauth', credential: 'tok', status: 'active', quota: {} };
  return {
    accounts: [acct],
    switchThreshold: 0.98,
    getAccountForSession() { return acct; },
    ensureTokenFresh() {}, updateQuota() {}, markRateLimited() {},
    noteSuccess() {}, noteAccountSuccess() {}, updateUsage() {}, getStatus() { return { ok: true }; },
    noteInflightStart() {}, noteInflightEnd() {},
  };
}

function startProxy(am, upstreamPort) {
  const server = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, proxy: {} });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

function req(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method,
      headers: { 'content-type': 'application/json' } }, res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.end(method === 'POST' ? JSON.stringify({ model: 'x', messages: [] }) : undefined);
  });
}

{
  const { srv: upstream, state } = await startUpstream();
  const proxy = await startProxy(makeAM(), upstream.address().port);
  const port = proxy.address().port;

  const g = await req(port, '/', 'GET');
  ok('GET / → 200', g.status === 200);
  ok('GET / body is local ok payload', g.body.includes('"status":"ok"') && g.body.includes('teamclaude'));

  const h = await req(port, '/', 'HEAD');
  ok('HEAD / → 200', h.status === 200);

  const hp = await req(port, '/health', 'GET');
  ok('GET /health → 200', hp.status === 200);

  ok('health probes NEVER reach upstream (no account routing)', state.hits === 0);

  // Control: a real inference request DOES route to upstream.
  const m = await req(port, '/v1/messages', 'POST');
  ok('POST /v1/messages → 200 (control: routes upstream)', m.status === 200);
  ok('control request DID reach upstream', state.hits === 1);

  proxy.close(); upstream.close();
}

// ── Part B: per-account in-flight cap (unit) ─────────────────────────────────

const DAY = 86400000;
const mk = () => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, 0.20);

// Make a1 the highest weekly-urgency account (soonest reset, below cap).
function urgencyRig(am) {
  const now = Date.now();
  am.accounts[0].quota.unified7d = 0.10; am.accounts[0].quota.unified7dReset = now + 6 * DAY;
  am.accounts[1].quota.unified7d = 0.15; am.accounts[1].quota.unified7dReset = now + 2 * DAY; // highest urgency
  am.accounts[2].quota.unified7d = 0.10; am.accounts[2].quota.unified7dReset = now + 6 * DAY;
}

// inc/dec/clamp
{ const am = mk();
  am.noteInflightStart(0); am.noteInflightStart(0);
  ok('noteInflightStart increments', am.accounts[0]._inflight === 2);
  am.noteInflightEnd(0);
  ok('noteInflightEnd decrements', am.accounts[0]._inflight === 1);
  am.noteInflightEnd(0); am.noteInflightEnd(0);
  ok('noteInflightEnd clamps at 0 (never negative)', am.accounts[0]._inflight === 0);
  am.noteInflightStart(99); // out of range — must not throw
  ok('noteInflight* tolerates out-of-range index', true); }

// control: with no in-flight pressure, the highest-urgency account wins the bind
{ const am = mk(); urgencyRig(am);
  ok('binds highest-urgency acct when none slammed', am._pickAccountForBinding().name === 'a1'); }

// the in-flight cap steers a NEW bind off the slammed (but highest-urgency) acct
{ const am = mk(); urgencyRig(am); am.maxInFlightPerAccount = 1;
  am.accounts[1]._inflight = 1; // a1 at cap
  ok('bind avoids the in-flight-capped acct even though it is highest urgency',
     am._pickAccountForBinding().name !== 'a1'); }

// all usable accounts at the cap → keep work flowing: highest-urgency (ranked[0])
{ const am = mk(); urgencyRig(am); am.maxInFlightPerAccount = 1;
  am.accounts[0]._inflight = 1; am.accounts[1]._inflight = 1; am.accounts[2]._inflight = 1;
  ok('all at cap → falls back to highest-urgency (never refuses)',
     am._pickAccountForBinding().name === 'a1'); }

// all over cap, unequal → fallback picks the LEAST in-flight (spreads the burst)
{ const am = mk(); urgencyRig(am); am.maxInFlightPerAccount = 1;
  am.accounts[0]._inflight = 1; am.accounts[1]._inflight = 3; am.accounts[2]._inflight = 1;
  ok('all over cap → fallback picks least-in-flight (not the most-loaded a1)',
     am._pickAccountForBinding().name !== 'a1'); }

// getStatus exposes the live in-flight count
{ const am = mk(); am.accounts[0]._inflight = 3;
  const a0 = am.getStatus().accounts.find(a => a.name === 'a0');
  ok('getStatus exposes inflight', a0.inflight === 3); }

// default cap is set from constructor
{ const am = mk();
  ok('maxInFlightPerAccount has a sane default', am.maxInFlightPerAccount === 6); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

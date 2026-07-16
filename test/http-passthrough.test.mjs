import http from 'node:http';
import { createProxyServer } from '../src/http/server.js';

// #83 (d723417): client-credential passthrough. /v1/code/* (Remote Control) and
// /api/oauth/files/* + /api/oauth/file_upload (attachments) are bound to the
// CLIENT's own claude.ai identity — forwarding them with a rotated ACCOUNT token
// 403s upstream (Remote Control stream dies; Claude Code silently drops the image).
// These must relay the client's OWN Authorization untouched, streamed (binary-safe).
// The mock upstream ECHOES the Authorization it received, so we can prove which
// credential reached it; a stub account carries a DIFFERENT token so a rewrite is
// detectable.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const ACCT_TOKEN = 'acct-pooled-token';
const CLIENT_TOKEN = 'client-oauth-token-XYZ';

// Stub AccountManager: one oauth account whose credential differs from the client's.
function makeAM() {
  return {
    accounts: [{ index: 0, name: 'a0', type: 'oauth', credential: ACCT_TOKEN, status: 'active', quota: {} }],
    switchThreshold: 0.98,
    getAccountForSession() { return this.accounts[0]; },
    ensureTokenFresh() {}, updateQuota() {}, markRateLimited() {},
    noteSuccess() {}, noteAccountSuccess() {}, updateUsage() {}, getStatus() { return {}; },
    noteInflightStart() {}, noteInflightEnd() {},
    tryReserveInflight() { return true; },
    allThrottledBackoff() { return 1; }, allHardCapped() { return false; },
  };
}

// Mock upstream: /binary → raw bytes; else JSON echoing the Authorization it saw.
const BINARY = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0xfe, 0x01, 0xc3]); // non-utf8 bytes
function startUpstream() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      if (req.url.includes('/binary')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(BINARY);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sawAuth: req.headers['authorization'] || null, sawPath: req.url }));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function startProxy(am, upstreamPort) {
  const server = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, proxy: {} });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// Fire a request carrying the client's OWN Authorization; collect the raw body Buffer.
function req(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method,
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${CLIENT_TOKEN}` } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(method === 'GET' ? undefined : JSON.stringify({ model: 'x', messages: [] }));
  });
}

const upstream = await startUpstream();
const upPort = upstream.address().port;

// ── /v1/code/* relays the CLIENT credential, not the account token ───────────
{
  const proxy = await startProxy(makeAM(), upPort);
  const { status, buf } = await req(proxy.address().port, '/v1/code/control/stream');
  const j = JSON.parse(buf.toString());
  ok('/v1/code/* relayed (200, not 403)', status === 200);
  ok('/v1/code/* forwarded the CLIENT Authorization untouched', j.sawAuth === `Bearer ${CLIENT_TOKEN}`);
  ok('/v1/code/* did NOT inject the pooled account token', j.sawAuth !== `Bearer ${ACCT_TOKEN}`);
  proxy.close();
}

// ── /api/oauth/files/* (attachment download) relays the client credential ────
{
  const proxy = await startProxy(makeAM(), upPort);
  const { status, buf } = await req(proxy.address().port, '/api/oauth/files/abc-uuid/content');
  const j = JSON.parse(buf.toString());
  ok('/api/oauth/files/* relayed with client credential', status === 200 && j.sawAuth === `Bearer ${CLIENT_TOKEN}`);
  proxy.close();
}

// ── /api/oauth/file_upload (attachment upload) relays the client credential ──
{
  const proxy = await startProxy(makeAM(), upPort);
  const { status, buf } = await req(proxy.address().port, '/api/oauth/file_upload', 'POST');
  const j = JSON.parse(buf.toString());
  ok('/api/oauth/file_upload relayed with client credential', status === 200 && j.sawAuth === `Bearer ${CLIENT_TOKEN}`);
  proxy.close();
}

// ── attachment bytes survive the relay byte-exact (streamed, not .text()) ────
{
  const proxy = await startProxy(makeAM(), upPort);
  const { status, buf } = await req(proxy.address().port, '/api/oauth/files/abc-uuid/binary');
  ok('binary attachment body relayed byte-exact (no text corruption)', status === 200 && buf.equals(BINARY));
  proxy.close();
}

// ── REGRESSION: a normal /v1/messages still gets the ACCOUNT token (the
//    passthrough must not bleed into the pooled inference path) ──────────────
{
  const proxy = await startProxy(makeAM(), upPort);
  const { status, buf } = await req(proxy.address().port, '/v1/messages', 'POST');
  const j = JSON.parse(buf.toString());
  ok('/v1/messages still rewrites to the pooled account token', status === 200 && j.sawAuth === `Bearer ${ACCT_TOKEN}`);
  ok('/v1/messages did NOT leak the client credential upstream', j.sawAuth !== `Bearer ${CLIENT_TOKEN}`);
  proxy.close();
}

upstream.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

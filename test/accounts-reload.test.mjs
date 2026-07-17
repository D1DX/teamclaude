import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/http/server.js';
import { syncAccountsFromDisk } from '../src/cli/shared.js';

// DL-2931: POST /teamclaude/accounts/reload hot-adds accounts discovered on disk
// into a RUNNING proxy — no restart. Proven end to end here: a real
// createProxyServer on an ephemeral port, an account added to the disk config
// after boot, one POST, and the live AccountManager grown by one. warmOne is
// stubbed so the sync's post-add warm never touches the network.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const post = (port, path) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.end();
});

const listen = (server) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// ── the wired path: reload adds a disk-discovered account with no restart ──────
{
  const am = new AccountManager([
    { name: 'first', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  ], 0.98);
  am.warmOne = async () => 200; // no network

  // In-memory config mirrors the running pool; the disk config is what a reload
  // re-reads. Start them equal, then a "new account lands on disk" post-boot.
  const memConfig = { accounts: [{ name: 'first', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 }], upstream: 'https://example.invalid' };
  const diskConfig = { accounts: [...memConfig.accounts] };

  const hooks = {
    reloadAccounts: async () => syncAccountsFromDisk(diskConfig, memConfig, am),
  };
  const server = createProxyServer(am, { upstream: 'https://example.invalid' }, hooks);
  const port = await listen(server);

  ok('pool starts with 1 account', am.accounts.length === 1);

  // Operator drops a second account into the on-disk config while the proxy runs.
  diskConfig.accounts.push({ name: 'second', type: 'oauth', accessToken: 'y', refreshToken: 'r2', expiresAt: Date.now() + 1e9 });

  const res = await post(port, '/teamclaude/accounts/reload');
  const json = JSON.parse(res.body);

  ok('reload returns 200', res.status === 200);
  ok('reload reports reloaded:true', json.reloaded === true);
  ok('reload reports added:1', json.added === 1);
  ok('reload echoes the new pool size (2)', json.accounts === 2);
  ok('reload carries the build', typeof json.build === 'string');
  ok('the RUNNING pool grew without a restart', am.accounts.length === 2);
  ok('the new account is live in the pool', am.accounts.some(a => a.name === 'second'));

  // A second reload with no disk change is a no-op (idempotent).
  const res2 = await post(port, '/teamclaude/accounts/reload');
  const json2 = JSON.parse(res2.body);
  ok('a no-change reload adds 0', json2.added === 0);
  ok('pool size stable on the no-op reload', am.accounts.length === 2);

  server.close();
}

// ── the unwired guard: no injected closure → 503, never a crash ───────────────
{
  const am = new AccountManager([
    { name: 'only', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  ], 0.98);
  const server = createProxyServer(am, { upstream: 'https://example.invalid' }, {}); // no reloadAccounts
  const port = await listen(server);

  const res = await post(port, '/teamclaude/accounts/reload');
  ok('unwired reload returns 503', res.status === 503);
  ok('pool untouched when reload is unwired', am.accounts.length === 1);

  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

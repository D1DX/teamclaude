import { saveConfig, saveConfigSync, loadConfig } from '../src/config.js';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// D-2286: the regression test for the recurring `invalid_grant` account deaths.
// Anthropic rotates the refresh token on refresh; onTokenRefresh mirrors the rotated
// token into the in-memory config synchronously but writes disk ASYNC. If the proxy
// exits (Deck quit / SIGINT / SIGTERM) before that async write lands, the next boot
// loads the OLD (rotated, now-invalid) refresh token → invalid_grant kills the grant.
// saveConfigSync is the sync exit-path flush that closes the window. This test proves
// it persists the rotated token AND is genuinely synchronous.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const dir = mkdtempSync(join(tmpdir(), 'tc-flush-'));
process.env.TEAMCLAUDE_CONFIG = join(dir, 'teamclaude.json');
const cfgPath = process.env.TEAMCLAUDE_CONFIG;

// ── seed: an oauth account on its OLD refresh token, written to disk ──────────
const cfg = {
  proxy: { port: 3456, apiKey: 'tc-seed' },
  upstream: 'https://api.anthropic.com',
  accounts: [
    { name: 'cherry', type: 'oauth', accountUuid: 'uuid-cherry', accessToken: 'AT_old', refreshToken: 'RT_old', expiresAt: 1000 },
    { name: 'apple',  type: 'oauth', accountUuid: 'uuid-apple',  accessToken: 'AT_a',   refreshToken: 'RT_a',   expiresAt: 1000 },
  ],
};
await saveConfig(cfg);

// ── a token refresh rotates cherry; onTokenRefresh mirrors it into the in-memory
//    config object (what index.js does synchronously), but the async disk write is
//    "in flight" when the operator quits the Deck to restart ──────────────────
cfg.accounts[0].accessToken = 'AT_new';
cfg.accounts[0].refreshToken = 'RT_new';
cfg.accounts[0].expiresAt = 9_999_999;

// the exit-path sync flush MUST land RT_new before the process would die
const ret = saveConfigSync(cfg);

const onDisk = JSON.parse(readFileSync(cfgPath, 'utf-8'));
ok('sync flush persists the ROTATED refresh token (not the stale one)', onDisk.accounts[0].refreshToken === 'RT_new');
ok('sync flush persists the rotated access token + expiry', onDisk.accounts[0].accessToken === 'AT_new' && onDisk.accounts[0].expiresAt === 9_999_999);
ok('untouched account is preserved verbatim', onDisk.accounts[1].refreshToken === 'RT_a' && onDisk.accounts[1].name === 'apple');
ok('config shape intact (proxy/key/upstream survive the flush)', onDisk.proxy.apiKey === 'tc-seed' && onDisk.upstream === 'https://api.anthropic.com');
ok('file written with 0600 perms (secret hygiene preserved)', (statSync(cfgPath).mode & 0o777) === 0o600);

// ── the writer must be SYNCHRONOUS — an async write would not complete before
//    process.exit() on the exit path (the whole point) ─────────────────────────
ok('saveConfigSync returns undefined (not a Promise)', ret === undefined || typeof ret?.then !== 'function');

// ── round-trips back through the async loader cleanly ────────────────────────
const reloaded = await loadConfig();
ok('async loadConfig reads the sync-flushed file', reloaded.accounts[0].refreshToken === 'RT_new');

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

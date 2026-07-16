import { saveConfig, loadConfig, atomicConfigUpdate, saveConfigSync } from '../src/config.js';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DL-3024/DL-3101: the regression test for the 2026-07-16 03:37:47 mass invalid_grant burst.
//
// Mechanism (from DL-3024): at boot `warmAll` refreshes every expired OAuth account
// CONCURRENTLY (Promise.all). Anthropic rotates the refresh token on each refresh and
// invalidates the prior one; each success fires onTokenRefresh → atomicConfigUpdate — an
// async read-modify-write. Before F1 there was NO in-process serialization and the disk
// write was a non-atomic `writeFile`, so:
//   (a) LOST UPDATE — 10 read-modify-write cycles interleave; a later writer reads a disk
//       snapshot taken before an earlier writer's rotation landed, then overwrites it →
//       rotations stranded stale on disk (7 of 10 in the incident). The next boot presents
//       the rotated-away (now-invalid) refresh tokens → mass invalid_grant.
//   (b) TORN READ — a concurrent reader parsed a half-written file:
//       "Failed to save refreshed token: Unexpected end of JSON input" (log line 20, 03:37:47).
//
// F1 fix: one in-process promise-chain queue serializes every write path + tmp+rename atomic
// disk writes. This test drives 10 concurrent onTokenRefresh-shaped updates PLUS a swarm of
// concurrent readers and proves BOTH failure modes are closed.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const dir = mkdtempSync(join(tmpdir(), 'tc-race-'));
process.env.TEAMCLAUDE_CONFIG = join(dir, 'teamclaude.json');
const cfgPath = process.env.TEAMCLAUDE_CONFIG;

const N = 10;
const names = ['daniel', 'apple', 'banana', 'mango', 'kiwi', 'cherry', 'grape', 'lychee', 'orange', 'peach'];

// ── seed: 10 oauth accounts on their OLD (pre-boot) tokens, written to disk ──────
const seed = {
  proxy: { port: 3456, apiKey: 'tc-seed' },
  upstream: 'https://api.anthropic.com',
  accounts: names.map((name, i) => ({
    name, type: 'oauth', accountUuid: `uuid-${name}`,
    accessToken: `AT_old_${i}`, refreshToken: `RT_old_${i}`, expiresAt: 1000,
  })),
};
await saveConfig(seed);

// ── the boot-warm storm: 10 refreshes complete "at once", each firing an
//    onTokenRefresh-shaped atomicConfigUpdate that writes ONE account's rotated
//    tokens (matched by accountUuid, index-shift-safe, exactly like index.js). ──
const rotated = names.map((name, i) => ({
  accessToken: `AT_NEW_${i}`, refreshToken: `RT_NEW_${i}`, expiresAt: 9_000_000 + i,
}));

const writers = names.map((name, i) => atomicConfigUpdate(diskConfig => {
  const idx = diskConfig.accounts.findIndex(a => a.accountUuid === `uuid-${name}`);
  if (idx >= 0) {
    diskConfig.accounts[idx].accessToken = rotated[i].accessToken;
    diskConfig.accounts[idx].refreshToken = rotated[i].refreshToken;
    diskConfig.accounts[idx].expiresAt = rotated[i].expiresAt;
  }
}));

// ── torn-read probe: hammer loadConfig WHILE the 10 writes race. Before tmp+rename
//    a reader could observe a half-written file and throw "Unexpected end of JSON
//    input". With rename, every read sees a whole (old or new) file. ──────────────
let tornReads = 0, readsAttempted = 0;
const readers = [];
for (let r = 0; r < 200; r++) {
  readers.push((async () => {
    try {
      readsAttempted++;
      const c = await loadConfig();
      // A successful parse that is missing the accounts array is also "torn".
      if (!c || !Array.isArray(c.accounts) || c.accounts.length !== N) tornReads++;
    } catch {
      tornReads++;
    }
  })());
}

await Promise.all([...writers, ...readers]);

// ── assertions ───────────────────────────────────────────────────────────────
const onDisk = JSON.parse(readFileSync(cfgPath, 'utf-8'));

// (a) LOST UPDATE closed: every one of the 10 rotations reached disk.
let landed = 0;
for (let i = 0; i < N; i++) {
  const acct = onDisk.accounts.find(a => a.accountUuid === `uuid-${names[i]}`);
  if (acct && acct.refreshToken === rotated[i].refreshToken
    && acct.accessToken === rotated[i].accessToken
    && acct.expiresAt === rotated[i].expiresAt) landed++;
}
ok(`all ${N} concurrent rotations reached disk (no lost update)`, landed === N);
ok('no account left on its stale pre-boot refresh token', !onDisk.accounts.some(a => /^RT_old_/.test(a.refreshToken)));

// (b) TORN READ closed: no concurrent reader saw a partial/invalid file.
ok(`no torn read across ${readsAttempted} concurrent reads during the write storm`, tornReads === 0);

// (c) atomicity residue: no stray .tmp left behind after the storm settles.
ok('no leftover .tmp sibling after writes settle', !readdirSync(dir).some(f => f.endsWith('.tmp')));

// (d) file integrity: shape + secret hygiene intact.
ok('config shape intact (proxy/key/upstream survive the storm)',
  onDisk.proxy.apiKey === 'tc-seed' && onDisk.upstream === 'https://api.anthropic.com' && onDisk.accounts.length === N);

// (e) the exit-path sync flush is ALSO atomic (tmp+rename) — a signal mid-flush
//     can't leave a torn config either. Prove it round-trips.
saveConfigSync(onDisk);
const afterSync = await loadConfig();
ok('saveConfigSync round-trips a whole config (atomic exit flush)',
  afterSync.accounts.length === N && afterSync.accounts.every((a, i) => a.refreshToken === rotated[i].refreshToken));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

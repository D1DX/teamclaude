import { AccountManager } from '../src/account-manager.js';

// D-2179: capacity snapshot for orchestrators — verdict / headroom / soonestReset
// + allHardCapped. No network — in-memory accounts.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = (opts = {}) => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, { backoffJitterSec: 0, softConcurrencyPerAccount: 3, ...opts });

// ── green: all live, ample headroom ───────────────────────────────────────────
{ const am = mk();
  const c = am.computeCapacity();
  ok('an all-idle pool is GREEN', c.verdict === 'green');
  ok('headroom = liveAccounts × perAccount − warm (3×3−0 = 9)', c.headroom === 9);
  ok('liveAccounts = 3 / total 3', c.liveAccounts === 3 && c.total === 3);
  ok('soonestResetSec = 0 when nothing is benched', c.soonestResetSec === 0); }

// ── yellow: one account benched ───────────────────────────────────────────────
{ const am = mk();
  am.markRateLimited(0, 300);
  const c = am.computeCapacity();
  ok('one benched account makes the pool YELLOW', c.verdict === 'yellow');
  ok('benched / live counts reflect the bench', c.benched === 1 && c.liveAccounts === 2);
  ok('soonestResetSec ≈ the benched bench (300s)', c.soonestResetSec >= 299 && c.soonestResetSec <= 301); }

// ── yellow: a deep streak (≥2) keeps the pool cautious even when not benched ───
{ const am = mk();
  am.markRateLimited(0, null); am.markRateLimited(0, null);   // streak 2
  am.accounts[0].status = 'active'; am.accounts[0].rateLimitedUntil = null; // bench cleared, streak kept
  const c = am.computeCapacity();
  ok('a deep 429 streak keeps the pool YELLOW (no bench)', c.verdict === 'yellow' && c.benched === 0); }

// ── red: every account benched → 0 live ───────────────────────────────────────
{ const am = mk();
  for (let i = 0; i < 3; i++) am.markRateLimited(i, 200);
  const c = am.computeCapacity();
  ok('an all-benched pool is RED with 0 live', c.verdict === 'red' && c.liveAccounts === 0);
  ok('RED carries soonestResetSec for scheduling (≈200s)', c.soonestResetSec >= 199 && c.soonestResetSec <= 201); }

// ── near-cap (learned) excludes an account from live ──────────────────────────
{ const am = mk({ capSoftCeiling: 0.75 });
  const a = am.accounts[0];
  a._capEst5h = 100000;
  am._recordBurn(a, 80000);                                   // 80k ≥ 0.75×100k = 75k → near cap
  const c = am.computeCapacity();
  const row = c.accounts.find(x => x.name === 'a0');
  ok('an account past its learned soft cap is flagged nearCap', row.nearCap === true);
  ok('a nearCap account is not counted live', row.live === false && c.liveAccounts === 2); }

// ── headroom shrinks as warm sessions fill slots ──────────────────────────────
{ const am = mk({ softConcurrencyPerAccount: 2 });
  for (let i = 0; i < 5; i++) am.getAccountForSession('S' + i);  // 5 warm across 3 live accounts
  const c = am.computeCapacity();
  ok('headroom = 3×2 − 5 warm = 1', c.headroom === 1);
  ok('low headroom (≤1) downgrades to YELLOW', c.verdict === 'yellow'); }

// ── allHardCapped (header path) ───────────────────────────────────────────────
{ const am = mk();
  ok('allHardCapped is false when accounts carry no header limits', am.allHardCapped() === false);
  for (const a of am.accounts) a.quota.unifiedStatus = 'rejected';
  ok('allHardCapped is true when every account is header-rejected', am.allHardCapped() === true); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

import { AccountManager } from '../src/account-manager.js';

// Reactive-only bench contract (DL-3032 + architecture-v3 §2.3 Q1/Q2). The server's
// explicit signal is the only admission signal: a retry-after benches for exactly the
// stated duration (verbatim, Q2); a header-less 429 never benches (fails over); a
// longer retry-after extends an existing bench, a shorter one never shrinks it; a
// success marks the account proven and an expired bench sweeps active. Folds the
// surviving retry-after / success / burn / all-throttled cases from the retired
// escalating-backoff suite. No network — in-memory accounts.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = (opts = {}) => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, opts);
const benchSec = (am, i) => Math.round((am.accounts[i].rateLimitedUntil - Date.now()) / 1000);

// ── a retry-after benches for exactly the stated duration ─────────────────────
{ const am = mk();
  am.markRateLimited(0, 120);
  ok('a retry-after benches the account (throttled)', am.accounts[0].status === 'throttled');
  ok('a retry-after is honored exactly (120s)', benchSec(am, 0) === 120); }

// ── a header-less 429 never benches — it just fails over ──────────────────────
{ const am = mk();
  am.markRateLimited(0, null);
  ok('a header-less 429 does not bench (status stays active)', am.accounts[0].status === 'active');
  ok('a header-less 429 sets no bench window', !am.accounts[0].rateLimitedUntil); }

// ── a zero / negative retry-after never benches ───────────────────────────────
{ const am = mk();
  am.markRateLimited(0, 0); am.markRateLimited(1, -60);
  ok('a zero retry-after does not bench', am.accounts[0].status === 'active');
  ok('a negative retry-after does not bench', am.accounts[1].status === 'active'); }

// ── a longer retry-after EXTENDS an existing bench; a shorter one never shrinks it ─
{ const am = mk();
  am.markRateLimited(0, 120);
  am.markRateLimited(0, 300);
  ok('a longer retry-after extends the bench (300s)', benchSec(am, 0) === 300);
  am.markRateLimited(0, 60);
  ok('a shorter retry-after does not shrink the bench (stays 300s)', benchSec(am, 0) === 300); }

// ── Q2: an over-long retry-after is honored VERBATIM (not clamped) ────────────
{ const am = mk();
  am.markRateLimited(0, 3600);   // 1h — well past the old 900s clamp
  ok('an over-long retry-after is honored verbatim (3600s, Q2)', benchSec(am, 0) === 3600); }

// ── bench expiry flips the account active on the next sweep ───────────────────
{ const am = mk();
  am.markRateLimited(0, 120);
  am.accounts[0].rateLimitedUntil = Date.now() - 1000;  // window elapsed
  am._sweepAll();
  ok('an expired bench flips active on sweep',
     am.accounts[0].status === 'active' && am.accounts[0].rateLimitedUntil === null); }

// ── a success marks the account proven (ready to serve) ───────────────────────
{ const am = mk();
  am.noteAccountSuccess(0);
  ok('a success marks the account proven', am.accounts[0]._proven === true); }

// ── DL-3032 S5: capEst recalibration on SUCCESS (reporting only) ──────────────
{ const am = mk({ capSoftCeiling: 0.75, capDecayHalfLifeHours: 24 });
  const a = am.accounts[0];
  a._capEst5h = 100000;                                       // learned low at a burst moment
  am._recordBurn(a, 90000);                                   // a success burns 90k > 0.75×100k = 75k
  am.noteAccountSuccess(0);
  ok('S5: a success above capEst×capSoftCeiling RAISES capEst (90k/0.75 = 120k)',
     Math.round(a._capEst5h) === 120000);
  ok('S5: the max successful burn is tracked as the decay target', a._maxSuccessBurn5h === 90000); }

{ const am = mk({ capSoftCeiling: 0.75, capDecayHalfLifeHours: 24 });
  const a = am.accounts[0];
  a._capEst5h = 200000;
  a._maxSuccessBurn5h = 100000;                               // proven-headroom target = 100k
  a._capEstAt = Date.now() - 24 * 3600000;                    // one half-life ago
  am._recordBurn(a, 50000);                                   // small success burn (below the ceiling → no raise)
  am.noteAccountSuccess(0);
  ok('S5: capEst decays halfway toward the max successful burn over one half-life (≈150k)',
     Math.round(a._capEst5h) >= 149000 && Math.round(a._capEst5h) <= 151000); }

// ── burn window: only the last N whole-hour buckets count ─────────────────────
{ const am = mk();
  const a = am.accounts[0];
  a._burn = new Map();
  const hr = Math.floor(Date.now() / 3600000);
  a._burn.set(hr, 1000); a._burn.set(hr - 1, 2000); a._burn.set(hr - 6, 9000); // 6h ago is outside 5h
  ok('burn5h sums only the last 5 hourly buckets (3000)', am._burnWindow(a, 5) === 3000);
  ok('burn7d includes the older bucket (12000)', am._burnWindow(a, 168) === 12000); }

// ── allThrottledBackoff: soonest real reset, clamped, floored ─────────────────
{ const am = mk({ backoffSec: 60, allThrottledCapSec: 600 });
  for (const a of am.accounts) { a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 120000; }
  const s = am.allThrottledBackoff();
  ok('client backoff tracks the soonest bench (≈120s)', s >= 120 && s <= 121); }
{ const am = mk({ backoffSec: 60, allThrottledCapSec: 600 });
  for (const a of am.accounts) { a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 1e8; }
  ok('client backoff clamps to allThrottledCapSec (600s)', am.allThrottledBackoff() === 600); }
{ const am = mk({ backoffSec: 60 });
  ok('client backoff floors at the base when no reset is known (60s)', am.allThrottledBackoff() === 60); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

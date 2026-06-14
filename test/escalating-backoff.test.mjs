import { AccountManager } from '../src/account-manager.js';

// D-2179: escalating 429 backoff + learned-cap + all-throttled client backoff.
// jitter pinned to 0 for exact values. No network — in-memory accounts.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = (opts = {}) => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, { backoffJitterSec: 0, ...opts });
const benchSec = (am, i) => Math.round((am.accounts[i].rateLimitedUntil - Date.now()) / 1000);

// ── escalating ladder: header-blind 429s grow 60 → 240 → 900 (cap) ────────────
{ const am = mk({ backoffSec: 60, backoffFactor: 4, backoffCapSec: 900 });
  am.markRateLimited(0, null); const w1 = benchSec(am, 0);
  am.markRateLimited(0, null); const w2 = benchSec(am, 0);
  am.markRateLimited(0, null); const w3 = benchSec(am, 0);
  ok('streak 1 benches the base (60s)', w1 === 60);
  ok('streak 2 escalates ×factor (240s)', w2 === 240);
  ok('streak 3 clamps to the ladder cap (900s, not 960)', w3 === 900);
  ok('the consecutive-429 streak is tracked on the account', am.accounts[0]._429streak === 3); }

// ── a success resets the streak → next 429 is back to the base ────────────────
{ const am = mk({ backoffSec: 60, backoffFactor: 4 });
  am.markRateLimited(0, null); am.markRateLimited(0, null); // streak 2
  am.noteAccountSuccess(0);
  ok('a success clears the 429 streak', am.accounts[0]._429streak === 0);
  am.markRateLimited(0, null);
  ok('the next 429 after a success benches the base again (60s)', benchSec(am, 0) === 60); }

// ── an explicit retry-after overrides the ladder (clamped to the cap) ─────────
{ const am = mk({ backoffSec: 60, backoffCapSec: 900 });
  am.markRateLimited(0, 120);
  ok('a retry-after header is honored exactly (120s)', benchSec(am, 0) === 120); }
{ const am = mk({ backoffCapSec: 900 });
  am.markRateLimited(0, 3600);
  ok('an over-long retry-after is clamped to the cap (900s)', benchSec(am, 0) === 900); }

// ── D-2226: a known unified reset is used ONLY when the account is genuinely at a
//    cap (near-ceiling util); a header-less burst BELOW the caps uses the ladder,
//    not the always-far reset — the bench-to-reset-for-any-429 false-throttle fix ─
{ const am = mk({ backoffCapSec: 900 });
  am.accounts[0].quota.unified5h = 0.95;                     // AT the 5h soft ceiling → genuine quota cap
  am.accounts[0].quota.unified5hReset = Date.now() + 150000; // 150s out
  am.markRateLimited(0, null);
  const w = benchSec(am, 0);
  ok('a near-cap 429 benches to the known unified reset (≈150s)', w >= 149 && w <= 151); }
{ const am = mk({ backoffSec: 60, backoffCapSec: 900 });
  am.accounts[0].quota.unified5h = 0.20;                     // well below the caps → a BURST, not quota
  am.accounts[0].quota.unified5hReset = Date.now() + 150000; // reset is known but irrelevant to a burst
  am.markRateLimited(0, null);
  ok('a burst-429 below the caps uses the ladder, NOT the far reset (60s)', benchSec(am, 0) === 60); }

// ── learned cap: EMA of burn5h at the FIRST 429 of each streak ────────────────
{ const am = mk({ capEmaAlpha: 0.5 });
  am._recordBurn(am.accounts[0], 200000);
  am.markRateLimited(0, null);
  ok('first cap event sets capEst5h to burn5h (200k)', am.accounts[0]._capEst5h === 200000);
  am._recordBurn(am.accounts[0], 100000);             // burn5h now 300k
  am.markRateLimited(0, null);                        // streak 2 — must NOT re-teach
  ok('a later 429 in the same streak does NOT re-teach the cap', am.accounts[0]._capEst5h === 200000);
  am.noteAccountSuccess(0);                            // new streak
  am.markRateLimited(0, null);                        // EMA toward 300k: 0.5×200k + 0.5×300k
  ok('a fresh streak EMAs the cap toward the new burn (250k)', am.accounts[0]._capEst5h === 250000); }

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

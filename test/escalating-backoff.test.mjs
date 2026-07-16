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
// D-2286: model a recovery between SEQUENTIAL 429s — the bench expired and the account
// was re-probed (what _sweepAll does: flip an expired bench back to 'active'). Only a
// failure AFTER recovery is a distinct cycle that escalates the streak; a 429 arriving
// while still benched is a concurrent-burst sibling (debounced, no escalation).
const recover = (am, i) => { am.accounts[i].status = 'active'; am.accounts[i].rateLimitedUntil = 0; };

// ── escalating ladder: SEQUENTIAL header-blind 429s grow 60 → 240 → 900 (cap) ──
{ const am = mk({ backoffSec: 60, backoffFactor: 4, backoffCapSec: 900 });
  am.markRateLimited(0, null); const w1 = benchSec(am, 0);
  recover(am, 0); am.markRateLimited(0, null); const w2 = benchSec(am, 0);
  recover(am, 0); am.markRateLimited(0, null); const w3 = benchSec(am, 0);
  ok('streak 1 benches the base (60s)', w1 === 60);
  ok('streak 2 escalates ×factor (240s)', w2 === 240);
  ok('streak 3 clamps to the ladder cap (900s, not 960)', w3 === 900);
  ok('the consecutive-429 streak is tracked on the account', am.accounts[0]._429streak === 3); }

// ── D-2286: concurrent-burst debounce — sibling 429s while ALREADY benched do NOT
//    escalate the streak or re-bench. The 06-15 cascade was 3 concurrent 429s driving
//    60→240→900 in 3 seconds because the streak counted in-flight 429s. Now only a
//    SEQUENTIAL failure (after recovery) escalates; a concurrent sibling is a no-op. ─
{ const am = mk({ backoffSec: 60, backoffFactor: 4, backoffCapSec: 900 });
  am.markRateLimited(0, null);                 // first 429 → streak 1, 60s, status throttled
  am.markRateLimited(0, null);                 // concurrent sibling (still benched) → debounced
  am.markRateLimited(0, null);                 // concurrent sibling → debounced
  ok('a concurrent burst does NOT inflate the streak (stays 1)', am.accounts[0]._429streak === 1);
  ok('a concurrent burst does NOT re-bench (stays 60s, not 900s)', benchSec(am, 0) === 60);
  recover(am, 0); am.markRateLimited(0, null); // a SEQUENTIAL failure after recovery DOES escalate
  ok('a sequential failure after recovery escalates (streak 2, 240s)', am.accounts[0]._429streak === 2 && benchSec(am, 0) === 240);
  // a concurrent 429 carrying a LONGER retry-after still extends the bench (no escalation)
  am.markRateLimited(0, 600);
  ok('a concurrent retry-after extends the bench but not the streak', am.accounts[0]._429streak === 2 && benchSec(am, 0) === 600); }

// ── a success resets the streak → next 429 is back to the base ────────────────
{ const am = mk({ backoffSec: 60, backoffFactor: 4 });
  am.markRateLimited(0, null); recover(am, 0); am.markRateLimited(0, null); // sequential → streak 2
  am.noteAccountSuccess(0);
  ok('a success clears the 429 streak', am.accounts[0]._429streak === 0);
  recover(am, 0); am.markRateLimited(0, null);
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

// ── DL-3032 S4: utilization-aware CONCURRENCY class. A header-less 429 with BOTH base
//    axes at/under burstUtilMax caps the bench at burstBenchCapSec instead of climbing
//    the full ladder — a synchronized low-util burst can't sideline the pool for
//    minutes. Mid-band (an axis above burstUtilMax) keeps the ladder; near-cap benches
//    to the reset. jitter pinned 0 for exact values. ─
{ const am = mk({ backoffSec: 60, backoffFactor: 4, backoffCapSec: 900, burstUtilMax: 0.30, burstBenchCapSec: 120 });
  am.accounts[0].quota.unified5h = 0.10;                      // near-idle → concurrency class
  am.accounts[0].quota.unified7d = 0.05;
  am.markRateLimited(0, null);
  ok('S4: concurrency-class streak 1 benches the base (60s, ≤120s cap)', benchSec(am, 0) === 60);
  recover(am, 0); am.markRateLimited(0, null);                // ladder wants 240s → capped to 120s
  ok('S4: concurrency-class streak 2 caps at burstBenchCapSec (120s, not 240s)', benchSec(am, 0) === 120);
  recover(am, 0); am.markRateLimited(0, null); recover(am, 0); am.markRateLimited(0, null);
  ok('S4: a concurrency-class deep streak never exceeds burstBenchCapSec (120s, not 900s)', benchSec(am, 0) === 120); }

{ const am = mk({ backoffSec: 60, backoffFactor: 4, backoffCapSec: 900, burstUtilMax: 0.30, burstBenchCapSec: 120 });
  am.accounts[0].quota.unified5h = 0.50;                      // mid-band → NOT concurrency class
  am.markRateLimited(0, null); recover(am, 0); am.markRateLimited(0, null); // sequential → streak 2
  ok('S4: mid-band (u5h 0.5) keeps the full escalating ladder (240s, not capped to 120s)', benchSec(am, 0) === 240); }

{ const am = mk({ backoffSec: 60, backoffCapSec: 900, burstBenchCapSec: 120 });
  am.accounts[0].quota.unified5h = 0.92;                      // ≥ fiveHourSoftCeiling 0.90 → genuine cap
  am.accounts[0].quota.unified5hReset = Date.now() + 300000;  // 300s out
  am.markRateLimited(0, null);
  ok('S4: a near-cap (u5h 0.92) 429 benches to the axis reset (≈300s), not the burst cap',
     benchSec(am, 0) >= 299 && benchSec(am, 0) <= 301); }

{ const am = mk({ backoffSec: 60, backoffFactor: 4, burstUtilMax: 0.30, burstBenchCapSec: 120 });
  am.accounts[0].quota.unified5h = 0.10;                      // idle 5h …
  am.accounts[0].quota.unified7d = 0.60;                      // … but 7d well above burstUtilMax
  am.markRateLimited(0, null); recover(am, 0); am.markRateLimited(0, null); // streak 2
  ok('S4: a hot 7d axis disqualifies the concurrency class (full ladder 240s)', benchSec(am, 0) === 240); }

// ── learned cap: EMA of burn5h at the FIRST 429 of each streak ────────────────
{ const am = mk({ capEmaAlpha: 0.5 });
  am._recordBurn(am.accounts[0], 200000);
  am.markRateLimited(0, null);                         // streak 1 → teach: capEst5h = 200k
  ok('first cap event sets capEst5h to burn5h (200k)', am.accounts[0]._capEst5h === 200000);
  am._recordBurn(am.accounts[0], 100000);             // burn5h now 300k
  recover(am, 0); am.markRateLimited(0, null);        // streak 2 (sequential) — only the 1st of a streak teaches
  ok('a later 429 in the same streak does NOT re-teach the cap', am.accounts[0]._capEst5h === 200000);
  am.accounts[0]._429streak = 0;                       // fresh streak (a success resets it; set directly to
                                                       // isolate the EMA-at-429 path from DL-3032 success-recalibration)
  recover(am, 0); am.markRateLimited(0, null);        // streak 1 again → EMA toward 300k: 0.5×200k + 0.5×300k
  ok('a fresh streak EMAs the cap toward the new burn (250k)', am.accounts[0]._capEst5h === 250000); }

// ── DL-3032 S5: capEst recalibration on SUCCESS — the learned cap no longer freezes at
//    a burst-taught low value. A success burning past capEst×capSoftCeiling RAISES the
//    cap immediately; otherwise it time-DECAYS toward the max observed successful burn. ─
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

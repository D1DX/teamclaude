import { AccountManager } from '../src/account-manager.js';

// D1DX (D-1705): all-accounts-throttled backoff + de-synchronized recovery.
// No network — constructs accounts in-memory and drives the AccountManager
// episode/backoff/recovery logic directly. retryJitterPct is pinned to 0 in the
// deterministic cases so the floor/cap/escalation values are exact.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = (opts) => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, 0.20, 10, 1.3, opts || {});
const throttleAll = (am, untilMs) => {
  for (const a of am.accounts) { a.status = 'throttled'; a.rateLimitedUntil = untilMs; }
};

// ── S1: real-reset-aware client backoff ───────────────────────────────────
{ const am = mk({ allThrottledFloorSec: 60, allThrottledCapSec: 600, retryJitterPct: 0 });
  throttleAll(am, Date.now() + 120000); // real reset 120s out — above the 60s floor, below the 600s cap
  const secs = am.allThrottledBackoff();
  ok('S1 backoff tracks the real soonest reset (≈120s, not the 60s floor)', secs >= 120 && secs <= 122); }

{ const am = mk({ allThrottledFloorSec: 60, allThrottledCapSec: 600, retryJitterPct: 0 });
  throttleAll(am, Date.now() + 100000000); // reset far out → clamp to cap
  const secs = am.allThrottledBackoff();
  ok('S1 backoff clamps to cap (600s) for a far reset', secs === 600); }

{ const am = mk({ allThrottledFloorSec: 60, allThrottledCapSec: 600, retryJitterPct: 0 });
  const secs = am.allThrottledBackoff(); // no reset info anywhere → fall back to the floor
  ok('S1 backoff floors at allThrottledFloorSec when no reset is known', secs === 60); }

{ const am = mk({ retryJitterPct: 0.15, allThrottledFloorSec: 100, allThrottledCapSec: 600 });
  const secs = am.allThrottledBackoff(); // floor 100, upward jitter up to +15%
  ok('S1 jitter is upward-only (>= floor, <= floor*(1+pct))', secs >= 100 && secs <= 116); }

{ const am = mk({ perAccountBackoffFloorSec: 60, recoveryStaggerSec: 5 });
  const now = Date.now();
  am.accounts[1].quota.unified5hReset = now + 200000; // 200s out — D-1728 must IGNORE this
  am.accounts[1].quota.unified7d = 0.90;               // D-1936: near-cap → sustained (long) backoff path
  am.markRateLimited(1, null);                          // 429 with NO retry-after header
  const remaining = am.accounts[1].rateLimitedUntil - now;
  // D-1728 supersedes D-1705 S1 for a SINGLE account: a headerless 429 on a
  // near-cap account uses the bounded per-account backoff (floor 60s + index
  // stagger), NOT the full 5h reset (200s). The rolling 5h window recovers long
  // before the nominal reset. (D-1936: a budget-HEALTHY account would instead
  // get the short burst cooldown — see burst-recovery.test.mjs.)
  ok('D-1728 markRateLimited(null header) on near-cap = bounded backoff (~60s), not the full 5h reset (200s)',
     remaining >= 60000 && remaining < 80000); }

// ── S2: de-synchronized recovery (per-account stagger) ─────────────────────
{ const am = mk({ recoveryStaggerSec: 5 });
  am.markRateLimited(0, 300); am.markRateLimited(1, 300); am.markRateLimited(2, 300); // identical window
  const u = am.accounts.map(a => a.rateLimitedUntil);
  ok('S2 identical windows get DISTINCT expiry (no lockstep)', u[0] !== u[1] && u[1] !== u[2] && u[0] !== u[2]);
  ok('S2 stagger scales with account index', u[2] > u[0]); }

// ── S3: half-open recovery (one release per gap) ───────────────────────────
{ const am = mk({ recoveryGapSec: 20 });
  const now = Date.now();
  throttleAll(am, now - 1000);   // every window already expired
  am._allThrottledStreak = 1;     // episode active
  am._recoveryReleaseAt = 0;      // gate open for the first release
  am._sweepAll();
  ok('S3 half-open releases exactly ONE account per sweep during an episode',
    am.accounts.filter(a => a.status === 'active').length === 1);
  ok('S3 gate armed after the release (future _recoveryReleaseAt)', am._recoveryReleaseAt > now); }

{ const am = mk({ recoveryGapSec: 20 });
  throttleAll(am, Date.now() - 1000);
  am._allThrottledStreak = 0;     // NOT in an episode → normal immediate release
  am._sweepAll();
  ok('S3 outside an episode, all expired throttles release at once (no regression)',
    am.accounts.filter(a => a.status === 'active').length === 3); }

{ const am = mk();
  am._allThrottledStreak = 3; am._recoveryReleaseAt = Date.now() + 99999;
  am.noteSuccess();
  ok('S3 noteSuccess resets the streak + opens the gate', am._allThrottledStreak === 0 && am._recoveryReleaseAt === 0); }

// ── S3: escalating floor on back-to-back episodes ──────────────────────────
{ const am = mk({ allThrottledFloorSec: 60, allThrottledCapSec: 600, retryJitterPct: 0, escalationFactor: 1.5 });
  const s1 = am.allThrottledBackoff();                                  // streak 1 → floor 60
  am._lastAllThrottledAt = Date.now() - (am._lastBackoffMs + 1000);     // backoff window elapsed (within cap) → next episode
  const s2 = am.allThrottledBackoff();                                  // streak 2 → floor 90
  am._lastAllThrottledAt = Date.now() - (am._lastBackoffMs + 1000);
  const s3 = am.allThrottledBackoff();                                  // streak 3 → floor 135
  ok('S3 escalating floor grows across back-to-back episodes (60→90→135)', s1 === 60 && s2 === 90 && s3 === 135); }

{ const am = mk({ allThrottledFloorSec: 60, retryJitterPct: 0 });
  const a = am.allThrottledBackoff(); // streak 1
  const b = am.allThrottledBackoff(); // same episode (no window elapsed) → still streak 1
  ok('S3 concurrent all-throttled within one episode does not double-escalate',
    a === 60 && b === 60 && am._allThrottledStreak === 1); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

import { AccountManager } from '../src/account-manager.js';

// D-2286: the regression test that would have caught the 06-15 outage. Reproduces the
// synchronized-recovery herd + concurrent-burst streak inflation at the AccountManager
// level (no network — in-memory accounts), and locks the three fixes:
//   1. streak-debounce      — a concurrent 429 burst benches ONCE, not N times
//   2. atomic probe-gate    — a recovery herd dispatches ≤1 per unproven account
//   3. full jitter          — simultaneous benches DON'T expire together
// jitter pinned to 0 for the deterministic bench-value assertions; one block flips it
// on to assert de-synchronization.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = (n = 3, opts = {}) => new AccountManager(
  Array.from({ length: n }, (_, i) => ({ name: `a${i}`, type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 })),
  0.98, { backoffJitterSec: 0, ...opts });
const benchSec = (am, i) => Math.round((am.accounts[i].rateLimitedUntil - Date.now()) / 1000);
// sim: a benched account whose window expired and got re-probed (what _sweepAll does).
const recover = (am, i) => { am.accounts[i].status = 'active'; am.accounts[i].rateLimitedUntil = 0; };

// ── 1. concurrent-burst streak inflation (the core 06-15 bug) ─────────────────
// Pre-fix: 8 concurrent 429s on one account drove the streak 1→8 and the bench
// 60→…→900 in milliseconds, sidelining a half-full account for 15 minutes. Post-fix:
// the burst benches ONCE at the base; only a sequential failure escalates.
{ const am = mk(1, { backoffSec: 60, backoffFactor: 4, backoffCapSec: 900 });
  for (let k = 0; k < 8; k++) am.markRateLimited(0, null);   // a concurrent burst of 8
  ok('a concurrent burst of 8 429s benches ONCE at the base (60s, not 900s)', benchSec(am, 0) === 60);
  ok('the streak stays 1 after a concurrent burst (not 8)', am.accounts[0]._429streak === 1); }

// ── 2. atomic dispatch probe-gate — a recovery herd can't dogpile one account ──
// The 06-15 onset: benches expired together, 8 sessions all re-bound to ONE just-
// recovered account ("window lapsed"), and all dispatched because each read _inflight
// = 0 before any reserved (TOCTOU). tryReserveInflight checks+reserves atomically.
{ const am = mk(1);
  const a = am.accounts[0];
  a._proven = false; a._inflight = 0;                        // just recovered, unproven
  let admitted = 0;
  for (let k = 0; k < 8; k++) if (am.tryReserveInflight(0)) admitted++;
  ok('atomic probe-gate admits exactly ONE request to an unproven account', admitted === 1);
  ok('the other 7 are held (in-flight stays at the graduated cap of 1)', a._inflight === 1);
  am.noteAccountSuccess(0);                                  // the probe returned 200 → proven
  let more = 0;
  while (am.tryReserveInflight(0)) more++;
  ok('once proven, the cap opens to maxInflightPerAccount', a._inflight === am.maxInflightPerAccount); }

// ── 3. routing + probe-gate together: a 9-session herd onto a 3-account recovered
//    pool dispatches at most ONE per unproven account (no dogpile, no burst-429) ──
{ const am = mk(3);
  for (const a of am.accounts) { a._proven = false; a._inflight = 0; a.status = 'active'; a.rateLimitedUntil = 0; }
  let dispatched = 0;
  for (let s = 0; s < 9; s++) {
    const acct = am.getAccountForSession(`sess-${s}`);       // routing
    if (acct && am.tryReserveInflight(acct.index)) dispatched++;  // admission
  }
  const perAccountOk = am.accounts.every(a => (a._inflight || 0) <= 1);
  ok('a 9-session recovery herd dispatches ≤1 per unproven account', perAccountOk);
  ok('the herd dispatches at most one-per-account total (≤3), the rest held', dispatched <= 3); }

// ── 4. no false all-throttled while the pool has headroom ─────────────────────
// Even after a concurrent burst benches every account once, each is benched only ~60s
// (base), NOT the 900s cap — so the pool is usable again in ~1 min, not stuck "all
// throttled" for the ~28-min waves of 06-15.
{ const am = mk(3, { backoffSec: 60, backoffFactor: 4, backoffCapSec: 900 });
  for (let i = 0; i < 3; i++) for (let k = 0; k < 6; k++) am.markRateLimited(i, null); // burst each
  const allShort = am.accounts.every((_, i) => benchSec(am, i) === 60);
  ok('a concurrent burst benches every account ONCE at ~60s (not the 15-min cap)', allShort);
  ok('no account was driven past streak 1 by the burst', am.accounts.every(a => a._429streak === 1)); }

// ── 5. full jitter de-synchronizes simultaneous benches (anti re-herd) ────────
{ const am = mk(2, { backoffSec: 60, backoffFactor: 4, backoffCapSec: 900, backoffJitterSec: 60 });
  am.accounts[0]._429streak = 2; am.accounts[1]._429streak = 2;  // next 429 → streak 3 (ladder 900)
  recover(am, 0); recover(am, 1);
  am.markRateLimited(0, null); am.markRateLimited(1, null);      // benched at the same instant
  ok('full jitter de-synchronizes two simultaneous benches (different expiry)',
     am.accounts[0].rateLimitedUntil !== am.accounts[1].rateLimitedUntil);
  ok('full-jitter bench stays within [base, ladder] (60..900s)',
     benchSec(am, 0) >= 60 && benchSec(am, 0) <= 900 && benchSec(am, 1) >= 60 && benchSec(am, 1) <= 900); }

// ── 6. DL-3032 S5: capacity reports the TRUTH — 10 low-util accounts all read live ─
// The 07-16 defect: computeCapacity reported 1/12 "live" while 10/12 accounts served at
// u5h 0.1–0.9 (a learned-cap nearCap exclusion), so orchestrators gated spawns on a
// false red. Now a learned-cap account is `constrained` (feeds headroom) but stays live.
{ const am = mk(10, { capSoftCeiling: 0.75 });
  for (let i = 0; i < 10; i++) {
    am.accounts[i].quota.unified5h = 0.10 + i * 0.05;         // 0.10 … 0.55 — all serving, none benched/hard-capped
    am.accounts[i]._capEst5h = 100000;                        // a learned cap
    am._recordBurn(am.accounts[i], 90000);                    // burn past 0.75×cap → the would-be nearCap exclusion
  }
  const c = am.computeCapacity();
  ok('DL-3032: 10 active low-util accounts ALL report live (≥10), not excluded by the learned cap',
     c.liveAccounts >= 10);
  ok('DL-3032: every such account is flagged constrained (feeds headroom, not liveness)',
     c.accounts.every(a => a.constrained === true));
  ok('DL-3032: the pool is NOT falsely RED while every account is serving', c.verdict !== 'red'); }

// ── 7. DL-3032 S4: a near-idle account never benches past burstBenchCapSec ─────
// Even under genuine sequential 429s, a concurrency-class (low-util) account's bench
// caps at burstBenchCapSec — so a low-util 429 pattern can't sideline the pool for 15m.
{ const am = mk(1, { backoffSec: 60, backoffFactor: 4, backoffCapSec: 900, burstUtilMax: 0.30, burstBenchCapSec: 120 });
  am.accounts[0].quota.unified5h = 0.10;                      // near-idle → concurrency class
  for (let k = 0; k < 5; k++) { am.markRateLimited(0, null); recover(am, 0); }
  am.markRateLimited(0, null);                                // deep sequential streak on a near-idle account
  ok('DL-3032: a low-util account never benches past burstBenchCapSec (120s, not 900s)', benchSec(am, 0) === 120); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

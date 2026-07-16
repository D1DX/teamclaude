import { AccountManager } from '../src/account-manager.js';

// The invariants that survive the reactive-only strip (no network — in-memory
// accounts): a header-less burst never benches (reactive fails over), the capacity
// view reads live under a learned soft cap, and the atomic in-flight reserve holds at
// maxInflightPerAccount. Alongside reactive-bench.test / capacity.test.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = (n = 3, opts = {}) => new AccountManager(
  Array.from({ length: n }, (_, i) => ({ name: `a${i}`, type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 })),
  0.98, opts);

// ── 1. a header-less concurrent burst never benches (reactive-only fails over) ──
// A header-less 429 (the Max OAuth norm) carries no server retry-after → no bench;
// the request just fails over to the rest of the pool. covered by reactive-bench.test.
{ const am = mk(1);
  for (let k = 0; k < 8; k++) am.markRateLimited(0, null);   // a concurrent burst of 8, header-less
  ok('a concurrent burst of header-less 429s never benches (fails over)',
     am.accounts[0].status !== 'throttled' && !am.accounts[0].rateLimitedUntil); }

// ── 2. DL-3032 S5: capacity reports the TRUTH — 10 low-util accounts all read live ─
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

// ── 3. atomic in-flight reserve (DL-2226) — the surviving TOCTOU invariant: exactly
//    maxInflightPerAccount concurrent binds pass the reserve at cap N; the rest hold ──
{ const am = mk(1, { maxInflightPerAccount: 5 });
  const a = am.accounts[0]; a._inflight = 0;
  let admitted = 0;
  for (let k = 0; k < 12; k++) if (am.tryReserveInflight(0)) admitted++;  // a concurrent herd of 12
  ok('atomic reserve admits exactly maxInflightPerAccount concurrent binds (the rest hold)',
     admitted === 5 && a._inflight === 5); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

import { AccountManager } from '../src/account-manager.js';

// D1DX patch #10 (operator 2026-06-10, D-2104): pace-to-expiry utilization
// controller. No network — drives _pickAccountForBinding / _paceExpected /
// _paceGap directly with in-memory accounts and hand-set 7d quota windows.
// expected(t) = fraction-of-week-elapsed; (re)bind goes to the account most
// BEHIND its line; expiring accounts take absolute precedence while behind; an
// account > paceOvershootGuard ahead of its line takes no new bindings. Names
// mirror the live pool (daniel/apple expiring; banana/cherry not).
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const H = 3600 * 1000, D = 24 * H, W = 7 * D;

const mk = (opts) => new AccountManager([
  { name: 'daniel', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'apple',  type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'banana', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'cherry', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, 0.20, 10, 1.3, opts || {});
// set weekly utilization + 7d reset; resetInMs = time LEFT in the window.
const set = (am, name, u7d, resetInMs) => {
  const a = am.accounts.find(x => x.name === name);
  a.quota.unified7d = u7d;
  a.quota.unified7dReset = Date.now() + resetInMs;
  return a;
};
const EXP = ['daniel', 'apple'];               // expiring set used in most blocks
const pickN = (am, n, prefix = 'S') => {        // n fresh-session binds → array of account names
  const out = [];
  for (let i = 0; i < n; i++) out.push(am.getAccountForSession(prefix + i).name);
  return out;
};
const close = (x, y) => Math.abs(x - y) < 1e-6;

// ── 1. _paceExpected: fraction-of-week-elapsed, per account ───────────────────
{ const am = mk();
  const a = set(am, 'daniel', 0.0, 0.5 * W);   // half the window left ⇒ half elapsed
  ok('expected = 0.5 at half-week left', close(am._paceExpected(a), 0.5));
  set(am, 'daniel', 0.0, 0);                    // at the reset
  ok('expected = 1.0 at reset (window spent)', close(am._paceExpected(a), 1));
  set(am, 'daniel', 0.0, W);                    // full window left ⇒ just reset
  ok('expected = 0.0 just after reset', close(am._paceExpected(a), 0));
  a.quota.unified7dReset = null;
  ok('expected = null when reset unknown', am._paceExpected(a) === null); }

// ── 2. _paceGap: signed distance from the line ────────────────────────────────
{ const am = mk();
  const a = set(am, 'daniel', 0.2, 0.3 * W);   // expected 0.7, used 0.2
  ok('gap > 0 when behind the line (0.7−0.2=0.5)', close(am._paceGap(a), 0.5));
  set(am, 'daniel', 0.9, 0.3 * W);             // expected 0.7, used 0.9
  ok('gap < 0 when ahead of the line (0.7−0.9=−0.2)', close(am._paceGap(a), -0.2));
  a.quota.unified7dReset = null;
  ok('gap = 0 (neutral) when reset unknown', am._paceGap(a) === 0); }

// ── 3. Most-behind first (no expiring configured) ─────────────────────────────
{ const am = mk();                              // expiringAccounts default []
  set(am, 'daniel', 0.20, 0.3 * W);            // expected 0.7 → gap 0.50 (most behind)
  set(am, 'apple',  0.50, 0.3 * W);            // gap 0.20
  set(am, 'banana', 0.65, 0.3 * W);            // gap 0.05
  set(am, 'cherry', 0.30, 0.3 * W);            // gap 0.40
  ok('binds to the most-behind account first (daniel)', am._pickAccountForBinding().name === 'daniel');
  const picks = pickN(am, 6);
  ok('the least-behind account (banana) is not the first pick', picks[0] !== 'banana'); }

// ── 4. Expiring accounts take ABSOLUTE precedence while behind ────────────────
{ const am = mk({ expiringAccounts: EXP });
  set(am, 'banana', 0.10, 0.2 * W);            // expected 0.8 → gap 0.70 (biggest overall)
  set(am, 'cherry', 0.20, 0.2 * W);            // gap 0.60
  set(am, 'apple',  0.40, 0.5 * W);            // expiring, expected 0.5 → gap 0.10 (behind)
  set(am, 'daniel', 0.45, 0.5 * W);            // expiring, gap 0.05 (behind)
  const first = am._pickAccountForBinding().name;
  ok('expiring-behind beats a bigger-gap non-expiring (apple over banana)', first === 'apple');
  ok('new bindings go only to expiring accounts while they are behind',
     pickN(am, 6).every(n => EXP.includes(n))); }

// ── 5. Expiring caught up → demand flows to the others' gaps ───────────────────
{ const am = mk({ expiringAccounts: EXP });
  set(am, 'daniel', 0.50, 0.5 * W);            // expiring, expected 0.5 → gap 0 (on line, not behind)
  set(am, 'apple',  0.47, 0.5 * W);            // expiring, gap 0.03 ... pull it onto the line:
  set(am, 'apple',  0.50, 0.5 * W);            // expiring, gap 0 (caught up)
  set(am, 'banana', 0.20, 0.2 * W);            // expected 0.8 → gap 0.60 (most behind non-expiring)
  set(am, 'cherry', 0.40, 0.2 * W);            // gap 0.40
  ok('once expiring are on their line, the most-behind other is picked (banana)',
     am._pickAccountForBinding().name === 'banana'); }

// ── 6. Overshoot guard: an account > guard ahead takes no new bindings ────────
{ const am = mk({ paceOvershootGuard: 0.05 });  // no expiring → isolate the guard
  set(am, 'daniel', 0.62, 0.5 * W);            // expected 0.5 → gap −0.12 (>5pt ahead) → GUARDED OUT
  set(am, 'apple',  0.30, 0.5 * W);            // gap 0.20 (behind)
  set(am, 'banana', 0.53, 0.5 * W);            // gap −0.03 (within guard) → eligible
  set(am, 'cherry', 0.48, 0.5 * W);            // gap 0.02 → eligible
  const picks = pickN(am, 8);
  ok('an account >5pt ahead of its line never takes a new binding (daniel)', !picks.includes('daniel'));
  ok('the most-behind eligible account is picked first (apple)', picks[0] === 'apple'); }

// ── 6b. Overshoot guard boundary: exactly at the guard is still eligible ──────
{ const am = mk({ paceOvershootGuard: 0.05 });
  set(am, 'daniel', 0.55, 0.5 * W);            // expected 0.5 → gap −0.05 (exactly at guard) → eligible
  set(am, 'apple',  0.99, 0.5 * W);            // hard-capped out of the way
  set(am, 'banana', 0.99, 0.5 * W);            // hard-capped
  set(am, 'cherry', 0.99, 0.5 * W);            // hard-capped
  ok('gap exactly at −guard stays eligible (daniel, ≥ not >)', am._pickAccountForBinding().name === 'daniel'); }

// ── 7. Never refuse service: all accounts overshot → least-ahead picked ───────
{ const am = mk({ paceOvershootGuard: 0.05 });
  set(am, 'daniel', 0.70, 0.5 * W);            // gap −0.20
  set(am, 'apple',  0.70, 0.5 * W);            // gap −0.20
  set(am, 'banana', 0.70, 0.5 * W);            // gap −0.20
  set(am, 'cherry', 0.56, 0.5 * W);            // gap −0.06 (least ahead)
  const a = am._pickAccountForBinding();
  ok('all-overshot still returns an account (never refuse)', a != null);
  ok('all-overshot picks the least-ahead account (cherry)', a.name === 'cherry'); }

// ── 8. Hard rails beat the pace gap (5h ceiling / rejected exclude) ───────────
{ const am = mk({ expiringAccounts: EXP });
  const d = set(am, 'daniel', 0.10, 0.3 * W);  // most behind on the line (gap 0.60) ...
  d.quota.unified5h = 0.99;                     // ... but 5h-exhausted → hard rail excludes it
  set(am, 'apple',  0.30, 0.3 * W);            // expiring, gap 0.40, healthy → picked
  set(am, 'banana', 0.40, 0.3 * W);
  set(am, 'cherry', 0.50, 0.3 * W);
  const first = am._pickAccountForBinding().name;
  ok('a 5h-exhausted account is excluded even when most behind (not daniel)', first !== 'daniel');
  ok('the binding lands on the most-behind HEALTHY account (apple)', first === 'apple');
  const r = set(am, 'apple', 0.30, 0.3 * W);
  r.quota.unifiedStatus = 'rejected';           // now apple rejected too
  ok('a rejected account is excluded as well (falls to banana)', am._pickAccountForBinding().name === 'banana'); }

// ── 9. In-flight cap steers a burst off an at-cap account ─────────────────────
{ const am = mk({ expiringAccounts: EXP, maxInFlightPerAccount: 6 });
  const d = set(am, 'daniel', 0.10, 0.3 * W);  // expiring, most behind (gap 0.60) ...
  d._inflight = 6;                              // ... but already at the in-flight cap
  set(am, 'apple',  0.30, 0.3 * W);            // expiring, gap 0.40, in-flight 0
  set(am, 'banana', 0.40, 0.3 * W);
  set(am, 'cherry', 0.50, 0.3 * W);
  ok('a new bind steers off an account at the in-flight cap (apple, not daniel)',
     am._pickAccountForBinding().name === 'apple'); }

// ── 10. Week-boundary edges ───────────────────────────────────────────────────
{ const am = mk({ expiringAccounts: EXP });
  set(am, 'daniel', 0.50, 1 * H);              // reset imminent → expected ≈0.994 → gap ≈0.49 (drain hard)
  set(am, 'apple',  0.30, 0.3 * W);            // expiring, gap 0.40
  set(am, 'banana', 0.20, 0.3 * W);
  set(am, 'cherry', 0.20, 0.3 * W);
  ok('an account near its reset with budget left is drained first (daniel)',
     am._pickAccountForBinding().name === 'daniel'); }
{ const am = mk();
  const d = set(am, 'daniel', 0.90, 0.3 * W); d.quota.unified7dReset = null; // unknown reset → neutral
  set(am, 'apple',  0.30, 0.3 * W);            // expected 0.7 → gap 0.40 (behind)
  ok('unknown-reset account has neutral gap (0)', am._paceGap(d) === 0);
  ok('a behind account is preferred over an unknown-reset one (apple)',
     am._pickAccountForBinding().name === 'apple'); }

// ── 11. Reserve floor is exempted for expiring accounts ───────────────────────
{ const am = mk({ expiringAccounts: EXP });
  // 12h to reset → floor ≈ 0.0375. Both daniel(expiring) + banana(non-exp) sit
  // just below that floor and on-pace; apple + cherry are hard-capped out. The
  // floor would exclude BOTH, but the controller exempts the expiring one.
  set(am, 'daniel', 0.9625, 0.5 * D);          // expiring, remaining 0.0375 ≤ floor, gap ≈ −0.034 (on-pace)
  set(am, 'banana', 0.9625, 0.5 * D);          // non-expiring, identical numbers
  const a1 = set(am, 'apple',  0.99, 0.5 * D); a1.quota.unified5h = 0.99; // hard-capped
  const c1 = set(am, 'cherry', 0.99, 0.5 * D); c1.quota.unified5h = 0.99; // hard-capped
  ok('expiring account below its reserve floor stays eligible; non-expiring is floored out (daniel)',
     am._pickAccountForBinding().name === 'daniel'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

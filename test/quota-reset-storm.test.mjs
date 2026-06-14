import { AccountManager } from '../src/account-manager.js';

// D-2236: the quota-reset log storm + the RangeError it fed.
// At a 5h/7d window boundary Anthropic can briefly report a reset timestamp that
// is already <= now. Pre-D-2236, updateQuota stored that passed reset, so every
// subsequent _sweepAll() saw `quota != null && now >= reset`, re-logged
// "session quota reset", and re-nulled — and because the TUI patches console.log
// -> _addLog -> render() -> computeCapacity() -> _sweepAll(), that storm recursed
// into "Maximum call stack size exceeded". The fix: never STORE a <=now reset
// (treat the window as already rolled), so the sweep finds nothing to re-clear.

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const mk = () => new AccountManager([
  { name: 'apple', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, { backoffJitterSec: 0 });

// Count "session quota reset" lines emitted while running `fn`.
const countResetLogs = (fn) => {
  const orig = console.log;
  let n = 0;
  console.log = (...a) => { if (String(a.join(' ')).includes('session quota reset')) n++; };
  try { fn(); } finally { console.log = orig; }
  return n;
};

const sec = (ms) => Math.floor(ms / 1000);

// ── a PAST 5h reset is never stored → no storm across many sweeps ──────────────
{ const am = mk();
  const past = sec(Date.now() - 60_000); // 60s ago
  const logs = countResetLogs(() => {
    am.updateQuota(0, {
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-5h-reset': String(past),
    });
    for (let i = 0; i < 50; i++) am._sweepAll(); // hammer it like the request/poll hot path
  });
  ok('a <=now 5h reset is NOT stored (window treated as rolled)', am.accounts[0].quota.unified5hReset === null);
  ok('its stale 5h utilization is cleared too', am.accounts[0].quota.unified5h === null);
  ok('NO reset-log storm across 50 sweeps (0 lines)', logs === 0); }

// ── a FUTURE 5h reset is stored normally ───────────────────────────────────────
{ const am = mk();
  const future = sec(Date.now() + 3_600_000); // +1h
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.42',
    'anthropic-ratelimit-unified-5h-reset': String(future),
  });
  ok('a future 5h reset IS stored', am.accounts[0].quota.unified5hReset === future * 1000);
  ok('its 5h utilization IS stored', am.accounts[0].quota.unified5h === 0.42); }

// ── a PAST 7d reset is never stored either ─────────────────────────────────────
{ const am = mk();
  const past = sec(Date.now() - 60_000);
  const logs = countResetLogs(() => {
    am.updateQuota(0, {
      'anthropic-ratelimit-unified-7d-utilization': '0.80',
      'anthropic-ratelimit-unified-7d-reset': String(past),
    });
    for (let i = 0; i < 50; i++) am._sweepAll();
  });
  ok('a <=now 7d reset is NOT stored', am.accounts[0].quota.unified7dReset === null);
  ok('its stale 7d utilization is cleared', am.accounts[0].quota.unified7d === null);
  ok('NO weekly reset-log storm across 50 sweeps', logs === 0); }

// ── a genuine transition still logs exactly ONCE, never repeats ────────────────
// Simulate a once-future reset that has now passed (set directly), then sweep
// repeatedly. _clearExpiredQuotas must log once, null the window, and never
// re-log on subsequent sweeps.
{ const am = mk();
  am.accounts[0].quota.unified5h = 0.5;
  am.accounts[0].quota.unified5hReset = Date.now() - 1000; // already passed
  const logs = countResetLogs(() => { for (let i = 0; i < 50; i++) am._sweepAll(); });
  ok('a real reset transition logs EXACTLY once (no repeat spam)', logs === 1);
  ok('the window is nulled after the transition', am.accounts[0].quota.unified5hReset === null && am.accounts[0].quota.unified5h === null); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

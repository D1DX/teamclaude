import { AccountManager } from '../src/account-manager.js';

// D1DX (operator 2026-06-06, D-1936): hard weekly-reserve floor for NEW bindings.
// No network — drives _pickAccountForBinding / _weeklyReserveFloor directly with
// in-memory accounts and hand-set 7d quota windows. Names mirror the live pool.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const H = 3600 * 1000, D = 24 * H;

const mk = (opts) => new AccountManager([
  { name: 'apple',  type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'banana', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'cherry', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'daniel', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, 0.20, 10, 1.3, opts || {});
const set = (am, name, u7d, resetInMs) => {
  const a = am.accounts.find(x => x.name === name);
  a.quota.unified7d = u7d;
  a.quota.unified7dReset = Date.now() + resetInMs;
  return a;
};

// ── floor scales with days-to-reset, clamped at the cap ───────────────────────
{ const am = mk();
  const a = set(am, 'apple', 0.5, 2 * D);
  ok('floor ≈ 0.15 at 2 days to reset (0.075×2)', Math.abs(am._weeklyReserveFloor(a) - 0.15) < 0.01);
  set(am, 'apple', 0.5, 4 * D);
  ok('floor ≈ 0.30 at 4 days to reset (0.075×4)', Math.abs(am._weeklyReserveFloor(a) - 0.30) < 0.01);
  set(am, 'apple', 0.5, 7 * D);
  ok('floor clamped to 0.50 at 7 days (0.075×7=0.525 → cap)', am._weeklyReserveFloor(a) === 0.50); }

// ── unknown reset → floor 0 (not gated) ───────────────────────────────────────
{ const am = mk();
  const a = am.accounts.find(x => x.name === 'apple');
  a.quota.unified7dReset = null;
  ok('unknown 7d reset → floor 0 (account not gated)', am._weeklyReserveFloor(a) === 0); }

// ── near-reset high-use accounts excluded; headroom accounts absorb new binds ──
{ const am = mk();
  set(am, 'apple',  0.93, 3 * D);   // floor 0.225, rem 0.07 → BELOW → excluded
  set(am, 'banana', 0.82, 3 * D);   // floor 0.225, rem 0.18 → BELOW → excluded
  set(am, 'cherry', 0.14, 3 * D);   // floor 0.225, rem 0.86 → above
  set(am, 'daniel', 0.17, 3 * D);   // floor 0.225, rem 0.83 → above
  const picks = [];
  for (let i = 0; i < 8; i++) picks.push(am.getAccountForSession('S' + i).name);
  ok('new bindings never land on below-floor apple/banana',
     !picks.includes('apple') && !picks.includes('banana'));
  ok('new bindings spread across headroom cherry/daniel',
     picks.includes('cherry') && picks.includes('daniel')); }

// ── single below-floor account still excluded while another is above floor ────
{ const am = mk();
  set(am, 'apple',  0.93, 4 * D);   // floor 0.30, rem 0.07 → BELOW
  set(am, 'banana', 0.40, 4 * D);   // floor 0.30, rem 0.60 → above
  set(am, 'cherry', 0.40, 4 * D);   // above
  set(am, 'daniel', 0.40, 4 * D);   // above
  const picks = [];
  for (let i = 0; i < 6; i++) picks.push(am.getAccountForSession('T' + i).name);
  ok('lone over-drained account is excluded from new binds', !picks.includes('apple')); }

// ── all below floor → degrade to most-headroom, never refuse service ──────────
{ const am = mk();
  set(am, 'apple',  0.90, 5 * D);   // floor 0.375 (clamped <0.5), rem 0.10 → below
  set(am, 'banana', 0.88, 5 * D);   // rem 0.12 → below
  set(am, 'cherry', 0.85, 5 * D);   // rem 0.15 → below
  set(am, 'daniel', 0.80, 5 * D);   // rem 0.20 → below (most headroom)
  const a = am._pickAccountForBinding();
  ok('all-below-floor still returns an account (keep working, never refuse)', a != null);
  ok('all-below-floor prefers the most-headroom account (daniel)', a.name === 'daniel'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

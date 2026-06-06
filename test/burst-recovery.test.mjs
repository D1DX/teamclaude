import { AccountManager } from '../src/account-manager.js';

// D1DX (operator 2026-06-06, D-1936): burst-429 fast recovery. A header-less 429
// on a budget-healthy account → short cooldown (stays in the pool); a near-cap
// account → the long 60s floor (rests). No network — drives markRateLimited
// directly and reads the resulting rateLimitedUntil window.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const mk = (opts) => new AccountManager([
  { name: 'apple',  type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'banana', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, 0.20, 10, 1.3, opts || {});
// apple = index 0 → stagger base 0, so the measured window isolates the cooldown.
const benchSec = (am, quota) => {
  const a = am.accounts[0];
  if (quota) Object.assign(a.quota, quota);
  am.markRateLimited(0, null);              // header-less (burst) 429
  return (a.rateLimitedUntil - Date.now()) / 1000;
};

// ── budget-healthy account → short cooldown (rejoins in seconds, not 60s) ─────
{ const am = mk();
  const s = benchSec(am, { unified5h: 0.20, unified7d: 0.20 });
  ok('healthy burst 429 → short cooldown (<15s, not the 60s floor)', s < 15 && s >= 5); }

// ── unknown quota windows → treated as healthy → short cooldown ───────────────
{ const am = mk();
  const s = benchSec(am, { unified5h: null, unified7d: null });
  ok('unknown windows → healthy → short cooldown (<15s)', s < 15); }

// ── near-cap account (weekly ≥ 0.80) → long floor (rests, ~60s+) ──────────────
{ const am = mk();
  const s = benchSec(am, { unified5h: 0.10, unified7d: 0.90 });
  ok('near-cap account keeps the long 60s floor (>55s)', s > 55); }

// ── hard-capped account → long floor (not short) ─────────────────────────────
{ const am = mk();
  const s = benchSec(am, { unified5h: 0.99, unified7d: 0.50 });
  ok('hard-capped account keeps the long floor (>55s)', s > 55); }

// ── explicit retry-after header honored regardless of health (clamped) ────────
{ const am = mk();
  const a = am.accounts[0];
  Object.assign(a.quota, { unified5h: 0.20, unified7d: 0.20 }); // healthy
  am.markRateLimited(0, 45);                                    // server gave retry-after 45s
  const s = (a.rateLimitedUntil - Date.now()) / 1000;
  ok('explicit retry-after honored even for a healthy account (~45s+)', s >= 45); }

// ── burst escalation is bounded at burstBackoffCapSec (30s) ───────────────────
{ const am = mk();
  const a = am.accounts[0];
  Object.assign(a.quota, { unified5h: 0.20, unified7d: 0.20 });
  for (let i = 0; i < 12; i++) am.markRateLimited(0, null);     // hammer → streak climbs
  const s = (a.rateLimitedUntil - Date.now()) / 1000;
  ok('healthy burst backoff bounded at cap (≤30s + small stagger)', s <= 35); }

// ── streak resets on success → next burst starts short again ─────────────────
{ const am = mk();
  const a = am.accounts[0];
  Object.assign(a.quota, { unified5h: 0.20, unified7d: 0.20 });
  for (let i = 0; i < 6; i++) am.markRateLimited(0, null);      // escalate
  am.noteAccountSuccess(0); // what server.js calls on a 2xx → resets the per-account streak
  am.markRateLimited(0, null);
  const s = (a.rateLimitedUntil - Date.now()) / 1000;
  ok('success resets streak → next healthy burst is short again (<15s)', s < 15); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

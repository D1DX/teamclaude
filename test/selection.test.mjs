import { AccountManager } from '../src/account-manager.js';

// Selection = eager throttle/quota sweep + session-sticky + (when no unified
// headers are present yet) least-loaded spread. The pace-to-weekly-line behavior
// on real utilization is covered in pace-controller.test.mjs (D-2104); these
// cases exercise the sweep, stickiness, failover, and the no-data fallback.
// No network — in-memory accounts.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = () => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98);

// ── eager sweep: expired throttles clear across the WHOLE pool, not just current ─
{ const am = mk(); am.markRateLimited(1, -60);
  ok('throttle set (pre-sweep)', am.accounts[1].status === 'throttled');
  am._sweepAll();
  ok('_sweepAll clears EXPIRED throttle on a non-current acct', am.accounts[1].status === 'active' && am.accounts[1].rateLimitedUntil === null); }

{ const am = mk(); am.markRateLimited(1, 300); am._sweepAll();
  ok('_sweepAll KEEPS a non-expired throttle', am.accounts[1].status === 'throttled'); }

{ const am = mk(); am._didBootSelect = true; am.currentIndex = 0; am.markRateLimited(2, -60);
  const a = am.getActiveAccount();
  ok('getActiveAccount sticky on a usable current', a.name === 'a0');
  ok('getActiveAccount swept a non-current expired throttle', am.accounts[2].status === 'active'); }

{ const am = mk(); am.markRateLimited(1, -60);
  const a1 = am.getStatus().accounts.find(a => a.name === 'a1');
  ok('getStatus renders swept state (no stale throttled)', a1.status === 'active' && a1.rateLimitedUntil === null); }

// ── sticky while the current account is usable ─────────────────────────────────
{ const am = mk(); am._didBootSelect = true; am.currentIndex = 1;
  ok('sticky on a usable current', am.getActiveAccount().name === 'a1'); }

// ── failover off a throttled current to a usable account ───────────────────────
{ const am = mk(); am._didBootSelect = true; am.currentIndex = 0; am.markRateLimited(0, 300);
  const a = am.getActiveAccount();
  ok('failover off a throttled current to a usable acct', !!a && a.name !== 'a0' && a.status === 'active'); }

// ── least-loaded pick: fewest in-flight wins ───────────────────────────────────
{ const am = mk();
  am.accounts[0]._inflight = 3; am.accounts[1]._inflight = 0; am.accounts[2]._inflight = 5;
  ok('_pickAccountForBinding picks the least-in-flight account (a1)', am._pickAccountForBinding().name === 'a1'); }

// in-flight tie → fewest warm sessions wins
{ const am = mk();
  am.getAccountForSession('warm-a0'); // binds least-loaded; force a0 warm
  // give a0 a warm session, leave a1/a2 empty → a new pick avoids a0
  const first = am.sessionBindings.values().next().value;
  am.accounts.forEach(a => { a._inflight = 0; });
  const pick = am._pickAccountForBinding();
  ok('tie on in-flight breaks to the least-warm account', am._activeSessionCounts().counts[pick.index] === 0); }

// ── hard rails (header path) exclude an account from selection ─────────────────
{ const am = mk();
  am.accounts[1].quota.unifiedStatus = 'rejected';
  am.accounts[0]._inflight = 2; am.accounts[2]._inflight = 4; // a1 would be least-loaded but is rejected
  ok('a rejected (hard-capped) account is excluded from selection', am._pickAccountForBinding().name !== 'a1'); }

// ── only the usable account is chosen when others are throttled ────────────────
{ const am = mk(); am.markRateLimited(0, 300); am.markRateLimited(2, 300);
  ok('the only usable account is selected when the others are throttled', am._pickAccountForBinding().name === 'a1'); }

// ── D-2182: apikey is a STRICT last resort (never beats a usable OAuth account) ─
const mkBk = () => new AccountManager([
  { name: 'oa', type: 'oauth',  accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'ob', type: 'oauth',  accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'bk', type: 'apikey', apiKey: 'k' },
], 0.98);

// apikey NOT picked while any OAuth is usable — even when both OAuth are over their
// pace-line (negative paceScore) and the apikey's flat-0 would otherwise win.
{ const am = mkBk();
  am.accounts[0].quota.unified7d = 0.95; am.accounts[1].quota.unified7d = 0.95;
  ok('apikey NOT picked while OAuth usable (D-2182)', am._pickAccountForBinding().type === 'oauth'); }

// apikey IS the last resort — picked only when no OAuth account is usable.
{ const am = mkBk(); am.markRateLimited(0, 300); am.markRateLimited(1, 300);
  ok('apikey picked only when all OAuth throttled (last resort)', am._pickAccountForBinding().name === 'bk'); }

// sticky-yield: a session on the apikey migrates back to OAuth once it recovers.
{ const am = mkBk(); am.markRateLimited(0, 300); am.markRateLimited(1, 300);
  const first = am.getAccountForSession('s1');           // all OAuth down → binds apikey
  am.accounts[0].rateLimitedUntil = null; am.accounts[0].status = 'active'; // oa recovers
  const next = am.getAccountForSession('s1');
  ok('session on apikey yields back to OAuth on recovery', first.name === 'bk' && next.type === 'oauth'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

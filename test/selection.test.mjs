import { AccountManager } from '../src/account-manager.js';

// Lightweight assertion harness for the two-tier weekly-reserve selector +
// the eager throttle/quota sweep. No network — constructs accounts in-memory.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = () => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, 0.20);

// Eager sweep — expired throttles clear across the WHOLE pool, not just `current`.
{ const am = mk(); am.markRateLimited(1, -60);
  ok('throttle set (pre-sweep)', am.accounts[1].status === 'throttled');
  am._sweepAll();
  ok('_sweepAll clears EXPIRED throttle on non-current acct', am.accounts[1].status === 'active' && am.accounts[1].rateLimitedUntil === null); }

{ const am = mk(); am.markRateLimited(1, 300); am._sweepAll();
  ok('_sweepAll KEEPS a non-expired throttle', am.accounts[1].status === 'throttled'); }

{ const am = mk(); am._didBootSelect = true; am.currentIndex = 0; am.markRateLimited(2, -60);
  const a = am.getActiveAccount();
  ok('getActiveAccount sticky on preferred current', a.name === 'a0');
  ok('getActiveAccount swept non-current expired throttle', am.accounts[2].status === 'active'); }

{ const am = mk(); am.markRateLimited(1, -60);
  const a1 = am.getStatus().accounts.find(a => a.name === 'a1');
  ok('getStatus renders swept state (no stale throttled)', a1.status === 'active' && a1.rateLimitedUntil === null); }

// Selection invariants.
{ const am = mk(); am._didBootSelect = true; am.currentIndex = 1;
  ok('sticky on preferred current', am.getActiveAccount().name === 'a1'); }

{ const am = mk(); am._didBootSelect = true; am.currentIndex = 0; am.markRateLimited(0, 300);
  const a = am.getActiveAccount();
  ok('failover off throttled current to a preferred acct', !!a && a.name !== 'a0' && a.status === 'active'); }

{ const am = mk(); am.accounts[0].quota.unified7d = 0.5; am.accounts[0].quota.unified7dReset = Date.now() + 1e9;
  ok('preferred when weekly below cap', am._isPreferred(am.accounts[0]) === true);
  am.accounts[1].quota.unifiedStatus = 'rejected';
  ok('NOT preferred when unified-status rejected', am._isPreferred(am.accounts[1]) === false); }

// D1DX §5.1 — periodic re-rank + boot-select (Fix C). Urgency = (timeDecayedCap - u7d)/timeToReset,
// so a soonest-resetting, below-cap account is the use-it-or-lose-it pick.
const DAY = 86400000;
{ const am = mk(); am.currentIndex = 2; // artificial — boot-select must ignore it
  const now = Date.now();
  am.accounts[0].quota.unified7d = 0.10; am.accounts[0].quota.unified7dReset = now + 6 * DAY;
  am.accounts[1].quota.unified7d = 0.15; am.accounts[1].quota.unified7dReset = now + 2 * DAY; // highest urgency (soonest reset)
  am.accounts[2].quota.unified7d = 0.10; am.accounts[2].quota.unified7dReset = now + 6 * DAY;
  const a = am.getActiveAccount();
  ok('boot-select picks highest-urgency acct (not index 0 / artificial current)', a.name === 'a1' && am.currentIndex === 1);
  ok('boot-select flag set after first selection', am._didBootSelect === true); }

{ const am = mk(); am._didBootSelect = true; am.rerankEvery = 2; am.currentIndex = 0;
  const now = Date.now();
  am.accounts[0].quota.unified7d = 0.10; am.accounts[0].quota.unified7dReset = now + 6 * DAY; // low urgency, late reset
  am.accounts[1].quota.unified7d = 0.15; am.accounts[1].quota.unified7dReset = now + 2 * DAY; // high urgency, soon reset
  am.accounts[2].quota.unified7d = 0.10; am.accounts[2].quota.unified7dReset = now + 6 * DAY;
  am.getActiveAccount();
  ok('re-rank holds within cadence (sticky until rerankEvery)', am.currentIndex === 0);
  const a = am.getActiveAccount();
  ok('periodic re-rank switches to higher-urgency acct past margin', a.name === 'a1' && am.currentIndex === 1); }

{ const am = mk(); am._didBootSelect = true; am.rerankEvery = 1; am.currentIndex = 0;
  const now = Date.now();
  am.accounts[0].quota.unified7d = 0.10; am.accounts[0].quota.unified7dReset = now + 6 * DAY;
  am.accounts[1].quota.unified7d = 0.12; am.accounts[1].quota.unified7dReset = now + 5.5 * DAY; // only marginally more urgent (< 1.3x)
  am.accounts[2].quota.unified7d = 0.10; am.accounts[2].quota.unified7dReset = now + 6 * DAY;
  const a = am.getActiveAccount();
  ok('re-rank holds within margin (no cache-churn)', a.name === 'a0' && am.currentIndex === 0); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

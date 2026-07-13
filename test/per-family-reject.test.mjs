import { AccountManager } from '../src/account-manager.js';

// DL-2841: per-model-tier weekly sub-limit (premium/flagship, e.g. Fable). Anthropic
// meters it on the `unified-7d_oi-*` axis and rejects premium-model requests on it while
// the account's BASE 5h/7d budget is fine. The proxy must attribute that reject to the
// premium tier ONLY — keep the account in the pool for non-premium models, and skip it
// for premium requests until the sub-limit resets. No network — in-memory accounts.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = (opts = {}) => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, { backoffJitterSec: 0, ...opts });

const secs = (n) => String(Math.floor(Date.now() / 1000) + n);
// Headers for a Fable (premium) 429: base axes healthy, the 7d_oi sub-axis rejected,
// and the top-line unified-status MIRRORS the premium sub-axis (this is the real shape
// observed on mango, DL-2841 probe).
const fableRejectHeaders = () => ({
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.01',
  'anthropic-ratelimit-unified-5h-reset': secs(3600),
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.75',
  'anthropic-ratelimit-unified-7d-reset': secs(7200),
  'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
  'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
  'anthropic-ratelimit-unified-7d_oi-reset': secs(7200),
  'anthropic-ratelimit-unified-status': 'rejected',
});
// Headers for a Sonnet (non-premium) 200: no 7d_oi axis, everything allowed.
const sonnetOkHeaders = () => ({
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.01',
  'anthropic-ratelimit-unified-5h-reset': secs(3600),
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.75',
  'anthropic-ratelimit-unified-7d-reset': secs(7200),
  'anthropic-ratelimit-unified-status': 'allowed',
});

// ── 1. A premium-tier reject does NOT bench the account (unstick the stuck trap) ──
{ const am = mk();
  am.updateQuota(0, fableRejectHeaders());
  ok('account-wide unifiedStatus stays on the BASE axes (allowed), not the premium mirror',
     am.accounts[0].quota.unifiedStatus === 'allowed');
  ok('the premium sub-axis is recorded separately (premiumStatus rejected)',
     am.accounts[0].quota.premiumStatus === 'rejected');
  ok('_premiumRejected(account) is true while the sub-limit holds',
     am._premiumRejected(am.accounts[0]) === true);
  ok('account is STILL usable (in the pool for non-premium models)',
     am._isUsable(am.accounts[0]) === true);
  ok('account is STILL 5h-eligible (never-stall rail does not exclude it)',
     am._fiveHourEligible(am.accounts[0]) === true); }

// ── 2. markRateLimited on a premium-scoped 429 must NOT throttle the whole account ──
{ const am = mk();
  am.updateQuota(0, fableRejectHeaders());     // server runs updateQuota first on a 429
  am.markRateLimited(0, 5944);                 // then markRateLimited with the retry-after
  ok('premium-scoped 429 leaves the account active (not throttled)',
     am.accounts[0].status !== 'throttled');
  ok('premium-scoped 429 does not start the burst streak',
     (am.accounts[0]._429streak || 0) === 0);
  ok('premium-scoped 429 does not set an account-wide bench',
     !am.accounts[0].rateLimitedUntil); }

// ── 3. model classifier ──
{ const am = mk();
  ok('claude-fable-5 is premium', am._isPremiumModel('claude-fable-5') === true);
  ok('claude-sonnet-5 is not premium', am._isPremiumModel('claude-sonnet-5') === false);
  ok('claude-opus-4-6 is not premium', am._isPremiumModel('claude-opus-4-6') === false);
  ok('null model is not premium', am._isPremiumModel(null) === false); }

// ── 4. selection: premium request avoids a premium-capped account; non-premium uses it ─
{ const am = mk();
  am.updateQuota(0, fableRejectHeaders());     // a0 premium-capped
  // 20 premium picks must never land on a0 while a1/a2 are premium-eligible.
  let a0PremiumPicks = 0, a0AnyPicks = 0;
  for (let i = 0; i < 20; i++) {
    const p = am._pickAccountForBinding({ model: 'claude-fable-5' });
    if (p && p.index === 0) a0PremiumPicks++;
  }
  for (let i = 0; i < 20; i++) {
    const p = am._pickAccountForBinding({ model: 'claude-sonnet-5' });
    if (p && p.index === 0) a0AnyPicks++;
  }
  ok('a premium (Fable) bind never picks the premium-capped account', a0PremiumPicks === 0);
  ok('a non-premium (Sonnet) bind CAN still pick that account', a0AnyPicks > 0); }

// ── 5. all-capped fallback: a premium request still binds (honest 429 rather than null) ─
{ const am = mk();
  am.updateQuota(0, fableRejectHeaders());
  am.updateQuota(1, fableRejectHeaders());
  am.updateQuota(2, fableRejectHeaders());
  const p = am._pickAccountForBinding({ model: 'claude-fable-5' });
  ok('premium request with EVERY account premium-capped still returns an account (upstream 429s honestly)',
     p !== null); }

// ── 6. recovery: a premium `allowed` response clears the cap ──
{ const am = mk();
  am.updateQuota(0, fableRejectHeaders());
  ok('capped before recovery', am._premiumRejected(am.accounts[0]) === true);
  const recovered = { ...sonnetOkHeaders(),
    'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.20',
    'anthropic-ratelimit-unified-7d_oi-reset': secs(7200) };
  am.updateQuota(0, recovered);
  ok('a premium `allowed` response clears _premiumRejected', am._premiumRejected(am.accounts[0]) === false);
  ok('premiumStatus is back to null/allowed', am.accounts[0].quota.premiumStatus !== 'rejected'); }

// ── 7. a GENUINE account-wide weekly cap still benches (no premium false-negative) ──
{ const am = mk();
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-7d-status': 'rejected',
    'anthropic-ratelimit-unified-7d-utilization': '0.99',
    'anthropic-ratelimit-unified-7d-reset': secs(7200),
    'anthropic-ratelimit-unified-status': 'rejected',
  });
  ok('a base-axis rejection still sets account-wide unifiedStatus rejected',
     am.accounts[0].quota.unifiedStatus === 'rejected');
  ok('a genuinely weekly-capped account is NOT usable', am._isUsable(am.accounts[0]) === false); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

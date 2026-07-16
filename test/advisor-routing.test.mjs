import { AccountManager } from '../src/account-manager.js';

// DL-2841 advisor-aware premium skip. Claude Code's advisor tool keeps the EXECUTOR
// in the top-level `model` and nests the advisor's model in tools[]. When the advisor
// model is premium (Fable) but the executor (Opus/Sonnet) is not, selection must STILL
// avoid a premium-capped (7d_oi) account — else the advisor sub-call lands on a capped
// account and Claude Code disables the advisor for the session.
//
// This is our reactive-only policy — NOT upstream's route-pin / per-family-weekly-bucket
// routing (that stays out; core/selection picks). The parser lift itself is covered by
// model.test.mjs; here we assert the SELECTION consequence. No network — in-memory.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = () => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, { backoffJitterSec: 0 });

const secs = (n) => String(Math.floor(Date.now() / 1000) + n);
// A Fable (premium) 429: base axes healthy, the 7d_oi sub-axis rejected — the exact
// shape that premium-caps a0 while leaving it usable for non-premium (DL-2841).
const fableRejectHeaders = () => ({
  'anthropic-ratelimit-unified-5h-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.01', 'anthropic-ratelimit-unified-5h-reset': secs(3600),
  'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-7d-utilization': '0.5', 'anthropic-ratelimit-unified-7d-reset': secs(7200),
  'anthropic-ratelimit-unified-7d_oi-status': 'rejected', 'anthropic-ratelimit-unified-7d_oi-utilization': '1.0', 'anthropic-ratelimit-unified-7d_oi-reset': secs(7200),
  'anthropic-ratelimit-unified-status': 'rejected',
});
const OPUS = 'claude-opus-4-8', FABLE = 'claude-fable-5';

// ── 1. _premiumRequested: executor OR advisor premium ─────────
{ const am = mk();
  ok('executor premium → requested', am._premiumRequested({ model: FABLE }) === true);
  ok('advisor premium under non-premium executor → requested', am._premiumRequested({ model: OPUS, advisorModel: FABLE }) === true);
  ok('neither premium → not requested', am._premiumRequested({ model: OPUS }) === false);
  ok('empty opts → not requested', am._premiumRequested({}) === false); }

// ── 2. selection: an advisor-Fable request skips the premium-capped account ─
{ const am = mk();
  am.updateQuota(0, fableRejectHeaders());        // a0 premium-capped
  let a0AdvisorPicks = 0, a0PlainOpusPicks = 0;
  for (let i = 0; i < 20; i++) {
    const p = am._pickAccountForBinding({ model: OPUS, advisorModel: FABLE });   // opus executor + fable advisor
    if (p && p.index === 0) a0AdvisorPicks++;
  }
  for (let i = 0; i < 20; i++) {
    const p = am._pickAccountForBinding({ model: OPUS });                        // plain opus, no advisor
    if (p && p.index === 0) a0PlainOpusPicks++;
  }
  ok('an advisor-Fable request NEVER binds the premium-capped account (DL-2841)', a0AdvisorPicks === 0);
  ok('a plain (non-advisor) Opus request CAN still bind that account', a0PlainOpusPicks > 0); }

// ── 3. sticky path: getActiveAccount does not stay on a premium-capped current ─
{ const am = mk();
  am.getActiveAccount({ model: OPUS });           // boot-select (sets _didBootSelect)
  am.updateQuota(0, fableRejectHeaders());        // cap the account we might be stuck on
  am.currentIndex = 0;
  const stuck = am.getActiveAccount({ model: OPUS, advisorModel: FABLE });
  ok('an advisor-Fable request rebinds off a premium-capped current account', stuck && stuck.index !== 0);
  am.currentIndex = 0;
  const plain = am.getActiveAccount({ model: OPUS });
  ok('a plain Opus request stays sticky on that account (non-premium)', plain && plain.index === 0); }

// ── 4. session warm-retention: rebind an advisor-Fable request off a capped binding ─
{ const am = mk();
  const sid = 'sess-1';
  am.sessionBindings.set(sid, { index: 0, lastUsedAt: Date.now(), boundAt: Date.now(), firstSeenAt: Date.now(), requests: 0, inputTokens: 0, outputTokens: 0 });
  am.updateQuota(0, fableRejectHeaders());        // the bound account is premium-capped
  const rebind = am.getAccountForSession(sid, { model: OPUS, advisorModel: FABLE });
  ok('a warm binding on a premium-capped account rebinds for an advisor-Fable request', rebind && rebind.index !== 0);
  // reset the binding to a0 and confirm a plain request keeps it warm
  am.sessionBindings.set(sid, { index: 0, lastUsedAt: Date.now(), boundAt: Date.now(), firstSeenAt: Date.now(), requests: 0, inputTokens: 0, outputTokens: 0 });
  const keep = am.getAccountForSession(sid, { model: OPUS });
  ok('a plain Opus request keeps the warm binding on that account', keep && keep.index === 0); }

// ── 5. allHardCapped is advisor-aware ─────────────────────────
{ const am = mk();
  for (const i of [0, 1, 2]) am.updateQuota(i, fableRejectHeaders());   // every account premium-capped
  ok('allHardCapped(opus, fable) → true when the whole pool is premium-capped for the advisor',
     am.allHardCapped(OPUS, FABLE) === true);
  ok('allHardCapped(opus) → false — the base axes are fine for a non-premium request',
     am.allHardCapped(OPUS) === false); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

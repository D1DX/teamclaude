import { AccountManager } from '../src/account-manager.js';
import { isFableReserved } from '../src/core/selection.js';

// DL-3563 — Fable (7d_oi) RESERVATION: a NON-premium request AVOIDS accounts that still
// hold Fable headroom, so their scarce base-5h budget stays free to serve Fable. Mirror of
// the premium filter; bind-time only; empty-set fallback preserves availability; pure
// selection ORDERING, never an admission signal (reactive-only intact). No network.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = (opts) => new AccountManager([
  { name: 'fable',  type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'capped', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, opts);
const PREMIUM = 'claude-fable-5', NORMAL = 'claude-opus-4-8';

// The live scenario: the Fable-headroom account is ALSO the weekly pace-winner (lowest
// weekly), so pace-to-line would pile all traffic onto it. Reservation must OVERRIDE pace
// for non-premium and send it to the Fable-exhausted account instead — while Fable still
// lands on the Fable-headroom account.
{ const am = mk();
  am.accounts[0].quota.premiumUtil = 0.35; am.accounts[0].quota.unified7d = 0.36; // Fable headroom + LOWEST weekly (pace-winner)
  am.accounts[1].quota.premiumUtil = 1.00; am.accounts[1].quota.unified7d = 0.70; // Fable exhausted, higher weekly
  ok('non-premium bind AVOIDS the Fable-headroom pace-winner → the Fable-capped account',
     am._pickAccountForBinding({ model: NORMAL }).name === 'capped');
  ok('a Fable request still lands on the Fable-headroom account (premium path intact)',
     am._pickAccountForBinding({ model: PREMIUM }).name === 'fable'); }

// Fallback — every usable account still holds Fable headroom → non-premium STILL binds
// (never empties; availability over reservation).
{ const am = mk();
  am.accounts[0].quota.premiumUtil = 0.30;
  am.accounts[1].quota.premiumUtil = 0.40;
  ok('all accounts Fable-reserved → non-premium still binds (empty-set fallback)',
     !!am._pickAccountForBinding({ model: NORMAL })); }

// Toggle off — reserveFableHeadroom:false disables the reservation entirely (pace wins).
{ const am = mk({ reserveFableHeadroom: false });
  am.accounts[0].quota.premiumUtil = 0.30; am.accounts[0].quota.unified7d = 0.30; // pace-winner + Fable headroom
  am.accounts[1].quota.premiumUtil = 1.00; am.accounts[1].quota.unified7d = 0.70;
  ok('reserveFableHeadroom:false → non-premium may pick the Fable-headroom account',
     am._pickAccountForBinding({ model: NORMAL }).name === 'fable'); }

// isFableReserved predicate contract.
{ const am = mk(); const a = am.accounts[0];
  a.quota.premiumUtil = 0.30; ok('reserved: real headroom above floor', isFableReserved(am, a) === true);
  a.quota.premiumUtil = 1.00; ok('not reserved: Fable exhausted (util 1.0)', isFableReserved(am, a) === false);
  a.quota.premiumUtil = 0.95; ok('not reserved: headroom below floor (0.05 < 0.10)', isFableReserved(am, a) === false);
  a.quota.premiumUtil = null; ok('not reserved: no Fable data (null → unknown capability)', isFableReserved(am, a) === false); }

// Custom floor honored.
{ const am = mk({ fableReserveHeadroomFloor: 0.5 }); const a = am.accounts[0];
  a.quota.premiumUtil = 0.30; ok('floor 0.5: headroom 0.70 → reserved', isFableReserved(am, a) === true);
  a.quota.premiumUtil = 0.60; ok('floor 0.5: headroom 0.40 → not reserved', isFableReserved(am, a) === false); }

// Reactive-only: the reservation never benches/excludes/hard-caps/empties.
{ const am = mk();
  am.accounts[0].quota.premiumUtil = 0.20; am.accounts[0].quota.unified7d = 0.20;
  am.accounts[1].quota.premiumUtil = 0.20; am.accounts[1].quota.unified7d = 0.20;
  const snap = am.accounts.map(a => ({ status: a.status, rl: a.rateLimitedUntil, pr: a._premiumRejectedUntil || 0, us: a.quota.unifiedStatus }));
  let everNull = false;
  for (let i = 0; i < 40; i++) {
    if (!am._pickAccountForBinding({ model: NORMAL }))  everNull = true;
    if (!am._pickAccountForBinding({ model: PREMIUM })) everNull = true;
  }
  const mutated = am.accounts.some((a, i) =>
    a.status !== snap[i].status || a.rateLimitedUntil !== snap[i].rl ||
    (a._premiumRejectedUntil || 0) !== snap[i].pr || a.quota.unifiedStatus !== snap[i].us);
  ok('REACTIVE-ONLY: reservation never benched/excluded an account', !mutated);
  ok('REACTIVE-ONLY: reservation never returned null while a usable account existed', !everNull); }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

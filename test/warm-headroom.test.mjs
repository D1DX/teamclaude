import { AccountManager } from '../src/account-manager.js';

// D-2805: warmHeadroom mints ONLY headroom OAuth accounts, skips capped +
// non-oauth, and reuses warmOne (stubbed here — no network). Verifies the
// threshold partition + summary shape.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const mk = () => new AccountManager([
  { name: 'headroom',   type: 'oauth',  accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'capped',     type: 'oauth',  accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'unknown',    type: 'oauth',  accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'apikeyacct', type: 'apikey', credential: 'k' },
], 0.98);

// ── partition on the 0.90 threshold; warmOne stubbed to avoid network ──────────
{
  const am = mk();
  am.accounts[0].quota.unified7d = 0.10;   // headroom → mint
  am.accounts[1].quota.unified7d = 0.95;   // capped   → skip
  am.accounts[2].quota.unified7d = null;   // unknown  → treated as headroom → mint
  const warmed = [];
  am.warmOne = async (account) => { warmed.push(account.name); account.quota.unified5h = 0.01; return 200; };

  const summary = await am.warmHeadroom(0.90, 'https://example.invalid');

  ok('minted the headroom + unknown OAuth accounts', warmed.includes('headroom') && warmed.includes('unknown'));
  ok('did NOT warm the capped account', !warmed.includes('capped'));
  ok('did NOT warm the apikey account', !warmed.includes('apikeyacct'));
  ok('summary.minted has 2 entries', summary.minted.length === 2);
  ok('summary.minted carries status + utilization', summary.minted[0].status === 200 && summary.minted[0].unified5h === 0.01);
  ok('capped is reported skipped with reason', summary.skipped.some((s) => s.name === 'capped' && /capped/.test(s.reason)));
  ok('apikey is reported skipped as not oauth', summary.skipped.some((s) => s.name === 'apikeyacct' && /not oauth/.test(s.reason)));
  ok('summary echoes the threshold', summary.threshold === 0.90);
}

// ── a per-account warm error is captured, not thrown ───────────────────────────
{
  const am = mk();
  am.accounts[0].quota.unified7d = 0.10;
  am.accounts[1].quota.unified7d = 0.10;
  am.accounts[2].quota.unified7d = 0.10;
  am.warmOne = async (account) => { if (account.name === 'capped') throw new Error('boom'); return 200; };

  const summary = await am.warmHeadroom(0.90, 'https://example.invalid');
  ok('a warm error becomes a skip, not a throw', summary.skipped.some((s) => s.name === 'capped' && /warm error: boom/.test(s.reason)));
  ok('the other accounts still minted', summary.minted.length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

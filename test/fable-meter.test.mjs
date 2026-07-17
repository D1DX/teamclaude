import { AccountManager } from '../src/account-manager.js';
import { DeckSnapshotSource } from '../src/deck-source.js';
import { TUI } from '../src/tui.js';

// DL-3160: a distinct per-account Fable/premium (7d_oi) meter in reporting — Deck
// rows, `teamclaude status`, and the capacity snapshot — separate from the base
// 5h/7d meters, with its reset time. REPORTING ONLY: admission/selection untouched
// (reactive-only stands, DL-2841 held). Real-header-driven (or prober-fed); a meter
// is never a silent estimate — no premium data → no bar.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const mk = () => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, { backoffJitterSec: 0 });
const secs = (n) => String(Math.floor(Date.now() / 1000) + n);

// Base 5h/7d healthy; the premium 7d_oi axis ALLOWED but utilized (util + reset).
const fableAllowedHeaders = (util = '0.60', resetSec = 7200) => ({
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.10',
  'anthropic-ratelimit-unified-5h-reset': secs(3600),
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.40',
  'anthropic-ratelimit-unified-7d-reset': secs(604800),
  'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
  'anthropic-ratelimit-unified-7d_oi-utilization': util,
  'anthropic-ratelimit-unified-7d_oi-reset': secs(resetSec),
  'anthropic-ratelimit-unified-status': 'allowed',
});
const fableRejectHeaders = () => ({
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.01',
  'anthropic-ratelimit-unified-5h-reset': secs(3600),
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.75',
  'anthropic-ratelimit-unified-7d-reset': secs(604800),
  'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
  'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
  'anthropic-ratelimit-unified-7d_oi-reset': secs(7200),
  'anthropic-ratelimit-unified-status': 'rejected',
});

// ── S1: updateQuota captures the premium axis (util + reset), reset UNCONDITIONALLY ──
{ const am = mk();
  am.updateQuota(0, fableAllowedHeaders('0.60', 7200));
  const q = am.accounts[0].quota;
  ok('S1: an ALLOWED premium response captures premiumUtil', q.premiumUtil === 0.6);
  ok('S1: an ALLOWED premium response captures premiumReset (the DL-3160 gap fix)',
     q.premiumReset != null && q.premiumReset > Date.now());
  ok('S1: an allowed premium response sets NO admission bench (reactive-only stands)',
     am.accounts[0]._premiumRejectedUntil === 0); }

{ const am = mk();
  am.updateQuota(0, fableRejectHeaders());
  const q = am.accounts[0].quota;
  ok('S1: a REJECTED premium response captures reset + benches premium only',
     q.premiumStatus === 'rejected' && q.premiumReset > Date.now()
     && am._premiumRejected(am.accounts[0]) === true); }

{ const am = mk();
  // A premium reset already in the past must clear (D-2236 guard), never persist stale.
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.50',
    'anthropic-ratelimit-unified-7d_oi-reset': secs(-100) });
  ok('S1: a passed premium reset is cleared, never stored stale',
     am.accounts[0].quota.premiumReset === null); }

// ── S2: the _premiumAxis Deck helper — real data → meter, none → no bar ──
{ const px = TUI.prototype._premiumAxis;
  ok('S2: util present → { r, t } meter', (() => { const a = px({ premiumUtil: 0.6, premiumReset: 123 }); return a.r === 0.6 && a.t === 123; })());
  ok('S2: rejected without util → full bar (r=1) so the cap is visible',
     (() => { const a = px({ premiumStatus: 'rejected', premiumReset: 9 }); return a.r === 1 && a.t === 9; })());
  ok('S2: no premium data → null (no bar fabricated)', px({ unified5h: 0.2 }) === null);
  ok('S2: null quota → null', px(null) === null); }

// ── S2: the Deck actually renders a labeled "Fbl" meter for a premium-utilized account ──
{ const am = mk();
  am.updateQuota(0, fableAllowedHeaders('0.60', 7200));
  const snap = am.getDeckSnapshot();
  const src = new DeckSnapshotSource(snap);
  const config = { proxy: { port: 3456, apiKey: 'k' } };
  const tui = new TUI({ accountManager: src, config, readOnly: true, onQuit: () => {} });
  tui.running = true;
  let frame = '';
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { frame += s; return true; };
  try { tui.render(); } finally { process.stdout.write = realWrite; }
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');
  ok('S2: the Deck renders a labeled "Fbl" meter for a premium-utilized account', plain.includes('Fbl')); }

// ── S2: no "Fbl" meter for an account with no premium data (never a silent estimate) ──
{ const am = mk();
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.10', 'anthropic-ratelimit-unified-5h-reset': secs(3600),
    'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-7d-utilization': '0.40',
    'anthropic-ratelimit-unified-7d-reset': secs(604800), 'anthropic-ratelimit-unified-status': 'allowed' });
  const src = new DeckSnapshotSource(am.getDeckSnapshot());
  const config = { proxy: { port: 3456, apiKey: 'k' } };
  const tui = new TUI({ accountManager: src, config, readOnly: true, onQuit: () => {} });
  tui.running = true;
  let frame = '';
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { frame += s; return true; };
  try { tui.render(); } finally { process.stdout.write = realWrite; }
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');
  ok('S2: no premium data → no "Fbl" meter rendered', !plain.includes('Fbl')); }

// ── S3: the capacity snapshot carries a distinct per-account premium field ──
{ const am = mk();
  am.updateQuota(0, fableAllowedHeaders('0.60', 7200));
  const capA = am.computeCapacity().accounts[0];
  ok('S3: computeCapacity exposes a premium sub-object (util + reset + status + capped)',
     capA.premium && capA.premium.util === 0.6 && capA.premium.reset > Date.now()
     && capA.premium.status === 'allowed' && capA.premium.capped === false); }

{ const am = mk();
  am.updateQuota(0, fableRejectHeaders());
  const capA = am.computeCapacity().accounts[0];
  ok('S3: a premium-capped account reads capped:true in the capacity snapshot (reporting only)',
     capA.premium.capped === true && capA.premium.status === 'rejected'
     && capA.live === true); } // capped premium ≠ dead: still live for non-premium

{ const am = mk();
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.10', 'anthropic-ratelimit-unified-5h-reset': secs(3600) });
  const capA = am.computeCapacity().accounts[0];
  ok('S3: an account with no premium data → premium.util null (no estimate)',
     capA.premium.util === null && capA.premium.capped === false); }

// ── S3: getStatus carries the premium axis into the deck/status snapshot (watch reads it) ──
{ const am = mk();
  am.updateQuota(0, fableAllowedHeaders('0.60', 7200));
  const acct = am.getStatus().accounts[0];
  ok('S3: getStatus() account quota carries premiumUtil + premiumReset for status + watch',
     acct.quota.premiumUtil === 0.6 && acct.quota.premiumReset > Date.now()); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

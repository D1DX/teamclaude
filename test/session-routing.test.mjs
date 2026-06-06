import { AccountManager } from '../src/account-manager.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// D1DX (D-1728): per-session cache-affinity routing + bounded per-account
// backoff. No network — drives getAccountForSession / _pickAccountForBinding /
// markRateLimited directly with in-memory accounts and hand-set quota windows.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = (opts) => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, 0.20, 10, 1.3, opts || {});
const H = 3600 * 1000, D = 24 * H;

// ── S1: warm-stick — a warm session reuses its bound account (no switch) ──────
{ const am = mk();
  const first = am.getAccountForSession('S1');
  const again = am.getAccountForSession('S1');
  ok('warm session reuses its bound account (no switch)', first.name === again.name && am.sessionBindings.size === 1); }

// warm-stick beats urgency: a more-urgent account must NOT pull a warm session.
{ const am = mk();
  const bound = am.getAccountForSession('S1');               // binds (equal urgency → a0)
  const other = am.accounts.find(a => a.index !== bound.index);
  other.quota.unified7dReset = Date.now() + 1 * H;            // make another account far more urgent
  other.quota.unified7d = 0.05;
  const again = am.getAccountForSession('S1');                // still warm → must stay put
  ok('non-urgent balancing does NOT cut a warm session mid-window', again.name === bound.name); }

// ── no-sid fallback → global selector (warmer / health / non-CC) ──────────────
{ const am = mk();
  const a = am.getAccountForSession(null);
  ok('no session id falls back to the global selector', a != null && am.sessionBindings.size === 0); }

// ── S3: blocker → immediate rebind to a different account ─────────────────────
{ const am = mk();
  const bound = am.getAccountForSession('S1');
  am.markRateLimited(bound.index, 300);                       // bench the bound account
  const rebind = am.getAccountForSession('S1');               // bound blocked → switch now
  ok('blocker (429) rebinds the session immediately to a different account', rebind.name !== bound.name); }

// ── window lapsed → rebind allowed; picks the now-more-urgent account ─────────
{ const am = mk();
  const bound = am.getAccountForSession('S1');
  const b = am.sessionBindings.get('S1');
  b.lastUsedAt = Date.now() - am.cacheAffinityWindowMs - 5000; // idle past the cache window
  const other = am.accounts.find(a => a.index !== bound.index);
  other.quota.unified7dReset = Date.now() + 2 * H;             // other now most urgent
  other.quota.unified7d = 0.05;
  const rebind = am.getAccountForSession('S1');
  ok('window lapsed → rebinds to the now-highest-urgency account', rebind.name === other.name); }

// ── S2: distribution spreads sessions across accounts (no reset bias) ─────────
{ const am = mk();
  for (let i = 0; i < 6; i++) am.getAccountForSession('S' + i); // equal urgency, boost 1
  const { counts } = am._activeSessionCounts();
  const max = Math.max(...counts), min = Math.min(...counts);
  ok('6 sessions spread evenly across 3 accounts (parallel capacity)', max - min <= 1 && counts.reduce((s, c) => s + c, 0) === 6); }

// ── S2: reset-proximity boost — soon-to-reset account absorbs MORE sessions ───
{ const am = mk();
  const now = Date.now();
  am.accounts[0].quota.unified7dReset = now + 6 * H;  am.accounts[0].quota.unified7d = 0.10; // imminent + headroom
  am.accounts[1].quota.unified7dReset = now + 6 * D;  am.accounts[1].quota.unified7d = 0.10; // far
  am.accounts[2].quota.unified7dReset = now + 6 * D;  am.accounts[2].quota.unified7d = 0.10; // far
  for (let i = 0; i < 6; i++) am.getAccountForSession('S' + i);
  const { counts } = am._activeSessionCounts();
  ok('reset-proximity boost drains the soon-to-reset account harder', counts[0] > counts[1] && counts[0] > counts[2]); }

// boost is gated on headroom: a soon-to-reset account with NO weekly headroom is not boosted.
{ const am = mk();
  am.accounts[0].quota.unified7dReset = Date.now() + 6 * H;
  am.accounts[0].quota.unified7d = 1.0;               // imminent but no headroom
  ok('reset-proximity boost is 1 when the account has no weekly headroom', am._resetProximityBoost(am.accounts[0]) === 1); }

// ── S3: bounded per-account backoff — escalates, caps, resets on success ──────
// D-1936: the SUSTAINED path (near-cap account) keeps the 60s floor. A headerless
// 429 on a near-cap account is genuine pressure, not burst → long backoff. (The
// budget-healthy burst path → short cooldown is covered in burst-recovery.test.mjs.)
{ const am = mk({ perAccountBackoffFloorSec: 60, perAccountBackoffFactor: 1.5, perAccountBackoffCapSec: 600, recoveryStaggerSec: 0 });
  am.accounts[0].quota.unified7d = 0.90;             // near-cap → sustained (long) backoff path
  const now = Date.now();
  am.markRateLimited(0, null); const w1 = Math.round((am.accounts[0].rateLimitedUntil - now) / 1000);
  am.markRateLimited(0, null); const w2 = Math.round((am.accounts[0].rateLimitedUntil - now) / 1000);
  am.markRateLimited(0, null); const w3 = Math.round((am.accounts[0].rateLimitedUntil - now) / 1000);
  ok('headerless 429 on a near-cap account escalates bounded 60→90→135 (not the full 5h reset)', w1 === 60 && w2 === 90 && w3 === 135);
  am.noteAccountSuccess(0);
  am.markRateLimited(0, null); const w4 = Math.round((am.accounts[0].rateLimitedUntil - now) / 1000);
  ok('a success resets the per-account 429 streak back to the floor', w4 === 60); }

{ const am = mk({ perAccountBackoffCapSec: 600, recoveryStaggerSec: 0 });
  const now = Date.now();
  am.markRateLimited(0, 3600);                          // explicit 1h header → clamped to the cap
  const w = Math.round((am.accounts[0].rateLimitedUntil - now) / 1000);
  ok('an explicit long retry-after is clamped to the bounded cap (600s)', w === 600); }

// ── eviction: idle bindings are dropped ───────────────────────────────────────
{ const am = mk({ bindingEvictSec: 1 });
  am.getAccountForSession('S1');
  am.sessionBindings.get('S1').lastUsedAt = Date.now() - 2000; // idle 2s > 1s evict window
  am.getAccountForSession('S2');                                // any call triggers the sweep
  ok('idle session bindings are evicted', !am.sessionBindings.has('S1') && am.sessionBindings.has('S2')); }

// ── exhaustion is REAL: all accounts genuinely benched → null (honest 429) ────
{ const am = mk();
  const future = Date.now() + 100000;
  for (const a of am.accounts) { a.status = 'throttled'; a.rateLimitedUntil = future; }
  ok('all accounts genuinely benched → getAccountForSession returns null', am.getAccountForSession('S1') === null); }

// a bench that has expired must NOT count as exhausted — the account re-enters.
{ const am = mk();
  for (const a of am.accounts) { a.status = 'throttled'; a.rateLimitedUntil = Date.now() - 1000; }
  const a = am.getAccountForSession('S1');
  ok('an expired bench re-enters the pool (not falsely exhausted)', a != null); }

// ── dashboard: per-session usage attribution ─────────────────────────────────
{ const am = mk();
  const acct = am.getAccountForSession('S1');
  am.updateUsage(acct.index, 1000, 0, 'S1');   // message_start: 1 message, 1000 input
  am.updateUsage(acct.index, 0, 200, 'S1');    // message_delta: 200 output
  am.updateUsage(acct.index, 500, 0, 'S1');    // a 2nd message
  am.updateUsage(acct.index, 0, 100, 'S1');
  const row = am.sessionBindingSummary().find(b => b.sid === 'S1');
  ok('per-session usage: 2 messages, 1800 tokens, avg 900/msg',
     row.requests === 2 && row.tokens === 1800 && row.avgTokensPerMsg === 900);
  // account totals updated too (no double-count regression)
  ok('account usage still tracked alongside session usage',
     am.accounts[acct.index].usage.totalInputTokens === 1500 && am.accounts[acct.index].usage.totalOutputTokens === 300); }

// stats persist across a rebind (a session's work spans its account switches).
{ const am = mk();
  const acct = am.getAccountForSession('S1');
  am.updateUsage(acct.index, 800, 100, 'S1');  // 1 msg, 900 tokens on the first account
  am.markRateLimited(acct.index, 300);          // blocker → next call rebinds
  const re = am.getAccountForSession('S1');
  ok('rebind keeps the session on a different account', re.name !== acct.name);
  const row = am.sessionBindingSummary().find(b => b.sid === 'S1');
  ok('per-session stats persist across the rebind', row.requests === 1 && row.tokens === 900); }

// ── dashboard: aggregate across all sessions ─────────────────────────────────
{ const am = mk();
  const a1 = am.getAccountForSession('S1'); am.updateUsage(a1.index, 1000, 200, 'S1');
  const a2 = am.getAccountForSession('S2'); am.updateUsage(a2.index, 500, 300, 'S2');
  const agg = am.sessionAggregate();
  ok('aggregate sums sessions / messages / tokens across all bindings',
     agg.sessions === 2 && agg.requests === 2 && agg.tokens === 2000 && agg.avgTokensPerMsg === 1000); }

// ── durable ledger (D-1728 S6): survives eviction, groups by issue ───────────
{ const am = mk();
  am._sessionRow = () => ({ pinned_issue: 'D-100' });  // stub registry
  const acct = am.getAccountForSession('S1');
  am.updateUsage(acct.index, 1000, 200, 'S1');          // 1 msg, 1200 tok
  am.sessionBindings.delete('S1');                       // simulate idle-eviction
  const bi = am.ledgerByIssue();
  ok('ledger survives binding eviction (durable)',
     bi.length === 1 && bi[0].issue === 'D-100' && bi[0].messages === 1 && bi[0].tokens === 1200); }

{ const am = mk();
  am._sessionRow = sid => ({ pinned_issue: sid === 'S3' ? 'D-200' : 'D-100' });
  for (const s of ['S1', 'S2', 'S3']) { const a = am.getAccountForSession(s); am.updateUsage(a.index, 1000, 0, s); }
  const bi = am.ledgerByIssue();
  const d100 = bi.find(g => g.issue === 'D-100');
  ok('per-issue rollup sums sessions sharing an issue',
     bi.length === 2 && d100.sessions === 2 && d100.tokens === 2000); }

{ const am = mk();
  let issue = 'D-100';
  am._sessionRow = () => ({ pinned_issue: issue });
  const a = am.getAccountForSession('S1');
  am.updateUsage(a.index, 1000, 0, 'S1');               // on D-100
  issue = 'D-200';                                       // session re-pins mid-life
  am.updateUsage(a.index, 500, 0, 'S1');                 // on D-200
  const bi = am.ledgerByIssue();
  ok('re-pin splits per-session usage cleanly by issue',
     bi.length === 2 && bi.find(g => g.issue === 'D-100').tokens === 1000 && bi.find(g => g.issue === 'D-200').tokens === 500); }

{ const dir = mkdtempSync(join(tmpdir(), 'tc-ledger-'));
  const p = join(dir, 'usage-ledger.json');
  const am = mk(); am._sessionRow = () => ({ pinned_issue: 'D-100' }); am.setLedgerPath(p);
  const a = am.getAccountForSession('S1'); am.updateUsage(a.index, 1000, 200, 'S1');
  am.saveLedger();
  const am2 = mk(); am2.setLedgerPath(p); am2.loadLedger();   // restart simulation
  const bi = am2.ledgerByIssue();
  ok('ledger save/load round-trips across a restart',
     bi.length === 1 && bi[0].issue === 'D-100' && bi[0].tokens === 1200 && bi[0].messages === 1);
  rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

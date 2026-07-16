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
], 0.98, opts || {});
const H = 3600 * 1000, D = 24 * H;

// ── S1: warm-stick — a warm session reuses its bound account (no switch) ──────
{ const am = mk();
  const first = am.getAccountForSession('S1');
  const again = am.getAccountForSession('S1');
  ok('warm session reuses its bound account (no switch)', first.name === again.name && am.sessionBindings.size === 1); }

// warm-stick beats load balancing: a less-loaded account must NOT pull a warm session.
{ const am = mk();
  const bound = am.getAccountForSession('S1');               // binds least-loaded
  const other = am.accounts.find(a => a.index !== bound.index);
  other._inflight = 0; bound._inflight = 5;                   // make another account less loaded
  const again = am.getAccountForSession('S1');                // still warm → must stay put
  ok('load balancing does NOT cut a warm session mid-window', again.name === bound.name); }

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

// ── window lapsed → rebind allowed; lands on a usable account ─────────────────
{ const am = mk();
  const bound = am.getAccountForSession('S1');
  const b = am.sessionBindings.get('S1');
  b.lastUsedAt = Date.now() - am.cacheAffinityWindowMs - 5000; // idle past the cache window
  const other = am.accounts.find(a => a.index !== bound.index);
  bound._inflight = 5;                                          // bound now most loaded → least-loaded rebinds away
  other._inflight = 0;
  const rebind = am.getAccountForSession('S1');
  ok('window lapsed → rebinds off the most-loaded account to a less-loaded one', rebind.name !== bound.name); }

// ── S2: distribution spreads sessions across accounts (no reset bias) ─────────
{ const am = mk();
  for (let i = 0; i < 6; i++) am.getAccountForSession('S' + i); // equal urgency, boost 1
  const { counts } = am._activeSessionCounts();
  const max = Math.max(...counts), min = Math.min(...counts);
  ok('6 sessions spread evenly across 3 accounts (parallel capacity)', max - min <= 1 && counts.reduce((s, c) => s + c, 0) === 6); }

// The reactive bench contract (retry-after verbatim, header-less never benches) is
// covered in reactive-bench.test.mjs; this suite only exercises session routing.

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

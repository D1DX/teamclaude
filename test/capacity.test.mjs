import { AccountManager } from '../src/account-manager.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// D-2179: capacity snapshot for orchestrators — verdict / headroom / soonestReset
// + allHardCapped + restart persistence. No network — in-memory accounts.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = (opts = {}) => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, { backoffJitterSec: 0, softConcurrencyPerAccount: 3, ...opts });

// ── green: all live, ample headroom ───────────────────────────────────────────
{ const am = mk();
  const c = am.computeCapacity();
  ok('an all-idle pool is GREEN', c.verdict === 'green');
  ok('headroom = liveAccounts × perAccount − warm (3×3−0 = 9)', c.headroom === 9);
  ok('liveAccounts = 3 / total 3', c.liveAccounts === 3 && c.total === 3);
  ok('soonestResetSec = 0 when nothing is benched', c.soonestResetSec === 0); }

// ── yellow: one account benched ───────────────────────────────────────────────
{ const am = mk();
  am.markRateLimited(0, 300);
  const c = am.computeCapacity();
  ok('one benched account makes the pool YELLOW', c.verdict === 'yellow');
  ok('benched / live counts reflect the bench', c.benched === 1 && c.liveAccounts === 2);
  ok('soonestResetSec ≈ the benched bench (300s)', c.soonestResetSec >= 299 && c.soonestResetSec <= 301); }

// ── yellow: a deep streak (≥2) keeps the pool cautious even when not benched ───
{ const am = mk();
  // D-2286: build the streak SEQUENTIALLY (recover between 429s) — a concurrent burst
  // is now debounced to streak 1, so two back-to-back calls no longer reach streak 2.
  am.markRateLimited(0, null);
  am.accounts[0].status = 'active'; am.accounts[0].rateLimitedUntil = 0; // bench expired + re-probed
  am.markRateLimited(0, null);                                // sequential → streak 2
  am.accounts[0].status = 'active'; am.accounts[0].rateLimitedUntil = null; // bench cleared, streak kept
  const c = am.computeCapacity();
  ok('a deep 429 streak keeps the pool YELLOW (no bench)', c.verdict === 'yellow' && c.benched === 0); }

// ── red: every account benched → 0 live ───────────────────────────────────────
{ const am = mk();
  for (let i = 0; i < 3; i++) am.markRateLimited(i, 200);
  const c = am.computeCapacity();
  ok('an all-benched pool is RED with 0 live', c.verdict === 'red' && c.liveAccounts === 0);
  ok('RED carries soonestResetSec for scheduling (≈200s)', c.soonestResetSec >= 199 && c.soonestResetSec <= 201); }

// ── DL-3032 S5: near-cap (learned) flags CONSTRAINED but STAYS live ───────────
{ const am = mk({ capSoftCeiling: 0.75 });
  const a = am.accounts[0];
  a._capEst5h = 100000;
  am._recordBurn(a, 80000);                                   // 80k ≥ 0.75×100k = 75k → constrained
  const c = am.computeCapacity();
  const row = c.accounts.find(x => x.name === 'a0');
  ok('an account past its learned soft cap is flagged constrained', row.constrained === true);
  ok('nearCap alias still set for existing readers', row.nearCap === true);
  ok('DL-3032: a constrained account STILL counts live (serving, not excluded)',
     row.live === true && c.liveAccounts === 3);
  ok('DL-3032: a constrained account adds no fresh slot headroom (2 unconstrained × 3 = 6)',
     c.headroom === 6); }

// ── headroom shrinks as warm sessions fill slots ──────────────────────────────
{ const am = mk({ softConcurrencyPerAccount: 2 });
  for (let i = 0; i < 5; i++) am.getAccountForSession('S' + i);  // 5 warm across 3 live accounts
  const c = am.computeCapacity();
  ok('headroom = 3×2 − 5 warm = 1', c.headroom === 1);
  ok('low headroom (≤1) downgrades to YELLOW', c.verdict === 'yellow'); }

// ── allHardCapped (header path) ───────────────────────────────────────────────
{ const am = mk();
  ok('allHardCapped is false when accounts carry no header limits', am.allHardCapped() === false);
  for (const a of am.accounts) a.quota.unifiedStatus = 'rejected';
  ok('allHardCapped is true when every account is header-rejected', am.allHardCapped() === true); }

// ── persistence: per-account usage + capacity model survive a restart ─────────
{ const dir = mkdtempSync(join(tmpdir(), 'tc-cap-'));
  const p = join(dir, 'usage-ledger.json');
  const am = mk(); am.setLedgerPath(p);
  am.updateUsage(0, 50000, 10000, 'S1');                  // account usage + burn (60k)
  am._recordBurn(am.accounts[0], 140000);                 // push 5h burn to ~200k
  am.markRateLimited(0, null);                            // learn a 5h cap from the burn
  const cap = am.accounts[0]._capEst5h;
  const burn5h = am._burnWindow(am.accounts[0], 5);
  am.saveLedger();
  const am2 = mk(); am2.setLedgerPath(p); am2.loadLedger(); // restart simulation
  ok('per-account cumulative usage survives restart',
     am2.accounts[0].usage.totalInputTokens === 50000 && am2.accounts[0].usage.totalOutputTokens === 10000);
  ok('learned 5h cap survives restart', am2.accounts[0]._capEst5h === cap && cap === 200000);
  ok('burn buckets survive restart', am2._burnWindow(am2.accounts[0], 5) === burn5h && burn5h === 200000);
  ok('the 429 streak is NOT persisted (reset on restart)', am2.accounts[0]._429streak === 0);
  ok('the per-issue ledger still round-trips alongside', am2.ledgerByIssue().reduce((s, g) => s + g.tokens, 0) === 60000);
  rmSync(dir, { recursive: true, force: true }); }

// ── back-compat: a v1 ledger file (no accounts section) loads cleanly ─────────
{ const dir = mkdtempSync(join(tmpdir(), 'tc-cap-v1-'));
  const p = join(dir, 'usage-ledger.json');
  const am = mk(); am.setLedgerPath(p);
  am.updateUsage(0, 1000, 0, 'S1'); am.saveLedger();
  // rewrite as a v1 payload (strip the accounts section)
  const fs = await import('node:fs');
  const data = JSON.parse(fs.readFileSync(p, 'utf-8')); delete data.accounts; data.version = 1;
  fs.writeFileSync(p, JSON.stringify(data));
  const am2 = mk(); am2.setLedgerPath(p);
  let threw = false; try { am2.loadLedger(); } catch { threw = true; }
  ok('a v1 ledger (no accounts) loads without error', threw === false);
  ok('v1 per-issue ledger still restores', am2.ledgerByIssue().reduce((s, g) => s + g.tokens, 0) === 1000);
  rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

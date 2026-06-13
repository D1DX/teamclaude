import { AccountManager } from '../src/account-manager.js';

// D-2104 (real-data rebuild): pace-to-weekly-line selection on Anthropic's live
// unified-5h/7d-utilization headers. Control law:
//   #1 never-stall 5h rail (top priority)  #2 pace to weekly line
//   #3 end-of-cycle ramp before 7d-reset   #6 cache yields only when far over line
// No network — in-memory accounts; quota values set directly.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const DAY = 24 * 3600 * 1000;
const mk = () => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98);
// Set a Max-account quota snapshot on one account.
const q = (am, i, { u7d = null, u5h = null, resetInMs = 5 * DAY, status = 'allowed' } = {}) => {
  const acct = am.accounts[i];
  acct.quota.unified7d = u7d;
  acct.quota.unified5h = u5h;
  acct.quota.unified7dReset = Date.now() + resetInMs;
  acct.quota.unifiedStatus = status;
};
const bind = (am, sid, i) => {
  const now = Date.now();
  am.sessionBindings.set(sid, { index: i, lastUsedAt: now, boundAt: now, firstSeenAt: now, requests: 0, inputTokens: 0, outputTokens: 0 });
};

// ── #2 pace to weekly line: furthest BEHIND its line is picked ─────────────────
// reset in 5d → line ≈ 1 - 5/7 ≈ 0.286. All 5h-eligible, all far from reset (no ramp).
{ const am = mk();
  q(am, 0, { u7d: 0.30, u5h: 0.1 });   // gap ≈ -0.014 (ahead)
  q(am, 1, { u7d: 0.05, u5h: 0.1 });   // gap ≈ +0.236 (most behind)
  q(am, 2, { u7d: 0.20, u5h: 0.1 });   // gap ≈ +0.086
  ok('picks the account furthest behind its weekly line (a1)', am._pickAccountForBinding().name === 'a1'); }

// ── pace line math: mid-week → ~0.5 ────────────────────────────────────────────
{ const am = mk(); q(am, 0, { u7d: 0.0, u5h: 0.1, resetInMs: 3.5 * DAY });
  ok('paceLine ≈ 0.5 at half the week', Math.abs(am._paceLine(am.accounts[0]) - 0.5) < 0.02); }

// ── #1 never-stall 5h rail BEATS pace: most-behind but 5h-maxed is excluded ─────
{ const am = mk();
  q(am, 0, { u7d: 0.05, u5h: 0.95 });  // MOST behind, but 5h ≥ 0.90 → ineligible
  q(am, 1, { u7d: 0.20, u5h: 0.10 });  // behind + eligible
  q(am, 2, { u7d: 0.30, u5h: 0.10 });  // ahead + eligible
  const pick = am._pickAccountForBinding();
  ok('5h rail excludes the most-behind account (not a0)', pick.name !== 'a0');
  ok('picks the most-behind 5h-eligible account (a1)', pick.name === 'a1'); }

// ── 5h rail fallback: ALL ineligible (but <0.98) → still pick, don't stall ──────
{ const am = mk();
  q(am, 0, { u7d: 0.30, u5h: 0.95 });
  q(am, 1, { u7d: 0.05, u5h: 0.95 });  // most behind
  q(am, 2, { u7d: 0.20, u5h: 0.95 });
  const pick = am._pickAccountForBinding();
  ok('all-5h-ineligible → still returns an account (no null/stall)', !!pick);
  ok('fallback still ranks by pace (a1)', pick && pick.name === 'a1'); }

// ── #3 end-of-cycle ramp dominates: near-reset w/ unused quota beats a bigger raw gap
{ const am = mk();
  q(am, 0, { u7d: 0.0,  u5h: 0.1, resetInMs: 5 * DAY });  // gap +0.286, far from reset (no ramp)
  q(am, 1, { u7d: 0.80, u5h: 0.1, resetInMs: 6 * 3600000 }); // gap +0.164, but 6h→ramp ×100 on 0.20 unused = +20
  ok('ramp makes a near-reset account win despite a smaller raw gap (a1)', am._pickAccountForBinding().name === 'a1'); }

// ── ramp boost magnitude sanity ────────────────────────────────────────────────
{ const am = mk();
  q(am, 1, { u7d: 0.80, u5h: 0.1, resetInMs: 6 * 3600000 });
  ok('rampBoost ≈ unused × tierWeight (0.20 × 100 = 20)', Math.abs(am._rampBoost(am.accounts[1]) - 20) < 0.5);
  q(am, 2, { u7d: 0.50, u5h: 0.1, resetInMs: 5 * DAY }); // 120h > 72h → no tier
  ok('no ramp beyond 72h to reset', am._rampBoost(am.accounts[2]) === 0); }

// ── #6 cache yields ONLY when far over line: warm session far over → rebinds ────
{ const am = mk(); const sid = 's-far';
  q(am, 0, { u7d: 0.50, u5h: 0.1 });   // line 0.286, gap -0.214 < -0.10 → FAR over
  q(am, 1, { u7d: 0.05, u5h: 0.1 });   // behind + eligible (rebind target)
  q(am, 2, { u7d: 0.30, u5h: 0.1 });
  bind(am, sid, 0);
  const got = am.getAccountForSession(sid);
  ok('warm session FAR over its line rebinds off the account', got.name !== 'a0');
  ok('rebinds to the most-behind account (a1)', got.name === 'a1'); }

// ── #6 warm session only MILDLY over line stays put (cache wins) ───────────────
{ const am = mk(); const sid = 's-mild';
  q(am, 0, { u7d: 0.32, u5h: 0.1 });   // line 0.286, gap -0.034, within 0.10 → stay
  q(am, 1, { u7d: 0.05, u5h: 0.1 });
  bind(am, sid, 0);
  ok('warm session only mildly over its line stays put (cache-warm)', am.getAccountForSession(sid).name === 'a0'); }

// ── #1 warm session yields to the 5h rail (never-stall overrides cache) ─────────
{ const am = mk(); const sid = 's-5h';
  q(am, 0, { u7d: 0.20, u5h: 0.95 });  // on its line, but 5h-maxed → must rebind
  q(am, 1, { u7d: 0.05, u5h: 0.10 });  // eligible rebind target
  bind(am, sid, 0);
  ok('warm session on a 5h-maxed account rebinds (never-stall)', am.getAccountForSession(sid).name !== 'a0'); }

// ── no-data fallback: no headers yet → all paceScore 0 → least-in-flight spread ─
{ const am = mk();
  am.accounts[0]._inflight = 3; am.accounts[1]._inflight = 0; am.accounts[2]._inflight = 5;
  ok('no unified data → degrades to least-in-flight (a1)', am._pickAccountForBinding().name === 'a1'); }

// ── anti-dogpile: in-flight cap excludes an at-cap account from new binds ──────
{ const am = mk();
  q(am, 0, { u7d: 0.10, u5h: 0.1 });   // all similarly behind → same band
  q(am, 1, { u7d: 0.10, u5h: 0.1 });
  q(am, 2, { u7d: 0.10, u5h: 0.1 });
  am.accounts[1]._inflight = am.maxInflightPerAccount; // a1 at the cap
  ok('in-flight cap excludes the at-cap account (burst spills off a1)', am._pickAccountForBinding().name !== 'a1'); }

// ── anti-dogpile: within the pace tie-band, spread by warm-session load ────────
{ const am = mk();
  q(am, 0, { u7d: 0.10, u5h: 0.1 });   // all in the same band
  q(am, 1, { u7d: 0.10, u5h: 0.1 });
  q(am, 2, { u7d: 0.10, u5h: 0.1 });
  bind(am, 'w1', 0); bind(am, 'w2', 0); // a0 carries 2 warm sessions
  ok('tie-band spreads off the most-loaded account (not a0)', am._pickAccountForBinding().name !== 'a0'); }

// ── concentration preserved: a clearly-behind account wins despite load ────────
{ const am = mk();
  q(am, 0, { u7d: 0.0,  u5h: 0.1 });   // gap +0.286 — alone in the band
  q(am, 1, { u7d: 0.30, u5h: 0.1 });   // ahead, > tieBand below → out of band
  q(am, 2, { u7d: 0.30, u5h: 0.1 });
  bind(am, 'w1', 0); bind(am, 'w2', 0); // even with load, a0 is the only behind one
  ok('a clearly-behind account still concentrates (a0 wins despite load)', am._pickAccountForBinding().name === 'a0'); }

// ── graceful fallback: ALL at in-flight cap → still returns an account ─────────
{ const am = mk();
  q(am, 0, { u7d: 0.10, u5h: 0.1 });
  q(am, 1, { u7d: 0.10, u5h: 0.1 });
  q(am, 2, { u7d: 0.10, u5h: 0.1 });
  am.accounts.forEach(a => { a._inflight = am.maxInflightPerAccount; });
  ok('all at in-flight cap → still returns an account (no refuse)', !!am._pickAccountForBinding()); }

// ── probe-gate: an UNPROVEN account with a probe in-flight is skipped, even if most-behind ──
{ const am = mk();
  q(am, 0, { u7d: 0.0,  u5h: 0.1 });   // MOST behind, but unproven + already probing
  q(am, 1, { u7d: 0.20, u5h: 0.1 });
  q(am, 2, { u7d: 0.20, u5h: 0.1 });
  am.accounts[0]._proven = false; am.accounts[0]._inflight = 1; // one probe in flight, no 200 yet
  ok('probe-gate: unproven account mid-probe takes no further binds (spills off a0)', am._pickAccountForBinding().name !== 'a0'); }

// ── probe-gate: a PROVEN account opens past the unproven cap of 1 ──────────────
{ const am = mk();
  q(am, 0, { u7d: 0.0, u5h: 0.1 });    // most behind
  q(am, 1, { u7d: 0.30, u5h: 0.1 });
  am.accounts[0]._proven = true; am.accounts[0]._inflight = 2; // proven → cap is maxInflightPerAccount (3), 2 < 3
  ok('probe-gate: a proven account admits more than 1 in-flight (a0 still picked)', am._pickAccountForBinding().name === 'a0'); }

// ── 200 proves / 429 un-proves ────────────────────────────────────────────────
{ const am = mk();
  am.noteAccountSuccess(0); ok('a 200 marks the account proven', am.accounts[0]._proven === true);
  am.markRateLimited(0, 60); ok('a 429 un-proves the account (re-probe on recovery)', am.accounts[0]._proven === false); }

// ── hard session cap: an account at maxSessionsPerAccount is skipped, even if most-behind ──
{ const am = mk();
  q(am, 0, { u7d: 0.0, u5h: 0.1 });    // most behind
  q(am, 1, { u7d: 0.20, u5h: 0.1 });
  am.accounts[0]._proven = true;        // proven, so the probe-gate isn't what excludes it
  for (let i = 0; i < am.maxSessionsPerAccount; i++) bind(am, `cap${i}`, 0); // a0 at the session cap
  ok('session cap excludes a maxed account (spills off a0 despite most-behind)', am._pickAccountForBinding().name !== 'a0'); }

// ── graduated 5h cap: a proven account in the warn band tightens to 1 in-flight ──
{ const am = mk();
  q(am, 0, { u7d: 0.0,  u5h: 0.80 }); // most behind, proven, but 5h in [0.75,0.90) warn band
  q(am, 1, { u7d: 0.20, u5h: 0.10 });
  am.accounts[0]._proven = true; am.accounts[0]._inflight = 1; // warn-band cap is 1 → already full
  ok('5h warn band tightens a proven account to in-flight cap 1 (spills off a0)', am._pickAccountForBinding().name !== 'a0'); }

// ── ample 5h headroom keeps the full cap ───────────────────────────────────────
{ const am = mk();
  q(am, 0, { u7d: 0.0,  u5h: 0.50 }); // most behind, proven, ample 5h headroom (<0.75)
  q(am, 1, { u7d: 0.30, u5h: 0.10 });
  am.accounts[0]._proven = true; am.accounts[0]._inflight = 2; // cap is maxInflightPerAccount (3); 2 < 3
  ok('ample 5h headroom keeps full in-flight cap (a0 still picked at 2 in-flight)', am._pickAccountForBinding().name === 'a0'); }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// accounting/capacity.js — the capacity model: REPORTING ONLY, never an admission
// signal. computeCapacity derives a pool verdict (green/yellow/red) + headroom +
// soonestReset from live state + a success-taught per-account 5h cap, so an
// orchestrator gates launches on real headroom. The learned cap is taught on
// SUCCESSES (not 429s) and decays toward proven headroom, so a burst-driven low
// estimate can't freeze and falsely constrain the pool. Reads the shared pool
// records + burn buckets via mgr; writes only the reporting fields (_capEst5h,
// _maxSuccessBurn5h, _capEstAt) + _proven.
//   • covered by capacity.test.

// A successful response on an account — mark it proven (opens the in-flight cap) +
// recalibrate its learned cap (reporting only).
export function noteAccountSuccess(mgr, accountIndex) {
  const a = mgr.accounts[accountIndex];
  if (!a) return;
  a._proven = true;
  mgr._recalibrateCap(a);
}

// Recalibrate the learned 5h cap on a successful response so a burst-driven low
// estimate can't stay frozen and falsely flag the account constrained. Two moves:
//   (1) immediate RAISE — a success that burned past capEst×capSoftCeiling proves
//       the ceiling is higher than believed, so lift capEst to put this burn back
//       at the ceiling;
//   (2) time-DECAY toward the max observed successful 5h burn (proven headroom) with
//       a capDecayHalfLifeHours half-life, so a stale estimate relaxes toward reality.
// No-op until a cap has been learned (capEst null → constrained can't fire anyway).
export function recalibrateCap(mgr, account) {
  if (!account) return;
  const now = Date.now();
  const burn5h = mgr._burnWindow(account, 5);
  if (burn5h > 0) account._maxSuccessBurn5h = Math.max(account._maxSuccessBurn5h || 0, burn5h);
  if (account._capEst5h == null) { account._capEstAt = now; return; }
  // (1) immediate raise on a success above the soft ceiling
  if (burn5h > account._capEst5h * mgr.capSoftCeiling) {
    account._capEst5h = burn5h / mgr.capSoftCeiling;
  }
  // (2) decay toward proven headroom (max successful burn)
  const target = account._maxSuccessBurn5h || 0;
  const last = account._capEstAt || now;
  const dtHours = (now - last) / 3600000;
  if (dtHours > 0 && mgr.capDecayHalfLifeHours > 0 && target > 0) {
    const k = Math.pow(0.5, dtHours / mgr.capDecayHalfLifeHours);
    account._capEst5h = target + (account._capEst5h - target) * k;
  }
  account._capEstAt = now;
  mgr._ledgerDirty = true;
}

// Capacity snapshot for orchestrators (served by GET /capacity + `teamclaude
// capacity`). Header-blind by design — derives a verdict from live state + the
// learned per-account cap. An account is "live" when it is not benched, not
// errored/exhausted, and not base-axis hard-capped; the learned soft cap now only
// SHRINKS published headroom (constrained), it no longer removes an account from
// `live` (that produced false red/yellow while most of the pool was serving).
// headroom = spare concurrent-session slots across the unconstrained live pool.
export function computeCapacity(mgr) {
  mgr._sweepAll();
  const now = Date.now();
  const accounts = mgr.accounts.map(a => {
    const benched = a.status === 'throttled' && a.rateLimitedUntil != null && now < a.rateLimitedUntil;
    const benchSec = benched ? Math.ceil((a.rateLimitedUntil - now) / 1000) : 0;
    const burn5h = mgr._burnWindow(a, 5);
    const cap = a._capEst5h ?? null;
    const headroomTok = cap != null ? Math.max(0, Math.round(cap * mgr.capSoftCeiling - burn5h)) : null;
    const constrained = cap != null && burn5h >= cap * mgr.capSoftCeiling;
    const dead = a.status === 'error' || a.status === 'exhausted';
    return {
      name: a.name, status: a.status,
      benched, benchSec, inflight: a._inflight || 0,
      burn5h, capEst5h: cap, headroomTok,
      constrained, nearCap: constrained,   // nearCap retained as an alias for existing readers (status label)
      live: !benched && !dead && !mgr._atHardLimit(a),
    };
  });
  const live = accounts.filter(a => a.live);
  const benchedAll = accounts.filter(a => a.benched);
  const { active: warmSessions } = mgr._activeSessionCounts();
  // A constrained (near learned-cap) account is live but contributes no fresh
  // concurrency headroom — only UNCONSTRAINED live accounts add slots.
  const unconstrainedLive = live.filter(a => !a.constrained);
  const slotHeadroom = Math.max(0, unconstrainedLive.length * mgr.softConcurrencyPerAccount - warmSessions);
  const soonestResetSec = benchedAll.length ? Math.min(...benchedAll.map(a => a.benchSec)) : 0;

  let verdict;
  if (live.length === 0) verdict = 'red';
  else if (benchedAll.length > 0 || slotHeadroom <= 1) verdict = 'yellow';
  else verdict = 'green';

  return {
    verdict,
    headroom: slotHeadroom,   // est. more concurrent sessions the pool can absorb now
    liveAccounts: live.length,
    benched: benchedAll.length,
    total: mgr.accounts.length,
    warmSessions,
    soonestResetSec,          // when the next benched account frees (RED scheduling)
    accounts,
    at: new Date(now).toISOString(),
  };
}

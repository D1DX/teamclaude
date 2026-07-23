// core/selection.js — the pace-to-weekly-line picker: which account (re)serves a
// bind. Session cache-affinity lives in core/session.js; this module owns the
// choice among eligible accounts. Reads account quota + manager config off mgr;
// all usability/premium predicates route through mgr (core/bench.js) so this
// module imports no other core module.
//   • pace-to-line + tie-band load-spread + end-of-cycle ramp — covered by
//     pace-controller.test, selection.test.
//   • apikey = strict last resort (OAuth always preferred; yield-back on OAuth
//     recovery) — covered by selection.test, all-throttled-hold.test.

// Best available account (sticky while the current one is preferred). Returns null
// only if every account is hard-capped / throttled with no reset yet.
export function getActiveAccount(mgr, opts = {}) {
  mgr._sweepAll();
  const current = mgr.accounts[mgr.currentIndex];
  // Sticky while the current account is usable; otherwise (re)pick. First-ever
  // call always picks. A premium request never sticks on a premium-capped account.
  if (mgr._didBootSelect && current && mgr._isUsable(current)
      && !mgr._apikeyShouldYield(current)
      && !(mgr._premiumRequested(opts) && mgr._premiumRejected(current))) {
    return current; // stay cache-warm
  }
  mgr._didBootSelect = true;
  const chosen = mgr._pickAccountForBinding(opts);
  if (chosen) mgr._switchTo(chosen, `account "${chosen.name}" (pace: behind weekly line)`);
  return chosen;
}

// Expected weekly utilization right now: the fraction of the account's own 7d
// window elapsed. A null reset (not yet observed) → line 0, so the account reads
// as "behind" and gets traffic that then populates its headers (self-priming).
export function paceLine(mgr, account) {
  const reset = account.quota.unified7dReset;
  if (!reset) return 0;
  const weekMs = 7 * 24 * 3600 * 1000;
  const elapsed = 1 - (reset - Date.now()) / weekMs;
  return Math.max(0, Math.min(1, elapsed));
}

// How far BEHIND its weekly line the account is. >0 = behind (wants more load);
// <0 = ahead (over-pace). Unknown utilization → treated as 0 used (behind).
export function paceGap(mgr, account) {
  const used = account.quota.unified7d ?? 0;
  return mgr._paceLine(account) - used;
}

// End-of-cycle ramp: as the account nears its 7d reset, escalate preference to
// drain unused weekly quota before it resets. Boost = unusedWeeklyFraction ×
// tierWeight(hoursToReset); 0 outside all tiers. First tier (ascending hours)
// whose bound ≥ hoursToReset wins.
export function rampBoost(mgr, account) {
  const reset = account.quota.unified7dReset;
  if (!reset) return 0;
  const hoursToReset = (reset - Date.now()) / 3600000;
  if (hoursToReset < 0) return 0;
  let weight = 0;
  for (const tier of mgr.rampTiers) {            // ascending by hours
    if (hoursToReset <= tier.hours) { weight = tier.weight; break; }
  }
  if (!weight) return 0;
  const unused = Math.max(0, 1 - (account.quota.unified7d ?? 0));
  return unused * weight;
}

// Selection score: behind-line gap + end-of-cycle ramp. Highest wins.
export function paceScore(mgr, account) {
  return mgr._paceGap(account) + mgr._rampBoost(account);
}

// Pick the account to (re)bind a session to. Layered eligibility — each set falls
// back to the prior so we never refuse while any usable account exists (a truly
// exhausted pool yields null via _soonestUsableOrNull):
//   1. usable — not blocked, not base-axis `rejected` (hard cap);
//   2. premium filter — a premium request skips premium-capped accounts;
//   3. atomic in-flight cap — under maxInflightPerAccount (DL-2226);
//   4. session cap — under maxSessionsPerAccount bound warm sessions.
// Then a PACE TIE-BAND: accounts within paceTieBand of the best paceScore are
// "equally behind" → spread a concurrent burst across them by load (fewest warm
// sessions, then fewest in-flight) instead of dogpiling the single best.
export function pickAccountForBinding(mgr, { allowApikey = false, model = null, advisorModel = null } = {}) {
  const usableAll = mgr.accounts.filter(a => mgr._isUsable(a));
  if (usableAll.length === 0) return mgr._soonestUsableOrNull();
  // apikey accounts are a STRICT last resort: an apikey has no weekly line → flat-0
  // paceScore that would otherwise park PAID traffic while healthy Max headroom
  // idles. OAuth is always preferred; the apikey is admitted only when the hold
  // loop passes allowApikey (every OAuth account throttled — the D-2420 gate).
  const oauthUsable = usableAll.filter(a => a.type !== 'apikey');
  let usable;
  if (oauthUsable.length) usable = oauthUsable;        // OAuth available → use it
  else if (allowApikey) usable = usableAll;            // last resort → admit apikey
  else return null;                                    // only apikey usable, not yet allowed → HOLD
  // A premium-tier request must avoid premium-capped accounts (they serve non-premium
  // fine but would 429 this model). Premium = executor OR nested advisor model premium
  // (DL-2841). Fall back to the unfiltered set only if every candidate is premium-capped
  // (then it 429s honestly rather than never binding).
  const premiumReq = mgr._premiumRequested({ model, advisorModel });
  if (premiumReq) {
    const premiumOk = usable.filter(a => !mgr._premiumRejected(a));
    if (premiumOk.length) usable = premiumOk;
  } else if (mgr.reserveFableHeadroom) {
    // DL-3563 — the MIRROR of the premium filter: a NON-premium request AVOIDS accounts
    // that still hold Fable (7d_oi) headroom, so their scarce base-5h budget is not burned
    // by non-premium traffic and stays free to serve Fable. Fable-capable accounts often
    // sit on the fleet's LOWEST weekly line, so pace-to-line would otherwise pile ALL
    // traffic onto exactly them, cap their 5h, and leave the pool with zero Fable capacity.
    // Same empty-set fallback — every usable account reserved → non-premium still binds
    // (availability preserved). Pure eligibility ORDERING, never an admission signal.
    const nonReserved = usable.filter(a => !isFableReserved(mgr, a));
    if (nonReserved.length) usable = nonReserved;
  }
  const { counts } = mgr._activeSessionCounts();
  // Atomic in-flight cap (DL-2226): an account at maxInflightPerAccount takes no new
  // bind, so a burst spills across accounts in pace order. The only in-flight
  // admission gate — reactive-only dropped the graduated probe-gate.
  const underCap = usable.filter(a => (a._inflight || 0) < mgr.maxInflightPerAccount);
  const capped = underCap.length ? underCap : usable;
  // Hard session cap (instances limit) — a burst spills beyond maxSessionsPerAccount.
  const underSession = capped.filter(a => (counts[a.index] || 0) < mgr.maxSessionsPerAccount);
  const pool = underSession.length ? underSession : capped;
  const best = pool.reduce((m, a) => Math.max(m, mgr._paceScore(a)), -Infinity);
  const band = pool.filter(a => best - mgr._paceScore(a) <= mgr.paceTieBand);
  return band.reduce((b, a) => {
    const ca = counts[a.index] || 0, cb = counts[b.index] || 0;
    if (ca !== cb) return ca < cb ? a : b;
    return (a._inflight || 0) < (b._inflight || 0) ? a : b;
  }, band[0]);
}

// DL-3563 — is this account currently RESERVED for Fable? True when it still holds
// meaningful Fable (premium 7d_oi) headroom, so a NON-premium request should avoid it and
// leave its scarce base-5h budget free to serve Fable. Requires REAL premium data
// (premiumUtil non-null) AND not premium-capped AND headroom >= fableReserveHeadroomFloor.
// An account with no premium data (unknown Fable capability) is NEVER reserved — a
// conservative default that lets non-premium traffic use it. Config-gated
// (reserveFableHeadroom). Reporting data ORDERING eligibility; the caller keeps the
// empty-set fallback, so admission stays reactive-only.
export function isFableReserved(mgr, account) {
  if (!mgr.reserveFableHeadroom || !account) return false;
  if (mgr._premiumRejected(account)) return false;          // Fable already exhausted → not reserved
  const util = account.quota?.premiumUtil;
  if (util == null) return false;                           // no Fable data → don't reserve
  const headroom = Math.max(0, 1 - util);
  const floor = mgr.fableReserveHeadroomFloor > 0 ? mgr.fableReserveHeadroomFloor : 0.1;
  return headroom >= floor;
}

// True when `account` is the apikey last-resort AND at least one OAuth account is
// usable right now — so a session sitting on the paid apikey (from an OAuth-outage
// window) should yield back to Max. Gates the two sticky paths so apikey use never
// outlives OAuth recovery.
export function apikeyShouldYield(mgr, account) {
  if (!account || account.type !== 'apikey') return false;
  return mgr.accounts.some(a => a.type !== 'apikey' && mgr._isUsable(a));
}

// Is there a usable apikey account to fall back to as the genuine last resort? The
// server's all-throttled HOLD loop checks this before firing the paid key.
export function hasUsableApikey(mgr) {
  return mgr.accounts.some(a => a.type === 'apikey' && mgr._isUsable(a));
}

export function switchTo(mgr, account, reason) {
  if (account.index !== mgr.currentIndex) {
    console.log(`[TeamClaude] Switched to ${reason}`);
  }
  mgr.currentIndex = account.index;
  return account;
}

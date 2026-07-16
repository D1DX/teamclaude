// core/bench.js — reactive-only admission: the ONLY admission signal is Anthropic's
// explicit statement. A 429 with retry-after benches that one account for exactly
// the stated duration (honored verbatim); a header-less 429 fails over, never
// benches; a base-axis unified-status `rejected` (Q1 hard cap) excludes the account
// until its reset; a premium (7d_oi) 429 benches the premium axis only, never the
// account. No prediction, no streak, no utilization thresholds. Also owns the pool
// sweep + the usability predicates selection/capacity read. Cross-concern calls
// route through mgr; this module imports no other core module.
//   • covered by reactive-bench.test, per-family-reject.test, selection.test,
//     capacity.test.

// The premium/flagship weekly tier (`unified-7d_oi`) — config-driven regex on mgr.
// Non-premium models (Sonnet/Opus/Haiku) are never gated by a premium sub-limit.
export function isPremiumModel(mgr, model) {
  return !!model && mgr.premiumModelRe.test(model);
}

// Is this account currently premium-tier (7d_oi) capped? True only while the
// sub-limit is live; non-premium traffic ignores it (the account stays usable).
export function premiumRejected(mgr, account) {
  return !!account && account._premiumRejectedUntil > Date.now();
}

// Does this request need a premium (7d_oi) account? True when EITHER the executor
// model OR a nested advisor model (Claude Code's advisor tool, DL-2841) is premium.
// An advisor request keeps the executor in the top-level `model` and nests the
// advisor's model in tools[]; if the advisor model is premium (Fable) it must skip
// a premium-capped account even when the executor (Opus/Sonnet) is not — else the
// advisor sub-call lands on a capped account and Claude Code disables the advisor.
export function premiumRequested(mgr, { model = null, advisorModel = null } = {}) {
  return mgr._isPremiumModel(model) || mgr._isPremiumModel(advisorModel);
}

// Sweep ALL accounts (every request + every status read): clear an expired throttle
// (a freed account rejoins the pool immediately) and stale quota windows. In-memory,
// no network, no timer.
export function sweepAll(mgr) {
  for (const account of mgr.accounts) {
    mgr._isBlocked(account);       // side effect: flips an expired throttle back to active
    mgr._clearExpiredQuotas(account);
  }
}

export function clearExpiredQuotas(mgr, account) {
  const q = account.quota;
  const now = Date.now();
  if (q.unified5h != null && q.unified5hReset && now >= q.unified5hReset) {
    console.log(`[TeamClaude] Account "${account.name}" session quota reset`);
    q.unified5h = null;
    q.unified5hReset = null;
  }
  if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
    console.log(`[TeamClaude] Account "${account.name}" weekly quota reset`);
    q.unified7d = null;
    q.unified7dReset = null;
    q.unifiedStatus = null;
  }
  if (q.resetsAt && now >= new Date(q.resetsAt).getTime()) {
    q.tokensRemaining = null;
    q.tokensLimit = null;
    q.requestsRemaining = null;
    q.requestsLimit = null;
    q.resetsAt = null;
  }
}

// Throttled / errored / exhausted — unusable. A throttle whose window has passed
// flips the account back to active immediately (normal 429 failover).
export function isBlocked(mgr, account) {
  if (!account) return true;
  if (account.status === 'throttled' && account.rateLimitedUntil) {
    if (Date.now() < account.rateLimitedUntil) return true;
    account.status = 'active';
    account.rateLimitedUntil = null;
    console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
  }
  if (account.status === 'exhausted' || account.status === 'error') return true;
  return false;
}

// Q1 explicit-server-signal hard cap: the account's BASE (5h/7d) axis carries
// unified-status `rejected` — the server saying it is over. Excluded from selection
// until its reset clears the status (clearExpiredQuotas nulls it on the 7d reset).
// Reactive, not predictive: `allowed_warning` is NOT a trigger, and a utilization
// number never is.
export function atHardLimit(mgr, account) {
  return !!account && account.quota?.unifiedStatus === 'rejected';
}

// Usable — not blocked and not base-axis `rejected` (Q1 hard cap).
export function isUsable(mgr, account) {
  if (mgr._isBlocked(account)) return false;
  mgr._clearExpiredQuotas(account);
  return !mgr._atHardLimit(account);
}

// Tier-3 fallback (pure): the soonest-to-reset account, reactivated only if its
// reset has actually passed; else null (= genuinely exhausted → honest 429).
export function soonestUsableOrNull(mgr) {
  let soonest = null, soonestTime = Infinity;
  for (const a of mgr.accounts) {
    const t = a.rateLimitedUntil || a.quota.unified5hReset || a.quota.unified7dReset
      || (a.quota.resetsAt ? new Date(a.quota.resetsAt).getTime() : null);
    if (t && t < soonestTime) { soonestTime = t; soonest = a; }
  }
  if (soonest && soonestTime <= Date.now()) {
    soonest.status = 'active';
    soonest.rateLimitedUntil = null;
    return soonest;
  }
  return null;
}

// Mark an account rate-limited (429) — reactive-only. The server's explicit signal
// is the only one obeyed:
//   • a premium (7d_oi) 429 is scoped to the premium axis (updateQuota already set
//     _premiumRejectedUntil) — it must NOT bench the whole account, which stays
//     usable for non-premium models;
//   • a retry-after benches that one account for exactly the stated duration,
//     honored verbatim; a longer retry-after extends an existing bench, a shorter
//     one never shrinks it;
//   • a header-less (or non-positive) 429 does NOT bench — it just fails over.
export function markRateLimited(mgr, accountIndex, retryAfterSeconds) {
  const account = mgr.accounts[accountIndex];
  if (!account) return;
  // Premium-scoped 429 (premium axis rejected, base axes NOT rejected): bench the
  // premium axis only. Benching here would stall its Sonnet/Opus/Haiku traffic too.
  if (mgr._premiumRejected(account) && account.quota?.unifiedStatus !== 'rejected') {
    console.log(`[TeamClaude] Account "${account.name}" premium-tier (7d_oi) capped — NOT benching account; stays usable for non-premium models`);
    return;
  }
  // Obey an explicit server retry-after, verbatim. Bench that one account so
  // selection moves to the rest of the pool; a longer retry-after extends an
  // existing bench, a shorter one never shrinks it. Log when the server asks for
  // more than 15 min (a clamp would re-probe an account it told us to leave alone).
  if (retryAfterSeconds != null && !isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
    const until = Date.now() + retryAfterSeconds * 1000;
    if (!(account.status === 'throttled' && account.rateLimitedUntil >= until)) {
      account.status = 'throttled';
      account.rateLimitedUntil = until;
      account._lastBenchSec = Math.round(retryAfterSeconds);
      const overLong = retryAfterSeconds > 15 * 60 ? ' — over 15min, honored verbatim (Q2)' : '';
      console.log(`[TeamClaude] Account "${account.name}" rate limited +${account._lastBenchSec}s (server retry-after)${overLong}`);
    }
  }
}

// Q1 signal 2: true when EVERY account is server-`rejected` for this request's axis
// — the pool is hard-capped, so the hold loop stops holding (recovery is hours out)
// and fires the apikey last resort immediately (DL-2420). Base-axis rejection counts
// for any request; premium (7d_oi) rejection counts only for a premium request —
// executor OR advisor model premium (DL-2841), so an all-premium-capped pool fires
// the apikey for a Fable advisor request instead of holding on OAuth forever.
export function allHardCapped(mgr, model = null, advisorModel = null) {
  if (!mgr.accounts.length) return false;
  const premium = mgr._premiumRequested({ model, advisorModel });
  return mgr.accounts.every(a => mgr._atHardLimit(a) || (premium && mgr._premiumRejected(a)));
}

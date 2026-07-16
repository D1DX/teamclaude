// core/quota.js — the unified-header grammar: parse an upstream response's
// `anthropic-ratelimit-*` headers into per-axis account state. Populates the base
// 5h/7d axes, the premium 7d_oi sub-axis (separately from the account-wide status),
// and the standard API-key token/request limits. Drives reporting; admission reads
// only the explicit signals it writes (unifiedStatus rejected, _premiumRejectedUntil),
// never a utilization threshold. Writes account.quota + account._premiumRejectedUntil
// on the shared pool records.
//   • covered by per-family-reject.test, quota-reset-storm.test, capacity.test.

// A premium (7d_oi) reject with no server-stated reset — bench the premium axis for
// this long, then re-probe (the next premium response carries the real reset and
// supersedes it). Only fires when Anthropic sends a `rejected` premium status but no
// forward-dated reset (rare).
const PREMIUM_REJECT_FALLBACK_MS = 15 * 60 * 1000; // 15m

// Update an account's quota tracking from upstream response headers.
export function updateQuota(mgr, accountIndex, headers) {
  const account = mgr.accounts[accountIndex];
  if (!account) return;

  // Unified rate limits (Claude Max)
  const u5h = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
  const u7d = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
  if (!isNaN(u5h)) account.quota.unified5h = u5h;
  if (!isNaN(u7d)) account.quota.unified7d = u7d;

  // D-2236: never store a reset timestamp already in the past. At a window boundary
  // Anthropic can briefly report a <=now reset; storing it makes clearExpiredQuotas
  // re-log "session quota reset" on every sweep (which, via the TUI's console.log →
  // render → computeCapacity → sweepAll patch, recursed into a stack overflow). A
  // passed reset means the window has rolled: clear util + reset so the next response
  // repopulates a live (future-dated) window instead.
  const nowMs = Date.now();
  const r5h = headers['anthropic-ratelimit-unified-5h-reset'];
  const r7d = headers['anthropic-ratelimit-unified-7d-reset'];
  if (r5h) {
    const t = parseInt(r5h, 10) * 1000;
    if (t > nowMs) account.quota.unified5hReset = t;
    else { account.quota.unified5hReset = null; account.quota.unified5h = null; }
  }
  if (r7d) {
    const t = parseInt(r7d, 10) * 1000;
    if (t > nowMs) account.quota.unified7dReset = t;
    else { account.quota.unified7dReset = null; account.quota.unified7d = null; account.quota.unifiedStatus = null; }
  }

  // The premium-tier weekly sub-axis (`unified-7d_oi-*`). Anthropic emits it only on
  // premium-model requests; it goes `rejected`/util 1.0 when that tier's separate
  // weekly cap is hit, while the base 5h/7d axes stay `allowed`.
  const oiStatus = headers['anthropic-ratelimit-unified-7d_oi-status'];
  if (oiStatus) {
    account.quota.premiumStatus = oiStatus;
    const oiUtil = parseFloat(headers['anthropic-ratelimit-unified-7d_oi-utilization']);
    if (!isNaN(oiUtil)) account.quota.premiumUtil = oiUtil;
    const oiReset = headers['anthropic-ratelimit-unified-7d_oi-reset'];
    const oiResetMs = oiReset ? parseInt(oiReset, 10) * 1000 : null;
    if (oiStatus === 'rejected') {
      account.quota.premiumReset = oiResetMs && oiResetMs > nowMs ? oiResetMs : null;
      // Bench premium-only: usable for every non-premium model throughout. Fall back
      // to a bounded re-probe when Anthropic sends no forward-dated reset.
      account._premiumRejectedUntil = (oiResetMs && oiResetMs > nowMs)
        ? oiResetMs : nowMs + PREMIUM_REJECT_FALLBACK_MS;
    } else {
      account.quota.premiumReset = null;
      account._premiumRejectedUntil = 0; // recovered
    }
  }

  // The top-line `unified-status` is REQUEST-MODEL-scoped: on a premium request it
  // MIRRORS the 7d_oi sub-axis (rejected) even though the account's base budget is
  // fine. Storing that as the account-wide status benched the whole account for every
  // model (the DL-2841 stuck trap). Keep account-wide status on the BASE axes: derive
  // it from the explicit per-axis statuses when present; only fall back to the top-line
  // when no premium sub-axis is in play.
  const s5 = headers['anthropic-ratelimit-unified-5h-status'];
  const s7 = headers['anthropic-ratelimit-unified-7d-status'];
  const uStatus = headers['anthropic-ratelimit-unified-status'];
  if (s5 || s7) {
    account.quota.unifiedStatus = (s5 === 'rejected' || s7 === 'rejected')
      ? 'rejected'
      : (s7 || s5); // allowed | allowed_warning from the base axes
  } else if (uStatus && !oiStatus) {
    account.quota.unifiedStatus = uStatus; // no sub-axis → top-line is account-wide
  }
  // else: a premium request with no explicit base-axis headers — leave account-wide
  // status untouched rather than clobber it from the premium-mirrored top-line.

  // Standard rate limits (API key accounts)
  const tokensLimit = parseInt(headers['anthropic-ratelimit-tokens-limit'], 10);
  const tokensRemaining = parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10);
  const tokensReset = headers['anthropic-ratelimit-tokens-reset'];
  const requestsLimit = parseInt(headers['anthropic-ratelimit-requests-limit'], 10);
  const requestsRemaining = parseInt(headers['anthropic-ratelimit-requests-remaining'], 10);
  const requestsReset = headers['anthropic-ratelimit-requests-reset'];

  if (!isNaN(tokensLimit)) account.quota.tokensLimit = tokensLimit;
  if (!isNaN(tokensRemaining)) account.quota.tokensRemaining = tokensRemaining;
  if (!isNaN(requestsLimit)) account.quota.requestsLimit = requestsLimit;
  if (!isNaN(requestsRemaining)) account.quota.requestsRemaining = requestsRemaining;

  if (tokensReset) account.quota.resetsAt = tokensReset;
  else if (requestsReset) account.quota.resetsAt = requestsReset;

  account.usage.totalRequests++;
  account.usage.lastUsed = new Date().toISOString();

  // Log when an account is near the hard ceiling.
  const weeklyUtil = account.quota.unified7d;
  if (weeklyUtil != null && weeklyUtil >= mgr.switchThreshold - 0.05) {
    console.log(`[TeamClaude] Account "${account.name}" at ${(weeklyUtil * 100).toFixed(1)}% weekly — near ceiling`);
  }
}

// Apply a zero-spend /api/oauth/usage probe result (auth/prober.js, DL-3105).
// REPORTING ONLY — deliberately narrower than updateQuota: it writes utilization +
// reset onto the base 5h/7d axes (the pace line + capacity + Deck display read
// these) and the premium sub-axis utilization for display, but it NEVER touches an
// admission signal (unifiedStatus, premiumStatus, _premiumRejectedUntil) and NEVER
// counts a request. "reactive-only stands": admission flips only on a real 429.
// buckets are the normalized { utilization, resetAt } shape from oauth.fetchUsage.
export function applyProbeUsage(mgr, accountIndex, usage) {
  const account = mgr.accounts[accountIndex];
  if (!account || !usage) return;
  const nowMs = Date.now();
  // Store a bucket's util + reset, honoring the D-2236 guard: never store a reset
  // already in the past (clear the window so the next observation repopulates it).
  const apply = (bucket, utilKey, resetKey) => {
    if (!bucket) return;
    if (bucket.utilization != null) account.quota[utilKey] = bucket.utilization;
    if (bucket.resetAt != null) {
      if (bucket.resetAt > nowMs) account.quota[resetKey] = bucket.resetAt;
      else { account.quota[resetKey] = null; account.quota[utilKey] = null; }
    }
  };
  apply(usage.fiveHour, 'unified5h', 'unified5hReset');
  apply(usage.sevenDay, 'unified7d', 'unified7dReset');
  // Premium (7d_oi) sub-axis utilization for the Deck only — the probe never sets
  // the _premiumRejectedUntil admission bench (a real premium 429 does, updateQuota).
  apply(usage.sevenDayFable, 'premiumUtil', 'premiumReset');
}

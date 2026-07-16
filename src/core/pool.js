// core/pool.js — the account pool: the ONE mutable account-record array and its
// lifecycle (create / add / remove). The array is created here and held by
// reference on the manager as `mgr.accounts`; every other core module reads that
// same array and none copies it, so a mutation is visible pool-wide. addAccount /
// removeAccount mutate it in place and keep each record's `.index` equal to its
// array position (removeAccount also repairs mgr.currentIndex).
//   • record shape (quota axes, cumulative usage, reactive-bench fields, rolling
//     burn + learned-cap capacity fields, the probe `_proven` flag, the premium
//     7d_oi gate) is defined here so selection / bench / quota / accounting all
//     agree on it. Covered via the facade by selection.test, session-routing.test,
//     capacity.test, reactive-bench.test, per-family-reject.test.

// Per-account quota axes. unified5h/7d = Claude Max unified limits (utilization,
// reset, status on the BASE axes); premium* = the 7d_oi flagship sub-axis
// (DL-2841), tracked SEPARATELY from unifiedStatus so a premium-tier cap never
// benches the whole account; tokens*/requests* = standard API-key limits.
export function emptyQuota() {
  return {
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    // Unified rate limits (Claude Max accounts)
    unified5h: null,       // utilization 0-1
    unified7d: null,       // utilization 0-1
    unified5hReset: null,  // ms timestamp
    unified7dReset: null,  // ms timestamp
    unifiedStatus: null,   // allowed | allowed_warning | rejected (BASE 5h/7d axes only — NOT the premium sub-axis)
    // The premium/flagship weekly sub-limit (`unified-7d_oi-*`). Anthropic rejects
    // premium-model requests on this axis while the base 5h/7d budget is fine, so
    // it is tracked apart from unifiedStatus (which gates the whole account).
    premiumStatus: null,   // allowed | rejected — the 7d_oi sub-axis status
    premiumUtil: null,     // utilization 0-1 on the premium sub-axis
    premiumReset: null,    // ms timestamp — when the premium sub-limit resets
    resetsAt: null,
  };
}

// Build the mutable account records from raw config (the composition-root's
// account map). Full state shape incl. the capacity/burn fields + premium gate.
export function createAccounts(rawAccounts) {
  return rawAccounts.map((acct, index) => ({
    index,
    name: acct.name,
    type: acct.type,
    accountUuid: acct.accountUuid || null,
    credential: acct.accessToken || acct.apiKey,
    upstream: acct.upstream || null,   // D-2655: per-account upstream override (GLM/OpenRouter last-resort)
    model: acct.model || null,         // D-2655: rewrite body.model for this account
    provider: acct.provider || null,   // D-2655: OpenRouter provider routing (fp8 pin)
    refreshToken: acct.refreshToken || null,
    expiresAt: acct.expiresAt || null,
    status: 'active',
    quota: emptyQuota(),
    usage: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      lastUsed: null,
    },
    rateLimitedUntil: null,
    _inflight: 0,        // live concurrent upstream requests (spread tiebreak + display)
    _lastBenchSec: 0,    // last bench duration in seconds (display + capacity)
    _burn: null,         // Map(hourEpoch → tokens) — rolling burn buckets (≤168 = 7d)
    _capEst5h: null,     // success-taught 5h cap (reporting only; recalibrated on 200s)
    _maxSuccessBurn5h: null, // max observed SUCCESSFUL 5h burn — the recalibration target
    _capEstAt: 0,        // last capEst recalibration instant (ms) — drives time-decay
    _proven: false,      // probe-gate: returned a 200 in this active spell? unproven → in-flight cap 1
    _premiumRejectedUntil: 0, // premium-tier (7d_oi) capped until this instant; usable for non-premium models throughout
  }));
}

// Append one account at runtime; returns its index. Slim record shape — the
// capacity/premium fields are lazily initialized by their writers on first use.
export function addAccount(mgr, acctData) {
  const index = mgr.accounts.length;
  mgr.accounts.push({
    index,
    name: acctData.name,
    type: acctData.type,
    accountUuid: acctData.accountUuid || null,
    credential: acctData.accessToken || acctData.apiKey,
    upstream: acctData.upstream || null,   // D-2655
    model: acctData.model || null,         // D-2655
    provider: acctData.provider || null,   // D-2655
    refreshToken: acctData.refreshToken || null,
    expiresAt: acctData.expiresAt || null,
    status: 'active',
    quota: emptyQuota(),
    usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastUsed: null },
    rateLimitedUntil: null,
    _inflight: 0,
  });
  return index;
}

// Remove an account by index, reindex the survivors, and keep currentIndex valid.
export function removeAccount(mgr, index) {
  if (index < 0 || index >= mgr.accounts.length) return;
  mgr.accounts.splice(index, 1);
  mgr.accounts.forEach((a, i) => a.index = i);
  if (mgr.currentIndex >= mgr.accounts.length) {
    mgr.currentIndex = Math.max(0, mgr.accounts.length - 1);
  } else if (mgr.currentIndex > index) {
    mgr.currentIndex--;
  }
}

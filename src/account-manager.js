import { refreshAccessToken, isTokenExpiringSoon } from './oauth.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function emptyQuota() {
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
    unifiedStatus: null,   // allowed | allowed_warning | rejected
    resetsAt: null,
  };
}

export class AccountManager {
  // D1DX patch: weeklyReserve drives the time-decayed weekly cap.
  // switchThreshold (0.98) stays the HARD ceiling on the 5h axis + the real
  // weekly limit; weeklyReserve (0.20) is the SOFT preference floor on 7d.
  constructor(accounts, switchThreshold = 0.98, weeklyReserve = 0.20, rerankEvery = 10, rerankMargin = 1.3, opts = {}) {
    this.accounts = accounts.map((acct, index) => ({
      index,
      name: acct.name,
      type: acct.type,
      accountUuid: acct.accountUuid || null,
      credential: acct.accessToken || acct.apiKey,
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
    }));
    this.currentIndex = 0;
    this.switchThreshold = switchThreshold;
    this.weeklyReserve = weeklyReserve;
    // D1DX patch (§5.1): periodic re-rank. Every `rerankEvery` selections, move to a
    // preferred account whose weekly-urgency exceeds current × `rerankMargin`. Keeps the
    // sticky cache-locality win while preventing the selector from getting STUCK on a
    // healthy-but-low-urgency account (use-it-or-lose-it). Tunable via config.
    this.rerankEvery = rerankEvery;
    this.rerankMargin = rerankMargin;
    this._sinceRerank = 0;        // selections on `current` since the last re-rank check
    this._didBootSelect = false;  // Fix C: first selection picks the best account, not config index 0
    this.homeIndex = null; // account to prefer returning to after a 429 failover (cache locality)

    // ── D1DX patch (D-1705): all-throttled backoff + de-synchronized recovery ──
    // Tunables (defaults mirror config.js / index.js; config is never hand-edited).
    this.allThrottledFloorSec = opts.allThrottledFloorSec ?? 60;   // min wait told to the client
    this.allThrottledCapSec   = opts.allThrottledCapSec   ?? 600;  // max wait (client re-polls, self-correcting)
    this.retryJitterPct       = opts.retryJitterPct       ?? 0.15; // UPWARD-only jitter on the client retry-after
    this.recoveryStaggerSec   = opts.recoveryStaggerSec   ?? 5;    // per-account stagger added to rateLimitedUntil
    this.recoveryGapSec       = opts.recoveryGapSec       ?? 20;   // half-open: min gap between account releases
    this.escalationFactor     = opts.escalationFactor     ?? 1.5;  // floor *= factor^(streak-1) on repeat episodes
    // Episode state. An "episode" = a run of all-throttled returns not yet ended
    // by a success. Used for the escalating floor + the half-open release gate.
    this._allThrottledStreak = 0;   // consecutive all-throttled episodes since the last success
    this._lastAllThrottledAt = 0;   // ms — debounces concurrent 429s into one episode
    this._lastBackoffMs = 0;        // ms — last computed backoff, the episode-debounce window
    this._recoveryReleaseAt = 0;    // ms — half-open gate: next throttled account may release at/after this
  }

  // D1DX patch: actively sweep ALL accounts every request + on every status read,
  // not just `current`. Clears an expired throttle (so a freed account rejoins the
  // failover pool immediately) and stale quota windows. In-memory, no network, no
  // timer — keeps the whole pool fresh and the status display truthful.
  _sweepAll() {
    for (const account of this.accounts) {
      this._isBlocked(account);       // side effect: flips an expired throttle back to active
      this._clearExpiredQuotas(account);
    }
  }

  /**
   * Get the best available account (sticky while the current one is preferred).
   * Returns null only if every account is hard-capped / throttled with no reset yet.
   */
  getActiveAccount() {
    this._sweepAll();
    const current = this.accounts[this.currentIndex];

    // D1DX patch (Fix C — boot-select): the first-ever selection picks the best
    // account by weekly-urgency rather than defaulting to config index 0.
    if (!this._didBootSelect) {
      this._didBootSelect = true;
      return this._selectNext();
    }

    // D1DX patch (§5.1 — periodic re-rank): otherwise sticky (stay cache-warm on
    // `current`), but `_selectNext`'s urgency ranker only runs at a FORCED switch —
    // so without this it gets STUCK on a healthy-but-low-urgency account while a
    // more about-to-be-wasted account goes undrained. Every `rerankEvery` calls,
    // move to a preferred account whose weekly-urgency > current × `rerankMargin`.
    // The margin keeps it from cache-churning on small urgency differences.
    if (this._isPreferred(current)) {
      if (++this._sinceRerank >= this.rerankEvery) {
        this._sinceRerank = 0;
        const best = this._bestPreferred();
        if (best && best.index !== current.index &&
            this._weeklyUrgency(best) > this._weeklyUrgency(current) * this.rerankMargin) {
          return this._switchTo(best, `account "${best.name}" (periodic re-rank — higher weekly urgency)`);
        }
      }
      return current; // sticky — stay cache-warm
    }
    return this._selectNext();
  }

  // ── D1DX patch: two-tier weekly-reserve selection ──────────────
  // Tier 1 (preferred): weekly utilization below the time-decayed reserve cap.
  // Tier 2 (reserve):   no preferred account left — dip into the reserve band
  //                     (below the 0.98 hard ceiling) to KEEP WORKING.
  // Tier 3 (fallback):  everything hard-capped/throttled — soonest reset / null.
  // Grounding: accounts sit at 0.75–0.99 weekly almost always, so a
  // hard reserve floor would refuse service constantly. The cap is a SOFT
  // preference; switchThreshold (0.98) stays the hard ceiling.

  // Time-decayed weekly cap: hold the full reserve early in the week, release
  // toward 1.0 as the account's 7d reset approaches (use-it-or-lose-it).
  _effectiveWeeklyCap(account) {
    const reset = account.quota.unified7dReset;
    const tToReset = reset ? Math.max(0, reset - Date.now()) : WEEK_MS;
    const frac = Math.min(1, tToReset / WEEK_MS);
    return 1 - this.weeklyReserve * frac;
  }

  // Below-cap weekly headroom per ms to reset — high = lots of soon-to-be-wasted
  // weekly budget. Maximize to drain the most about-to-reset account first
  // (operator's "percent ÷ time-left, prefer the one resetting soonest").
  _weeklyUrgency(account) {
    const u7d = account.quota.unified7d ?? 0;
    const reset = account.quota.unified7dReset;
    const tToReset = reset ? Math.max(1, reset - Date.now()) : WEEK_MS;
    return Math.max(0, this._effectiveWeeklyCap(account) - u7d) / tToReset;
  }

  // Absolute weekly headroom to the hard ceiling (reserve-band tiebreak).
  _weeklyRemaining(account) {
    return 1 - (account.quota.unified7d ?? 0);
  }

  _clearExpiredQuotas(account) {
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

  // Throttled / errored / exhausted — unusable regardless of quota band.
  _isBlocked(account) {
    if (!account) return true;
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (Date.now() < account.rateLimitedUntil) return true;
      // D1DX patch (D-1705 S3): half-open recovery. During an all-throttled
      // episode, release at most ONE account per `recoveryGapSec` so the pool
      // re-enters one at a time (the first proves healthy before the next
      // rejoins) instead of the whole cluster flipping active in one sweep.
      // Outside an episode (`_allThrottledStreak === 0`) release is immediate,
      // exactly as before — normal 429-failover is unaffected.
      if (this._allThrottledStreak > 0 && Date.now() < this._recoveryReleaseAt) return true;
      account.status = 'active';
      account.rateLimitedUntil = null;
      if (this._allThrottledStreak > 0) this._recoveryReleaseAt = Date.now() + this.recoveryGapSec * 1000;
      console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
    }
    if (account.status === 'exhausted' || account.status === 'error') return true;
    return false;
  }

  // Real hard limits — using past these risks an actual 429. unified-status
  // `rejected` is the server telling us this account is over (allowed_warning
  // is NOT a trigger — ~24% of normal requests carry it).
  _atHardLimit(account) {
    const q = account.quota;
    if (q.unifiedStatus === 'rejected') return true;
    if (q.unified5h != null && q.unified5h >= this.switchThreshold) return true;
    if (q.unified7d != null && q.unified7d >= this.switchThreshold) return true;
    if (q.tokensLimit != null && q.tokensRemaining != null &&
        (1 - q.tokensRemaining / q.tokensLimit) >= this.switchThreshold) return true;
    if (q.requestsLimit != null && q.requestsRemaining != null &&
        (1 - q.requestsRemaining / q.requestsLimit) >= this.switchThreshold) return true;
    return false;
  }

  // Tier 1 — usable AND weekly utilization below the time-decayed reserve cap.
  _isPreferred(account) {
    if (this._isBlocked(account)) return false;
    this._clearExpiredQuotas(account);
    if (this._atHardLimit(account)) return false;
    const q = account.quota;
    if (q.unified7d != null && q.unified7d >= this._effectiveWeeklyCap(account)) return false;
    return true;
  }

  // Tier 2 — usable and below the hard ceiling (may be in the reserve band).
  _isUsable(account) {
    if (this._isBlocked(account)) return false;
    this._clearExpiredQuotas(account);
    return !this._atHardLimit(account);
  }

  // Back-compat shim: "near quota" === not in the preferred band (updateQuota's
  // approaching-quota log line still calls this).
  _isNearQuota(account) {
    return !this._isPreferred(account);
  }

  _switchTo(account, reason) {
    if (account.index !== this.currentIndex) {
      console.log(`[TeamClaude] Switched to ${reason}`);
    }
    this.currentIndex = account.index;
    this._sinceRerank = 0; // D1DX: reset the re-rank counter on every (re)selection
    return account;
  }

  // D1DX patch (§5.1): the highest weekly-urgency preferred account, or null if
  // none are preferred. Shared by _selectNext (forced switch) and the periodic
  // re-rank in getActiveAccount so the ranking logic lives in exactly one place.
  _bestPreferred() {
    let best = null;
    for (const a of this.accounts) {
      if (!this._isPreferred(a)) continue;
      if (best === null || this._weeklyUrgency(a) > this._weeklyUrgency(best)) best = a;
    }
    return best;
  }

  _selectNext() {
    // Tier 1 — preferred accounts (weekly utilization below the reserve cap).
    const best = this._bestPreferred();
    if (best) {
      // Return to a remembered home account if it's preferred again (cache-warm).
      if (this.homeIndex != null) {
        const home = this.accounts[this.homeIndex];
        if (home && this._isPreferred(home)) {
          this.homeIndex = null;
          return this._switchTo(home, `home account "${home.name}" (cleared, cache-warm)`);
        }
      }
      // Otherwise drain the most about-to-be-wasted weekly budget first.
      return this._switchTo(best, `account "${best.name}" (max weekly urgency)`);
    }

    // Tier 2 — reserve band: no preferred account, but keep work alive on the
    // account with the most weekly headroom below the hard ceiling.
    const usable = this.accounts.filter(a => this._isUsable(a));
    if (usable.length > 0) {
      const target = usable.reduce((best, a) =>
        this._weeklyRemaining(a) > this._weeklyRemaining(best) ? a : best);
      return this._switchTo(target, `account "${target.name}" (reserve band — keeping work alive)`);
    }

    // Tier 3 — everything hard-capped / throttled: take the soonest to reset.
    let soonestAccount = null;
    let soonestTime = Infinity;
    for (const account of this.accounts) {
      const resetTime = account.rateLimitedUntil
        || account.quota.unified5hReset
        || account.quota.unified7dReset
        || (account.quota.resetsAt ? new Date(account.quota.resetsAt).getTime() : null);
      if (resetTime && resetTime < soonestTime) {
        soonestTime = resetTime;
        soonestAccount = account;
      }
    }

    if (soonestAccount && soonestTime <= Date.now()) {
      soonestAccount.status = 'active';
      soonestAccount.rateLimitedUntil = null;
      this.currentIndex = soonestAccount.index;
      // D1DX patch (D-1705 S3): arm the half-open gate so a subsequent sweep
      // doesn't flip the rest of the pool active at once — one re-entry at a time.
      if (this._allThrottledStreak > 0) this._recoveryReleaseAt = Date.now() + this.recoveryGapSec * 1000;
      console.log(`[TeamClaude] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }

    return null;
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex, headers) {
    const account = this.accounts[accountIndex];
    if (!account) return;

    // Unified rate limits (Claude Max)
    const u5h = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
    const u7d = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
    if (!isNaN(u5h)) account.quota.unified5h = u5h;
    if (!isNaN(u7d)) account.quota.unified7d = u7d;

    const r5h = headers['anthropic-ratelimit-unified-5h-reset'];
    const r7d = headers['anthropic-ratelimit-unified-7d-reset'];
    if (r5h) account.quota.unified5hReset = parseInt(r5h, 10) * 1000;
    if (r7d) account.quota.unified7dReset = parseInt(r7d, 10) * 1000;

    const uStatus = headers['anthropic-ratelimit-unified-status'];
    if (uStatus) account.quota.unifiedStatus = uStatus;

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

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null
        ? (account.quota.unified7d * 100).toFixed(1)
        : account.quota.tokensLimit
          ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
          : '?';
      console.log(`[TeamClaude] Account "${account.name}" at ${pct}% usage — will switch on next request`);
    }
  }

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex, inputTokens, outputTokens) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
  }

  /**
   * Mark an account as rate-limited.
   *
   * `retryAfterSeconds` is the upstream `retry-after` header value, or null/NaN
   * when the 429 carried no header — in which case D1DX patch (D-1705 S1)
   * derives the window from this account's own known unified resets instead of
   * the old blind 60s. D1DX patch (D-1705 S2) then adds a small per-account
   * stagger + jitter so accounts throttled in the same burst don't all expire
   * at the same instant (de-synchronized recovery).
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    const now = Date.now();

    let windowMs;
    if (retryAfterSeconds != null && !isNaN(retryAfterSeconds)) {
      windowMs = retryAfterSeconds * 1000;
    } else {
      // No header — derive from this account's soonest genuine future reset.
      const resets = [
        account.quota.unified5hReset,
        account.quota.unified7dReset,
        account.quota.resetsAt ? new Date(account.quota.resetsAt).getTime() : null,
      ].filter(t => t && t > now);
      windowMs = resets.length ? Math.min(...resets) - now : this.allThrottledFloorSec * 1000;
    }

    // S2: per-account stagger (deterministic base by index) + jitter (tail), so
    // a burst of 429s doesn't cluster every account's window on the same instant.
    const staggerMs = account.index * this.recoveryStaggerSec * 1000
      + Math.random() * this.recoveryStaggerSec * 1000;

    account.status = 'throttled';
    account.rateLimitedUntil = now + windowMs + staggerMs;
    // D1DX patch: remember the displaced current account so selection
    // prefers returning to it (cache-warm) at the next switch once it clears.
    if (accountIndex === this.currentIndex) this.homeIndex = accountIndex;
    console.log(`[TeamClaude] Account "${account.name}" rate limited until +${Math.round((windowMs + staggerMs) / 1000)}s`);
  }

  /**
   * D1DX patch (D-1705 S1+S3): the retry-after (seconds) to hand the client when
   * EVERY account is throttled. Real-reset-aware (soonest genuine reset across
   * the pool), clamped to [escalated floor, cap], with UPWARD-ONLY jitter so we
   * never tell the client to retry *before* the real reset (which would just
   * earn another 429). Also advances the episode streak (escalating floor on
   * repeated back-to-back all-throttled states), debounced so concurrent 429s in
   * one episode count once. Replaces the old free `computeRetryAfter` helper,
   * which ignored the unified 5h/7d resets and used a blind 60s default.
   */
  allThrottledBackoff() {
    const now = Date.now();

    // Episode bookkeeping:
    //  - a long quiet gap (> cap) since the last all-throttled → fresh episode (streak = 1);
    //  - a return within the last backoff window → SAME episode (no double-count);
    //  - a return after the backoff window but within cap → next back-to-back episode (escalate).
    if (now - this._lastAllThrottledAt > this.allThrottledCapSec * 1000) {
      this._allThrottledStreak = 1;
    } else if (this._lastAllThrottledAt === 0 || now - this._lastAllThrottledAt > this._lastBackoffMs) {
      this._allThrottledStreak += 1;
    }
    this._lastAllThrottledAt = now;

    // Escalated floor, capped.
    const floorSec = Math.min(
      this.allThrottledCapSec,
      this.allThrottledFloorSec * Math.pow(this.escalationFactor, Math.max(0, this._allThrottledStreak - 1)),
    );

    // Soonest genuine reset across the whole pool (ms timestamps, internal form).
    let soonest = Infinity;
    for (const a of this.accounts) {
      const candidates = [
        a.rateLimitedUntil,
        a.quota.unified5hReset,
        a.quota.unified7dReset,
        a.quota.resetsAt ? new Date(a.quota.resetsAt).getTime() : null,
      ];
      for (const t of candidates) {
        if (t && t > now && t < soonest) soonest = t;
      }
    }

    let secs = soonest === Infinity ? floorSec : (soonest - now) / 1000;
    secs = Math.max(floorSec, Math.min(this.allThrottledCapSec, secs));
    secs += Math.random() * secs * this.retryJitterPct; // upward-only de-sync jitter
    this._lastBackoffMs = Math.ceil(secs) * 1000;
    return Math.max(1, Math.ceil(secs));
  }

  /**
   * D1DX patch (D-1705 S3): a successful (<400) upstream response ends the
   * all-throttled episode — open the half-open recovery gate (releases become
   * immediate again) and reset the escalation streak.
   */
  noteSuccess() {
    if (this._allThrottledStreak !== 0 || this._recoveryReleaseAt !== 0) {
      this._allThrottledStreak = 0;
      this._lastAllThrottledAt = 0;
      this._lastBackoffMs = 0;
      this._recoveryReleaseAt = 0;
    }
  }

  /**
   * Ensure an OAuth account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth' || !account.refreshToken) return;

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      console.log(`[TeamClaude] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await refreshAccessToken(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        console.log(`[TeamClaude] Token refreshed for account "${account.name}"`);
        this._onTokenRefresh?.(accountIndex, newTokens);
      } catch (err) {
        console.error(`[TeamClaude] Token refresh failed for "${account.name}": ${err.message}`);
        // Only mark as error if the access token is actually expired;
        // a failed proactive refresh shouldn't kill a still-valid token
        if (!account.expiresAt || Date.now() >= account.expiresAt) {
          account.status = 'error';
        }
      } finally {
        account._refreshPromise = null;
      }
    })();

    return account._refreshPromise;
  }

  /**
   * Set a callback to persist refreshed tokens to config.
   */
  onTokenRefresh(callback) {
    this._onTokenRefresh = callback;
  }

  /**
   * Update a specific account's OAuth tokens (e.g. after intercepting a token refresh).
   */
  updateAccountTokens(accountIndex, { accessToken, refreshToken, expiresAt }) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth') return;

    account.credential = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
    if (account.status === 'error') account.status = 'active';
    console.log(`[TeamClaude] Updated tokens for account "${account.name}"`);
    this._onTokenRefresh?.(accountIndex, {
      accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    });
  }

  /**
   * Add a new account at runtime.
   */
  addAccount(acctData) {
    const index = this.accounts.length;
    this.accounts.push({
      index,
      name: acctData.name,
      type: acctData.type,
      accountUuid: acctData.accountUuid || null,
      credential: acctData.accessToken || acctData.apiKey,
      refreshToken: acctData.refreshToken || null,
      expiresAt: acctData.expiresAt || null,
      status: 'active',
      quota: emptyQuota(),
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastUsed: null },
      rateLimitedUntil: null,
    });
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
    this.homeIndex = null; // indices shift on removal — drop any stale home pointer
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => a.index = i);
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1);
    } else if (this.currentIndex > index) {
      this.currentIndex--;
    }
  }

  /**
   * D1DX patch: warm all accounts at startup. Refreshes each OAuth
   * token, then fires one minimal request per account to anchor its 5h window
   * and populate the unified-ratelimit headers so selection isn't blind on
   * request #1. Startup-only — no timer, no background loop (operator constraint).
   * Best-effort: a failed warm logs and is skipped; it never blocks boot.
   */
  async warmAll(upstream = 'https://api.anthropic.com') {
    console.log(`[TeamClaude] Warming ${this.accounts.length} account(s) at startup...`);
    await Promise.all(this.accounts.map(async (account) => {
      try {
        await this.ensureTokenFresh(account.index);
        const isOAuth = account.type === 'oauth';
        const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
        if (isOAuth) {
          headers['authorization'] = `Bearer ${account.credential}`;
          headers['anthropic-beta'] = 'oauth-2025-04-20';
        } else {
          headers['x-api-key'] = account.credential;
        }
        const res = await fetch(`${upstream}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        const rl = {};
        for (const [k, v] of res.headers.entries()) {
          if (k.startsWith('anthropic-ratelimit-')) rl[k] = v;
        }
        this.updateQuota(account.index, rl);
        await res.body?.cancel?.();
        const w = account.quota.unified7d != null ? `${(account.quota.unified7d * 100).toFixed(0)}%` : '?';
        console.log(`[TeamClaude] Warmed "${account.name}" (HTTP ${res.status}, weekly ${w})`);
      } catch (err) {
        console.error(`[TeamClaude] Warm failed for "${account.name}": ${err.message}`);
      }
    }));
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    this._sweepAll(); // D1DX patch: truthful display — clear expired throttles/quotas before rendering
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      weeklyReserve: this.weeklyReserve,
      accounts: this.accounts.map(a => ({
        name: a.name,
        type: a.type,
        status: a.status,
        quota: { ...a.quota },
        usage: { ...a.usage },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
    };
  }
}

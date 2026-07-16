// core/session.js — session→account bindings: cache-affinity routing, warm-stick,
// idle eviction, and the per-session usage summaries the Deck reads. State lives
// on the manager (mgr.sessionBindings: Map<sid, binding>); these functions read
// and mutate it. Cross-concern calls (selection, bench, registry) route through
// mgr so this module imports nothing from other core modules.
//   • cache-affinity: a session sticks to one account (warm prompt cache) until a
//     blocker, the idle window, or being far past its weekly line — covered by
//     session-routing.test, pace-controller.test.
//   • summaries: sessionBindingSummary / sessionAggregate feed the live dashboard —
//     covered by fleet.test, tree.test, deck-snapshot.test.

// Pick the account to serve a request for a specific Claude Code session (the
// x-claude-code-session-id header). A warm binding stays put (cache locality); it
// rebinds ONLY on a blocker (bound account throttled / hard-capped → immediate),
// after the cache window lapses (idle ≥ window → free to rebalance), when the
// account is far past its weekly line, or when a premium request lands on a
// premium-capped account. Falls back to the global picker when there is no
// session id (warmer / health checks / non-Claude-Code clients). Returns null only
// when the pool is genuinely exhausted (server returns an honest 429).
export function getAccountForSession(mgr, sessionId, opts = {}) {
  mgr._sweepAll();
  mgr._evictStaleBindings();
  if (!sessionId) return mgr.getActiveAccount(opts);

  const now = Date.now();
  const b = mgr.sessionBindings.get(sessionId);
  if (b) {
    const acct = mgr.accounts[b.index];
    const warm = now - b.lastUsedAt < mgr.cacheAffinityWindowMs;
    // Stay put while warm AND safe AND not far past the weekly line. Rebind on a
    // blocker / hard-cap, or being far over the weekly line (cache yields ONLY then;
    // normal over-pace never churns a warm session).
    const farOverLine = acct ? mgr._paceGap(acct) < -mgr.farOverLineThreshold : false;
    // A premium-tier request on a premium-capped bound account must rebind, else
    // every premium request on it would 429. Non-premium requests keep the binding.
    const premiumMiss = mgr._isPremiumModel(opts.model) && mgr._premiumRejected(acct);
    if (acct && warm && !mgr._isBlocked(acct) && !mgr._atHardLimit(acct)
        && !farOverLine
        && !mgr._apikeyShouldYield(acct) && !premiumMiss) {
      b.lastUsedAt = now;
      return acct;
    }
  }

  // (Re)bind: no binding, window lapsed, or bound account blocked/capped.
  const chosen = mgr._pickAccountForBinding(opts);
  if (!chosen) return null; // genuinely exhausted — server returns an honest 429

  const prevIdx = b?.index;
  const stillWarm = b && now - b.lastUsedAt < mgr.cacheAffinityWindowMs;
  const reason = !b ? 'new session'
    : !stillWarm ? 'window lapsed'
    : 'blocker'; // was warm; bound acct blocked/capped
  // Preserve per-session stats across a rebind — a session's work spans its account
  // switches (firstSeenAt = the session's true start, not the latest bind).
  mgr.sessionBindings.set(sessionId, {
    index: chosen.index, lastUsedAt: now, boundAt: now,
    firstSeenAt: b?.firstSeenAt ?? now,
    requests: b?.requests ?? 0,
    inputTokens: b?.inputTokens ?? 0,
    outputTokens: b?.outputTokens ?? 0,
  });
  mgr.currentIndex = chosen.index; // keep TUI "active account" meaningful
  if (prevIdx !== chosen.index) {
    console.log(`[TeamClaude] Session ${mgr._sessionTag(sessionId)} → "${chosen.name}" (${reason})`);
  }
  return chosen;
}

// Per-account count of sessions whose binding is still warm (within the cache
// window) — drives the parallel-spread load cap. Returns { counts, active }.
export function activeSessionCounts(mgr) {
  const now = Date.now();
  const counts = new Array(mgr.accounts.length).fill(0);
  let active = 0;
  for (const b of mgr.sessionBindings.values()) {
    if (now - b.lastUsedAt < mgr.cacheAffinityWindowMs && b.index < counts.length) {
      counts[b.index]++;
      active++;
    }
  }
  return { counts, active };
}

export function evictStaleBindings(mgr) {
  const now = Date.now();
  for (const [sid, b] of mgr.sessionBindings) {
    if (now - b.lastUsedAt > mgr.bindingEvictMs) mgr.sessionBindings.delete(sid);
  }
}

// Snapshot of live session→account bindings + per-session usage for the dashboard.
// tokens = input + output; avgTokensPerMsg = tokens / messages; tokensPerMin =
// throughput over the session's elapsed time.
export function sessionBindingSummary(mgr) {
  const now = Date.now();
  const out = [];
  for (const [sid, b] of mgr.sessionBindings) {
    const acct = mgr.accounts[b.index];
    if (!acct) continue;
    const row = mgr._sessionRow(sid);
    const pin = row ? mgr._sessionPin(row.sid) : null; // local issue title/status overlay
    const tokens = (b.inputTokens || 0) + (b.outputTokens || 0);
    const reqs = b.requests || 0;
    const elapsedSec = Math.max(1, Math.round((now - (b.firstSeenAt ?? now)) / 1000));
    out.push({
      sid,
      sid8: String(sid).slice(0, 8),
      emoji: row?.emoji || null,
      issue: row?.pinned_issue || null,
      intent: row?.intent || null,                              // agent activity line
      fullSid: row?.sid || ('cc-' + sid),                       // registry sid (whole-fleet merge key)
      title: pin?.title || null,                                // local pin.json overlay
      status: pin?.status || null,                              // agent's last-claimed issue status
      needsYou: !!(pin && (pin.status === 'blocked' || pin.status === 'in_review' || pin.assigneeUserId)),
      pid: row?.pid ?? null, // Claude Code process pid for per-instance mem/cpu
      tag: mgr._sessionTag(sid),
      account: acct.name,
      warm: now - b.lastUsedAt < mgr.cacheAffinityWindowMs,
      idleSec: Math.round((now - b.lastUsedAt) / 1000),
      elapsedSec,
      requests: reqs,
      inputTokens: b.inputTokens || 0,
      outputTokens: b.outputTokens || 0,
      tokens,
      cost: b.cost || 0,            // API-equivalent $ for this session
      model: b.model || null,       // last-seen model (for the price tier)
      avgTokensPerMsg: reqs ? Math.round(tokens / reqs) : 0,
      tokensPerMin: Math.round(tokens / (elapsedSec / 60)),
    });
  }
  return out.sort((a, c) => a.account.localeCompare(c.account) || c.tokens - a.tokens);
}

// Aggregate across all live sessions for the dashboard TOTAL.
export function sessionAggregate(mgr) {
  const now = Date.now();
  let sessions = 0, warm = 0, requests = 0, inputTokens = 0, outputTokens = 0, cost = 0, earliest = now;
  for (const b of mgr.sessionBindings.values()) {
    sessions++;
    if (now - b.lastUsedAt < mgr.cacheAffinityWindowMs) warm++;
    requests += b.requests || 0;
    inputTokens += b.inputTokens || 0;
    outputTokens += b.outputTokens || 0;
    cost += b.cost || 0;
    if (b.firstSeenAt && b.firstSeenAt < earliest) earliest = b.firstSeenAt;
  }
  const tokens = inputTokens + outputTokens;
  const elapsedSec = Math.max(1, Math.round((now - earliest) / 1000));
  return {
    sessions, warm, requests, inputTokens, outputTokens, tokens, cost, elapsedSec,
    avgTokensPerMsg: requests ? Math.round(tokens / requests) : 0,
    tokensPerMin: Math.round(tokens / (elapsedSec / 60)),
  };
}

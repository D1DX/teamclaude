import { refreshAccessToken, isTokenExpiringSoon } from './oauth.js';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir, totalmem, freemem, loadavg, cpus, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// D1DX (D-1728): D1DX session presence registry — used only to resolve a
// session emoji for log/TUI display. Best-effort; never load-bearing for routing.
const SESSIONS_REGISTRY = join(homedir(), '.claude', 'state', 'sessions.json');

// macOS "Memory Used" (App + Wired + Compressed), matching Activity Monitor.
// os.freemem() can't be used here — it excludes reclaimable cache, overstating
// used memory by ~10GB. Parsed from `vm_stat` and cached for 2s so the dashboard
// snapshot (hit per /status request + TUI refresh) never hammers the shell-out.
// Returns bytes, or null if vm_stat is unavailable/unparseable (caller falls back).
let _macUsedCache = { at: 0, bytes: null };
function _macUsedBytes() {
  const now = Date.now();
  if (_macUsedCache.bytes != null && now - _macUsedCache.at < 2000) return _macUsedCache.bytes;
  try {
    const out = execFileSync('vm_stat', { encoding: 'utf-8', timeout: 1000 });
    const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1]) || 4096;
    const pages = label => {
      const m = out.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
      return m ? Number(m[1]) : 0;
    };
    const wired = pages('Pages wired down');
    const compressed = pages('Pages occupied by compressor');
    const appMem = Math.max(0, pages('Anonymous pages') - pages('Pages purgeable'));
    const bytes = (appMem + wired + compressed) * pageSize;
    _macUsedCache = { at: now, bytes };
    return bytes;
  } catch {
    return null;
  }
}

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

    // ── D1DX patch (D-1728): per-session cache-affinity routing ──
    // Anthropic prompt cache is 5-min TTL + per-account, so each Claude Code
    // session (keyed on the x-claude-code-session-id header) binds to ONE
    // account and stays cache-warm on it; it only switches on a blocker
    // (immediate) or after the cache window lapses (free rebalance). Non-urgent
    // weekly-urgency balancing never cuts a warm session mid-window.
    this.sessionBindings = new Map(); // sid -> { index, lastUsedAt, boundAt }
    this.cacheAffinityWindowMs = (opts.cacheAffinityWindowSec ?? 300) * 1000; // warm-stick window
    this.bindingEvictMs        = (opts.bindingEvictSec        ?? 1800) * 1000; // drop idle bindings
    this.bindingBoostBaseHours = opts.bindingBoostBaseHours    ?? 48;          // reset-proximity boost knee
    this.bindingMaxBoost       = opts.bindingMaxBoost          ?? this.accounts.length; // cap the boost
    // Per-account bounded backoff (D-1728): replaces the D-1705 "derive the full
    // 5h reset on a headerless 429" over-bench. A 429 benches the account for a
    // bounded escalating window (floor × factor^streak), not hours — so a
    // transient/rolling-window 429 re-probes in ~60s and "all exhausted" stays real.
    this.perAccountBackoffFloorSec = opts.perAccountBackoffFloorSec ?? 60;
    this.perAccountBackoffCapSec   = opts.perAccountBackoffCapSec   ?? 600;
    this.perAccountBackoffFactor   = opts.perAccountBackoffFactor   ?? 1.5;
    this._sessionTagCache = { at: 0, rows: null }; // cached sessions.json read for emoji tags

    // ── D1DX patch (D-1728 S6): durable per-issue usage ledger ──
    // Survives idle-eviction AND proxy restart (unlike the live sessionBindings).
    // Keyed by `sid::issue` so a session that re-pins to another issue splits
    // cleanly. The source of truth for the per-issue dashboard + the Paperclip
    // rollup (S7). Persisted to ~/teamclaude-logs/usage-ledger.json (debounced).
    this.usageLedger = new Map(); // "sid::issue" -> { sid, issue, account, messages, inputTokens, outputTokens, firstSeenAt, lastActiveAt }
    this.ledgerPath = null;       // set by setLedgerPath() at startup
    this.ledgerRetentionMs = (opts.ledgerRetentionHours ?? 168) * 60 * 60 * 1000; // 7d default
    this.ledgerSaveMs = (opts.ledgerSaveSec ?? 10) * 1000; // debounce window for disk writes
    this._ledgerDirty = false;
    this._ledgerLastSaveAt = 0;
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

  // ── D1DX patch (D-1728): per-session cache-affinity routing ─────
  /**
   * Pick the account to serve a request for a specific Claude Code session
   * (the x-claude-code-session-id header). A warm binding stays put (cache
   * locality); a switch happens ONLY on a blocker (bound account throttled /
   * hard-capped → immediate) or after the cache window lapses (idle ≥ window →
   * free to rebalance). Non-urgent weekly-urgency balancing never cuts a warm
   * session. Falls back to the global getActiveAccount() when there is no
   * session id (warmer / health checks / non-Claude-Code clients).
   * Returns null only when the pool is genuinely exhausted.
   */
  getAccountForSession(sessionId) {
    this._sweepAll();
    this._evictStaleBindings();
    if (!sessionId) return this.getActiveAccount();

    const now = Date.now();
    const b = this.sessionBindings.get(sessionId);
    if (b) {
      const acct = this.accounts[b.index];
      const warm = now - b.lastUsedAt < this.cacheAffinityWindowMs;
      // Warm + usable → stay put (the whole point: don't churn the cache).
      if (acct && warm && !this._isBlocked(acct) && !this._atHardLimit(acct)) {
        b.lastUsedAt = now;
        return acct;
      }
    }

    // (Re)bind: no binding, window lapsed, or the bound account is blocked/capped.
    const chosen = this._pickAccountForBinding();
    if (!chosen) return null; // genuinely exhausted — server returns an honest 429

    const prevIdx = b?.index;
    const reason = !b ? 'new session'
      : (now - b.lastUsedAt < this.cacheAffinityWindowMs) ? 'blocker'   // was warm; bound acct blocked/capped
      : 'window lapsed';
    // Preserve per-session stats across a rebind — a session's work spans its
    // account switches (firstSeenAt = the session's true start, not the latest bind).
    this.sessionBindings.set(sessionId, {
      index: chosen.index, lastUsedAt: now, boundAt: now,
      firstSeenAt: b?.firstSeenAt ?? now,
      requests: b?.requests ?? 0,
      inputTokens: b?.inputTokens ?? 0,
      outputTokens: b?.outputTokens ?? 0,
    });
    this.currentIndex = chosen.index; // keep TUI "active account" + homeIndex logic meaningful
    if (prevIdx !== chosen.index) {
      console.log(`[TeamClaude] Session ${this._sessionTag(sessionId)} → "${chosen.name}" (${reason})`);
    }
    return chosen;
  }

  // Per-account count of sessions whose binding is still warm (within the cache
  // window) — drives the parallel-spread load cap. Returns { counts, active }.
  _activeSessionCounts() {
    const now = Date.now();
    const counts = new Array(this.accounts.length).fill(0);
    let active = 0;
    for (const b of this.sessionBindings.values()) {
      if (now - b.lastUsedAt < this.cacheAffinityWindowMs && b.index < counts.length) {
        counts[b.index]++;
        active++;
      }
    }
    return { counts, active };
  }

  // Reset-proximity boost (operator D-1728): an account with weekly headroom and
  // an imminent 7d reset should absorb progressively more sessions (use-it-or-
  // lose-it). ~1 at ≥48h, ~2 at 24h, ~4 at 12h, ~8 at 6h, capped at bindingMaxBoost.
  _resetProximityBoost(account) {
    if (this._weeklyRemaining(account) <= 0) return 1;
    const reset = account.quota.unified7dReset;
    if (!reset) return 1;
    const tToResetH = Math.max(0.5, (reset - Date.now()) / HOUR_MS);
    const boost = Math.round(this.bindingBoostBaseHours / tToResetH);
    return Math.min(this.bindingMaxBoost, Math.max(1, boost));
  }

  /**
   * Pick the best account to (re)bind a session to (pure — no global-sticky side
   * effects). Spreads sessions across accounts for parallel throughput (load
   * cap = ceil((active+1)/usable)), drains the highest weekly-urgency account
   * first, and loosens the cap by the reset-proximity boost so soon-to-reset
   * budget is drained aggressively. The 5h hard ceiling (_isUsable) + 429
   * failover bound over-stacking. Returns null only when the pool is exhausted.
   */
  _pickAccountForBinding() {
    const usable = this.accounts.filter(a => this._isUsable(a));
    if (usable.length === 0) return this._soonestUsableOrNull();

    const { counts, active } = this._activeSessionCounts();
    const baseCap = Math.max(1, Math.ceil((active + 1) / usable.length));
    const ranked = usable.slice().sort((a, c) => this._weeklyUrgency(c) - this._weeklyUrgency(a));

    for (const a of ranked) {
      const cap = baseCap * this._resetProximityBoost(a);
      if (counts[a.index] < cap) return a;
    }
    // Every usable account is at its (boosted) cap — least-loaded among the
    // highest-urgency ranking still keeps work flowing.
    return ranked.reduce((best, a) => (counts[a.index] < counts[best.index] ? a : best), ranked[0]);
  }

  // Tier-3 fallback (pure): the soonest-to-reset account, reactivated only if its
  // reset has actually passed; else null (= genuinely exhausted → honest 429).
  _soonestUsableOrNull() {
    let soonest = null, soonestTime = Infinity;
    for (const a of this.accounts) {
      const t = a.rateLimitedUntil || a.quota.unified5hReset || a.quota.unified7dReset
        || (a.quota.resetsAt ? new Date(a.quota.resetsAt).getTime() : null);
      if (t && t < soonestTime) { soonestTime = t; soonest = a; }
    }
    if (soonest && soonestTime <= Date.now()) {
      soonest.status = 'active';
      soonest.rateLimitedUntil = null;
      if (this._allThrottledStreak > 0) this._recoveryReleaseAt = Date.now() + this.recoveryGapSec * 1000;
      return soonest;
    }
    return null;
  }

  _evictStaleBindings() {
    const now = Date.now();
    for (const [sid, b] of this.sessionBindings) {
      if (now - b.lastUsedAt > this.bindingEvictMs) this.sessionBindings.delete(sid);
    }
  }

  // Resolve a session's D1DX presence-registry row (or null). Best-effort,
  // cached ~5s. The x-claude-code-session-id header equals the registry SID
  // minus the `cc-` prefix.
  _sessionRow(sessionId) {
    const rows = this._readSessionsRegistry();
    if (!rows) return null;
    return rows.find(r => r && typeof r.sid === 'string'
      && (r.sid === 'cc-' + sessionId || r.sid.endsWith(sessionId))) || null;
  }

  _sessionEmoji(sessionId) {
    return this._sessionRow(sessionId)?.emoji || null;
  }

  // Short display tag (emoji + short sid) for log lines; falls back to the sid.
  _sessionTag(sessionId) {
    const short = String(sessionId).slice(0, 8);
    const emoji = this._sessionEmoji(sessionId);
    return emoji ? `${emoji} ${short}` : short;
  }

  _readSessionsRegistry() {
    const now = Date.now();
    if (now - this._sessionTagCache.at < 5000) return this._sessionTagCache.rows;
    let rows = null;
    try {
      rows = JSON.parse(readFileSync(SESSIONS_REGISTRY, 'utf-8'));
      if (!Array.isArray(rows)) rows = rows?.sessions ?? null;
    } catch { rows = null; }
    this._sessionTagCache = { at: now, rows };
    return rows;
  }

  // D-1739: read a session's local Paperclip pin overlay (title/status), written
  // by /task + `pc-current --set`. Credential-free — the proxy never calls
  // Paperclip. Best-effort, cached ~5s; missing/partial → null (never throws).
  // `status` is the agent's LAST-CLAIMED snapshot, not live server truth.
  _sessionPin(fullSid) {
    if (!fullSid) return null;
    this._pinCache ??= new Map();
    const now = Date.now();
    const c = this._pinCache.get(fullSid);
    if (c && now - c.at < 5000) return c.data;
    let data = null;
    try {
      const p = join(homedir(), '.claude', 'state', 'sessions', fullSid, 'pin.json');
      const j = JSON.parse(readFileSync(p, 'utf-8'));
      data = {
        title: j.title ?? null,
        status: j.status ?? null,
        assigneeUserId: j.assigneeUserId ?? null,
        lastCommentAt: j.lastCommentAt ?? null,
        // D-1820: identifier = the human D-N string from pin.json. pc-current --set
        // writes this field (see `pc_current --set` → jq projection in pc-current).
        // The registry row's `pinned_issue` is the canonical source, but it can be
        // null for sessions registered via pc_session_ensure/pc_session_claim_emoji
        // (self-heal / relaunch paths) that never completed a /task run. In that
        // case, pin.json's `identifier` is the only local source of the D-N. Used
        // as a fallback in fleetRows() when r.pinned_issue is blank.
        identifier: j.identifier ?? null,
        // D-1798: tree linkage. issueId = this session's own pinned-issue UUID
        // (the match key an umbrella is found by); parentId = its umbrella
        // issue's UUID (null for a top-level / non-child session).
        issueId: j.issueId ?? null,
        parentId: j.parentId ?? null,
      };
    } catch { data = null; }
    this._pinCache.set(fullSid, { at: now, data });
    return data;
  }

  // D-1739: every live presence-registry row enriched with its local pin
  // overlay — the whole-fleet spine for Deck (includes agents the proxy has
  // never routed). Best-effort + credential-free; empty array if unreadable.
  // D-1739: a process is alive if kill(pid,0) succeeds; EPERM also means alive
  // (someone else's process); only ESRCH (no such process) is dead. No pid →
  // treat as alive (can't disprove). Mirrors the bash registry's active filter.
  _pidAlive(pid) {
    if (pid == null || pid === '') return true;
    try { process.kill(Number(pid), 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
  }

  fleetRows() {
    const rows = (this._readSessionsRegistry() || []).filter(r => this._pidAlive(r.pid));
    return rows.map(r => {
      const pin = this._sessionPin(r.sid);
      return {
        sid: r.sid,
        emoji: r.emoji || null,
        pid: r.pid ?? null,
        intent: r.intent || null,
        // D-1820: registry `pinned_issue` is the canonical D-N source; fall back to
        // pin.json `identifier` for sessions that were registered via the self-heal /
        // relaunch path (pc_session_ensure → pc_sessions_register) without a
        // subsequent /task run that calls pc-current --set to update the registry row.
        issue: r.pinned_issue || pin?.identifier || null,
        started: r.started || null,
        lastHeartbeat: r.last_heartbeat || null,
        pin,
        // D-1798: tree linkage surfaced at the row top-level so the render path
        // can build the umbrella→children index without reaching into `pin`.
        issueId: pin?.issueId || null,   // this session's own pinned-issue UUID
        parentId: pin?.parentId || null, // its umbrella issue UUID (null = not a child)
        inflight: this._sessionInflight(r.sid), // D-1739: ⚙ a tool is executing right now (D-1749 marker)
      };
    });
  }

  // D-1739: is a tool currently executing in this session? Reads the D-1749
  // `tool-inflight` marker (written by pre-tool-inflight.sh, cleared by the
  // post hook). Fresh-guarded (≤120s) so a marker orphaned by a crashed session
  // doesn't show ⚙ forever. Best-effort, never throws.
  _sessionInflight(fullSid) {
    if (!fullSid) return false;
    try {
      const p = join(homedir(), '.claude', 'state', 'sessions', fullSid, 'tool-inflight');
      const raw = readFileSync(p, 'utf-8').trim();
      const epoch = parseInt(raw.split(/\s+/)[0], 10);
      if (!Number.isFinite(epoch)) return false;
      return (Date.now() / 1000 - epoch) < 120;
    } catch { return false; }
  }

  // D-1739: bare-sid → last-known account name, from the durable ledger (survives
  // restart + idle eviction). Lets the Deck cluster a registry agent UNDER the
  // account that last served it even with no current binding — so idle / just-
  // restarted agents still group by account instead of floating in a flat list.
  ledgerBySid() {
    const bySid = new Map();
    for (const e of this.usageLedger.values()) {
      if (!e.sid || !e.account) continue;
      const prev = bySid.get(e.sid);
      if (!prev || (e.lastActiveAt || 0) > prev.lastActiveAt) {
        bySid.set(e.sid, { account: e.account, lastActiveAt: e.lastActiveAt || 0 });
      }
    }
    return bySid; // Map<bareSid, { account, lastActiveAt }>
  }

  // Process + system resource snapshot for the dashboard (D-1728 S8). Cheap —
  // os + process, plus a single cached `vm_stat` on macOS for an accurate used
  // figure (see _macUsedBytes). Per-instance mem/cpu still resolved by the
  // caller from each session's pid.
  systemSnapshot() {
    const mu = process.memoryUsage();
    const total = totalmem();
    // os.freemem() on macOS counts reclaimable cache/inactive/compressor pages
    // as NOT free, so (total - free) overstates used by ~10GB (15.8/16 vs 6.7).
    // Derive the Activity-Monitor "Memory Used" figure via vm_stat instead;
    // fall back to freemem() on non-darwin (where freemem is meaningful enough).
    const macUsed = platform() === 'darwin' ? _macUsedBytes() : null;
    const used = macUsed != null ? macUsed : (total - freemem());
    return {
      proxyRssMB: Math.round(mu.rss / 1048576),
      proxyUptimeSec: Math.round(process.uptime()),
      totalMemMB: Math.round(total / 1048576),
      usedMemMB: Math.round(used / 1048576),
      usedMemPct: Math.round((used / total) * 100),
      loadAvg: loadavg().map(n => Math.round(n * 100) / 100),
      cpuCount: cpus().length,
    };
  }

  // Snapshot of live session→account bindings + per-session usage for the
  // dashboard (D-1728). tokens = input + output; avgTokensPerMsg = tokens /
  // messages; tokensPerMin = throughput over the session's elapsed time.
  sessionBindingSummary() {
    const now = Date.now();
    const out = [];
    for (const [sid, b] of this.sessionBindings) {
      const acct = this.accounts[b.index];
      if (!acct) continue;
      const row = this._sessionRow(sid);
      const pin = row ? this._sessionPin(row.sid) : null; // D-1739: local issue title/status overlay
      const tokens = (b.inputTokens || 0) + (b.outputTokens || 0);
      const reqs = b.requests || 0;
      const elapsedSec = Math.max(1, Math.round((now - (b.firstSeenAt ?? now)) / 1000));
      out.push({
        sid,
        sid8: String(sid).slice(0, 8),
        emoji: row?.emoji || null,
        issue: row?.pinned_issue || null,
        intent: row?.intent || null,                              // D-1739: agent activity line
        fullSid: row?.sid || ('cc-' + sid),                       // D-1739: registry sid (whole-fleet merge key)
        title: pin?.title || null,                                // D-1739: local pin.json overlay
        status: pin?.status || null,                              // D-1739: agent's last-claimed issue status
        needsYou: !!(pin && (pin.status === 'blocked' || pin.status === 'in_review' || pin.assigneeUserId)),
        pid: row?.pid ?? null, // D-1728 S8: Claude Code process pid for per-instance mem/cpu
        tag: this._sessionTag(sid),
        account: acct.name,
        warm: now - b.lastUsedAt < this.cacheAffinityWindowMs,
        idleSec: Math.round((now - b.lastUsedAt) / 1000),
        elapsedSec,
        requests: reqs,
        inputTokens: b.inputTokens || 0,
        outputTokens: b.outputTokens || 0,
        tokens,
        avgTokensPerMsg: reqs ? Math.round(tokens / reqs) : 0,
        tokensPerMin: Math.round(tokens / (elapsedSec / 60)),
      });
    }
    return out.sort((a, c) => a.account.localeCompare(c.account) || c.tokens - a.tokens);
  }

  // Aggregate across all live sessions for the dashboard TOTAL (D-1728).
  sessionAggregate() {
    const now = Date.now();
    let sessions = 0, warm = 0, requests = 0, inputTokens = 0, outputTokens = 0, earliest = now;
    for (const b of this.sessionBindings.values()) {
      sessions++;
      if (now - b.lastUsedAt < this.cacheAffinityWindowMs) warm++;
      requests += b.requests || 0;
      inputTokens += b.inputTokens || 0;
      outputTokens += b.outputTokens || 0;
      if (b.firstSeenAt && b.firstSeenAt < earliest) earliest = b.firstSeenAt;
    }
    const tokens = inputTokens + outputTokens;
    const elapsedSec = Math.max(1, Math.round((now - earliest) / 1000));
    return {
      sessions, warm, requests, inputTokens, outputTokens, tokens, elapsedSec,
      avgTokensPerMsg: requests ? Math.round(tokens / requests) : 0,
      tokensPerMin: Math.round(tokens / (elapsedSec / 60)),
    };
  }

  // ── D1DX patch (D-1728 S6): durable usage ledger ───────────────
  setLedgerPath(p) { this.ledgerPath = p || null; }

  // Load the ledger from disk at startup (best-effort) + prune stale entries.
  loadLedger() {
    if (!this.ledgerPath) return;
    try {
      const data = JSON.parse(readFileSync(this.ledgerPath, 'utf-8'));
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      for (const e of entries) {
        if (e && e.sid != null) this.usageLedger.set(`${e.sid}::${e.issue || ''}`, e);
      }
    } catch { /* missing/corrupt → start empty */ }
    this._pruneLedger();
  }

  // Atomic save (tmp + rename) so a crash mid-write can't corrupt the ledger.
  saveLedger() {
    if (!this.ledgerPath) return;
    try {
      const entries = [...this.usageLedger.values()];
      const tmp = this.ledgerPath + '.tmp';
      writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), entries }), { mode: 0o600 });
      renameSync(tmp, this.ledgerPath);
      this._ledgerDirty = false;
      this._ledgerLastSaveAt = Date.now();
    } catch { /* best-effort */ }
  }

  _pruneLedger() {
    if (!this.ledgerRetentionMs) return;
    const cutoff = Date.now() - this.ledgerRetentionMs;
    for (const [k, e] of this.usageLedger) {
      if ((e.lastActiveAt || 0) < cutoff) this.usageLedger.delete(k);
    }
  }

  // Attribute one message's usage to the durable ledger (keyed by sid::issue).
  _ledgerTouch(sessionId, accountName, inputTokens, outputTokens) {
    if (!sessionId) return;
    const issue = this._sessionRow(sessionId)?.pinned_issue || '';
    const key = `${sessionId}::${issue}`;
    let e = this.usageLedger.get(key);
    const now = Date.now();
    if (!e) {
      e = { sid: sessionId, issue, account: accountName, messages: 0, inputTokens: 0, outputTokens: 0, firstSeenAt: now, lastActiveAt: now };
      this.usageLedger.set(key, e);
    }
    e.account = accountName;
    if (inputTokens) { e.messages++; e.inputTokens += inputTokens; }
    if (outputTokens) e.outputTokens += outputTokens;
    e.lastActiveAt = now;
    this._ledgerDirty = true;
  }

  // Debounced disk write — called from the hot path; writes at most every ledgerSaveMs.
  _maybeSaveLedger() {
    if (!this.ledgerPath || !this._ledgerDirty) return;
    if (Date.now() - this._ledgerLastSaveAt < this.ledgerSaveMs) return;
    this.saveLedger();
  }

  // Per-issue rollup across ALL ledger entries (durable, all sessions). The
  // operator's "all usage on the issue across all sessions" view.
  ledgerByIssue() {
    const byIssue = new Map();
    for (const e of this.usageLedger.values()) {
      const k = e.issue || '(unassigned)';
      let g = byIssue.get(k);
      if (!g) { g = { issue: k, sessions: 0, messages: 0, inputTokens: 0, outputTokens: 0, lastActiveAt: 0 }; byIssue.set(k, g); }
      g.sessions++;
      g.messages += e.messages || 0;
      g.inputTokens += e.inputTokens || 0;
      g.outputTokens += e.outputTokens || 0;
      if ((e.lastActiveAt || 0) > g.lastActiveAt) g.lastActiveAt = e.lastActiveAt;
    }
    return [...byIssue.values()].map(g => {
      const tokens = g.inputTokens + g.outputTokens;
      return { ...g, tokens, avgTokensPerMsg: g.messages ? Math.round(tokens / g.messages) : 0 };
    }).sort((a, c) => c.tokens - a.tokens);
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
  updateUsage(accountIndex, inputTokens, outputTokens, sessionId = null) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
    // D-1728: per-session attribution for the live dashboard. message_start
    // carries input_tokens (one per message → counts a "message"); message_delta
    // carries output_tokens. Only attributes when the session still has a binding.
    if (sessionId) {
      const sb = this.sessionBindings.get(sessionId);
      if (sb) {
        if (inputTokens) { sb.requests++; sb.inputTokens += inputTokens; }
        if (outputTokens) sb.outputTokens += outputTokens;
      }
      // D-1728 S6: durable ledger (survives idle-eviction + restart).
      this._ledgerTouch(sessionId, account.name, inputTokens, outputTokens);
      this._maybeSaveLedger();
    }
  }

  /**
   * Mark an account as rate-limited.
   *
   * D1DX patch (D-1728): BOUNDED per-account backoff. A 429 benches this account
   * for `floor × factor^(streak-1)` seconds (consecutive same-account 429s
   * escalate), capped at `perAccountBackoffCapSec` — NOT the full unified 5h/7d
   * reset. Anthropic's 5h limit is a rolling window, so a transient/burst 429
   * recovers usable headroom long before the nominal reset; benching to the full
   * reset (the old D-1705 S1 behavior) starved the highest-weekly-urgency account
   * for hours and made the pool look "exhausted" when it wasn't. A genuinely
   * capped account is still excluded honestly by `_atHardLimit` (its 429 response
   * carries unified-5h ≈ 1.0 / status `rejected`), so the short re-probe doesn't
   * hammer it — it just keeps "all exhausted" REAL. An explicit upstream
   * `retry-after` is honored but clamped to the same cap for the same reason.
   * D-1705 S2 per-account stagger + jitter (de-synchronized recovery) is kept.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    const now = Date.now();

    // Per-account 429 streak: a fresh 429 after a long quiet gap (> cap) resets it.
    if (now - (account._rl429At || 0) > this.perAccountBackoffCapSec * 1000) {
      account._rl429Streak = 0;
    }
    account._rl429Streak = (account._rl429Streak || 0) + 1;
    account._rl429At = now;

    const capMs = this.perAccountBackoffCapSec * 1000;
    let windowMs;
    if (retryAfterSeconds != null && !isNaN(retryAfterSeconds)) {
      // Honor an explicit header, but never bench beyond the bounded cap.
      windowMs = Math.min(retryAfterSeconds * 1000, capMs);
    } else {
      // No header — bounded escalating backoff (floor × factor^(streak-1)).
      const sec = Math.min(
        this.perAccountBackoffCapSec,
        this.perAccountBackoffFloorSec * Math.pow(this.perAccountBackoffFactor, account._rl429Streak - 1),
      );
      windowMs = sec * 1000;
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
    console.log(`[TeamClaude] Account "${account.name}" rate limited until +${Math.round((windowMs + staggerMs) / 1000)}s (429 streak ${account._rl429Streak})`);
  }

  /**
   * D1DX patch (D-1728): a successful (<400) response on an account clears its
   * per-account 429 backoff streak, so the next isolated 429 starts again at the
   * floor instead of an inflated escalated window.
   */
  noteAccountSuccess(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (account._rl429Streak) account._rl429Streak = 0;
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
   * request #1.
   *
   * D1DX (D-1763): the first pass is awaited (boot timing unchanged — still
   * bounded by index.js's 15s deadline). Any account that fails on a NETWORK
   * error (the proxy booted before Wi-Fi/VPN was up — `fetch failed`,
   * ECONNREFUSED, ENOTFOUND, ETIMEDOUT) is retried by a BOUNDED, TERMINATING
   * background pass (`_rewarmFailed`) that self-heals within ~75s and then
   * stops. This is NOT a perpetual re-warm timer — it fires only after a failed
   * boot-warm and exits once every account is anchored or its attempts are spent.
   * An account that REACHED the API (any HTTP status, incl. 429) is considered
   * anchored and is never retried.
   * Best-effort throughout: nothing here ever blocks boot.
   */
  async warmAll(upstream = 'https://api.anthropic.com') {
    console.log(`[TeamClaude] Warming ${this.accounts.length} account(s) at startup...`);
    const failed = [];
    await Promise.all(this.accounts.map(async (account) => {
      try {
        await this.warmOne(account, upstream);
      } catch (err) {
        console.error(`[TeamClaude] Warm failed for "${account.name}": ${err.message}`);
        failed.push(account.index);
      }
    }));
    // D-1763: self-heal a cold-network boot. Detached (not awaited) so it outlives
    // the index.js 15s boot deadline; bounded + terminating so it isn't a timer.
    if (failed.length > 0) {
      this._rewarmFailed(failed, upstream).catch(() => {});
    }
  }

  /**
   * Single warm attempt for one account. Refreshes the token, fires the minimal
   * request, folds the rate-limit headers into quota. Resolves once the API was
   * REACHED (returns the HTTP status — any status anchors the window); throws on
   * a network/token error so the caller can decide whether to retry. (D-1763)
   */
  async warmOne(account, upstream = 'https://api.anthropic.com') {
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
    return res.status;
  }

  /**
   * D-1763: bounded background re-warm for accounts whose boot-warm failed on a
   * network error. Per account, retry on a fixed backoff schedule until the API
   * is reached or attempts are exhausted, then STOP. Terminating by construction
   * — no timer, no perpetual loop. Each account is retried independently so a
   * single still-dead account doesn't hold up the others.
   */
  async _rewarmFailed(indices, upstream, backoffsSec = [5, 10, 20, 40]) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    console.log(`[TeamClaude] Scheduling background re-warm for ${indices.length} account(s) that failed at boot (network not ready).`);
    await Promise.all(indices.map(async (index) => {
      const account = this.accounts[index];
      if (!account) return;
      for (let attempt = 0; attempt < backoffsSec.length; attempt++) {
        await sleep(backoffsSec[attempt] * 1000);
        try {
          await this.warmOne(account, upstream);
          console.log(`[TeamClaude] Late-warmed "${account.name}" on retry ${attempt + 1}/${backoffsSec.length}.`);
          return; // reached the API — anchored, done
        } catch (err) {
          if (attempt === backoffsSec.length - 1) {
            console.error(`[TeamClaude] Re-warm gave up for "${account.name}" after ${backoffsSec.length} retries: ${err.message}`);
          }
        }
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
      system: this.systemSnapshot(),                 // D1DX (D-1728 S8): proxy + host resources
      sessionBindings: this.sessionBindingSummary(), // D1DX (D-1728): live session→account map
      sessionAggregate: this.sessionAggregate(),     // D1DX (D-1728): live dashboard TOTAL
      usageByIssue: this.ledgerByIssue(),            // D1DX (D-1728 S6): durable per-issue rollup
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

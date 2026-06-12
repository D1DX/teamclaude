import { refreshAccessToken, isTokenExpiringSoon } from './oauth.js';
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { homedir, totalmem, freemem, loadavg, cpus, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// D1DX (D-2169): per-model API pricing, $/Mtok [input, output]. The Messages API
// returns no cost field — we compute the API-equivalent cost from token usage +
// the response's `model`. Cache multipliers (of the INPUT rate): write-5m 1.25×,
// write-1h 2×, read 0.1×. Family parsed from the model string; unknown → opus
// (Claude Code is predominantly Opus). Override per-family via opts.pricing.
const PRICING = {
  fable:  [10, 50],   // claude-fable-5 / mythos-5 (new top tier)
  mythos: [10, 50],
  opus:   [5, 25],    // opus 4.x
  sonnet: [3, 15],    // sonnet 4.x
  haiku:  [1, 5],     // haiku 4.5
};
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;
const CACHE_READ_MULT = 0.1;
// D1DX (D-1728): D1DX session presence registry — used only to resolve a
// session emoji for log/TUI display. Best-effort; never load-bearing for routing.
const SESSIONS_REGISTRY = join(homedir(), '.claude', 'state', 'sessions.json');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SESSION_ZOMBIE_MS = 12 * 60 * 60 * 1000; // 12h — matches lib-sessions PC_ZOMBIE_THRESHOLD_S (D-2085)

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
  // D1DX — simplified routing (D-2165). ONE selection rule: pace-to-line. Each
  // account aims for an expected-utilization line = fraction of its OWN 7d window
  // elapsed; new work goes to the account furthest BEHIND its line. switchThreshold
  // (0.98) is the hard ceiling that is never crossed (the real-429 guard).
  constructor(accounts, switchThreshold = 0.98, opts = {}) {
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
      _inflight: 0, // live concurrent upstream requests (spread tiebreak + display)
    }));
    this.currentIndex = 0;
    this.switchThreshold = switchThreshold; // hard ceiling — 5h axis + real weekly limit
    this._didBootSelect = false;            // first selection picks best, not config index 0

    // ── Selection: pace-to-line ──
    // expiringAccounts (subscriptions ending) drain to their line FIRST. An account
    // more than paceOvershootGuard AHEAD of its line takes no new bindings — and a
    // warm session bound to it is released at its next message (lazy eviction).
    this.expiringAccounts   = opts.expiringAccounts   ?? [];
    this.paceOvershootGuard = opts.paceOvershootGuard ?? 0.05;

    // ── Cache-affinity ──
    // A session sticks to one account (per-account prompt cache) until a blocker,
    // the idle window lapses, or the account runs past its pace line.
    this.sessionBindings = new Map(); // sid -> { index, lastUsedAt, boundAt, ... }
    this.cacheAffinityWindowMs = (opts.cacheAffinityWindowSec ?? 300) * 1000; // warm-stick window
    this.bindingEvictMs        = (opts.bindingEvictSec        ?? 1800) * 1000; // drop idle bindings

    // ── 429 handling: one bounded backoff ──
    // A throttled account is benched for backoffSec (+ small de-sync jitter), then
    // re-probed; a genuinely capped account is still excluded honestly by
    // _atHardLimit. allThrottledCapSec bounds the client retry-after when EVERY
    // account is throttled (the server hold-loop re-polls within that window).
    this.backoffSec         = opts.backoffSec         ?? 60;
    this.allThrottledCapSec = opts.allThrottledCapSec ?? 600;

    this._sessionTagCache = { at: 0, rows: null }; // cached sessions.json read for emoji tags

    // ── Durable per-issue usage ledger (observability — unchanged) ──
    // Survives idle-eviction AND proxy restart. Keyed by `sid::issue`. Source of
    // truth for the per-issue dashboard. Persisted to usage-ledger.json (debounced).
    this.usageLedger = new Map();
    this.ledgerPath = null;
    this.ledgerRetentionMs = (opts.ledgerRetentionHours ?? 168) * 60 * 60 * 1000;
    this.ledgerSaveMs = (opts.ledgerSaveSec ?? 10) * 1000;
    this._ledgerDirty = false;
    this._ledgerLastSaveAt = 0;

    // D1DX (D-2169): per-model price overrides (family → [in$, out$] per Mtok).
    // Falls back to the PRICING table above per family.
    this.pricing = opts.pricing ?? null;
  }

  // D1DX (D-2169): resolve $/Mtok [input, output] for a model string. Family
  // parsed from the string; unknown → opus (CC is mostly Opus).
  _priceFor(model) {
    const m = String(model || '').toLowerCase();
    let key = 'opus';
    if (m.includes('fable')) key = 'fable';
    else if (m.includes('mythos')) key = 'mythos';
    else if (m.includes('opus')) key = 'opus';
    else if (m.includes('sonnet')) key = 'sonnet';
    else if (m.includes('haiku')) key = 'haiku';
    const [inp, out] = (this.pricing && this.pricing[key]) || PRICING[key];
    return { in: inp, out };
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
    // Sticky while the current account is usable AND still on (or behind) its pace
    // line; otherwise (re)pick by the one rule. First-ever call always picks.
    if (this._didBootSelect && current && this._isUsable(current)
        && this._paceGap(current) >= -this.paceOvershootGuard) {
      return current; // stay cache-warm
    }
    this._didBootSelect = true;
    const chosen = this._pickAccountForBinding();
    if (chosen) this._switchTo(chosen, `account "${chosen.name}" (pace-to-line)`);
    return chosen;
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
      const onPace = acct && this._paceGap(acct) >= -this.paceOvershootGuard;
      // Warm + usable + still on (or behind) its pace line → stay put (don't churn
      // the cache). If the bound account has run PAST its line, fall through and
      // rebind (lazy over-pace eviction — the next pick rebalances to a more-behind
      // account). A blocked / hard-capped account also falls through (immediate).
      if (acct && warm && onPace && !this._isBlocked(acct) && !this._atHardLimit(acct)) {
        b.lastUsedAt = now;
        return acct;
      }
    }

    // (Re)bind: no binding, window lapsed, bound account blocked/capped, or over its line.
    const chosen = this._pickAccountForBinding();
    if (!chosen) return null; // genuinely exhausted — server returns an honest 429

    const prevAcct = b ? this.accounts[b.index] : null;
    const prevIdx = b?.index;
    const stillWarm = b && now - b.lastUsedAt < this.cacheAffinityWindowMs;
    const reason = !b ? 'new session'
      : !stillWarm ? 'window lapsed'
      : (prevAcct && this._paceGap(prevAcct) < -this.paceOvershootGuard) ? 'over pace line'
      : 'blocker'; // was warm; bound acct blocked/capped
    // Preserve per-session stats across a rebind — a session's work spans its
    // account switches (firstSeenAt = the session's true start, not the latest bind).
    this.sessionBindings.set(sessionId, {
      index: chosen.index, lastUsedAt: now, boundAt: now,
      firstSeenAt: b?.firstSeenAt ?? now,
      requests: b?.requests ?? 0,
      inputTokens: b?.inputTokens ?? 0,
      outputTokens: b?.outputTokens ?? 0,
    });
    this.currentIndex = chosen.index; // keep TUI "active account" meaningful
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

  // ── pace-to-expiry controller helpers ──────────────
  // expected(t) = fraction of THIS account's own 7d window that has elapsed.
  // 0 just after a reset → 1 at the reset. Per-account (each account's 7d window
  // is anchored independently). Returns null when the reset time is unknown — we
  // can't place the line, so the gap is treated as neutral (0) by _paceGap.
  _paceExpected(account) {
    const reset = account.quota.unified7dReset;
    if (!reset) return null;
    const tToReset = Math.max(0, reset - Date.now());
    return 1 - Math.min(1, tToReset / WEEK_MS);
  }

  // Signed distance from the expected line: expected − weekly-used.
  //   > 0  → BEHIND the line (under-utilized; wants more bindings)
  //   < 0  → AHEAD of the line (over-utilized; overshoot guard may exclude it)
  //   = 0  → on the line, or the reset is unknown (neutral — neither promoted nor guarded)
  _paceGap(account) {
    const expected = this._paceExpected(account);
    if (expected == null) return 0;
    const u7d = account.quota.unified7d ?? 0;
    return expected - u7d;
  }

  // Subscription ending soon — drain before expiry. Names come from config
  // (expiringAccounts); empty by default ⇒ no account gets precedence.
  _isExpiring(account) {
    return this.expiringAccounts.includes(account.name);
  }

  /**
   * Pick the account to (re)bind a session to — THE one rule (pace-to-line):
   *  1. usable accounts only (under the 0.98 hard ceiling, not throttled);
   *  2. overshoot guard — drop accounts more than paceOvershootGuard AHEAD of
   *     their line (degrade to all-usable if that would empty the pool);
   *  3. expiring-first — while any expiring account is still behind its line,
   *     restrict to that set so its soon-to-vanish budget drains first;
   *  4. furthest BEHIND its line wins; near-ties (within paceOvershootGuard of the
   *     top gap) break to the least-loaded account (fewest in-flight, then fewest
   *     warm sessions) so a burst of new bindings spreads instead of dogpiling one.
   * Returns null only when the pool is genuinely exhausted.
   */
  _pickAccountForBinding() {
    const usable = this.accounts.filter(a => this._isUsable(a));
    if (usable.length === 0) return this._soonestUsableOrNull();

    const onPace = usable.filter(a => this._paceGap(a) >= -this.paceOvershootGuard);
    const guarded = onPace.length > 0 ? onPace : usable;

    const expiringBehind = guarded.filter(a => this._isExpiring(a) && this._paceGap(a) > 0);
    const pool = expiringBehind.length > 0 ? expiringBehind : guarded;

    // Furthest behind its line first; spread near-ties by load.
    const ranked = pool.slice().sort((a, c) => this._paceGap(c) - this._paceGap(a));
    const topGap = this._paceGap(ranked[0]);
    const { counts } = this._activeSessionCounts();
    const contenders = ranked.filter(a => topGap - this._paceGap(a) <= this.paceOvershootGuard);
    return contenders.reduce((best, a) => {
      const ai = a._inflight || 0, bi = best._inflight || 0;
      if (ai !== bi) return ai < bi ? a : best;
      return counts[a.index] < counts[best.index] ? a : best;
    }, contenders[0]);
  }

  // ── D1DX patch (D-1903): per-account in-flight accounting ──────────
  // server.js brackets each real upstream attempt with start/end so the count
  // reflects concurrent requests actually hitting an account right now. Bounded
  // + clamped so a missed end (it shouldn't happen — server.js guards + finally)
  // can never wedge an account permanently above its cap.
  noteInflightStart(accountIndex) {
    const a = this.accounts[accountIndex];
    if (a) a._inflight = (a._inflight || 0) + 1;
  }

  noteInflightEnd(accountIndex) {
    const a = this.accounts[accountIndex];
    if (a) a._inflight = Math.max(0, (a._inflight || 0) - 1);
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
        // D-1827: umbrella type label. pc-current --set does NOT currently project
        // labels into pin.json (agent-kit scope), so this will be null for all
        // existing pins. Forward-compatible: if a future pc-current update writes
        // a `labels` array, it will be picked up here automatically.
        labels: Array.isArray(j.labels) ? j.labels : null,
      };
    } catch { data = null; }
    this._pinCache.set(fullSid, { at: now, data });
    return data;
  }

  // D-2085: return the age (ms) of the newest matching transcript file for a
  // session sid of the form "cc-<uuid>". Globs ~/.claude/projects/*/<uuid>.jsonl;
  // if multiple matches, uses the newest mtime. Returns null if no file found or
  // on any fs error (sentinel → caller treats as conservative present).
  _transcriptAgeMs(sid) {
    if (!sid) return null;
    const uuid = sid.startsWith('cc-') ? sid.slice(3) : sid;
    try {
      let newestMtime = null;
      let projectDirs;
      try { projectDirs = readdirSync(PROJECTS_DIR); } catch { return null; }
      for (const dir of projectDirs) {
        const candidate = join(PROJECTS_DIR, dir, `${uuid}.jsonl`);
        try {
          const st = statSync(candidate);
          if (newestMtime === null || st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
        } catch { /* not found in this dir */ }
      }
      if (newestMtime === null) return null;
      return Date.now() - newestMtime;
    } catch { return null; }
  }

  // D-2085: a row is PRESENT (keep it in fleet) iff its pid is alive (fast
  // positive), OR its transcript is not a zombie. Mirrors pc_session_present
  // in lib-sessions.sh (D-2085). Conservative: unknown transcript → present.
  _present(r) {
    if (this._pidAlive(r.pid)) return true;          // fast positive
    const age = this._transcriptAgeMs(r.sid);
    if (age == null) return true;                    // unknown transcript → conservative present
    return age <= SESSION_ZOMBIE_MS;                 // fresh → present; stale >12h → zombie
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
    const rows = (this._readSessionsRegistry() || []).filter(r => this._present(r));
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
        // D-1827: labels array from pin.json (null if not written by pc-current yet).
        labels: pin?.labels || null,
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
        cost: b.cost || 0,            // D-2169: API-equivalent $ for this session
        model: b.model || null,       // D-2169: last-seen model (for the price tier)
        avgTokensPerMsg: reqs ? Math.round(tokens / reqs) : 0,
        tokensPerMin: Math.round(tokens / (elapsedSec / 60)),
      });
    }
    return out.sort((a, c) => a.account.localeCompare(c.account) || c.tokens - a.tokens);
  }

  // Aggregate across all live sessions for the dashboard TOTAL (D-1728).
  sessionAggregate() {
    const now = Date.now();
    let sessions = 0, warm = 0, requests = 0, inputTokens = 0, outputTokens = 0, cost = 0, earliest = now;
    for (const b of this.sessionBindings.values()) {
      sessions++;
      if (now - b.lastUsedAt < this.cacheAffinityWindowMs) warm++;
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
  // D1DX (D-2169): also accumulates `cost` ($) and remembers the last `model`.
  _ledgerTouch(sessionId, accountName, inputTokens, outputTokens, cost = 0, model = null) {
    if (!sessionId) return;
    const issue = this._sessionRow(sessionId)?.pinned_issue || '';
    const key = `${sessionId}::${issue}`;
    let e = this.usageLedger.get(key);
    const now = Date.now();
    if (!e) {
      e = { sid: sessionId, issue, account: accountName, messages: 0, inputTokens: 0, outputTokens: 0, cost: 0, model: null, firstSeenAt: now, lastActiveAt: now };
      this.usageLedger.set(key, e);
    }
    e.account = accountName;
    if (inputTokens) { e.messages++; e.inputTokens += inputTokens; }
    if (outputTokens) e.outputTokens += outputTokens;
    if (cost) e.cost = (e.cost || 0) + cost;
    if (model) e.model = model;
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
      if (!g) { g = { issue: k, sessions: 0, messages: 0, inputTokens: 0, outputTokens: 0, cost: 0, lastActiveAt: 0 }; byIssue.set(k, g); }
      g.sessions++;
      g.messages += e.messages || 0;
      g.inputTokens += e.inputTokens || 0;
      g.outputTokens += e.outputTokens || 0;
      g.cost += e.cost || 0;
      if ((e.lastActiveAt || 0) > g.lastActiveAt) g.lastActiveAt = e.lastActiveAt;
    }
    return [...byIssue.values()].map(g => {
      const tokens = g.inputTokens + g.outputTokens;
      return { ...g, tokens, avgTokensPerMsg: g.messages ? Math.round(tokens / g.messages) : 0 };
    }).sort((a, c) => c.tokens - a.tokens);
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

  // Throttled / errored / exhausted — unusable. A throttle whose window has passed
  // flips the account back to active immediately (normal 429 failover).
  _isBlocked(account) {
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

  // Usable — not blocked and below the 0.98 hard ceiling.
  _isUsable(account) {
    if (this._isBlocked(account)) return false;
    this._clearExpiredQuotas(account);
    return !this._atHardLimit(account);
  }

  _switchTo(account, reason) {
    if (account.index !== this.currentIndex) {
      console.log(`[TeamClaude] Switched to ${reason}`);
    }
    this.currentIndex = account.index;
    return account;
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

    // Log when an account is near the hard ceiling.
    const weeklyUtil = account.quota.unified7d;
    if (weeklyUtil != null && weeklyUtil >= this.switchThreshold - 0.05) {
      console.log(`[TeamClaude] Account "${account.name}" at ${(weeklyUtil * 100).toFixed(1)}% weekly — near ceiling`);
    }
  }

  /**
   * Update cumulative token usage from response body data.
   *
   * D1DX (D-2169): also computes API-equivalent COST. message_start carries
   * input_tokens (uncached) + cache tokens + the model; message_delta carries
   * output_tokens only — so the model is remembered on the binding from
   * message_start and reused for the output-side cost. opts: { cacheCreate5m,
   * cacheCreate1h, cacheRead, model }.
   */
  updateUsage(accountIndex, inputTokens, outputTokens, sessionId = null, opts = {}) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;

    const sb = sessionId ? this.sessionBindings.get(sessionId) : null;
    // Resolve the model for pricing: explicit (message_start) → remember it;
    // else the binding's last-seen model (message_delta) → else null (→ opus).
    const model = opts.model || sb?.model || null;
    if (opts.model && sb) sb.model = opts.model;
    const price = this._priceFor(model);
    const cacheCreate5m = opts.cacheCreate5m || 0;
    const cacheCreate1h = opts.cacheCreate1h || 0;
    const cacheRead = opts.cacheRead || 0;
    const cost = (
      (inputTokens || 0) * price.in
      + cacheCreate5m * price.in * CACHE_WRITE_5M_MULT
      + cacheCreate1h * price.in * CACHE_WRITE_1H_MULT
      + cacheRead * price.in * CACHE_READ_MULT
      + (outputTokens || 0) * price.out
    ) / 1e6;
    account.usage.totalCost = (account.usage.totalCost || 0) + cost;

    // D-1728: per-session attribution for the live dashboard. Only attributes
    // when the session still has a binding.
    if (sessionId) {
      if (sb) {
        if (inputTokens) { sb.requests++; sb.inputTokens += inputTokens; }
        if (outputTokens) sb.outputTokens += outputTokens;
        sb.cost = (sb.cost || 0) + cost;
      }
      // D-1728 S6: durable ledger (survives idle-eviction + restart).
      this._ledgerTouch(sessionId, account.name, inputTokens, outputTokens, cost, model);
      this._maybeSaveLedger();
    }
  }

  /**
   * Mark an account as rate-limited (429). ONE bounded backoff: bench the account
   * for backoffSec (or an explicit upstream retry-after, clamped to
   * allThrottledCapSec), plus small random jitter so a burst of 429s doesn't
   * cluster every account's window on the same instant. A genuinely capped account
   * is still excluded by _atHardLimit (its 429 carries unified ≈ 1.0 / status
   * `rejected`), so the short re-probe never hammers a real cap.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    const now = Date.now();
    const capMs = this.allThrottledCapSec * 1000;
    const baseMs = (retryAfterSeconds != null && !isNaN(retryAfterSeconds))
      ? Math.min(retryAfterSeconds * 1000, capMs)
      : this.backoffSec * 1000;
    const jitterMs = Math.random() * this.backoffSec * 1000; // de-sync window expiry
    account.status = 'throttled';
    account.rateLimitedUntil = now + baseMs + jitterMs;
    console.log(`[TeamClaude] Account "${account.name}" rate limited +${Math.round((baseMs + jitterMs) / 1000)}s`);
  }

  /** A successful response on an account — no per-account streak state to reset now. */
  noteAccountSuccess(_accountIndex) { /* no-op: single bounded backoff has no streak */ }

  /**
   * Retry-after (seconds) to hand the client when EVERY account is throttled.
   * Real-reset-aware (soonest genuine reset across the pool), clamped to
   * [backoffSec, allThrottledCapSec], with upward-only jitter so we never tell the
   * client to retry BEFORE the real reset (which would just earn another 429).
   */
  allThrottledBackoff() {
    const now = Date.now();
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
    let secs = soonest === Infinity ? this.backoffSec : (soonest - now) / 1000;
    secs = Math.max(this.backoffSec, Math.min(this.allThrottledCapSec, secs));
    secs += Math.random() * secs * 0.15; // upward-only de-sync jitter
    return Math.max(1, Math.ceil(secs));
  }

  /** A successful upstream response — no all-throttled episode state to clear now. */
  noteSuccess() { /* no-op: simplified rails have no episode streak */ }

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
      _inflight: 0, // D1DX (D-1903)
    });
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
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
      system: this.systemSnapshot(),                 // D1DX (D-1728 S8): proxy + host resources
      sessionBindings: this.sessionBindingSummary(), // D1DX (D-1728): live session→account map
      sessionAggregate: this.sessionAggregate(),     // D1DX (D-1728): live dashboard TOTAL
      usageByIssue: this.ledgerByIssue(),            // D1DX (D-1728 S6): durable per-issue rollup
      accounts: this.accounts.map(a => ({
        name: a.name,
        type: a.type,
        status: a.status,
        inflight: a._inflight || 0, // D1DX (D-1903): live concurrent in-flight count
        quota: { ...a.quota },
        usage: { ...a.usage },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
    };
  }
}

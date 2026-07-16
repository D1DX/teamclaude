import { refreshAccessToken, isTokenExpiringSoon } from './oauth.js';
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { systemSnapshot as _systemSnapshot } from './infra/system.js';
import { priceFor } from './accounting/pricing.js';
import { updateUsage as usageUpdateUsage, recordBurn as usageRecordBurn, burnWindow as usageBurnWindow } from './accounting/usage.js';
import { setLedgerPath as ledgerSetPath, loadLedger as ledgerLoad, saveLedger as ledgerSave, pruneLedger as ledgerPrune, ledgerTouch as ledgerTouchFn, maybeSaveLedger as ledgerMaybeSave, ledgerByIssue as ledgerByIssueFn, ledgerBySid as ledgerBySidFn } from './accounting/ledger.js';
import { computeCapacity as capComputeCapacity, noteAccountSuccess as capNoteAccountSuccess, recalibrateCap as capRecalibrateCap } from './accounting/capacity.js';
import { warmAll as warmerWarmAll, warmOne as warmerWarmOne, warmHeadroom as warmerWarmHeadroom, rewarmFailed as warmerRewarmFailed } from './auth/warmer.js';
import { createAccounts, addAccount as poolAddAccount, removeAccount as poolRemoveAccount } from './core/pool.js';
import { getAccountForSession as sessGetAccountForSession, activeSessionCounts as sessActiveSessionCounts, evictStaleBindings as sessEvictStaleBindings, sessionBindingSummary as sessBindingSummary, sessionAggregate as sessAggregate } from './core/session.js';
import { getActiveAccount as selGetActiveAccount, pickAccountForBinding as selPickAccountForBinding, paceLine as selPaceLine, paceGap as selPaceGap, rampBoost as selRampBoost, paceScore as selPaceScore, apikeyShouldYield as selApikeyShouldYield, hasUsableApikey as selHasUsableApikey, switchTo as selSwitchTo } from './core/selection.js';
import { noteInflightStart as dispNoteInflightStart, noteInflightEnd as dispNoteInflightEnd, tryReserveInflight as dispTryReserveInflight, atInflightCap as dispAtInflightCap } from './core/dispatch.js';
import { sweepAll as benchSweepAll, clearExpiredQuotas as benchClearExpiredQuotas, isBlocked as benchIsBlocked, atHardLimit as benchAtHardLimit, isUsable as benchIsUsable, soonestUsableOrNull as benchSoonestUsableOrNull, isPremiumModel as benchIsPremiumModel, premiumRejected as benchPremiumRejected, premiumRequested as benchPremiumRequested, markRateLimited as benchMarkRateLimited, allHardCapped as benchAllHardCapped } from './core/bench.js';
import { updateQuota as quotaUpdateQuota, applyProbeUsage as quotaApplyProbeUsage } from './core/quota.js';
import { allThrottledBackoff as holdAllThrottledBackoff } from './core/hold-policy.js';

// D1DX (D-1728): D1DX session presence registry — used only to resolve a
// session emoji for log/TUI display. Best-effort; never load-bearing for routing.
const SESSIONS_REGISTRY = join(homedir(), '.claude', 'state', 'sessions.json');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
// D-2203: the deck is a LIVE-ACTIVITY view. A session is present iff it did
// something within this window (transcript touched) — 30m, aligned with
// `bindingEvictSec` so an idle session drops from the fleet spine and the
// binding view together. The deck only HIDES (cheap, reversible), so unlike the
// bash reaper it needs no 12h/grace/pid-identity ceremony — a stale-but-maybe-
// alive row is safely dropped and reappears the instant it does anything.
const DECK_PRESENT_MS = 30 * 60 * 1000; // 30m activity window
// D-2203: a brand-new session whose transcript JSONL has not materialised yet is
// rescued for this long after it registered (pid-free — `started` from the row),
// then drops if it still has produced no real turn.
const NEW_SESSION_GRACE_MS = 2 * 60 * 1000; // 2m
// Bytes of transcript tail scanned for the last real turn (the turn sits just
// behind the trailing no-ts metadata block; a bounded read keeps it O(tail)).
const TURN_TAIL_BYTES = 65536;

// D-2697: wall-clock time string, byte-identical to tui.js's timestamp() so the
// server-side Activity ring renders the same as the interactive Deck's.
function _actTimestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

export class AccountManager {
  // Pool selection + reactive rate-limit handling. The invariant catalog and its
  // incident→invariant→test mapping live in design/architecture-v3.md §2.1.
  //   • SELECT: session cache-affinity + pace-to-weekly-line (covered by
  //     pace-controller.test, session-routing.test, selection.test).
  //   • BENCH: reactive-only — the server's explicit signal is the only admission
  //     signal. A 429 with retry-after benches that one account for exactly the
  //     stated duration; a header-less 429 fails over, never benches; a base-axis
  //     unified-status `rejected` excludes the account until its reset (Q1). No
  //     prediction, no streak, no utilization thresholds (covered by
  //     reactive-bench.test, per-family-reject.test).
  //   • CAPACITY: per-account rolling 5h/7d burn + success-taught cap → reporting
  //     only, never admission (covered by capacity.test).
  // switchThreshold (0.98) is a reporting band only (the near-ceiling display log).
  constructor(accounts, switchThreshold = 0.98, opts = {}) {
    // §3.1(b): the ONE mutable account array — created by core/pool.js, held by
    // reference here, read (never copied) by every core module.
    this.accounts = createAccounts(accounts);
    this.currentIndex = 0;
    this.switchThreshold = switchThreshold; // hard ceiling — 5h axis + real weekly limit
    this._didBootSelect = false;            // first selection picks best, not config index 0

    // ── Selection: session-sticky + pace-to-weekly-line (D-2104, real-data) ──
    // A session sticks to one account (per-account prompt cache) until a blocker,
    // the idle window, the 5h never-stall rail, or being far past its weekly line.
    // New/rebound work goes to the account furthest BEHIND its weekly pace line.
    // Anthropic returns unified-5h/7d-utilization on every Max OAuth response
    // (proven live; D-2179's "headers never sent → pace inert" premise was false —
    // it grepped logs that weren't capturing response headers). So pacing runs on
    // real per-account utilization, not an estimate.
    this.sessionBindings = new Map(); // sid -> { index, lastUsedAt, boundAt, ... }
    this.cacheAffinityWindowMs = (opts.cacheAffinityWindowSec ?? 300) * 1000; // warm-stick window
    this.bindingEvictMs        = (opts.bindingEvictSec        ?? 1800) * 1000; // drop idle bindings

    // farOverLineThreshold = control law #6: a warm session is rebound for pacing
    // ONLY when its account is this far past its weekly line (cache yields late).
    this.farOverLineThreshold = opts.farOverLineThreshold ?? 0.10;
    // Anti-dogpile (D-2104 hardening): without these, a concurrent burst all
    // picks the single most-behind account and 429s it (thundering herd).
    // paceTieBand: accounts within this of the best paceScore are "equally
    // behind" → spread by load instead of dogpiling. maxInflightPerAccount: a
    // hard never-stall valve — an account at this many concurrent in-flight
    // requests takes no new bind, so a burst spills across accounts in pace order
    // (bounds overshoot even when the 5h header lags the burst).
    this.paceTieBand          = opts.paceTieBand          ?? 0.10;
    this.maxInflightPerAccount = opts.maxInflightPerAccount ?? 5;
    // Probe-gate (D-2104): an UNPROVEN account (no 200 in this active spell — cold,
    // or just recovered from a bench) admits only ONE in-flight request; until that
    // probe returns 200 it takes no further binds, so we never pile sessions onto an
    // account we haven't confirmed has headroom. maxSessionsPerAccount: hard cap on
    // bound warm sessions per account (instances limit) — a burst spills beyond it.
    this.maxSessionsPerAccount = opts.maxSessionsPerAccount ?? 7;
    // End-of-cycle ramp (control law #3): weight by hours-to-7d-reset, applied to
    // the account's unused weekly fraction → drains quota before it resets.
    // First tier (ascending hours) whose bound ≥ hoursToReset wins.
    this.rampTiers = opts.rampTiers ?? [
      { hours: 8,  weight: 100 }, // ≤8h  → put all it can take on it
      { hours: 16, weight: 8 },   // ≤16h → almost all
      { hours: 24, weight: 4 },   // ≤24h → prefer aggressively
      { hours: 48, weight: 2 },   // ≤48h → push
      { hours: 72, weight: 1 },   // ≤72h → push where possible
    ];

    // DL-2841: per-model-tier weekly sub-limit awareness. Anthropic meters the
    // flagship/premium tier (e.g. Fable) on a SEPARATE weekly axis (`unified-7d_oi-*`)
    // and rejects premium-model requests on it while the account's base 5h/7d budget
    // is fine. Without this, a single Fable 429 set the account-wide `unified-status:
    // rejected` and benched the WHOLE account out of the pool for every model — a stuck
    // trap (excluded → no non-premium traffic ever flips it back). premiumModelRe
    // classifies which outbound models fall in that tier so a premium-capped account is
    // avoided for premium requests only, and stays fully usable for the rest.
    this.premiumModelRe = (() => {
      const src = opts.premiumModelPattern ?? 'fable|mythos';
      try { return new RegExp(src, 'i'); } catch { return /fable|mythos/i; }
    })();

    // ── 429 handling: reactive-only bench (covered by reactive-bench.test) ──
    // A 429 with a server retry-after benches that one account for exactly the
    // stated duration; a header-less 429 fails over, never benches. backoffBaseSec
    // is the floor for the all-throttled client retry-after; allThrottledCapSec its
    // ceiling. No ladder, no streak, no utilization thresholds.
    this.backoffBaseSec     = opts.backoffSec         ?? 60;   // all-throttled retry-after floor
    this.allThrottledCapSec = opts.allThrottledCapSec ?? 600;  // client retry-after cap

    // ── Capacity model (reporting only) ──
    // Per-account hourly burn buckets (≤168 = 7d) feed a success-taught 5h cap.
    // headroom is published below the cap by capSoftCeiling; concurrency by
    // softConcurrencyPerAccount. Never an admission signal.
    this.capSoftCeiling            = opts.capSoftCeiling            ?? 0.75;
    this.softConcurrencyPerAccount = opts.softConcurrencyPerAccount ?? 3;
    // DL-3032: learned-cap recalibration. The EMA cap is learned at a 429 moment and
    // never decayed — a burst-driven low estimate freezes and falsely trips nearCap.
    // capEst decays toward the max observed SUCCESSFUL 5h burn (proven headroom) with
    // this half-life, and raises immediately when a success burns past capEst×capSoftCeiling.
    this.capDecayHalfLifeHours     = opts.capDecayHalfLifeHours     ?? 24;

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
    // Falls back per family to the default table in accounting/pricing.js.
    this.pricing = opts.pricing ?? null;

    // ── D-2697: server-side live request stream (Activity panel) ──
    // In the centralized/headless mode there is no interactive TUI to track the
    // in-flight requests + completed log (those lived only on the TUI instance,
    // tui.js:262-286). So AccountManager keeps its OWN in-memory active-map +
    // recent-log ring, fed by the same server hooks (wired in index.js when
    // !useTUI). getDeckSnapshot() ships them and a remote `watch` viewer renders
    // the ORIGINAL Activity panel from them — no port bind, no second server.
    this._active = new Map(); // reqId -> { method, path, account, t, started }
    this._log = [];           // [{ t, msg }] newest-first, capped at LOG_CAP
  }

  // D1DX (D-2169): resolve $/Mtok [input, output] for a model string. Delegated
  // to accounting/pricing.js (the price table + family match live there); passes
  // this manager's per-family overrides (opts.pricing).
  _priceFor(model) {
    return priceFor(model, this.pricing);
  }

  // D1DX patch: actively sweep ALL accounts every request + on every status read,
  // not just `current`. Clears an expired throttle (so a freed account rejoins the
  // failover pool immediately) and stale quota windows. In-memory, no network, no
  // timer — keeps the whole pool fresh and the status display truthful.
  _sweepAll() { return benchSweepAll(this); }

  /**
   * Get the best available account (sticky while the current one is preferred).
   * Returns null only if every account is hard-capped / throttled with no reset yet.
   */
  getActiveAccount(opts = {}) { return selGetActiveAccount(this, opts); }

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
  getAccountForSession(sessionId, opts = {}) { return sessGetAccountForSession(this, sessionId, opts); }

  // Per-account count of warm-bound sessions (core/session.js). { counts, active }.
  _activeSessionCounts() { return sessActiveSessionCounts(this); }

  // ── Pace-to-weekly-line helpers (D-2104, real-data) ──────────────────
  // Expected weekly utilization right now: fraction of the account's own 7d
  // window elapsed. Window = [reset-7d, reset]; line = 1 - timeLeft/7d. A null
  // reset (not yet observed) → line 0, so the account reads as "behind" and gets
  // traffic that then populates its headers (self-priming).
  _paceLine(account) { return selPaceLine(this, account); }

  // How far BEHIND its weekly line the account is (core/selection.js).
  _paceGap(account) { return selPaceGap(this, account); }

  // Premium/flagship weekly-tier (7d_oi) model classification (core/bench.js).
  _isPremiumModel(model) { return benchIsPremiumModel(this, model); }

  // Is this account currently premium-tier (7d_oi) capped? (core/bench.js).
  _premiumRejected(account) { return benchPremiumRejected(this, account); }

  // Does this request need a premium account — executor OR advisor model premium
  // (DL-2841 advisor-aware premium skip)? (core/bench.js).
  _premiumRequested(opts) { return benchPremiumRequested(this, opts); }

  // End-of-cycle ramp (control law #3): as the account nears its 7d-reset, escalate
  // preference to drain unused weekly quota before it resets (use-it-or-lose-it).
  // Boost = unusedWeeklyFraction × tierWeight(hoursToReset). 0 outside all tiers.
  _rampBoost(account) { return selRampBoost(this, account); }

  // Selection score: behind-line gap + end-of-cycle ramp (core/selection.js).
  _paceScore(account) { return selPaceScore(this, account); }

  // ── Capacity-model burn buckets (accounting/usage.js) ──────────────────
  _recordBurn(account, tokens) { return usageRecordBurn(this, account, tokens); }

  _burnWindow(account, hours) { return usageBurnWindow(this, account, hours); }

  /**
   * Pick the account to (re)bind a session to (pace controller; covered by
   * pace-controller.test, selection.test). Layered eligibility — each set falls
   * back to the prior so we never refuse while any usable account exists (a truly
   * exhausted pool yields null via _soonestUsableOrNull at the top):
   *   1. usable — not blocked, not base-axis `rejected` (Q1 hard-cap);
   *   2. premium filter — a premium request skips premium-capped accounts;
   *   3. atomic in-flight cap — under maxInflightPerAccount (DL-2226);
   *   4. session cap — under maxSessionsPerAccount bound warm sessions.
   * Then within the surviving pool, a PACE TIE-BAND: accounts within paceTieBand
   * of the best paceScore are "equally behind" → spread a concurrent burst across
   * them by load (fewest warm sessions, then fewest in-flight) instead of
   * dogpiling the single best. A clearly-leading account (genuinely most-behind,
   * or ramping near its reset) sits alone in the band and still concentrates load
   * — bounded by the caps so it drains without 429ing.
   */
  _pickAccountForBinding(opts = {}) { return selPickAccountForBinding(this, opts); }

  // apikey yields back to Max the moment any OAuth account recovers (core/selection.js).
  _apikeyShouldYield(account) { return selApikeyShouldYield(this, account); }

  // Is a usable apikey last-resort configured? (core/selection.js) — hold loop checks this.
  hasUsableApikey() { return selHasUsableApikey(this); }

  // ── Per-account in-flight accounting (core/dispatch.js) ──────────
  noteInflightStart(accountIndex) { return dispNoteInflightStart(this, accountIndex); }

  noteInflightEnd(accountIndex) { return dispNoteInflightEnd(this, accountIndex); }

  // DL-2226: atomic in-flight reserve (check+set in one step) — core/dispatch.js.
  tryReserveInflight(accountIndex) { return dispTryReserveInflight(this, accountIndex); }

  // DL-2226: at/over the in-flight cap? (core/dispatch.js) — server holds for a slot.
  atInflightCap(accountIndex) { return dispAtInflightCap(this, accountIndex); }

  // Tier-3 fallback: soonest-to-reset account, reactivated only if its reset has
  // passed; else null (genuinely exhausted → honest 429) (core/bench.js).
  _soonestUsableOrNull() { return benchSoonestUsableOrNull(this); }

  _evictStaleBindings() { return sessEvictStaleBindings(this); }

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

  // D-2203: epoch-ms of the session's NEWEST real turn (a user|assistant entry's
  // .timestamp), or null. The transcript FILE-MTIME (_transcriptAgeMs, retained
  // as a fallback) is bumped by no-timestamp harness metadata appended even at
  // idle (mode/permission-mode/ai-title/agent-name/custom-title/
  // file-history-snapshot/last-prompt/agent-*), so it reads a quiet session as
  // fresh. Only user|assistant are real turns. Reads a bounded tail and scans
  // backward for the newest one; widens once to the whole file if the tail holds
  // no turn. All fs/JSON guarded → null on any failure.
  _newestTurnTs(sid) {
    if (!sid) return null;
    const uuid = sid.startsWith('cc-') ? sid.slice(3) : sid;
    // Resolve the newest-mtime matching transcript (mirrors _transcriptAgeMs).
    let path = null, newestMtime = null;
    try {
      for (const dir of readdirSync(PROJECTS_DIR)) {
        const candidate = join(PROJECTS_DIR, dir, `${uuid}.jsonl`);
        try {
          const st = statSync(candidate);
          if (newestMtime === null || st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; path = candidate; }
        } catch { /* not in this dir */ }
      }
    } catch { return null; }
    if (!path) return null;

    const scanBackward = (text) => {
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if ((o.type === 'user' || o.type === 'assistant') && o.timestamp) {
          const t = Date.parse(o.timestamp);
          if (!Number.isNaN(t)) return t;
        }
      }
      return null;
    };

    try {
      const size = statSync(path).size;
      if (size > TURN_TAIL_BYTES) {
        const fd = openSync(path, 'r');
        try {
          const buf = Buffer.alloc(TURN_TAIL_BYTES);
          readSync(fd, buf, 0, TURN_TAIL_BYTES, size - TURN_TAIL_BYTES);
          const text = buf.toString('utf8');
          const nl = text.indexOf('\n');               // drop the partial first line
          const t = scanBackward(nl >= 0 ? text.slice(nl + 1) : text);
          if (t != null) return t;
          return scanBackward(readFileSync(path, 'utf8'));  // widen once
        } finally { closeSync(fd); }
      }
      return scanBackward(readFileSync(path, 'utf8'));
    } catch { return null; }
  }

  // D-2203: age (ms) since the last real turn. When the transcript has 0 real turns
  // (a metadata-only stub) this falls back to the file mtime (a valid staleness
  // floor — the metadata-poke problem only masks an OLD real turn behind a FRESH
  // mtime, and a 0-turn stub has no real turn to mask, so a brand-new stub reads
  // fresh and a dead stub reads stale — restoring reaper/hide coverage). null ONLY
  // when there is no transcript file at all (caller routes null to the started-
  // freshness rescue). Cached per-sid ~5s — the deck refreshes ~1s, many rows/tick.
  _lastTurnAgeMs(sid) {
    if (!sid) return null;
    this._turnCache ??= new Map();
    const now = Date.now();
    const c = this._turnCache.get(sid);
    let ts;
    if (c && now - c.at < 5000) ts = c.ts;
    else { ts = this._newestTurnTs(sid); this._turnCache.set(sid, { at: now, ts }); }
    if (ts != null) return now - ts;
    return this._transcriptAgeMs(sid);   // 0-turn stub → mtime floor; no file → null
  }

  // D-2203: a row is PRESENT on the deck iff the session took a REAL TURN recently.
  // The deck is a LIVE view, so presence keys on the last real turn (newest
  // user|assistant transcript timestamp — the truthful signal), NOT on the
  // transcript FILE-MTIME (bumped by idle harness metadata) nor the recorded pid
  // (D-2085: a recyclable daemon-pool ancestor — "alive" proves nothing). Three
  // ways to be present:
  //   1. a tool is executing right now (the D-1749 inflight marker), OR
  //   2. the last real turn was within DECK_PRESENT_MS (recent activity), OR
  //   3. no transcript file / no real turn yet — a brand-new session — rescued
  //      for NEW_SESSION_GRACE_MS after it registered (started-freshness, pid-free).
  // Everything else (last turn stale past the window, or no turn + started past the
  // grace) is hidden. Hiding is reversible: the row reappears the instant the
  // session takes a turn. Deliberately MORE aggressive than the bash reaper, which
  // DELETES rows and so stays conservative (pid-identity + 12h, D-2196).
  _present(r) {
    if (this._sessionInflight(r.sid)) return true;            // a tool is running now
    const age = this._lastTurnAgeMs(r.sid);
    if (age == null) {                                        // no real turn yet → new-session rescue
      const started = r.started ? Date.parse(r.started) : NaN;
      return !Number.isNaN(started) && (Date.now() - started) <= NEW_SESSION_GRACE_MS;
    }
    return age <= DECK_PRESENT_MS;                            // recent real turn → present; stale → hide
  }

  // D-1739: a process is alive if kill(pid,0) succeeds; EPERM also means alive
  // (someone else's process); only ESRCH (no such process) is dead. No pid →
  // treat as alive (can't disprove). Used ONLY as the new-session rescue in
  // _present (a recent pid for a not-yet-materialised transcript) — NOT as a
  // general presence signal, because an alive pid can be a recycled ghost.
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

  // bareSid → last-known account name from the durable ledger (accounting/ledger.js).
  ledgerBySid() { return ledgerBySidFn(this); }

  // Process + system resource snapshot for the dashboard (D-1728 S8). Cheap host
  // introspection — delegated to infra/system.js (mem/CPU gauge caches live there).
  systemSnapshot() {
    return _systemSnapshot();
  }

  // Live session→account bindings + per-session usage for the dashboard (core/session.js).
  sessionBindingSummary() { return sessBindingSummary(this); }

  // Aggregate across all live sessions for the dashboard TOTAL (core/session.js).
  sessionAggregate() { return sessAggregate(this); }

  // ── Durable per-issue usage ledger (accounting/ledger.js) ───────────────
  setLedgerPath(p) { return ledgerSetPath(this, p); }

  loadLedger() { return ledgerLoad(this); }

  saveLedger() { return ledgerSave(this); }

  _pruneLedger() { return ledgerPrune(this); }

  _ledgerTouch(sessionId, accountName, inputTokens, outputTokens, cost = 0, model = null) {
    return ledgerTouchFn(this, sessionId, accountName, inputTokens, outputTokens, cost, model);
  }

  _maybeSaveLedger() { return ledgerMaybeSave(this); }

  // Per-issue rollup across ALL ledger entries (accounting/ledger.js).
  ledgerByIssue() { return ledgerByIssueFn(this); }

  // Clear stale quota windows (5h/7d/standard) on an account (core/bench.js).
  _clearExpiredQuotas(account) { return benchClearExpiredQuotas(this, account); }

  // Throttled / errored / exhausted — unusable; expired throttle flips active (core/bench.js).
  _isBlocked(account) { return benchIsBlocked(this, account); }

  // Q1 hard cap: base-axis unified-status `rejected` (core/bench.js).
  _atHardLimit(account) { return benchAtHardLimit(this, account); }

  // Usable — not blocked and not base-axis `rejected` (core/bench.js).
  _isUsable(account) { return benchIsUsable(this, account); }

  _switchTo(account, reason) { return selSwitchTo(this, account, reason); }

  // Update an account's quota from upstream response headers (core/quota.js).
  updateQuota(accountIndex, headers) { return quotaUpdateQuota(this, accountIndex, headers); }

  // Apply a zero-spend /api/oauth/usage probe result — REPORTING ONLY (core/quota.js).
  // Writes utilization/reset for pace + capacity; never an admission signal, never
  // counts a request. Fed by auth/prober.js (DL-3105).
  applyProbeUsage(accountIndex, usage) { return quotaApplyProbeUsage(this, accountIndex, usage); }

  // Cumulative token usage + cost + burn buckets from a response (accounting/usage.js).
  updateUsage(accountIndex, inputTokens, outputTokens, sessionId = null, opts = {}) {
    return usageUpdateUsage(this, accountIndex, inputTokens, outputTokens, sessionId, opts);
  }

  // Mark an account rate-limited (429) — reactive-only (core/bench.js).
  markRateLimited(accountIndex, retryAfterSeconds) { return benchMarkRateLimited(this, accountIndex, retryAfterSeconds); }

  // A successful response — mark proven + recalibrate the learned cap (accounting/capacity.js).
  noteAccountSuccess(accountIndex) { return capNoteAccountSuccess(this, accountIndex); }

  // Success-taught 5h-cap recalibration, reporting only (accounting/capacity.js).
  _recalibrateCap(account) { return capRecalibrateCap(this, account); }

  // Reset-aware all-throttled client retry-after (core/hold-policy.js).
  allThrottledBackoff() { return holdAllThrottledBackoff(this); }

  /** A successful upstream response — no all-throttled episode state to clear now. */
  noteSuccess() { /* no-op: simplified rails have no episode streak */ }

  // Capacity snapshot for orchestrators (reporting only) — accounting/capacity.js.
  computeCapacity() { return capComputeCapacity(this); }

  // Q1 signal 2: every account server-`rejected` for this request's axis (core/bench.js).
  // advisorModel: premium (7d_oi) rejection counts when executor OR advisor is premium.
  allHardCapped(model = null, advisorModel = null) { return benchAllHardCapped(this, model, advisorModel); }

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

  // Add a new account at runtime (core/pool.js). Returns its index.
  addAccount(acctData) { return poolAddAccount(this, acctData); }

  // Remove an account by index (core/pool.js) — reindexes + repairs currentIndex.
  removeAccount(index) { return poolRemoveAccount(this, index); }

  // ── Account warming (auth/warmer.js) ───────────────
  async warmAll(upstream = 'https://api.anthropic.com') { return warmerWarmAll(this, upstream); }

  async warmOne(account, upstream = 'https://api.anthropic.com') { return warmerWarmOne(this, account, upstream); }

  // D-2805: on-demand headroom "mint" (POST /teamclaude/warm) — auth/warmer.js.
  async warmHeadroom(threshold = 0.90, upstream = 'https://api.anthropic.com') { return warmerWarmHeadroom(this, threshold, upstream); }

  async _rewarmFailed(indices, upstream, backoffsSec = [5, 10, 20, 40]) { return warmerRewarmFailed(this, indices, upstream, backoffsSec); }

  // ── D-2697: live request stream hooks ──────────────────────
  // Mirror tui.js's onRequestStart/Routed/End (262-286) so the centralized
  // headless proxy tracks the same active-map + log ring the interactive Deck
  // does. Wired into the server in index.js when !useTUI. NOTE: unlike the TUI
  // version these DO NOT persist to the daily oplog file — in headless mode the
  // console tee (index.js) already files non-2xx lines, so persisting here too
  // would double-write. The ring is purely the live-snapshot source.
  onRequestStart(id, info) {
    this._active.set(id, { ...info, t: _actTimestamp(), started: Date.now(), account: null });
  }

  onRequestRouted(id, info) {
    const r = this._active.get(id);
    if (r) {
      r.account = info.account;
      // DL-2785 data: surface the parsed executor model + effort on the live
      // request record so the Deck's model·effort Activity tag can render them
      // (this module never builds the tag — data only).
      if (info.model != null) r.model = info.model;
      if (info.effort != null) r.effort = info.effort;
    }
  }

  onRequestEnd(id, info) {
    const r = this._active.get(id);
    this._active.delete(id);
    const dur = r ? ((Date.now() - r.started) / 1000).toFixed(1) : '?';
    const acct = info.account || r?.account || '?';
    this._addLog(`${info.method} ${info.path} → ${acct} (${info.status}, ${dur}s)`);
  }

  _addLog(msg) {
    msg = msg.replace(/^\[TeamClaude\]\s*/, '');
    this._log.unshift({ t: _actTimestamp(), msg });
    if (this._log.length > 200) this._log.length = 200;
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    this._sweepAll(); // D1DX patch: truthful display — clear expired throttles/quotas before rendering
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      capacity: this.computeCapacity(),              // D1DX (D-2179): pool capacity verdict
      system: this.systemSnapshot(),                 // D1DX (D-1728 S8): proxy + host resources
      sessionBindings: this.sessionBindingSummary(), // D1DX (D-1728): live session→account map
      sessionAggregate: this.sessionAggregate(),     // D1DX (D-1728): live dashboard TOTAL
      usageByIssue: this.ledgerByIssue(),            // D1DX (D-1728 S6): durable per-issue rollup
      accounts: this.accounts.map(a => ({
        name: a.name,
        type: a.type,
        status: a.status,
        inflight: a._inflight || 0, // D1DX (D-1903): live concurrent in-flight count
        benchSec: (a.status === 'throttled' && a.rateLimitedUntil)
          ? Math.max(0, Math.ceil((a.rateLimitedUntil - Date.now()) / 1000)) : 0,
        premiumCappedSec: this._premiumRejected(a) // DL-2841: premium-tier (7d_oi) capped, still usable for non-premium
          ? Math.max(0, Math.ceil((a._premiumRejectedUntil - Date.now()) / 1000)) : 0,
        burn5h: this._burnWindow(a, 5),   // D1DX (D-2179): rolling 5h token burn
        capEst5h: a._capEst5h ?? null,    // D1DX (D-2179): learned 5h cap
        quota: { ...a.quota },
        usage: { ...a.usage },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
    };
  }

  // D-2485: full Deck-render snapshot — a SUPERSET of getStatus() carrying
  // everything tui.js render() consumes, so a read-only viewer (`teamclaude
  // watch`) can render the IDENTICAL Deck from a polled JSON snapshot without
  // being the server (no port bind, no second pooling process). Single source
  // of truth: it reuses getStatus() plus the same fleet/ledger accessors the
  // live Deck reads, so the viewer can never drift from the real Deck.
  //   getStatus() already gives accounts/quota/usage/capacity/system/
  //   sessionBindings/sessionAggregate/usageByIssue. The Deck additionally
  //   reads currentIndex (current-account ►), fleetRows() (the registry spine),
  //   and ledgerBySid() (cluster idle agents under their last account). The
  //   per-request spinner rows are NOT pollable (sub-second, no HTTP surface),
  //   so we publish a scalar activeLLM count for the Top "N LLM" line instead.
  getDeckSnapshot() {
    const status = this.getStatus(); // sweeps + builds the shared sections
    return {
      ...status,
      currentIndex: this.currentIndex,
      // live concurrent upstream calls across the pool → the Top "N LLM" line
      activeLLM: this.accounts.reduce((s, a) => s + (a._inflight || 0), 0),
      // D-2697: the live request stream for the Activity panel. The Map isn't
      // JSON-serializable → flatten to an array carrying the reqId; the viewer's
      // watch loop rebuilds the Map the TUI's Activity render reads. `log` is
      // already the {t,msg} shape the render consumes. Empty in interactive mode
      // (the TUI tracks its own active/log there); populated when headless.
      active: [...this._active.entries()].map(([id, r]) => ({ id, ...r })),
      log: this._log,
      fleet: this.fleetRows(),
      // Map<bareSid,{account,lastActiveAt}> isn't JSON-serializable — flatten to
      // a plain object; the viewer's DeckSnapshotSource rebuilds the Map.
      ledgerBySid: Object.fromEntries(this.ledgerBySid()),
    };
  }
}

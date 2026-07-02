import { refreshAccessToken, isTokenExpiringSoon } from './oauth.js';
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir, totalmem, freemem, loadavg, cpus, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

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

// Real CPU-busy % (100 − idle), from os.cpus() aggregate time deltas. The CPU
// gauge previously used the system LOAD AVERAGE (load/cores), which counts
// runnable+waiting threads — so it pegged red even when cores sat idle (a Mac
// at 60% idle still showed "100%"). This measures actual compute: busy =
// 1 − idleΔ/totalΔ between two consecutive snapshots. Cached 1s so multiple
// reads in one render tick reuse the same delta window; the first call (no
// prior sample) seeds from cumulative-since-boot. Returns 0..100, or null if
// cpus() is unavailable (caller keeps load average as the fallback display).
let _cpuPrev = null; // { idle, total } from the last cache-miss sample
let _cpuBusyCache = { at: 0, pct: null };
function _cpuBusyPct() {
  const now = Date.now();
  if (_cpuBusyCache.pct != null && now - _cpuBusyCache.at < 1000) return _cpuBusyCache.pct;
  let idle = 0, total = 0;
  try {
    for (const c of cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
  } catch {
    return null;
  }
  let pct;
  if (_cpuPrev) {
    const idleD = idle - _cpuPrev.idle;
    const totalD = total - _cpuPrev.total;
    pct = totalD > 0
      ? Math.max(0, Math.min(100, Math.round(100 * (1 - idleD / totalD))))
      : (_cpuBusyCache.pct ?? 0); // no tick elapsed — reuse last reading
  } else {
    // First call: cumulative-since-boot busy% — valid, just less responsive
    // until the next sample establishes a delta window.
    pct = total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
  }
  _cpuPrev = { idle, total };
  _cpuBusyCache = { at: now, pct };
  return pct;
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

// D-2697: wall-clock time string, byte-identical to tui.js's timestamp() so the
// server-side Activity ring renders the same as the interactive Deck's.
function _actTimestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

export class AccountManager {
  // D1DX — capacity-aware routing (D-2179). Max OAuth accounts send NO rate-limit
  // headers (anthropic-ratelimit-unified-*), so the prior pace-to-line model ran
  // blind. The model is now reactive with an optional header refinement:
  //   • SELECT: session-sticky (per-account prompt cache) + least-in-flight spread.
  //   • THROTTLE: a 429 benches the account on an ESCALATING ladder keyed to the
  //     consecutive-429 streak (reset on any success) — a real cap stops being
  //     re-probed every 60s; a header retry-after / known reset overrides it.
  //   • CAPACITY: per-account rolling 5h/7d burn + a learned cap (EMA of burn at
  //     the first 429 of each streak) → forward headroom, published via
  //     computeCapacity() so orchestrators gate launches instead of saturating.
  // switchThreshold (0.98) stays as the header-path hard ceiling when headers exist.
  constructor(accounts, switchThreshold = 0.98, opts = {}) {
    this.accounts = accounts.map((acct, index) => ({
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
      _429streak: 0,       // consecutive 429s (drives the escalating backoff ladder)
      _lastBenchSec: 0,    // last bench duration in seconds (display + capacity)
      _burn: null,         // Map(hourEpoch → tokens) — rolling burn buckets (≤168 = 7d)
      _capEst5h: null,     // learned 5h cap: EMA of burn5h at the first 429 of each streak
      _proven: false,      // D-2104 probe-gate: returned a 200 in this active spell? unproven → in-flight cap 1
    }));
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

    // Pace controller knobs. fiveHourSoftCeiling = never-stall rail (control law
    // #1, TOP priority): an account at/over this 5h utilization takes no new load.
    // farOverLineThreshold = control law #6: a warm session is rebound for pacing
    // ONLY when its account is this far past its weekly line (cache yields late).
    this.fiveHourSoftCeiling  = opts.fiveHourSoftCeiling  ?? 0.90;
    // Graduated 5h admission (D-2104): a proven account whose 5h-utilization is in
    // the warn band [fiveHourWarnCeiling, fiveHourSoftCeiling) drops to an in-flight
    // cap of 1 — it drains one-at-a-time instead of taking a burst, so its 5h
    // header updates between requests and it gets excluded (≥ soft ceiling) before
    // a burst overshoots into a 429. Below the warn ceiling → full cap.
    this.fiveHourWarnCeiling  = opts.fiveHourWarnCeiling  ?? 0.75;
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

    // ── 429 handling: escalating backoff (D-2179) ──
    // A 429 with a server retry-after (or a known unified reset) benches until that
    // instant. Header-blind (the Max OAuth norm), it benches on an escalating ladder
    // keyed to consecutive 429s: backoffBaseSec * backoffFactor^(streak-1), capped at
    // backoffCapSec, + de-sync jitter. Any success resets the streak — so a transient
    // 429 recovers fast while a genuine cap stops being re-probed every 60s.
    this.backoffBaseSec     = opts.backoffSec         ?? 60;   // streak-1 bench
    this.backoffFactor      = opts.backoffFactor      ?? 4;    // ×per consecutive 429
    this.backoffCapSec      = opts.backoffCapSec      ?? 900;  // ladder ceiling (15m)
    this.allThrottledCapSec = opts.allThrottledCapSec ?? 600;  // client retry-after cap
    this.backoffJitterSec   = opts.backoffJitterSec   ?? this.backoffBaseSec; // de-sync spread (0 = deterministic)

    // ── Capacity model (D-2179) ──
    // Per-account hourly burn buckets (≤168 = 7d) feed a learned 5h cap (EMA of
    // burn5h at the first 429 of each streak). headroom is published below the
    // learned cap by capSoftCeiling; concurrency by softConcurrencyPerAccount.
    this.capEmaAlpha               = opts.capEmaAlpha               ?? 0.3;
    this.capSoftCeiling            = opts.capSoftCeiling            ?? 0.75;
    this.softConcurrencyPerAccount = opts.softConcurrencyPerAccount ?? 3;

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
  getActiveAccount(opts = {}) {
    this._sweepAll();
    const current = this.accounts[this.currentIndex];
    // Sticky while the current account is usable; otherwise (re)pick the
    // least-loaded usable account. First-ever call always picks.
    if (this._didBootSelect && current && this._isUsable(current) && this._fiveHourEligible(current)
        && !this._apikeyShouldYield(current)) {
      return current; // stay cache-warm (until it nears its 5h ceiling — never-stall)
    }
    this._didBootSelect = true;
    const chosen = this._pickAccountForBinding(opts);
    if (chosen) this._switchTo(chosen, `account "${chosen.name}" (pace: behind weekly line)`);
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
  getAccountForSession(sessionId, opts = {}) {
    this._sweepAll();
    this._evictStaleBindings();
    if (!sessionId) return this.getActiveAccount(opts);

    const now = Date.now();
    const b = this.sessionBindings.get(sessionId);
    if (b) {
      const acct = this.accounts[b.index];
      const warm = now - b.lastUsedAt < this.cacheAffinityWindowMs;
      // Stay put while warm AND safe AND not far past the weekly line. Rebind on:
      // a blocker / hard-cap, the 5h never-stall rail (control law #1), or being
      // far over the weekly line (control law #6 — cache yields ONLY then; normal
      // over-pace doesn't churn a warm session).
      const farOverLine = acct ? this._paceGap(acct) < -this.farOverLineThreshold : false;
      if (acct && warm && !this._isBlocked(acct) && !this._atHardLimit(acct)
          && this._fiveHourEligible(acct) && !farOverLine
          && !this._apikeyShouldYield(acct)) {
        b.lastUsedAt = now;
        return acct;
      }
    }

    // (Re)bind: no binding, window lapsed, or bound account blocked/capped.
    const chosen = this._pickAccountForBinding(opts);
    if (!chosen) return null; // genuinely exhausted — server returns an honest 429

    const prevIdx = b?.index;
    const stillWarm = b && now - b.lastUsedAt < this.cacheAffinityWindowMs;
    const reason = !b ? 'new session'
      : !stillWarm ? 'window lapsed'
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

  // ── Pace-to-weekly-line helpers (D-2104, real-data) ──────────────────
  // Expected weekly utilization right now: fraction of the account's own 7d
  // window elapsed. Window = [reset-7d, reset]; line = 1 - timeLeft/7d. A null
  // reset (not yet observed) → line 0, so the account reads as "behind" and gets
  // traffic that then populates its headers (self-priming).
  _paceLine(account) {
    const reset = account.quota.unified7dReset;
    if (!reset) return 0;
    const weekMs = 7 * 24 * 3600 * 1000;
    const elapsed = 1 - (reset - Date.now()) / weekMs;
    return Math.max(0, Math.min(1, elapsed));
  }

  // How far BEHIND its weekly line the account is. >0 = behind (wants more load);
  // <0 = ahead (over-pace). Unknown utilization → treated as 0 used (behind).
  _paceGap(account) {
    const used = account.quota.unified7d ?? 0;
    return this._paceLine(account) - used;
  }

  // Never-stall rail (control law #1, TOP priority): an account at/over its 5h
  // soft ceiling — or server-flagged `rejected` — takes NO new load. Note: the
  // `allowed_warning` status is NOT a trigger on its own (≈24% of normal requests
  // carry it); the 5h utilization number is.
  _fiveHourEligible(account) {
    const q = account.quota;
    if (q.unifiedStatus === 'rejected') return false;
    if (q.unified5h != null && q.unified5h >= this.fiveHourSoftCeiling) return false;
    return true;
  }

  // Graduated in-flight cap for new binds (D-2104):
  //   unproven (no 200 this spell) → 1 (probe-gate);
  //   proven but in the 5h warn band [warnCeiling, softCeiling) → 1 (slow-drain,
  //     so a near-cap account can't take a burst that overshoots before its header
  //     updates and the 5h rail excludes it);
  //   proven with ample 5h headroom → maxInflightPerAccount.
  _inflightCapFor(account) {
    if (!account._proven) return 1;
    const u5h = account.quota.unified5h;
    if (u5h != null && u5h >= this.fiveHourWarnCeiling) return 1;
    return this.maxInflightPerAccount;
  }

  // End-of-cycle ramp (control law #3): as the account nears its 7d-reset, escalate
  // preference to drain unused weekly quota before it resets (use-it-or-lose-it).
  // Boost = unusedWeeklyFraction × tierWeight(hoursToReset). 0 outside all tiers.
  _rampBoost(account) {
    const reset = account.quota.unified7dReset;
    if (!reset) return 0;
    const hoursToReset = (reset - Date.now()) / 3600000;
    if (hoursToReset < 0) return 0;
    let weight = 0;
    for (const tier of this.rampTiers) {            // ascending by hours
      if (hoursToReset <= tier.hours) { weight = tier.weight; break; }
    }
    if (!weight) return 0;
    const unused = Math.max(0, 1 - (account.quota.unified7d ?? 0));
    return unused * weight;
  }

  // Selection score: behind-line gap + end-of-cycle ramp. Highest wins.
  _paceScore(account) {
    return this._paceGap(account) + this._rampBoost(account);
  }

  // ── Capacity model helpers (D-2179) ──────────────────
  // Per-account hourly burn buckets: Map(hourEpoch → tokens), pruned to 7d. Cheap
  // (≤168 entries) and the only forward signal we have when Max OAuth sends no
  // rate-limit headers — the learned cap is derived from these at 429 time.
  _recordBurn(account, tokens) {
    if (!account || !tokens) return;
    const hr = Math.floor(Date.now() / 3600000);
    if (!account._burn) account._burn = new Map();
    account._burn.set(hr, (account._burn.get(hr) || 0) + tokens);
    const cutoff = hr - 168; // keep 7d
    for (const k of account._burn.keys()) if (k < cutoff) account._burn.delete(k);
  }

  // Sum of burn (tokens) over the last `hours` whole-hour buckets.
  _burnWindow(account, hours) {
    if (!account || !account._burn) return 0;
    const cutoff = Math.floor(Date.now() / 3600000) - hours;
    let sum = 0;
    for (const [k, v] of account._burn) if (k >= cutoff) sum += v;
    return sum;
  }

  /**
   * Pick the account to (re)bind a session to (D-2104 pace controller).
   * Layered eligibility — each set falls back to the prior so we never refuse
   * while any usable account exists (a truly exhausted pool yields null via
   * _soonestUsableOrNull at the top):
   *   1. usable (not blocked, under the 0.98 hard ceiling);
   *   2. 5h never-stall rail — below the 5h soft ceiling;
   *   3. graduated in-flight cap (_inflightCapFor) — 1 while UNPROVEN (probe-gate)
   *      or in the 5h warn band, opening to maxInflightPerAccount only when proven
   *      with ample 5h headroom; so we never pile onto an unconfirmed or near-cap
   *      account, and a near-cap account drains one-at-a-time without overshooting;
   *   4. session cap — under maxSessionsPerAccount bound warm sessions.
   * Then within the surviving pool, a PACE TIE-BAND: accounts within paceTieBand
   * of the best paceScore are "equally behind" → spread a concurrent burst across
   * them by load (fewest warm sessions, then fewest in-flight) instead of
   * dogpiling the single best. A clearly-leading account (genuinely most-behind,
   * or ramping near its reset) sits alone in the band and still concentrates load
   * — bounded by the caps so it drains without 429ing.
   */
  _pickAccountForBinding({ allowApikey = false } = {}) {
    const usableAll = this.accounts.filter(a => this._isUsable(a));
    if (usableAll.length === 0) return this._soonestUsableOrNull();
    // D1DX (D-2182): apikey accounts are a STRICT last resort. An apikey has no
    // weekly line → flat-0 paceScore, which otherwise beats any OAuth account a
    // hair over its pace-line (negative score) and parks PAID traffic while healthy
    // Max headroom sits idle. OAuth is always preferred.
    //
    // D1DX (D-2420): the apikey is gated behind the all-throttled HOLD. When every
    // OAuth account is throttled, normal binding (allowApikey=false) returns null
    // so the server HOLDS and polls for an OAuth account to recover, instead of
    // burning the PAID key on a transient header-less 429 (clears in ~60-140s).
    // Only the hold-loop's last-resort attempt (server.js, after the max wait
    // elapses or the pool is genuinely hard-capped) passes allowApikey=true to
    // admit the apikey. _apikeyShouldYield still migrates a session off the apikey
    // the moment an OAuth account recovers.
    const oauthUsable = usableAll.filter(a => a.type !== 'apikey');
    let usable;
    if (oauthUsable.length) usable = oauthUsable;        // OAuth available → use it
    else if (allowApikey) usable = usableAll;            // last resort → admit apikey
    else return null;                                    // only apikey usable, not yet allowed → HOLD
    const { counts } = this._activeSessionCounts();
    const fiveHourOk = usable.filter(a => this._fiveHourEligible(a));
    const base = fiveHourOk.length ? fiveHourOk : usable;
    // Probe-gate + graduated 5h cap: 1 while unproven, 1 in the 5h warn band,
    // maxInflightPerAccount when proven with ample headroom (see _inflightCapFor).
    const underCap = base.filter(a => (a._inflight || 0) < this._inflightCapFor(a));
    const capped = underCap.length ? underCap : base;
    // Hard session cap (instances limit) — a burst spills beyond maxSessionsPerAccount.
    const underSession = capped.filter(a => (counts[a.index] || 0) < this.maxSessionsPerAccount);
    const pool = underSession.length ? underSession : capped;
    const best = pool.reduce((m, a) => Math.max(m, this._paceScore(a)), -Infinity);
    const band = pool.filter(a => best - this._paceScore(a) <= this.paceTieBand);
    return band.reduce((b, a) => {
      const ca = counts[a.index] || 0, cb = counts[b.index] || 0;
      if (ca !== cb) return ca < cb ? a : b;
      return (a._inflight || 0) < (b._inflight || 0) ? a : b;
    }, band[0]);
  }

  // D1DX (D-2182): true when `account` is the apikey last-resort AND at least one
  // OAuth account is usable right now — so a session sitting on the paid apikey
  // (from an OAuth-outage window) should yield back to Max. Gates the two sticky
  // paths so apikey use never outlives the OAuth recovery.
  _apikeyShouldYield(account) {
    if (!account || account.type !== 'apikey') return false;
    return this.accounts.some(a => a.type !== 'apikey' && this._isUsable(a));
  }

  // D1DX (D-2420): is there a usable apikey account to fall back to as the genuine
  // last resort? The server's all-throttled HOLD loop checks this before firing the
  // paid key (at the deadline, or immediately when the OAuth pool is hard-capped).
  hasUsableApikey() {
    return this.accounts.some(a => a.type === 'apikey' && this._isUsable(a));
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

  // D-2286: atomic dispatch probe-gate. Checks the account against its GRADUATED cap
  // (_inflightCapFor: 1 while UNPROVEN/just-recovered → exactly ONE probe in flight,
  // opening to maxInflightPerAccount once a 200 proves headroom) and reserves the slot
  // in the SAME synchronous step. Single-threaded JS makes the check+increment atomic,
  // so a concurrent recovery herd can't all pass while _inflight is still 0 (the TOCTOU
  // that let 7+ requests pile onto one just-recovered account and burst-429 it — the
  // 06-15 cascade). server.js calls this at dispatch instead of the bind-time filter
  // (which races) + a separate noteInflightStart (which doesn't gate). Returns true if
  // a slot was reserved — caller MUST pair it with noteInflightEnd — or false if the
  // account is at its graduated cap (caller holds for a slot, preserving affinity).
  tryReserveInflight(accountIndex) {
    const a = this.accounts[accountIndex];
    if (!a) return false;
    if ((a._inflight || 0) >= this._inflightCapFor(a)) return false;
    a._inflight = (a._inflight || 0) + 1;
    return true;
  }

  // D-2226: is this account at/over its HARD in-flight cap? server.js uses this to
  // briefly HOLD a warm-stuck request until one of the account's own in-flight
  // slots frees — preserving cache-affinity — instead of piling on (→ burst-429)
  // or churning the warm session onto another account. New binds already exclude
  // at-cap accounts via _inflightCapFor; this guards the warm-stick + all-at-cap
  // fallback paths that bypass that filter and reach the dispatcher directly.
  atInflightCap(accountIndex) {
    const a = this.accounts[accountIndex];
    return !!a && (a._inflight || 0) >= this.maxInflightPerAccount;
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
      cpuBusyPct: _cpuBusyPct(), // D-2173: actual CPU utilization (the gauge driver); load avg kept as secondary text
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
      // D-2179: restore per-account usage + capacity model (v2, keyed by name;
      // absent in a v1 file → skipped). The 429 streak is NOT persisted — a cold
      // boot has no recent 429s, so resetting it to 0 is correct.
      const accounts = (data && typeof data.accounts === 'object') ? data.accounts : null;
      if (accounts) {
        const hr = Math.floor(Date.now() / 3600000);
        for (const a of this.accounts) {
          const s = accounts[a.name];
          if (!s) continue;
          if (s.usage) {
            a.usage.totalInputTokens  = s.usage.totalInputTokens  || 0;
            a.usage.totalOutputTokens = s.usage.totalOutputTokens || 0;
            a.usage.totalRequests     = s.usage.totalRequests     || 0;
            a.usage.totalCost         = s.usage.totalCost         || 0;
            a.usage.lastUsed          = s.usage.lastUsed          || null;
          }
          if (Array.isArray(s.burn) && s.burn.length) {
            a._burn = new Map(s.burn.filter(([k]) => k >= hr - 168)); // re-prune to 7d
          }
          if (s.capEst5h != null) a._capEst5h = s.capEst5h;
        }
      }
    } catch { /* missing/corrupt → start empty */ }
    this._pruneLedger();
  }

  // Atomic save (tmp + rename) so a crash mid-write can't corrupt the ledger.
  saveLedger() {
    if (!this.ledgerPath) return;
    try {
      const entries = [...this.usageLedger.values()];
      // D-2179: per-account durable state (cumulative usage + capacity model),
      // keyed by name so it survives an account reorder across restarts.
      const accounts = {};
      for (const a of this.accounts) {
        accounts[a.name] = {
          usage: { ...a.usage },
          burn: a._burn ? [...a._burn] : [],
          capEst5h: a._capEst5h ?? null,
        };
      }
      const tmp = this.ledgerPath + '.tmp';
      writeFileSync(tmp, JSON.stringify({ version: 2, savedAt: Date.now(), entries, accounts }), { mode: 0o600 });
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

    // D-2236: never store a reset timestamp already in the past. At a window
    // boundary Anthropic can briefly report a <=now reset; storing it makes
    // _clearExpiredQuotas re-log "session quota reset" on EVERY subsequent sweep
    // (it only nulls the window, but the next response re-populates the passed
    // reset) — and because the TUI patches console.log -> _addLog -> render() ->
    // computeCapacity() -> _sweepAll(), that storm recurses into a stack overflow.
    // A passed reset means the window has rolled: clear util + reset so the next
    // response repopulates a live (future-dated) window instead.
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

    // D-2179: feed the rolling burn buckets (capacity model). Count the billable
    // load that pushes toward the rate limit — uncached input + cache writes +
    // output; cache reads are ~free, so they're excluded.
    this._recordBurn(account,
      (inputTokens || 0) + (opts.cacheCreate5m || 0) + (opts.cacheCreate1h || 0) + (outputTokens || 0));

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

    // D-2286: concurrent-burst debounce. If this account is ALREADY benched from
    // this cycle (throttled, time remaining), a 429 arriving now is a sibling of the
    // same concurrent burst — NOT a fresh post-recovery probe failure. Incrementing
    // the streak per in-flight 429 is what drove 60s→4m→15m in 3 seconds and the
    // false all-throttled cascade (06-15, D-2286 forensic). Keep the existing bench:
    // don't increment the streak, don't re-bench, don't re-log. A genuine SEQUENTIAL
    // failure still escalates — by then the bench has expired and _sweepAll flipped
    // status back to 'active', so this guard passes. A server retry-after still
    // EXTENDS the bench when it's longer than what we already hold.
    if (account.status === 'throttled' && account.rateLimitedUntil > now) {
      account._proven = false;
      if (retryAfterSeconds != null && !isNaN(retryAfterSeconds)) {
        const until = now + Math.min(retryAfterSeconds * 1000, this.backoffCapSec * 1000);
        if (until > account.rateLimitedUntil) {
          account.rateLimitedUntil = until;
          account._lastBenchSec = Math.round((until - now) / 1000);
        }
      }
      return;
    }

    account._429streak = (account._429streak || 0) + 1;
    account._proven = false; // D-2104 probe-gate: a 429 un-proves it → re-probe with 1 on recovery

    // D-2179: learn this account's 5h cap from the burn at the FIRST 429 of a
    // streak (the moment it hit the wall). EMA across cap events; later 429s in the
    // same streak don't re-teach (burn keeps climbing while benched-then-probed).
    if (account._429streak === 1) {
      const burn5h = this._burnWindow(account, 5);
      if (burn5h > 0) {
        account._capEst5h = account._capEst5h == null
          ? burn5h
          : account._capEst5h * (1 - this.capEmaAlpha) + burn5h * this.capEmaAlpha;
      }
    }

    const capMs = this.backoffCapSec * 1000;
    let baseMs, why, isBurst = false;
    if (retryAfterSeconds != null && !isNaN(retryAfterSeconds)) {
      baseMs = Math.min(retryAfterSeconds * 1000, capMs);          // server told us exactly
      why = 'retry-after';
    } else {
      // D-2226: classify the header-less 429 by WHICH limit axis is actually hot.
      // A 429 while utilization sits well below the hard ceiling is a BURST /
      // concurrency limit (clears in seconds) — NOT quota exhaustion — so bench it
      // on the short escalating ladder, not to the window reset. Only bench-to-reset
      // when the account is genuinely AT a cap (5h ≥ soft ceiling, weekly ≥ hard
      // ceiling, or the server flagged unified-status `rejected`): there the reset
      // IS the soonest real recovery. Benching a transient burst to the always-far
      // reset (clamped to backoffCapSec) is what sidelined a half-full account for
      // 15 minutes and drove the false "all-throttled" cascade.
      const u5h = account.quota.unified5h;
      const u7d = account.quota.unified7d;
      const nearCap = account.quota.unifiedStatus === 'rejected'
        || (u5h != null && u5h >= this.fiveHourSoftCeiling)
        || (u7d != null && u7d >= this.switchThreshold);
      const resets = [account.quota.unified5hReset, account.quota.unified7dReset].filter(Boolean);
      const reset = resets.length ? Math.min(...resets) : null;
      if (nearCap && reset && reset > now) {
        baseMs = Math.min(reset - now, capMs);            // genuine quota cap → wait for the reset
        why = 'quota-reset';
      } else {
        // Header-blind burst (the Max OAuth norm): escalating ladder by consecutive
        // 429s. Any success resets the streak (noteAccountSuccess), so a transient
        // burst recovers in ~backoffBaseSec while a persistent one escalates.
        // D-2286: FULL JITTER (AWS "Exponential Backoff and Jitter") — spread the
        // bench across [base, ladder] so simultaneously-benched accounts DON'T expire
        // together and re-form the synchronized recovery herd. The ladder ceiling
        // still grows with the streak; jitter only de-synchronizes WHEN each account
        // frees. backoffJitterSec === 0 keeps it deterministic (= ladder) for tests.
        const ladderMs = Math.min(this.backoffBaseSec * 1000 * this.backoffFactor ** (account._429streak - 1), capMs);
        if (this.backoffJitterSec > 0) {
          const floorMs = Math.min(this.backoffBaseSec * 1000, ladderMs);
          baseMs = floorMs + Math.random() * (ladderMs - floorMs);
        } else {
          baseMs = ladderMs;
        }
        why = `burst×${account._429streak}`;
        isBurst = true;
      }
    }
    // D-2286: retry-after + quota-reset keep the small additive de-sync jitter; a
    // burst already carries full jitter above, so don't double-jitter it.
    const jitterMs = isBurst ? 0 : Math.random() * this.backoffJitterSec * 1000;
    account.status = 'throttled';
    account.rateLimitedUntil = now + baseMs + jitterMs;
    account._lastBenchSec = Math.round((baseMs + jitterMs) / 1000);
    console.log(`[TeamClaude] Account "${account.name}" rate limited +${account._lastBenchSec}s (${why}, streak ${account._429streak})`);
    this._ledgerDirty = true; this._maybeSaveLedger(); // D-2179: persist the learned cap
  }

  /** A successful response on an account — reset its 429 streak (ends the ladder). */
  noteAccountSuccess(accountIndex) {
    const a = this.accounts[accountIndex];
    if (!a) return;
    if (a._429streak) { a._429streak = 0; a._lastBenchSec = 0; }
    a._proven = true; // D-2104 probe-gate: a 200 proves headroom → open the in-flight cap to maxInflightPerAccount
  }

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
    let secs = soonest === Infinity ? this.backoffBaseSec : (soonest - now) / 1000;
    secs = Math.max(this.backoffBaseSec, Math.min(this.allThrottledCapSec, secs));
    if (this.backoffJitterSec > 0) secs += Math.random() * secs * 0.15; // upward-only de-sync jitter
    return Math.max(1, Math.ceil(secs));
  }

  /** A successful upstream response — no all-throttled episode state to clear now. */
  noteSuccess() { /* no-op: simplified rails have no episode streak */ }

  /**
   * D-2179: capacity snapshot for orchestrators (served by GET /capacity +
   * `teamclaude capacity`). Header-blind by design — derives a verdict from live
   * state + the learned per-account cap, so a launcher gates worker spawns on real
   * pool headroom instead of saturating it. An account is "live" when it is not
   * benched, not errored/exhausted, not over the header hard ceiling, and not past
   * its learned soft cap. headroom = spare concurrent-session slots across the pool.
   */
  computeCapacity() {
    this._sweepAll();
    const now = Date.now();
    const accounts = this.accounts.map(a => {
      const benched = a.status === 'throttled' && a.rateLimitedUntil != null && now < a.rateLimitedUntil;
      const benchSec = benched ? Math.ceil((a.rateLimitedUntil - now) / 1000) : 0;
      const burn5h = this._burnWindow(a, 5);
      const cap = a._capEst5h ?? null;
      const headroomTok = cap != null ? Math.max(0, Math.round(cap * this.capSoftCeiling - burn5h)) : null;
      const nearCap = cap != null && burn5h >= cap * this.capSoftCeiling;
      const dead = a.status === 'error' || a.status === 'exhausted';
      return {
        name: a.name, status: a.status,
        benched, benchSec, streak: a._429streak || 0, inflight: a._inflight || 0,
        burn5h, capEst5h: cap, headroomTok, nearCap,
        live: !benched && !dead && !this._atHardLimit(a) && !nearCap,
      };
    });
    const live = accounts.filter(a => a.live);
    const benchedAll = accounts.filter(a => a.benched);
    const { active: warmSessions } = this._activeSessionCounts();
    const slotHeadroom = Math.max(0, live.length * this.softConcurrencyPerAccount - warmSessions);
    const soonestResetSec = benchedAll.length ? Math.min(...benchedAll.map(a => a.benchSec)) : 0;

    let verdict;
    if (live.length === 0) verdict = 'red';
    else if (benchedAll.length > 0 || accounts.some(a => a.streak >= 2) || slotHeadroom <= 1) verdict = 'yellow';
    else verdict = 'green';

    return {
      verdict,
      headroom: slotHeadroom,   // est. more concurrent sessions the pool can absorb now
      liveAccounts: live.length,
      benched: benchedAll.length,
      total: this.accounts.length,
      warmSessions,
      soonestResetSec,          // when the next benched account frees (RED scheduling)
      accounts,
      at: new Date(now).toISOString(),
    };
  }

  /**
   * True when EVERY account is at a genuine hard limit (the header path). Used by
   * the server hold-loop to stop holding a genuinely-capped pool. Folds the former
   * server.js local copy (the D-1741 TODO) into the class.
   */
  allHardCapped() {
    if (!this.accounts.length) return false;
    return this.accounts.every(a => this._atHardLimit(a));
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
      upstream: acctData.upstream || null,   // D-2655
      model: acctData.model || null,         // D-2655
      provider: acctData.provider || null,   // D-2655
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
   * D-2805: on-demand "mint" of the headroom OAuth accounts — start each
   * account's 5h window EARLY (the morning primer curls POST /teamclaude/warm).
   * Warms ONLY OAuth accounts under `threshold` weekly utilization, reusing
   * warmOne → ensureTokenFresh (the coalesced per-PROCESS refresh) so an expired
   * token is refreshed CLOBBER-SAFELY by the running proxy itself, never a second
   * process racing the shared token store into invalid_grant (D-2286). A capped
   * account is skipped (a warm can't help it until reset). Best-effort per
   * account; never throws. Returns a summary the caller serializes as JSON.
   */
  async warmHeadroom(threshold = 0.90, upstream = 'https://api.anthropic.com') {
    const minted = [];
    const skipped = [];
    for (const account of this.accounts) {
      if (account.type !== 'oauth') { skipped.push({ name: account.name, reason: 'not oauth' }); continue; }
      const u7 = account.quota?.unified7d;
      if (u7 != null && u7 >= threshold) {
        skipped.push({ name: account.name, reason: `weekly ${(u7 * 100).toFixed(0)}% ≥ ${(threshold * 100).toFixed(0)}% (capped)` });
        continue;
      }
      try {
        const status = await this.warmOne(account, upstream);
        minted.push({
          name: account.name,
          status,
          unified5h: account.quota?.unified5h ?? null,
          unified7d: account.quota?.unified7d ?? null,
        });
      } catch (err) {
        skipped.push({ name: account.name, reason: `warm error: ${err.message}` });
      }
    }
    console.log(`[TeamClaude] warmHeadroom(threshold=${threshold}): minted ${minted.length} (${minted.map((m) => m.name).join(', ') || '-'}), skipped ${skipped.length}`);
    return { threshold, minted, skipped };
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
    if (r) r.account = info.account;
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
        streak: a._429streak || 0,  // D1DX (D-2179): consecutive-429 ladder depth
        benchSec: (a.status === 'throttled' && a.rateLimitedUntil)
          ? Math.max(0, Math.ceil((a.rateLimitedUntil - Date.now()) / 1000)) : 0,
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

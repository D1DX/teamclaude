import { importCredentials, fetchProfile } from './oauth.js';
import { resolveLogDir, appendOpLog } from './oplog.js';
import { modelEffortTag } from './model.js';
import { execSync } from 'node:child_process';

// Deck render helpers (ANSI / width / bar / fmt) live in deck/render-util.js.
import {
  SPINNER, ESC,
  bold, dim, green, yellow, red, cyan, gray,
  vw, dw, padW, rpad, fitLine,
  bar, timestamp,
  fmtN, fmtDur, fmtCost,
  FIVE_H_MS, SEVEN_D_MS,
} from './deck/render-util.js';

// ── TUI class ────────────────────────────────────────────────

export class TUI {
  constructor({ accountManager, config, saveConfig, syncAccounts, onQuit, readOnly = false }) {
    this.am = accountManager;
    this.config = config;
    this.saveConfig = saveConfig;
    this.syncAccounts = syncAccounts;
    this.onQuit = onQuit;
    // D-2485: read-only viewer (`teamclaude watch`). When true the Deck renders
    // a polled snapshot of a SEPARATE running proxy — it owns no AccountManager,
    // no server, no config to mutate. Mutation keys (s/r/a/R) are disabled, the
    // console-capture patch is skipped (no server log stream to absorb), and a
    // WATCH / connection banner is shown. activeLLM + connState are pushed in by
    // the watch driver each poll.
    this.readOnly = !!readOnly;
    this.activeCount = null;                 // D-2485: snapshot in-flight count (Top "N LLM")
    this.connState = { ok: true, msg: '' };  // D-2485: watch poll connection state

    this.log = [];           // completed activity entries
    this.active = new Map(); // in-flight requests
    this.mode = 'normal';    // normal | select | add | input
    this.selAction = null;   // switch | remove
    this.selIdx = 0;
    this.inputPrompt = '';
    this.inputBuf = '';
    this.inputCb = null;
    this.frame = 0;
    this.running = false;
    this.timer = null;
    this._origLog = null;
    this._origErr = null;
    // D-1680: durable sink for the operational stream (see oplog.js).
    this.logDir = resolveLogDir(config);
    // D-1728 S8: throttled per-instance mem/cpu sampler (ps on session pids).
    this._psAt = 0;
    this._psMap = {};
    // D-1739: By-issue expand toggle ([i]) — collapsed caps at 8 rows.
    this.byIssueExpanded = false;
  }

  // D-1728 S8: sample per-process RSS + CPU for the given pids, at most every 3s
  // (the render loop runs every 500ms — ps must not run on every frame).
  _samplePs(pids) {
    const now = Date.now();
    if (now - this._psAt < 3000 || pids.length === 0) return this._psMap;
    this._psAt = now;
    const map = {};
    try {
      const out = execSync(`ps -o pid=,rss=,pcpu= -p ${pids.join(',')}`, { encoding: 'utf-8', timeout: 1000 });
      for (const ln of out.trim().split('\n')) {
        const m = ln.trim().split(/\s+/);
        if (m.length >= 3) map[m[0]] = { rssMB: Math.round(+m[1] / 1024), cpu: +m[2] };
      }
    } catch { /* ps unavailable */ }
    this._psMap = map;
    return map;
  }

  // ── lifecycle ──────────────────────────────────────

  start() {
    this.running = true;
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    this._dataHandler = d => this._onData(d);
    this._resizeHandler = () => this.render();
    process.stdin.on('data', this._dataHandler);
    process.stdout.on('resize', this._resizeHandler);

    // Redirect console to activity log. D-2485: skip in read-only watch mode —
    // there is no server console stream to absorb, and hijacking console.error
    // would swallow the watch driver's own poll-error reporting.
    if (!this.readOnly) {
      this._origLog = console.log;
      this._origErr = console.error;
      console.log = (...a) => this._addLog(a.join(' '));
      console.error = (...a) => this._addLog(a.join(' '));
    }

    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.render();
    }, 500);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._origLog) { console.log = this._origLog; console.error = this._origErr; }
    // D-2485: guard against stop() before start() (the listeners aren't installed
    // yet) so the read-only viewer can quit safely on any path.
    if (this._dataHandler) process.stdin.removeListener('data', this._dataHandler);
    if (this._resizeHandler) process.stdout.removeListener('resize', this._resizeHandler);
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
  }

  // ── server hooks ───────────────────────────────────

  onRequestStart(id, info) {
    this.active.set(id, { ...info, t: timestamp(), started: Date.now(), account: null });
    this.render();
  }

  onRequestRouted(id, info) {
    const r = this.active.get(id);
    if (r) {
      r.account = info.account;
      // DL-2785 data: carry the parsed model + effort on the live request record
      // for the model·effort Activity tag (rendered on spinner rows + log lines).
      if (info.model != null) r.model = info.model;
      if (info.effort != null) r.effort = info.effort;
    }
  }

  onRequestEnd(id, info) {
    const r = this.active.get(id);
    this.active.delete(id);
    const dur = r ? ((Date.now() - r.started) / 1000).toFixed(1) : '?';
    const acct = info.account || r?.account || '?';
    // DL-2785: the model·effort tag rides the completed log line too.
    const tag = modelEffortTag(r?.model, r?.effort);
    // D1DX (D-1728): routine 2xx request lines stay in the live Activity pane only;
    // only non-2xx (errors / 429) persist to the daily log. Keeps the file minimal.
    this._addLog(`${info.method} ${info.path}${tag ? ' ' + tag : ''} → ${acct} (${info.status}, ${dur}s)`, info.status >= 400);
  }

  _addLog(msg, persist = true) {
    msg = msg.replace(/^\[TeamClaude\]\s*/, '');
    if (persist) appendOpLog(this.logDir, msg); // D-1680: durable daily file; D-1728: signal-only
    this.log.unshift({ t: timestamp(), msg });
    if (this.log.length > 200) this.log.length = 200;
    // D-2236: re-entrancy guard. console.log/error are patched (start()) to route
    // here, and render() calls am.computeCapacity() -> _sweepAll() which can emit a
    // console.log (e.g. a quota reset). Without this guard that nested log re-enters
    // _addLog -> render() -> ... until the stack overflows (RangeError). The buffer
    // is already updated above; the in-flight render paints it and the 500ms timer
    // repaints regardless, so skipping the nested render loses nothing. try/finally
    // so a render() throw can never wedge the Deck into a permanent no-render state.
    if (this.running && !this._rendering) {
      this._rendering = true;
      try { this.render(); } finally { this._rendering = false; }
    }
  }

  // ── input handling ─────────────────────────────────

  _onData(d) {
    if (d === '\x1b[A') return this._key('up');
    if (d === '\x1b[B') return this._key('down');
    if (d === '\x1b') return this._key('esc');
    if (d === '\r' || d === '\n') return this._key('enter');
    if (d === '\x03') return this._key('ctrl-c');
    if (d === '\x7f' || d === '\x08') return this._key('bs');
    if (d.length === 1 && d >= ' ') return this._key(d);
  }

  _key(k) {
    if (k === 'ctrl-c') { this.stop(); this.onQuit?.(); return; }

    switch (this.mode) {
      case 'normal': this._keyNormal(k); break;
      case 'select': this._keySelect(k); break;
      case 'add':    this._keyAdd(k); break;
      case 'input':  this._keyInput(k); break;
    }
    this.render();
  }

  _keyNormal(k) {
    // D-2485: read-only watch viewer — only quit + the harmless view toggles.
    // Account mutation (s/r/a) + config reload (R) are disabled; the viewer owns
    // no AccountManager/config to change.
    if (this.readOnly) {
      if (k === 'q') { this.stop(); this.onQuit?.(); }
      else if (k === 'b') {
        this.bell = this.bell === false;
        this._addLog('Alert bell ' + (this.bell === false ? 'muted' : 'on'));
      }
      else if (k === 'i') {
        this.byIssueExpanded = !this.byIssueExpanded;
        if (this.running) this.render();
      }
      return;
    }
    if (k === 'q') { this.stop(); this.onQuit?.(); }
    else if (k === 's' && this.am.accounts.length > 0) {
      this.mode = 'select'; this.selAction = 'switch'; this.selIdx = this.am.currentIndex;
    }
    else if (k === 'r' && this.am.accounts.length > 0) {
      this.mode = 'select'; this.selAction = 'remove'; this.selIdx = 0;
    }
    else if (k === 'a') { this.mode = 'add'; }
    else if (k === 'R') { this._doSync(); }
    else if (k === 'b') { // D-1739: mute/unmute the alert bell (in-view flag stays)
      this.bell = this.bell === false;
      this._addLog('Alert bell ' + (this.bell === false ? 'muted' : 'on'));
    }
    else if (k === 'i') { // D-1739: expand/collapse the By-issue list
      this.byIssueExpanded = !this.byIssueExpanded;
      if (this.running) this.render();
    }
  }

  _keySelect(k) {
    const len = this.am.accounts.length;
    if (k === 'up' || k === 'k') this.selIdx = Math.max(0, this.selIdx - 1);
    else if (k === 'down' || k === 'j') this.selIdx = Math.min(len - 1, this.selIdx + 1);
    else if (k === 'enter') {
      if (this.selAction === 'switch') {
        this.am.currentIndex = this.selIdx;
        this._addLog(`Switched to "${this.am.accounts[this.selIdx].name}"`);
      } else {
        this._doRemove(this.selIdx);
      }
      this.mode = 'normal';
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _keyAdd(k) {
    if (k === 'i') { this._doImport(); this.mode = 'normal'; }
    else if (k === 'k') {
      this.mode = 'input';
      this.inputPrompt = 'API key';
      this.inputBuf = '';
      this.inputCb = v => { if (v) this._doAddKey(v); };
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _keyInput(k) {
    if (k === 'enter') {
      const cb = this.inputCb;
      const v = this.inputBuf;
      this.mode = 'normal'; this.inputCb = null; this.inputBuf = '';
      cb?.(v);
    }
    else if (k === 'esc') { this.mode = 'normal'; this.inputCb = null; this.inputBuf = ''; }
    else if (k === 'bs') { this.inputBuf = this.inputBuf.slice(0, -1); }
    else if (k.length === 1) { this.inputBuf += k; }
  }

  // ── account operations ─────────────────────────────

  async _doSync() {
    try {
      const count = await this.syncAccounts();
      if (count > 0) {
        this._addLog(`Synced ${count} new account(s) from config`);
      } else {
        this._addLog('Config reloaded, credentials refreshed');
      }
    } catch (e) {
      this._addLog(`Sync failed: ${e.message}`);
    }
  }

  async _doImport() {
    try {
      this._addLog('Importing credentials...');
      const creds = await importCredentials('~/.claude/.credentials.json');
      const profile = await fetchProfile(creds.accessToken);
      const profileOk = profile && !profile.error;

      if (!profileOk) {
        this._addLog(`Warning: could not fetch profile — ${profile?.error || 'no token'}`);
      }

      let name;
      if (profile?.email) {
        name = profile.email;
        const tier = profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : null;
        if (tier) this._addLog(`Detected Claude ${tier}: ${name}`);
      } else {
        const n = this.config.accounts.filter(a => a.name.startsWith('account-')).length + 1;
        name = `account-${n}`;
      }

      const entry = {
        name, type: 'oauth', source: 'import',
        accountUuid: profile?.accountUuid || null,
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
      };

      // Deduplicate: match by UUID first, then by name
      let idx = profile?.accountUuid
        ? this.config.accounts.findIndex(a => a.accountUuid === profile.accountUuid)
        : -1;
      if (idx < 0) idx = this.config.accounts.findIndex(a => a.name === name);

      if (idx >= 0) {
        this.config.accounts[idx] = entry;
        // Update the running account manager entry
        const amAcct = this.am.accounts[idx];
        if (amAcct) {
          amAcct.credential = creds.accessToken;
          amAcct.refreshToken = creds.refreshToken;
          amAcct.expiresAt = creds.expiresAt;
          amAcct.accountUuid = entry.accountUuid;
          amAcct.name = name;
          if (amAcct.status === 'error') amAcct.status = 'active';
        }
        this._addLog(`Updated account "${name}"`);
      } else {
        this.config.accounts.push(entry);
        this.am.addAccount(entry);
        this._addLog(`Imported account "${name}"`);
      }

      await this.saveConfig(this.config);
    } catch (e) {
      this._addLog(`Import failed: ${e.message}`);
    }
  }

  async _doAddKey(apiKey) {
    const n = this.config.accounts.filter(a => a.name.startsWith('api-')).length + 1;
    const name = `api-${n}`;
    this.config.accounts.push({ name, type: 'apikey', apiKey });
    this.am.addAccount({ name, type: 'apikey', apiKey });
    await this.saveConfig(this.config);
    this._addLog(`Added API key account "${name}"`);
  }

  async _doRemove(idx) {
    if (idx < 0 || idx >= this.am.accounts.length) return;
    const name = this.am.accounts[idx].name;
    this.am.removeAccount(idx);
    this.config.accounts.splice(idx, 1);
    if (this.selIdx >= this.am.accounts.length) this.selIdx = Math.max(0, this.am.accounts.length - 1);
    await this.saveConfig(this.config);
    this._addLog(`Removed account "${name}"`);
  }

  // ── rendering ──────────────────────────────────────

  // D-1820: factor the proxy/system line into its own method so child C can add
  // threshold coloring inside here without touching the Top section layout.
  // Returns the line STRING (leading space + gray content) or null when sys is falsy.
  // D-1820 Req 3: threshold-color RAM%, load, and issues segment; gray scaffolding preserved.
  // D-2169: visual proxy/host health panel — gauge bars for RAM + CPU-load (the
  // existing bar() helper colors green<0.7 / yellow<0.9 / red≥0.9), plus a proxy
  // summary line. Returns an array of rendered lines (or [] when sys is falsy).
  _healthPanel(sys) {
    if (!sys) return [];
    const gb = mb => (mb / 1024).toFixed(1);
    const cpus = sys.cpuCount || 1;
    const load = sys.loadAvg?.[0] ?? 0;
    const ramRatio = (sys.usedMemPct ?? 0) / 100;
    // D-2173: gauge ACTUAL CPU-busy % (1.0 = cores saturated). Load average
    // over-reports — it counts runnable+waiting threads, pegging red even when
    // idle. Fall back to load/cpus only if cpuBusyPct is unavailable (non-os).
    const cpuBusy = sys.cpuBusyPct;
    const cpuRatio = cpuBusy != null ? cpuBusy / 100 : Math.min(1, load / cpus);
    const GW = 16; // gauge width (cells)

    // Issues segment: count throttled / exhausted accounts (kept on the summary line).
    const accounts = this.am.accounts || [];
    const throttledN = accounts.filter(a => a.status === 'throttled').length;
    const errorN = accounts.filter(a => a.status === 'exhausted' || a.status === 'error').length;
    let issuesSeg = '';
    if (throttledN > 0) issuesSeg += gray(' · ') + yellow(`${throttledN} throttled`);
    if (errorN > 0)     issuesSeg += gray(' · ') + red(`${errorN} error`);

    const lbl = s => gray(padW(s, 5)); // aligned gauge labels
    return [
      ' ' + gray(`proxy ${sys.proxyRssMB}MB · up ${fmtDur(sys.proxyUptimeSec)} · ${cpus} cpus`) + issuesSeg,
      ' ' + lbl('RAM') + bar(ramRatio, GW) + gray(`  ${gb(sys.usedMemMB)}/${gb(sys.totalMemMB)}GB`),
      ' ' + lbl('CPU') + bar(cpuRatio, GW) + gray(`  ${cpuBusy != null ? cpuBusy + '% busy · ' : ''}load ${load} / ${cpus} cores`),
    ];
  }

  render() {
    if (!this.running) return;
    const W = process.stdout.columns || 80;
    const H = process.stdout.rows || 24;

    if (W < 40 || H < 8) {
      process.stdout.write(`${ESC}H${ESC}2JTerminal too small (need 40x8+)\r\n`);
      return;
    }

    const lines = [];

    // D-1820: one section-header design, reused by every section (Top · Umbrellas ·
    // Accounts · By issue · Activity) so separators look identical everywhere.
    // ` Label  <meta> ` in bold-cyan, then a dim ─ rule filling the width. Callers
    // push a blank line before it for clear separation.
    const sectionHdr = (label, meta = '') => {
      const h = ` ${bold(cyan(label))}${meta ? '  ' + meta : ''} `;
      return h + dim('─'.repeat(Math.max(1, W - dw(h))));
    };

    // ── Header
    // D-2485: in the read-only watch viewer, tag the title + flip the up/down
    // marker to the WATCHED proxy's reachability (not this process — the viewer
    // is never a server).
    const watchTag = this.readOnly
      ? '  ' + (this.connState.ok ? yellow('👁 WATCH (read-only)') : red('⚠ WATCH — disconnected'))
      : '';
    const left = bold(' TeamClaude') + watchTag;
    const port = this.config.proxy?.port || 3456;
    const upMark = (this.readOnly && !this.connState.ok) ? red('▼') : green('▲');
    const right = `Port ${port} ${upMark} `;
    lines.push(left + ' '.repeat(Math.max(1, W - vw(left) - vw(right))) + right);
    lines.push(' ' + dim('─'.repeat(W - 2)));
    // D-2485: a loud retry banner while the watched proxy is unreachable; the
    // frozen last-known snapshot stays visible below it.
    if (this.readOnly && !this.connState.ok) {
      lines.push(' ' + red(this.connState.msg || `proxy unreachable on :${port} — retrying…`));
    }

    // D-1728 S8: system resource snapshot — rendered via _healthPanel in the Top section (D-2169).
    const sys = this.am.systemSnapshot ? this.am.systemSnapshot() : null;

    // ── Fleet control plane (D-1739): every live agent clustered UNDER its
    // account — current binding OR last-known account from the durable ledger —
    // shown with its emoji + a status word + $ burn + activity. The registry is
    // the spine; binding + ledger enrich. Local, credential-free, best-effort.
    const binds = this.am.sessionBindingSummary ? this.am.sessionBindingSummary() : [];
    const agg = this.am.sessionAggregate ? this.am.sessionAggregate() : null;
    const fleet = this.am.fleetRows ? this.am.fleetRows() : [];
    const lastAcct = this.am.ledgerBySid ? this.am.ledgerBySid() : new Map();
    const bareOf = sid => String(sid).replace(/^cc-/, '');
    const bindByBare = new Map(binds.map(b => [bareOf(b.fullSid), b]));
    const needsYouP = p => !!(p && (p.status === 'blocked' || p.status === 'in_review' || p.assigneeUserId));

    // D-2105: orchestrator-role detection is pure parentId (tree nesting), not a
    // label. The legacy umbrella:(parallel|sequential|hybrid) type-breakdown is
    // retired — the charter has no sub-type label, and per-level rollups (below)
    // are the new aggregate view. Phase/ordering display is D-1866's job.
    const isOrchestratorLabel = l =>
      typeof l === 'string' && /^orchestrator(:child)?$/i.test(l);

    // resolve every registry agent → account (current OR last-known) + live data
    const agents = fleet.map(f => {
      const bare = bareOf(f.sid);
      const b = bindByBare.get(bare) || null;
      return {
        emoji: f.emoji, issue: f.issue, intent: f.intent, sid8: bare.slice(0, 8),
        status: f.pin?.status || null, needsYou: needsYouP(f.pin),
        inflight: !!f.inflight, // D-1739: a tool is executing right now
        account: b?.account || lastAcct.get(bare)?.account || null,
        bound: !!b, warm: b?.warm || false, idleSec: b?.idleSec ?? null,
        tokens: b?.tokens || 0, inTok: b?.inputTokens || 0, outTok: b?.outputTokens || 0,
        cost: b?.cost || 0, // D-2169: API-equivalent $ for this session
        // D-1798: umbrella→children tree linkage (from pin.json, via fleetRows).
        issueId: f.issueId || f.pin?.issueId || null, // own pinned-issue UUID
        parentId: f.parentId || f.pin?.parentId || null, // umbrella issue UUID
        title: f.pin?.title || null, // issue title — umbrella header label
        // D-1827: raw labels array (null if pc-current hasn't written them yet).
        labels: f.labels || f.pin?.labels || null,
      };
    });

    // D-2697: central-Deck fallback — on a centralized proxy the registry fleet
    // (sessions.json) is client-side, so `fleet` is empty even with live sessions
    // bound. Synthesize `agents` from the live session bindings so the fleet
    // header counts (N agents · M warm · L LLM) + the per-account session rows
    // reflect real activity centrally. The client-only fields (emoji / issue /
    // pin status / umbrella linkage) aren't on the central proxy, so they render
    // as their nil forms (sid8 instead of an issue label, no ☂/↳ tree); the live
    // token / warm / idle / account / cost data is all present in the binding.
    if (agents.length === 0 && binds.length) {
      for (const b of binds) {
        const bare = bareOf(b.fullSid);
        agents.push({
          emoji: null, issue: null, intent: null, sid8: bare.slice(0, 8),
          status: null, needsYou: false, inflight: false,
          account: b.account || null,
          bound: true, warm: b.warm || false, idleSec: b.idleSec ?? null,
          tokens: b.tokens || 0, inTok: b.inputTokens || 0, outTok: b.outputTokens || 0,
          cost: b.cost || 0,
          issueId: null, parentId: null, title: null, labels: null,
        });
      }
    }

    // D-2697: central-Deck fallback — on a centralized proxy the registry fleet
    // (sessions.json) is client-side, so `fleet` is empty even with live sessions
    // bound. Synthesize `agents` from the live session bindings so the fleet
    // header counts (N agents · M warm · L LLM) + the per-account session rows
    // reflect real activity centrally. The client-only fields (emoji / issue /
    // pin status / umbrella linkage) aren't on the central proxy, so they render
    // as their nil forms (sid8 instead of an issue label, no ☂/↳ tree); the live
    // token / warm / idle / account / cost data is all present in the binding.
    if (agents.length === 0 && binds.length) {
      for (const b of binds) {
        const bare = bareOf(b.fullSid);
        agents.push({
          emoji: null, issue: null, intent: null, sid8: bare.slice(0, 8),
          status: null, needsYou: false, inflight: false,
          account: b.account || null,
          bound: true, warm: b.warm || false, idleSec: b.idleSec ?? null,
          tokens: b.tokens || 0, inTok: b.inputTokens || 0, outTok: b.outputTokens || 0,
          cost: b.cost || 0,
          issueId: null, parentId: null, title: null, labels: null,
        });
      }
    }

    // D-2697: central-Deck fallback — on a centralized proxy the registry fleet
    // (sessions.json) is client-side, so `fleet` is empty even with live sessions
    // bound. Synthesize `agents` from the live session bindings so the fleet
    // header counts (N agents · M warm · L LLM) + the per-account session rows
    // reflect real activity centrally. The client-only fields (emoji / issue /
    // pin status / umbrella linkage) aren't on the central proxy, so they render
    // as their nil forms (sid8 instead of an issue label, no ☂/↳ tree); the live
    // token / warm / idle / account / cost data is all present in the binding.
    if (agents.length === 0 && binds.length) {
      for (const b of binds) {
        const bare = bareOf(b.fullSid);
        agents.push({
          emoji: null, issue: null, intent: null, sid8: bare.slice(0, 8),
          status: null, needsYou: false, inflight: false,
          account: b.account || null,
          bound: true, warm: b.warm || false, idleSec: b.idleSec ?? null,
          tokens: b.tokens || 0, inTok: b.inputTokens || 0, outTok: b.outputTokens || 0,
          cost: b.cost || 0,
          issueId: null, parentId: null, title: null, labels: null,
        });
      }
    }

    // collisions + attention counts across the whole fleet
    const issueCount = new Map();
    for (const a of agents) if (a.issue) issueCount.set(a.issue, (issueCount.get(a.issue) || 0) + 1);
    const collide = new Set([...issueCount].filter(([, n]) => n > 1).map(([k]) => k));
    const fleetNeedsYou = agents.filter(a => a.needsYou).length;
    const warmCount = agents.filter(a => a.warm).length;

    // edge-fired alert bell (terminal bell + in-view flag only; never per-frame)
    const alertKey = `${[...collide].sort().join(',')}|${fleetNeedsYou}`;
    const hasAlert = collide.size > 0 || fleetNeedsYou > 0;
    if (this.bell !== false && hasAlert && alertKey !== this._lastAlertKey) process.stdout.write('\x07');
    this._lastAlertKey = hasAlert ? alertKey : '';

    // D-1820: build umbrella/children index ONCE — reused by Top section fleet line
    // (req 2), role indicators in agentRow (req 5), and Umbrellas section (req 4/6).
    // An umbrella lead is a live agent whose issueId is another live agent's parentId.
    // kidsByParent maps parentIssueUuid → [child agents]; orphans (no live lead) skipped.
    const agentByIssueUuid = new Map();
    for (const a of agents) if (a.issueId) agentByIssueUuid.set(a.issueId, a);
    const kidsByParent = new Map();
    for (const a of agents) {
      if (!a.parentId || !agentByIssueUuid.has(a.parentId)) continue; // skip orphans
      if (!kidsByParent.has(a.parentId)) kidsByParent.set(a.parentId, []);
      kidsByParent.get(a.parentId).push(a);
    }

    // D-1820 Req 5: precompute umbrella lead set + child set for role indicators.
    // ☂ = umbrella lead (its issueId key maps to it in kidsByParent via agentByIssueUuid)
    // ↳ = child (its parentId is a key in kidsByParent)
    // Note: ☂ is 2 cells (matched by WIDE_RE), ↳ is 1 — padW measures real display
    // width, so every account row's chip/state/tok columns stay aligned regardless.
    const umbrellaLeadSet = new Set();
    for (const [pid] of kidsByParent) {
      const lead = agentByIssueUuid.get(pid);
      if (lead) umbrellaLeadSet.add(lead);
    }
    const childSet = new Set();
    for (const a of agents) {
      if (a.parentId && kidsByParent.has(a.parentId)) childSet.add(a);
    }

    // bucket agents under their resolved account; the rest into an unrouted tail
    const byAcct = new Map();
    const unrouted = [];
    for (const a of agents) {
      if (a.account) { if (!byAcct.has(a.account)) byAcct.set(a.account, []); byAcct.get(a.account).push(a); }
      else unrouted.push(a);
    }

    // status chip — short colored word from the local pin status (60-30-10:
    // color does the work). Empty for unknown/no-pin.
    const statusChip = st => {
      const m = {
        in_progress: [green, 'work'], blocked: [red, 'block'], in_review: [yellow, 'review'],
        todo: [cyan, 'todo'], backlog: [gray, 'queued'], done: [dim, 'done'], cancelled: [gray, 'cancel'],
      };
      const e = m[st];
      return e ? e[0](e[1]) : '';
    };

    // ══ Accounts — each account, with the agents using it clustered below ══
    if (this.am.accounts.length === 0) {
      lines.push('');
      lines.push(yellow('  No accounts configured. Press [a] to add one.'));
    } else {
      const showBoth = W >= 70;
      const aggCost = agg ? (agg.cost || 0) : 0; // D-2169: accurate per-model $ (not the flat _cost guess)
      const bw = showBoth
        ? Math.max(5, Math.min(16, Math.floor((W - 60) / 2)))
        : Math.max(5, Math.min(16, W - 48));

      // ── D-1820 Req 1+2: Top section ─────────────────────────────────────
      // Proxy line + rebuilt fleet summary, grouped before Umbrellas + Accounts.
      {
        const numUmbrellas = umbrellaLeadSet.size;
        // child-only = in childSet but NOT also a lead (a nested-umbrella lead counts
        // as ☂, never ↳), so solo · ☂ · ↳ always sums to agents.length.
        const childOnly = [...childSet].filter(a => !umbrellaLeadSet.has(a)).length;
        const independent = agents.filter(a => !umbrellaLeadSet.has(a) && !childSet.has(a)).length;
        // in-flight upstream API calls through proxy. D-2485: the watch viewer has
        // no per-request hooks (this.active stays empty), so prefer the scalar
        // activeLLM count polled from the snapshot; live mode falls back to the set.
        const runningLLM = this.activeCount != null ? this.activeCount : this.active.size;
        const runningTools = agents.filter(a => a.inflight).length;

        lines.push('');
        lines.push(sectionHdr('Top'));

        // D-2169: visual health panel (proxy summary + RAM/CPU gauge bars)
        for (const hl of this._healthPanel(sys)) lines.push(hl);

        // D-2179: pool capacity chip — what an orchestrator reads to gate launches.
        if (this.am.computeCapacity) {
          const cap = this.am.computeCapacity();
          const vcol = cap.verdict === 'green' ? green : cap.verdict === 'yellow' ? yellow : red;
          let cH = ` Cap    ${vcol(String(cap.verdict).toUpperCase())} · ${cyan(cap.headroom + ' headroom')} · ${cap.liveAccounts}/${cap.total} live`;
          if (cap.benched > 0) cH += ` · ${yellow(cap.benched + ' benched')}`;
          if (cap.soonestResetSec > 0) cH += ` · ${gray('next ' + fmtDur(cap.soonestResetSec))}`;
          lines.push(cH);
        }

        // fleet summary left: agent breakdown + attention signals
        let sH = ` Fleet  ${cyan(agents.length + ' agents')}`;
        if (numUmbrellas > 0) {
          sH += ` (${independent} solo · ${numUmbrellas} ☂ · ${childOnly} ↳)`;
        }
        sH += ` · ${green(warmCount + ' warm')}`;
        if (fleetNeedsYou > 0) sH += ` · ${red(fleetNeedsYou + ' needs-you')}`;
        if (collide.size > 0) sH += ` · ${yellow(collide.size + ' collide')}`;
        sH += ` · ${cyan(runningLLM + ' LLM')} · ${runningTools} tools`;

        // right-aligned: token total + $ burn
        const sHR = `${fmtN(agg ? agg.tokens : 0)} tok · ${green('$' + aggCost.toFixed(2))} ▲ `;
        lines.push(sH + ' '.repeat(Math.max(1, W - dw(sH) - dw(sHR))) + sHR);
      }

      // D-1820: unified column lane model — every session-like row (agentRow and
      // childRow) shares the SAME column start positions so chip/state/act/tok/intent
      // form clean vertical lanes across both the Umbrellas and Accounts sections.
      //
      // Prefix: 8 display cells in both row types:
      //   agentRow  → '      ' (6 sp) + mark (1) + ' ' (1) = 8
      //   childRow  → '   ' (3 sp) + conn (2 = ├─/└─) + ' ' (1) + mark (1) + ' ' (1) = 8
      //
      // Column widths (display cells):
      //   who   : padW(_, 20)  — role-glyph + emoji + issue label
      //   [gap2]: 2 spaces
      //   chip  : padW(_, 9)   — status word (work/review/block/todo/…)
      //   [gap1]: 1 space
      //   state : padW(_, 6)   — live / idle / —
      //   [gap1]: 1 space
      //   act   : padW(_, 3)   — ⚙ / ~ / space
      //   [gap1]: 1 space
      //   tok   : padW(_, 8)   — token count
      //   [gap2]: 2 spaces
      //   intent: W - 8 - 20 - 2 - 9 - 1 - 6 - 1 - 3 - 1 - 8 - 2 = W - 61 chars remaining
      //
      // D-1820 Req 5: role indicator glyph prepended before emoji in who column.
      // D-1820 Req 7 (display half): title fallback before sid8 — a.title shows
      // issue title for sessions with no D-N yet resolved.
      const COL_WHO = 20, COL_CHIP = 9, COL_STATE = 6, COL_ACT = 3, COL_TOK = 8, COL_COST = 8;
      const agentRow = a => {
        const mark = a.needsYou ? red('►') : (collide.has(a.issue) ? yellow('◆') : ' ');
        const roleGlyph = umbrellaLeadSet.has(a) ? dim(cyan('☂')) : (childSet.has(a) ? dim(cyan('↳')) : ' ');
        const label = a.issue || a.title || a.sid8 || '—';
        const who   = padW(roleGlyph + ' ' + (a.emoji || '·') + ' ' + label, COL_WHO);
        const chip  = padW(a.status ? statusChip(a.status) : gray('·'), COL_CHIP);
        const state = padW(a.bound ? (a.warm ? green('live') : gray('idle')) : gray('—'), COL_STATE);
        // D-1739: activity glyph — ⚙ tool executing, ~ LLM responding/active, blank idle.
        const act   = padW(a.inflight ? cyan('⚙') : (a.warm ? dim('~') : ' '), COL_ACT);
        const tok   = padW(a.bound ? green(fmtN(a.tokens)) : gray('—'), COL_TOK);
        const cst   = padW(a.bound && a.cost ? green(fmtCost(a.cost)) : gray('—'), COL_COST); // D-2169
        let line = '      ' + mark + ' ' + who + '  ' + chip + ' ' + state + ' ' + act + ' ' + tok + ' ' + cst + '  ';
        const intent = a.intent ? a.intent.replace(/^solo:\s*/, '') : '';
        if (intent) {
          const tag = (a.intent && a.intent.startsWith('solo:')) ? cyan('solo ') : '';
          const room = W - dw(line) - dw(tag);
          if (room > 8) line += tag + dim(intent.slice(0, room));
        }
        return line;
      };

      // ══ D-2105: Tree — the FULL orchestration tree, recursive to any depth ══
      // Roots = lead agents (≥1 live child) whose own parent is NOT a live agent
      // (top of a tree; orphan-as-root). Each node renders depth-indented with
      // ├─/└─ connectors + │ continuation bars; tokens roll up per-subtree
      // (self · Σ), per-level (Levels line), and per-tree ($ on the header).
      // Tree art lives INSIDE the who column so chip/state/act/tok lanes stay
      // vertically aligned at EVERY depth. Replaces the one-level Umbrellas
      // section (D-1798/D-1820/D-1827); folds the umbrella→orchestrator rename
      // (D-1960). Phase/ordering display stays D-1866's job.
      const isChildAgent = a => a.parentId && agentByIssueUuid.has(a.parentId);
      const treeRoots = agents.filter(a => a.issueId && kidsByParent.has(a.issueId) && !isChildAgent(a));

      if (treeRoots.length > 0) {
        // memoized subtree token total (self + all descendants); cycle-safe.
        const subtreeTokCache = new Map();
        const subtreeTokens = (a, seen = new Set()) => {
          const key = a.issueId;
          if (key && subtreeTokCache.has(key)) return subtreeTokCache.get(key);
          if (key && seen.has(key)) return a.tokens || 0; // cycle: count self only
          if (key) seen.add(key);
          let t = a.tokens || 0;
          for (const c of (kidsByParent.get(key) || [])) t += subtreeTokens(c, seen);
          if (key) subtreeTokCache.set(key, t);
          return t;
        };

        // running totals filled during the recursive walk.
        let treeNodeCount = 0, treeIn = 0, treeOut = 0, treeCostAcc = 0; // D-2169: $ rollup
        const levelStats = []; // depth → { count, tokens }

        lines.push('');
        const hdrIdx = lines.length;
        lines.push(''); // header placeholder — filled after totals are known

        // who-column width for the tree: the indented art + emoji + label all live
        // inside this fixed lane so every other column lines up at any depth.
        const COL_WHO_TREE = 26;
        const renderNode = (a, depth, isLast, bars, seen) => {
          if (a.issueId && seen.has(a.issueId)) return; // cycle guard
          if (a.issueId) seen.add(a.issueId);
          treeNodeCount++;
          treeIn += a.inTok || 0; treeOut += a.outTok || 0; treeCostAcc += a.cost || 0;
          if (!levelStats[depth]) levelStats[depth] = { count: 0, tokens: 0 };
          levelStats[depth].count++;
          levelStats[depth].tokens += a.tokens || 0;

          const kids = (a.issueId ? kidsByParent.get(a.issueId) : null) || [];
          const isLead = kids.length > 0;
          const indent = bars.map(b => (b ? '│  ' : '   ')).join('');
          const conn = depth === 0 ? '' : (isLast ? '└─ ' : '├─ ');
          const glyph = isLead ? dim(cyan('☂')) + ' ' : (depth > 0 ? dim(cyan('↳')) + ' ' : '');
          const label = a.issue || a.title || a.sid8 || '—';
          const whoRaw = indent + conn + glyph + (a.emoji || '·') + ' ' + label;
          const who = padW(whoRaw, COL_WHO_TREE);
          const mark = a.needsYou ? red('►') : (collide.has(a.issue) ? yellow('◆') : ' ');
          const chip  = padW(a.status ? statusChip(a.status) : gray('·'), COL_CHIP);
          const state = padW(a.bound ? (a.warm ? green('live') : gray('idle')) : gray('—'), COL_STATE);
          const act   = padW(a.inflight ? cyan('⚙') : (a.warm ? dim('~') : ' '), COL_ACT);
          const tok   = padW(a.bound ? green(fmtN(a.tokens)) : gray('—'), COL_TOK);
          const cst   = padW(a.bound && a.cost ? green(fmtCost(a.cost)) : gray('—'), COL_COST); // D-2169
          let line = ' ' + mark + ' ' + (depth === 0 ? bold(who) : who) + '  ' + chip + ' ' + state + ' ' + act + ' ' + tok + ' ' + cst;
          // lead nodes also show the Σ subtree total after the self-token lane.
          if (isLead) line += '  ' + dim('Σ') + ' ' + bold(green(fmtN(subtreeTokens(a))));
          // intent / title tail
          const tailRaw = (depth === 0 ? (a.title || a.intent) : a.intent) || '';
          if (tailRaw) {
            const tail = tailRaw.replace(/^solo:\s*/, '');
            const room = W - dw(line) - 2;
            if (room > 8) line += '  ' + dim(tail.slice(0, room));
          }
          lines.push(line);
          // recurse children, largest subtree first.
          const ordered = [...kids].sort((x, y) => subtreeTokens(y) - subtreeTokens(x));
          ordered.forEach((c, i) =>
            renderNode(c, depth + 1, i === ordered.length - 1, [...bars, !isLast], seen));
        };

        const seen = new Set();
        const rootsOrdered = [...treeRoots].sort((x, y) => subtreeTokens(y) - subtreeTokens(x));
        let treeTok = 0;
        for (const r of rootsOrdered) { treeTok += subtreeTokens(r); renderNode(r, 0, true, [], seen); }

        // header — now that the walk computed node count + tokens.
        const treeWord = treeRoots.length === 1 ? ' tree' : ' trees';
        const treeCost = treeCostAcc; // D-2169: accurate per-model $ rollup
        const tMeta = `${cyan(treeRoots.length + treeWord)} · ${gray(treeNodeCount + (treeNodeCount === 1 ? ' node' : ' nodes'))} · ${green(fmtN(treeTok) + ' tok')} · ${green('$' + treeCost.toFixed(2))}`;
        lines[hdrIdx] = sectionHdr('Tree', tMeta);

        // S3: per-level rollup line — count · tokens at each depth.
        if (levelStats.some(Boolean)) {
          let lv = ' ' + dim('Levels');
          levelStats.forEach((s, d) => {
            if (!s) return;
            lv += `  ${cyan('L' + d)} ${s.count}·${green(fmtN(s.tokens))}`;
          });
          lines.push(lv);
        }
      }

      // each account header, then the agents using it.
      // D-1739: accounts themselves ordered by total token burn descending.
      const acctTok = i => (byAcct.get(this.am.accounts[i].name) || [])
        .reduce((s, a) => s + a.inTok + a.outTok, 0);
      const acctOrder = this.am.accounts.map((_, i) => i).sort((a, b) => acctTok(b) - acctTok(a));
      // D-1820: Accounts section header — same design as the other sections.
      const totalAcctTok = acctOrder.reduce((s, i) => s + acctTok(i), 0);
      const aMeta = `${cyan(this.am.accounts.length + (this.am.accounts.length === 1 ? ' account' : ' accounts'))} · ${green(fmtN(totalAcctTok) + ' tok')}`;
      lines.push('');
      lines.push(sectionHdr('Accounts', aMeta));
      for (const i of acctOrder) {
        const acct = this.am.accounts[i];
        const list = byAcct.get(acct.name) || [];
        let rin = 0, rout = 0, live = 0;
        for (const a of list) { rin += a.inTok; rout += a.outTok; if (a.warm) live++; }
        const _bn = binds.filter(b => b.account === acct.name);           // D-2697: central-Deck chat count from session bindings (fleet rows are client-side)
        const _bnLive = _bn.filter(b => b.warm).length;
        const _bnTok = _bn.reduce((s, b) => s + (b.tokens || 0), 0);
        const actN = (acct.inflight != null ? acct.inflight : (acct._inflight || 0)); // D-2697: per-account live in-flight (requests executing now)
        const actChip = actN ? ' · ' + cyan(actN + ' active') : '';
        const roll = list.length
          ? `${cyan(list.length + (list.length === 1 ? ' agent' : ' agents'))}${live ? ' · ' + green(live + ' live') : ''}${actChip} · ${green(fmtN(rin + rout) + ' tok')}`
          : _bn.length
            ? `${cyan(_bn.length + (_bn.length === 1 ? ' chat' : ' chats'))}${_bnLive ? ' · ' + green(_bnLive + ' live') : ''}${actChip} · ${green(fmtN(_bnTok) + ' tok')}`
            : gray('· no agents ·');
        lines.push('');
        lines.push(this._renderAcctHeader(i, bw, showBoth, roll));
        if (!list.length) continue;
        list.sort((x, y) => (y.tokens - x.tokens)); // D-1739: ALL rows by token count descending (needs-you stays a ► marker)
        for (const a of list) lines.push(agentRow(a));
      }

      // agents with no account history (never routed through the proxy)
      if (unrouted.length > 0) {
        lines.push('');
        lines.push('  ' + dim('· no account history ·') + '  ' + gray(unrouted.length));
        unrouted.sort((x, y) => (y.tokens - x.tokens)); // D-1739: token-desc like every other list
        for (const a of unrouted) lines.push(agentRow(a));
      }
    }

    // ── By issue (D-1728 S6): durable per-issue usage rollup (ALL sessions,
    // survives idle-eviction + restart). The operator's "all usage on the issue".
    // D-1739: issue → live session emoji(s) + the set of issues with a live
    // session. By-issue shows ONLY active issues (operator: history is in
    // Paperclip); ledger-only issues with no live session are dropped entirely.
    const emojiByIssue = new Map();
    const liveIssues = new Set();
    for (const a of agents) {
      if (!a.issue) continue;
      liveIssues.add(a.issue);
      if (!a.emoji) continue;
      const cur = emojiByIssue.get(a.issue) || [];
      if (!cur.includes(a.emoji)) cur.push(a.emoji);
      emojiByIssue.set(a.issue, cur);
    }
    const byIssue = (this.am.ledgerByIssue ? this.am.ledgerByIssue() : [])
      .filter(g => liveIssues.has(g.issue));
    if (byIssue.length > 0) {
      const issueLabel = iss => {
        const e = emojiByIssue.get(iss);
        return e && e.length ? e.slice(0, 2).join('') + ' ' + iss : iss;
      };
      lines.push('');
      // D-1739: expandable — [i] toggles the full list vs an 8-row cap.
      const cap = this.byIssueExpanded ? byIssue.length : 8;
      const shown = byIssue.slice(0, cap);
      const more = byIssue.length - shown.length;
      const iMeta = `${cyan(byIssue.length)}${this.byIssueExpanded ? ' ' + gray('all') : ''}`;
      lines.push(sectionHdr('By issue', iMeta));
      // first column is width-aware (padW) because the emoji prefix is a wide glyph.
      // D-2169: + a $ cost column between tokens and avg/m.
      const irow = (a, b, c, d, e, f) => '   ' + padW(a, 14) + rpad(b, 6) + rpad(c, 7) + rpad(d, 9) + rpad(e, 9) + f;
      lines.push(dim(irow('issue', 'sess', 'msgs', 'tokens', '$', 'avg/m')));
      const tot = byIssue.reduce((a, g) => ({ s: a.s + g.sessions, m: a.m + g.messages, t: a.t + g.tokens, c: a.c + (g.cost || 0) }), { s: 0, m: 0, t: 0, c: 0 });
      for (const g of shown) {
        lines.push(irow(issueLabel(g.issue), String(g.sessions), String(g.messages), fmtN(g.tokens), fmtCost(g.cost), fmtN(g.avgTokensPerMsg)));
      }
      if (more > 0) lines.push('   ' + gray(`… +${more} more — press i`));
      lines.push(bold(irow('TOTAL', String(tot.s), String(tot.m), fmtN(tot.t), fmtCost(tot.c), fmtN(tot.m ? Math.round(tot.t / tot.m) : 0))));
    }

    // ── Activity header
    lines.push('');
    const ac = this.active.size;
    lines.push(sectionHdr('Activity', ac > 0 ? cyan(ac + ' active') : ''));

    // Active requests
    const now = Date.now();
    for (const [, r] of this.active) {
      const el = ((now - r.started) / 1000).toFixed(1);
      const sp = cyan(SPINNER[this.frame]);
      const a = r.account ? ` → ${r.account}` : '';
      // DL-2785: the model·effort tag, dim so method/path stay the row's anchor.
      const tag = modelEffortTag(r.model, r.effort);
      lines.push(` ${sp} ${gray(r.t)}  ${r.method} ${r.path}${tag ? ' ' + dim(tag) : ''}${a} ${dim(`(${el}s...)`)}`);
    }

    // Completed log
    // D-1820 Req 8: color activity rows by severity (error=red, warn=yellow, else plain).
    const footerH = 2;
    const space = Math.max(0, H - lines.length - footerH);
    for (let i = 0; i < space && i < this.log.length; i++) {
      const { t, msg } = this.log[i];
      const sev = this._logSeverity(msg);
      const coloredMsg = sev === 'error' ? red(msg) : sev === 'warn' ? yellow(msg) : msg;
      lines.push(`   ${gray(t)}  ${coloredMsg}`);
    }

    // Pad to fill
    while (lines.length < H - footerH) lines.push('');

    // ── Footer
    lines.push(' ' + dim('─'.repeat(W - 2)));
    lines.push(this._renderFooter());

    // Write buffer
    let buf = `${ESC}H`;
    for (let i = 0; i < H; i++) {
      buf += fitLine(lines[i] || '', W);
      if (i < H - 1) buf += '\r\n';
    }
    // Show cursor only in input mode
    buf += this.mode === 'input' ? `${ESC}?25h` : `${ESC}?25l`;
    // D-2286: guard the frame write. When the controlling terminal backgrounds or its
    // pty buffer fills, this write raises EIO/EPIPE. render() is reached from console.*
    // (patched → _addLog → render), the 500ms timer, resize, and key handlers — an
    // unguarded throw here propagated into the crash handler, which re-logged via
    // console.error → _addLog → render → here again: the 06-15 EIO storm. Swallow the
    // terminal-write error; the next 500ms repaint recovers once the terminal is back.
    try {
      process.stdout.write(buf);
    } catch (e) {
      if (!(e && (e.code === 'EPIPE' || e.code === 'EIO'))) throw e;
    }
  }

  _renderAcct(idx, bw, showBoth) {
    const a = this.am.accounts[idx];
    const isCur = idx === this.am.currentIndex;
    const isSel = this.mode === 'select' && idx === this.selIdx;

    // Prefix: selection marker + current marker
    const sel = isSel ? cyan('>') : ' ';
    const cur = isCur ? green('►') : ' ';

    // Name (bold if selected)
    const rawName = a.name.slice(0, 12).padEnd(12);
    const name = isSel ? bold(rawName) : rawName;

    // Type
    const type = gray(a.type.padEnd(7));

    // Status
    let status;
    switch (a.status) {
      case 'active':    status = isCur ? green('active') : 'active'; break;
      case 'throttled': status = yellow('throttled'); break;
      case 'exhausted': status = red('exhausted'); break;
      case 'error':     status = red('error'); break;
      default:          status = a.status || 'ready';
    }
    status = rpad(status, 10);

    // Quota ratios — prefer unified (Claude Max), fall back to standard (API key)
    const q = a.quota;
    let r1 = null, r2 = null, l1 = 'Ses', l2 = 'Wk ', t1 = null, t2 = null;

    if (q.unified5h != null || q.unified7d != null) {
      r1 = q.unified5h;
      r2 = q.unified7d;
      t1 = q.unified5hReset;
      t2 = q.unified7dReset;
    } else {
      l1 = 'Tok';
      l2 = 'Req';
      r1 = (q.tokensLimit != null && q.tokensRemaining != null)
        ? 1 - q.tokensRemaining / q.tokensLimit : null;
      r2 = (q.requestsLimit != null && q.requestsRemaining != null)
        ? 1 - q.requestsRemaining / q.requestsLimit : null;
      t1 = q.resetsAt ? new Date(q.resetsAt).getTime() : null;
      t2 = t1;
    }

    let line = ` ${sel}${cur} ${name} ${type} ${status} ${l1} ${bar(r1, bw, t1)}`;
    if (showBoth) {
      line += `  ${l2} ${bar(r2, bw, t2)}`;
      // DL-3160: distinct Fable/premium (7d_oi) meter — real-header-driven, shown
      // only when the account carries premium-axis data; separate from base 5h/7d.
      const pa = this._premiumAxis(q);
      if (pa) line += `  Fbl ${bar(pa.r, bw, pa.t)}`;
    }
    return line;
  }

  // D-1739 S1: account as a group header — glyph(type) + name + status +
  // quota bars + per-account roll-up (sess · $). Sessions render indented below.
  _renderAcctHeader(idx, bw, showBoth, roll) {
    const a = this.am.accounts[idx];
    const isCur = idx === this.am.currentIndex;
    const isSel = this.mode === 'select' && idx === this.selIdx;
    const sel = isSel ? cyan('>') : ' ';
    const glyph = this._acctGlyph(a.type);

    const rawName = a.name.slice(0, 12).padEnd(12);
    const name = isSel ? bold(rawName) : (isCur ? bold(rawName) : rawName);

    let status;
    switch (a.status) {
      case 'active':    status = green('active'); break;
      case 'throttled': status = yellow('throttled'); break;
      case 'exhausted': status = red('exhausted'); break;
      case 'error':     status = red('error'); break;
      default:          status = a.status || 'ready';
    }
    status = rpad(status, 10);

    // Quota ratios — prefer unified (Claude Max), fall back to standard (API key)
    const q = a.quota;
    let r1 = null, r2 = null, l1 = 'Ses', l2 = 'Wk', t1 = null, t2 = null;
    const isUnified = q.unified5h != null || q.unified7d != null;
    if (isUnified) {
      r1 = q.unified5h; r2 = q.unified7d; t1 = q.unified5hReset; t2 = q.unified7dReset;
    } else {
      l1 = 'Tok'; l2 = 'Req';
      r1 = (q.tokensLimit != null && q.tokensRemaining != null)
        ? 1 - q.tokensRemaining / q.tokensLimit : null;
      r2 = (q.requestsLimit != null && q.requestsRemaining != null)
        ? 1 - q.requestsRemaining / q.requestsLimit : null;
      t1 = q.resetsAt ? new Date(q.resetsAt).getTime() : null; t2 = t1;
    }

    // D-1820: pace arrow after each bar — only Max/unified accounts have a known
    // rolling window (5h/7d); API-key Tok/Req windows are unknown → '·'.
    const w1 = isUnified ? FIVE_H_MS : null;
    const w2 = isUnified ? SEVEN_D_MS : null;
    let line = ` ${sel}${glyph} ${name} ${status} ${l1}${bar(r1, bw, t1)} ${this._paceArrow(r1, t1, w1)}`;
    if (showBoth) line += `   ${l2}${bar(r2, bw, t2)} ${this._paceArrow(r2, t2, w2)}`;
    // DL-3160: distinct Fable/premium (7d_oi) meter after the base axes — shown only
    // when the account carries premium-axis data (real header or prober), never estimated.
    if (showBoth) {
      const pa = this._premiumAxis(q);
      if (pa) line += `   Fbl${bar(pa.r, bw, pa.t)}`;
    }
    line += `  ${roll}`;
    return line;
  }

  _acctGlyph(type) {
    return type === 'apikey' ? cyan('◇') : cyan('◆');
  }

  // DL-3160: the Fable/premium (7d_oi) axis for the Deck meter — real-header-driven,
  // never estimated. Returns { r: utilization, t: reset } when the account carries
  // premium data, else null (→ no meter rendered, we never fabricate a bar). A
  // rejected account with no util still reads as full (r=1) so the cap is visible.
  _premiumAxis(q) {
    if (!q) return null;
    if (q.premiumUtil != null) return { r: q.premiumUtil, t: q.premiumReset ?? null };
    if (q.premiumStatus === 'rejected') return { r: 1, t: q.premiumReset ?? null };
    return null;
  }

  // D-1820: burn-rate arrow for one quota window — compares used% against how
  // much of the rolling window has elapsed, so the operator sees whether to load
  // more work (under-pace) or cool down (over-pace, will hit the cap before reset).
  //   ↑ green  = under-spending (headroom) — safe to pile on work
  //   → yellow = tracking even with the clock
  //   ↓N red   = over-spending — projected to hit the cap in ~N (before the reset)
  //   · gray   = no data / unknown window (error account, API-key Tok/Req)
  _paceArrow(used, resetTs, windowMs) {
    if (used == null || resetTs == null || windowMs == null) return gray('·');
    const timeToReset = resetTs - Date.now();
    const elapsedFrac = Math.max(0, Math.min(1, 1 - timeToReset / windowMs));
    if (elapsedFrac < 0.02) return gray('·'); // too early in the window to judge pace
    const headroom = elapsedFrac - used;      // >0 under-pace, <0 over-pace
    if (headroom > 0.05) return green('↑');
    if (headroom < -0.05) {
      if (used >= 0.98) return red('↓!');      // already at the cap
      const fStar = elapsedFrac / used;        // window-fraction at projected exhaust (<1)
      const etaSec = Math.max(0, Math.round((fStar - elapsedFrac) * windowMs / 1000));
      return red('↓' + fmtDur(etaSec));        // cool down — cap in ~ETA, before reset
    }
    return yellow('→');
  }

  // D-1739 S4: API-equivalent $ burn — what these tokens would cost pay-as-you-go
  // on the Anthropic API. Default Sonnet-4.x rate ($3/Mtok in, $15/Mtok out);
  // override via config.pricing.{inPerMtok,outPerMtok}. Display-only (Max is flat-fee).
  _cost(inTok, outTok) {
    const pin = this.config.pricing?.inPerMtok ?? 3;
    const pout = this.config.pricing?.outPerMtok ?? 15;
    return ((inTok || 0) / 1e6) * pin + ((outTok || 0) / 1e6) * pout;
  }

  // D-1820 Req 8: classify a log message as 'error', 'warn', or null.
  // error wins over warn. HTTP status is matched only in its `(NNN,`/`(NNN)`
  // log position (onRequestEnd format) so 3-digit paths/durations/account names
  // don't false-trigger; keyword matches catch non-request log lines.
  _logSeverity(msg) {
    if (/\(5\d\d[,)]|error|fail|exhausted|rejected/i.test(msg)) return 'error';
    if (/\(4\d\d[,)]|throttl|overload|warn/i.test(msg)) return 'warn';
    return null;
  }

  _renderFooter() {
    // D-2485: read-only watch viewer — only the non-mutating keys are live.
    if (this.readOnly) {
      const conn = this.connState.ok ? green('● live') : red('● reconnecting');
      return ` ${conn}  ${bold('b')}ell${this.bell === false ? gray('·muted') : ''}  ${bold('i')}ssues${this.byIssueExpanded ? gray('·all') : ''}  ${bold('q')}uit  ${gray('· read-only viewer')}`;
    }
    switch (this.mode) {
      case 'normal':
        return ` ${bold('s')}witch  ${bold('a')}dd  ${bold('r')}emove  ${bold('R')}eload  ${bold('b')}ell${this.bell === false ? gray('·muted') : ''}  ${bold('i')}ssues${this.byIssueExpanded ? gray('·all') : ''}  ${bold('q')}uit`;
      case 'select': {
        const act = this.selAction === 'switch' ? 'switch' : 'remove';
        return ` ${dim('↑↓')} select  ${bold('Enter')} ${act}  ${bold('Esc')} cancel`;
      }
      case 'add':
        return ` ${bold('i')}mport Claude Code  ${bold('k')} API key  ${bold('Esc')} cancel`;
      case 'input':
        return ` ${this.inputPrompt}: ${this.inputBuf}█`;
      default:
        return '';
    }
  }
}

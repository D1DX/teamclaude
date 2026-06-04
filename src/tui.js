import { importCredentials, fetchProfile } from './oauth.js';
import { resolveLogDir, appendOpLog } from './oplog.js';
import { execSync } from 'node:child_process';

// ── ANSI helpers ─────────────────────────────────────────────

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.split('');
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

const bold = s => `${BOLD}${s}${RESET}`;
const dim = s => `${DIM}${s}${RESET}`;
const fg = (c, s) => `${ESC}${c}m${s}${RESET}`;
const green = s => fg(32, s);
const yellow = s => fg(33, s);
const red = s => fg(31, s);
const cyan = s => fg(36, s);
const gray = s => fg(90, s);

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = s => s.replace(ANSI_RE, '');
const vw = s => strip(s).length;

// D-1739: true display width — emojis + CJK occupy TWO terminal cells, so
// counting them as 1 (string length) is exactly what makes emoji columns ragged.
// Strip ANSI, then sum cell widths; combining marks / VS16 / ZWJ contribute 0.
const WIDE_RE = /[\u{1100}-\u{115F}\u{2E80}-\u{303E}\u{3041}-\u{33FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{A000}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE30}-\u{FE6F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/u;
function dw(s) {
  let w = 0;
  for (const ch of strip(s)) {
    const cp = ch.codePointAt(0);
    if (cp === 0xFE0F || cp === 0x200D || (cp >= 0x0300 && cp <= 0x036F)) continue;
    w += WIDE_RE.test(ch) ? 2 : 1;
  }
  return w;
}
// right-pad / left-pad (right-align) to a display width measured in cells
function padW(s, w) { const g = w - dw(s); return g > 0 ? s + ' '.repeat(g) : s; }
function lpadW(s, w) { const g = w - dw(s); return g > 0 ? ' '.repeat(g) + s : s; }

function rpad(s, w) {
  const gap = w - vw(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/** Truncate a string with ANSI codes to exactly w visible characters, then reset. */
function truncate(s, w) {
  let visible = 0;
  let out = '';
  let i = 0;
  while (i < s.length && visible < w) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end >= 0) { out += s.slice(i, end + 1); i = end + 1; continue; }
    }
    out += s[i];
    visible++;
    i++;
  }
  return out + RESET;
}

/** Fit a line to exactly w columns: truncate if too long, pad if too short. */
function fitLine(s, w) {
  const v = vw(s);
  if (v > w) return truncate(s, w);
  if (v < w) return s + ' '.repeat(w - v);
  return s;
}

function formatReset(resetTs) {
  if (!resetTs) return '';
  const ms = resetTs - Date.now();
  if (ms <= 0) return '';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d${rh}h` : `${days}d`;
}

/**
 * Render a progress bar using background colors with text overlaid.
 * The label (e.g. "Ses 2h30m" or "45%") is drawn on top of the bar.
 */
function bar(ratio, w = 10, resetTs) {
  const rst = formatReset(resetTs);

  if (ratio == null || isNaN(ratio)) {
    // No data — dim background, show label or dash
    const label = rst || '-';
    const text = label.slice(0, w);
    const pad = w - text.length;
    const lp = Math.floor(pad / 2);
    const rp = pad - lp;
    return `${ESC}100m${' '.repeat(lp)}${text}${' '.repeat(rp)}${RESET}`;
  }

  ratio = Math.max(0, Math.min(1, ratio));
  const f = Math.round(ratio * w);
  // Background colors: 42=green, 43=yellow, 41=red; 100=bright black (gray) for empty
  const bg = ratio < 0.7 ? 42 : ratio < 0.9 ? 43 : 41;

  // Build the label to overlay: show reset time if available, else percentage
  const pct = (ratio * 100).toFixed(0) + '%';
  const label = rst || pct;
  const text = label.slice(0, w);
  const pad = w - text.length;
  const lp = Math.floor(pad / 2);
  const rp = pad - lp;
  const chars = (' '.repeat(lp) + text + ' '.repeat(rp));

  // Split chars into filled (colored bg) and empty (gray bg) portions
  const filled = chars.slice(0, f);
  const empty = chars.slice(f);

  let out = '';
  if (filled) out += `${ESC}${bg};97m${filled}`;
  if (empty) out += `${ESC}100;37m${empty}`;
  out += RESET;
  return out;
}

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// D-1728 dashboard formatters.
function fmtN(n) {
  if (n == null) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
}
function fmtDur(sec) {
  if (sec == null) return '-';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

// D-1820: rolling quota window lengths — the pace arrow compares used% against
// how much of the window has elapsed. Claude Max: 5h session + 7d weekly.
const FIVE_H_MS = 5 * 60 * 60 * 1000;
const SEVEN_D_MS = 7 * 24 * 60 * 60 * 1000;

// ── TUI class ────────────────────────────────────────────────

export class TUI {
  constructor({ accountManager, config, saveConfig, syncAccounts, onQuit }) {
    this.am = accountManager;
    this.config = config;
    this.saveConfig = saveConfig;
    this.syncAccounts = syncAccounts;
    this.onQuit = onQuit;

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

    // Redirect console to activity log
    this._origLog = console.log;
    this._origErr = console.error;
    console.log = (...a) => this._addLog(a.join(' '));
    console.error = (...a) => this._addLog(a.join(' '));

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
    process.stdin.removeListener('data', this._dataHandler);
    process.stdout.removeListener('resize', this._resizeHandler);
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
    if (r) r.account = info.account;
  }

  onRequestEnd(id, info) {
    const r = this.active.get(id);
    this.active.delete(id);
    const dur = r ? ((Date.now() - r.started) / 1000).toFixed(1) : '?';
    const acct = info.account || r?.account || '?';
    // D1DX (D-1728): routine 2xx request lines stay in the live Activity pane only;
    // only non-2xx (errors / 429) persist to the daily log. Keeps the file minimal.
    this._addLog(`${info.method} ${info.path} → ${acct} (${info.status}, ${dur}s)`, info.status >= 400);
  }

  _addLog(msg, persist = true) {
    msg = msg.replace(/^\[TeamClaude\]\s*/, '');
    if (persist) appendOpLog(this.logDir, msg); // D-1680: durable daily file; D-1728: signal-only
    this.log.unshift({ t: timestamp(), msg });
    if (this.log.length > 200) this.log.length = 200;
    if (this.running) this.render();
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
  _proxyLine(sys, _W) {
    if (!sys) return null;
    const gb = mb => (mb / 1024).toFixed(1);

    // RAM % threshold color: green < 70, yellow 70–89, red ≥ 90
    const ramPct = sys.usedMemPct;
    const ramColor = ramPct >= 90 ? red : ramPct >= 70 ? yellow : green;
    const ramStr = gray(`${gb(sys.usedMemMB)}/`) + gray(`${gb(sys.totalMemMB)}GB`) +
      gray(' (') + ramColor(`${ramPct}%`) + gray(')');

    // Load threshold color: green < cpus*0.7, yellow < cpus, red ≥ cpus
    const load = sys.loadAvg[0];
    const cpus = sys.cpuCount;
    const loadColor = load >= cpus ? red : load >= cpus * 0.7 ? yellow : green;
    const loadStr = loadColor(`${load}`);

    // Issues segment: count throttled/exhausted/error accounts
    const accounts = this.am.accounts || [];
    const throttledN = accounts.filter(a => a.status === 'throttled').length;
    const errorN = accounts.filter(a => a.status === 'exhausted' || a.status === 'error').length;
    let issuesSeg = '';
    if (throttledN > 0) issuesSeg += gray(' · ') + yellow(`${throttledN} throttled`);
    if (errorN > 0)     issuesSeg += gray(' · ') + red(`${errorN} error`);

    return ' ' +
      gray(`proxy ${sys.proxyRssMB}MB · up ${fmtDur(sys.proxyUptimeSec)}    host RAM `) +
      ramStr +
      gray(` · load `) + loadStr + gray(` · ${cpus} cpus`) +
      issuesSeg;
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
    const left = bold(' TeamClaude');
    const port = this.config.proxy?.port || 3456;
    const right = `Port ${port} ${green('▲')} `;
    lines.push(left + ' '.repeat(Math.max(1, W - vw(left) - vw(right))) + right);
    lines.push(' ' + dim('─'.repeat(W - 2)));

    // D-1728 S8: system resource snapshot — rendered via _proxyLine in the Top section.
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
        // D-1798: umbrella→children tree linkage (from pin.json, via fleetRows).
        issueId: f.issueId || f.pin?.issueId || null, // own pinned-issue UUID
        parentId: f.parentId || f.pin?.parentId || null, // umbrella issue UUID
        title: f.pin?.title || null, // issue title — umbrella header label
      };
    });

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
      const aggCost = agg ? this._cost(agg.inputTokens, agg.outputTokens) : 0;
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
        const runningLLM = this.active.size;  // in-flight upstream API calls through proxy
        const runningTools = agents.filter(a => a.inflight).length;

        lines.push('');
        lines.push(sectionHdr('Top'));

        // proxy/system line — child C owns coloring inside _proxyLine
        const pl = this._proxyLine(sys, W);
        if (pl) lines.push(pl);

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
      const COL_WHO = 20, COL_CHIP = 9, COL_STATE = 6, COL_ACT = 3, COL_TOK = 8;
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
        let line = '      ' + mark + ' ' + who + '  ' + chip + ' ' + state + ' ' + act + ' ' + tok + '  ';
        const intent = a.intent ? a.intent.replace(/^solo:\s*/, '') : '';
        if (intent) {
          const tag = (a.intent && a.intent.startsWith('solo:')) ? cyan('solo ') : '';
          const room = W - dw(line) - dw(tag);
          if (room > 8) line += tag + dim(intent.slice(0, room));
        }
        return line;
      };

      // ══ D-1820 Req 4: Umbrellas as a standalone section ════════════════
      // After the Top section, before account groups. The umbrella→children tree
      // (D-1798) renders here. Orphan children (lead not live/wrapped) remain in
      // the account groups below, exactly as today.
      if (kidsByParent.size > 0) {
        const totalKids = [...kidsByParent.values()].reduce((s, l) => s + l.length, 0);
        const treeWord = kidsByParent.size === 1 ? ' umbrella' : ' umbrellas';

        // D-1820 Req 6: token total on the header — sum of each umbrella lead's
        // tokens + its children's tokens; mirrors the ` By issue ` TOTAL pattern.
        let totalUmbrellaTok = 0;
        for (const [pid, children] of kidsByParent) {
          const lead = agentByIssueUuid.get(pid);
          if (lead) totalUmbrellaTok += lead.tokens;
          for (const c of children) totalUmbrellaTok += c.tokens;
        }
        const uMeta = `${cyan(kidsByParent.size + treeWord)} · ${gray(totalKids + (totalKids === 1 ? ' child' : ' children'))} · ${green(fmtN(totalUmbrellaTok) + ' tok')}`;
        lines.push('');
        lines.push(sectionHdr('Umbrellas', uMeta));

        // one child row — indented under its umbrella with a tree connector.
        // Prefix = '   ' (3) + conn (2 = ├─/└─) + ' ' (1) + mark (1) + ' ' (1) = 8 cells,
        // matching agentRow's 8-cell prefix so all data columns align vertically.
        // D-1820 Req 7 (display half): title fallback — a.title before a.sid8.
        const childRow = (a, last) => {
          const conn = gray(last ? '└─' : '├─');
          const mark = a.needsYou ? red('►') : (collide.has(a.issue) ? yellow('◆') : ' ');
          const clabel = a.issue || a.title || a.sid8 || '—';
          // No role glyph for child rows (they're implicitly ↳ by tree context); pad to COL_WHO.
          const who   = padW((a.emoji || '·') + ' ' + clabel, COL_WHO);
          const chip  = padW(a.status ? statusChip(a.status) : gray('·'), COL_CHIP);
          const state = padW(a.bound ? (a.warm ? green('live') : gray('idle')) : gray('—'), COL_STATE);
          const act   = padW(a.inflight ? cyan('⚙') : (a.warm ? dim('~') : ' '), COL_ACT);
          const tok   = padW(a.bound ? green(fmtN(a.tokens)) : gray('—'), COL_TOK);
          let line = '   ' + conn + ' ' + mark + ' ' + who + '  ' + chip + ' ' + state + ' ' + act + ' ' + tok + '  ';
          const intent = a.intent ? a.intent.replace(/^solo:\s*/, '') : '';
          if (intent) {
            const tag = (a.intent && a.intent.startsWith('solo:')) ? cyan('solo ') : '';
            const room = W - dw(line) - dw(tag);
            if (room > 8) line += tag + dim(intent.slice(0, room));
          }
          return line;
        };

        // umbrellas ordered by child count desc (biggest fan-out first).
        const groups = [...kidsByParent.entries()].sort((x, y) => y[1].length - x[1].length);
        for (const [pid, children] of groups) {
          const lead = agentByIssueUuid.get(pid);
          if (!lead) continue; // defensive: matches the token-total loop guard above
          // umbrella header — ☂ + bold lead label + status chip + tok self/all totals.
          // Layout: 1-space left indent, then COL_WHO+2 wide (bold who), then chip, then tokSeg.
          // who is 2 cells wider than COL_WHO (the ☂ prefix occupies 2 cells by itself);
          // we use COL_WHO+2 so the chip column lands at the same horizontal position.
          const who = padW('☂ ' + (lead.emoji || '·') + ' ' + (lead.issue || lead.sid8 || '—'), COL_WHO + 2);
          const leadTok = lead.tokens || 0;
          const umbrellaTot = leadTok + children.reduce((s, c) => s + (c.tokens || 0), 0);
          // D-1820: suppress noisy "0 self · 0 all" when umbrella has no tokens at all.
          // When umbrellaTot is 0 show a dim dash; when leadTok is 0 but children have
          // tokens, suppress the "0 self" half and show only the "all" total.
          const tokSeg = umbrellaTot === 0
            ? dim('—')
            : leadTok === 0
              ? `${dim('—')} ${dim('self')} · ${bold(green(fmtN(umbrellaTot)))} ${dim('all')}`
              : `${green(fmtN(leadTok))} ${dim('self')} · ${bold(green(fmtN(umbrellaTot)))} ${dim('all')}`;
          const chip = padW(lead.status ? statusChip(lead.status) : gray('·'), COL_CHIP);
          let head = ' ' + bold(who) + '  ' + chip + '  ' + padW(tokSeg, 24);
          const headLabel = lead.title || lead.intent || '';
          if (headLabel) {
            const room = W - dw(head) - 2;
            if (room > 8) head += ' ' + dim(headLabel.slice(0, room));
          }
          lines.push(head);
          children.sort((x, y) => (y.tokens - x.tokens)); // token-desc, like every other list
          children.forEach((c, idx) => lines.push(childRow(c, idx === children.length - 1)));
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
        const roll = list.length
          ? `${cyan(list.length + (list.length === 1 ? ' agent' : ' agents'))}${live ? ' · ' + green(live + ' live') : ''} · ${green(fmtN(rin + rout) + ' tok')}`
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
      const irow = (a, b, c, d, e) => '   ' + padW(a, 14) + rpad(b, 6) + rpad(c, 7) + rpad(d, 9) + e;
      lines.push(dim(irow('issue', 'sess', 'msgs', 'tokens', 'avg/m')));
      const tot = byIssue.reduce((a, g) => ({ s: a.s + g.sessions, m: a.m + g.messages, t: a.t + g.tokens }), { s: 0, m: 0, t: 0 });
      for (const g of shown) {
        lines.push(irow(issueLabel(g.issue), String(g.sessions), String(g.messages), fmtN(g.tokens), fmtN(g.avgTokensPerMsg)));
      }
      if (more > 0) lines.push('   ' + gray(`… +${more} more — press i`));
      lines.push(bold(irow('TOTAL', String(tot.s), String(tot.m), fmtN(tot.t), fmtN(tot.m ? Math.round(tot.t / tot.m) : 0))));
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
      lines.push(` ${sp} ${gray(r.t)}  ${r.method} ${r.path}${a} ${dim(`(${el}s...)`)}`);
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
    process.stdout.write(buf);
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
    line += `  ${roll}`;
    return line;
  }

  _acctGlyph(type) {
    return type === 'apikey' ? cyan('◇') : cyan('◆');
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

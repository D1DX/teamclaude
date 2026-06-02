// D-1680: in-proxy operational file-logger.
//
// Persists teamclaude's operational stream — account switches (+ reasons),
// warmer, throttle, token refresh, server errors — to a daily, greppable log
// independent of the TUI. The TUI only keeps an in-memory pane (capped, on the
// alternate screen, lost on exit), and it hijacks console.log/console.error, so
// in normal (TUI) use those lines never reach stdout. This module is the durable
// sink both paths feed: tui.js at the `_addLog` chokepoint, and index.js via a
// console tee on the headless / startup-warm path.
//
// Best-effort by design: logging must never throw into the proxy.

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TAG_RE = /^\[TeamClaude\]\s*/;
const _ensured = new Set();

// D1DX (D-1728): 24h log auto-prune. No timer — pruning is opportunistic on log
// writes, guarded to at most once/hour, plus an explicit call at server startup.
let _retentionMs = 24 * 60 * 60 * 1000;
let _lastPruneAt = 0;
const PRUNE_CHECK_MS = 60 * 60 * 1000;

/** Set the log-retention window (hours). 0/falsey disables pruning. */
export function setLogRetentionHours(hours) {
  _retentionMs = (hours && hours > 0) ? hours * 60 * 60 * 1000 : 0;
}

/**
 * Delete files in logDir older than the retention window (by mtime). Best-effort,
 * never throws. Returns the count removed. Skips subdirectories.
 */
export function pruneOldLogs(logDir, maxAgeMs = _retentionMs) {
  if (!logDir || !maxAgeMs) return 0;
  let removed = 0;
  try {
    const now = Date.now();
    for (const name of readdirSync(logDir)) {
      try {
        const p = join(logDir, name);
        const st = statSync(p);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) { unlinkSync(p); removed++; }
      } catch { /* skip one file */ }
    }
    _lastPruneAt = now;
  } catch { /* best-effort */ }
  return removed;
}

/**
 * Resolve the operational-log directory: config.logDir (set from `--log-to`),
 * with leading-~ expansion, defaulting to ~/teamclaude-logs.
 */
export function resolveLogDir(config) {
  let dir = (config && config.logDir) || join(homedir(), 'teamclaude-logs');
  if (dir === '~') dir = homedir();
  else if (dir.startsWith('~/')) dir = join(homedir(), dir.slice(2));
  return dir;
}

/** Local "YYYY-MM-DD" + "YYYY-MM-DD HH:MM:SS" — matches `date +%F`, no locale dependency. */
function localStamp(d) {
  const p = n => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { date, line: `${date} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` };
}

/**
 * Append one timestamped operational line to <logDir>/server-YYYY-MM-DD.log.
 * Local clock: the filename date rolls at local midnight (matches `date +%F`),
 * the line stamp is sortable + human-local. The `[TeamClaude]` prefix is
 * stripped for parity with the TUI pane. Swallows all errors.
 */
export function appendOpLog(logDir, msg) {
  if (!logDir || msg == null) return;
  const clean = String(msg).replace(TAG_RE, '');
  if (clean === '') return;
  try {
    if (!_ensured.has(logDir)) { mkdirSync(logDir, { recursive: true }); _ensured.add(logDir); }
    const { date, line } = localStamp(new Date());
    appendFileSync(join(logDir, `server-${date}.log`), `[${line}] ${clean}\n`);
    // D1DX (D-1728): opportunistic 24h prune, guarded to at most once/hour so a
    // long-running proxy keeps cleaning up without a timer.
    const now = Date.now();
    if (_retentionMs && now - _lastPruneAt > PRUNE_CHECK_MS) pruneOldLogs(logDir);
  } catch {
    // best-effort: never throw from logging
  }
}

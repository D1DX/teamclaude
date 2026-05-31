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

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TAG_RE = /^\[TeamClaude\]\s*/;
const _ensured = new Set();

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
  } catch {
    // best-effort: never throw from logging
  }
}

import { TUI } from '../../tui.js';
import { DeckSnapshotSource } from '../../deck-source.js';
import { loadOrCreateConfig } from '../../config.js';
import { argValue } from '../shared.js';

// ── watch (D-2485) ──────────────────────────────────────────
// Read-only Deck viewer. Renders the IDENTICAL tui.js Deck from a polled
// /teamclaude/deck snapshot of a SEPARATELY-running proxy — no port bind, no
// server, no account mutation. Solves the "you must BE the server to see the
// Deck" conflict (two servers can't share :3456): run the proxy headless/in the
// background, watch it live from here, alongside it, with zero conflict.
export async function watchCommand() {
  const config = await loadOrCreateConfig();
  const port = config.proxy.port;

  // The Deck is a full-screen TUI — it needs an interactive terminal. For a
  // one-shot, pipe-friendly view there is already `teamclaude status`.
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('teamclaude watch needs an interactive terminal (TTY).');
    console.error('For a non-interactive snapshot, use: teamclaude status');
    process.exit(1);
  }

  const intervalSec = Math.max(0.5, parseFloat(argValue('--interval')) || 2);
  const url = `http://localhost:${port}/teamclaude/deck`;
  const headers = { 'x-api-key': config.proxy.apiKey };

  const source = new DeckSnapshotSource({});
  let pollTimer = null;
  const cleanup = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };

  const tui = new TUI({
    accountManager: source,
    config,
    readOnly: true,
    // q / Ctrl-C in the Deck → leave the viewer ONLY. There is no server to
    // close (the watched proxy keeps running untouched).
    onQuit: () => { cleanup(); process.exit(0); },
  });

  // Start disconnected — the first poll flips it live (or shows the retry banner).
  tui.connState = { ok: false, msg: `connecting to proxy on :${port}…` };
  tui.start();

  const poll = async () => {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = await res.json();
      source.update(snap);
      tui.activeCount = snap.activeLLM ?? 0;
      // D-2697: feed the live request stream into the viewer's Activity panel.
      // The snapshot now carries active rows (flattened from the server's Map)
      // + the recent log; rebuild the Map the TUI's Activity render reads
      // (tui.js:951-972) so the centralized Deck shows the live request log.
      tui.active = new Map((snap.active || []).map(r => [r.id, r]));
      tui.log = Array.isArray(snap.log) ? snap.log : [];
      tui.connState = { ok: true, msg: '' };
    } catch (err) {
      // Keep the last-known snapshot visible behind the banner; just retry.
      tui.connState = { ok: false, msg: `proxy unreachable on :${port} — retrying every ${intervalSec}s (${err.message})` };
    }
    if (tui.running) tui.render();
  };

  await poll();                                  // immediate first paint
  pollTimer = setInterval(poll, intervalSec * 1000);

  // Backup signal handlers (raw-mode Ctrl-C arrives as data, handled by the TUI;
  // these cover a non-raw kill). Restore the terminal before exiting.
  const bail = () => { cleanup(); try { tui.stop(); } catch {} process.exit(0); };
  process.on('SIGINT', bail);
  process.on('SIGTERM', bail);
}

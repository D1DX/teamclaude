import { join } from 'node:path';
import { AccountManager } from '../../account-manager.js';
import { createProxyServer } from '../../server.js';
import { TUI } from '../../tui.js';
import { loadOrCreateConfig, loadConfig, saveConfig, saveConfigSync, atomicConfigUpdate } from '../../config.js';
import { resolveLogDir, appendOpLog, pruneOldLogs, setLogRetentionHours } from '../../oplog.js';
import { BUILD } from '../../version.js';
import { argValue, resolveAccounts, findConfigAccount, syncAccountsFromDisk } from '../shared.js';

// ── server ──────────────────────────────────────────────────

export async function serverCommand() {
  const config = await loadOrCreateConfig();

  // --log-to <dir>
  const logTo = argValue('--log-to');
  if (logTo) config.logDir = logTo;

  if (config.accounts.length === 0) {
    console.error('No accounts configured.\n');
    console.error('Add an account first:');
    console.error('  teamclaude import           Import from Claude Code');
    console.error('  teamclaude login            OAuth login via browser');
    console.error('  teamclaude login --api      Add an API key');
    process.exit(1);
  }

  const accounts = await resolveAccounts(config);
  if (accounts.length === 0) {
    console.error('No valid accounts after initialization');
    process.exit(1);
  }

  const threshold = config.switchThreshold || 0.98;
  // D1DX (D-2179): capacity-aware routing — session-sticky + least-loaded selection,
  // escalating 429 backoff, learned-cap capacity model. Defaults cover configs
  // predating the keys.
  const opts = {
    // Cache-affinity (selection)
    cacheAffinityWindowSec: config.cacheAffinityWindowSec ?? 300,
    bindingEvictSec: config.bindingEvictSec ?? 1800,
    // Pace-to-weekly-line controller (D-2104, real-data rebuild)
    farOverLineThreshold: config.farOverLineThreshold ?? 0.10, // rebind a warm session only when this far past its weekly line
    rampTiers: config.rampTiers ?? undefined,                  // hours→weight ramp before 7d-reset (constructor default)
    paceTieBand: config.paceTieBand ?? 0.10,                   // anti-dogpile: accounts within this of the best paceScore spread by load
    maxInflightPerAccount: config.maxInflightPerAccount ?? 5,  // atomic in-flight cap per account — D-2236
    maxSessionsPerAccount: config.maxSessionsPerAccount ?? 7,  // hard cap on bound warm sessions per account (instances limit) — D-2236
    premiumModelPattern: config.premiumModelPattern ?? 'fable|mythos', // DL-2841: regex for the flagship/premium weekly tier (Anthropic's 7d_oi sub-axis) — a premium-capped account is skipped for these models only, stays usable for the rest
    // 429 handling — reactive-only bench
    backoffSec: config.backoffSec ?? 60,           // all-throttled client retry-after floor
    allThrottledCapSec: config.allThrottledCapSec ?? 600,
    // Capacity model (reporting only)
    capSoftCeiling: config.capSoftCeiling ?? 0.75,
    softConcurrencyPerAccount: config.softConcurrencyPerAccount ?? 3,
    // Ledger (observability)
    ledgerRetentionHours: config.ledgerRetentionHours ?? 168,
    ledgerSaveSec: config.ledgerSaveSec ?? 10,
  };
  const accountManager = new AccountManager(accounts, threshold, opts);

  // D1DX (D-1728 S6): durable per-issue usage ledger — load at startup so totals
  // survive a restart; saved debounced on the hot path + on shutdown below.
  accountManager.setLedgerPath(join(resolveLogDir(config), 'usage-ledger.json'));
  accountManager.loadLedger();

  // Persist refreshed tokens back to config (re-read from disk to avoid clobbering
  // accounts added externally, e.g. by `teamclaude import` while server is running)
  accountManager.onTokenRefresh((idx, newTokens) => {
    const account = accountManager.accounts[idx];
    if (!account) return;
    // Keep config.accounts in sync so TUI saveConfig doesn't clobber fresh tokens
    if (config.accounts[idx]) {
      config.accounts[idx].accessToken = newTokens.accessToken;
      config.accounts[idx].refreshToken = newTokens.refreshToken;
      config.accounts[idx].expiresAt = newTokens.expiresAt;
    }
    atomicConfigUpdate(diskConfig => {
      // Pick up any new accounts from disk so index matching stays correct
      // (only add, don't refresh credentials — we're about to write the authoritative tokens)
      for (const diskAcct of diskConfig.accounts) {
        const known = (diskAcct.accountUuid && config.accounts.some(a => a.accountUuid === diskAcct.accountUuid))
          || config.accounts.some(a => a.name === diskAcct.name);
        if (!known) {
          config.accounts.push(diskAcct);
          accountManager.addAccount(diskAcct);
        }
      }
      // Match by UUID first, then by name — index may have shifted
      const cfgIdx = findConfigAccount(diskConfig, account);
      if (cfgIdx >= 0) {
        diskConfig.accounts[cfgIdx].accessToken = newTokens.accessToken;
        diskConfig.accounts[cfgIdx].refreshToken = newTokens.refreshToken;
        diskConfig.accounts[cfgIdx].expiresAt = newTokens.expiresAt;
      }
    }).catch(err => console.error(`[TeamClaude] Failed to save refreshed token: ${err.message}`));
  });

  // D-2286: flush the freshest tokens to disk SYNCHRONOUSLY on every exit path.
  // Anthropic rotates the refresh token on each refresh; onTokenRefresh (above) mirrors
  // the rotated token into config.accounts synchronously but writes disk ASYNC. If the
  // operator quits the Deck (or a signal kills the process) while that write is in flight,
  // the next boot loads the rotated-but-unpersisted (now-invalid) refresh token →
  // invalid_grant kills the whole grant (the recurring cherry/banana deaths, D-2286 S3-tail).
  // A sync flush on exit closes that window. (Residual narrow gap: a refresh whose HTTP
  // round-trip is still in flight at quit — config holds the pre-rotation token then; not
  // worth making the exit path async to cover.)
  let _tokensFlushed = false;
  const flushTokensSync = () => {
    if (_tokensFlushed) return;
    _tokensFlushed = true;
    try { saveConfigSync(config); } catch {}
  };

  const port = config.proxy.port;
  const useTUI = process.stdout.isTTY && process.stdin.isTTY;

  let tui = null;
  let hooks = {};

  if (useTUI) {
    tui = new TUI({
      accountManager, config,
      saveConfig: () => atomicConfigUpdate(async diskConfig => {
        // Write in-memory accounts as the authoritative state, preserving
        // extra disk-only fields (e.g. importFrom) where the account still exists.
        // Use live tokens from AccountManager (not the stale config.accounts copy).
        diskConfig.accounts = config.accounts.map((a, i) => {
          const am = accountManager.accounts[i];
          const live = am ? {
            ...a,
            accessToken: am.credential,
            refreshToken: am.refreshToken,
            expiresAt: am.expiresAt,
          } : a;
          const diskAcct = diskConfig.accounts.find(
            d => (a.accountUuid && d.accountUuid === a.accountUuid) || d.name === a.name
          );
          return diskAcct ? { ...diskAcct, ...live } : live;
        });
      }),
      syncAccounts: async () => {
        const diskConfig = await loadConfig();
        if (!diskConfig) return 0;
        return syncAccountsFromDisk(diskConfig, config, accountManager);
      },
      onQuit: () => { flushTokensSync(); accountManager.saveLedger(); server.close(() => process.exit(0)); },
    });
    hooks = {
      onRequestStart: (id, info) => tui.onRequestStart(id, info),
      onRequestRouted: (id, info) => tui.onRequestRouted(id, info),
      onRequestEnd: (id, info) => tui.onRequestEnd(id, info),
    };
  } else {
    // D-2697: headless/centralized mode has no TUI to track the live request
    // stream, so feed AccountManager's in-memory active-map + log ring directly.
    // getDeckSnapshot() then ships them and a remote `teamclaude watch` viewer
    // renders the ORIGINAL Activity panel — the live request log the interactive
    // Deck has always shown, now visible centrally.
    hooks = {
      onRequestStart: (id, info) => accountManager.onRequestStart(id, info),
      onRequestRouted: (id, info) => accountManager.onRequestRouted(id, info),
      onRequestEnd: (id, info) => accountManager.onRequestEnd(id, info),
    };
  }

  // D-1680: tee the operational console stream to a daily file. Installed BEFORE
  // warmAll so the startup-warm lines are captured in both modes. In headless
  // mode this covers the whole process lifetime; in TUI mode tui.start() then
  // redirects console to the in-memory pane and the _addLog patch (tui.js) takes
  // over filing from there — so there is no double-write and no gap. The original
  // stdout/stderr are preserved (headless visibility + the pre-TUI startup flash).
  // D-2286: swallow EPIPE/EIO on the std streams. When the controlling terminal
  // backgrounds, scrolls, or its pty buffer fills, a write
  // to stdout/stderr raises EPIPE/EIO. Without these listeners Node turns that stream
  // 'error' into an uncaughtException; the crash handler below then logged it via
  // console.error → another terminal write → another EIO → a self-amplifying storm
  // (observed once as a multi-million-line log storm within minutes). The oplog FILE write is independent, so
  // dropping the terminal write loses nothing.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (e) => { if (e && (e.code === 'EPIPE' || e.code === 'EIO')) return; });
  }

  // opLogDir hoisted to serverCommand scope (D-2286) so the crash handlers below can
  // write to the file directly, never through the patched (TUI-rerouted) console.
  const opLogDir = resolveLogDir(config);
  {
    // D1DX (D-1728): 24h log retention — set the window + prune once at startup
    // (the opportunistic hourly prune in appendOpLog covers long-running uptime).
    setLogRetentionHours(config.logRetentionHours ?? 24);
    const pruned = pruneOldLogs(opLogDir);
    if (pruned > 0) console.log(`[TeamClaude] Pruned ${pruned} log file(s) older than ${config.logRetentionHours ?? 24}h`);
    const origLog = console.log;
    const origErr = console.error;
    // D-2286: appendOpLog (file) is independent and always runs; the terminal write is
    // wrapped so a synchronous EIO/EPIPE throw can't propagate out of console.* into
    // the request path or the crash handler.
    console.log = (...a) => { appendOpLog(opLogDir, a.join(' ')); try { origLog(...a); } catch {} };
    console.error = (...a) => { appendOpLog(opLogDir, a.join(' ')); try { origErr(...a); } catch {} };
  }

  const server = createProxyServer(accountManager, config, hooks);

  // D1DX patch: warm BEFORE listening so request #1 is never blind — quota populated
  // and 5h windows anchored before any client request is served. Awaited (adds ~1-2s
  // to boot), but bounded by a 15s deadline so a hung upstream can't block boot
  // indefinitely; best-effort either way (warmAll catches per-account). No timer.
  if (config.warmOnStartup !== false) {
    let deadline;
    const warmDeadline = new Promise(resolve => { deadline = setTimeout(resolve, 15000); });
    await Promise.race([
      accountManager.warmAll(config.upstream || 'https://api.anthropic.com').catch(() => {}),
      warmDeadline,
    ]);
    clearTimeout(deadline);

    // DL-3024 F2: post-warm reconciliation flush. warmAll refreshes every expired
    // account concurrently; each success fires onTokenRefresh → atomicConfigUpdate
    // (now serialized, F1). Those persists are fire-and-forget, so some may still be
    // queued when the race resolves. One authoritative full-config write from the
    // in-memory AccountManager tokens — enqueued behind them via the same serialized
    // queue, so it runs LAST and self-heals any residual stranding before we serve a
    // single request. Best-effort: F1 is the correctness guarantee, this is belt-and-braces.
    await atomicConfigUpdate(diskConfig => {
      // Pick up any accounts added on disk since boot (parity with onTokenRefresh).
      for (const diskAcct of diskConfig.accounts) {
        const known = (diskAcct.accountUuid && config.accounts.some(a => a.accountUuid === diskAcct.accountUuid))
          || config.accounts.some(a => a.name === diskAcct.name);
        if (!known) {
          config.accounts.push(diskAcct);
          accountManager.addAccount(diskAcct);
        }
      }
      // Write each known account's LIVE token (from AccountManager, the authoritative
      // post-refresh state) over the disk copy — never the stale config.accounts mirror.
      for (let i = 0; i < config.accounts.length; i++) {
        const am = accountManager.accounts[i];
        if (!am) continue;
        const cfgIdx = findConfigAccount(diskConfig, config.accounts[i]);
        if (cfgIdx < 0) continue;
        if (am.credential != null) diskConfig.accounts[cfgIdx].accessToken = am.credential;
        if (am.refreshToken != null) diskConfig.accounts[cfgIdx].refreshToken = am.refreshToken;
        if (am.expiresAt != null) diskConfig.accounts[cfgIdx].expiresAt = am.expiresAt;
      }
    }).catch(err => console.error(`[TeamClaude] Post-warm reconciliation flush failed: ${err.message}`));
  }

  // D-1644: bind loopback-only (::1) by default — reachable only from this host
  // (not LAN/tailnet); localhost resolves to ::1 first on macOS, the path Claude
  // Code already uses. D-2646: TEAMCLAUDE_BIND overrides the bind address for a
  // containerized deploy, where a netns-shared inbound DNAT arrives on the
  // network iface (not loopback) so the server must bind 0.0.0.0. Exposure stays
  // private-network-only via the host port map on the netns sidecar.
  const bindAddr = process.env.TEAMCLAUDE_BIND || '::1';
  server.listen(port, bindAddr, () => {
    if (tui) {
      tui.start();
      console.log(`Listening on port ${port} with ${accounts.length} account(s) (build ${BUILD})`);
    } else {
      const sep = '='.repeat(60);
      console.log('');
      console.log(sep);
      console.log('  TeamClaude Proxy');
      console.log(sep);
      console.log(`  Port:       ${port}`);
      console.log(`  Accounts:   ${accounts.length}`);
      console.log(`  Build:      ${BUILD}`);
      console.log(`  Threshold:  ${(threshold * 100).toFixed(0)}%`);
      console.log(`  Upstream:   ${config.upstream || 'https://api.anthropic.com'}`);
      console.log('');
      accounts.forEach((a, i) => {
        console.log(`  [${i + 1}] ${a.name} (${a.type})`);
      });
      console.log('');
      console.log('  Run Claude through proxy:  teamclaude run');
      console.log('  Show env vars:             teamclaude env');
      console.log(sep);
      console.log('');
    }
  });

  // D-2236: process-level safety net. The per-request handler (server.js) catches
  // throws on the request path, but a throw OUTSIDE it — the startup warmer, the
  // ledger save, any timer — had no handler: Node would print to stderr and exit,
  // killing the proxy with no oplog line (an invisible "crash"). We keep the proxy
  // alive (each request still has its own try/catch); a genuinely corrupt state
  // surfaces as logged errors the operator can act on. saveLedger() on uncaught so
  // usage state survives the event.
  //
  // D-2286: EIO-safe crash logging. Do NOT route through console.error here — in TUI
  // mode console.error is patched to _addLog → render() → process.stdout.write, so a
  // crash CAUSED by an EIO terminal write would re-enter that same write and loop (the
  // 06-15 storm). Write straight to the oplog FILE (independent of the terminal) plus a
  // guarded raw stderr, behind a re-entrancy flag so a throw inside the handler can
  // never re-arm it. A bare EPIPE/EIO is a terminal-write fault, not a real fault — skip
  // it entirely (still saveLedger on uncaught).
  let _inCrashHandler = false;
  const crashLog = (label, detail) => {
    if (_inCrashHandler) return;
    _inCrashHandler = true;
    try {
      const line = `[TeamClaude] ${label}: ${detail}`;
      try { appendOpLog(opLogDir, line); } catch {}
      try { process.stderr.write(line + '\n'); } catch {}
    } finally {
      _inCrashHandler = false;
    }
  };
  process.on('unhandledRejection', (reason) => {
    if (reason && (reason.code === 'EPIPE' || reason.code === 'EIO')) return;
    crashLog('Unhandled promise rejection', reason && reason.stack ? reason.stack : reason);
  });
  process.on('uncaughtException', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'EIO')) { try { accountManager.saveLedger(); } catch {} return; }
    crashLog('Uncaught exception', err && err.stack ? err.stack : err);
    try { accountManager.saveLedger(); } catch {}
  });

  if (!tui) {
    process.on('SIGINT', () => {
      console.log('\n[TeamClaude] Shutting down...');
      flushTokensSync();
      accountManager.saveLedger();
      server.close(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      console.log('\n[TeamClaude] Shutting down...');
      flushTokensSync();
      accountManager.saveLedger();
      server.close(() => process.exit(0));
    });
  }
}

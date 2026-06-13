#!/usr/bin/env node

import { spawnSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { loadOrCreateConfig, loadConfig, saveConfig, atomicConfigUpdate, getConfigPath } from './config.js';
import { AccountManager } from './account-manager.js';
import { createProxyServer } from './server.js';
import { importCredentials, loginOAuth, fetchProfile, refreshAccessToken, isTokenExpiringSoon } from './oauth.js';
import { TUI } from './tui.js';
import { resolveLogDir, appendOpLog, pruneOldLogs, setLogRetentionHours } from './oplog.js';
import { join } from 'node:path';

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'server':
    await serverCommand();
    break;
  case 'run':
    await runCommand();
    break;
  case 'import':
    await importCommand();
    process.exit(0);
    break;
  case 'login':
    await loginCommand();
    process.exit(0);
    break;
  case 'env':
    await envCommand();
    process.exit(0);
    break;
  case 'status':
    await statusCommand();
    process.exit(0);
    break;
  case 'capacity':
    await capacityCommand();
    process.exit(0);
    break;
  case 'accounts':
    await accountsCommand();
    process.exit(0);
    break;
  case 'remove':
    await removeCommand();
    process.exit(0);
    break;
  case 'api':
    await apiCommand();
    process.exit(0);
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    // No command or unknown command → start server
    if (command && !command.startsWith('-')) {
      console.error(`Unknown command: ${command}\n`);
      showHelp();
      process.exit(1);
    }
    await serverCommand();
    break;
}

// ── server ──────────────────────────────────────────────────

async function serverCommand() {
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
    // 429 handling — escalating backoff
    backoffSec: config.backoffSec ?? 60,           // streak-1 bench (ladder base)
    backoffFactor: config.backoffFactor ?? 4,      // ×per consecutive 429
    backoffCapSec: config.backoffCapSec ?? 900,    // ladder ceiling (15m)
    allThrottledCapSec: config.allThrottledCapSec ?? 600,
    // Capacity model
    capEmaAlpha: config.capEmaAlpha ?? 0.3,
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
      onQuit: () => { accountManager.saveLedger(); server.close(() => process.exit(0)); },
    });
    hooks = {
      onRequestStart: (id, info) => tui.onRequestStart(id, info),
      onRequestRouted: (id, info) => tui.onRequestRouted(id, info),
      onRequestEnd: (id, info) => tui.onRequestEnd(id, info),
    };
  }

  // D-1680: tee the operational console stream to a daily file. Installed BEFORE
  // warmAll so the startup-warm lines are captured in both modes. In headless
  // mode this covers the whole process lifetime; in TUI mode tui.start() then
  // redirects console to the in-memory pane and the _addLog patch (tui.js) takes
  // over filing from there — so there is no double-write and no gap. The original
  // stdout/stderr are preserved (headless visibility + the pre-TUI startup flash).
  {
    const opLogDir = resolveLogDir(config);
    // D1DX (D-1728): 24h log retention — set the window + prune once at startup
    // (the opportunistic hourly prune in appendOpLog covers long-running uptime).
    setLogRetentionHours(config.logRetentionHours ?? 24);
    const pruned = pruneOldLogs(opLogDir);
    if (pruned > 0) console.log(`[TeamClaude] Pruned ${pruned} log file(s) older than ${config.logRetentionHours ?? 24}h`);
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => { appendOpLog(opLogDir, a.join(' ')); origLog(...a); };
    console.error = (...a) => { appendOpLog(opLogDir, a.join(' ')); origErr(...a); };
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
  }

  // D-1644: bind loopback-only (::1) instead of the default 0.0.0.0/:: wildcard,
  // so the proxy is reachable only from this host (not LAN/tailnet). localhost
  // resolves to ::1 first on macOS, which is the path Claude Code already uses.
  server.listen(port, '::1', () => {
    if (tui) {
      tui.start();
      console.log(`Listening on port ${port} with ${accounts.length} account(s)`);
    } else {
      const sep = '='.repeat(60);
      console.log('');
      console.log(sep);
      console.log('  TeamClaude Proxy');
      console.log(sep);
      console.log(`  Port:       ${port}`);
      console.log(`  Accounts:   ${accounts.length}`);
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

  if (!tui) {
    process.on('SIGINT', () => {
      console.log('\n[TeamClaude] Shutting down...');
      accountManager.saveLedger();
      server.close(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      console.log('\n[TeamClaude] Shutting down...');
      accountManager.saveLedger();
      server.close(() => process.exit(0));
    });
  }
}

// ── import ──────────────────────────────────────────────────

async function importCommand() {
  const config = await loadOrCreateConfig();

  let name = argValue('--name');
  const jsonStr = argValue('--json');

  let creds;
  if (jsonStr) {
    // Accept raw JSON: --json '{"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}'
    // or flat: --json '{"accessToken":"...","refreshToken":"...","expiresAt":...}'
    try {
      const raw = JSON.parse(jsonStr);
      const data = raw.claudeAiOauth || raw;
      if (!data.accessToken) {
        console.error('JSON must contain "accessToken" (directly or under "claudeAiOauth")');
        process.exit(1);
      }
      creds = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: data.expiresAt,
      };
    } catch (err) {
      console.error(`Failed to parse --json: ${err.message}`);
      process.exit(1);
    }
  } else {
    const fromPath = argValue('--from') || '~/.claude/.credentials.json';
    try {
      creds = await importCredentials(fromPath);
    } catch (err) {
      console.error(`Failed to import from ${fromPath}: ${err.message}`);
      process.exit(1);
    }
  }

  await upsertOAuthAccount(config, name, creds, 'import');
}

// ── login ───────────────────────────────────────────────────

async function loginCommand() {
  if (args.includes('--api')) {
    await loginApiCommand();
    return;
  }
  if (args.includes('--oauth')) {
    await loginOAuthCommand();
    return;
  }

  // Default to OAuth if not a TTY
  if (!process.stdout.isTTY) {
    await loginOAuthCommand();
    return;
  }

  // Interactive menu
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  console.log('Select login method:\n');
  console.log('  1. Claude subscription  (Pro, Max, Team, Enterprise)');
  console.log('  2. Anthropic API key    (Console API billing)');
  console.log('');
  const choice = await new Promise(resolve => rl.question('Choice [1]: ', resolve));
  rl.close();

  switch (choice.trim() || '1') {
    case '1': await loginOAuthCommand(); break;
    case '2': await loginApiCommand(); break;
    default:
      console.error(`Invalid choice: ${choice.trim()}`);
      process.exit(1);
  }
}

async function loginApiCommand() {
  const config = await loadOrCreateConfig();
  let name = argValue('--name');

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const apiKey = await new Promise(resolve => rl.question('Anthropic API key: ', resolve));
  rl.close();

  if (!apiKey.trim()) {
    console.error('No API key provided');
    process.exit(1);
  }

  if (!name) {
    const n = config.accounts.filter(a => a.name.startsWith('api-')).length + 1;
    name = `api-${n}`;
  }

  config.accounts.push({ name, type: 'apikey', apiKey: apiKey.trim() });
  await saveConfig(config);
  console.log(`Added API key account "${name}"`);
  console.log(`Saved to ${getConfigPath()}`);
}

async function loginOAuthCommand() {
  const config = await loadOrCreateConfig();
  let name = argValue('--name');

  console.log('Starting OAuth login...');
  let creds;
  try {
    creds = await loginOAuth();
  } catch (err) {
    console.error(`OAuth login failed: ${err.message}`);
    console.error('');
    console.error('Alternatives:');
    console.error('  teamclaude import        Import from existing Claude Code credentials');
    console.error('  teamclaude login --api   Add an API key instead');
    process.exit(1);
  }

  await upsertOAuthAccount(config, name, creds, 'login');
}

// ── env ─────────────────────────────────────────────────────

async function envCommand() {
  const config = await loadOrCreateConfig();
  console.log(`export ANTHROPIC_BASE_URL=http://localhost:${config.proxy.port}`);
  console.log(`export ANTHROPIC_API_KEY=${config.proxy.apiKey}`);
}

// ── run ─────────────────────────────────────────────────────

async function runCommand() {
  const config = await loadOrCreateConfig();

  // Everything after 'run' (skip -- separator if present)
  const claudeArgs = args.slice(1);
  if (claudeArgs[0] === '--') claudeArgs.shift();

  // Only set ANTHROPIC_BASE_URL — Claude Code keeps its own OAuth token
  // which the proxy accepts from localhost. Not setting ANTHROPIC_API_KEY
  // lets Claude Code stay in subscription mode (full model access).
  // Use spawnSync so the Node process blocks entirely — behaves like execvp.
  const result = spawnSync('claude', claudeArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${config.proxy.port}`,
    },
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error('Claude Code not found in PATH. Install it first.');
    } else {
      console.error(`Failed to start claude: ${result.error.message}`);
    }
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

// ── status ──────────────────────────────────────────────────

async function statusCommand() {
  const config = await loadOrCreateConfig();
  const url = `http://localhost:${config.proxy.port}/teamclaude/status`;

  try {
    const res = await fetch(url, { headers: { 'x-api-key': config.proxy.apiKey } });
    const data = await res.json();

    // D1DX (D-1728): dashboard formatters (shared by every section below).
    const fmtN = n => n == null ? '-' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
    const fmtDur = s => { if (s == null) return '-'; if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm'; const h = Math.floor(m / 60), rm = m % 60; if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`; const d = Math.floor(h / 24); return `${d}d${h % 24}h`; };
    const pad = (s, w) => String(s).padEnd(w);

    // D1DX (D-1728 S8): health + host resources up top.
    const sys = data.system || {};
    let wired = 'unknown';
    try {
      const st = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf-8'));
      wired = (st.env?.ANTHROPIC_BASE_URL === `http://localhost:${config.proxy.port}` && st.apiKeyHelper)
        ? 'wired (ANTHROPIC_BASE_URL + apiKeyHelper)'
        : 'NOT fully wired — run scripts/teamclaude-proxy-enable.sh';
    } catch { /* settings.json unreadable */ }
    const gb = mb => mb == null ? '?' : (mb / 1024).toFixed(1);
    console.log(`Proxy:    UP · port ${config.proxy.port} · up ${fmtDur(sys.proxyUptimeSec)} · proxy RSS ${sys.proxyRssMB ?? '?'}MB`);
    console.log(`Routing:  ${wired}`);
    console.log(`System:   RAM ${gb(sys.usedMemMB)}/${gb(sys.totalMemMB)}GB (${sys.usedMemPct ?? '?'}%) · cpu ${sys.cpuBusyPct ?? '?'}% busy · load ${(sys.loadAvg || []).join(' ')} · ${sys.cpuCount ?? '?'} cpus`);
    console.log('');

    console.log(`Active account: ${data.currentAccount}`);
    console.log(`Switch at:      ${(data.switchThreshold * 100).toFixed(0)}% usage\n`);

    for (const acct of data.accounts) {
      const q = acct.quota;
      const current = acct.name === data.currentAccount ? ' *' : '';

      console.log(`  ${acct.name} (${acct.type})${current}`);
      console.log(`    Status:   ${acct.status}`);

      if (q.unified5h != null || q.unified7d != null) {
        const ses = q.unified5h != null ? (q.unified5h * 100).toFixed(1) + '%' : '-';
        const wk = q.unified7d != null ? (q.unified7d * 100).toFixed(1) + '%' : '-';
        console.log(`    Session:  ${ses} used    Weekly: ${wk} used`);
      } else {
        const tok = q.tokensLimit ? ((1 - q.tokensRemaining / q.tokensLimit) * 100).toFixed(1) + '%' : '-';
        const req = q.requestsLimit ? ((1 - q.requestsRemaining / q.requestsLimit) * 100).toFixed(1) + '%' : '-';
        console.log(`    Tokens:   ${tok} used    Requests: ${req} used`);
      }

      console.log(`    Total:    ${acct.usage.totalInputTokens + acct.usage.totalOutputTokens} tokens, ${acct.usage.totalRequests} requests`);
      if (acct.rateLimitedUntil) console.log(`    Throttled until: ${acct.rateLimitedUntil}`);
      console.log('');
    }

    // D1DX (D-1728): live per-session cache-affinity dashboard + per-instance
    // mem/CPU (resolved locally via `ps` on each session's Claude pid) + TOTAL.
    const binds = data.sessionBindings || [];
    const agg = data.sessionAggregate;
    if (binds.length > 0) {
      const pids = binds.map(b => b.pid).filter(Boolean);
      const psMap = {};
      if (pids.length) {
        try {
          const out = execSync(`ps -o pid=,rss=,pcpu= -p ${pids.join(',')}`, { encoding: 'utf-8' });
          for (const ln of out.trim().split('\n')) {
            const m = ln.trim().split(/\s+/);
            if (m.length >= 3) psMap[m[0]] = { rssMB: Math.round(+m[1] / 1024), cpu: +m[2] };
          }
        } catch { /* ps unavailable */ }
      }
      console.log(`Sessions: ${binds.length} bound (${agg ? agg.warm : 0} warm)`);
      console.log('  ' + pad('session', 14) + pad('acct', 9) + pad('elapsed', 8) + pad('msgs', 6) + pad('tokens', 8) + pad('avg/m', 8) + pad('tok/min', 8) + pad('mem', 7) + pad('cpu', 6) + 'state');
      let pm = 0;
      for (const b of binds) {
        const who = (b.emoji ? b.emoji + ' ' : '') + (b.issue || b.sid8);
        const state = b.warm ? 'warm' : `idle ${fmtDur(b.idleSec)}`;
        const ps = psMap[b.pid] || {};
        if (ps.rssMB) pm += ps.rssMB;
        const mem = ps.rssMB != null ? ps.rssMB + 'MB' : '-';
        const cpu = ps.cpu != null ? ps.cpu + '%' : '-';
        console.log('  ' + pad(who, 14) + pad(b.account, 9) + pad(fmtDur(b.elapsedSec), 8) + pad(b.requests, 6) + pad(fmtN(b.tokens), 8) + pad(fmtN(b.avgTokensPerMsg), 8) + pad(fmtN(b.tokensPerMin), 8) + pad(mem, 7) + pad(cpu, 6) + state);
      }
      if (agg) console.log('  ' + pad('TOTAL', 14) + pad('', 9) + pad(fmtDur(agg.elapsedSec), 8) + pad(agg.requests, 6) + pad(fmtN(agg.tokens), 8) + pad(fmtN(agg.avgTokensPerMsg), 8) + pad(fmtN(agg.tokensPerMin), 8) + pad(pm ? pm + 'MB' : '-', 7));
      console.log('');
    }

    // D1DX (D-1728 S6): durable per-issue usage rollup (all sessions, survives restart).
    const byIssue = data.usageByIssue || [];
    if (byIssue.length > 0) {
      console.log(`By issue: ${byIssue.length}`);
      console.log('  ' + pad('issue', 14) + pad('sess', 6) + pad('msgs', 7) + pad('tokens', 9) + 'avg/m');
      const tot = byIssue.reduce((a, g) => ({ s: a.s + g.sessions, m: a.m + g.messages, t: a.t + g.tokens }), { s: 0, m: 0, t: 0 });
      for (const g of byIssue) {
        console.log('  ' + pad(g.issue, 14) + pad(g.sessions, 6) + pad(g.messages, 7) + pad(fmtN(g.tokens), 9) + fmtN(g.avgTokensPerMsg));
      }
      console.log('  ' + pad('TOTAL', 14) + pad(tot.s, 6) + pad(tot.m, 7) + pad(fmtN(tot.t), 9) + fmtN(tot.m ? Math.round(tot.t / tot.m) : 0));
      console.log('');
    }
  } catch {
    console.error(`Cannot connect to proxy at localhost:${config.proxy.port}`);
    console.error('Is the server running? Start with: teamclaude server');
    process.exit(1);
  }
}

// ── capacity (D-2179) ───────────────────────────────────────
// Pool capacity for orchestrators: verdict (green/yellow/red) + headroom
// (spare concurrent-session slots) + soonest-reset. `--json` for scripts;
// exit code green=0 / yellow=10 / red=20 so a launcher can branch on it.

function _verdictExit(v) { return v === 'green' ? 0 : v === 'yellow' ? 10 : 20; }

async function capacityCommand() {
  const config = await loadOrCreateConfig();
  const json = args.includes('--json');
  const url = `http://localhost:${config.proxy.port}/teamclaude/capacity`;
  let data;
  try {
    const res = await fetch(url, { headers: { 'x-api-key': config.proxy.apiKey } });
    data = await res.json();
  } catch (err) {
    if (json) console.log(JSON.stringify({ verdict: 'red', headroom: 0, error: 'proxy unreachable' }));
    else console.error(`Capacity: proxy unreachable on :${config.proxy.port} — ${err.message}`);
    process.exit(20);
  }
  if (json) { console.log(JSON.stringify(data)); process.exit(_verdictExit(data.verdict)); }

  const fmtN = n => n == null ? '-' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
  const fmtDur = s => { if (!s) return '-'; if (s < 60) return s + 's'; const m = Math.floor(s / 60); return m < 60 ? m + 'm' : `${Math.floor(m / 60)}h${m % 60}m`; };
  const mark = { green: '🟢', yellow: '🟡', red: '🔴' }[data.verdict] || '·';
  const reset = data.soonestResetSec ? ` · next free ${fmtDur(data.soonestResetSec)}` : '';
  console.log(`${mark} ${String(data.verdict).toUpperCase()}  headroom ${data.headroom} session(s) · live ${data.liveAccounts}/${data.total} · benched ${data.benched} · warm ${data.warmSessions}${reset}`);
  for (const a of (data.accounts || [])) {
    const state = a.benched ? `benched ${fmtDur(a.benchSec)} (streak ${a.streak})`
      : a.nearCap ? 'near cap'
      : a.live ? 'live' : a.status;
    const cap = a.capEst5h != null
      ? ` · burn ${fmtN(a.burn5h)}/${fmtN(Math.round(a.capEst5h))} (5h)`
      : ` · burn ${fmtN(a.burn5h)} (5h, cap unlearned)`;
    console.log(`  ${String(a.name).padEnd(8)} ${state}${cap}`);
  }
  process.exit(_verdictExit(data.verdict));
}

// ── accounts ────────────────────────────────────────────────

async function accountsCommand() {
  const config = await loadOrCreateConfig();
  const verbose = args.includes('-v') || args.includes('--verbose');

  if (config.accounts.length === 0) {
    console.log('No accounts configured.');
    console.log('Add one with: teamclaude import, teamclaude login, or teamclaude login --api');
    return;
  }

  // Refresh expired tokens before fetching profiles
  let configDirty = false;
  await Promise.all(config.accounts.map(async (a) => {
    if (a.type !== 'oauth' || !a.refreshToken) return;
    if (!isTokenExpiringSoon(a.expiresAt)) return;
    try {
      const newTokens = await refreshAccessToken(a.refreshToken);
      a.accessToken = newTokens.accessToken;
      a.refreshToken = newTokens.refreshToken;
      a.expiresAt = newTokens.expiresAt;
      configDirty = true;
    } catch (err) {
      // refresh failed — fetchProfile will report the specific error
    }
  }));
  if (configDirty) await saveConfig(config);

  // Fetch profiles in parallel for all OAuth accounts
  const profiles = await Promise.all(
    config.accounts.map(a =>
      a.type === 'oauth' && a.accessToken ? fetchProfile(a.accessToken) : null
    )
  );

  // Deduplicate by accountUuid — keep the last (most recently added) entry
  const seen = new Map();
  let removed = 0;
  for (let i = config.accounts.length - 1; i >= 0; i--) {
    const a = config.accounts[i];
    const uuid = profiles[i]?.accountUuid || a.accountUuid;
    if (uuid) {
      if (seen.has(uuid)) {
        config.accounts.splice(i, 1);
        profiles.splice(i, 1);
        removed++;
      } else {
        seen.set(uuid, i);
        // Update stored UUID and name from profile
        if (profiles[i] && !profiles[i].error) {
          a.accountUuid = profiles[i].accountUuid;
          if (profiles[i].email) a.name = profiles[i].email;
        }
      }
    }
  }
  if (removed > 0) {
    await saveConfig(config);
    console.log(`Removed ${removed} duplicate account(s)\n`);
  }

  for (const [i, a] of config.accounts.entries()) {
    const p = profiles[i];

    if (a.type === 'apikey') {
      console.log(`  [${i + 1}] ${a.name} (apikey)  ${a.apiKey?.slice(0, 15)}...`);
      continue;
    }

    // OAuth account
    const hasProfile = p && !p.error;
    const tier = hasProfile ? (p.hasClaudeMax ? 'Max' : p.hasClaudePro ? 'Pro' : 'subscription') : null;
    const status = hasProfile ? `Claude ${tier}` : `unknown (${p?.error || 'no token'})`;
    const src = a.source ? `, ${a.source}` : '';
    console.log(`  [${i + 1}] ${a.name} (${status}${src})`);
    if (hasProfile && p.email && p.email !== a.name) console.log(`       Email: ${p.email}`);
    if (hasProfile && p.orgName) console.log(`       Org:   ${p.orgName}`);
    if (verbose && a.expiresAt) {
      const remaining = a.expiresAt - Date.now();
      if (remaining <= 0) {
        console.log(`       Token: expired`);
      } else {
        const mins = Math.floor(remaining / 60000);
        const hrs = Math.floor(mins / 60);
        const expiry = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
        console.log(`       Token: expires in ${expiry}`);
      }
    }
  }
}

// ── api ─────────────────────────────────────────────────────

async function apiCommand() {
  const config = await loadOrCreateConfig();
  const path = args[1];

  if (!path) {
    console.error('Usage: teamclaude api <path> [--account NAME] [--method POST] [--data JSON]');
    console.error('Example: teamclaude api /api/oauth/claude_cli/roles');
    process.exit(1);
  }

  // Find account to use
  const accountName = argValue('--account');
  const method = (argValue('--method') || 'GET').toUpperCase();
  const data = argValue('--data');

  const accounts = await resolveAccounts(config);
  let account;
  if (accountName) {
    account = accounts.find(a => a.name === accountName);
    if (!account) { console.error(`Account "${accountName}" not found`); process.exit(1); }
  } else {
    account = accounts.find(a => a.type === 'oauth') || accounts[0];
    if (!account) { console.error('No accounts configured'); process.exit(1); }
  }

  const credential = account.accessToken || account.apiKey;
  const isOAuth = account.type === 'oauth';
  const upstream = config.upstream || 'https://api.anthropic.com';
  const url = path.startsWith('http') ? path : `${upstream}${path}`;

  const headers = isOAuth
    ? { 'Authorization': `Bearer ${credential}` }
    : { 'x-api-key': credential };

  const fetchOpts = { method, headers };
  if (data) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = data;
  }

  const res = await fetch(url, fetchOpts);

  // Print response headers to stderr
  console.error(`${res.status} ${res.statusText}`);
  for (const [k, v] of res.headers.entries()) {
    console.error(`  ${k}: ${v}`);
  }
  console.error('');

  // Print body to stdout
  const body = await res.text();
  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    console.log(body);
  }
}

// ── remove ──────────────────────────────────────────────────

async function removeCommand() {
  const config = await loadOrCreateConfig();
  const name = args[1];

  if (!name) {
    console.error('Usage: teamclaude remove <account-name>');
    process.exit(1);
  }

  const idx = config.accounts.findIndex(a => a.name === name);
  if (idx < 0) {
    console.error(`Account "${name}" not found`);
    process.exit(1);
  }

  config.accounts.splice(idx, 1);
  await saveConfig(config);
  console.log(`Removed account "${name}"`);
}

// ── help ────────────────────────────────────────────────────

function showHelp() {
  console.log(`TeamClaude - Multi-account Claude proxy

Usage: teamclaude [command] [options]

Commands:
  server              Start the proxy server (default)
  import              Import credentials from Claude Code
  login               OAuth login via browser
  login --api         Add an API key account
  env                 Print env vars to use with Claude
  run [-- args...]    Run Claude Code through the proxy
  status              Show proxy & account status (live)
  capacity [--json]   Pool capacity for orchestrators (verdict/headroom/reset)
  accounts            List configured accounts
  remove <name>       Remove an account
  api <path>          Call an API endpoint with account credentials
  help                Show this help

Options:
  --name NAME         Set account name (import/login)
  --from PATH         Credentials path (import, default: ~/.claude/.credentials.json)
  --json JSON         Import from inline JSON (import), e.g.:
                      --json '{"accessToken":"...","refreshToken":"...","expiresAt":1234}'
  --log-to DIR        Log full requests/responses to DIR (server, one file per request)

Config: ${getConfigPath()}
`);
}

// ── shared account upsert ────────────────────────────────────

async function upsertOAuthAccount(config, name, creds, source = 'unknown') {
  // Fetch profile to auto-name and deduplicate by account UUID
  const profile = await fetchProfile(creds.accessToken);
  const profileOk = profile && !profile.error;

  if (!profileOk) {
    console.error(`Warning: could not fetch account profile — ${profile?.error || 'no token'}`);
  }
  if (!name && profile?.email) {
    name = profile.email;
    const tier = profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : null;
    if (tier) console.log(`Detected Claude ${tier} account: ${profile.email}`);
  }
  if (!name) {
    const n = config.accounts.filter(a => a.name.startsWith('account-')).length + 1;
    name = `account-${n}`;
  }

  const account = {
    name,
    type: 'oauth',
    source,
    accountUuid: profile?.accountUuid || null,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  };

  // Deduplicate: match by UUID first, then by name
  let idx = profile?.accountUuid
    ? config.accounts.findIndex(a => a.accountUuid === profile.accountUuid)
    : -1;
  if (idx < 0) idx = config.accounts.findIndex(a => a.name === name);

  if (idx >= 0) {
    config.accounts[idx] = account;
    console.log(`Updated account "${name}"`);
  } else {
    config.accounts.push(account);
    console.log(`Added account "${name}"`);
  }

  await saveConfig(config);
  console.log(`Saved to ${getConfigPath()}`);
}

// ── config sync helpers ─────────────────────────────────────

/**
 * Find a config account entry matching an in-memory account (by UUID, then name).
 */
function findConfigAccount(diskConfig, account) {
  if (account.accountUuid) {
    const idx = diskConfig.accounts.findIndex(a => a.accountUuid === account.accountUuid);
    if (idx >= 0) return idx;
  }
  return diskConfig.accounts.findIndex(a => a.name === account.name);
}

/**
 * Sync accounts from disk config: add new accounts and refresh credentials
 * for existing ones (handles re-imported OAuth tokens, rotated API keys, etc.).
 * Returns the number of new accounts added.
 */
async function syncAccountsFromDisk(diskConfig, memConfig, accountManager) {
  let added = 0;
  for (const diskAcct of diskConfig.accounts) {
    const matchByUuid = diskAcct.accountUuid &&
      memConfig.accounts.findIndex(a => a.accountUuid === diskAcct.accountUuid);
    const matchByName = memConfig.accounts.findIndex(a => a.name === diskAcct.name);
    const memIdx = (matchByUuid >= 0 ? matchByUuid : null) ?? (matchByName >= 0 ? matchByName : -1);

    if (memIdx < 0) {
      // New account discovered on disk — add to running server
      memConfig.accounts.push(diskAcct);
      accountManager.addAccount(diskAcct);
      added++;
      console.log(`[TeamClaude] Picked up new account "${diskAcct.name}" from config`);
      // D-1820: warm the freshly-added account now (parity with startup warmAll)
      // so Reload fires the 1-token request against it immediately, instead of
      // leaving it cold until the next routed session. Best-effort + detached —
      // never block/hang the sync on a slow or hanging fetch.
      const newMgr = accountManager.accounts.find(a =>
        (diskAcct.accountUuid && a.accountUuid === diskAcct.accountUuid) || a.name === diskAcct.name);
      if (newMgr) {
        accountManager.warmOne(newMgr, memConfig.upstream || 'https://api.anthropic.com')
          .catch(err => console.error(`[TeamClaude] Warm failed for "${diskAcct.name}": ${err.message}`));
      }
      continue;
    }

    // Existing account — resolve fresh credentials from disk
    let freshCred = null;
    if (diskAcct.type === 'oauth' && diskAcct.importFrom) {
      try {
        const creds = await importCredentials(diskAcct.importFrom);
        freshCred = { accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt };
      } catch (err) {
        console.error(`[TeamClaude] Re-import failed for "${diskAcct.name}": ${err.message}`);
      }
    } else if (diskAcct.type === 'oauth' && diskAcct.accessToken) {
      freshCred = { accessToken: diskAcct.accessToken, refreshToken: diskAcct.refreshToken, expiresAt: diskAcct.expiresAt };
    } else if (diskAcct.type === 'apikey' && diskAcct.apiKey) {
      freshCred = { apiKey: diskAcct.apiKey };
    }

    if (!freshCred) continue;

    // Find the corresponding AccountManager entry and update credentials
    const mgr = accountManager.accounts.find(a =>
      (diskAcct.accountUuid && a.accountUuid === diskAcct.accountUuid) || a.name === diskAcct.name
    );
    if (!mgr) continue;

    if (freshCred.accessToken) {
      const changed = mgr.credential !== freshCred.accessToken ||
        mgr.refreshToken !== freshCred.refreshToken;
      // Don't overwrite in-memory credentials with staler ones from disk
      // (e.g. after a TUI import updated the AM before saveConfig wrote to disk)
      const diskIsStaler = freshCred.expiresAt && mgr.expiresAt &&
        freshCred.expiresAt < mgr.expiresAt;
      if (changed && !diskIsStaler) {
        accountManager.updateAccountTokens(mgr.index, freshCred);
        console.log(`[TeamClaude] Refreshed credentials for "${mgr.name}"`);
      }
    } else if (freshCred.apiKey && mgr.credential !== freshCred.apiKey) {
      mgr.credential = freshCred.apiKey;
      if (mgr.status === 'error') mgr.status = 'active';
      console.log(`[TeamClaude] Updated API key for "${mgr.name}"`);
    }
  }
  return added;
}

// ── helpers ─────────────────────────────────────────────────

async function resolveAccounts(config) {
  const accounts = [];
  for (const acct of config.accounts) {
    if (acct.type === 'oauth') {
      if (acct.importFrom) {
        try {
          const creds = await importCredentials(acct.importFrom);
          accounts.push({ name: acct.name, type: 'oauth', ...creds });
          console.log(`Imported "${acct.name}" from ${acct.importFrom}`);
        } catch (err) {
          console.error(`Failed to import "${acct.name}": ${err.message}`);
        }
      } else if (acct.accessToken) {
        accounts.push(acct);
      } else {
        console.error(`No token for "${acct.name}", skipping`);
      }
    } else if (acct.type === 'apikey' && acct.apiKey) {
      accounts.push(acct);
    }
  }
  return accounts;
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : null;
}

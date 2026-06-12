import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export function getConfigPath() {
  if (process.env.TEAMCLAUDE_CONFIG) return process.env.TEAMCLAUDE_CONFIG;
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configDir, 'teamclaude.json');
}

export function createDefaultConfig() {
  return {
    proxy: {
      port: 3456,
      apiKey: 'tc-' + randomBytes(24).toString('base64url'),
    },
    upstream: 'https://api.anthropic.com',
    warmOnStartup: true,           // ping each account at boot to anchor rate-limit windows
    // ── Routing (D1DX) — 5 knobs ──
    switchThreshold: 0.98,         // HARD ceiling — never route past this (real-429 guard)
    cacheAffinityWindowSec: 300,   // a session sticks to its account while used within this window
    bindingEvictSec: 1800,         // drop an idle session binding after this long
    backoffSec: 60,                // a 429 benches the account this long (+ jitter), then re-probe
    expiringAccounts: [],          // names whose subscription ends soon — drain to their pace line first
    paceOvershootGuard: 0.05,      // an account >this far AHEAD of its pace line takes no new work (5 pts)
    allThrottledCapSec: 600,       // max client retry-after when EVERY account is throttled
    // ── Logs + ledger (observability) ──
    logRequests: false,            // per-request full-body dumps (verbose) — debug only
    logRetentionHours: 24,         // auto-delete log files older than this (0 = never)
    ledgerRetentionHours: 168,     // keep per-issue usage ledger entries this long (7d)
    ledgerSaveSec: 10,             // debounce window for ledger disk writes
    accounts: [],
  };
}

export async function loadConfig() {
  const path = getConfigPath();
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadOrCreateConfig() {
  let config = await loadConfig();
  if (!config) {
    config = createDefaultConfig();
    await saveConfig(config);
    console.log(`Created config at ${getConfigPath()}`);
  }
  return config;
}

export async function saveConfig(config) {
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Atomically update the config: re-reads from disk, calls updater(config),
 * then saves. Returns the updated config. This prevents overwriting changes
 * made by other processes (e.g. `teamclaude import` while the server runs).
 */
export async function atomicConfigUpdate(updater) {
  const config = await loadConfig() || createDefaultConfig();
  await updater(config);
  await saveConfig(config);
  return config;
}

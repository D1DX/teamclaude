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
    // ── Routing (D1DX, D-2104) — real-data pace-to-weekly-line ──
    switchThreshold: 0.98,         // HARD unusable ceiling on real unified-5h/7d utilization
    cacheAffinityWindowSec: 300,   // a session sticks to its account while used within this window
    bindingEvictSec: 1800,         // drop an idle session binding after this long
    fiveHourSoftCeiling: 0.90,     // never-stall rail: no NEW load at/over this 5h utilization
    farOverLineThreshold: 0.10,    // rebind a warm session only when this far past its weekly pace line
    paceTieBand: 0.10,             // anti-dogpile: accounts within this of the best paceScore spread by load
    maxInflightPerAccount: 3,      // hard never-stall valve: max concurrent in-flight requests per account
    backoffSec: 60,                // 429 escalating-backoff base: streak-1 bench (+ jitter)
    backoffFactor: 4,              // ×per consecutive 429 (60s → 4m → 15m)
    backoffCapSec: 900,            // escalating-backoff ceiling (15m)
    allThrottledCapSec: 600,       // max client retry-after when EVERY account is throttled
    // ── Capacity model (D-2179) ──
    capEmaAlpha: 0.3,              // EMA weight when learning an account's 5h cap from 429s
    capSoftCeiling: 0.75,          // publish headroom below this fraction of the learned cap
    softConcurrencyPerAccount: 3,  // warm sessions per live account before headroom runs out
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

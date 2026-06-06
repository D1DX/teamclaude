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
    switchThreshold: 0.98, // hard ceiling (5h axis + real weekly limit)
    weeklyReserve: 0.20,   // D1DX: soft weekly reserve floor, time-decayed
    rerankEvery: 10,       // D1DX: re-rank cadence — calls between weekly-urgency re-checks
    rerankMargin: 1.3,     // D1DX: re-rank switches only if another preferred acct's urgency > current x this
    warmOnStartup: true,   // D1DX: ping each account at boot to anchor windows
    // D1DX (D-1705): all-throttled backoff + de-synchronized recovery
    allThrottledFloorSec: 60,   // min retry-after told to the client when all accounts are throttled
    allThrottledCapSec: 600,    // max retry-after (client re-polls, self-correcting as accounts free)
    retryJitterPct: 0.15,       // upward-only jitter on the client retry-after (de-sync concurrent retries)
    recoveryStaggerSec: 5,      // per-account stagger added to rateLimitedUntil (de-sync window expiry)
    recoveryGapSec: 20,         // half-open recovery: min gap between account re-entries
    escalationFactor: 1.5,      // floor *= factor^(streak-1) on repeated back-to-back all-throttled episodes
    // D1DX (D-1728): per-session cache-affinity routing + bounded per-account backoff
    cacheAffinityWindowSec: 300,   // warm-stick window (Anthropic prompt cache TTL — same account while warm)
    bindingEvictSec: 1800,         // drop a session binding after it's idle this long
    bindingBoostBaseHours: 48,     // reset-proximity boost knee: boost ≈ base / hours-to-7d-reset
    bindingMaxBoost: null,         // cap on the reset-proximity boost (null → number of accounts)
    perAccountBackoffFloorSec: 60, // bounded per-account 429 backoff floor (replaces full-5h over-bench)
    perAccountBackoffCapSec: 600,  // bounded per-account 429 backoff cap
    perAccountBackoffFactor: 1.5,  // escalation per consecutive same-account 429
    // D1DX (D-1903): per-account concurrent in-flight cap — steers a burst of new
    // session (re)binds off an account already serving this many concurrent
    // upstream requests, so bursts spread instead of dogpiling one account
    // (concurrency-induced burst-rate 429s). Steers new binds only; never cuts a
    // warm session, never refuses service. Higher = drain weekly-urgency harder;
    // lower = spread bursts more aggressively.
    maxInFlightPerAccount: 6,
    // D1DX (D-1728): minimal logs + auto-prune. Per-request full-body dumps are
    // OFF by default (the daily operational log keeps the signal); flip to true
    // only for deep debugging. Logs older than logRetentionHours are auto-deleted.
    logRequests: false,            // write per-request full request/response dumps (verbose, ~MB each)
    logRetentionHours: 24,         // auto-delete log files older than this (0 = never)
    // D1DX (D-1728 S6): durable per-issue usage ledger.
    ledgerRetentionHours: 168,     // keep ledger entries this long after last activity (7d)
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

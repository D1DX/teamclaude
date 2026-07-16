import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
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
    switchThreshold: 0.98,         // reporting band only (the near-ceiling display log)
    cacheAffinityWindowSec: 300,   // a session sticks to its account while used within this window
    bindingEvictSec: 1800,         // drop an idle session binding after this long
    farOverLineThreshold: 0.10,    // rebind a warm session only when this far past its weekly pace line
    paceTieBand: 0.10,             // anti-dogpile: accounts within this of the best paceScore spread by load
    maxInflightPerAccount: 5,      // atomic in-flight cap per account — D-2236: 3→5 for deadline throughput
    maxSessionsPerAccount: 7,      // hard cap on bound warm sessions per account (instances limit) — D-2236: 4→7 for deadline throughput
    backoffSec: 60,                // all-throttled client retry-after floor
    allThrottledCapSec: 600,       // max client retry-after when EVERY account is throttled
    // ── Capacity model (reporting only) ──
    capSoftCeiling: 0.75,          // publish headroom below this fraction of the success-taught cap
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

// ── DL-3024/DL-3101: in-process serialization + atomic disk writes ────────────
// Anthropic rotates the refresh token on each refresh. At boot `warmAll` refreshes
// every expired account CONCURRENTLY (Promise.all), and each success fires
// onTokenRefresh → atomicConfigUpdate. With no in-process lock those read-modify-
// writes interleave: a later writer strands an earlier writer's rotated token stale
// on disk (lost-update), and a concurrent reader parses a half-written file
// ("Unexpected end of JSON input") — the 03:37:47 mass invalid_grant burst (DL-3024).
//
// Two guarantees close it:
//   1. A single in-process promise-chain queue serializes EVERY write path
//      (saveConfig / saveConfigSync-via-queue is not needed — sync is exit-only —
//      and atomicConfigUpdate), so read-modify-write cycles never interleave.
//   2. tmp + rename: a write lands on a `.tmp` sibling then atomically renames over
//      the target (POSIX rename is atomic on the same filesystem), so a concurrent
//      reader sees either the whole old file or the whole new one — never a torn one.
//      Mirrors the usage-ledger writer (account-manager.js).
let _configWriteQueue = Promise.resolve();

/** Serialize `fn` behind every prior queued config write; returns fn's result. */
function _enqueueConfigWrite(fn) {
  const run = _configWriteQueue.then(fn, fn);
  // Keep the chain alive even if `fn` rejects (settle to undefined for the NEXT waiter),
  // while still surfacing the rejection to THIS caller via `run`.
  _configWriteQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** Atomic disk write (tmp + rename). Not serialized itself — callers go through the queue. */
async function _writeConfigAtomic(config) {
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  // #81 (4fc849a): `mode` above is honored only when the tmp is CREATED; a leftover
  // tmp from a crashed prior write keeps its old perms. Force 0600 before the rename
  // so the file that lands at `path` (proxy apiKey + account tokens) is never
  // world-readable. rename preserves the tmp's mode, so `path` inherits 0600.
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export function saveConfig(config) {
  return _enqueueConfigWrite(() => _writeConfigAtomic(config));
}

/**
 * Synchronous config write for exit paths (D-2286). saveConfig is async — on
 * SIGINT/SIGTERM or a Deck quit the process can die before the async write lands,
 * stranding a rotated-but-unpersisted refresh token on the OLD value → invalid_grant
 * on the next boot. A sync write completes before process.exit(). Atomic tmp+rename
 * so a signal mid-write can't leave a torn config either (DL-3101). NOT queued — the
 * exit path runs synchronously to completion, past the async queue, and is the last
 * writer by construction.
 */
export function saveConfigSync(config) {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  // Distinct tmp suffix from the async writer (`.tmp`): if SIGTERM lands in the
  // microtask window of an in-flight async write, the two must not target the same
  // tmp path. rename is atomic either way, so `path` always ends up whole — this just
  // keeps the exit flush from tripping the async writer's rename (harmless but noisy).
  const tmp = path + '.sync.tmp';
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  // #81 (4fc849a): enforce 0600 unconditionally (mode is honored only on tmp
  // creation; a leftover tmp keeps its old perms). rename preserves the mode.
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * Atomically update the config: re-reads from disk, calls updater(config), then
 * saves — all serialized behind the in-process write queue so concurrent updates
 * (the boot-warm refresh storm) run one-at-a-time instead of racing. Returns the
 * updated config. The re-read-before-save also prevents overwriting changes made by
 * other processes (e.g. `teamclaude import` while the server runs).
 */
export function atomicConfigUpdate(updater) {
  return _enqueueConfigWrite(async () => {
    const config = await loadConfig() || createDefaultConfig();
    await updater(config);
    await _writeConfigAtomic(config);
    return config;
  });
}

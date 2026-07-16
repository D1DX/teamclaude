import { totalmem, freemem, loadavg, cpus, platform } from 'node:os';
import { execFileSync } from 'node:child_process';

// Process + host resource snapshot for the dashboard (D-1728 S8). Owns the two
// cached OS gauges — macOS "Memory Used" (via vm_stat) and real CPU-busy %.
// Pure host introspection: no account state, no network, no timers.
//   • systemSnapshot() — one cheap os+process reading (covered by
//     test/deck-snapshot.test.mjs, test/tree.test.mjs via the facade).

// macOS "Memory Used" (App + Wired + Compressed), matching Activity Monitor.
// os.freemem() can't be used here — it excludes reclaimable cache, overstating
// used memory by ~10GB. Parsed from `vm_stat` and cached for 2s so the dashboard
// snapshot (hit per /status request + TUI refresh) never hammers the shell-out.
// Returns bytes, or null if vm_stat is unavailable/unparseable (caller falls back).
let _macUsedCache = { at: 0, bytes: null };
function macUsedBytes() {
  const now = Date.now();
  if (_macUsedCache.bytes != null && now - _macUsedCache.at < 2000) return _macUsedCache.bytes;
  try {
    const out = execFileSync('vm_stat', { encoding: 'utf-8', timeout: 1000 });
    const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1]) || 4096;
    const pages = label => {
      const m = out.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
      return m ? Number(m[1]) : 0;
    };
    const wired = pages('Pages wired down');
    const compressed = pages('Pages occupied by compressor');
    const appMem = Math.max(0, pages('Anonymous pages') - pages('Pages purgeable'));
    const bytes = (appMem + wired + compressed) * pageSize;
    _macUsedCache = { at: now, bytes };
    return bytes;
  } catch {
    return null;
  }
}

// Real CPU-busy % (100 − idle), from os.cpus() aggregate time deltas. The CPU
// gauge previously used the system LOAD AVERAGE (load/cores), which counts
// runnable+waiting threads — so it pegged red even when cores sat idle (a Mac
// at 60% idle still showed "100%"). This measures actual compute: busy =
// 1 − idleΔ/totalΔ between two consecutive snapshots. Cached 1s so multiple
// reads in one render tick reuse the same delta window; the first call (no
// prior sample) seeds from cumulative-since-boot. Returns 0..100, or null if
// cpus() is unavailable (caller keeps load average as the fallback display).
let _cpuPrev = null; // { idle, total } from the last cache-miss sample
let _cpuBusyCache = { at: 0, pct: null };
function cpuBusyPct() {
  const now = Date.now();
  if (_cpuBusyCache.pct != null && now - _cpuBusyCache.at < 1000) return _cpuBusyCache.pct;
  let idle = 0, total = 0;
  try {
    for (const c of cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
  } catch {
    return null;
  }
  let pct;
  if (_cpuPrev) {
    const idleD = idle - _cpuPrev.idle;
    const totalD = total - _cpuPrev.total;
    pct = totalD > 0
      ? Math.max(0, Math.min(100, Math.round(100 * (1 - idleD / totalD))))
      : (_cpuBusyCache.pct ?? 0); // no tick elapsed — reuse last reading
  } else {
    // First call: cumulative-since-boot busy% — valid, just less responsive
    // until the next sample establishes a delta window.
    pct = total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
  }
  _cpuPrev = { idle, total };
  _cpuBusyCache = { at: now, pct };
  return pct;
}

// Process + system resource snapshot for the dashboard (D-1728 S8). Cheap —
// os + process, plus a single cached `vm_stat` on macOS for an accurate used
// figure (see macUsedBytes). Per-instance mem/cpu still resolved by the
// caller from each session's pid.
function systemSnapshot() {
  const mu = process.memoryUsage();
  const total = totalmem();
  // os.freemem() on macOS counts reclaimable cache/inactive/compressor pages
  // as NOT free, so (total - free) overstates used by ~10GB (15.8/16 vs 6.7).
  // Derive the Activity-Monitor "Memory Used" figure via vm_stat instead;
  // fall back to freemem() on non-darwin (where freemem is meaningful enough).
  const macUsed = platform() === 'darwin' ? macUsedBytes() : null;
  const used = macUsed != null ? macUsed : (total - freemem());
  return {
    proxyRssMB: Math.round(mu.rss / 1048576),
    proxyUptimeSec: Math.round(process.uptime()),
    totalMemMB: Math.round(total / 1048576),
    usedMemMB: Math.round(used / 1048576),
    usedMemPct: Math.round((used / total) * 100),
    loadAvg: loadavg().map(n => Math.round(n * 100) / 100),
    cpuCount: cpus().length,
    cpuBusyPct: cpuBusyPct(), // D-2173: actual CPU utilization (the gauge driver); load avg kept as secondary text
  };
}

export { macUsedBytes, cpuBusyPct, systemSnapshot };

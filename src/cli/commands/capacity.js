import { loadOrCreateConfig } from '../../config.js';
import { args } from '../shared.js';

// ── capacity (D-2179) ───────────────────────────────────────
// Pool capacity for orchestrators: verdict (green/yellow/red) + headroom
// (spare concurrent-session slots) + soonest-reset. `--json` for scripts;
// exit code green=0 / yellow=10 / red=20 so a launcher can branch on it.

function _verdictExit(v) { return v === 'green' ? 0 : v === 'yellow' ? 10 : 20; }

export async function capacityCommand() {
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
    const state = a.benched ? `benched ${fmtDur(a.benchSec)}`
      : a.nearCap ? 'near cap'
      : a.live ? 'live' : a.status;
    const cap = a.capEst5h != null
      ? ` · burn ${fmtN(a.burn5h)}/${fmtN(Math.round(a.capEst5h))} (5h)`
      : ` · burn ${fmtN(a.burn5h)} (5h, cap unlearned)`;
    // DL-3160: distinct Fable/premium (7d_oi) segment — shown only when the account
    // carries premium data; capped = premium-only bench (still serves non-premium).
    const p = a.premium || {};
    const fbl = p.capped ? ' · Fable capped'
      : p.util != null ? ` · Fable ${(p.util * 100).toFixed(0)}%`
      : '';
    console.log(`  ${String(a.name).padEnd(8)} ${state}${cap}${fbl}`);
  }
  process.exit(_verdictExit(data.verdict));
}

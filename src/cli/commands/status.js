import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILD } from '../../version.js';
import { loadOrCreateConfig } from '../../config.js';

// ── status ──────────────────────────────────────────────────

export async function statusCommand() {
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
    // D-2226: prefer the RUNNING proxy's build (from /teamclaude/status); fall back
    // to the on-disk build with a hint when the live proxy predates the stamp.
    console.log(`Build:    ${data.build || `${BUILD} (on disk — running proxy predates the stamp; restart to load)`}`);
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

      // DL-3160: distinct per-account Fable/premium (7d_oi) meter — its own weekly
      // sub-axis, separate from base 5h/7d, real-header-driven (or prober-fed). Shown
      // only when the account carries premium data; never a silent estimate.
      if (q.premiumUtil != null || q.premiumStatus != null) {
        const fbl = q.premiumUtil != null ? (q.premiumUtil * 100).toFixed(1) + '%'
          : (q.premiumStatus === 'rejected' ? '100%' : '-');
        const capped = (acct.premiumCappedSec > 0 || q.premiumStatus === 'rejected') ? ' (capped)' : '';
        const resetIn = (q.premiumReset && q.premiumReset > Date.now())
          ? ' · resets ' + fmtDur(Math.ceil((q.premiumReset - Date.now()) / 1000)) : '';
        console.log(`    Fable:    ${fbl} used${capped}${resetIn}`);
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

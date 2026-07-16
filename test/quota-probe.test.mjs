import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/auth/prober.js';
import { normalizeUsageBucket, findScopedWeeklyLimit } from '../src/oauth.js';

// DL-3105: zero-spend quota probe (upstream #49). The probe reads /api/oauth/usage
// and applies the result via applyProbeUsage — REPORTING ONLY: utilization/reset for
// the pace line + capacity, NO request count, and NO admission mutation (reactive-only
// stands). Default OFF. Adapted to our normalized bucket shape + reporting fields.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, expiresAt: Date.now() + 1e9, ...extra });
const future = () => Date.now() + 3600_000;
const past = () => Date.now() - 1000;
const mk = (accts) => new AccountManager(accts, 0.98, { backoffJitterSec: 0 });

// ── oauth usage helpers ───────────────────────────────────────
ok('normalizeUsageBucket converts percentages to 0-1 + resets to ms',
  normalizeUsageBucket({ used_percentage: 42 }).utilization === 0.42
  && normalizeUsageBucket({ utilization: 100 }).utilization === 1
  && normalizeUsageBucket({ used_percentage: '30' }).utilization === 0.3
  && normalizeUsageBucket({ resets_at: 1700000000 }).resetAt === 1700000000000
  && normalizeUsageBucket({ resets_at: '2026-01-01T00:00:00Z' }).resetAt === Date.parse('2026-01-01T00:00:00Z')
  && normalizeUsageBucket(null) === null);
{ const data = { limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 8, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 100, resets_at: '2026-07-03T17:00:00Z', scope: { model: { display_name: 'Fable' } } },
  ]};
  const b = normalizeUsageBucket(findScopedWeeklyLimit(data, /fable/i));
  ok('findScopedWeeklyLimit pulls a per-model weekly bucket from limits[]',
     b.utilization === 1 && b.resetAt === Date.parse('2026-07-03T17:00:00Z')
     && findScopedWeeklyLimit(data, /sonnet/i) === null && findScopedWeeklyLimit({}, /fable/i) === null); }

// ── applyProbeUsage: reporting only ───────────────────────────
{ const am = mk([oauth('a')]);
  const r5 = future(), r7 = future();
  am.applyProbeUsage(0, { fiveHour: { utilization: 0.2, resetAt: r5 }, sevenDay: { utilization: 0.4, resetAt: r7 } });
  const q = am.accounts[0].quota;
  ok('applyProbeUsage populates 5h/7d util + reset', q.unified5h === 0.2 && q.unified5hReset === r5 && q.unified7d === 0.4 && q.unified7dReset === r7);
  ok('applyProbeUsage does NOT count a request (a probe is not real traffic)', am.accounts[0].usage.totalRequests === 0);
  ok('applyProbeUsage sets NO admission signal (unifiedStatus stays null)', q.unifiedStatus === null);
  ok('a high-util probe leaves the account usable (never an admission bench)', am._isUsable(am.accounts[0]) === true); }

{ const am = mk([oauth('a')]);
  const r = future();
  am.applyProbeUsage(0, { sevenDayFable: { utilization: 0.99, resetAt: r } });
  ok('applyProbeUsage records the premium (Fable) util for the Deck (reporting)', am.accounts[0].quota.premiumUtil === 0.99 && am.accounts[0].quota.premiumReset === r);
  ok('a near-full premium probe does NOT set the _premiumRejectedUntil admission bench', am.accounts[0]._premiumRejectedUntil === 0); }

{ const am = mk([oauth('a')]);
  am.applyProbeUsage(0, { sevenDay: { utilization: 0.5, resetAt: past() } });
  ok('applyProbeUsage honors the D-2236 guard (a passed reset clears the window)',
     am.accounts[0].quota.unified7d === null && am.accounts[0].quota.unified7dReset === null); }

// ── Prober ────────────────────────────────────────────────────
{ const am = mk([oauth('a')]);
  let calls = 0;
  const probeFn = async () => { calls++; return { fiveHour: { utilization: 0.1, resetAt: future() }, sevenDay: { utilization: 0.2, resetAt: future() } }; };
  const prober = new Prober(am, { intervalMs: 0, probeFn, log: () => {} });
  await prober.probeAll();
  ok('prober probes an oauth account and applies its usage', calls === 1 && am.accounts[0].quota.unified5h === 0.1 && am.accounts[0].quota.unified7d === 0.2); }

{ const am = mk([{ name: 'k', type: 'apikey', apiKey: 'sk' }]);
  let calls = 0;
  const prober = new Prober(am, { intervalMs: 0, probeFn: async () => { calls++; return {}; }, log: () => {} });
  await prober.probeAll();
  ok('prober skips API-key accounts', calls === 0); }

{ const am = mk([oauth('a')]); // no refreshToken → ensureTokenFresh is a no-op
  let calls = 0;
  const probeFn = async () => { calls++; return calls === 1 ? { error: 'HTTP 401', status: 401 } : { sevenDay: { utilization: 0.3, resetAt: future() } }; };
  const prober = new Prober(am, { intervalMs: 0, probeFn, log: () => {} });
  await prober.probeAll();
  ok('prober retries once on a 401 and applies the retry result', calls === 2 && am.accounts[0].quota.unified7d === 0.3); }

{ const am = mk([oauth('a'), { name: 'k', type: 'apikey', apiKey: 'sk' }]);
  const prober = new Prober(am, { intervalMs: 300_000, probeFn: async () => ({ sevenDay: { utilization: 0.3, resetAt: future() } }), log: () => {} });
  await prober.probeAll();
  const status = prober.getStatus();
  ok('prober status records per-account probe results',
     status.enabled === true && status.intervalSeconds === 300
     && status.accounts[0].name === 'a' && status.accounts[0].status === 'ok'
     && typeof status.accounts[0].lastProbedAt === 'string' && status.accounts[1].status === 'not-applicable'); }

{ const am = mk([oauth('a')]);
  let seenToken = null;
  am.ensureTokenFresh = async (idx) => { am.accounts[idx].credential = 'fresh-token'; }; // stub the refresh
  const prober = new Prober(am, { intervalMs: 0, probeFn: async (cred) => { seenToken = cred; return { sevenDay: { utilization: 0.3, resetAt: future() } }; }, log: () => {} });
  await prober.probeAll();
  ok('prober refreshes the token before probing (probes with the fresh credential)', seenToken === 'fresh-token'); }

// ── default OFF (DoD) ─────────────────────────────────────────
{ const am = mk([oauth('a')]);
  let calls = 0;
  const prober = new Prober(am, { intervalMs: 0, probeFn: async () => { calls++; return {}; }, log: () => {} });
  prober.start(); // disabled → no timer, no immediate probe
  await new Promise(r => setTimeout(r, 20));
  ok('a default-OFF prober (intervalMs 0) fires no probe on start()', calls === 0);
  ok('a default-OFF prober reports disabled', prober.getStatus().enabled === false); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// D1DX (D-1739): Deck fleet control-plane data layer — local + credential-free.
// Covers the pin.json overlay reader, the whole-fleet rows, the new
// sessionBindingSummary fields (intent/status/needsYou/fullSid/title), and the
// TUI $-burn mapping. Render-level collision/needs-you visuals are operator-
// verified (TUI needs a TTY); the boolean derivations they consume are here.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const mk = () => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, 0.20, 10, 1.3, {});

// ── sessionBindingSummary carries the new D-1739 fields ───────────────────────
{ const am = mk();
  am.getAccountForSession('S1');                 // create one binding
  const rows = am.sessionBindingSummary();
  const r = rows.find(x => x.sid === 'S1');
  ok('summary row exists for a bound session', !!r);
  ok('row exposes intent/status/title/needsYou/fullSid keys',
    r && ['intent', 'status', 'title', 'needsYou', 'fullSid'].every(k => k in r));
  ok('fullSid derives cc-<sid> when no registry row matches', r && r.fullSid === 'cc-S1');
  ok('needsYou is a boolean (false with no pin)', r && r.needsYou === false); }

// ── _sessionPin: graceful null on a missing pin file ──────────────────────────
{ const am = mk();
  ok('_sessionPin(null) → null', am._sessionPin(null) === null);
  ok('_sessionPin(missing) → null (never throws)', am._sessionPin('cc-does-not-exist-d1739') === null); }

// ── _sessionPin: parses a real pin.json (title/status/assignee/lastComment) ───
{ const am = mk();
  const sid = 'cc-test-d1739-fleet';
  const dir = join(homedir(), '.claude', 'state', 'sessions', sid);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pin.json'), JSON.stringify({
      identifier: 'D-9999', title: 'Test pin overlay', status: 'blocked',
      assigneeUserId: 'u-1', lastCommentAt: '2026-06-02T00:00:00Z', extra: 'ignored',
    }));
    const p = am._sessionPin(sid);
    ok('_sessionPin parses title', p && p.title === 'Test pin overlay');
    ok('_sessionPin parses status', p && p.status === 'blocked');
    ok('_sessionPin parses assigneeUserId', p && p.assigneeUserId === 'u-1');
    ok('_sessionPin parses lastCommentAt', p && p.lastCommentAt === '2026-06-02T00:00:00Z');
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} } }

// ── _sessionPin: corrupt JSON → null (best-effort, never blocks render) ───────
{ const am = mk();
  const sid = 'cc-test-d1739-corrupt';
  const dir = join(homedir(), '.claude', 'state', 'sessions', sid);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pin.json'), '{ not valid json');
    ok('_sessionPin(corrupt) → null', am._sessionPin(sid) === null);
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} } }

// ── fleetRows: returns an array of enriched rows (best-effort) ─────────────────
{ const am = mk();
  const fleet = am.fleetRows();
  ok('fleetRows returns an array', Array.isArray(fleet));
  ok('fleet rows carry the expected shape when present',
    fleet.length === 0 || fleet.every(f => 'sid' in f && 'emoji' in f && 'intent' in f && 'issue' in f && 'pin' in f)); }

// ── TUI._cost: API-equivalent burn from the input/output token split ──────────
{ const stub = { accountManager: {}, config: {}, saveConfig() {}, syncAccounts() {}, onQuit() {} };
  const tui = new TUI(stub);
  ok('_cost default: 1M input = $3 (Sonnet-4.x)', Math.abs(tui._cost(1e6, 0) - 3) < 1e-9);
  ok('_cost default: 1M output = $15', Math.abs(tui._cost(0, 1e6) - 15) < 1e-9);
  ok('_cost default: 1M in + 1M out = $18', Math.abs(tui._cost(1e6, 1e6) - 18) < 1e-9);
  ok('_cost handles null tokens as 0', tui._cost(null, undefined) === 0); }

{ const stub = { accountManager: {}, config: { pricing: { inPerMtok: 10, outPerMtok: 40 } }, saveConfig() {}, syncAccounts() {}, onQuit() {} };
  const tui = new TUI(stub);
  ok('_cost honors config.pricing override', Math.abs(tui._cost(1e6, 1e6) - 50) < 1e-9); }

// ── D-2196/D-2198: pid-identity presence (PID-reuse ghost) ────────────────────
// Helper: write a fake transcript for a uuid and age it `agoSec` into the past.
const writeTranscript = (uuid, agoSec) => {
  const dir = join(homedir(), '.claude', 'projects', '-test-d2198-fake');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${uuid}.jsonl`);
  writeFileSync(p, '{}\n');
  const t = Date.now() / 1000 - agoSec;
  utimesSync(p, t, t);
  return p;
};

{ const am = mk();
  // _pidStartEpoch — our own pid gives a sane recent epoch; bad pids → null.
  const own = am._pidStartEpoch(process.pid);
  const now = Math.floor(Date.now() / 1000);
  ok('_pidStartEpoch: live pid → recent epoch', own != null && own <= now && (now - own) < 86400);
  ok('_pidStartEpoch: dead pid → null', am._pidStartEpoch(999999) === null);
  ok('_pidStartEpoch: null pid → null', am._pidStartEpoch(null) === null);

  // _pidIdentityOk — matching baseline ok; recycled / dead → false; no baseline → ok.
  ok('_pidIdentityOk: alive pid + matching start → true', am._pidIdentityOk(process.pid, own) === true);
  ok('_pidIdentityOk: alive pid + recycled (stale start) → false', am._pidIdentityOk(process.pid, 1000000000) === false);
  ok('_pidIdentityOk: dead pid → false', am._pidIdentityOk(999999, own) === false);
  ok('_pidIdentityOk: alive pid + no baseline → true (back-compat)', am._pidIdentityOk(process.pid, null) === true);

  // _present — identity-ok row is present with no transcript needed.
  ok('_present: alive original pid → present', am._present({ sid: 'cc-d2198-orig', pid: process.pid, pid_start: own }) === true);

  // Reused-pid ghost: identity fails (recycled start) + stale transcript past grace → dropped.
  const ghostUuid = 'd2198aaa-0000-0000-0000-000000000001';
  try {
    writeTranscript(ghostUuid, 40 * 60); // 40 min stale
    const ghost = { sid: `cc-${ghostUuid}`, pid: process.pid, pid_start: 1000000000 };
    ok('_present: reused pid + transcript past grace → absent (D-2198)', am._present(ghost) === false);
    ok('_isZombie: reused pid + transcript past grace → zombie', am._isZombie(ghost) === true);
    // Fresh transcript protects even a recycled pid (live-session guard).
    writeTranscript(ghostUuid, 5); // 5s fresh
    ok('_present: reused pid + FRESH transcript → present (guard)', am._present(ghost) === true);
  } finally { try { rmSync(join(homedir(), '.claude', 'projects', '-test-d2198-fake'), { recursive: true, force: true }); } catch {} }

  // Back-compat: no pid_start, alive pid, stale transcript → present (pre-D-2196 alive==present).
  const bcUuid = 'd2198bbb-0000-0000-0000-000000000002';
  try {
    writeTranscript(bcUuid, 40 * 60);
    ok('_present: no pid_start + alive pid + stale transcript → present (back-compat)',
      am._present({ sid: `cc-${bcUuid}`, pid: process.pid, pid_start: null }) === true);
  } finally { try { rmSync(join(homedir(), '.claude', 'projects', '-test-d2198-fake'), { recursive: true, force: true }); } catch {} }

  // Dead-pid + stale transcript past grace → absent (D-2155 line, unchanged).
  const deadUuid = 'd2198ccc-0000-0000-0000-000000000003';
  try {
    writeTranscript(deadUuid, 40 * 60);
    ok('_present: dead pid + transcript past grace → absent (D-2155)',
      am._present({ sid: `cc-${deadUuid}`, pid: 999999, pid_start: null }) === false);
  } finally { try { rmSync(join(homedir(), '.claude', 'projects', '-test-d2198-fake'), { recursive: true, force: true }); } catch {} } }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

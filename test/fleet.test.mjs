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

// ── D-2203: transcript-activity presence (the deck's live-view filter) ─────────
const FAKE_PROJ = join(homedir(), '.claude', 'projects', '-test-d2203-fake');
// Write a fake transcript for a uuid and age its mtime `agoSec` into the past.
const writeTranscript = (uuid, agoSec) => {
  mkdirSync(FAKE_PROJ, { recursive: true });
  const p = join(FAKE_PROJ, `${uuid}.jsonl`);
  writeFileSync(p, '{}\n');
  const t = Date.now() / 1000 - agoSec;
  utimesSync(p, t, t);
  return p;
};
// Write a D-1749 tool-inflight marker for a full sid, `agoSec` old.
const sessDir = fullSid => join(homedir(), '.claude', 'state', 'sessions', fullSid);
const setInflight = (fullSid, agoSec = 0) => {
  mkdirSync(sessDir(fullSid), { recursive: true });
  writeFileSync(join(sessDir(fullSid), 'tool-inflight'), `${Math.floor(Date.now() / 1000 - agoSec)}\tBash\n`);
};

{ const am = mk();
  const cleanupSids = [];
  try {
    // Fresh transcript → present (the pid is irrelevant when there's recent activity).
    const freshU = 'd2203aaa-0000-0000-0000-000000000001';
    writeTranscript(freshU, 60); // 1 min ago
    ok('_present: fresh transcript (1m) → present', am._present({ sid: `cc-${freshU}`, pid: process.pid }) === true);

    // Stale transcript (>30m window) + alive pid → HIDE. This is the operator's
    // "not active" row: an alive (possibly recycled) pid no longer keeps it.
    const staleU = 'd2203bbb-0000-0000-0000-000000000002';
    writeTranscript(staleU, 40 * 60); // 40 min ago
    ok('_present: stale transcript (40m) + alive pid → hide', am._present({ sid: `cc-${staleU}`, pid: process.pid }) === false);

    // Tool-inflight marker overrides a stale transcript → present (long foreground tool).
    const inflU = 'd2203ccc-0000-0000-0000-000000000003';
    writeTranscript(inflU, 40 * 60);
    setInflight(`cc-${inflU}`, 0); cleanupSids.push(`cc-${inflU}`);
    ok('_present: stale transcript + fresh inflight marker → present', am._present({ sid: `cc-${inflU}`, pid: 999999 }) === true);

    // Expired inflight marker (>120s, the D-1749 fresh-guard) does NOT rescue a stale row.
    const expU = 'd2203ddd-0000-0000-0000-000000000004';
    writeTranscript(expU, 40 * 60);
    setInflight(`cc-${expU}`, 300); cleanupSids.push(`cc-${expU}`);
    ok('_present: stale transcript + EXPIRED inflight marker → hide', am._present({ sid: `cc-${expU}`, pid: 999999 }) === false);

    // No transcript file yet + alive pid → present (brand-new-session rescue).
    ok('_present: no transcript + alive pid → present (new-session rescue)',
      am._present({ sid: 'cc-d2203eee-0000-0000-000000000005', pid: process.pid }) === true);

    // No transcript file + dead pid → hide (unmappable stale row).
    ok('_present: no transcript + dead pid → hide',
      am._present({ sid: 'cc-d2203fff-0000-0000-000000000006', pid: 999999 }) === false);

    // Dead pid + fresh transcript → present (just-finished/crashed but recently active).
    const jdU = 'd2203999-0000-0000-0000-000000000007';
    writeTranscript(jdU, 60);
    ok('_present: dead pid + fresh transcript → present (recent activity)', am._present({ sid: `cc-${jdU}`, pid: 999999 }) === true);
  } finally {
    try { rmSync(FAKE_PROJ, { recursive: true, force: true }); } catch {}
    for (const s of cleanupSids) { try { rmSync(sessDir(s), { recursive: true, force: true }); } catch {} }
  } }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

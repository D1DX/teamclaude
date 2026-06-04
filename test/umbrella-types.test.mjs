import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// D1DX (D-1827): Umbrella type-awareness — per-type breakdown rendering +
// mismatch nudge. Tests cover:
//   1. umbrellaTypeOf helper (via _sessionPin labels passthrough)
//   2. Per-type stats aggregation (count · children · tokens)
//   3. Per-type breakdown lines rendered in the TUI output
//   4. Mismatch nudge fires for Parallel umbrella with 0 live children
//   5. Mismatch nudge does NOT fire for non-Parallel or when children present
//   6. 'unknown' type when labels absent or unrecognised

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else       { fail++; console.log('  FAIL', name); }
};

const mk = () => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, 0.20, 10, 1.3, {});

// ── Helper: write a synthetic pin.json and sessions.json so fleetRows() returns
// agents with the right issueId/parentId/labels. Cleaned up in `finally`.
// sidFull = full SID string (e.g. 'cc-test-d1827-lead1')
function writePin(sidFull, pin) {
  const dir = join(homedir(), '.claude', 'state', 'sessions', sidFull);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pin.json'), JSON.stringify(pin));
  return dir;
}

// ── _sessionPin: labels field passthrough ────────────────────────────────────
{ const am = mk();
  const sid = 'cc-test-d1827-labels';
  const dir = writePin(sid, {
    identifier: 'D-1827', issueId: 'uuid-lead-1', title: 'Test umbrella',
    status: 'in_progress', labels: ['umbrella:parallel', 'mcp:n8n'],
  });
  try {
    const p = am._sessionPin(sid);
    ok('_sessionPin passes through labels array', Array.isArray(p?.labels));
    ok('_sessionPin labels contains umbrella:parallel', p?.labels?.includes('umbrella:parallel'));
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} } }

{ const am = mk();
  const sid = 'cc-test-d1827-nolabels';
  const dir = writePin(sid, { identifier: 'D-1827', issueId: 'uuid-lead-2', status: 'in_progress' });
  try {
    const p = am._sessionPin(sid);
    ok('_sessionPin labels is null when absent from pin.json', p?.labels === null);
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} } }

// ── fleetRows: labels surfaced at row top-level ──────────────────────────────
{ const am = mk();
  const sid = 'cc-test-d1827-fleet-labels';
  const dir = writePin(sid, {
    identifier: 'D-9001', issueId: 'uuid-fl-1', status: 'in_progress',
    labels: ['umbrella:sequential'],
  });
  // Inject a synthetic sessions registry entry so fleetRows picks this session up.
  am._sessionTagCache = {
    at: Date.now() + 1e9, // never expires during this test
    rows: [{ sid, pid: null, emoji: '🔵', intent: null, pinned_issue: 'D-9001' }],
  };
  try {
    const rows = am.fleetRows();
    const r = rows.find(f => f.sid === sid);
    ok('fleetRows row carries labels field', r && 'labels' in r);
    ok('fleetRows labels contains umbrella:sequential', r?.labels?.includes('umbrella:sequential'));
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} } }

// ── TUI render: per-type breakdown lines + mismatch nudge ───────────────────
// Build a synthetic fleet: 2 Parallel umbrellas (one with children, one without),
// 1 Sequential umbrella, 1 Hybrid umbrella — all via fleetRows() stub injection.

const LEAD_P1 = 'uuid-p1', LEAD_P2 = 'uuid-p2', LEAD_S1 = 'uuid-s1', LEAD_H1 = 'uuid-h1';
const CHILD_PA = 'uuid-pa', CHILD_PB = 'uuid-pb', CHILD_SC = 'uuid-sc', CHILD_HD = 'uuid-hd', CHILD_HE = 'uuid-he';

// Synthetic agents: each has the fields tui.js reads from fleetRows() rows.
function makeAgent(opts) {
  return {
    sid: opts.sid || ('cc-test-' + opts.issueId),
    emoji: opts.emoji || '·',
    pid: null,
    intent: opts.intent || null,
    issue: opts.issue || null,
    started: null,
    lastHeartbeat: null,
    pin: {
      title: opts.title || null,
      status: opts.status || 'in_progress',
      assigneeUserId: null,
      lastCommentAt: null,
      identifier: opts.issue || null,
      issueId: opts.issueId || null,
      parentId: opts.parentId || null,
      labels: opts.labels || null,
    },
    issueId:  opts.issueId  || null,
    parentId: opts.parentId || null,
    labels:   opts.labels   || null,
    inflight: false,
    // D-1827: the fixture's intended token total per agent. The tui render rebuilds
    // each agent's tokens from session bindings (bindByBare, tui.js:545-552), NOT
    // from this field — so the sessionBindingSummary() stub below projects these onto
    // bindings keyed by sid. Kept here as the single source feeding that stub.
    tokens: opts.tokens || 0,
    bound: (opts.tokens || 0) > 0,
  };
}

{
  const dirs = [];
  try {
    // Umbrella leads
    const leadP1 = makeAgent({ sid: 'cc-p1', issueId: LEAD_P1, issue: 'D-P1', labels: ['umbrella:parallel'],   tokens: 50000 });
    const leadP2 = makeAgent({ sid: 'cc-p2', issueId: LEAD_P2, issue: 'D-P2', labels: ['umbrella:parallel'],   tokens: 30000 });
    const leadS1 = makeAgent({ sid: 'cc-s1', issueId: LEAD_S1, issue: 'D-S1', labels: ['umbrella:sequential'], tokens: 20000 });
    const leadH1 = makeAgent({ sid: 'cc-h1', issueId: LEAD_H1, issue: 'D-H1', labels: ['umbrella:hybrid'],     tokens: 10000 });
    // Children
    const childPA = makeAgent({ sid: 'cc-pa', issueId: CHILD_PA, parentId: LEAD_P1, issue: 'D-PA', tokens: 40000 });
    const childPB = makeAgent({ sid: 'cc-pb', issueId: CHILD_PB, parentId: LEAD_P1, issue: 'D-PB', tokens: 60000 });
    const childSC = makeAgent({ sid: 'cc-sc', issueId: CHILD_SC, parentId: LEAD_S1, issue: 'D-SC', tokens: 15000 });
    const childHD = makeAgent({ sid: 'cc-hd', issueId: CHILD_HD, parentId: LEAD_H1, issue: 'D-HD', tokens: 25000 });
    const childHE = makeAgent({ sid: 'cc-he', issueId: CHILD_HE, parentId: LEAD_H1, issue: 'D-HE', tokens: 35000 });
    // leadP2 has NO children → triggers Parallel mismatch nudge

    const allAgents = [leadP1, leadP2, leadS1, leadH1, childPA, childPB, childSC, childHD, childHE];

    const am = mk();
    // Stub fleetRows() to return our synthetic agents directly.
    am.fleetRows = () => allAgents;
    // Stub ledgerBySid / sessionBindingSummary / sessionAggregate / systemSnapshot
    // to return safe empties — the TUI render only uses fleetRows for this path.
    am.ledgerBySid = () => new Map();
    // Project each synthetic agent's intended tokens onto a binding keyed by its sid,
    // so the render's bindByBare lookup (tui.js:545-552) populates a.tokens. This is
    // how real tokens flow — via session bindings, not the fleetRows row.
    am.sessionBindingSummary = () => allAgents.map(a => ({ fullSid: a.sid, tokens: a.tokens, account: 'a0', warm: false, idleSec: null }));
    am.sessionAggregate = () => ({ tokens: 0, inputTokens: 0, outputTokens: 0, sessions: 0, warm: 0, requests: 0, elapsedSec: 1 });
    am.systemSnapshot = () => ({ proxyRssMB: 100, proxyUptimeSec: 60, totalMemMB: 16384, usedMemMB: 8192, usedMemPct: 50, loadAvg: [0.5, 0.5, 0.5], cpuCount: 8 });
    am.ledgerByIssue = () => [];

    const stub = { accountManager: am, config: {}, saveConfig() {}, syncAccounts() {}, onQuit() {} };
    const tui = new TUI(stub);
    tui.running = true;

    // Capture render output into a buffer by overriding process.stdout.columns + write.
    const origCols = process.stdout.columns;
    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    Object.defineProperty(process.stdout, 'rows',    { value: 40,  configurable: true });

    const written = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = chunk => { written.push(String(chunk)); return true; };

    try {
      tui.render();
    } finally {
      process.stdout.write = origWrite;
      Object.defineProperty(process.stdout, 'columns', { value: origCols, configurable: true });
      Object.defineProperty(process.stdout, 'rows',    { value: origRows, configurable: true });
      tui.running = false;
    }

    // Strip ANSI from all output for plain-text assertions.
    const ANSI_RE = /\x1b\[[0-9;]*m/g;
    const output = written.join('').replace(ANSI_RE, '');
    const outputLines = output.split(/\r?\n/);

    // Helper: find all lines containing a plain-text substring.
    const linesWith = sub => outputLines.filter(l => l.includes(sub));

    // 1. Umbrellas section is rendered.
    ok('Umbrellas section header present', linesWith('Umbrellas').length > 0);

    // 2. Per-type breakdown: Parallel line present with correct count (2 umbrellas).
    const parallelLines = linesWith('Parallel');
    ok('Parallel breakdown line present', parallelLines.length > 0);
    ok('Parallel count is 2', parallelLines.some(l => /Parallel\s+2/.test(l)));

    // 3. Parallel children = 2 (only leadP1 has children: PA + PB; leadP2 has 0).
    ok('Parallel shows 2 ↳ children', parallelLines.some(l => /2 ↳/.test(l)));

    // 4. Parallel tokens = 180k (leadP1 50k + leadP2 30k + childPA 40k + childPB 60k).
    ok('Parallel tokens = 180k', parallelLines.some(l => l.includes('180k')));

    // 5. Sequential line present with count=1, children=1, tokens=35k (leadS1+childSC).
    const seqLines = linesWith('Sequential');
    ok('Sequential breakdown line present', seqLines.length > 0);
    ok('Sequential count is 1', seqLines.some(l => /Sequential\s+1/.test(l)));
    ok('Sequential shows 1 ↳ child',   seqLines.some(l => /1 ↳/.test(l)));
    ok('Sequential tokens = 35k', seqLines.some(l => l.includes('35k')));

    // 6. Hybrid line present with count=1, children=2, tokens=70k (leadH1+HD+HE).
    const hybridLines = linesWith('Hybrid');
    ok('Hybrid breakdown line present', hybridLines.length > 0);
    ok('Hybrid count is 1',   hybridLines.some(l => /Hybrid\s+1/.test(l)));
    ok('Hybrid shows 2 ↳ children', hybridLines.some(l => /2 ↳/.test(l)));
    ok('Hybrid tokens = 70k', hybridLines.some(l => l.includes('70k')));

    // 7. Mismatch nudge fires for leadP2 (Parallel, 0 live children).
    const p2Lines = linesWith('D-P2');
    ok('leadP2 umbrella header present', p2Lines.length > 0);
    ok('mismatch nudge on leadP2 (Parallel, 0 children)', p2Lines.some(l => l.includes('no live children')));

    // 8. Mismatch nudge does NOT fire for leadP1 (Parallel but has children).
    const p1Lines = linesWith('D-P1');
    ok('no mismatch nudge on leadP1 (Parallel, has children)', p1Lines.every(l => !l.includes('no live children')));

    // 9. Mismatch nudge does NOT fire for Sequential or Hybrid (different type).
    const s1Lines = linesWith('D-S1');
    const h1Lines = linesWith('D-H1');
    ok('no mismatch nudge on leadS1 (Sequential)', s1Lines.every(l => !l.includes('no live children')));
    ok('no mismatch nudge on leadH1 (Hybrid)',     h1Lines.every(l => !l.includes('no live children')));

    // 10. Per-type order: Parallel before Sequential before Hybrid.
    const umbrellasSectionIdx = outputLines.findIndex(l => l.includes('Umbrellas'));
    const parallelIdx   = outputLines.findIndex((l, i) => i > umbrellasSectionIdx && l.includes('Parallel'));
    const sequentialIdx = outputLines.findIndex((l, i) => i > umbrellasSectionIdx && l.includes('Sequential'));
    const hybridIdx     = outputLines.findIndex((l, i) => i > umbrellasSectionIdx && l.includes('Hybrid'));
    ok('Parallel breakdown before Sequential', parallelIdx > -1 && parallelIdx < sequentialIdx);
    ok('Sequential breakdown before Hybrid',   sequentialIdx > -1 && sequentialIdx < hybridIdx);

  } finally {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

// ── umbrellaTypeOf edge cases (tested via _sessionPin + labels) ──────────────
{ const am = mk();
  const sid = 'cc-test-d1827-unk';
  const dir = writePin(sid, { identifier: 'D-X', issueId: 'uuid-x', labels: ['mcp:n8n', 'mode:solo'] });
  try {
    const p = am._sessionPin(sid);
    // Labels present but no umbrella:* entry — type should be 'unknown' in render.
    // We verify labels round-trips correctly; the TUI helper derives 'unknown' from it.
    ok('labels without umbrella:* entry round-trips as array', Array.isArray(p?.labels));
    ok('no umbrella:* label in array', !p?.labels?.some(l => l.startsWith('umbrella:')));
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} } }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

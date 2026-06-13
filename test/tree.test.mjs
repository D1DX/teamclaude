import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// D1DX (D-2105): Deck full orchestration tree — recursive ≥3-level render with
// per-subtree (self · Σ), per-level (Levels line), and per-tree ($) token
// rollups. Replaces the one-level umbrella-types test. Tree nesting is pure
// parentId (label-independent); these tests prove the recursion, the rollups,
// and that solo agents stay out of the tree section.

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else       { fail++; console.log('  FAIL', name); }
};

const mk = () => new AccountManager([
  { name: 'a0', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, 0.20, 10, 1.3, {});

// ── _sessionPin / fleetRows: labels passthrough still works (carried from the
// retired umbrella-types test — labels remain a real pin.json field). ──────────
function writePin(sidFull, pin) {
  const dir = join(homedir(), '.claude', 'state', 'sessions', sidFull);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pin.json'), JSON.stringify(pin));
  return dir;
}

{ const am = mk();
  const sid = 'cc-test-d2105-labels';
  const dir = writePin(sid, {
    identifier: 'D-2105', issueId: 'uuid-lbl-1', title: 'Test',
    status: 'in_progress', labels: ['orchestrator', 'mcp:n8n'],
  });
  try {
    const p = am._sessionPin(sid);
    ok('_sessionPin passes through labels array', Array.isArray(p?.labels));
    ok('_sessionPin labels contains orchestrator', p?.labels?.includes('orchestrator'));
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} } }

{ const am = mk();
  const sid = 'cc-test-d2105-nolabels';
  const dir = writePin(sid, { identifier: 'D-2105', issueId: 'uuid-lbl-2', status: 'in_progress' });
  try {
    ok('_sessionPin labels is null when absent', am._sessionPin(sid)?.labels === null);
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} } }

// ── Synthetic agent helper — mirrors the fields tui.js reads off fleetRows(). ──
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
    tokens: opts.tokens || 0,
    bound: (opts.tokens || 0) > 0,
  };
}

// Render the TUI against a synthetic fleet, return ANSI-stripped output lines.
function renderFleet(allAgents) {
  const am = mk();
  am.fleetRows = () => allAgents;
  am.ledgerBySid = () => new Map();
  // tokens flow via session bindings (bindByBare), not the row — project them.
  am.sessionBindingSummary = () => allAgents.map(a => ({ fullSid: a.sid, tokens: a.tokens, account: 'a0', warm: false, idleSec: null }));
  am.sessionAggregate = () => ({ tokens: 0, inputTokens: 0, outputTokens: 0, sessions: 0, warm: 0, requests: 0, elapsedSec: 1 });
  am.systemSnapshot = () => ({ proxyRssMB: 100, proxyUptimeSec: 60, totalMemMB: 16384, usedMemMB: 8192, usedMemPct: 50, loadAvg: [0.5, 0.5, 0.5], cpuCount: 8 });
  am.ledgerByIssue = () => [];

  const stub = { accountManager: am, config: {}, saveConfig() {}, syncAccounts() {}, onQuit() {} };
  const tui = new TUI(stub);
  tui.running = true;

  const origCols = process.stdout.columns, origRows = process.stdout.rows;
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  Object.defineProperty(process.stdout, 'rows',    { value: 60,  configurable: true });
  const written = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = chunk => { written.push(String(chunk)); return true; };
  try { tui.render(); }
  finally {
    process.stdout.write = origWrite;
    Object.defineProperty(process.stdout, 'columns', { value: origCols, configurable: true });
    Object.defineProperty(process.stdout, 'rows',    { value: origRows, configurable: true });
    tui.running = false;
  }
  const ANSI_RE = /\x1b\[[0-9;]*m/g;
  return written.join('').replace(ANSI_RE, '').split(/\r?\n/);
}

// ── A real ≥3-level tree ──────────────────────────────────────────────────────
//   HoO (uHOO, 10k)                            L0
//   ├─ A (uA, 5k)                              L1  lead
//   │  ├─ A1 (uA1, 20k)                        L2
//   │  └─ A2 (uA2, 8k)                         L2
//   └─ B (uB, 3k)                              L1  lead
//      └─ B1 (uB1, 12k)                        L2
//   solo (uSOLO, 1k)  — no parent, no children → NOT in the tree section
{
  const hoo = makeAgent({ sid: 'cc-hoo', issueId: 'uHOO', issue: 'D-HOO', tokens: 10000, labels: ['orchestrator'] });
  const A   = makeAgent({ sid: 'cc-A', issueId: 'uA', parentId: 'uHOO', issue: 'D-A', tokens: 5000, labels: ['orchestrator:child', 'orchestrator'] });
  const B   = makeAgent({ sid: 'cc-B', issueId: 'uB', parentId: 'uHOO', issue: 'D-B', tokens: 3000, labels: ['orchestrator:child'] });
  const A1  = makeAgent({ sid: 'cc-A1', issueId: 'uA1', parentId: 'uA', issue: 'D-A1', tokens: 20000 });
  const A2  = makeAgent({ sid: 'cc-A2', issueId: 'uA2', parentId: 'uA', issue: 'D-A2', tokens: 8000 });
  const B1  = makeAgent({ sid: 'cc-B1', issueId: 'uB1', parentId: 'uB', issue: 'D-B1', tokens: 12000 });
  const solo = makeAgent({ sid: 'cc-solo', issueId: 'uSOLO', issue: 'D-SOLO', tokens: 1000 });

  const out = renderFleet([hoo, A, B, A1, A2, B1, solo]);
  const has = sub => out.some(l => l.includes(sub));
  const lineWith = sub => out.find(l => l.includes(sub)) || '';
  const idxOf = sub => out.findIndex(l => l.includes(sub));

  // 1. Tree section header present, with node count + $ cost.
  ok('Tree section header present', has('Tree'));
  const hdr = lineWith(' Tree ') || out.find(l => /\bTree\b/.test(l)) || '';
  ok('Tree header shows 6 nodes', out.some(l => /Tree/.test(l) && l.includes('6 nodes')));
  ok('Tree header shows a $ cost', out.some(l => /Tree/.test(l) && l.includes('$')));

  // 2. All three levels render.
  ok('L0 root D-HOO present', has('D-HOO'));
  ok('L1 lead D-A present',   has('D-A '));
  ok('L2 worker D-A1 present', has('D-A1'));
  ok('L2 worker B1 present',  has('D-B1'));

  // 3. Tree connectors present (├─ or └─) and a │ continuation bar at depth 2.
  ok('tree connectors rendered', out.some(l => l.includes('├─') || l.includes('└─')));
  ok('continuation bar │ at depth 2', out.some(l => l.includes('│') && l.includes('D-A1')));

  // 4. Increasing indentation: D-A1 (L2) is indented further than D-A (L1) than D-HOO (L0).
  const lead = s => lineWith(s).search(/\S/); // first non-space col (after we keep leading mark/space)
  // Use raw position of the D-N token instead — robust to the leading mark.
  const col = s => { const l = lineWith(s); return l.indexOf(s); };
  ok('D-A indented deeper than D-HOO', col('D-A ') > col('D-HOO'));
  ok('D-A1 indented deeper than D-A', col('D-A1') > col('D-A '));

  // 5. Subtree Σ rollups: HoO=58k, A=33k, B=15k.
  ok('HoO row shows Σ 58k subtree', /Σ/.test(lineWith('D-HOO')) && lineWith('D-HOO').includes('58'));
  ok('A row shows Σ 33k subtree',   /Σ/.test(lineWith('D-A ')) && lineWith('D-A ').includes('33'));
  ok('B row shows Σ 15k subtree',   /Σ/.test(lineWith('D-B ')) && lineWith('D-B ').includes('15'));

  // 6. Self tokens on a leaf worker (A1 = 20k, no Σ since no children).
  ok('A1 self token 20k present', lineWith('D-A1').includes('20'));
  ok('A1 (leaf) has no Σ', !/Σ/.test(lineWith('D-A1')));

  // 7. Levels rollup line: L0 1·10k, L1 2·8k, L2 3·40k.
  const lv = lineWith('Levels');
  ok('Levels line present', lv.length > 0);
  ok('Levels L0 count 1', /L0\s*1·/.test(lv));
  ok('Levels L1 count 2', /L1\s*2·/.test(lv));
  ok('Levels L2 count 3', /L2\s*3·/.test(lv));
  ok('Levels L2 tokens 40k', lv.includes('40'));

  // 8. Sibling order: A (subtree 33k) before B (subtree 15k).
  ok('A before B (subtree-desc order)', idxOf('D-A ') < idxOf('D-B '));

  // 9. Solo agent does NOT appear inside the tree section (between Tree header and Levels).
  const treeStart = out.findIndex(l => /Tree/.test(l) && l.includes('nodes'));
  const levelsIdx = idxOf('Levels');
  const treeBlock = out.slice(treeStart, levelsIdx >= 0 ? levelsIdx + 1 : out.length);
  ok('solo D-SOLO not in tree block', !treeBlock.some(l => l.includes('D-SOLO')));
}

// ── LIVE PATH: real pin.json on disk, read through production fleetRows() ──────
// Acceptance #3 ("verified live against a running multi-level fleet"): drive the
// REAL fleetRows()->_sessionPin() disk-read path (NOT a fleetRows stub) against a
// 3-level fleet written as actual pin.json files, exactly as a live fleet writes
// them. Only the binding/snapshot helpers are stubbed (those need the live proxy).
{
  const SS = join(homedir(), '.claude', 'state', 'sessions');
  const nodes = [
    { sid:'cc-treetest-hoo', emoji:'🦘', pin:{ identifier:'D-HOO', issueId:'tt-uHOO', parentId:null, status:'in_progress', title:'HoO', labels:['orchestrator'] } },
    { sid:'cc-treetest-A',   emoji:'🦛', pin:{ identifier:'D-A',   issueId:'tt-uA', parentId:'tt-uHOO', status:'in_progress', labels:['orchestrator:child','orchestrator'] } },
    { sid:'cc-treetest-B',   emoji:'🦝', pin:{ identifier:'D-B',   issueId:'tt-uB', parentId:'tt-uHOO', status:'in_review' } },
    { sid:'cc-treetest-A1',  emoji:'🦜', pin:{ identifier:'D-A1',  issueId:'tt-uA1', parentId:'tt-uA', status:'blocked' } },
    { sid:'cc-treetest-B1',  emoji:'🦉', pin:{ identifier:'D-B1',  issueId:'tt-uB1', parentId:'tt-uB', status:'in_progress' } },
  ];
  const dirs = [];
  try {
    for (const n of nodes) { const d = join(SS, n.sid); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'pin.json'), JSON.stringify(n.pin)); dirs.push(d); }
    const am = mk();
    // Inject ONLY the registry rows; pins are read REAL from disk by fleetRows->_sessionPin.
    // `started` mirrors a real registry row (register stamps it) — D-2203's _present
    // rescues a brand-new no-transcript session by started-freshness, pid-free.
    am._sessionTagCache = { at: Date.now() + 1e9, rows: nodes.map(n => ({ sid:n.sid, pid:process.pid, emoji:n.emoji, intent:null, pinned_issue:n.pin.identifier, started: new Date().toISOString() })) };
    const toks = { 'cc-treetest-hoo':10000,'cc-treetest-A':5000,'cc-treetest-B':3000,'cc-treetest-A1':20000,'cc-treetest-B1':12000 };
    am.sessionBindingSummary = () => nodes.map(n => ({ fullSid:n.sid, tokens:toks[n.sid], inputTokens:toks[n.sid], outputTokens:0, account:'a0', warm:false, idleSec:null }));
    am.ledgerBySid = () => new Map();
    am.sessionAggregate = () => ({ tokens:50000, inputTokens:50000, outputTokens:0, sessions:5, warm:0, requests:0, elapsedSec:1 });
    am.systemSnapshot = () => ({ proxyRssMB:100, proxyUptimeSec:60, totalMemMB:16384, usedMemMB:8192, usedMemPct:50, loadAvg:[0.5,0.5,0.5], cpuCount:8 });
    am.ledgerByIssue = () => [];

    // fleetRows() reads the pins from DISK — prove the tree linkage came through it.
    const fr = am.fleetRows().filter(f => f.sid.startsWith('cc-treetest-'));
    ok('fleetRows read 5 pins from disk', fr.length === 5);
    ok('fleetRows surfaced parentId chain from disk', fr.find(f => f.issue === 'D-A1')?.parentId === 'tt-uA');

    const stub = { accountManager: am, config: {}, saveConfig() {}, syncAccounts() {}, onQuit() {} };
    const tui = new TUI(stub); tui.running = true;
    const oc = process.stdout.columns, orw = process.stdout.rows;
    Object.defineProperty(process.stdout, 'columns', { value: 110, configurable: true });
    Object.defineProperty(process.stdout, 'rows',    { value: 60,  configurable: true });
    const w = []; const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = c => { w.push(String(c)); return true; };
    try { tui.render(); } finally {
      process.stdout.write = ow;
      Object.defineProperty(process.stdout, 'columns', { value: oc, configurable: true });
      Object.defineProperty(process.stdout, 'rows',    { value: orw, configurable: true });
      tui.running = false;
    }
    const lines = w.join('').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
    const has = s => lines.some(l => l.includes(s));
    const lw = s => lines.find(l => l.includes(s)) || '';
    ok('LIVE: Tree renders 5 nodes from disk pins', lines.some(l => /Tree/.test(l) && l.includes('5 nodes')));
    ok('LIVE: L0 root D-HOO', has('D-HOO'));
    ok('LIVE: L1 D-A', has('D-A '));
    ok('LIVE: L2 D-A1 (3rd level)', has('D-A1'));
    ok('LIVE: HoO Σ 50k subtree', /Σ/.test(lw('D-HOO')) && lw('D-HOO').includes('50'));
    ok('LIVE: Levels line spans 3 depths', /L0/.test(lw('Levels')) && /L1/.test(lw('Levels')) && /L2/.test(lw('Levels')));
  } finally {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

// ── Cycle / malformed-parent safety: a self-parent node must not hang render. ──
{
  const root = makeAgent({ sid: 'cc-r', issueId: 'uR', issue: 'D-R', tokens: 100 });
  const child = makeAgent({ sid: 'cc-c', issueId: 'uC', parentId: 'uR', issue: 'D-C', tokens: 200 });
  const selfloop = makeAgent({ sid: 'cc-x', issueId: 'uX', parentId: 'uX', issue: 'D-X', tokens: 50 });
  let completed = false;
  const out = renderFleet([root, child, selfloop]);
  completed = Array.isArray(out) && out.length > 0;
  ok('render completes with a self-parent node present', completed);
  ok('normal tree still renders (D-R + D-C)', out.some(l => l.includes('D-R')) && out.some(l => l.includes('D-C')));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

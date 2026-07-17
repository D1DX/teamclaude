import { modelEffortTag } from '../src/model.js';
import { AccountManager } from '../src/account-manager.js';
import { DeckSnapshotSource } from '../src/deck-source.js';
import { TUI } from '../src/tui.js';

// DL-2785: the `[<model>·<effort>]` Activity tag. Proves four things:
//   1. modelEffortTag() — compaction rules + the no-data → '' contract.
//   2. Live TUI — the tag rides both the spinner row (render) and the
//      completed log line (onRequestEnd), and rows WITHOUT parsed data
//      render exactly as before (no stray tag, no shape change).
//   3. Headless AccountManager — the same tag on its log ring, and the
//      snapshot's active[] carries model/effort so the wire has them.
//   4. Watch viewer — a TUI fed from a JSON-round-tripped snapshot (the
//      watch.js poll path) shows the tag on spinner rows + log lines.
// No network, no terminal — stdout is captured around render().

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = s => s.replace(ANSI_RE, '');

const mk = () => new AccountManager([
  { name: 'kiwi', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
], 0.98, { backoffJitterSec: 0 });

// ── 1. modelEffortTag formatting ───────────────────────────────────────────────
{
  ok('claude- prefix drops', modelEffortTag('claude-opus-4-8', 'high') === '[opus-4-8·high]');
  ok('trailing date stamp drops', modelEffortTag('claude-haiku-4-5-20251001', 'low') === '[haiku-4-5·low]');
  ok('[1m] context variant passes through', modelEffortTag('claude-fable-5[1m]', 'high') === '[fable-5[1m]·high]');
  ok('non-Anthropic id passes through verbatim', modelEffortTag('gpt-5.5', 'medium') === '[gpt-5.5·medium]');
  ok('model without effort → no separator', modelEffortTag('claude-opus-4-8', null) === '[opus-4-8]');
  ok('effort without model → ? placeholder', modelEffortTag(null, 'high') === '[?·high]');
  ok('neither known → empty string (row unchanged)', modelEffortTag(null, null) === '');
  ok('non-string junk → empty string', modelEffortTag(42, {}) === '');
}

// ── 2. live TUI — spinner row + completed log line ─────────────────────────────
{
  const tui = new TUI({ accountManager: mk(), config: { proxy: { port: 3456 } }, onQuit: () => {} });

  // tagged request: start → routed(model+effort) → visible on the spinner row
  tui.onRequestStart('r1', { method: 'POST', path: '/v1/messages' });
  tui.onRequestRouted('r1', { account: 'kiwi', model: 'claude-opus-4-8', effort: 'high' });
  // untagged request: no model/effort parsed — row must stay tag-free
  tui.onRequestStart('r2', { method: 'GET', path: '/teamclaude/status' });

  const realWrite = process.stdout.write.bind(process.stdout);
  let frame = '';
  process.stdout.write = s => { frame += s; return true; };
  let threw = null;
  try { tui.running = true; tui.render(); } catch (e) { threw = e; }
  process.stdout.write = realWrite;
  tui.running = false;
  const plain = strip(frame);
  ok('render() does not throw with tagged active rows', threw === null);
  if (threw) console.log('     threw:', threw.stack ? threw.stack.split('\n')[0] : threw);
  ok('spinner row carries [opus-4-8·high]', plain.includes('/v1/messages [opus-4-8·high]'));
  ok('untagged spinner row stays tag-free', !/\/teamclaude\/status\s+\[/.test(plain));

  // completed log line carries the tag (2xx → live pane only, no disk write)
  tui.onRequestEnd('r1', { method: 'POST', path: '/v1/messages', account: 'kiwi', status: 200 });
  ok('completed log line carries the tag', tui.log[0].msg.includes('/v1/messages [opus-4-8·high] → kiwi (200'));
  tui.onRequestEnd('r2', { method: 'GET', path: '/teamclaude/status', account: 'kiwi', status: 200 });
  ok('untagged completed line unchanged', tui.log[0].msg.includes('/teamclaude/status → kiwi (200'));
}

// ── 3. headless AccountManager — log ring + snapshot wire ──────────────────────
{
  const am = mk();
  am.onRequestStart('r1', { method: 'POST', path: '/v1/messages' });
  am.onRequestRouted('r1', { account: 'kiwi', model: 'claude-fable-5[1m]', effort: 'high' });

  const snap = am.getDeckSnapshot();
  const row = snap.active.find(r => r.id === 'r1');
  ok('snapshot active[] carries model', row?.model === 'claude-fable-5[1m]');
  ok('snapshot active[] carries effort', row?.effort === 'high');

  am.onRequestEnd('r1', { method: 'POST', path: '/v1/messages', account: 'kiwi', status: 200 });
  ok('headless log line carries the tag', am._log[0].msg.includes('/v1/messages [fable-5[1m]·high] → kiwi (200'));
  ok('snapshot log ships the tagged line', am.getDeckSnapshot().log[0].msg.includes('[fable-5[1m]·high]'));
}

// ── 4. watch viewer — snapshot → JSON wire → read-only Deck render ─────────────
{
  const am = mk();
  am.onRequestStart('r1', { method: 'POST', path: '/v1/messages' });
  am.onRequestRouted('r1', { account: 'kiwi', model: 'claude-opus-4-8', effort: 'med' });
  am.onRequestEnd('r1', { method: 'POST', path: '/v1/messages', account: 'kiwi', status: 200 });
  am.onRequestStart('r2', { method: 'POST', path: '/v1/messages' });
  am.onRequestRouted('r2', { account: 'kiwi', model: 'claude-opus-4-8', effort: 'med' });

  const wire = JSON.parse(JSON.stringify(am.getDeckSnapshot()));
  const tui = new TUI({ accountManager: new DeckSnapshotSource(wire), config: { proxy: { port: 3456 } }, readOnly: true, onQuit: () => {} });
  // the watch.js poll loop: rebuild active Map + log from the snapshot
  tui.active = new Map((wire.active || []).map(r => [r.id, r]));
  tui.log = Array.isArray(wire.log) ? wire.log : [];
  tui.activeCount = wire.activeLLM ?? 0;
  tui.connState = { ok: true, msg: '' };

  const realWrite = process.stdout.write.bind(process.stdout);
  let frame = '';
  process.stdout.write = s => { frame += s; return true; };
  let threw = null;
  try { tui.running = true; tui.render(); } catch (e) { threw = e; }
  process.stdout.write = realWrite;
  tui.running = false;
  const plain = strip(frame);
  ok('watch render does not throw', threw === null);
  if (threw) console.log('     threw:', threw.stack ? threw.stack.split('\n')[0] : threw);
  ok('watch spinner row carries the tag', plain.includes('/v1/messages [opus-4-8·med]'));
  ok('watch completed log line carries the tag', plain.includes('[opus-4-8·med] → kiwi (200'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

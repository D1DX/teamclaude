import { AccountManager } from '../src/account-manager.js';
import { DeckSnapshotSource } from '../src/deck-source.js';
import { TUI } from '../src/tui.js';

// D-2485: the read-only Deck viewer (`teamclaude watch`). Proves three things:
//   1. getDeckSnapshot() is a JSON-safe superset of everything render() reads.
//   2. DeckSnapshotSource exposes the exact am.* accessor surface render() calls,
//      reconstructed from the (HTTP-transported) snapshot.
//   3. A read-only TUI renders the real snapshot without throwing (no drift) and
//      ignores the mutation keys (s/a/r), while q quits.
// No network — in-memory accounts; the snapshot is round-tripped through JSON to
// mirror the /teamclaude/deck wire path.

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const mk = () => new AccountManager([
  { name: 'kiwi', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'apple', type: 'oauth', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 1e9 },
  { name: 'backup', type: 'apikey', apiKey: 'sk-x' },
], 0.98, { backoffJitterSec: 0 });

// ── 1. getDeckSnapshot() shape — superset of getStatus() ──────────────────────
{
  const am = mk();
  const snap = am.getDeckSnapshot();
  // getStatus() carry-over
  ok('snapshot has accounts[]', Array.isArray(snap.accounts) && snap.accounts.length === 3);
  ok('snapshot has capacity object', snap.capacity && typeof snap.capacity.verdict === 'string');
  ok('snapshot has system', !!snap.system && typeof snap.system.proxyRssMB === 'number');
  ok('snapshot has sessionAggregate', !!snap.sessionAggregate);
  ok('snapshot has sessionBindings[]', Array.isArray(snap.sessionBindings));
  ok('snapshot has usageByIssue[]', Array.isArray(snap.usageByIssue));
  // Deck-only additions
  ok('snapshot adds currentIndex', snap.currentIndex === 0);
  ok('snapshot adds activeLLM (scalar in-flight count)', snap.activeLLM === 0);
  ok('snapshot adds fleet[]', Array.isArray(snap.fleet));
  ok('snapshot adds ledgerBySid as a plain object (JSON-safe, not a Map)',
    snap.ledgerBySid && typeof snap.ledgerBySid === 'object' && !(snap.ledgerBySid instanceof Map));
  // per-account fields the Deck draws
  const a0 = snap.accounts[0];
  ok('account carries name/type/status/quota', a0.name === 'kiwi' && a0.type === 'oauth' && !!a0.quota && typeof a0.status === 'string');
  // activeLLM reflects live in-flight
  am.accounts[0]._inflight = 2; am.accounts[1]._inflight = 1;
  ok('activeLLM sums per-account in-flight (2+1+0=3)', am.getDeckSnapshot().activeLLM === 3);
}

// ── 2. DeckSnapshotSource — the read-only accessor facade ─────────────────────
{
  const am = mk();
  // simulate the HTTP path: getDeckSnapshot → JSON wire → parse
  const wire = JSON.parse(JSON.stringify(am.getDeckSnapshot()));
  const src = new DeckSnapshotSource(wire);

  ok('accounts exposed as a property', Array.isArray(src.accounts) && src.accounts.length === 3);
  ok('currentIndex exposed as a property', src.currentIndex === 0);
  ok('systemSnapshot() returns the snapshot system', src.systemSnapshot() === wire.system);
  ok('sessionBindingSummary() returns bindings', Array.isArray(src.sessionBindingSummary()));
  ok('sessionAggregate() returns aggregate', !!src.sessionAggregate());
  ok('fleetRows() returns fleet', Array.isArray(src.fleetRows()));
  ok('ledgerByIssue() returns usageByIssue', Array.isArray(src.ledgerByIssue()));
  ok('computeCapacity() returns the capacity object', src.computeCapacity().verdict === wire.capacity.verdict);
  ok('ledgerBySid() rebuilds a Map (render expects .get())', src.ledgerBySid() instanceof Map);

  // empty/pre-connect snapshot must NOT throw on render (capacity has a safe default)
  const empty = new DeckSnapshotSource({});
  ok('empty source → accounts []', empty.accounts.length === 0);
  ok('empty source → capacity default (red/0) so render never throws', empty.computeCapacity().verdict === 'red');
  ok('empty source → ledgerBySid() is an (empty) Map', empty.ledgerBySid() instanceof Map);

  // round-trip a populated ledgerBySid through the Map rebuild
  const src2 = new DeckSnapshotSource({ ledgerBySid: { 'abc123': { account: 'kiwi', lastActiveAt: 1 } } });
  ok('ledgerBySid Map.get(bareSid) resolves the account', src2.ledgerBySid().get('abc123')?.account === 'kiwi');
}

// ── 3. read-only TUI renders the real snapshot + ignores mutation keys ────────
{
  const am = mk();
  const wire = JSON.parse(JSON.stringify(am.getDeckSnapshot()));
  const src = new DeckSnapshotSource(wire);
  const config = { proxy: { port: 3456 } };

  // capture stdout so the alt-screen frame + exit escapes don't pollute test output
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  let threw = null;
  try {
    const tui = new TUI({ accountManager: src, config, readOnly: true, onQuit: () => {} });
    tui.activeCount = wire.activeLLM;
    tui.connState = { ok: true, msg: '' };
    tui.running = true;          // allow render() to paint (without start()'s raw-mode/alt-screen)
    tui.render();                // real snapshot → real render path
    // disconnected frame must also render (frozen snapshot + banner)
    tui.connState = { ok: false, msg: 'proxy unreachable on :3456 — retrying' };
    tui.render();
    // a brand-new (pre-first-poll) empty viewer must render without throwing
    const empty = new TUI({ accountManager: new DeckSnapshotSource({}), config, readOnly: true, onQuit: () => {} });
    empty.connState = { ok: false, msg: 'connecting…' };
    empty.running = true;
    empty.render();
  } catch (e) { threw = e; }
  process.stdout.write = realWrite;
  ok('read-only Deck renders the real snapshot without throwing', threw === null);
  if (threw) console.log('     threw:', threw && threw.stack ? threw.stack.split('\n')[0] : threw);

  // mutation keys are inert in read-only mode; q triggers onQuit
  process.stdout.write = () => true;
  let quit = false;
  const tui = new TUI({ accountManager: src, config, readOnly: true, onQuit: () => { quit = true; } });
  tui.running = false;           // _key calls render() at the end; running=false makes it a no-op
  tui._key('s'); ok('read-only: [s] does NOT enter switch mode', tui.mode === 'normal');
  tui._key('a'); ok('read-only: [a] does NOT enter add mode', tui.mode === 'normal');
  tui._key('r'); ok('read-only: [r] does NOT enter remove mode', tui.mode === 'normal');
  tui._key('q'); ok('read-only: [q] triggers onQuit (exit viewer only)', quit === true);
  process.stdout.write = realWrite;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

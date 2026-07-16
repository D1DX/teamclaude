import { saveConfig, saveConfigSync, atomicConfigUpdate } from '../src/config.js';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #81 (4fc849a): "chmod 0600 on every config save (mode is ignored when the file
// exists)". Our writer is tmp+rename, so the normal path already lands 0600 (a
// fresh tmp honors `mode`). The gap #81 names is a LEFTOVER tmp from a crashed
// prior write: writeFile truncates it but keeps its old perms, so the renamed
// file would inherit them. An explicit chmod(tmp, 0600) before rename closes it.
// This proves all three write paths (async / atomicConfigUpdate / sync) end 0600
// even when a world-readable tmp is pre-seeded.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const dir = mkdtempSync(join(tmpdir(), 'tc-perms-'));
process.env.TEAMCLAUDE_CONFIG = join(dir, 'teamclaude.json');
const cfgPath = process.env.TEAMCLAUDE_CONFIG;
const mode = (p) => statSync(p).mode & 0o777;
const cfg = { proxy: { port: 3456, apiKey: 'tc-secret' }, upstream: 'https://api.anthropic.com', accounts: [] };

// ── saveConfig (async, tmp+rename): fresh file is 0600 ───────────────────────
await saveConfig(cfg);
ok('saveConfig writes 0600 on a fresh file', mode(cfgPath) === 0o600);

// ── a world-readable LEFTOVER .tmp must not leak its perms through the rename ──
writeFileSync(cfgPath + '.tmp', 'stale', { mode: 0o644 });
await saveConfig(cfg);
ok('saveConfig forces 0600 even over a leftover 0644 tmp', mode(cfgPath) === 0o600);
ok('the leftover tmp is consumed by the rename', !existsSync(cfgPath + '.tmp'));

// ── atomicConfigUpdate (the boot-warm write path) also lands 0600 ────────────
writeFileSync(cfgPath + '.tmp', 'stale', { mode: 0o666 });
await atomicConfigUpdate((c) => { c.proxy.apiKey = 'tc-rotated'; });
ok('atomicConfigUpdate forces 0600 over a leftover 0666 tmp', mode(cfgPath) === 0o600);

// ── saveConfigSync (exit-path flush) also lands 0600 over a leftover sync tmp ─
writeFileSync(cfgPath + '.sync.tmp', 'stale', { mode: 0o644 });
saveConfigSync(cfg);
ok('saveConfigSync forces 0600 over a leftover 0644 sync tmp', mode(cfgPath) === 0o600);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

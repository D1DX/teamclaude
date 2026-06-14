import { resolveBuild } from '../src/version.js';

// D-2226: the build-id resolver behind the startup log / `teamclaude status` /
// /health version stamp. No network — pure resolution-priority logic.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

// 1) TEAMCLAUDE_BUILD env override wins over everything.
process.env.TEAMCLAUDE_BUILD = 'test-build-xyz';
ok('TEAMCLAUDE_BUILD env override is honored', resolveBuild() === 'test-build-xyz');
delete process.env.TEAMCLAUDE_BUILD;

// 2) Without an override it resolves to a non-empty id (git short SHA in the
//    fork clone, a BUILD file in the installed copy, or 'unknown') — never
//    throws, never empty.
const b = resolveBuild();
ok('resolves to a non-empty build id (never throws / never empty)', typeof b === 'string' && b.length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

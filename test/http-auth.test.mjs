import { safeKeyEqual } from '../src/http/server.js';

// #81 (4fc849a): the proxy-key auth gate compares in constant time (safeKeyEqual)
// instead of `!==`, which early-exits on the first differing byte and leaks the
// match length via timing. The gate wires it as `!safeKeyEqual(clientKey, proxyApiKey)`
// (server.js), loopback-exempt. This proves the primitive's semantics — equal keys
// pass, every mismatch class (value, length, missing header, type) is rejected.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

ok('equal keys compare true', safeKeyEqual('tc-abc123', 'tc-abc123') === true);
ok('same-length differing keys compare false', safeKeyEqual('tc-abc123', 'tc-abc124') === false);
ok('a one-char difference is rejected', safeKeyEqual('secret', 'Secret') === false);
ok('length mismatch is rejected (no throw)', safeKeyEqual('tc-abc', 'tc-abc-longer') === false);
ok('a prefix of the real key does NOT pass', safeKeyEqual('tc-abc', 'tc-abc123') === false);
ok('empty vs empty compares true', safeKeyEqual('', '') === true);
ok('a missing client header (undefined) is rejected', safeKeyEqual(undefined, 'tc-key') === false);
ok('a missing proxy key (undefined) is rejected', safeKeyEqual('tc-key', undefined) === false);
ok('null is rejected', safeKeyEqual(null, 'tc-key') === false);
ok('a non-string (number) is rejected', safeKeyEqual(12345, 12345) === false);
// Multi-byte safety: Buffer.from length differs from string .length, but the
// compare stays length-guarded so it never throws on a RangeError.
ok('unicode of differing byte-length is rejected without throwing', safeKeyEqual('é', 'e') === false);
ok('identical unicode compares true', safeKeyEqual('café-tc', 'café-tc') === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

import {
  isFableModel, modelFamily,
  parseRequestModel, TopLevelFieldFinder,
  parseAdvisorModel, AdvisorModelFinder,
  parseRequestEffort,
} from '../src/model.js';

// DL-3105: the lifted streaming request-body parsers (upstream #64/#66/#70/#98/#99).
// Byte-exact — never mistake a `"model"`/`"effort"` nested in conversation text for
// the real top-level field, and cheap on large bodies (stop as soon as it resolves).
// Family classifier + the advisor parser (the DL-2841 fix) + the D1DX effort finder.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

// ── model family ──────────────────────────────────────────────
ok('isFableModel matches the Fable family only', isFableModel('claude-fable-5') === true
  && isFableModel('claude-opus-4-8') === false && isFableModel('claude-sonnet-5') === false
  && isFableModel(null) === false && isFableModel(undefined) === false);
ok('modelFamily tags each family', modelFamily('claude-fable-5') === 'fable'
  && modelFamily('claude-sonnet-5') === 'sonnet' && modelFamily('claude-opus-4-8') === 'opus'
  && modelFamily('claude-haiku-4-5') === 'haiku');
ok('modelFamily → other on unknown / non-string', modelFamily('gpt-5') === 'other'
  && modelFamily(null) === 'other' && modelFamily('') === 'other');

// ── parseRequestModel ─────────────────────────────────────────
ok('parseRequestModel reads the top-level model (string + Buffer)',
  parseRequestModel('{"model":"claude-fable-5","max_tokens":1}') === 'claude-fable-5'
  && parseRequestModel(Buffer.from('{ "model" : "claude-opus-4-8" }')) === 'claude-opus-4-8');
ok('parseRequestModel → null on absent / empty / null',
  parseRequestModel('{"max_tokens":1}') === null && parseRequestModel('') === null
  && parseRequestModel(null) === null);
ok('parseRequestModel ignores a "model" nested in conversation content', parseRequestModel(JSON.stringify({
  messages: [{ role: 'user', content: 'here is json: {"model":"DECOY-should-be-ignored"}' }],
  system: [{ type: 'text', text: '"model": "ALSO-DECOY"' }],
  model: 'claude-fable-5',
})) === 'claude-fable-5');
ok('parseRequestModel ignores a nested model even when it appears first',
  parseRequestModel('{"metadata":{"model":"nested-decoy"},"model":"claude-opus-4-8"}') === 'claude-opus-4-8');

// ── TopLevelFieldFinder streaming ─────────────────────────────
{
  const full = '{"max_tokens":1,"model":"claude-fable-5","stream":true}';
  const finder = new TopLevelFieldFinder('model');
  let out = null;
  for (let i = 0; i < full.length; i += 3) { out = finder.push(Buffer.from(full.slice(i, i + 3), 'utf8')); if (finder.done) break; }
  ok('TopLevelFieldFinder resolves across chunk boundaries', out === 'claude-fable-5' && finder.done === true);
}
{
  const finder = new TopLevelFieldFinder('model');
  ok('TopLevelFieldFinder marks done (absent) once the root object closes',
    finder.push(Buffer.from('{"max_tokens":1}')) === null && finder.done === true);
}

// ── parseAdvisorModel (DL-2841 fix) ───────────────────────────
const advisorBody = (executor = 'claude-opus-4-8', advisor = 'claude-fable-5') => JSON.stringify({
  model: executor,
  max_tokens: 4096,
  tools: [
    { name: 'Bash', description: 'run advisor commands', input_schema: { type: 'object', properties: { model: { type: 'string' } } } },
    { type: 'advisor_20260301', name: 'advisor', model: advisor },
  ],
  messages: [{ role: 'user', content: 'say {"model":"claude-haiku-4-5"} and "type":"advisor_x"' }],
});
ok('parseAdvisorModel extracts the advisor model from tools[] (string + Buffer)',
  parseAdvisorModel(advisorBody()) === 'claude-fable-5'
  && parseAdvisorModel(Buffer.from(advisorBody())) === 'claude-fable-5');
ok('parseAdvisorModel → null without an advisor tool',
  parseAdvisorModel(JSON.stringify({ model: 'claude-opus-4-8', tools: [{ name: 'Bash' }] })) === null
  && parseAdvisorModel('{"model":"claude-opus-4-8"}') === null
  && parseAdvisorModel(null) === null && parseAdvisorModel('') === null && parseAdvisorModel('not json {') === null);
ok('parseAdvisorModel never matches nested or decoy fields', parseAdvisorModel(JSON.stringify({
  model: 'claude-opus-4-8',
  tools: [{ name: 'x', input_schema: { type: 'advisor_fake', properties: { model: { const: 'claude-haiku-4-5' } } } }],
  messages: [{ role: 'user', content: '{"tools":[{"type":"advisor_20260301","model":"claude-haiku-4-5"}]}' }],
})) === null
  && parseAdvisorModel(JSON.stringify({ model: 'claude-opus-4-8', metadata: { tools: [{ type: 'advisor_20260301', model: 'claude-haiku-4-5' }] } })) === null);
ok('parseAdvisorModel handles field order (model before type)',
  parseAdvisorModel(JSON.stringify({ model: 'claude-opus-4-8', tools: [{ model: 'claude-fable-5', name: 'advisor', type: 'advisor_20260301' }] })) === 'claude-fable-5');
{
  const finder = new AdvisorModelFinder();
  const buf = Buffer.from(advisorBody());
  for (let i = 0; i < buf.length; i++) finder.push(buf.subarray(i, i + 1));
  ok('AdvisorModelFinder byte-at-a-time matches whole-buffer', finder.value === 'claude-fable-5');
}

// ── parseRequestEffort (D1DX, DL-2785 data) ───────────────────
ok('parseRequestEffort reads output_config.effort (string + Buffer)',
  parseRequestEffort('{"model":"claude-opus-4-8","output_config":{"effort":"high"}}') === 'high'
  && parseRequestEffort(Buffer.from('{"output_config":{"effort":"low"},"model":"x"}')) === 'low');
ok('parseRequestEffort → null when absent / no effort key',
  parseRequestEffort('{"model":"claude-opus-4-8"}') === null
  && parseRequestEffort('{"output_config":{"other":1}}') === null
  && parseRequestEffort(null) === null && parseRequestEffort('') === null);
ok('parseRequestEffort ignores a top-level or deeply-nested "effort" decoy',
  parseRequestEffort('{"effort":"top-level-decoy","output_config":{"effort":"medium"}}') === 'medium'
  && parseRequestEffort(JSON.stringify({ messages: [{ role: 'user', content: '{"output_config":{"effort":"DECOY"}}' }], output_config: { effort: 'xhigh' } })) === 'xhigh'
  && parseRequestEffort('{"metadata":{"output_config":{"effort":"nested-decoy"}}}') === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

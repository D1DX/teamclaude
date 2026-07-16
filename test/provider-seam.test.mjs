// Provider-adapter seam (architecture-v3 §7). Unit-tests the registry resolution
// + the anthropic adapter's shape methods, and PROVES the per-account override
// (D-2655 GLM/OpenRouter leg) produces the identical outbound model/provider/auth/
// upstream before and after the seam extraction (the DL-3106 parity DoD).
import '../src/providers/anthropic.js';                       // self-registers 'anthropic'
import { resolveProvider, getProvider, configureProviders, resolveUpstream, registerProvider } from '../src/providers/provider.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const anthropic = getProvider('anthropic');

// ── Registry resolution ──────────────────────────────────────────────────────
ok('anthropic adapter is registered', anthropic && anthropic.name === 'anthropic');
ok('an account with no provider resolves to anthropic',
  resolveProvider({ type: 'oauth' }) === anthropic);
ok('an account with an UNREGISTERED provider (D-2655 z-ai pin) falls back to anthropic',
  resolveProvider({ type: 'apikey', provider: 'z-ai' }) === anthropic);
ok('a null account resolves to the default adapter',
  resolveProvider(null) === anthropic);

// A throwaway stub proves resolution actually keys on a registered name.
const stub = { name: 'stub-provider', baseUrl: () => 'http://stub', applyAuth: (a, h) => h,
  mapModel: (m) => ({ model: m, provider: null }), parseQuota: () => ({}), parseUsage: () => null,
  classifyRateLimit: () => ({ retryAfterSec: null }) };
registerProvider(stub);
ok('a REGISTERED provider name resolves to that adapter',
  resolveProvider({ provider: 'stub-provider' }) === stub);
ok('the default upstream helper falls back to the anthropic origin when unconfigured',
  resolveUpstream({}) === 'https://api.anthropic.com');

// ── configure() folds the deployment upstream into the default origin ─────────
configureProviders({ upstream: 'http://127.0.0.1:9999' });
ok('configure() sets the default base URL from config.upstream',
  anthropic.baseUrl({ type: 'oauth' }) === 'http://127.0.0.1:9999');
ok('resolveUpstream honors config.upstream',
  resolveUpstream({ upstream: 'http://127.0.0.1:9999' }) === 'http://127.0.0.1:9999');
ok('configure({}) is a no-op — it preserves the prior default (no reset)',
  anthropic.baseUrl({ type: 'oauth' }) === 'http://127.0.0.1:9999');
// reset back to the anthropic default for the remaining shape assertions
configureProviders({ upstream: 'https://api.anthropic.com' });
ok('re-configure restores the anthropic origin',
  anthropic.baseUrl({ type: 'oauth' }) === 'https://api.anthropic.com');

// ── baseUrl: per-account override wins ────────────────────────────────────────
ok('baseUrl honors a per-account upstream override (D-2655)',
  anthropic.baseUrl({ type: 'apikey', upstream: 'https://openrouter.ai/api' }) === 'https://openrouter.ai/api');

// ── applyAuth: the three legs ─────────────────────────────────────────────────
{
  const h = {};
  anthropic.applyAuth({ type: 'oauth', credential: 'tok' }, h);
  ok('OAuth → Bearer', h['authorization'] === 'Bearer tok');
  ok('OAuth → injects the oauth beta gate first', h['anthropic-beta'] === 'oauth-2025-04-20');
  ok('OAuth → no x-api-key', !('x-api-key' in h));
}
{
  const h = { 'anthropic-beta': 'other-beta' };
  anthropic.applyAuth({ type: 'oauth', credential: 'tok' }, h);
  ok('OAuth → PREPENDS the beta gate to existing betas',
    h['anthropic-beta'] === 'oauth-2025-04-20,other-beta');
}
{
  const h = {};
  anthropic.applyAuth({ type: 'apikey', credential: 'k' }, h);
  ok('plain apikey → x-api-key', h['x-api-key'] === 'k');
  ok('plain apikey → no Authorization', !('authorization' in h));
}
{
  const h = { 'x-api-key': 'left-over' };
  anthropic.applyAuth({ type: 'apikey', upstream: 'https://openrouter.ai/api', credential: 'k' }, h);
  ok('D-2655 apikey leg → Bearer', h['authorization'] === 'Bearer k');
  ok('D-2655 apikey leg → strips x-api-key', !('x-api-key' in h));
  ok('D-2655 apikey leg → no beta injection (not OAuth)', !('anthropic-beta' in h));
}

// ── mapModel: the three routes + the no-alternative signal ────────────────────
ok('default account → model passthrough, no provider pin',
  JSON.stringify(anthropic.mapModel('claude-opus-4-8', { type: 'oauth' })) ===
  JSON.stringify({ model: 'claude-opus-4-8', provider: null }));

// D-2655 GLM/OpenRouter leg — the LIVE glm-openrouter shape. This is the parity DoD.
const glm = { type: 'apikey', upstream: 'https://openrouter.ai/api', model: 'z-ai/glm-5.2', provider: 'z-ai', credential: 'k' };
ok('D-2655 override → rewrites model + pins the provider (identical to pre-seam)',
  JSON.stringify(anthropic.mapModel('claude-sonnet-5', glm)) ===
  JSON.stringify({ model: 'z-ai/glm-5.2', provider: 'z-ai' }));
ok('D-2655 model override does NOT fire without an upstream (behavior-preserving)',
  JSON.stringify(anthropic.mapModel('claude-opus-4-8', { type: 'apikey', model: 'z-ai/glm-5.2' })) ===
  JSON.stringify({ model: 'claude-opus-4-8', provider: null }));

// The slice-8 grammar (dormant today): family-keyed map, no entry → no route.
const mapped = { type: 'apikey', upstream: 'https://openrouter.ai/api', provider: 'z-ai',
  modelMap: { haiku: 'z-ai/glm-5.2', sonnet: 'z-ai/glm-5.2', opus: 'anthropic/claude-opus-4-8' } };
ok('modelMap grammar → resolves by family (dated id → family key)',
  JSON.stringify(anthropic.mapModel('claude-opus-4-8[1m]', mapped)) ===
  JSON.stringify({ model: 'anthropic/claude-opus-4-8', provider: 'z-ai' }));
ok('modelMap grammar → an UNMAPPED family returns null (the no-alternative signal)',
  anthropic.mapModel('claude-fable-5', mapped) === null);

// ── parseQuota: the anthropic-ratelimit-* subset ─────────────────────────────
{
  const hdrs = new Map([
    ['anthropic-ratelimit-unified-5h-utilization', '0.42'],
    ['anthropic-ratelimit-unified-7d-status', 'allowed'],
    ['content-type', 'application/json'],
    ['x-request-id', 'abc'],
  ]);
  const q = anthropic.parseQuota(hdrs);
  ok('parseQuota keeps only the anthropic-ratelimit-* headers',
    Object.keys(q).length === 2 &&
    q['anthropic-ratelimit-unified-5h-utilization'] === '0.42' &&
    q['anthropic-ratelimit-unified-7d-status'] === 'allowed');
}

// ── parseUsage: token/cache split ─────────────────────────────────────────────
{
  const u = anthropic.parseUsage({ input_tokens: 100, output_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 3 },
    cache_read_input_tokens: 7 });
  ok('parseUsage extracts input/output + explicit cache split',
    u.inputTokens === 100 && u.outputTokens === 20 &&
    u.cacheCreate5m === 5 && u.cacheCreate1h === 3 && u.cacheRead === 7);
  const u2 = anthropic.parseUsage({ input_tokens: 10, cache_creation_input_tokens: 4 });
  ok('parseUsage → absent breakdown treats all cache-creation as 5m',
    u2.cacheCreate5m === 4 && u2.cacheCreate1h === 0);
  ok('parseUsage → null usage returns null', anthropic.parseUsage(null) === null);
}

// ── classifyRateLimit: explicit retry-after only ─────────────────────────────
{
  const withHdr = { headers: { get: (k) => (k === 'retry-after' ? '120' : null) } };
  const noHdr = { headers: { get: () => null } };
  ok('classifyRateLimit reads an explicit retry-after',
    anthropic.classifyRateLimit(withHdr).retryAfterSec === 120);
  ok('classifyRateLimit → header-less 429 gives null (fails over, never benches)',
    anthropic.classifyRateLimit(noHdr).retryAfterSec === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

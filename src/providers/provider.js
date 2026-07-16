// providers/provider.js — the provider-adapter seam (architecture-v3 §7).
//
// An adapter describes ONE upstream's request/response SHAPE and nothing else.
// POLICY — account selection, pace-to-line, cache-affinity, the apikey HOLD gate,
// the failover + hold loops — stays in provider-agnostic core/http and never
// enters an adapter (§7: an adapter describes its upstream, it can never soften a
// gate; upstream's fallback-priority grammar is weaker than our HOLD gate — do
// not import their policy). The adapter interface every provider implements:
//
//   name                         registry key ('anthropic' | 'openrouter' | 'codex' | …)
//   configure(config)            optional — fold deployment config (e.g. the
//                                default upstream) into the adapter at boot
//   baseUrl(account)             upstream origin (honors a per-account override)
//   applyAuth(account, headers)  mutate the outbound header set — credential +
//                                any upstream-specific injection; returns headers
//   mapModel(model, account)     the outbound model for this account:
//                                  { model, provider } to send, OR
//                                  null = this account is NOT a route for `model`
//                                  (the no-alternative signal — §5 / DL-2536)
//   parseQuota(resHeaders)       pull this upstream's rate-limit headers into a
//                                provider-neutral subset for core/quota
//   parseUsage(usage)            token/cache extraction from a usage object
//   classifyRateLimit(res)       EXPLICIT signals only → { retryAfterSec | null }
//
// The registry maps name → adapter instance. Account config gains `provider`
// (default 'anthropic'); an UNREGISTERED value resolves to the default adapter,
// so today's accounts — including the D-2655 apikey leg whose `provider` field is
// the OpenRouter body-routing pin (e.g. 'z-ai'), NOT an adapter name — keep
// running on the default (anthropic) adapter with zero behavior change until a new
// adapter is registered and the account is reconfigured (operator-gated).
//   • covered by test/provider-seam.test.mjs (registry resolution + adapter shape)
//     and, end-to-end, by the http integration suites (all-throttled-hold,
//     http-passthrough, http-auth drive the real adapter through forwardRequest).

const REGISTRY = new Map();
const DEFAULT_PROVIDER = 'anthropic';

// Register a provider adapter under its `name`. Called once per adapter module at
// import time (anthropic.js self-registers).
export function registerProvider(adapter) {
  if (!adapter || typeof adapter.name !== 'string' || !adapter.name) {
    throw new Error('provider adapter must expose a string `name`');
  }
  REGISTRY.set(adapter.name, adapter);
}

// The adapter registered under `name`, or the default adapter, or null.
export function getProvider(name) {
  return REGISTRY.get(name) || REGISTRY.get(DEFAULT_PROVIDER) || null;
}

// Resolve the adapter that serves an account. An `account.provider` that does NOT
// name a REGISTERED adapter (e.g. the D-2655 'z-ai' body-routing pin) falls back
// to the default adapter — the zero-behavior-change bridge (see header).
export function resolveProvider(account) {
  const name = account && account.provider;
  if (name && REGISTRY.has(name)) return REGISTRY.get(name);
  return REGISTRY.get(DEFAULT_PROVIDER) || null;
}

// Fold deployment config into every registered adapter (each adapter decides what
// it needs). createProxyServer calls this once, before serving.
export function configureProviders(config) {
  for (const adapter of REGISTRY.values()) adapter.configure?.(config);
}

// The default upstream for the RAW passthrough paths (the /v1/oauth/token relay
// and the #83 client-credential streams) — these bypass account selection, so
// they use the deployment default, not a per-account origin. Deferred to the
// default adapter so the upstream literal lives once, under providers/.
export function resolveUpstream(config) {
  const a = getProvider(DEFAULT_PROVIDER);
  return (config && config.upstream) || (a ? a.baseUrl(null) : null);
}

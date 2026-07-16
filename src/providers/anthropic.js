// providers/anthropic.js — the DEFAULT provider adapter: today's Anthropic OAuth
// + apikey upstream behavior, extracted verbatim from http/forward.js so the
// request/response SHAPE lives behind the seam (architecture-v3 §7) and the
// forward path stays provider-agnostic. Zero behavior change: every account
// resolves here while `anthropic` is the only registered adapter, and each of the
// three legs (OAuth · plain apikey · the D-2655 apikey-with-own-upstream leg) is
// reproduced exactly.
//   • covered by test/provider-seam.test.mjs (unit) + the http integration suites.

import { registerProvider } from './provider.js';
import { modelFamily } from '../model.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

// Claude Code 2.1.121+ intermittently drops this from `anthropic-beta` when
// model-level betas merge in (Object.assign source-order bug; OpenClaw #41444),
// and upstream then 401s with a misleading "OAuth authentication is currently not
// supported". Always ensure the gate leads `anthropic-beta` on OAuth requests.
const REQUIRED_OAUTH_BETA = 'oauth-2025-04-20';

class AnthropicProvider {
  constructor() {
    this.name = 'anthropic';
    // Deployment default upstream; a per-account `upstream` overrides it. Set from
    // config at boot via configure(); the literal is the fallback.
    this.defaultBaseUrl = DEFAULT_BASE_URL;
  }

  // Fold the deployment's `upstream` config into the default origin (createProxyServer
  // → configureProviders). A per-account override still wins in baseUrl().
  configure(config) {
    if (config && config.upstream) this.defaultBaseUrl = config.upstream;
  }

  // Upstream origin for this account. Honors the D-2655 per-account `upstream`
  // override (the GLM/OpenRouter apikey leg); else the deployment default. A null
  // account (raw-relay default lookup) → the default origin.
  baseUrl(account) {
    return (account && account.upstream) || this.defaultBaseUrl;
  }

  // Mutate the outbound header set with this account's credential + the
  // upstream-specific injection; returns the same headers object.
  //   • OAuth        → the oauth-2025-04-20 beta gate, then `Authorization: Bearer`.
  //   • apikey leg   → the D-2655 alt-upstream apikey: `Authorization: Bearer`, no
  //     `x-api-key` (an account with its own `upstream`).
  //   • plain apikey → `x-api-key`.
  // The caller has already stripped the inbound proxy `x-api-key` and hop-by-hop /
  // accept-encoding headers; this only sets the UPSTREAM credential.
  applyAuth(account, headers) {
    if (account.type === 'oauth') {
      const betaKey = Object.keys(headers).find(k => k.toLowerCase() === 'anthropic-beta');
      const existing = betaKey
        ? String(headers[betaKey]).split(',').map(s => s.trim()).filter(Boolean)
        : [];
      if (!existing.includes(REQUIRED_OAUTH_BETA)) {
        existing.unshift(REQUIRED_OAUTH_BETA);
        headers[betaKey || 'anthropic-beta'] = existing.join(',');
      }
      headers['authorization'] = `Bearer ${account.credential}`;
    } else if (account.upstream) {
      // D-2655 apikey leg to an alternate upstream (OpenRouter): Bearer, and no
      // x-api-key (drop any the caller left set).
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'x-api-key') delete headers[k];
      }
      headers['authorization'] = `Bearer ${account.credential}`;
    } else {
      headers['x-api-key'] = account.credential;
    }
    return headers;
  }

  // Resolve the outbound model for this account. Returns { model, provider } to
  // send, or `null` when this account is NOT a route for `model` (the
  // no-alternative signal — §5 / DL-2536). `provider` is the OpenRouter body pin
  // (parsed.provider), null when none.
  //   1. account.modelMap (slice-8 #74/#79 grammar) — family-keyed richer map; a
  //      family with no entry → null (no route). DORMANT until config declares a
  //      modelMap — no live account does, so today this branch never fires.
  //   2. account.model + account.upstream (D-2655 legacy single override — the two
  //      travel as one unit) → that model + the optional provider pin.
  //   3. neither → the requested model unchanged (no rewrite).
  mapModel(model, account) {
    if (account && account.modelMap && typeof account.modelMap === 'object') {
      const mapped = account.modelMap[modelFamily(model)];
      if (mapped == null) return null;                     // no route → no-alternative
      return { model: mapped, provider: account.provider ?? null };
    }
    if (account && account.upstream && account.model) {    // D-2655 legacy override
      return { model: account.model, provider: account.provider ?? null };
    }
    return { model, provider: null };
  }

  // Pull this upstream's rate-limit headers into a provider-neutral subset for
  // core/quota (the `anthropic-ratelimit-*` grammar). Accepts a fetch Headers
  // object or a plain map.
  parseQuota(resHeaders) {
    const out = {};
    const entries = resHeaders && typeof resHeaders.entries === 'function'
      ? resHeaders.entries()
      : Object.entries(resHeaders || {});
    for (const [k, v] of entries) {
      if (k.startsWith('anthropic-ratelimit-')) out[k] = v;
    }
    return out;
  }

  // Extract token/cache counts from a Messages-API `usage` object (message_start,
  // message_delta, or a non-streamed body's usage). The cache-creation split
  // (5m vs 1h) mirrors the API; an absent breakdown → all 5m (Claude Code's
  // default cache TTL). Returns null for a missing usage object.
  parseUsage(usage) {
    if (!usage) return null;
    const cc = usage.cache_creation || {};
    let c5 = cc.ephemeral_5m_input_tokens;
    let c1 = cc.ephemeral_1h_input_tokens;
    if (c5 == null && c1 == null) { c5 = usage.cache_creation_input_tokens || 0; c1 = 0; }
    else { c5 = c5 || 0; c1 = c1 || 0; }
    return {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheCreate5m: c5,
      cacheCreate1h: c1,
      cacheRead: usage.cache_read_input_tokens || 0,
    };
  }

  // Classify a rate-limit response into EXPLICIT signals only (§4 reactive-only):
  // a server `retry-after` → bench that duration; absent → null (a header-less 429
  // fails over, never benches). The per-axis `rejected` signal is read from the
  // response headers by core/quota; this returns only the retry-after.
  classifyRateLimit(res) {
    const hdr = parseInt(res.headers.get('retry-after'), 10);
    return { retryAfterSec: Number.isNaN(hdr) ? null : hdr };
  }
}

registerProvider(new AnthropicProvider());

export { AnthropicProvider, DEFAULT_BASE_URL };

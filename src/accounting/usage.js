// accounting/usage.js — cumulative token usage + API-equivalent cost + the rolling
// per-account burn buckets that feed the capacity model. Written by http/sse on each
// response; read by the deck + accounting/capacity. Cost is computed from tokens +
// the response model via accounting/pricing.js (the Messages API returns no $ field).
// Burn buckets are Map(hourEpoch → tokens), pruned to 7d, and count the billable
// load that pushes toward the rate limit (uncached input + cache writes + output;
// cache reads are ~free). Reads/writes the shared pool records + mgr.sessionBindings.
//   • covered by tree.test, capacity.test (burn), fleet.test.

import { CACHE_WRITE_5M_MULT, CACHE_WRITE_1H_MULT, CACHE_READ_MULT } from './pricing.js';

// Add `tokens` to the account's current hour bucket; prune buckets older than 7d.
export function recordBurn(mgr, account, tokens) {
  if (!account || !tokens) return;
  const hr = Math.floor(Date.now() / 3600000);
  if (!account._burn) account._burn = new Map();
  account._burn.set(hr, (account._burn.get(hr) || 0) + tokens);
  const cutoff = hr - 168; // keep 7d
  for (const k of account._burn.keys()) if (k < cutoff) account._burn.delete(k);
}

// Sum of burn (tokens) over the last `hours` whole-hour buckets.
export function burnWindow(mgr, account, hours) {
  if (!account || !account._burn) return 0;
  const cutoff = Math.floor(Date.now() / 3600000) - hours;
  let sum = 0;
  for (const [k, v] of account._burn) if (k >= cutoff) sum += v;
  return sum;
}

// Update cumulative token usage + cost from response body data. message_start
// carries input_tokens (uncached) + cache tokens + the model; message_delta carries
// output_tokens only — so the model is remembered on the binding from message_start
// and reused for the output-side cost. opts: { cacheCreate5m, cacheCreate1h,
// cacheRead, model }.
export function updateUsage(mgr, accountIndex, inputTokens, outputTokens, sessionId = null, opts = {}) {
  const account = mgr.accounts[accountIndex];
  if (!account) return;
  if (inputTokens) account.usage.totalInputTokens += inputTokens;
  if (outputTokens) account.usage.totalOutputTokens += outputTokens;

  // Feed the rolling burn buckets — the billable load toward the rate limit:
  // uncached input + cache writes + output; cache reads are ~free, so excluded.
  recordBurn(mgr, account,
    (inputTokens || 0) + (opts.cacheCreate5m || 0) + (opts.cacheCreate1h || 0) + (outputTokens || 0));

  const sb = sessionId ? mgr.sessionBindings.get(sessionId) : null;
  // Resolve the model for pricing: explicit (message_start) → remember it; else the
  // binding's last-seen model (message_delta) → else null (→ opus).
  const model = opts.model || sb?.model || null;
  if (opts.model && sb) sb.model = opts.model;
  const price = mgr._priceFor(model);
  const cacheCreate5m = opts.cacheCreate5m || 0;
  const cacheCreate1h = opts.cacheCreate1h || 0;
  const cacheRead = opts.cacheRead || 0;
  const cost = (
    (inputTokens || 0) * price.in
    + cacheCreate5m * price.in * CACHE_WRITE_5M_MULT
    + cacheCreate1h * price.in * CACHE_WRITE_1H_MULT
    + cacheRead * price.in * CACHE_READ_MULT
    + (outputTokens || 0) * price.out
  ) / 1e6;
  account.usage.totalCost = (account.usage.totalCost || 0) + cost;

  // Per-session attribution for the live dashboard. Only attributes when the
  // session still has a binding.
  if (sessionId) {
    if (sb) {
      if (inputTokens) { sb.requests++; sb.inputTokens += inputTokens; }
      if (outputTokens) sb.outputTokens += outputTokens;
      sb.cost = (sb.cost || 0) + cost;
    }
    // Durable ledger (survives idle-eviction + restart).
    mgr._ledgerTouch(sessionId, account.name, inputTokens, outputTokens, cost, model);
    mgr._maybeSaveLedger();
  }
}

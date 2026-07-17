// D1DX (D-2169): per-model API pricing, $/Mtok [input, output]. The Messages API
// returns no cost field — the caller computes the API-equivalent cost from token
// usage + the response's `model`. Cache multipliers (of the INPUT rate): write-5m
// 1.25×, write-1h 2×, read 0.1×. Family parsed from the model string; unknown →
// opus (Claude Code is predominantly Opus). Override per-family via opts.pricing.
//   • priceFor(model, overrides, provider) — provider+model → { in, out } $/Mtok
//     (§7: pricing keys off provider+model; covered by test/tree.test.mjs via the
//     facade + test/provider-seam.test.mjs for the provider dimension).
const PRICING = {
  fable:  [10, 50],   // claude-fable-5 / mythos-5 (new top tier)
  mythos: [10, 50],
  opus:   [5, 25],    // opus 4.x
  sonnet: [3, 15],    // sonnet 4.x
  haiku:  [1, 5],     // haiku 4.5
};
// §7: per-provider price tables. Only the default (anthropic) table exists today; a
// future provider adapter (openrouter, codex) registers its own so a same-named
// model priced differently upstream bills correctly. An absent/unknown provider
// falls back to the anthropic table — zero behavior change for today's pool.
const PROVIDER_PRICING = {
  anthropic: PRICING,
};
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;
const CACHE_READ_MULT = 0.1;

// D1DX (D-2169): resolve $/Mtok [input, output] for a provider + model. The price
// TABLE is selected by provider (§7, default anthropic); the FAMILY is parsed from
// the model string; unknown family → opus (CC is mostly Opus). `overrides` is an
// optional per-family { family: [in$, out$] } map (opts.pricing on the manager),
// applied on top of the selected table.
function priceFor(model, overrides = null, provider = null) {
  const table = PROVIDER_PRICING[provider] || PRICING;
  const m = String(model || '').toLowerCase();
  let key = 'opus';
  if (m.includes('fable')) key = 'fable';
  else if (m.includes('mythos')) key = 'mythos';
  else if (m.includes('opus')) key = 'opus';
  else if (m.includes('sonnet')) key = 'sonnet';
  else if (m.includes('haiku')) key = 'haiku';
  const [inp, out] = (overrides && overrides[key]) || table[key] || PRICING[key];
  return { in: inp, out };
}

export { PRICING, PROVIDER_PRICING, CACHE_WRITE_5M_MULT, CACHE_WRITE_1H_MULT, CACHE_READ_MULT, priceFor };

// core/hold-policy.js — the all-throttled hold DECISION, pure (no req/res). Given
// pool state + elapsed wait it returns what the server's hold loop should do next;
// the LOOP itself (holdForThrottle) and the 429 writer (sendAllThrottled429) stay
// on the http side, because they read/write the live req/res and recurse into
// forwardRequest — that forward↔hold cycle must live in one module for the
// core-imports-nothing-from-http rule to hold. This module only computes.
//   • the apikey last-resort gate (DL-2420) + reset-aware all-throttled retry-after
//     — covered by all-throttled-hold.test (via the server), reactive-bench.test
//     (allThrottledBackoff via the facade).

// Retry-after (seconds) to hand the client when EVERY account is throttled.
// Real-reset-aware (soonest genuine reset across the pool), clamped to
// [backoffBaseSec, allThrottledCapSec].
export function allThrottledBackoff(mgr) {
  const now = Date.now();
  let soonest = Infinity;
  for (const a of mgr.accounts) {
    const candidates = [
      a.rateLimitedUntil,
      a.quota.unified5hReset,
      a.quota.unified7dReset,
      a.quota.resetsAt ? new Date(a.quota.resetsAt).getTime() : null,
    ];
    for (const t of candidates) {
      if (t && t > now && t < soonest) soonest = t;
    }
  }
  let secs = soonest === Infinity ? mgr.backoffBaseSec : (soonest - now) / 1000;
  secs = Math.max(mgr.backoffBaseSec, Math.min(mgr.allThrottledCapSec, secs));
  return Math.max(1, Math.ceil(secs));
}

// Decide the next move for a held inference request whose pool is all-throttled.
// Pure: the caller supplies elapsed wait + the two pool booleans (hasApikey,
// hardCapped) + the hold config; this returns one of three actions. The paid apikey
// (DL-2420) fires — instead of holding further or 429ing — when EITHER the OAuth
// pool is genuinely hard-capped (resets hours out) OR the max wait elapsed (the
// deadline minus a small lead, so it fires just before the client's own timeout).
// Otherwise: hold to the OAuth-recovery budget, then an honest reset-aware 429.
//   → { action: 'open-apikey' }            open the gate + re-attempt (OAuth still preferred)
//   → { action: 'give-up' }                send the all-throttled 429
//   → { action: 'retry', baseMs, ceilMs }  poll again; caller applies jitter within [0, ceilMs]
// The caller never sleeps past the OAuth-recovery budget, nor (with an apikey) past
// the apikey fire point — so the key fires on time, not a poll late.
export function decideHold({ elapsedMs, hasApikey, hardCapped, budgetSec, apikeyDeadlineSec, apikeyLeadSec, pollSec }) {
  if (hasApikey) {
    const fireAtMs = Math.max(0, (apikeyDeadlineSec - apikeyLeadSec) * 1000);
    if (hardCapped || elapsedMs >= fireAtMs) return { action: 'open-apikey' };
  }
  const remainingMs = budgetSec * 1000 - elapsedMs;
  if (remainingMs <= 0 || hardCapped) return { action: 'give-up' };

  const baseMs = pollSec * 1000;
  let ceilMs = remainingMs;
  if (hasApikey) {
    ceilMs = Math.min(ceilMs, Math.max(0, (apikeyDeadlineSec - apikeyLeadSec) * 1000 - elapsedMs));
  }
  return { action: 'retry', baseMs, ceilMs };
}

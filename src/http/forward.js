// http/forward.js — the request-forwarding path: account selection → dispatch →
// upstream, the 429/5xx failover loop, and the all-throttled HOLD loop.
// Owns:
//   • forwardRequest — select (session cache-affinity), atomic in-flight reserve,
//     build the upstream request, relay the response, and fail over on 429 /
//     retry on 5xx / hold when the whole pool is throttled.
//   • relayRaw — header-rewriting-free passthrough (the /v1/oauth/token relay).
//   • holdForThrottle + sendAllThrottled429 — the all-throttled HOLD LOOP. The
//     DECISION is pure in core/hold-policy.js; the loop lives HERE because it
//     reads/writes the live req/res and recurses into forwardRequest — the
//     forward↔hold cycle must stay inside one module for the core-imports-nothing-
//     from-http rule to hold.
//   • configureForward — resolve the HOLD knobs from config once at startup.
//   covered by: test/all-throttled-hold.test.mjs (HOLD loop, failover, apikey gate),
//   test/session-routing.test.mjs + test/selection.test.mjs (selection the forward
//   path drives via the AccountManager facade).

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decideHold } from '../core/hold-policy.js';
import { streamResponse, extractUsageFromBody } from './sse.js';

const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

// D1DX patch (D-1741): all-throttled HOLD-and-wait config. Set once by
// configureForward (called from createProxyServer) from config; defaults cover
// configs predating the keys.
// D1DX (D-2420): apikeyDeadlineSec/apikeyLeadSec gate the paid-key last resort.
let HOLD = { budgetSec: 1800, pollSec: 5, apikeyDeadlineSec: 300, apikeyLeadSec: 1 };

// D1DX patch (D-1741): resolve the all-throttled hold knobs once, at server
// construction. createProxyServer calls this before the listener is created.
export function configureForward(config) {
  HOLD = {
    budgetSec: Number.isFinite(config.allThrottledHoldBudgetSec) ? config.allThrottledHoldBudgetSec : 1800,
    pollSec:   Number.isFinite(config.holdPollSec) ? config.holdPollSec : 5,
    // D1DX (D-2420): paid-key last resort. Hold/poll for an OAuth account up to
    // apikeyDeadlineSec, then fire the apikey apikeyLeadSec before that.
    // IMPORTANT — a held request sends NO response headers, so Claude Code's
    // CLAUDE_CODE_CONNECT_TIMEOUT_MS (default 60s) aborts+retries it well before
    // 290s. This 290s default ASSUMES the box raised CLAUDE_CODE_CONNECT_TIMEOUT_MS
    // (box-env.sh sets 660000) so the hold can run that long AND the key's own
    // response still arrives inside the window. On a deploy WITHOUT that raise, set
    // apikeyFallbackDeadlineSec ≤ ~45 so the key fires before the 60s client abort.
    apikeyDeadlineSec: Number.isFinite(config.apikeyFallbackDeadlineSec) ? config.apikeyFallbackDeadlineSec : 290,
    apikeyLeadSec:     Number.isFinite(config.apikeyLastResortLeadSec) ? config.apikeyLastResortLeadSec : 1,
  };
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 */
export async function relayRaw(req, res, upstream) {
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);

  try {
    const upstreamRes = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'user-agent': req.headers['user-agent'] || 'node',
      },
      body: body.length > 0 ? body : undefined,
    });

    const responseBody = await upstreamRes.text();
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    res.end(responseBody);
  } catch (err) {
    console.error('[TeamClaude] Raw relay error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  }
}


function logTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

async function writeRequestLog(logDir, reqId, sections) {
  if (!logDir) return;
  const ts = logTimestamp();
  const filename = `${ts}_${String(reqId).padStart(5, '0')}.log`;
  try {
    await writeFile(join(logDir, filename), sections.join('\n\n'), 'utf-8');
  } catch (err) {
    console.error(`[TeamClaude] Failed to write log: ${err.message}`);
  }
}

function formatHeaders(headers) {
  if (headers.entries) {
    return [...headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

export async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir) {
  const maxRetries = accountManager.accounts.length;

  // Select account — per-session cache-affinity routing (D-1728). The
  // x-claude-code-session-id header is stable per Claude Code session; a warm
  // session sticks to its bound account, switching only on a blocker or after
  // the cache window lapses. No header (warmer / health / non-CC) → global
  // getActiveAccount() fallback (unchanged behavior).
  const sessionId = req.headers['x-claude-code-session-id'] || null;
  // DL-2841: parse the outbound model so selection can avoid a premium-tier (7d_oi)
  // capped account for premium requests only (non-premium keeps flowing to it). Cheap
  // one-shot parse; a non-JSON / unparseable body → model unknown → treated non-premium.
  let reqModel = null;
  if (body && body.length) { try { reqModel = JSON.parse(body.toString('utf8')).model || null; } catch { /* model unknown */ } }
  ctx.reqModel = reqModel; // Q1: the hold loop consults allHardCapped(model) for premium pool-wide rejection
  // D1DX (D-2420): the apikey is admitted only once the hold loop has set
  // ctx.allowApikey (max wait elapsed, or pool hard-capped). Normal binds keep it
  // gated so an all-OAuth-throttled pool returns null → HOLD, not the paid key.
  const account = accountManager.getAccountForSession(sessionId, { allowApikey: ctx.allowApikey === true, model: reqModel });
  if (!account) {
    // D1DX patch (D-1741): all accounts throttled at selection time — HOLD the
    // inference request and poll for one to free up, instead of returning a 429
    // that aborts the agent. (Was: immediate 429 with a real-reset-aware
    // retry-after — that path still fires as the last-resort give-up below.)
    return holdForThrottle(req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir);
  }

  // DL-2226: atomic in-flight reserve. tryReserveInflight checks maxInflightPerAccount
  // AND reserves the slot in one synchronous step, so a concurrent burst can't all
  // clear the cap while _inflight is still 0 — the rest HOLD here for a slot
  // (cache-affinity preserved, no rebind). _pickAccountForBinding pre-filters at-cap
  // accounts from NEW binds; this is the dispatch-time gate the bind-time filter's
  // TOCTOU would otherwise let a recovery herd slip through.
  let reserved = accountManager.tryReserveInflight(account.index);
  if (!reserved) {
    const SLOT_POLL_MS = 200, SLOT_BUDGET_MS = 5000;
    let waited = 0;
    while (!reserved && waited < SLOT_BUDGET_MS && !res.destroyed) {
      const step = SLOT_POLL_MS + Math.floor(Math.random() * SLOT_POLL_MS); // anti-herd jitter
      await new Promise(r => setTimeout(r, step));
      waited += step;
      reserved = accountManager.tryReserveInflight(account.index);
    }
    if (res.destroyed) { if (reserved) accountManager.noteInflightEnd(account.index); return; }
    if (!reserved) {
      // Budget exhausted and still no slot — never refuse. Reserve unconditionally and
      // dispatch; a resulting header-less 429 just fails over (reactive-only, no bench),
      // and by 5s an in-flight slot has almost certainly freed anyway.
      accountManager.noteInflightStart(account.index);
      reserved = true;
    }
  }

  // Track which account handles this request
  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // In-flight slot already reserved above (atomically via tryReserveInflight, or the
  // never-refuse fallback). Released by the dispatch try/finally below, or explicitly
  // on each early exit between here and it (token-refresh throw / token-error failover).

  // Refresh OAuth token if needed
  try {
    await accountManager.ensureTokenFresh(account.index);
  } catch (err) {
    accountManager.noteInflightEnd(account.index); // release on a refresh failure, then propagate
    throw err;
  }
  if (account.status === 'error' && retryCount < maxRetries) {
    accountManager.noteInflightEnd(account.index); // release before the failover re-selects + re-reserves
    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
  }

  // Build upstream request headers
  const isOAuth = account.type === 'oauth';
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk)) continue;
    if (lk === 'x-api-key') continue;
    // Strip accept-encoding: Node fetch auto-decompresses, which would
    // mismatch the Content-Encoding header we forward to the client
    if (lk === 'accept-encoding') continue;
    headers[key] = value;
  }

  // --- D1DX patch: defend against claude-code OAuth-beta clobber regression.
  // Claude Code 2.1.121+ intermittently drops `oauth-2025-04-20` from
  // `anthropic-beta` when model-level betas are merged in (Object.assign
  // source-order bug; OpenClaw #41444). Server returns 401 with misleading
  // "OAuth authentication is currently not supported". Always ensure the
  // gate is present on OAuth-account requests.
  if (isOAuth) {
    const REQUIRED_OAUTH_BETA = 'oauth-2025-04-20';
    const betaKey = Object.keys(headers).find(k => k.toLowerCase() === 'anthropic-beta');
    const existing = betaKey ? String(headers[betaKey]).split(',').map(s => s.trim()).filter(Boolean) : [];
    if (!existing.includes(REQUIRED_OAUTH_BETA)) {
      existing.unshift(REQUIRED_OAUTH_BETA);
      headers[betaKey || 'anthropic-beta'] = existing.join(',');
    }
  }
  // --- end D1DX patch ---

  if (isOAuth) {
    headers['authorization'] = `Bearer ${account.credential}`;
  } else {
    headers['x-api-key'] = account.credential;
  }

  // --- D1DX patch (D-2655): per-account upstream + model override for the
  // apikey last-resort (GLM-5.2 via OpenRouter). Fires ONLY for an apikey
  // account that declares its own `upstream`; OAuth + plain Anthropic-apikey
  // are untouched. Rewrites body.model, pins the fp8 provider, swaps to Bearer.
  let effectiveUpstream = upstream;
  let outBody = body;
  if (account.type === 'apikey' && account.upstream) {
    effectiveUpstream = account.upstream;
    if (account.model && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString());
        parsed.model = account.model;
        if (account.provider) parsed.provider = account.provider;
        outBody = Buffer.from(JSON.stringify(parsed));
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === 'content-length') delete headers[k];
        }
      } catch { /* non-JSON body — forward unchanged */ }
    }
    delete headers['x-api-key'];
    headers['authorization'] = `Bearer ${account.credential}`;
  }
  // --- end D1DX patch (D-2655) ---

  const upstreamUrl = `${effectiveUpstream}${req.url}`;
  const method = req.method;

  // Build log sections
  const logSections = [];
  if (logDir) {
    const safeHeaders = { ...headers };
    // Mask credentials in logs
    if (safeHeaders['x-api-key']) {
      safeHeaders['x-api-key'] = safeHeaders['x-api-key'].slice(0, 15) + '...';
    }
    if (safeHeaders['authorization']) {
      safeHeaders['authorization'] = safeHeaders['authorization'].slice(0, 20) + '...';
    }
    logSections.push(
      `=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(safeHeaders)}`,
    );
    if (body.length > 0) {
      try {
        logSections.push(`=== REQUEST BODY ===\n${JSON.stringify(JSON.parse(body.toString()), null, 2)}`);
      } catch {
        logSections.push(`=== REQUEST BODY (${body.length} bytes) ===\n${body.toString().slice(0, 4096)}`);
      }
    }
  }

  // D1DX patch (D-1903 + D-2226): the in-flight slot was reserved synchronously
  // at selection above (D-2226). This try/finally is its release scope for the
  // dispatch path — the finally below releases on every exit (success, terminal
  // error, or a failover/hold/retry recursion). Recursion stays balanced: a
  // recursive forwardRequest() reserves its OWN slot synchronously, and this
  // invocation's finally fires the moment that recursive call yields at its first
  // `await`, so the count never accumulates across the retry chain.
  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : outBody,
      redirect: 'manual',
    });

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) {
        rateLimitHeaders[key] = value;
      }
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

    // --- D1DX patch (D-1642): 429 → immediate failover (upstream PR #13).
    // A 429 means this account is rate-limited or out of quota. Mark it
    // unavailable for the retry-after window and immediately fail over to the
    // next available account, rather than holding the client connection open
    // waiting on a dead account (for quota exhaustion retry-after can be hours).
    // Once every account is throttled, getActiveAccount() returns null on the
    // next pass and the client gets a 429 with a proper retry-after to back off.
    if (upstreamRes.status === 429) {
      // D1DX patch (D-1705 S1): pass the header through as-is (null when absent)
      // so markRateLimited derives the real window from the unified resets
      // instead of defaulting to a blind 60s.
      const hdr = parseInt(upstreamRes.headers.get('retry-after'), 10);
      const headerRetryAfter = isNaN(hdr) ? null : hdr;
      // Discard the 429 response body
      await upstreamRes.body?.cancel();
      accountManager.markRateLimited(account.index, headerRetryAfter);

      if (logDir) {
        logSections.push(`=== RESPONSE 429 — "${account.name}" rate-limited (retry-after header: ${headerRetryAfter ?? 'none'}), failing over ===\n${formatHeaders(upstreamRes.headers)}`);
      }
      console.log(`[TeamClaude] 429 on "${account.name}" — rate-limited (header: ${headerRetryAfter ?? 'none'}), failing over`);

      if (retryCount < maxRetries && !res.headersSent) {
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
      }

      // D1DX patch (D-1741): every account 429'd this failover pass — HOLD the
      // inference request and poll, instead of returning a 429 that aborts the
      // agent. Under heavy parallel load this is almost always a cluster of
      // transient header-less 429s that clear in ~60-140s.
      if (logDir) writeRequestLog(logDir, reqId, logSections);
      return holdForThrottle(req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir);
    }
    // --- end D1DX 429 patch ---

    // --- D1DX patch (D-1642 + D-1647): server-side 5xx → hold-and-backoff.
    // 529/500/502/503 are transient, (mostly) global Anthropic server-side
    // errors, NOT account-specific — switching accounts does not help. Hold the
    // client connection and retry the SAME account with exponential backoff
    // (capped 60s/wait) for up to ~1h cumulative, then return the upstream
    // status so the client can give up cleanly. retryCount is left untouched —
    // these retries must not consume the account-failover budget used by the
    // 429 path above. D-1647: 500/502/503 folded in alongside 529 per operator
    // decision (uniform server-error handling; volume is low — §3). Client
    // disconnect / headersSent ends the loop early.
    if ([500, 502, 503, 529].includes(upstreamRes.status)) {
      const serverStatus = upstreamRes.status;
      await upstreamRes.body?.cancel();
      if (ctx.overloadStart == null) ctx.overloadStart = Date.now();
      ctx.overloadAttempts = (ctx.overloadAttempts || 0) + 1;
      const OVERLOAD_BUDGET_MS = 60 * 60 * 1000; // ~1 hour total
      const elapsed = Date.now() - ctx.overloadStart;
      // exponential backoff: 1s, 2s, 4s, ... capped at 60s/wait
      const backoff = Math.min(60000, 1000 * 2 ** Math.min(ctx.overloadAttempts - 1, 6));

      if (elapsed + backoff < OVERLOAD_BUDGET_MS && !res.headersSent && !res.destroyed) {
        if (logDir) {
          logSections.push(`=== RESPONSE ${serverStatus} — server error, retry ${ctx.overloadAttempts} after ${backoff}ms (elapsed ${Math.round(elapsed / 1000)}s) ===\n${formatHeaders(upstreamRes.headers)}`);
        }
        console.log(`[TeamClaude] ${serverStatus} server error on "${account.name}" — retry ${ctx.overloadAttempts} in ${Math.round(backoff / 1000)}s (elapsed ${Math.round(elapsed / 1000)}s/3600s)`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        // Client may have disconnected during the wait
        if (res.destroyed) return;
        return forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir);
      }

      // Budget exhausted (or client gone) — return the upstream status to the client.
      ctx.status = serverStatus;
      console.log(`[TeamClaude] ${serverStatus} server error on "${account.name}" — giving up after ${Math.round(elapsed / 1000)}s, returning ${serverStatus}`);
      if (logDir) {
        logSections.push(`=== RESPONSE ${serverStatus} — server-error budget exhausted after ${Math.round(elapsed / 1000)}s ===\n${formatHeaders(upstreamRes.headers)}`);
        writeRequestLog(logDir, reqId, logSections);
      }
      if (!res.headersSent) {
        res.writeHead(serverStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'overloaded_error',
            message: `Upstream server error (${serverStatus}) — retried with backoff for ~1h before giving up.`,
          },
        }));
      }
      return;
    }
    // --- end D1DX 5xx backoff patch ---

    // A genuine success marks the account proven (opens its in-flight cap) and
    // recalibrates its success-taught 5h cap (reporting only).
    if (upstreamRes.status < 400) {
      accountManager.noteSuccess();
      accountManager.noteAccountSuccess(account.index);
    }

    // Log response headers
    if (logDir) {
      logSections.push(`=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);
    }

    ctx.status = upstreamRes.status;

    // Build response headers (skip hop-by-hop and encoding headers)
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection') continue;
      // Strip content-encoding/content-length since fetch may auto-decompress
      if (key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }

    res.writeHead(upstreamRes.status, responseHeaders);

    if (!upstreamRes.body) {
      if (logDir) {
        logSections.push(`=== RESPONSE BODY ===\n(empty)`);
        writeRequestLog(logDir, reqId, logSections);
      }
      res.end();
      return;
    }

    const isStreaming = (upstreamRes.headers.get('content-type') || '').includes('text/event-stream');

    if (isStreaming) {
      const streamLog = logDir ? [] : null;
      await streamResponse(upstreamRes.body, res, account.index, accountManager, streamLog, sessionId);
      if (logDir) {
        logSections.push(`=== RESPONSE BODY (streamed) ===\n${streamLog.join('')}`);
        writeRequestLog(logDir, reqId, logSections);
      }
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager, sessionId);
      if (logDir) {
        try {
          logSections.push(`=== RESPONSE BODY ===\n${JSON.stringify(JSON.parse(buf.toString()), null, 2)}`);
        } catch {
          logSections.push(`=== RESPONSE BODY (${buf.length} bytes) ===\n${buf.toString().slice(0, 8192)}`);
        }
        writeRequestLog(logDir, reqId, logSections);
      }
      res.end(buf);
    }
  } catch (err) {
    console.error(`[TeamClaude] Upstream error (account "${account.name}"):`, err.message);

    if (logDir) {
      logSections.push(`=== ERROR ===\n${err.stack || err.message}`);
      writeRequestLog(logDir, reqId, logSections);
    }

    const isTransient = err instanceof Error &&
      (err.message.includes('fetch failed') ||
        err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT');

    // Transient network errors: just close the connection and let the client retry
    if (isTransient) {
      res.destroy();
      return;
    }

    if (retryCount < maxRetries && !res.headersSent) {
      account.status = 'error';
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
    }
    ctx.status = 502;

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'proxy_error', message: `Upstream error: ${err.message}` },
      }));
    }
  } finally {
    // D1DX patch (D-1903): release this account's in-flight slot on every exit
    // path (success, terminal error, or a failover/hold/retry recursion).
    accountManager.noteInflightEnd(account.index);
  }
}

/**
 * D1DX patch (D-1741): all accounts throttled → HOLD the client and poll for an
 * account to free up, instead of returning a 429 that aborts the agent. Under
 * heavy parallel load the all-throttled state is almost always a cluster of
 * transient header-less 429s that clear in ~60-140s (D-1728 bounded per-account
 * backoff), so a held request becomes slower-but-successful. Mirrors the 5xx
 * hold-and-backoff already in forwardRequest.
 *
 *  - Only inference (/v1/messages) is held; health / warmer / non-Claude-Code
 *    traffic keeps the original immediate 429.
 *  - Last-resort 429 is returned when the hold budget is spent, the client
 *    disconnects, or EVERY account is genuinely hard-capped (real weekly/5h
 *    exhaustion — holding would be pointless; resets are hours out).
 *  - The hold budget (ctx.throttleHoldStart) is cumulative across both
 *    all-throttled sites and across failover recursions for one client request.
 */
async function holdForThrottle(req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir) {
  ctx.account = ctx.account || '(none available)';

  // Only hold inference. Health probes / warmer / non-CC clients get the fast 429.
  const isInference = typeof req.url === 'string' && req.url.startsWith('/v1/messages');
  if (!isInference) return sendAllThrottled429(res, accountManager, ctx);

  if (ctx.throttleHoldStart == null) ctx.throttleHoldStart = Date.now();
  const elapsedMs = Date.now() - ctx.throttleHoldStart;
  if (res.destroyed) return;

  // The DECISION is pure (core/hold-policy.js); this loop owns the req/res + the
  // forwardRequest recursion. hasUsableApikey is called once (it sweeps expired
  // throttles as a side effect); allHardCapped is a side-effect-free read.
  const hasApikey = accountManager.hasUsableApikey?.() === true;
  const hardCapped = accountManager.allHardCapped(ctx.reqModel);
  const decision = decideHold({
    elapsedMs, hasApikey, hardCapped,
    budgetSec: HOLD.budgetSec,
    apikeyDeadlineSec: HOLD.apikeyDeadlineSec,
    apikeyLeadSec: HOLD.apikeyLeadSec,
    pollSec: HOLD.pollSec,
  });

  // Paid-key last resort (DL-2420): open the gate + re-attempt. ctx.allowApikey
  // widens _pickAccountForBinding's fallback — OAuth is still preferred if one
  // recovered in the same tick. Subscriptions are always tried first, to the max.
  if (decision.action === 'open-apikey') {
    ctx.allowApikey = true;
    console.log(`[TeamClaude] apikey last-resort for ${reqId} after ${Math.round(elapsedMs / 1000)}s (${hardCapped ? 'OAuth hard-capped' : `deadline ${HOLD.apikeyDeadlineSec}s`})`);
    return forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
  }

  // Hold budget spent, or a genuinely hard-capped pool with no apikey (holding
  // can't recover it): an honest reset-aware 429.
  if (decision.action === 'give-up') {
    return sendAllThrottled429(res, accountManager, ctx);
  }

  // Poll: short, anti-herd jitter within the ceiling the decision computed (never
  // past the OAuth-recovery budget, nor — with an apikey — past the fire point).
  const waitMs = Math.min(decision.ceilMs, decision.baseMs + Math.floor(Math.random() * decision.baseMs));

  ctx.throttleHolds = (ctx.throttleHolds || 0) + 1;
  if (ctx.throttleHolds === 1 || ctx.throttleHolds % 6 === 0) {
    const cap = hasApikey ? `${HOLD.apikeyDeadlineSec}s→apikey` : `${HOLD.budgetSec}s`;
    console.log(`[TeamClaude] all OAuth throttled — holding request ${reqId} (waited ${Math.round(elapsedMs / 1000)}s/${cap})`);
  }
  await new Promise(resolve => setTimeout(resolve, waitMs));
  if (res.destroyed) return;

  // Re-attempt from a clean failover budget — pool state changed during the wait.
  return forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
}

// D1DX (D-2179): allHardCapped folded into AccountManager.allHardCapped() — the
// D-1741 local copy is gone now the sibling work has landed.

// The last-resort all-throttled 429 (unchanged behavior — real-reset-aware
// retry-after via AccountManager.allThrottledBackoff()).
function sendAllThrottled429(res, accountManager, ctx) {
  ctx.status = 429;
  if (res.headersSent) return;
  const retryAfter = accountManager.allThrottledBackoff();
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'retry-after': String(retryAfter),
  });
  res.end(JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `All ${accountManager.accounts.length} accounts throttled. Retry in ${retryAfter}s.`,
    },
  }));
}

// D1DX patch (D-1705): the free `computeRetryAfter(accounts)` helper was removed.
// Its job (the client retry-after when all accounts are throttled) now lives in
// AccountManager.allThrottledBackoff() — real-reset-aware, escalating, jittered.

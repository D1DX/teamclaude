import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

// D1DX patch (D-1741): all-throttled HOLD-and-wait config. Set once in
// createProxyServer from config; defaults cover configs predating the keys.
// (Lives here, not on AccountManager, because D-1741 shares account-manager.js
// with a live sibling session — see the D-1741 issue thread.)
let HOLD = { budgetSec: 1800, pollSec: 5 };

export function createProxyServer(accountManager, config, hooks = {}) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const proxyApiKey = config.proxy?.apiKey;
  // D1DX (D-1728): per-request full-body dumps are OFF unless `logRequests` is
  // explicitly true. This nulls the dump dir, so all the per-request log-section
  // building + writeRequestLog calls below short-circuit on `if (logDir)`. The
  // daily operational log (switches/throttles/binds/errors) is written separately
  // via the console tee in index.js (resolveLogDir) and is unaffected.
  const logDir = (config.logRequests === true && config.logDir) ? config.logDir : null;
  let requestCounter = 0;

  // D1DX patch (D-1741): resolve the all-throttled hold knobs once.
  HOLD = {
    budgetSec: Number.isFinite(config.allThrottledHoldBudgetSec) ? config.allThrottledHoldBudgetSec : 1800,
    pollSec:   Number.isFinite(config.holdPollSec) ? config.holdPollSec : 5,
  };

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Auth check — skip for localhost connections
      const clientKey = req.headers['x-api-key'];
      const remoteAddr = req.socket.remoteAddress;
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      if (proxyApiKey && clientKey !== proxyApiKey && !isLocal) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        }));
        return;
      }

      // Status endpoint
      if (req.method === 'GET' && req.url === '/teamclaude/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(accountManager.getStatus(), null, 2));
        return;
      }

      // D-2179: capacity endpoint — orchestrators gate worker launches on this
      // (verdict / headroom / soonestResetSec). Localhost-only like /status.
      if (req.method === 'GET' && (req.url === '/teamclaude/capacity' || req.url === '/capacity')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(accountManager.computeCapacity(), null, 2));
        return;
      }

      // D1DX patch (D-1903): local health endpoint. A bare `GET`/`HEAD /` (and
      // `/health`) is a connectivity probe Claude Code / monitors fire ~every 30s.
      // Anthropic returns 404 for it, so WITHOUT this short-circuit every probe is
      // forwarded upstream on a real Max account — burning a token refresh + a
      // selection + a real round-trip to api.anthropic.com, AND emitting a
      // `GET / → <acct> (404)` oplog line (23% of the daily log on 2026-06-05) +
      // consuming the all-throttled path during saturation (234 spurious 429s that
      // day). Answer it locally with 200, no routing, and return BEFORE the request
      // counter / onRequest* hooks so it never reaches an account or the log.
      if ((req.method === 'GET' || req.method === 'HEAD') && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok', service: 'teamclaude' }));
        return;
      }

      // Let client token refresh requests pass through to upstream untouched.
      // The proxy manages its own tokens via ensureTokenFresh(); intercepting
      // or rewriting client refreshes would cause token rotation conflicts.
      if (req.method === 'POST' && req.url === '/v1/oauth/token') {
        await relayRaw(req, res, upstream);
        return;
      }

      // Track request
      const reqId = ++requestCounter;
      hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

      // Buffer request body (needed for retry on 429)
      const bodyChunks = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk);
      }
      const body = Buffer.concat(bodyChunks);

      const ctx = { account: null, status: null };
      try {
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error('[TeamClaude] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'proxy_error', message: 'Internal proxy error' },
          }));
        }
      } finally {
        hooks.onRequestEnd?.(reqId, {
          method: req.method, path: req.url,
          account: ctx.account, status: ctx.status,
        });
      }
    } catch (err) {
      console.error('[TeamClaude] Unhandled error:', err);
    }
  });

  return server;
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 */
async function relayRaw(req, res, upstream) {
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

async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir) {
  const maxRetries = accountManager.accounts.length;

  // Select account — per-session cache-affinity routing (D-1728). The
  // x-claude-code-session-id header is stable per Claude Code session; a warm
  // session sticks to its bound account, switching only on a blocker or after
  // the cache window lapses. No header (warmer / health / non-CC) → global
  // getActiveAccount() fallback (unchanged behavior).
  const sessionId = req.headers['x-claude-code-session-id'] || null;
  const account = accountManager.getAccountForSession(sessionId);
  if (!account) {
    // D1DX patch (D-1741): all accounts throttled at selection time — HOLD the
    // inference request and poll for one to free up, instead of returning a 429
    // that aborts the agent. (Was: immediate 429 with a real-reset-aware
    // retry-after — that path still fires as the last-resort give-up below.)
    return holdForThrottle(req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir);
  }

  // D1DX patch (D-2226): warm-path in-flight cap — HOLD for a slot, don't pile on
  // or churn. _pickAccountForBinding excludes at-cap accounts from NEW binds, so an
  // at-cap account reaching here is a warm-stuck session (or the all-at-cap
  // fallback). Briefly wait for one of its OWN in-flight requests to finish, then
  // dispatch to the SAME account — cache-affinity preserved, no rebind. The
  // reservation below is synchronous with the final at-cap check (no `await`
  // between the loop exit and noteInflightStart), so the freed slot is taken
  // atomically. Budget-bounded: on timeout we dispatch anyway (never refuse — and a
  // resulting burst-429 now benches ~60s, not 15 min).
  if (accountManager.atInflightCap(account.index)) {
    const WARM_SLOT_POLL_MS = 200, WARM_SLOT_BUDGET_MS = 5000;
    let waited = 0;
    while (accountManager.atInflightCap(account.index) && waited < WARM_SLOT_BUDGET_MS && !res.destroyed) {
      const step = WARM_SLOT_POLL_MS + Math.floor(Math.random() * WARM_SLOT_POLL_MS); // anti-herd jitter
      await new Promise(r => setTimeout(r, step));
      waited += step;
    }
    if (res.destroyed) return; // client gave up during the wait — nothing reserved yet
  }

  // Track which account handles this request
  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // D1DX patch (D-2226): reserve the in-flight slot SYNCHRONOUSLY at selection —
  // BEFORE the first `await` below — so a burst of concurrent requests can't all
  // clear the per-account in-flight cap while _inflight is still 0. That TOCTOU
  // race (selection read _inflight at getAccountForSession, but the increment
  // used to land only at dispatch, after `await ensureTokenFresh`) defeated the
  // probe-gate and let the recovery herd dogpile a just-freed account. Released by
  // the dispatch try/finally below, or explicitly on each early exit between here
  // and it (token-refresh throw / token-error failover).
  accountManager.noteInflightStart(account.index);

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

  const upstreamUrl = `${upstream}${req.url}`;
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
      body: ['GET', 'HEAD'].includes(method) ? undefined : body,
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

    // D1DX patch (D-1705 S3): a genuine success ends any all-throttled episode —
    // reopen the half-open recovery gate + reset the escalation streak.
    // D-1728: also clear this account's per-account 429 backoff streak.
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
  const budgetMs = HOLD.budgetSec * 1000;
  const elapsedMs = Date.now() - ctx.throttleHoldStart;
  const remainingMs = budgetMs - elapsedMs;

  // Give up: budget spent, client gone, or genuine exhaustion. allHardCapped is
  // the real-vs-transient discriminator — a transiently-benched account is NOT
  // hard-capped (its quota has headroom), so it is held for; a genuinely capped
  // pool (quota ≥ ceiling / status rejected) resets hours out, so holding the
  // full budget would just hang the agent before erroring anyway.
  if (remainingMs <= 0 || res.destroyed || accountManager.allHardCapped()) {
    if (res.destroyed) return;
    return sendAllThrottled429(res, accountManager, ctx);
  }

  // Poll: short, anti-herd jitter, never past the remaining budget.
  const baseMs = HOLD.pollSec * 1000;
  const waitMs = Math.min(remainingMs, baseMs + Math.floor(Math.random() * baseMs));

  ctx.throttleHolds = (ctx.throttleHolds || 0) + 1;
  if (ctx.throttleHolds === 1 || ctx.throttleHolds % 6 === 0) {
    console.log(`[TeamClaude] all accounts throttled — holding request ${reqId} (waited ${Math.round(elapsedMs / 1000)}s/${HOLD.budgetSec}s)`);
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

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
async function streamResponse(webStream, res, accountIndex, accountManager, streamLog, sessionId = null) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Client disconnected — stop reading from upstream
      if (res.destroyed) break;

      // Forward chunk immediately
      const ok = res.write(value);

      const text = decoder.decode(value, { stream: true });

      // Capture for logging
      if (streamLog) streamLog.push(text);

      // Parse SSE events for usage tracking
      sseBuffer += text;
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop(); // keep incomplete event

      for (const event of events) {
        parseSSEUsage(event, accountIndex, accountManager, sessionId);
      }

      // Handle backpressure — also bail out if client disconnects,
      // because 'drain' will never fire on a destroyed socket
      if (!ok) {
        await new Promise(resolve => {
          res.once('drain', resolve);
          res.once('close', resolve);
        });
        if (res.destroyed) break;
      }
    }

    // Parse any remaining buffer
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, accountIndex, accountManager, sessionId);
    }
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

function parseSSEUsage(event, accountIndex, accountManager, sessionId = null) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message?.usage) {
      // D-2169: input + cache tokens + model land on message_start. Output
      // tokens arrive on message_delta (no model — the binding remembers it).
      accountManager.updateUsage(
        accountIndex, data.message.usage.input_tokens || 0, 0, sessionId,
        { ..._cacheOpts(data.message.usage), model: data.message.model || null },
      );
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(accountIndex, 0, data.usage.output_tokens || 0, sessionId);
    }
  } catch {
    // not valid JSON, skip
  }
}

// D-2169: split a usage object's cache-creation into 5m vs 1h. When the API
// omits the breakdown, treat all cache-creation as 5m (Claude Code's default TTL).
function _cacheOpts(usage) {
  const cc = usage.cache_creation || {};
  let c5 = cc.ephemeral_5m_input_tokens;
  let c1 = cc.ephemeral_1h_input_tokens;
  if (c5 == null && c1 == null) { c5 = usage.cache_creation_input_tokens || 0; c1 = 0; }
  else { c5 = c5 || 0; c1 = c1 || 0; }
  return { cacheCreate5m: c5, cacheCreate1h: c1, cacheRead: usage.cache_read_input_tokens || 0 };
}

function extractUsageFromBody(buffer, accountIndex, accountManager, sessionId = null) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      accountManager.updateUsage(
        accountIndex, json.usage.input_tokens || 0, json.usage.output_tokens || 0, sessionId,
        { ..._cacheOpts(json.usage), model: json.model || null },
      );
    }
  } catch {
    // not JSON or no usage
  }
}

// D1DX patch (D-1705): the free `computeRetryAfter(accounts)` helper was removed.
// Its job (the client retry-after when all accounts are throttled) now lives in
// AccountManager.allThrottledBackoff() — real-reset-aware, escalating, jittered.

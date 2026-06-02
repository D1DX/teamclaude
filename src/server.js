import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

export function createProxyServer(accountManager, config, hooks = {}) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  let requestCounter = 0;

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
    ctx.status = 429;
    ctx.account = '(none available)';
    // D1DX patch (D-1705): real-reset-aware, escalating, jittered backoff.
    const retryAfter = accountManager.allThrottledBackoff();
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'retry-after': String(retryAfter),
    });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: `All ${accountManager.accounts.length} accounts exhausted. Retry in ${retryAfter}s.`,
      },
    }));
    return;
  }

  // Track which account handles this request
  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // Refresh OAuth token if needed
  await accountManager.ensureTokenFresh(account.index);
  if (account.status === 'error' && retryCount < maxRetries) {
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

      // Retries exhausted — every account is throttled; tell the client to back off.
      ctx.status = 429;
      if (logDir) writeRequestLog(logDir, reqId, logSections);
      if (!res.headersSent) {
        const clientRetryAfter = accountManager.allThrottledBackoff();
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'retry-after': String(clientRetryAfter),
        });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `All ${accountManager.accounts.length} accounts rate-limited. Retry in ${clientRetryAfter}s.`,
          },
        }));
      }
      return;
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
      await streamResponse(upstreamRes.body, res, account.index, accountManager, streamLog);
      if (logDir) {
        logSections.push(`=== RESPONSE BODY (streamed) ===\n${streamLog.join('')}`);
        writeRequestLog(logDir, reqId, logSections);
      }
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager);
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
  }
}

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
async function streamResponse(webStream, res, accountIndex, accountManager, streamLog) {
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
        parseSSEUsage(event, accountIndex, accountManager);
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
      parseSSEUsage(sseBuffer, accountIndex, accountManager);
    }
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

function parseSSEUsage(event, accountIndex, accountManager) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message?.usage) {
      accountManager.updateUsage(accountIndex, data.message.usage.input_tokens, 0);
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(accountIndex, 0, data.usage.output_tokens);
    }
  } catch {
    // not valid JSON, skip
  }
}

function extractUsageFromBody(buffer, accountIndex, accountManager) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      accountManager.updateUsage(accountIndex, json.usage.input_tokens, json.usage.output_tokens);
    }
  } catch {
    // not JSON or no usage
  }
}

// D1DX patch (D-1705): the free `computeRetryAfter(accounts)` helper was removed.
// Its job (the client retry-after when all accounts are throttled) now lives in
// AccountManager.allThrottledBackoff() — real-reset-aware, escalating, jittered.

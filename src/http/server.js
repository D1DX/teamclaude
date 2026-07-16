// http/server.js — the proxy's front door: the HTTP listener, the proxy-key auth
// gate, the local health/build endpoints, and the top-level routing that hands
// each request to the ops surface (http/admin.js), the raw token relay, or the
// forwarding path (http/forward.js). Owns nothing about account selection or
// upstream shape — it only routes.
//   covered by: test/all-throttled-hold.test.mjs (drives createProxyServer end
//   to end: auth-exempt localhost, health short-circuit, the /v1/messages path).

import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { BUILD } from '../version.js';
import { handleAdminRoute } from './admin.js';
import { forwardRequest, relayRaw, configureForward } from './forward.js';

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

  // D1DX patch (D-1741): resolve the all-throttled hold knobs once, before serving.
  configureForward(config);

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

      // Ops surface (/teamclaude/* + /capacity) — served locally, never upstream.
      if (await handleAdminRoute(req, res, { accountManager, config, upstream })) return;

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
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok', service: 'teamclaude', build: BUILD }));
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

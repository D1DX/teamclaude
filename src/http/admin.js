// http/admin.js — the /teamclaude/* ops surface (+ the /capacity alias). These
// are read/act endpoints served locally, never routed upstream, never oplogged;
// the top auth gate (http/server.js) protects them exactly like inference
// (localhost exempt, remote needs the proxy key).
//
// Today's endpoints (all D1DX): status · capacity · deck · warm. The endpoint-
// first ops plan (architecture-v3 §8) lands the rest HERE — reload (DL-2931),
// enable/disable/remove/re-auth (DL-2546), refresh-all (DL-3017), drop-request
// /reaper (DL-3021). Keep this dispatcher flat and additive: one guarded branch
// per route, returning true once handled.
//   covered by: /status + /warm shapes via test/warm-headroom.test.mjs +
//   test/deck-snapshot.test.mjs (the AccountManager snapshots these serve).

import { BUILD } from '../version.js';

/**
 * Handle an ops-surface request. Returns true if the URL matched an admin route
 * (and a response was written), false to let the caller keep routing.
 *   ctx = { accountManager, config, upstream }
 */
export async function handleAdminRoute(req, res, { accountManager, config, upstream }) {
  // Status endpoint
  if (req.method === 'GET' && req.url === '/teamclaude/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // D-2226: report the RUNNING proxy's build (this process), so `teamclaude
    // status` shows what's actually live — not the on-disk copy the CLI sees.
    res.end(JSON.stringify({ ...accountManager.getStatus(), build: BUILD }, null, 2));
    return true;
  }

  // D-2179: capacity endpoint — orchestrators gate worker launches on this
  // (verdict / headroom / soonestResetSec). Localhost-only like /status.
  if (req.method === 'GET' && (req.url === '/teamclaude/capacity' || req.url === '/capacity')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(accountManager.computeCapacity(), null, 2));
    return true;
  }

  // D-2485: full Deck snapshot — everything tui.js render() needs, so
  // `teamclaude watch` can render the live Deck READ-ONLY (no port bind, no
  // second server). Localhost + x-api-key gated exactly like /status; served
  // locally, never routed upstream, never logged.
  if (req.method === 'GET' && req.url === '/teamclaude/deck') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...accountManager.getDeckSnapshot(), build: BUILD }, null, 2));
    return true;
  }

  // D-2805: on-demand mint — start the 5h window EARLY for the headroom
  // OAuth accounts (the morning primer curls this from localhost). Gated by
  // the top auth check exactly like /status (remote needs the key; localhost
  // exempt). Uses the proxy's own warmOne → ensureTokenFresh, so an expired
  // token is refreshed clobber-safely (no second process racing the token
  // store). Never routed upstream as a proxied request.
  if (req.method === 'POST' && req.url === '/teamclaude/warm') {
    const threshold = Number.isFinite(config.warmHeadroomThreshold) ? config.warmHeadroomThreshold : 0.90;
    const summary = await accountManager.warmHeadroom(threshold, upstream);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...summary, build: BUILD }, null, 2));
    return true;
  }

  return false;
}

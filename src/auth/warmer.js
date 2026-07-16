// auth/warmer.js — account warming: fire one minimal request per account to refresh
// its token and anchor its 5h window + unified-ratelimit headers, so selection isn't
// blind on request #1. warmAll runs at boot (bounded; a network-failed account is
// retried by a terminating background pass); warmHeadroom is the on-demand morning
// "mint" that starts each headroom account's 5h window early. Refreshes go through
// mgr.ensureTokenFresh (the coalesced per-PROCESS refresh) so an expired token is
// refreshed clobber-safely by the running proxy itself, never a second process
// racing the shared token store into invalid_grant.
//   • covered by warm-headroom.test.

// Warm all accounts at startup. The first pass is awaited (boot timing unchanged —
// still bounded by the caller's 15s deadline). An account that fails on a NETWORK
// error (proxy booted before Wi-Fi/VPN was up) is retried by a BOUNDED, TERMINATING
// background pass (rewarmFailed) that self-heals within ~75s then stops — NOT a
// perpetual timer. An account that REACHED the API (any HTTP status, incl. 429) is
// anchored and never retried. Best-effort throughout: nothing here blocks boot.
export async function warmAll(mgr, upstream = 'https://api.anthropic.com') {
  console.log(`[TeamClaude] Warming ${mgr.accounts.length} account(s) at startup...`);
  const failed = [];
  await Promise.all(mgr.accounts.map(async (account) => {
    try {
      await mgr.warmOne(account, upstream);
    } catch (err) {
      console.error(`[TeamClaude] Warm failed for "${account.name}": ${err.message}`);
      failed.push(account.index);
    }
  }));
  // Self-heal a cold-network boot. Detached (not awaited) so it outlives the caller's
  // 15s boot deadline; bounded + terminating so it isn't a timer.
  if (failed.length > 0) {
    mgr._rewarmFailed(failed, upstream).catch(() => {});
  }
}

// Single warm attempt for one account. Refreshes the token, fires the minimal
// request, folds the rate-limit headers into quota. Resolves once the API was
// REACHED (returns the HTTP status — any status anchors the window); throws on a
// network/token error so the caller can decide whether to retry.
export async function warmOne(mgr, account, upstream = 'https://api.anthropic.com') {
  await mgr.ensureTokenFresh(account.index);
  const isOAuth = account.type === 'oauth';
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (isOAuth) {
    headers['authorization'] = `Bearer ${account.credential}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  } else {
    headers['x-api-key'] = account.credential;
  }
  const res = await fetch(`${upstream}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const rl = {};
  for (const [k, v] of res.headers.entries()) {
    if (k.startsWith('anthropic-ratelimit-')) rl[k] = v;
  }
  mgr.updateQuota(account.index, rl);
  await res.body?.cancel?.();
  const w = account.quota.unified7d != null ? `${(account.quota.unified7d * 100).toFixed(0)}%` : '?';
  console.log(`[TeamClaude] Warmed "${account.name}" (HTTP ${res.status}, weekly ${w})`);
  return res.status;
}

// D-2805: on-demand "mint" of the headroom OAuth accounts — start each account's 5h
// window EARLY (the morning primer curls POST /teamclaude/warm). Warms ONLY OAuth
// accounts under `threshold` weekly utilization; a capped account is skipped (a warm
// can't help it until reset). Best-effort per account; never throws. Returns a
// summary the caller serializes as JSON.
export async function warmHeadroom(mgr, threshold = 0.90, upstream = 'https://api.anthropic.com') {
  const minted = [];
  const skipped = [];
  for (const account of mgr.accounts) {
    if (account.type !== 'oauth') { skipped.push({ name: account.name, reason: 'not oauth' }); continue; }
    const u7 = account.quota?.unified7d;
    if (u7 != null && u7 >= threshold) {
      skipped.push({ name: account.name, reason: `weekly ${(u7 * 100).toFixed(0)}% ≥ ${(threshold * 100).toFixed(0)}% (capped)` });
      continue;
    }
    try {
      const status = await mgr.warmOne(account, upstream);
      minted.push({
        name: account.name,
        status,
        unified5h: account.quota?.unified5h ?? null,
        unified7d: account.quota?.unified7d ?? null,
      });
    } catch (err) {
      skipped.push({ name: account.name, reason: `warm error: ${err.message}` });
    }
  }
  console.log(`[TeamClaude] warmHeadroom(threshold=${threshold}): minted ${minted.length} (${minted.map((m) => m.name).join(', ') || '-'}), skipped ${skipped.length}`);
  return { threshold, minted, skipped };
}

// D-1763: bounded background re-warm for accounts whose boot-warm failed on a
// network error. Per account, retry on a fixed backoff schedule until the API is
// reached or attempts are exhausted, then STOP. Terminating by construction — no
// timer, no perpetual loop. Each account is retried independently.
export async function rewarmFailed(mgr, indices, upstream, backoffsSec = [5, 10, 20, 40]) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log(`[TeamClaude] Scheduling background re-warm for ${indices.length} account(s) that failed at boot (network not ready).`);
  await Promise.all(indices.map(async (index) => {
    const account = mgr.accounts[index];
    if (!account) return;
    for (let attempt = 0; attempt < backoffsSec.length; attempt++) {
      await sleep(backoffsSec[attempt] * 1000);
      try {
        await mgr.warmOne(account, upstream);
        console.log(`[TeamClaude] Late-warmed "${account.name}" on retry ${attempt + 1}/${backoffsSec.length}.`);
        return; // reached the API — anchored, done
      } catch (err) {
        if (attempt === backoffsSec.length - 1) {
          console.error(`[TeamClaude] Re-warm gave up for "${account.name}" after ${backoffsSec.length} retries: ${err.message}`);
        }
      }
    }
  }));
}

// accounting/ledger.js — the durable per-issue usage ledger (observability). Keyed
// by `sid::issue`, it survives idle-eviction AND proxy restart, and persists three
// things: the per-issue token/$ rollup (entries), per-account cumulative usage, and
// the capacity model (burn buckets + learned 5h cap) — keyed by account name so they
// survive a reorder. Saves are atomic (tmp + rename) and debounced (ledgerSaveMs).
// Reads/writes mgr.usageLedger + the shared pool records; cross-concern lookups
// (mgr._sessionRow) route through mgr.
//   • covered by tree.test, fleet.test, deck-snapshot.test.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export function setLedgerPath(mgr, p) { mgr.ledgerPath = p || null; }

// Load the ledger from disk at startup (best-effort) + prune stale entries.
export function loadLedger(mgr) {
  if (!mgr.ledgerPath) return;
  try {
    const data = JSON.parse(readFileSync(mgr.ledgerPath, 'utf-8'));
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    for (const e of entries) {
      if (e && e.sid != null) mgr.usageLedger.set(`${e.sid}::${e.issue || ''}`, e);
    }
    // Restore per-account usage + capacity model (v2, keyed by name; absent in a v1
    // file → skipped). Reactive-bench state is NOT persisted — a cold boot has no
    // recent 429s, so resetting it is correct.
    const accounts = (data && typeof data.accounts === 'object') ? data.accounts : null;
    if (accounts) {
      const hr = Math.floor(Date.now() / 3600000);
      for (const a of mgr.accounts) {
        const s = accounts[a.name];
        if (!s) continue;
        if (s.usage) {
          a.usage.totalInputTokens  = s.usage.totalInputTokens  || 0;
          a.usage.totalOutputTokens = s.usage.totalOutputTokens || 0;
          a.usage.totalRequests     = s.usage.totalRequests     || 0;
          a.usage.totalCost         = s.usage.totalCost         || 0;
          a.usage.lastUsed          = s.usage.lastUsed          || null;
        }
        if (Array.isArray(s.burn) && s.burn.length) {
          a._burn = new Map(s.burn.filter(([k]) => k >= hr - 168)); // re-prune to 7d
        }
        if (s.capEst5h != null) a._capEst5h = s.capEst5h;
        if (s.maxSuccessBurn5h != null) a._maxSuccessBurn5h = s.maxSuccessBurn5h;
      }
    }
  } catch { /* missing/corrupt → start empty */ }
  pruneLedger(mgr);
}

// Atomic save (tmp + rename) so a crash mid-write can't corrupt the ledger.
export function saveLedger(mgr) {
  if (!mgr.ledgerPath) return;
  try {
    const entries = [...mgr.usageLedger.values()];
    // Per-account durable state (cumulative usage + capacity model), keyed by name
    // so it survives an account reorder across restarts.
    const accounts = {};
    for (const a of mgr.accounts) {
      accounts[a.name] = {
        usage: { ...a.usage },
        burn: a._burn ? [...a._burn] : [],
        capEst5h: a._capEst5h ?? null,
        maxSuccessBurn5h: a._maxSuccessBurn5h ?? null, // proven-headroom recalibration floor
      };
    }
    const tmp = mgr.ledgerPath + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: 2, savedAt: Date.now(), entries, accounts }), { mode: 0o600 });
    renameSync(tmp, mgr.ledgerPath);
    mgr._ledgerDirty = false;
    mgr._ledgerLastSaveAt = Date.now();
  } catch { /* best-effort */ }
}

export function pruneLedger(mgr) {
  if (!mgr.ledgerRetentionMs) return;
  const cutoff = Date.now() - mgr.ledgerRetentionMs;
  for (const [k, e] of mgr.usageLedger) {
    if ((e.lastActiveAt || 0) < cutoff) mgr.usageLedger.delete(k);
  }
}

// Attribute one message's usage to the durable ledger (keyed by sid::issue). Also
// accumulates `cost` ($) and remembers the last `model`.
export function ledgerTouch(mgr, sessionId, accountName, inputTokens, outputTokens, cost = 0, model = null) {
  if (!sessionId) return;
  const issue = mgr._sessionRow(sessionId)?.pinned_issue || '';
  const key = `${sessionId}::${issue}`;
  let e = mgr.usageLedger.get(key);
  const now = Date.now();
  if (!e) {
    e = { sid: sessionId, issue, account: accountName, messages: 0, inputTokens: 0, outputTokens: 0, cost: 0, model: null, firstSeenAt: now, lastActiveAt: now };
    mgr.usageLedger.set(key, e);
  }
  e.account = accountName;
  if (inputTokens) { e.messages++; e.inputTokens += inputTokens; }
  if (outputTokens) e.outputTokens += outputTokens;
  if (cost) e.cost = (e.cost || 0) + cost;
  if (model) e.model = model;
  e.lastActiveAt = now;
  mgr._ledgerDirty = true;
}

// Debounced disk write — called from the hot path; writes at most every ledgerSaveMs.
export function maybeSaveLedger(mgr) {
  if (!mgr.ledgerPath || !mgr._ledgerDirty) return;
  if (Date.now() - mgr._ledgerLastSaveAt < mgr.ledgerSaveMs) return;
  saveLedger(mgr);
}

// Per-issue rollup across ALL ledger entries (durable, all sessions). The
// operator's "all usage on the issue across all sessions" view.
export function ledgerByIssue(mgr) {
  const byIssue = new Map();
  for (const e of mgr.usageLedger.values()) {
    const k = e.issue || '(unassigned)';
    let g = byIssue.get(k);
    if (!g) { g = { issue: k, sessions: 0, messages: 0, inputTokens: 0, outputTokens: 0, cost: 0, lastActiveAt: 0 }; byIssue.set(k, g); }
    g.sessions++;
    g.messages += e.messages || 0;
    g.inputTokens += e.inputTokens || 0;
    g.outputTokens += e.outputTokens || 0;
    g.cost += e.cost || 0;
    if ((e.lastActiveAt || 0) > g.lastActiveAt) g.lastActiveAt = e.lastActiveAt;
  }
  return [...byIssue.values()].map(g => {
    const tokens = g.inputTokens + g.outputTokens;
    return { ...g, tokens, avgTokensPerMsg: g.messages ? Math.round(tokens / g.messages) : 0 };
  }).sort((a, c) => c.tokens - a.tokens);
}

// bareSid → last-known account name, from the durable ledger (survives restart +
// idle eviction). Lets the Deck cluster an idle/just-restarted agent under the
// account that last served it even with no current binding.
export function ledgerBySid(mgr) {
  const bySid = new Map();
  for (const e of mgr.usageLedger.values()) {
    if (!e.sid || !e.account) continue;
    const prev = bySid.get(e.sid);
    if (!prev || (e.lastActiveAt || 0) > prev.lastActiveAt) {
      bySid.set(e.sid, { account: e.account, lastActiveAt: e.lastActiveAt || 0 });
    }
  }
  return bySid; // Map<bareSid, { account, lastActiveAt }>
}

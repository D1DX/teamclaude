// core/dispatch.js — per-account in-flight accounting: the atomic reserve that
// bounds concurrency. tryReserveInflight is the load-bearing invariant: the check
// against maxInflightPerAccount and the slot reservation happen in ONE synchronous
// step, so a concurrent burst can never all pass while _inflight is still 0 (the
// TOCTOU that let a recovery herd dogpile one account). Reads/writes account._inflight
// on the shared pool records.
//   • covered by herd-recovery.test, pace-controller.test, all-throttled-hold.test.

// server.js brackets each real upstream attempt with start/end so the count
// reflects concurrent requests actually hitting an account right now. Clamped so a
// missed end can never wedge an account permanently above its cap.
export function noteInflightStart(mgr, accountIndex) {
  const a = mgr.accounts[accountIndex];
  if (a) a._inflight = (a._inflight || 0) + 1;
}

export function noteInflightEnd(mgr, accountIndex) {
  const a = mgr.accounts[accountIndex];
  if (a) a._inflight = Math.max(0, (a._inflight || 0) - 1);
}

// DL-2226: atomic in-flight reserve — check maxInflightPerAccount and reserve the
// slot in ONE synchronous step, so a concurrent burst can't all pass while
// _inflight is still 0. Returns true if a slot was reserved — the caller MUST pair
// it with noteInflightEnd — or false at the cap (caller holds for a slot).
export function tryReserveInflight(mgr, accountIndex) {
  const a = mgr.accounts[accountIndex];
  if (!a) return false;
  if ((a._inflight || 0) >= mgr.maxInflightPerAccount) return false;
  a._inflight = (a._inflight || 0) + 1;
  return true;
}

// DL-2226: is this account at/over its in-flight cap? server.js uses this to briefly
// HOLD a warm-stuck request until one of the account's own in-flight slots frees —
// preserving cache-affinity — instead of piling on or churning the warm session.
export function atInflightCap(mgr, accountIndex) {
  const a = mgr.accounts[accountIndex];
  return !!a && (a._inflight || 0) >= mgr.maxInflightPerAccount;
}

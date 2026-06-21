// D-2485: read-only AccountManager facade for `teamclaude watch`.
//
// tui.js render() reads every datum it draws through a bounded set of
// AccountManager accessors (systemSnapshot / sessionBindingSummary /
// sessionAggregate / fleetRows / ledgerBySid / computeCapacity / ledgerByIssue,
// plus the `accounts` array + `currentIndex`). This class implements exactly
// that surface from a polled /teamclaude/deck snapshot, so the Deck renders
// byte-identically WITHOUT a live AccountManager, a port bind, or a running
// server. `update(snapshot)` swaps the data each poll.
//
// Every method is a pure read of the last snapshot — no side effects, no
// mutation path. The viewer is strictly view-only by construction: there is no
// account-switch / add / remove surface to call (the live Deck's mutation keys
// are disabled separately in the TUI's read-only mode).

// Safe default so render() never throws before the first successful poll (the
// Top "Cap" chip dereferences cap.verdict unconditionally when the method
// exists). A disconnected viewer shows this red/zeroed chip behind the banner.
const EMPTY_CAPACITY = {
  verdict: 'red', headroom: 0, liveAccounts: 0, total: 0,
  benched: 0, warmSessions: 0, soonestResetSec: 0, accounts: [],
};

export class DeckSnapshotSource {
  constructor(snapshot = {}) {
    this.update(snapshot);
  }

  // Swap in the latest /teamclaude/deck payload. `accounts` and `currentIndex`
  // are read by render() as PROPERTIES (not method calls), so set them here.
  update(snapshot) {
    this._snap = snapshot || {};
    this.accounts = Array.isArray(this._snap.accounts) ? this._snap.accounts : [];
    this.currentIndex = Number.isInteger(this._snap.currentIndex) ? this._snap.currentIndex : 0;
  }

  // ── the exact accessor surface tui.js render() calls on `this.am` ──
  systemSnapshot()        { return this._snap.system || null; }
  sessionBindingSummary() { return this._snap.sessionBindings || []; }
  sessionAggregate()      { return this._snap.sessionAggregate || null; }
  fleetRows()             { return this._snap.fleet || []; }
  ledgerByIssue()         { return this._snap.usageByIssue || []; }
  computeCapacity()       { return this._snap.capacity || EMPTY_CAPACITY; }

  // render() expects a Map<bareSid,{account,lastActiveAt}>; the snapshot carries
  // it flattened to a plain object (JSON can't hold a Map). Rebuild the Map.
  ledgerBySid()           { return new Map(Object.entries(this._snap.ledgerBySid || {})); }
}

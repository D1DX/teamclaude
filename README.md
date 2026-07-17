# TeamClaude

Multi-account Claude proxy with automatic quota-based rotation for [Claude Code](https://claude.ai/claude-code).

Sits transparently between Claude Code and the Anthropic API, managing multiple Claude Max (or API key) accounts and automatically switching when one approaches its session or weekly quota limit.

![TeamClaude TUI](screenshots/teamclaude.png)

## Features

- **Pace-to-weekly-line routing** — each session sticks to one account (warm prompt cache); new/rebound work goes to the account furthest BEHIND its weekly utilization line (`unified-7d-utilization` vs fraction-of-its-week-elapsed). A 5h soft-ceiling rail keeps new load off accounts near their session cap (never-stall), an end-of-cycle ramp drains an account's unused weekly quota before its reset, and an anti-dogpile layer spreads a concurrent burst across accounts instead of stampeding the single most-behind one — a **probe-gate** (an unproven account admits only one request until it returns a 200), a pace tie-band, a graduated per-account in-flight cap (tightens to 1 as 5h-utilization nears the cap), and a hard sessions-per-account cap
- **Escalating 429 backoff** — a 429 benches the account (honoring `retry-after` when present, else an escalating ladder by consecutive-429 streak that resets on any success), then fails over; clients only see a 429 once every account is throttled
- **Capacity endpoint** — `GET /capacity` (and `teamclaude capacity`) report a pool verdict (green/yellow/red) + spare concurrency headroom + soonest-reset, learned from per-account burn, so a launcher can gate how much concurrent work it starts. Per-account usage + the learned caps persist to disk, so a restart doesn't blank the model
- **Interactive TUI** — real-time dashboard with color-coded quota bars, reset countdowns, activity log, and keyboard controls
- **OAuth token management** — automatically refreshes tokens nearing expiry and persists them to config; client token refreshes pass through untouched
- **Hot-reload accounts** — add accounts via `import` or `login` while the server is running, press **R** to pick them up
- **Account deduplication** — detects duplicate accounts by UUID and keeps the most recent
- **Request logging** — optional full request/response logging for debugging
- **Zero dependencies** — uses only Node.js built-in modules

## Quick Start

Requires Node.js 18+.

```bash
# Install
npm install -g @karpeleslab/teamclaude

# Add your first account (opens browser for OAuth)
teamclaude login

# Add a second account
teamclaude login

# Start the proxy
teamclaude server

# In another terminal, run Claude Code through the proxy
teamclaude run
```

You can also import existing Claude Code credentials instead of logging in:

```bash
claude /login           # Log into an account in Claude Code
teamclaude import       # Import its credentials
```

## Adding Accounts

### OAuth Login (recommended)

The easiest way to add accounts — opens your browser for authentication:

```bash
teamclaude login
```

Uses the same OAuth flow as Claude Code. Auto-detects the account email and subscription tier. Logging in with the same account again updates its credentials.

You can add accounts while the server is running — press **R** in the TUI to reload.

### Import from Claude Code

If you already have Claude Code set up, you can import its credentials directly:

```bash
claude /login           # Log into an account in Claude Code
teamclaude import       # Import its credentials
```

Re-importing the same account updates its credentials. You can also import from a custom path:

```bash
teamclaude import --from /path/to/credentials.json
```

### API Key

For Anthropic API key accounts (billed via Console):

```bash
teamclaude login --api
```

## Usage

### Start the proxy server

```bash
teamclaude server
```

When running from a TTY, shows an interactive **fleet control plane** (the "Deck"):
- **Tree** (top section, above the account groups) — the FULL orchestration tree, rendered recursively to any depth (HoO → orchestrator lead → worker → …). A tree root is a lead session (its pinned issue is the *parent* of ≥1 live session) whose own parent is **not** a live session; the walk descends through every live descendant. Each node: `☂` (lead) / `↳` (worker) glyph + per-session emoji + issue + status, indented with `├─`/`└─` connectors and `│` continuation bars. Tokens roll up **per node** (`self · Σ subtree` on lead rows), **per level** (a `Levels  L0 …  L1 …  L2 …` line — count·tokens at each depth), and **per tree** (node count + total tokens + `$` cost on the section header). Built entirely in-memory from each session's local `~/.claude/state/sessions/<sid>/pin.json` (`issueId` = a session's own pinned-issue UUID; `parentId` = its parent's issue UUID) — **no extra API or DB calls**. Cycle-guarded. Only trees whose root is a live lead render here; solo sessions (no live parent, no children) and orphan children fall through to the account groups below, unchanged.
- **Sessions grouped by account** — each agent clustered under the Max account serving it, with the account header carrying status + quota bars (`Ses` 5h · `Wk` 7d, plus a distinct `Fbl` meter for the premium/Fable weekly sub-axis `unified-7d_oi` — value + reset, shown only when the account carries real premium-axis data, never estimated) + a per-account roll-up (`N agents · M live · tokens`). Accounts ordered by total token burn.
- **Per-session row** — emoji · pinned issue (or sid) · issue-status chip (`work`/`todo`/`queued`/`block`/`review`) · live/idle · **activity glyph** (`⚙` a tool is executing, `~` the session is live/LLM responding, blank idle) · token burn · `$` cost · activity/intent line. `►` marks sessions that need the operator (blocked / in-review). All rows sorted by token count descending.
- **Fleet header** — one-glance `N agents · M warm · K needs-you · total tokens · $burn`.
- **By issue** — active issues only (those with a live session), each prefixed with its session emoji(s), sorted by token count descending. Press `i` to expand the full list. Historical/closed-issue usage lives in the task tracker, not here.
- Idle / stale sessions are filtered out automatically, so the deck stays a **live view**. Presence keys on the session's **last real turn** — the newest `user`/`assistant` entry in its transcript, the truthful activity signal — NOT on the file mtime (bumped by no-timestamp harness metadata even at idle: titles, mode, snapshots) nor the recorded pid (a recyclable daemon-pool ancestor, so a crashed session's pid can read "alive" and show a ghost). A row is shown iff a tool is executing now, OR its last real turn was within 30 min, OR it is a brand-new session whose transcript hasn't appeared yet (rescued by started-freshness, ~120 s, pid-free). A transcript that has no real turn yet (a metadata-only stub) falls back to its file mtime. Anything quiet longer than the window drops — and reappears the instant it takes a turn. (The registry **reaper** that deletes rows is separately conservative — last-real-turn + pid-identity + a 12h ceiling — since deletion, unlike hiding, isn't free to get wrong.)
- Real-time activity log with request tracking. Each `/v1/messages` row carries a compact `[<model>·<effort>]` tag (parsed from the request body — e.g. `[opus-4-8·high]`) on both the in-flight spinner row and the completed log line, in the live Deck and the `watch` viewer alike.

Falls back to plain log output when not a TTY (e.g. running as a service).

#### TUI Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `s` | Switch active account |
| `a` | Add account (import or API key) |
| `r` | Remove an account |
| `R` | Reload accounts from config |
| `b` | Mute / unmute the alert bell |
| `i` | Expand / collapse the full By-issue list |
| `q` | Quit |

In selection mode, use `j`/`k` or arrow keys to navigate, `Enter` to confirm, `Esc` to cancel.

### Run Claude Code through the proxy

```bash
teamclaude run
```

Or manually set the environment:

```bash
eval $(teamclaude env)
claude
```

### Other commands

```bash
teamclaude accounts          # List accounts with subscription tier and token status
teamclaude accounts -v       # Also show token expiry times
teamclaude status            # Show live proxy status (requires running server)
teamclaude capacity          # Pool capacity verdict/headroom/reset; --json for scripts (exit 0/10/20)
teamclaude remove <name>     # Remove an account
teamclaude api <path>        # Call an API endpoint with account credentials
teamclaude help              # Show all commands
```

### Request logging

Log full request/response details to a directory (one file per request):

```bash
teamclaude server --log-to /tmp/requests
```

## Configuration

Config is stored at `~/.config/teamclaude.json` (or `$XDG_CONFIG_HOME/teamclaude.json`). A random proxy API key is generated on first use.

Override the config path with `TEAMCLAUDE_CONFIG`:

```bash
TEAMCLAUDE_CONFIG=./my-config.json teamclaude server
```

### Config format

```json
{
  "proxy": {
    "port": 3456,
    "apiKey": "tc-auto-generated-key"
  },
  "upstream": "https://api.anthropic.com",
  "switchThreshold": 0.98,
  "accounts": [
    {
      "name": "user@example.com",
      "type": "oauth",
      "accountUuid": "...",
      "accessToken": "sk-ant-oat01-...",
      "refreshToken": "sk-ant-ort01-...",
      "expiresAt": 1774384968427
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `proxy.port` | Local port the proxy listens on |
| `proxy.apiKey` | API key clients use to authenticate with the proxy |
| `upstream` | Upstream API base URL |
| `switchThreshold` | Quota utilization (0–1) at which to switch accounts |

## How It Works

1. Claude Code connects to the local proxy instead of `api.anthropic.com`
2. The proxy selects the active account and forwards requests with that account's credentials
3. OAuth tokens expiring within 5 minutes are automatically refreshed and persisted to config
4. Each client session (by `x-claude-code-session-id`) binds to one account and stays cache-warm; new/rebound work goes to the account furthest BEHIND its weekly pace line (`unified-7d-utilization` vs fraction-of-its-week-elapsed). Before an account's first response populates its headers it reads as "behind" and gets traffic (self-priming); with no unified data at all it degrades to least-loaded spread (fewest in-flight, then fewest warm)
5. Anthropic returns `anthropic-ratelimit-unified-5h/7d-utilization` (+ resets/status) on every Max OAuth response, so pacing runs on real weekly utilization. The proxy keeps new load off accounts at/over a 5h soft ceiling (never-stall rail), and treats `switchThreshold` as the hard unusable cap. A warm session is only rebound for pacing when its account is far past its line
6. On a 429 the account is benched — to the server `retry-after` if present, otherwise an escalating ladder keyed to the consecutive-429 streak (capped), reset on any success — then the request fails over to another account
7. A per-account capacity model learns each account's cap from its burn at 429 time and exposes pool headroom via `/capacity`
8. Transient network errors (connection reset, timeout) drop the connection so the client can retry
9. If all accounts are throttled, the proxy holds the request and polls for capacity, then returns a reset-aware 429 if the hold budget is spent
10. Client token refresh requests (`/v1/oauth/token`) are relayed to upstream untouched — the proxy and client manage their own token lifecycles independently

## License

MIT

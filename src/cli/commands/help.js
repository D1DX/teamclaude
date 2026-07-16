import { getConfigPath } from '../../config.js';

// ── help ────────────────────────────────────────────────────

export function showHelp() {
  console.log(`TeamClaude - Multi-account Claude proxy

Usage: teamclaude [command] [options]

Commands:
  server              Start the proxy server (default)
  import              Import credentials from Claude Code
  login               OAuth login via browser
  login --api         Add an API key account
  env                 Print env vars to use with Claude
  run [-- args...]    Run Claude Code through the proxy
  status              Show proxy & account status (live)
  watch [--interval N] Read-only Deck viewer for a running proxy (no server)
  capacity [--json]   Pool capacity for orchestrators (verdict/headroom/reset)
  accounts            List configured accounts
  remove <name>       Remove an account
  api <path>          Call an API endpoint with account credentials
  help                Show this help

Options:
  --name NAME         Set account name (import/login)
  --from PATH         Credentials path (import, default: ~/.claude/.credentials.json)
  --json JSON         Import from inline JSON (import), e.g.:
                      --json '{"accessToken":"...","refreshToken":"...","expiresAt":1234}'
  --log-to DIR        Log full requests/responses to DIR (server, one file per request)

Config: ${getConfigPath()}
`);
}

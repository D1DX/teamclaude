import { spawnSync } from 'node:child_process';
import { loadOrCreateConfig } from '../../config.js';
import { args } from '../shared.js';

// ── run ─────────────────────────────────────────────────────

export async function runCommand() {
  const config = await loadOrCreateConfig();

  // Everything after 'run' (skip -- separator if present)
  const claudeArgs = args.slice(1);
  if (claudeArgs[0] === '--') claudeArgs.shift();

  // Only set ANTHROPIC_BASE_URL — Claude Code keeps its own OAuth token
  // which the proxy accepts from localhost. Not setting ANTHROPIC_API_KEY
  // lets Claude Code stay in subscription mode (full model access).
  // Use spawnSync so the Node process blocks entirely — behaves like execvp.
  const result = spawnSync('claude', claudeArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${config.proxy.port}`,
    },
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error('Claude Code not found in PATH. Install it first.');
    } else {
      console.error(`Failed to start claude: ${result.error.message}`);
    }
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

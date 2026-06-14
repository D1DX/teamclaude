import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// D-2226: resolve the running build id ONCE at module load so the startup log,
// `teamclaude status`, and the /health endpoint can report exactly which code is
// live. The proxy carried no version marker before this — package.json `version`
// is static (1.0.x) and does not move per fork commit, so "is the latest fix
// deployed?" was only answerable by inspecting files + restart timing. Priority:
//   1. TEAMCLAUDE_BUILD env override (manual pin / CI).
//   2. a `BUILD` file next to src/ — written by the mirror/deploy step. The
//      installed copy under node_modules is NOT a git repo, so this is its only
//      source of truth for the deployed SHA.
//   3. `git rev-parse --short HEAD` — works when running from the fork clone (dev).
//   4. 'unknown' — nothing could resolve it (honest, never throws).
export function resolveBuild() {
  if (process.env.TEAMCLAUDE_BUILD) return process.env.TEAMCLAUDE_BUILD;
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    const b = readFileSync(join(here, 'BUILD'), 'utf8').trim();
    if (b) return b;
  } catch { /* no BUILD file — fall through */ }
  try {
    return execSync('git rev-parse --short HEAD', { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { /* not a git repo / git unavailable — fall through */ }
  return 'unknown';
}

// Resolved once at process start; the running code never changes mid-process.
export const BUILD = resolveBuild();

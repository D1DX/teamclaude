import { loadOrCreateConfig } from '../../config.js';

// ── env ─────────────────────────────────────────────────────

export async function envCommand() {
  const config = await loadOrCreateConfig();
  console.log(`export ANTHROPIC_BASE_URL=http://localhost:${config.proxy.port}`);
  console.log(`export ANTHROPIC_API_KEY=${config.proxy.apiKey}`);
}

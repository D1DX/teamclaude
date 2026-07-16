import { loadOrCreateConfig, saveConfig } from '../../config.js';
import { args } from '../shared.js';

// ── remove ──────────────────────────────────────────────────

export async function removeCommand() {
  const config = await loadOrCreateConfig();
  const name = args[1];

  if (!name) {
    console.error('Usage: teamclaude remove <account-name>');
    process.exit(1);
  }

  const idx = config.accounts.findIndex(a => a.name === name);
  if (idx < 0) {
    console.error(`Account "${name}" not found`);
    process.exit(1);
  }

  config.accounts.splice(idx, 1);
  await saveConfig(config);
  console.log(`Removed account "${name}"`);
}

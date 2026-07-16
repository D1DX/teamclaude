import { importCredentials, fetchProfile } from '../oauth.js';
import { saveConfig, getConfigPath } from '../config.js';

export const args = process.argv.slice(2);

export function argValue(flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : null;
}

// ── shared account upsert ────────────────────────────────────

export async function upsertOAuthAccount(config, name, creds, source = 'unknown') {
  // Fetch profile to auto-name and deduplicate by account UUID
  const profile = await fetchProfile(creds.accessToken);
  const profileOk = profile && !profile.error;

  if (!profileOk) {
    console.error(`Warning: could not fetch account profile — ${profile?.error || 'no token'}`);
  }
  if (!name && profile?.email) {
    name = profile.email;
    const tier = profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : null;
    if (tier) console.log(`Detected Claude ${tier} account: ${profile.email}`);
  }
  if (!name) {
    const n = config.accounts.filter(a => a.name.startsWith('account-')).length + 1;
    name = `account-${n}`;
  }

  const account = {
    name,
    type: 'oauth',
    source,
    accountUuid: profile?.accountUuid || null,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  };

  // Deduplicate: match by UUID first, then by name
  let idx = profile?.accountUuid
    ? config.accounts.findIndex(a => a.accountUuid === profile.accountUuid)
    : -1;
  if (idx < 0) idx = config.accounts.findIndex(a => a.name === name);

  if (idx >= 0) {
    config.accounts[idx] = account;
    console.log(`Updated account "${name}"`);
  } else {
    config.accounts.push(account);
    console.log(`Added account "${name}"`);
  }

  await saveConfig(config);
  console.log(`Saved to ${getConfigPath()}`);
}

// ── config sync helpers ─────────────────────────────────────

/**
 * Find a config account entry matching an in-memory account (by UUID, then name).
 */
export function findConfigAccount(diskConfig, account) {
  if (account.accountUuid) {
    const idx = diskConfig.accounts.findIndex(a => a.accountUuid === account.accountUuid);
    if (idx >= 0) return idx;
  }
  return diskConfig.accounts.findIndex(a => a.name === account.name);
}

/**
 * Sync accounts from disk config: add new accounts and refresh credentials
 * for existing ones (handles re-imported OAuth tokens, rotated API keys, etc.).
 * Returns the number of new accounts added.
 */
export async function syncAccountsFromDisk(diskConfig, memConfig, accountManager) {
  let added = 0;
  for (const diskAcct of diskConfig.accounts) {
    const matchByUuid = diskAcct.accountUuid &&
      memConfig.accounts.findIndex(a => a.accountUuid === diskAcct.accountUuid);
    const matchByName = memConfig.accounts.findIndex(a => a.name === diskAcct.name);
    const memIdx = (matchByUuid >= 0 ? matchByUuid : null) ?? (matchByName >= 0 ? matchByName : -1);

    if (memIdx < 0) {
      // New account discovered on disk — add to running server
      memConfig.accounts.push(diskAcct);
      accountManager.addAccount(diskAcct);
      added++;
      console.log(`[TeamClaude] Picked up new account "${diskAcct.name}" from config`);
      // D-1820: warm the freshly-added account now (parity with startup warmAll)
      // so Reload fires the 1-token request against it immediately, instead of
      // leaving it cold until the next routed session. Best-effort + detached —
      // never block/hang the sync on a slow or hanging fetch.
      const newMgr = accountManager.accounts.find(a =>
        (diskAcct.accountUuid && a.accountUuid === diskAcct.accountUuid) || a.name === diskAcct.name);
      if (newMgr) {
        accountManager.warmOne(newMgr, memConfig.upstream || 'https://api.anthropic.com')
          .catch(err => console.error(`[TeamClaude] Warm failed for "${diskAcct.name}": ${err.message}`));
      }
      continue;
    }

    // Existing account — resolve fresh credentials from disk
    let freshCred = null;
    if (diskAcct.type === 'oauth' && diskAcct.importFrom) {
      try {
        const creds = await importCredentials(diskAcct.importFrom);
        freshCred = { accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt };
      } catch (err) {
        console.error(`[TeamClaude] Re-import failed for "${diskAcct.name}": ${err.message}`);
      }
    } else if (diskAcct.type === 'oauth' && diskAcct.accessToken) {
      freshCred = { accessToken: diskAcct.accessToken, refreshToken: diskAcct.refreshToken, expiresAt: diskAcct.expiresAt };
    } else if (diskAcct.type === 'apikey' && diskAcct.apiKey) {
      freshCred = { apiKey: diskAcct.apiKey };
    }

    if (!freshCred) continue;

    // Find the corresponding AccountManager entry and update credentials
    const mgr = accountManager.accounts.find(a =>
      (diskAcct.accountUuid && a.accountUuid === diskAcct.accountUuid) || a.name === diskAcct.name
    );
    if (!mgr) continue;

    if (freshCred.accessToken) {
      const changed = mgr.credential !== freshCred.accessToken ||
        mgr.refreshToken !== freshCred.refreshToken;
      // Don't overwrite in-memory credentials with staler ones from disk
      // (e.g. after a TUI import updated the AM before saveConfig wrote to disk)
      const diskIsStaler = freshCred.expiresAt && mgr.expiresAt &&
        freshCred.expiresAt < mgr.expiresAt;
      if (changed && !diskIsStaler) {
        accountManager.updateAccountTokens(mgr.index, freshCred);
        console.log(`[TeamClaude] Refreshed credentials for "${mgr.name}"`);
      }
    } else if (freshCred.apiKey && mgr.credential !== freshCred.apiKey) {
      mgr.credential = freshCred.apiKey;
      if (mgr.status === 'error') mgr.status = 'active';
      console.log(`[TeamClaude] Updated API key for "${mgr.name}"`);
    }
  }
  return added;
}

// ── helpers ─────────────────────────────────────────────────

export async function resolveAccounts(config) {
  const accounts = [];
  for (const acct of config.accounts) {
    if (acct.type === 'oauth') {
      if (acct.importFrom) {
        try {
          const creds = await importCredentials(acct.importFrom);
          accounts.push({ name: acct.name, type: 'oauth', ...creds });
          console.log(`Imported "${acct.name}" from ${acct.importFrom}`);
        } catch (err) {
          console.error(`Failed to import "${acct.name}": ${err.message}`);
        }
      } else if (acct.accessToken) {
        accounts.push(acct);
      } else {
        console.error(`No token for "${acct.name}", skipping`);
      }
    } else if (acct.type === 'apikey' && acct.apiKey) {
      accounts.push(acct);
    }
  }
  return accounts;
}

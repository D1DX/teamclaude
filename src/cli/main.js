import { serverCommand } from './commands/server.js';
import { importCommand } from './commands/import.js';
import { loginCommand } from './commands/login.js';
import { envCommand } from './commands/env.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { watchCommand } from './commands/watch.js';
import { capacityCommand } from './commands/capacity.js';
import { accountsCommand } from './commands/accounts.js';
import { removeCommand } from './commands/remove.js';
import { apiCommand } from './commands/api.js';
import { showHelp } from './commands/help.js';

export async function main(args) {
  const command = args[0];

  switch (command) {
    case 'server':
      await serverCommand();
      break;
    case 'run':
      await runCommand();
      break;
    case 'import':
      await importCommand();
      process.exit(0);
      break;
    case 'login':
      await loginCommand();
      process.exit(0);
      break;
    case 'env':
      await envCommand();
      process.exit(0);
      break;
    case 'status':
      await statusCommand();
      process.exit(0);
      break;
    case 'watch':
      await watchCommand();
      break;
    case 'capacity':
      await capacityCommand();
      process.exit(0);
      break;
    case 'accounts':
      await accountsCommand();
      process.exit(0);
      break;
    case 'remove':
      await removeCommand();
      process.exit(0);
      break;
    case 'api':
      await apiCommand();
      process.exit(0);
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      // No command or unknown command → start server
      if (command && !command.startsWith('-')) {
        console.error(`Unknown command: ${command}\n`);
        showHelp();
        process.exit(1);
      }
      await serverCommand();
      break;
  }
}

#!/usr/bin/env node
/**
 * KiroGraph CLI entry.
 *
 * The commands that hooks run after every agent turn (sync, sync-if-dirty, mark-dirty) are
 * handled here with only their own module loaded. The full program (main.ts) imports about a
 * hundred command modules, which is most of the 100 ms a `kirograph` process takes to start
 * (Node itself takes 40 ms). Everything else, including help and unknown commands, goes through
 * main.ts as before.
 */

import { Command } from 'commander';
import { installCrashHandler } from './crash-handler';

declare const __CLI_VERSION__: string;

const HOT_COMMANDS = new Set(['sync', 'sync-if-dirty', 'mark-dirty']);
const wantsHelp = process.argv.includes('--help') || process.argv.includes('-h') || process.argv.includes('-V') || process.argv.includes('--version');

if (HOT_COMMANDS.has(process.argv[2]) && !wantsHelp) {
  installCrashHandler();
  const program = new Command();
  program.name('kirograph').version(__CLI_VERSION__);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(`./commands/${process.argv[2]}`).register(program);
  program.parse(process.argv);
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./main');
}

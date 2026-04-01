#!/usr/bin/env node
/**
 * KiroGraph CLI
 */

import { Command } from 'commander';
import { printBanner } from './banner';
import { printColoredHelp, register as registerHelp } from './commands/help';
import { register as registerInit } from './commands/init';
import { register as registerUninit } from './commands/uninit';
import { register as registerIndex } from './commands/index';
import { register as registerSync } from './commands/sync';
import { register as registerStatus } from './commands/status';
import { register as registerQuery } from './commands/query';
import { register as registerFiles } from './commands/files';
import { register as registerContext } from './commands/context';
import { register as registerAffected } from './commands/affected';
import { register as registerMarkDirty } from './commands/mark-dirty';
import { register as registerSyncIfDirty } from './commands/sync-if-dirty';
import { register as registerUnlock } from './commands/unlock';
import { register as registerInstall } from './commands/install';
import { register as registerServe } from './commands/serve';

const program = new Command();

program
  .name('kirograph')
  .description('Semantic code knowledge graph for Kiro')
  .version('0.1.0')
  .addHelpCommand(true)
  .hook('preAction', (thisCommand) => {
    const name = thisCommand.name();
    if (name === 'init') printBanner();
  });

registerInstall(program);
registerInit(program);
registerUninit(program);
registerIndex(program);
registerSync(program);
registerSyncIfDirty(program);
registerMarkDirty(program);
registerStatus(program);
registerQuery(program);
registerContext(program);
registerFiles(program);
registerAffected(program);
registerUnlock(program);
registerServe(program);

// Show banner + help when called with no arguments, otherwise parse normally
if (process.argv.length === 2) {
  printBanner();
  printColoredHelp();
  process.exit(0);
}

registerHelp(program);

program.parse(process.argv);

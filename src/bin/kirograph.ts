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
import { register as registerDashboard } from './commands/dashboard';
import { register as registerArchitecture } from './commands/architecture';
import { register as registerCoupling } from './commands/coupling';
import { register as registerPackage } from './commands/package';
import { register as registerCaveman } from './commands/caveman';
import { register as registerDeadCode } from './commands/dead-code';
import { register as registerHotspots } from './commands/hotspots';
import { register as registerSurprising } from './commands/surprising';
import { register as registerSnapshot } from './commands/snapshot';
import { register as registerPath } from './commands/path';
import { register as registerExport } from './commands/export';

// ── Global error handler for WASM runtime crashes ─────────────────────────────
//
// node-sqlite3-wasm calls process.abort() when it hits a fatal error (e.g.
// database is locked by another process). This produces a raw "Aborted()"
// message with no context. We intercept it here to print a clear explanation
// before the process exits.
process.on('uncaughtException', (err: Error) => {
  const msg = err?.message ?? String(err);
  const isWasmAbort = msg.includes('Aborted(') || msg.includes('RuntimeError') || (err as any)?.constructor?.name === 'RuntimeError';

  if (isWasmAbort) {
    process.stderr.write([
      '',
      '  ✖ KiroGraph crashed: SQLite WASM runtime aborted.',
      '',
      '  Most likely cause: another process (e.g. the Kiro MCP server) is',
      '  holding the database open while indexing is running.',
      '',
      '  How to fix:',
      '    1. Close Kiro IDE (or disable the kirograph MCP server) before indexing',
      '    2. Run: kirograph unlock',
      '    3. Then retry: kirograph index',
      '',
      '  If the problem persists, delete the lock manually:',
      '    del .kirograph\\kirograph.db.lock  (Windows)',
      '    rm -rf .kirograph/kirograph.db.lock  (macOS/Linux)',
      '',
    ].join('\n'));
    process.exit(1);
  }

  // Not a WASM crash — re-throw as normal
  process.stderr.write(`Uncaught error: ${msg}\n`);
  process.exit(1);
});

declare const __CLI_VERSION__: string;

const program = new Command();

program
  .name('kirograph')
  .description('Semantic code knowledge graph for Kiro')
  .version(__CLI_VERSION__)
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
registerDashboard(program);
registerArchitecture(program);
registerCoupling(program);
registerPackage(program);
registerCaveman(program);
registerDeadCode(program);
registerHotspots(program);
registerSurprising(program);
registerSnapshot(program);
registerPath(program);
registerExport(program);

// Show banner + help when called with no arguments, otherwise parse normally
if (process.argv.length === 2) {
  printBanner();
  printColoredHelp();
  process.exit(0);
}

registerHelp(program);

program.parse(process.argv);

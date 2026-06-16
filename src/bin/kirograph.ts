#!/usr/bin/env node
/**
 * KiroGraph CLI
 */

import { Command } from 'commander';
import { printBanner } from './banner';
import { printColoredHelp, printInteractiveHelp, register as registerHelp } from './commands/help';
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
import { register as registerGain } from './commands/gain';
import { register as registerCompression } from './commands/compression';
import { register as registerExec } from './commands/exec';
import { register as registerMemory } from './commands/memory';
import { register as registerDocs } from './commands/docs';
import { register as registerData } from './commands/data';
import { register as registerBenchmark } from './commands/benchmark';
import { register as registerFlows } from './commands/flows';
import { register as registerCommunities } from './commands/communities';
import { register as registerRefactor } from './commands/refactor';
import { register as registerRead } from './commands/read';
import { register as registerBudget } from './commands/budget';
import { register as registerSecurity } from './commands/security';
import { register as registerSbom } from './commands/sbom';
import { register as registerVex } from './commands/vex';
import { register as registerVulns } from './commands/vulns';
import { register as registerReachability } from './commands/reachability';
import { register as registerStaleness } from './commands/staleness';
import { register as registerLicenses } from './commands/licenses';
import { register as registerSecurityExport } from './commands/security-export';
import { register as registerVulnSuppress } from './commands/vuln-suppress';
import { register as registerAttackSurface } from './commands/attack-surface';
import { register as registerSecuritySecrets } from './commands/security-secrets';
import { register as registerSecurityFlows } from './commands/security-flows';
import { register as registerSecurityCiReport } from './commands/security-ci-report';
import { register as registerSupplyChain } from './commands/supply-chain';
import { register as registerDepConfusion } from './commands/dep-confusion';
import { register as registerRemediation } from './commands/remediation';
import { register as registerPattern } from './commands/pattern';
import { register as registerHook } from './commands/hook';
import { register as registerWiki } from './commands/wiki';

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
registerGain(program);
registerCompression(program);
registerExec(program);
registerMemory(program);
registerDocs(program);
registerData(program);
registerBenchmark(program);
registerFlows(program);
registerCommunities(program);
registerRefactor(program);
registerRead(program);
registerBudget(program);
const securityCmd = registerSecurity(program);
registerSbom(program);
registerVex(program);
registerVulns(program);
registerReachability(program);
registerStaleness(program);
registerLicenses(program);
registerSecurityExport(securityCmd);
registerSecuritySecrets(securityCmd);
registerSecurityFlows(securityCmd);
registerSecurityCiReport(securityCmd);
registerVulnSuppress(program);
registerAttackSurface(program);
registerSupplyChain(program);
registerDepConfusion(program);
registerRemediation(program);
registerPattern(program);
registerHook(program);
registerWiki(program);

// Register the help command for `kirograph help`
program
  .command('help')
  .description('Show interactive help')
  .action(() => {
    if (process.stdout.isTTY) {
      printInteractiveHelp();
    } else {
      printBanner();
      printColoredHelp();
      process.exit(0);
    }
  });

registerHelp(program);

// Show interactive help when called with no arguments
if (process.argv.length === 2) {
  if (process.stdout.isTTY) {
    printInteractiveHelp();
  } else {
    printBanner();
    printColoredHelp();
    process.exit(0);
  }
} else if (process.argv.includes('--help') || process.argv.includes('-h')) {
  // Intercept --help before Commander to avoid process.exit
  if (process.stdout.isTTY) {
    printInteractiveHelp();
  } else {
    printBanner();
    printColoredHelp();
    process.exit(0);
  }
} else {
  program.parse(process.argv);
}

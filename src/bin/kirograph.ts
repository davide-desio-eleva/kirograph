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
import { register as registerCallers } from './commands/callers';
import { register as registerCallees } from './commands/callees';
import { register as registerImpact } from './commands/impact';
import { register as registerTypeHierarchy } from './commands/type-hierarchy';
import { register as registerCircularDeps } from './commands/circular-deps';
import { register as registerDoctor } from './commands/doctor';
import { register as registerManifest } from './commands/manifest';
import { register as registerUnusedImports } from './commands/unused-imports';
import { register as registerGini } from './commands/gini';
import { register as registerDependencyDepth } from './commands/dependency-depth';
import { register as registerModuleApi } from './commands/module-api';
import { register as registerRenamePreview } from './commands/rename-preview';
import { register as registerDocCoverage } from './commands/doc-coverage';
import { register as registerGodClass } from './commands/god-class';
import { register as registerInheritanceDepth } from './commands/inheritance-depth';
import { register as registerRecursion } from './commands/recursion';
import { register as registerLargest } from './commands/largest';
import { register as registerRank } from './commands/rank';
import { register as registerDistribution } from './commands/distribution';
import { register as registerAnnotations } from './commands/annotations';
import { register as registerSession } from './commands/session';
import { register as registerStrReplace } from './commands/str-replace';
import { register as registerMultiReplace } from './commands/multi-replace';
import { register as registerInsertAt } from './commands/insert-at';
import { register as registerAstRewrite } from './commands/ast-rewrite';
import { register as registerComplexityCli } from './commands/complexity';
import { register as registerSimplifyScan } from './commands/simplify-scan';
import { register as registerDiffContext } from './commands/diff-context';
import { register as registerCommitContext } from './commands/commit-context';
import { register as registerPrContext } from './commands/pr-context';
import { register as registerChangelog } from './commands/changelog';
import { register as registerTestMap } from './commands/test-map';
import { register as registerHealth } from './commands/health';
import { register as registerDsm } from './commands/dsm';
import { register as registerTestRisk } from './commands/test-risk';
import { register as registerTestCoverage } from './commands/test-coverage';
import { register as registerBench } from './commands/bench';
import { register as registerBranch } from './commands/branch';
import { register as registerMonitor } from './commands/monitor';
import { register as registerUpgrade } from './commands/upgrade';
import { register as registerCost } from './commands/cost';

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
registerCallers(program);
registerCallees(program);
registerImpact(program);
registerTypeHierarchy(program);
registerCircularDeps(program);
registerDoctor(program);
registerManifest(program);
registerUnusedImports(program);
registerGini(program);
registerDependencyDepth(program);
registerModuleApi(program);
registerRenamePreview(program);
registerDocCoverage(program);
registerGodClass(program);
registerInheritanceDepth(program);
registerRecursion(program);
registerLargest(program);
registerRank(program);
registerDistribution(program);
registerAnnotations(program);
registerSession(program);
registerStrReplace(program);
registerMultiReplace(program);
registerInsertAt(program);
registerAstRewrite(program);
registerComplexityCli(program);
registerSimplifyScan(program);
registerDiffContext(program);
registerCommitContext(program);
registerPrContext(program);
registerChangelog(program);
registerTestMap(program);
registerHealth(program);
registerDsm(program);
registerTestRisk(program);
registerTestCoverage(program);
registerBench(program);
registerBranch(program);
registerMonitor(program);
registerUpgrade(program);
registerCost(program);

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

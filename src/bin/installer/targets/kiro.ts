import * as path from 'path';
import { writeCliAgent } from '../cli-agent';
import { writeHooks, KiroHookFormat } from '../hooks';
import { writeMcpConfigFinal } from '../mcp';
import { writeSteering } from '../steering';
import type { LateInstallOptions } from '../common';

export function installKiroEarly(projectRoot: string, kiroHookFormat: KiroHookFormat = 'v2'): void {
  const kiroDir = path.join(projectRoot, '.kiro');
  writeHooks(kiroDir, { kiroHookFormat });
}

export function installKiroLate(projectRoot: string, opts: LateInstallOptions): void {
  const { cavemanMode, shellCompressionLevel, enableMemory, enableDocs, enableData, enableSecurity,
    enableArchitecture, enablePatterns, enableWatchmen, watchmenSynthesisMode, enableWiki,
    wikiSynthesisMode, enableCodeHealth, enableNavigation, enableComplexity, enableGitContext,
    enableEditPrimitives, enableBranch, enableAgentUtils, enableGeneralCompression, trackCallSites } = opts;
  const kiroHookFormat = (opts.kiroHookFormat ?? 'v2') as KiroHookFormat;
  const kiroDir = path.join(projectRoot, '.kiro');
  const enableCompression = shellCompressionLevel !== 'off';
  const enableShellExec = shellCompressionLevel !== 'off';
  writeMcpConfigFinal(kiroDir, projectRoot, { enableArchitecture, enableMemory, enableWatchmen, enableDocs, enableData, enableSecurity, enablePatterns, enableWiki, enableCodeHealth, enableNavigation, enableComplexity, enableGitContext, enableEditPrimitives, enableBranch, enableAgentUtils, enableGeneralCompression, enableShellExec, trackCallSites });
  writeHooks(kiroDir, { enableCompression, enableMemory, enableWatchmen, watchmenSynthesisMode, enableWiki, wikiSynthesisMode, kiroHookFormat });
  writeSteering(kiroDir, { cavemanMode, enableCompression, shellCompressionLevel: shellCompressionLevel as any, enableMemory, enableDocs, enableData, enableSecurity, enableArchitecture, enablePatterns, enableWiki, enableCodeHealth, enableNavigation, enableGitContext, enableAgentUtils, enableGeneralCompression, trackCallSites });
  writeCliAgent(kiroDir, { enableSecurity, enableArchitecture, enablePatterns });
}

export function printKiroNextSteps(): void {
  console.log('\n  Done! Restart Kiro IDE for the MCP server to load.');
  console.log('  For Kiro CLI, use the "kirograph" agent: kiro-cli --agent kirograph\n');
}


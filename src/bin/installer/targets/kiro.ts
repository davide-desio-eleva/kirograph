import * as path from 'path';
import { CavemanMode } from '../caveman';
import { writeCliAgent } from '../cli-agent';
import { writeHooks, KiroHookFormat } from '../hooks';
import { writeMcpConfigFinal } from '../mcp';
import { writeSteering } from '../steering';

export function installKiroEarly(projectRoot: string, kiroHookFormat: KiroHookFormat = 'v2'): void {
  const kiroDir = path.join(projectRoot, '.kiro');
  writeHooks(kiroDir, { kiroHookFormat });
}

export function installKiroLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean, enablePatterns?: boolean, enableWatchmen?: boolean, watchmenSynthesisMode?: 'local' | 'agent', enableWiki?: boolean, wikiSynthesisMode?: 'local' | 'agent', wikiLocalModel?: string, enableCodeHealth?: boolean, enableAdvancedAnalysis?: boolean, enableAgentUtils?: boolean, trackCallSites?: boolean, kiroHookFormat: KiroHookFormat = 'v2'): void {
  const kiroDir = path.join(projectRoot, '.kiro');
  const enableCompression = shellCompressionLevel !== 'off';
  const enableShellExec = shellCompressionLevel !== 'off';
  writeMcpConfigFinal(kiroDir, projectRoot, { enableArchitecture, enableMemory, enableDocs, enableData, enableSecurity, enablePatterns, enableWiki, enableCodeHealth, enableAdvancedAnalysis, enableAgentUtils, enableShellExec, trackCallSites });
  writeHooks(kiroDir, { enableCompression, enableMemory, enableWatchmen, watchmenSynthesisMode, enableWiki, wikiSynthesisMode, kiroHookFormat });
  writeSteering(kiroDir, { cavemanMode, enableCompression, shellCompressionLevel: shellCompressionLevel as any, enableMemory, enableDocs, enableData, enableSecurity, enableArchitecture, enablePatterns, enableWiki, enableCodeHealth, enableAdvancedAnalysis, enableAgentUtils, trackCallSites });
  writeCliAgent(kiroDir, { enableSecurity, enableArchitecture, enablePatterns });
}

export function printKiroNextSteps(): void {
  console.log('\n  Done! Restart Kiro IDE for the MCP server to load.');
  console.log('  For Kiro CLI, use the "kirograph" agent: kiro-cli --agent kirograph\n');
}


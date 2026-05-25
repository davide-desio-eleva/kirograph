import * as path from 'path';
import { CavemanMode } from '../caveman';
import { writeCliAgent } from '../cli-agent';
import { writeHooks } from '../hooks';
import { writeMcpConfig } from '../mcp';
import { writeSteering } from '../steering';

export function installKiroEarly(projectRoot: string): void {
  const kiroDir = path.join(projectRoot, '.kiro');
  writeMcpConfig(kiroDir);
  writeHooks(kiroDir);
}

export function installKiroLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean): void {
  const kiroDir = path.join(projectRoot, '.kiro');
  const enableCompression = shellCompressionLevel !== 'off';
  // Re-write hooks with compression and memory awareness
  writeHooks(kiroDir, { enableCompression, enableMemory });
  writeSteering(kiroDir, { cavemanMode, enableCompression, shellCompressionLevel: shellCompressionLevel as any, enableMemory, enableDocs, enableData });
  writeCliAgent(kiroDir);
}

export function printKiroNextSteps(): void {
  console.log('\n  Done! Restart Kiro IDE for the MCP server to load.');
  console.log('  For Kiro CLI, use the "kirograph" agent: kiro-cli --agent kirograph\n');
}


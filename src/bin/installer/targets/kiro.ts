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

export function installKiroLate(projectRoot: string, cavemanMode?: CavemanMode | 'off'): void {
  const kiroDir = path.join(projectRoot, '.kiro');
  writeSteering(kiroDir, cavemanMode);
  writeCliAgent(kiroDir);
}

export function printKiroNextSteps(): void {
  console.log('\n  Done! Restart Kiro IDE for the MCP server to load.');
  console.log('  For Kiro CLI, use the "kirograph" agent: kiro-cli --agent kirograph\n');
}


import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  removeMcpServersConfig,
  writeMcpServersConfig,
} from '../common';
import { buildAgentInstructions } from '../instructions';
import { buildInstructionOpts } from '../common';

export function installWarpEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.warp', 'mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(`  ✓ Warp MCP server registered in ${mcpPath}`);
}

export function installWarpLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'warp.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Warp instructions written to ${instructionsPath}`);

  const rulesDir = path.join(projectRoot, '.warp', 'rules');
  ensureDir(rulesDir);
  const rulePath = path.join(rulesDir, 'kirograph.md');
  fs.writeFileSync(rulePath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Warp rule written to ${rulePath}`);
}

export function uninitWarp(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.warp', 'mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .warp/mcp.json`);
  }

  const rulePath = path.join(projectRoot, '.warp', 'rules', 'kirograph.md');
  if (fs.existsSync(rulePath)) {
    fs.unlinkSync(rulePath);
    console.log(`  ✓ Removed .warp/rules/kirograph.md`);
  }
}

export function printWarpNextSteps(): void {
  console.log('\n  Done! Restart Warp for the MCP server to load.');
  console.log('  KiroGraph rule is in .warp/rules/kirograph.md\n');
}

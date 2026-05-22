import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  removeMcpServersConfig,
  upsertGeneratedBlock,
  removeGeneratedBlock,
  writeMcpServersConfig,
} from '../common';
import { buildAgentInstructions } from '../instructions';
import { buildInstructionOpts } from '../common';

const WINDSURF_BLOCK_ID = 'windsurf';

export function installWindsurfEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.windsurf', 'mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(`  ✓ Windsurf MCP server registered in ${mcpPath}`);
}

export function installWindsurfLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'windsurf.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Windsurf instructions written to ${instructionsPath}`);

  const rulesPath = path.join(projectRoot, '.windsurfrules');
  const changed = upsertGeneratedBlock(rulesPath, WINDSURF_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(changed
    ? `  ✓ .windsurfrules updated with KiroGraph instructions`
    : `  ✓ .windsurfrules already up to date`);
}

export function uninitWindsurf(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.windsurf', 'mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .windsurf/mcp.json`);
  }

  const rulesPath = path.join(projectRoot, '.windsurfrules');
  if (removeGeneratedBlock(rulesPath, WINDSURF_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from .windsurfrules`);
  }
}

export function printWindsurfNextSteps(): void {
  console.log('\n  Done! Restart Windsurf for the MCP server to load.');
  console.log('  KiroGraph instructions are in .windsurfrules\n');
}

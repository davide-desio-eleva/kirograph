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

const AUGMENT_BLOCK_ID = 'augment';

export function installAugmentEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.augment', 'mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(`  ✓ Augment Code MCP server registered in ${mcpPath}`);
}

export function installAugmentLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'augment.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Augment instructions written to ${instructionsPath}`);

  const guidelinesPath = path.join(projectRoot, 'augment-guidelines.md');
  const changed = upsertGeneratedBlock(guidelinesPath, AUGMENT_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(changed
    ? `  ✓ augment-guidelines.md updated with KiroGraph instructions`
    : `  ✓ augment-guidelines.md already up to date`);
}

export function uninitAugment(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.augment', 'mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .augment/mcp.json`);
  }

  const guidelinesPath = path.join(projectRoot, 'augment-guidelines.md');
  if (removeGeneratedBlock(guidelinesPath, AUGMENT_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from augment-guidelines.md`);
  }
}

export function printAugmentNextSteps(): void {
  console.log('\n  Done! Restart Augment Code for the MCP server to load.');
  console.log('  KiroGraph instructions are in augment-guidelines.md\n');
}

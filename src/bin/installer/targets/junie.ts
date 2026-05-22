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

const JUNIE_BLOCK_ID = 'junie';

export function installJunieEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.junie', 'mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(`  ✓ JetBrains Junie MCP server registered in ${mcpPath}`);
}

export function installJunieLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'junie.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Junie instructions written to ${instructionsPath}`);

  const guidelinesPath = path.join(projectRoot, '.junie', 'guidelines.md');
  ensureDir(path.dirname(guidelinesPath));
  const changed = upsertGeneratedBlock(guidelinesPath, JUNIE_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(changed
    ? `  ✓ .junie/guidelines.md updated with KiroGraph instructions`
    : `  ✓ .junie/guidelines.md already up to date`);
}

export function uninitJunie(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.junie', 'mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .junie/mcp.json`);
  }

  const guidelinesPath = path.join(projectRoot, '.junie', 'guidelines.md');
  if (removeGeneratedBlock(guidelinesPath, JUNIE_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from .junie/guidelines.md`);
  }
}

export function printJunieNextSteps(): void {
  console.log('\n  Done! Restart your JetBrains IDE for the Junie MCP server to load.');
  console.log('  KiroGraph instructions are in .junie/guidelines.md\n');
}

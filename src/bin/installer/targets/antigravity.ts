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

const ANTIGRAVITY_BLOCK_ID = 'antigravity';

export function installAntigravityEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.gemini', 'settings', 'mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(`  ✓ Antigravity MCP server registered in ${mcpPath}`);
}

export function installAntigravityLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'antigravity.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Antigravity instructions written to ${instructionsPath}`);

  const geminiPath = path.join(projectRoot, 'GEMINI.md');
  const changed = upsertGeneratedBlock(geminiPath, ANTIGRAVITY_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(changed
    ? `  ✓ GEMINI.md updated with KiroGraph instructions`
    : `  ✓ GEMINI.md already up to date`);
}

export function uninitAntigravity(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.gemini', 'settings', 'mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .gemini/settings/mcp.json`);
  }

  const geminiPath = path.join(projectRoot, 'GEMINI.md');
  if (removeGeneratedBlock(geminiPath, ANTIGRAVITY_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from GEMINI.md`);
  }
}

export function printAntigravityNextSteps(): void {
  console.log('\n  Done! Restart Antigravity for the MCP server to load.');
  console.log('  KiroGraph instructions are in GEMINI.md\n');
}

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

const COPILOT_BLOCK_ID = 'copilot';

export function installCopilotEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.github', 'copilot-mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(`  ✓ GitHub Copilot MCP server registered in ${mcpPath}`);
}

export function installCopilotLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'copilot.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Copilot instructions written to ${instructionsPath}`);

  const rulesPath = path.join(projectRoot, '.github', 'copilot-instructions.md');
  ensureDir(path.dirname(rulesPath));
  const changed = upsertGeneratedBlock(rulesPath, COPILOT_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(changed
    ? `  ✓ .github/copilot-instructions.md updated with KiroGraph instructions`
    : `  ✓ .github/copilot-instructions.md already up to date`);
}

export function uninitCopilot(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.github', 'copilot-mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .github/copilot-mcp.json`);
  }

  const rulesPath = path.join(projectRoot, '.github', 'copilot-instructions.md');
  if (removeGeneratedBlock(rulesPath, COPILOT_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from .github/copilot-instructions.md`);
  }
}

export function printCopilotNextSteps(): void {
  console.log('\n  Done! Restart your editor for the Copilot MCP server to load.');
  console.log('  KiroGraph instructions are in .github/copilot-instructions.md\n');
}

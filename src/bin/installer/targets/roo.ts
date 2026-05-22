import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  KIROGRAPH_SERVER_NAME,
  readJson,
  writeJson,
  upsertGeneratedBlock,
  removeGeneratedBlock,
} from '../common';
import { buildAgentInstructions } from '../instructions';
import { buildInstructionOpts } from '../common';

const ROO_BLOCK_ID = 'roo';

export function installRooEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.roo', 'mcp.json');
  ensureDir(path.dirname(mcpPath));
  const config = readJson(mcpPath);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
    disabled: false,
  };
  writeJson(mcpPath, config);
  console.log(`  ✓ Roo Code MCP server registered in ${mcpPath}`);
}

export function installRooLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'roo.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Roo Code instructions written to ${instructionsPath}`);

  const rulesPath = path.join(projectRoot, '.roorules');
  const changed = upsertGeneratedBlock(rulesPath, ROO_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(changed
    ? `  ✓ .roorules updated with KiroGraph instructions`
    : `  ✓ .roorules already up to date`);
}

export function uninitRoo(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.roo', 'mcp.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from .roo/mcp.json`);
    }
  }

  const rulesPath = path.join(projectRoot, '.roorules');
  if (removeGeneratedBlock(rulesPath, ROO_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from .roorules`);
  }
}

export function printRooNextSteps(): void {
  console.log('\n  Done! Restart Roo Code for the MCP server to load.');
  console.log('  KiroGraph instructions are in .roorules\n');
}

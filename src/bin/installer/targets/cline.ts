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

const CLINE_BLOCK_ID = 'cline';

export function installClineEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.cline', 'mcp_settings.json');
  ensureDir(path.dirname(mcpPath));
  const config = readJson(mcpPath);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
    disabled: false,
  };
  writeJson(mcpPath, config);
  console.log(`  ✓ Cline MCP server registered in ${mcpPath}`);
}

export function installClineLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'cline.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Cline instructions written to ${instructionsPath}`);

  const rulesPath = path.join(projectRoot, '.clinerules');
  const changed = upsertGeneratedBlock(rulesPath, CLINE_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(changed
    ? `  ✓ .clinerules updated with KiroGraph instructions`
    : `  ✓ .clinerules already up to date`);
}

export function uninitCline(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.cline', 'mcp_settings.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from .cline/mcp_settings.json`);
    }
  }

  const rulesPath = path.join(projectRoot, '.clinerules');
  if (removeGeneratedBlock(rulesPath, CLINE_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from .clinerules`);
  }
}

export function printClineNextSteps(): void {
  console.log('\n  Done! Restart Cline for the MCP server to load.');
  console.log('  KiroGraph instructions are in .clinerules\n');
}

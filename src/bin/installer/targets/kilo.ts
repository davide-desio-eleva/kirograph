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

const KILO_BLOCK_ID = 'kilo';

export function installKiloEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.kilo', 'mcp_settings.json');
  ensureDir(path.dirname(mcpPath));
  const config = readJson(mcpPath);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
    disabled: false,
  };
  writeJson(mcpPath, config);
  console.log(`  ✓ Kilo Code MCP server registered in ${mcpPath}`);
}

export function installKiloLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'kilo.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Kilo Code instructions written to ${instructionsPath}`);

  const rulesPath = path.join(projectRoot, '.kilorules');
  const changed = upsertGeneratedBlock(rulesPath, KILO_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(changed
    ? `  ✓ .kilorules updated with KiroGraph instructions`
    : `  ✓ .kilorules already up to date`);
}

export function uninitKilo(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.kilo', 'mcp_settings.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from .kilo/mcp_settings.json`);
    }
  }

  const rulesPath = path.join(projectRoot, '.kilorules');
  if (removeGeneratedBlock(rulesPath, KILO_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from .kilorules`);
  }
}

export function printKiloNextSteps(): void {
  console.log('\n  Done! Restart Kilo Code for the MCP server to load.');
  console.log('  KiroGraph instructions are in .kilorules\n');
}

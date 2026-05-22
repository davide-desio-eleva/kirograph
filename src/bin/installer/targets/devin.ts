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

const DEVIN_BLOCK_ID = 'devin';

export function installDevinEarly(projectRoot: string): void {
  const configPath = path.join(projectRoot, 'devin.json');
  const config = readJson(configPath);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };
  writeJson(configPath, config);
  console.log(`  ✓ Devin MCP server registered in ${configPath}`);
}

export function installDevinLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'devin.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Devin instructions written to ${instructionsPath}`);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const changed = upsertGeneratedBlock(agentsPath, DEVIN_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(changed
    ? `  ✓ AGENTS.md updated with KiroGraph instructions (Devin)`
    : `  ✓ AGENTS.md already up to date`);
}

export function uninitDevin(projectRoot: string): void {
  const configPath = path.join(projectRoot, 'devin.json');
  if (fs.existsSync(configPath)) {
    const config = readJson(configPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      writeJson(configPath, config);
      console.log(`  ✓ Removed kirograph from devin.json`);
    }
  }

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (removeGeneratedBlock(agentsPath, DEVIN_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from AGENTS.md (Devin)`);
  }
}

export function printDevinNextSteps(): void {
  console.log('\n  Done! Devin will pick up the MCP server from devin.json.');
  console.log('  KiroGraph instructions are in AGENTS.md\n');
}

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

const OPENHANDS_BLOCK_ID = 'openhands';

export function installOpenHandsEarly(projectRoot: string): void {
  const configPath = path.join(projectRoot, '.openhands', 'config.json');
  ensureDir(path.dirname(configPath));
  const config = readJson(configPath);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };
  writeJson(configPath, config);
  console.log(`  ✓ OpenHands MCP server registered in ${configPath}`);
}

export function installOpenHandsLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'openhands.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ OpenHands instructions written to ${instructionsPath}`);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const changed = upsertGeneratedBlock(agentsPath, OPENHANDS_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(changed
    ? `  ✓ AGENTS.md updated with KiroGraph instructions (OpenHands)`
    : `  ✓ AGENTS.md already up to date`);
}

export function uninitOpenHands(projectRoot: string): void {
  const configPath = path.join(projectRoot, '.openhands', 'config.json');
  if (fs.existsSync(configPath)) {
    const config = readJson(configPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      writeJson(configPath, config);
      console.log(`  ✓ Removed kirograph from .openhands/config.json`);
    }
  }

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (removeGeneratedBlock(agentsPath, OPENHANDS_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from AGENTS.md (OpenHands)`);
  }
}

export function printOpenHandsNextSteps(): void {
  console.log('\n  Done! Restart OpenHands for the MCP server to load.');
  console.log('  KiroGraph instructions are in AGENTS.md\n');
}

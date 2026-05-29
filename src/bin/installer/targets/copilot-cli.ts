/**
 * GitHub Copilot CLI target.
 *
 * MCP: ~/.copilot/mcp-config.json with "servers" key
 * Instructions: AGENTS.md (upsert block)
 */

import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  buildInstructionOpts,
  readJson,
  writeJson,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  KIROGRAPH_SERVER_NAME,
  upsertGeneratedBlock,
  removeGeneratedBlock,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const COPILOT_CLI_BLOCK_ID = 'copilot-cli';

export function installCopilotCliEarly(_projectRoot: string): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const mcpPath = path.join(home, '.copilot', 'mcp-config.json');
  ensureDir(path.dirname(mcpPath));
  const config = readJson(mcpPath);
  config.servers = config.servers ?? {};
  if (config.servers[KIROGRAPH_SERVER_NAME]) {
    console.log(`  ✓ Copilot CLI MCP already configured in ${mcpPath}`);
    return;
  }
  config.servers[KIROGRAPH_SERVER_NAME] = {
    type: 'stdio',
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };
  writeJson(mcpPath, config);
  console.log(`  ✓ Copilot CLI MCP server registered in ${mcpPath}`);
}

export function installCopilotCliLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'copilot-cli.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Copilot CLI instructions written to ${instructionsPath}`);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const changed = upsertGeneratedBlock(agentsPath, COPILOT_CLI_BLOCK_ID, '## KiroGraph', buildAgentInstructions(opts));
  console.log(changed
    ? `  ✓ AGENTS.md updated with KiroGraph instructions (Copilot CLI)`
    : `  ✓ AGENTS.md already up to date`);
}

export function uninitCopilotCli(projectRoot: string): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const mcpPath = path.join(home, '.copilot', 'mcp-config.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.servers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.servers[KIROGRAPH_SERVER_NAME];
      if (Object.keys(config.servers).length === 0) delete config.servers;
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from ~/.copilot/mcp-config.json`);
    }
  }

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (removeGeneratedBlock(agentsPath, COPILOT_CLI_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from AGENTS.md (Copilot CLI)`);
  }
}

export function printCopilotCliNextSteps(): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const mcpPath = path.join(home, '.copilot', 'mcp-config.json');
  console.log('\n  Done! Copilot CLI MCP server registered.');
  console.log(`  MCP config: ${mcpPath}`);
  console.log('  KiroGraph instructions are in AGENTS.md\n');
}

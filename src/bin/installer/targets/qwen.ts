/**
 * Qwen Code target.
 *
 * MCP: ~/.qwen/settings.json (user-scoped, mcpServers format)
 * Instructions: .kirograph/qwen.md
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
} from '../common';
import { buildAgentInstructions } from '../instructions';

export function installQwenEarly(_projectRoot: string): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const mcpPath = path.join(home, '.qwen', 'settings.json');
  ensureDir(path.dirname(mcpPath));
  const config = readJson(mcpPath);
  config.mcpServers = config.mcpServers ?? {};
  if (config.mcpServers[KIROGRAPH_SERVER_NAME]) {
    console.log(`  ✓ Qwen Code MCP already configured in ${mcpPath}`);
    return;
  }
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };
  writeJson(mcpPath, config);
  console.log(`  ✓ Qwen Code MCP server registered in ${mcpPath}`);
}

export function installQwenLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'qwen.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(`  ✓ Qwen Code instructions written to ${instructionsPath}`);
}

export function uninitQwen(projectRoot: string): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const mcpPath = path.join(home, '.qwen', 'settings.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from ~/.qwen/settings.json`);
    }
  }

  const instructionsPath = path.join(projectRoot, '.kirograph', 'qwen.md');
  if (fs.existsSync(instructionsPath)) {
    fs.unlinkSync(instructionsPath);
    console.log(`  ✓ Removed .kirograph/qwen.md`);
  }
}

export function printQwenNextSteps(): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const mcpPath = path.join(home, '.qwen', 'settings.json');
  console.log('\n  Done! Restart Qwen Code for the MCP server to load.');
  console.log(`  MCP registered in ${mcpPath}\n`);
}

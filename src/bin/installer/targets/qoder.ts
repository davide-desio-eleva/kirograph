/**
 * Qoder target.
 *
 * MCP: .qoder/mcp.json (project-level, mcpServers format)
 * Instructions: .kirograph/qoder.md
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

export function installQoderEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.qoder', 'mcp.json');
  ensureDir(path.dirname(mcpPath));
  const config = readJson(mcpPath);
  config.mcpServers = config.mcpServers ?? {};
  if (config.mcpServers[KIROGRAPH_SERVER_NAME]) {
    console.log(`  ✓ Qoder MCP already configured in ${mcpPath}`);
    return;
  }
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };
  writeJson(mcpPath, config);
  console.log(`  ✓ Qoder MCP server registered in ${mcpPath}`);
}

export function installQoderLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'qoder.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(`  ✓ Qoder instructions written to ${instructionsPath}`);
}

export function uninitQoder(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.qoder', 'mcp.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from .qoder/mcp.json`);
    }
  }

  const instructionsPath = path.join(projectRoot, '.kirograph', 'qoder.md');
  if (fs.existsSync(instructionsPath)) {
    fs.unlinkSync(instructionsPath);
    console.log(`  ✓ Removed .kirograph/qoder.md`);
  }
}

export function printQoderNextSteps(): void {
  console.log('\n  Done! Restart Qoder for the MCP server to load.');
  console.log('  MCP registered in .qoder/mcp.json\n');
}

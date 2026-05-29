/**
 * Warp target.
 *
 * MCP: .warp/.mcp.json (project-level, standard mcpServers format)
 * Rules: AGENTS.md (Warp reads this natively, upsert block)
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

const WARP_BLOCK_ID = 'warp';

export function installWarpEarly(projectRoot: string): void {
  // Write MCP to .warp/.mcp.json (project-level)
  const mcpPath = path.join(projectRoot, '.warp', '.mcp.json');
  ensureDir(path.dirname(mcpPath));
  const config = readJson(mcpPath);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };
  writeJson(mcpPath, config);
  console.log(`  ✓ Warp MCP server registered in ${mcpPath}`);
}

export function installWarpLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'warp.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Warp instructions written to ${instructionsPath}`);

  // Write to AGENTS.md (Warp reads this natively)
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const changed = upsertGeneratedBlock(agentsPath, WARP_BLOCK_ID, '## KiroGraph', buildAgentInstructions(opts));
  console.log(changed
    ? `  ✓ AGENTS.md updated with KiroGraph instructions (Warp)`
    : `  ✓ AGENTS.md already up to date`);

  // Remove legacy .warp/rules/kirograph.md if it exists
  const legacyRule = path.join(projectRoot, '.warp', 'rules', 'kirograph.md');
  if (fs.existsSync(legacyRule)) {
    fs.unlinkSync(legacyRule);
    console.log(`  ✓ Removed legacy .warp/rules/kirograph.md`);
  }
}

export function uninitWarp(projectRoot: string): void {
  // Remove MCP entry
  const mcpPath = path.join(projectRoot, '.warp', '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from .warp/.mcp.json`);
    }
  }

  // Remove AGENTS.md block
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (removeGeneratedBlock(agentsPath, WARP_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from AGENTS.md (Warp)`);
  }
}

export function printWarpNextSteps(): void {
  console.log('\n  Done! Restart Warp for the MCP server to load.');
  console.log('  MCP is in .warp/.mcp.json');
  console.log('  KiroGraph instructions are in AGENTS.md\n');
}

/**
 * JetBrains Junie target.
 *
 * MCP: .junie/mcp/mcp.json (project-level, standard mcpServers format)
 * Rules: .junie/AGENTS.md (preferred guidelines location)
 * Hooks: Only SessionStart (EAP, user-level only) — not useful for auto-sync
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

const JUNIE_BLOCK_ID = 'junie';

export function installJunieEarly(projectRoot: string): void {
  // Write MCP to .junie/mcp/mcp.json (project-level)
  const mcpPath = path.join(projectRoot, '.junie', 'mcp', 'mcp.json');
  ensureDir(path.dirname(mcpPath));
  const config = readJson(mcpPath);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };
  writeJson(mcpPath, config);
  console.log(`  ✓ Junie MCP server registered in ${mcpPath}`);
}

export function installJunieLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'junie.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Junie instructions written to ${instructionsPath}`);

  // Write to .junie/AGENTS.md (preferred guidelines location)
  const agentsPath = path.join(projectRoot, '.junie', 'AGENTS.md');
  ensureDir(path.dirname(agentsPath));
  const changed = upsertGeneratedBlock(agentsPath, JUNIE_BLOCK_ID, '## KiroGraph', buildAgentInstructions(opts));
  console.log(changed
    ? `  ✓ .junie/AGENTS.md updated with KiroGraph instructions`
    : `  ✓ .junie/AGENTS.md already up to date`);

  // Remove legacy .junie/guidelines.md if it was created by us
  const legacyPath = path.join(projectRoot, '.junie', 'guidelines.md');
  if (fs.existsSync(legacyPath)) {
    const content = fs.readFileSync(legacyPath, 'utf8');
    if (content.includes('kirograph') || content.includes('KiroGraph')) {
      fs.unlinkSync(legacyPath);
      console.log(`  ✓ Removed legacy .junie/guidelines.md (migrated to .junie/AGENTS.md)`);
    }
  }
}

export function uninitJunie(projectRoot: string): void {
  // Remove MCP entry
  const mcpPath = path.join(projectRoot, '.junie', 'mcp', 'mcp.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from .junie/mcp/mcp.json`);
    }
  }

  // Remove guidelines block
  const agentsPath = path.join(projectRoot, '.junie', 'AGENTS.md');
  if (removeGeneratedBlock(agentsPath, JUNIE_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from .junie/AGENTS.md`);
  }

  // Also check legacy path
  const legacyPath = path.join(projectRoot, '.junie', 'guidelines.md');
  if (removeGeneratedBlock(legacyPath, JUNIE_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from .junie/guidelines.md`);
  }
}

export function printJunieNextSteps(): void {
  console.log('\n  Done! Restart Junie for the MCP server to load.');
  console.log('  MCP is in .junie/mcp/mcp.json');
  console.log('  KiroGraph guidelines are in .junie/AGENTS.md\n');
}

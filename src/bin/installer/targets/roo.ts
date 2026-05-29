/**
 * Roo Code target.
 *
 * MCP: user-scoped at ~/.roo/mcp_settings.json (print instructions)
 * Rules: .roo/rules/kirograph.md (directory-based, preferred method)
 * Also reads: AGENTS.md, .roorules (fallback)
 */

import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  buildInstructionOpts,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  KIROGRAPH_SERVER_NAME,
  readJson,
  writeJson,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const ROO_RULES_FILE = 'kirograph.md';

export function installRooEarly(projectRoot: string): void {
  // Write MCP to .roo/mcp.json (project-level, per Roo Code docs)
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

export function installRooLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'roo.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Roo Code instructions written to ${instructionsPath}`);

  // Write rules file inside .roo/rules/ directory (preferred method)
  const rulesDir = path.join(projectRoot, '.roo', 'rules');
  ensureDir(rulesDir);
  const rulePath = path.join(rulesDir, ROO_RULES_FILE);
  fs.writeFileSync(rulePath, buildAgentInstructions(opts));
  console.log(`  ✓ Roo Code rule written to ${rulePath}`);
}

export function uninitRoo(projectRoot: string): void {
  // Remove MCP entry
  const mcpPath = path.join(projectRoot, '.roo', 'mcp.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from .roo/mcp.json`);
    }
  }

  // Remove rule file
  const rulePath = path.join(projectRoot, '.roo', 'rules', ROO_RULES_FILE);
  if (fs.existsSync(rulePath)) {
    fs.unlinkSync(rulePath);
    console.log(`  ✓ Removed .roo/rules/${ROO_RULES_FILE}`);
  }
}

export function printRooNextSteps(): void {
  console.log('\n  Done! Restart Roo Code for the MCP server to load.');
  console.log('  MCP is in .roo/mcp.json');
  console.log('  KiroGraph rule is in .roo/rules/kirograph.md\n');
}

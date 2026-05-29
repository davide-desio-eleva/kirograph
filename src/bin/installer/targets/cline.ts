/**
 * Cline target.
 *
 * MCP: .cline/mcp_settings.json
 * Rules: .clinerules/kirograph.md (directory-based, not a flat file)
 * Hooks: .cline/hooks/task_completed (executable script)
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

const CLINE_RULES_FILE = 'kirograph.md';
const CLINE_HOOK_SCRIPT = '#!/bin/sh\nkirograph sync --quiet 2>/dev/null || true\n';

export function installClineEarly(projectRoot: string): void {
  // Write MCP config to workspace-level .cline/mcp_settings.json
  const mcpPath = path.join(projectRoot, '.cline', 'mcp_settings.json');
  ensureDir(path.dirname(mcpPath));
  const existing = readJson(mcpPath);
  existing.mcpServers = existing.mcpServers ?? {};
  if (existing.mcpServers[KIROGRAPH_SERVER_NAME]) {
    console.log(`  ✓ Cline MCP already configured in ${mcpPath}`);
    return;
  }
  existing.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
    disabled: false,
  };
  writeJson(mcpPath, existing);
  console.log(`  ✓ Cline MCP server registered in ${mcpPath}`);
}

export function installClineLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true, enableDocs, enableData, enableSecurity, enableArchitecture);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'cline.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Cline instructions written to ${instructionsPath}`);

  // Write rules file inside .clinerules/ directory
  const rulesDir = path.join(projectRoot, '.clinerules');
  // If .clinerules exists as a flat file (legacy), remove it first
  if (fs.existsSync(rulesDir) && fs.statSync(rulesDir).isFile()) {
    fs.unlinkSync(rulesDir);
  }
  ensureDir(rulesDir);
  const rulePath = path.join(rulesDir, CLINE_RULES_FILE);
  fs.writeFileSync(rulePath, buildAgentInstructions(opts));
  console.log(`  ✓ Cline rule written to ${rulePath}`);

  // Write hook script
  const hooksDir = path.join(projectRoot, '.clinerules', 'hooks');
  ensureDir(hooksDir);
  const hookPath = path.join(hooksDir, 'task_completed');
  fs.writeFileSync(hookPath, CLINE_HOOK_SCRIPT, { mode: 0o755 });
  console.log(`  ✓ Cline hook written to ${hookPath}`);
}

export function uninitCline(projectRoot: string): void {
  // Remove MCP entry
  const mcpPath = path.join(projectRoot, '.cline', 'mcp_settings.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from .cline/mcp_settings.json`);
    }
  }

  // Remove rule file
  const rulePath = path.join(projectRoot, '.clinerules', CLINE_RULES_FILE);
  if (fs.existsSync(rulePath)) {
    fs.unlinkSync(rulePath);
    console.log(`  ✓ Removed .clinerules/${CLINE_RULES_FILE}`);
  }

  // Remove hook
  const hookPath = path.join(projectRoot, '.clinerules', 'hooks', 'task_completed');
  if (fs.existsSync(hookPath)) {
    const content = fs.readFileSync(hookPath, 'utf8');
    if (content.includes('kirograph')) {
      fs.unlinkSync(hookPath);
      console.log(`  ✓ Removed Cline hook .clinerules/hooks/task_completed`);
    }
  }
}

export function printClineNextSteps(_projectRoot: string): void {
  console.log('\n  Done! Restart Cline for the MCP server to load.');
  console.log('  MCP registered in .cline/mcp_settings.json');
  console.log('  KiroGraph rule and hook are in .clinerules/\n');
}

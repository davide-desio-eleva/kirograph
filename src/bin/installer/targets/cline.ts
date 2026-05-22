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
  upsertGeneratedBlock,
  removeGeneratedBlock,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const CLINE_BLOCK_ID = 'cline';
const CLINE_HOOK_SCRIPT = '#!/bin/sh\nkirograph sync --quiet 2>/dev/null || true\n';

export function installClineEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.cline', 'mcp_settings.json');
  ensureDir(path.dirname(mcpPath));
  const config = readJson(mcpPath);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
    disabled: false,
  };
  writeJson(mcpPath, config);
  console.log(`  ✓ Cline MCP server registered in ${mcpPath}`);
}

export function installClineLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'cline.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Cline instructions written to ${instructionsPath}`);

  const rulesPath = path.join(projectRoot, '.clinerules');
  const changed = upsertGeneratedBlock(rulesPath, CLINE_BLOCK_ID, '## KiroGraph', buildAgentInstructions(opts));
  console.log(changed
    ? `  ✓ .clinerules updated with KiroGraph instructions`
    : `  ✓ .clinerules already up to date`);

  // Write hook script — Cline uses executable scripts in .clinerules/hooks/
  const hooksDir = path.join(projectRoot, '.clinerules', 'hooks');
  ensureDir(hooksDir);
  const hookPath = path.join(hooksDir, 'task_completed');
  fs.writeFileSync(hookPath, CLINE_HOOK_SCRIPT, { mode: 0o755 });
  console.log(`  ✓ Cline hook written to ${hookPath}`);
}

export function uninitCline(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.cline', 'mcp_settings.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from .cline/mcp_settings.json`);
    }
  }

  const rulesPath = path.join(projectRoot, '.clinerules');
  if (removeGeneratedBlock(rulesPath, CLINE_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from .clinerules`);
  }

  const hookPath = path.join(projectRoot, '.clinerules', 'hooks', 'task_completed');
  if (fs.existsSync(hookPath)) {
    const content = fs.readFileSync(hookPath, 'utf8');
    if (content.includes('kirograph')) {
      fs.unlinkSync(hookPath);
      console.log(`  ✓ Removed Cline hook .clinerules/hooks/task_completed`);
    }
  }
}

export function printClineNextSteps(): void {
  console.log('\n  Done! Restart Cline for the MCP server and hooks to load.');
  console.log('  Auto-sync hook runs on task completion.\n');
}

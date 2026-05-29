/**
 * Antigravity IDE target.
 *
 * MCP: user-scoped at ~/.gemini/antigravity/mcp_config.json (print instructions)
 * Hooks: .agents/hooks.json (workspace-level)
 * Instructions: GEMINI.md (upsert block)
 */

import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  buildInstructionOpts,
  readJson,
  writeJson,
  upsertGeneratedBlock,
  removeGeneratedBlock,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  KIROGRAPH_SERVER_NAME,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const ANTIGRAVITY_BLOCK_ID = 'antigravity';

function buildAntigravityHooks(): object {
  return {
    'kirograph-sync': {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'kirograph sync --quiet 2>/dev/null || true',
              timeout: 30,
            },
          ],
        },
      ],
    },
  };
}

export function installAntigravityEarly(_projectRoot: string): void {
  // Write MCP config to user-scoped ~/.gemini/antigravity/mcp_config.json
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const mcpPath = path.join(home, '.gemini', 'antigravity', 'mcp_config.json');
  ensureDir(path.dirname(mcpPath));
  const existing = readJson(mcpPath);
  existing.mcpServers = existing.mcpServers ?? {};
  if (existing.mcpServers[KIROGRAPH_SERVER_NAME]) {
    console.log(`  ✓ Antigravity MCP already configured in ${mcpPath}`);
    return;
  }
  existing.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };
  writeJson(mcpPath, existing);
  console.log(`  ✓ Antigravity MCP server registered in ${mcpPath}`);
}

export function installAntigravityLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true, enableDocs, enableData, enableSecurity, enableArchitecture);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'antigravity.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Antigravity instructions written to ${instructionsPath}`);

  const geminiPath = path.join(projectRoot, 'GEMINI.md');
  const changed = upsertGeneratedBlock(geminiPath, ANTIGRAVITY_BLOCK_ID, '## KiroGraph', buildAgentInstructions(opts));
  console.log(changed
    ? `  ✓ GEMINI.md updated with KiroGraph instructions`
    : `  ✓ GEMINI.md already up to date`);

  // Write hooks to .agents/hooks.json
  const hooksPath = path.join(projectRoot, '.agents', 'hooks.json');
  ensureDir(path.dirname(hooksPath));
  const existing = readJson(hooksPath);
  const kgHooks = buildAntigravityHooks() as any;
  // Merge without overwriting existing hooks
  for (const [name, config] of Object.entries(kgHooks)) {
    if (!existing[name]) {
      existing[name] = config;
    }
  }
  writeJson(hooksPath, existing);
  console.log(`  ✓ Antigravity hooks written to ${hooksPath}`);
}

export function uninitAntigravity(projectRoot: string): void {
  // Remove user-scoped MCP config
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const mcpPath = path.join(home, '.gemini', 'antigravity', 'mcp_config.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from ${mcpPath}`);
    }
  }

  const geminiPath = path.join(projectRoot, 'GEMINI.md');
  if (removeGeneratedBlock(geminiPath, ANTIGRAVITY_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from GEMINI.md`);
  }

  // Remove hooks
  const hooksPath = path.join(projectRoot, '.agents', 'hooks.json');
  if (fs.existsSync(hooksPath)) {
    const config = readJson(hooksPath);
    if (config['kirograph-sync']) {
      delete config['kirograph-sync'];
      writeJson(hooksPath, config);
      console.log(`  ✓ Removed kirograph-sync from .agents/hooks.json`);
    }
  }
}

export function printAntigravityNextSteps(_projectRoot: string): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const mcpPath = path.join(home, '.gemini', 'antigravity', 'mcp_config.json');
  console.log('\n  Done! Restart Antigravity for the MCP server to load.');
  console.log(`  MCP registered in ${mcpPath}`);
  console.log('  KiroGraph instructions are in GEMINI.md');
  console.log('  Auto-sync hook installed in .agents/hooks.json\n');
}

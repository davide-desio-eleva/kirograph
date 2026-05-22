/**
 * Devin for Terminal target.
 *
 * MCP: .devin/config.json (project-level, standard mcpServers format)
 * Hooks: .devin/hooks.v1.json (Claude Code compatible format)
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

const DEVIN_BLOCK_ID = 'devin';

function buildDevinHooks(): object {
  return {
    hooks: {
      Stop: [
        {
          matcher: '',
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

export function installDevinEarly(projectRoot: string): void {
  // Write MCP to .devin/config.json
  const configPath = path.join(projectRoot, '.devin', 'config.json');
  ensureDir(path.dirname(configPath));
  const config = readJson(configPath);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };
  writeJson(configPath, config);
  console.log(`  ✓ Devin MCP server registered in ${configPath}`);
}

export function installDevinLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'devin.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Devin instructions written to ${instructionsPath}`);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const changed = upsertGeneratedBlock(agentsPath, DEVIN_BLOCK_ID, '## KiroGraph', buildAgentInstructions(opts));
  console.log(changed
    ? `  ✓ AGENTS.md updated with KiroGraph instructions (Devin)`
    : `  ✓ AGENTS.md already up to date`);

  // Write hooks to .devin/hooks.v1.json (Claude Code compatible)
  const hooksPath = path.join(projectRoot, '.devin', 'hooks.v1.json');
  const existing = readJson(hooksPath);
  const kgHooks = buildDevinHooks() as any;
  existing.hooks = existing.hooks ?? {};
  for (const [event, matchers] of Object.entries(kgHooks.hooks)) {
    existing.hooks[event] = existing.hooks[event] ?? [];
    const hasKirograph = existing.hooks[event].some((m: any) =>
      m.hooks?.some((h: any) => h.command?.includes('kirograph'))
    );
    if (!hasKirograph) {
      for (const matcher of matchers as any[]) {
        existing.hooks[event].push(matcher);
      }
    }
  }
  writeJson(hooksPath, existing);
  console.log(`  ✓ Devin hooks written to ${hooksPath}`);
}

export function uninitDevin(projectRoot: string): void {
  // Remove MCP
  const configPath = path.join(projectRoot, '.devin', 'config.json');
  if (fs.existsSync(configPath)) {
    const config = readJson(configPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeJson(configPath, config);
      console.log(`  ✓ Removed kirograph from .devin/config.json`);
    }
  }

  // Remove AGENTS.md block
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (removeGeneratedBlock(agentsPath, DEVIN_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from AGENTS.md (Devin)`);
  }

  // Remove hooks
  const hooksPath = path.join(projectRoot, '.devin', 'hooks.v1.json');
  if (fs.existsSync(hooksPath)) {
    const config = readJson(hooksPath);
    if (config.hooks) {
      let changed = false;
      for (const event of Object.keys(config.hooks)) {
        const before = config.hooks[event].length;
        config.hooks[event] = config.hooks[event].filter((m: any) =>
          !m.hooks?.some((h: any) => h.command?.includes('kirograph'))
        );
        if (config.hooks[event].length === 0) delete config.hooks[event];
        if (config.hooks[event]?.length !== before) changed = true;
      }
      if (Object.keys(config.hooks).length === 0) delete config.hooks;
      if (changed) {
        writeJson(hooksPath, config);
        console.log(`  ✓ Removed kirograph hooks from .devin/hooks.v1.json`);
      }
    }
  }
}

export function printDevinNextSteps(): void {
  console.log('\n  Done! Restart Devin for Terminal for the MCP server and hooks to load.');
  console.log('  MCP is in .devin/config.json');
  console.log('  Auto-sync hook is in .devin/hooks.v1.json');
  console.log('  KiroGraph instructions are in AGENTS.md\n');
}

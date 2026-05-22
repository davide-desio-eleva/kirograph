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
  removeMcpServersConfig,
  upsertGeneratedBlock,
  removeGeneratedBlock,
  writeMcpServersConfig,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const WINDSURF_BLOCK_ID = 'windsurf';

function buildWindsurfHooks(): object {
  return {
    hooks: {
      post_cascade_response: [
        { command: 'kirograph sync --quiet 2>/dev/null || true', show_output: false },
      ],
    },
  };
}

export function installWindsurfEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.windsurf', 'mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(`  ✓ Windsurf MCP server registered in ${mcpPath}`);
}

export function installWindsurfLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'windsurf.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Windsurf instructions written to ${instructionsPath}`);

  const rulesPath = path.join(projectRoot, '.windsurfrules');
  const changed = upsertGeneratedBlock(rulesPath, WINDSURF_BLOCK_ID, '## KiroGraph', buildAgentInstructions(opts));
  console.log(changed
    ? `  ✓ .windsurfrules updated with KiroGraph instructions`
    : `  ✓ .windsurfrules already up to date`);

  // Write hooks
  const hooksPath = path.join(projectRoot, '.windsurf', 'hooks.json');
  const existing = readJson(hooksPath);
  const kgHooks = buildWindsurfHooks() as any;
  existing.hooks = existing.hooks ?? {};
  for (const [event, commands] of Object.entries(kgHooks.hooks)) {
    existing.hooks[event] = existing.hooks[event] ?? [];
    for (const cmd of commands as Array<{ command: string; show_output: boolean }>) {
      if (!existing.hooks[event].some((h: any) => h.command === cmd.command)) {
        existing.hooks[event].push(cmd);
      }
    }
  }
  writeJson(hooksPath, existing);
  console.log(`  ✓ Windsurf hooks written to ${hooksPath}`);
}

export function uninitWindsurf(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.windsurf', 'mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .windsurf/mcp.json`);
  }

  const rulesPath = path.join(projectRoot, '.windsurfrules');
  if (removeGeneratedBlock(rulesPath, WINDSURF_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from .windsurfrules`);
  }

  // Remove kirograph hooks
  const hooksPath = path.join(projectRoot, '.windsurf', 'hooks.json');
  if (fs.existsSync(hooksPath)) {
    const config = readJson(hooksPath);
    if (config.hooks) {
      let changed = false;
      for (const event of Object.keys(config.hooks)) {
        const before = config.hooks[event].length;
        config.hooks[event] = config.hooks[event].filter((h: any) => !h.command?.includes('kirograph'));
        if (config.hooks[event].length === 0) delete config.hooks[event];
        if (config.hooks[event]?.length !== before) changed = true;
      }
      if (Object.keys(config.hooks).length === 0) delete config.hooks;
      if (changed) {
        writeJson(hooksPath, config);
        console.log(`  ✓ Removed kirograph hooks from .windsurf/hooks.json`);
      }
    }
  }
}

export function printWindsurfNextSteps(): void {
  console.log('\n  Done! Restart Windsurf for the MCP server and hooks to load.');
  console.log('  KiroGraph instructions are in .windsurfrules');
  console.log('  Auto-sync hook runs after each Cascade response.\n');
}

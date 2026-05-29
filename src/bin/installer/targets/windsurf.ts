/**
 * Windsurf target.
 *
 * MCP: user-scoped at ~/.codeium/windsurf/mcp_config.json (print instructions)
 * Rules: .windsurf/rules/kirograph.md (workspace-level, with frontmatter)
 * Hooks: .windsurf/hooks.json (workspace-level)
 */

import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  buildInstructionOpts,
  readJson,
  writeJson,
  printMcpSetup,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  KIROGRAPH_SERVER_NAME,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const WINDSURF_RULES_FILE = 'kirograph.md';

function buildWindsurfHooks(): object {
  return {
    hooks: {
      post_cascade_response: [
        { command: 'kirograph sync --quiet 2>/dev/null || true', show_output: false },
      ],
    },
  };
}

function buildWindsurfRule(instructions: string): string {
  const frontmatter = [
    '---',
    'trigger: always_on',
    '---',
    '',
  ].join('\n');
  return frontmatter + instructions;
}

export function installWindsurfEarly(_projectRoot: string): void {
  // Write MCP config to user-scoped ~/.codeium/windsurf/mcp_config.json
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const mcpPath = path.join(home, '.codeium', 'windsurf', 'mcp_config.json');
  ensureDir(path.dirname(mcpPath));
  const existing = readJson(mcpPath);
  existing.mcpServers = existing.mcpServers ?? {};
  if (existing.mcpServers[KIROGRAPH_SERVER_NAME]) {
    console.log(`  ✓ Windsurf MCP already configured in ${mcpPath}`);
    return;
  }
  existing.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };
  writeJson(mcpPath, existing);
  console.log(`  ✓ Windsurf MCP server registered in ${mcpPath}`);
}

export function installWindsurfLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true, enableDocs, enableData, enableSecurity, enableArchitecture);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'windsurf.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Windsurf instructions written to ${instructionsPath}`);

  // Write rules file inside .windsurf/rules/ with frontmatter
  const rulesDir = path.join(projectRoot, '.windsurf', 'rules');
  ensureDir(rulesDir);
  const rulePath = path.join(rulesDir, WINDSURF_RULES_FILE);
  fs.writeFileSync(rulePath, buildWindsurfRule(buildAgentInstructions(opts)));
  console.log(`  ✓ Windsurf rule written to ${rulePath}`);

  // Remove legacy .windsurfrules if it exists and was created by us
  const legacyPath = path.join(projectRoot, '.windsurfrules');
  if (fs.existsSync(legacyPath)) {
    const content = fs.readFileSync(legacyPath, 'utf8');
    if (content.includes('kirograph')) {
      fs.unlinkSync(legacyPath);
      console.log(`  ✓ Removed legacy .windsurfrules (migrated to .windsurf/rules/)`);
    }
  }

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
  // Remove user-scoped MCP config
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const mcpPath = path.join(home, '.codeium', 'windsurf', 'mcp_config.json');
  if (fs.existsSync(mcpPath)) {
    const config = readJson(mcpPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeJson(mcpPath, config);
      console.log(`  ✓ Removed kirograph from ${mcpPath}`);
    }
  }

  // Remove rule file
  const rulePath = path.join(projectRoot, '.windsurf', 'rules', WINDSURF_RULES_FILE);
  if (fs.existsSync(rulePath)) {
    fs.unlinkSync(rulePath);
    console.log(`  ✓ Removed .windsurf/rules/${WINDSURF_RULES_FILE}`);
  }

  // Remove legacy .windsurfrules block
  const legacyPath = path.join(projectRoot, '.windsurfrules');
  if (fs.existsSync(legacyPath)) {
    const content = fs.readFileSync(legacyPath, 'utf8');
    if (content.includes('kirograph')) {
      fs.unlinkSync(legacyPath);
      console.log(`  ✓ Removed legacy .windsurfrules`);
    }
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

export function printWindsurfNextSteps(_projectRoot: string): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const mcpPath = path.join(home, '.codeium', 'windsurf', 'mcp_config.json');
  console.log('\n  Done! Restart Windsurf for the MCP server and hooks to load.');
  console.log(`  MCP registered in ${mcpPath}`);
  console.log('  Rule is in .windsurf/rules/kirograph.md');
  console.log('  Auto-sync hook is in .windsurf/hooks.json\n');
}

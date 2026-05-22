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
  writeMcpServersConfig,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const CURSOR_RULES_FILE = 'kirograph.mdc';
const CURSOR_HOOKS_FILE = 'hooks.json';

function buildCursorHooks(enableCompression?: boolean): object {
  const hooks: Record<string, Array<{ command: string }>> = {
    stop: [
      { command: 'kirograph sync --quiet 2>/dev/null || true' },
    ],
  };

  if (enableCompression) {
    hooks.beforeShellExecution = [
      { command: 'kirograph compress-hint 2>/dev/null || true' },
    ];
  }

  return { version: 1, hooks };
}

export function installCursorEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.cursor', 'mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(`  ✓ Cursor MCP server registered in ${mcpPath}`);
}

export function installCursorLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const enableCompression = shellCompressionLevel !== undefined && shellCompressionLevel !== 'off';
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'cursor.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Cursor instructions written to ${instructionsPath}`);

  const rulesDir = path.join(projectRoot, '.cursor', 'rules');
  ensureDir(rulesDir);
  const rulePath = path.join(rulesDir, CURSOR_RULES_FILE);
  const frontmatter = [
    '---',
    'description: KiroGraph semantic code knowledge graph — use graph tools instead of grep/glob',
    'alwaysApply: true',
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(rulePath, frontmatter + buildAgentInstructions(opts));
  console.log(`  ✓ Cursor rule written to ${rulePath}`);

  // Write hooks
  const hooksPath = path.join(projectRoot, '.cursor', CURSOR_HOOKS_FILE);
  const existing = readJson(hooksPath);
  const kirographHooks = buildCursorHooks(enableCompression);
  // Merge: add kirograph hooks without overwriting user's existing hooks
  const merged = { ...existing, ...kirographHooks };
  if (existing.hooks) {
    merged.hooks = { ...existing.hooks };
    const kgHooks = (kirographHooks as any).hooks;
    for (const [event, commands] of Object.entries(kgHooks)) {
      merged.hooks[event] = merged.hooks[event] ?? [];
      // Avoid duplicates
      for (const cmd of commands as Array<{ command: string }>) {
        if (!merged.hooks[event].some((h: any) => h.command === cmd.command)) {
          merged.hooks[event].push(cmd);
        }
      }
    }
  }
  writeJson(hooksPath, merged);
  console.log(`  ✓ Cursor hooks written to ${hooksPath}`);
}

export function uninitCursor(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.cursor', 'mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .cursor/mcp.json`);
  }

  const rulePath = path.join(projectRoot, '.cursor', 'rules', CURSOR_RULES_FILE);
  if (fs.existsSync(rulePath)) {
    fs.unlinkSync(rulePath);
    console.log(`  ✓ Removed .cursor/rules/${CURSOR_RULES_FILE}`);
  }

  // Remove kirograph hooks from hooks.json
  const hooksPath = path.join(projectRoot, '.cursor', CURSOR_HOOKS_FILE);
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
        console.log(`  ✓ Removed kirograph hooks from .cursor/hooks.json`);
      }
    }
  }
}

export function printCursorNextSteps(): void {
  console.log('\n  Done! Restart Cursor for the MCP server and hooks to load.');
  console.log('  The kirograph rule is active in .cursor/rules/kirograph.mdc');
  console.log('  Auto-sync hook runs on task completion.\n');
}

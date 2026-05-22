import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  appendImportLine,
  ensureDir,
  buildInstructionOpts,
  readJson,
  writeJson,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  removeMcpServersConfig,
  removeImportLine,
  writeMcpServersConfig,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const CLAUDE_IMPORT = '@.kirograph/claude.md';

function buildClaudeHooks(): object {
  return {
    hooks: {
      Stop: [
        { type: 'command', command: 'kirograph sync --quiet 2>/dev/null || true' },
      ],
    },
  };
}

export function installClaudeEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(`  ✓ Claude MCP server registered in ${mcpPath}`);
}

export function installClaudeLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'claude.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Claude instructions written to ${instructionsPath}`);

  const memoryPath = path.join(projectRoot, 'CLAUDE.md');
  const changed = appendImportLine(memoryPath, CLAUDE_IMPORT, '## KiroGraph');
  console.log(changed
    ? `  ✓ Claude project memory updated in ${memoryPath}`
    : `  ✓ Claude project memory already imports ${CLAUDE_IMPORT}`);

  // Write hooks to .claude/settings.json
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  ensureDir(path.dirname(settingsPath));
  const settings = readJson(settingsPath);
  const kgHooks = buildClaudeHooks() as any;
  settings.hooks = settings.hooks ?? {};
  for (const [event, commands] of Object.entries(kgHooks.hooks)) {
    settings.hooks[event] = settings.hooks[event] ?? [];
    for (const cmd of commands as Array<{ type: string; command: string }>) {
      if (!settings.hooks[event].some((h: any) => h.command === cmd.command)) {
        settings.hooks[event].push(cmd);
      }
    }
  }
  writeJson(settingsPath, settings);
  console.log(`  ✓ Claude Code hooks written to ${settingsPath}`);
}

export function uninitClaude(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .mcp.json`);
  }

  const memoryPath = path.join(projectRoot, 'CLAUDE.md');
  if (removeImportLine(memoryPath, CLAUDE_IMPORT)) {
    console.log(`  ✓ Removed KiroGraph import from CLAUDE.md`);
  }

  // Remove kirograph hooks from .claude/settings.json
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const settings = readJson(settingsPath);
    if (settings.hooks) {
      let changed = false;
      for (const event of Object.keys(settings.hooks)) {
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter((h: any) => !h.command?.includes('kirograph'));
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
        if (settings.hooks[event]?.length !== before) changed = true;
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      if (changed) {
        writeJson(settingsPath, settings);
        console.log(`  ✓ Removed kirograph hooks from .claude/settings.json`);
      }
    }
  }
}

export function printClaudeNextSteps(): void {
  console.log('\n  Done! Restart Claude Code for the MCP server, hooks, and project memory to load.');
  console.log('  Auto-sync hook runs on session stop.\n');
}

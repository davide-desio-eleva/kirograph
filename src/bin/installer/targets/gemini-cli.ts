/**
 * Gemini CLI target.
 *
 * MCP: .gemini/settings.json (project-level, mcpServers format)
 * Hooks: .gemini/settings.json (hooks section with SessionEnd event)
 * Instructions: GEMINI.md (upsert block)
 *
 * NOTE: This is NOT an alias for Antigravity. Gemini CLI and Antigravity IDE
 * use different config paths and hook formats.
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

const GEMINI_CLI_BLOCK_ID = 'gemini-cli';

export function installGeminiCliEarly(projectRoot: string): void {
  // Write MCP + hooks to .gemini/settings.json
  const settingsPath = path.join(projectRoot, '.gemini', 'settings.json');
  ensureDir(path.dirname(settingsPath));
  const settings = readJson(settingsPath);

  // MCP server
  settings.mcpServers = settings.mcpServers ?? {};
  settings.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };

  writeJson(settingsPath, settings);
  console.log(`  ✓ Gemini CLI MCP server registered in ${settingsPath}`);
}

export function installGeminiCliLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'gemini-cli.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Gemini CLI instructions written to ${instructionsPath}`);

  const geminiPath = path.join(projectRoot, 'GEMINI.md');
  const changed = upsertGeneratedBlock(geminiPath, GEMINI_CLI_BLOCK_ID, '## KiroGraph', buildAgentInstructions(opts));
  console.log(changed
    ? `  ✓ GEMINI.md updated with KiroGraph instructions`
    : `  ✓ GEMINI.md already up to date`);

  // Write hooks to .gemini/settings.json
  const settingsPath = path.join(projectRoot, '.gemini', 'settings.json');
  const settings = readJson(settingsPath);
  settings.hooks = settings.hooks ?? {};
  settings.hooks.SessionEnd = settings.hooks.SessionEnd ?? [];

  const hasKirograph = settings.hooks.SessionEnd.some((m: any) =>
    m.hooks?.some((h: any) => h.command?.includes('kirograph'))
  );
  if (!hasKirograph) {
    settings.hooks.SessionEnd.push({
      hooks: [
        {
          type: 'command',
          command: 'kirograph sync --quiet 2>/dev/null || true',
          timeout: 5000,
        },
      ],
    });
  }

  writeJson(settingsPath, settings);
  console.log(`  ✓ Gemini CLI hooks written to ${settingsPath}`);
}

export function uninitGeminiCli(projectRoot: string): void {
  const settingsPath = path.join(projectRoot, '.gemini', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const settings = readJson(settingsPath);
    let changed = false;

    // Remove MCP
    if (settings.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete settings.mcpServers[KIROGRAPH_SERVER_NAME];
      if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
      changed = true;
      console.log(`  ✓ Removed kirograph from .gemini/settings.json mcpServers`);
    }

    // Remove hooks
    if (settings.hooks?.SessionEnd) {
      const before = settings.hooks.SessionEnd.length;
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter((m: any) =>
        !m.hooks?.some((h: any) => h.command?.includes('kirograph'))
      );
      if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      if (settings.hooks?.SessionEnd?.length !== before) {
        changed = true;
        console.log(`  ✓ Removed kirograph hooks from .gemini/settings.json`);
      }
    }

    if (changed) writeJson(settingsPath, settings);
  }

  const geminiPath = path.join(projectRoot, 'GEMINI.md');
  if (removeGeneratedBlock(geminiPath, GEMINI_CLI_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from GEMINI.md`);
  }
}

export function printGeminiCliNextSteps(): void {
  console.log('\n  Done! Restart Gemini CLI for the MCP server and hooks to load.');
  console.log('  MCP and hooks are in .gemini/settings.json');
  console.log('  KiroGraph instructions are in GEMINI.md\n');
}

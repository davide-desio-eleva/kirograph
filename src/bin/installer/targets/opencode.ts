/**
 * OpenCode target.
 *
 * MCP: .opencode.json (mcp field with type: "local")
 * Hooks: .opencode/plugins/kirograph-sync.js (JS plugin)
 * Instructions: .opencode.json (instructions field)
 */

import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import { ensureDir, buildInstructionOpts, readJson, writeJson } from '../common';
import { buildAgentInstructions } from '../instructions';

const OPENCODE_CONFIG = '.opencode.json';
const OPENCODE_MCP_NAME = 'kirograph';
const OPENCODE_INSTRUCTIONS_PATH = '.kirograph/opencode.md';
const OPENCODE_PLUGIN_FILE = 'kirograph-sync.js';

const OPENCODE_PLUGIN_CONTENT = `/**
 * KiroGraph auto-sync plugin for OpenCode.
 * Syncs the KiroGraph index when the agent session goes idle.
 */
export const KirographSync = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await $\`kirograph sync --quiet 2>/dev/null || true\`
      }
    },
  }
}
`;

export function installOpenCodeEarly(projectRoot: string): void {
  const configPath = path.join(projectRoot, OPENCODE_CONFIG);
  const config = readJson(configPath);

  config.mcp = config.mcp ?? {};
  config.mcp[OPENCODE_MCP_NAME] = {
    type: 'local',
    command: ['kirograph', 'serve', '--mcp'],
    enabled: true,
  };

  if (!config.$schema) {
    config.$schema = 'https://opencode.ai/config.json';
  }

  writeJson(configPath, config);
  console.log(`  ✓ OpenCode MCP server registered in ${configPath}`);
}

export function installOpenCodeLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'opencode.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ OpenCode instructions written to ${instructionsPath}`);

  // Add instructions reference to .opencode.json
  const configPath = path.join(projectRoot, OPENCODE_CONFIG);
  const config = readJson(configPath);

  const instructions: string[] = config.instructions ?? [];
  if (!instructions.includes(OPENCODE_INSTRUCTIONS_PATH)) {
    instructions.push(OPENCODE_INSTRUCTIONS_PATH);
  }
  config.instructions = instructions;
  writeJson(configPath, config);
  console.log(`  ✓ OpenCode instructions referenced in ${configPath}`);

  // Write sync plugin
  const pluginsDir = path.join(projectRoot, '.opencode', 'plugins');
  ensureDir(pluginsDir);
  const pluginPath = path.join(pluginsDir, OPENCODE_PLUGIN_FILE);
  fs.writeFileSync(pluginPath, OPENCODE_PLUGIN_CONTENT);
  console.log(`  ✓ OpenCode sync plugin written to ${pluginPath}`);
}

export function uninitOpenCode(projectRoot: string): void {
  const configPath = path.join(projectRoot, OPENCODE_CONFIG);
  if (fs.existsSync(configPath)) {
    const config = readJson(configPath);
    let changed = false;

    // Remove MCP entry
    if (config.mcp?.[OPENCODE_MCP_NAME]) {
      delete config.mcp[OPENCODE_MCP_NAME];
      if (Object.keys(config.mcp).length === 0) delete config.mcp;
      changed = true;
      console.log(`  ✓ Removed kirograph from .opencode.json mcp`);
    }

    // Remove instructions reference
    if (Array.isArray(config.instructions)) {
      const idx = config.instructions.indexOf(OPENCODE_INSTRUCTIONS_PATH);
      if (idx !== -1) {
        config.instructions.splice(idx, 1);
        if (config.instructions.length === 0) delete config.instructions;
        changed = true;
        console.log(`  ✓ Removed kirograph instructions from .opencode.json`);
      }
    }

    if (changed) writeJson(configPath, config);
  }

  // Remove plugin
  const pluginPath = path.join(projectRoot, '.opencode', 'plugins', OPENCODE_PLUGIN_FILE);
  if (fs.existsSync(pluginPath)) {
    fs.unlinkSync(pluginPath);
    console.log(`  ✓ Removed OpenCode sync plugin`);
  }
}

export function printOpenCodeNextSteps(): void {
  console.log('\n  Done! Restart OpenCode for the MCP server and sync plugin to load.');
  console.log('  MCP and instructions are in .opencode.json');
  console.log('  Auto-sync plugin is in .opencode/plugins/kirograph-sync.js\n');
}

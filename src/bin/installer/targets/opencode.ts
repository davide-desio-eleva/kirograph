import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import { ensureDir, readJson, writeJson } from '../common';
import { buildAgentInstructions } from '../instructions';
import { buildInstructionOpts } from '../common';

const OPENCODE_CONFIG = '.opencode.json';
const OPENCODE_MCP_NAME = 'kirograph';
const OPENCODE_INSTRUCTIONS_PATH = '.kirograph/opencode.md';

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
  const instructionsPath = path.join(projectRoot, '.kirograph', 'opencode.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
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
}

export function uninitOpenCode(projectRoot: string): void {
  const configPath = path.join(projectRoot, OPENCODE_CONFIG);
  if (!fs.existsSync(configPath)) return;

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

  if (changed) {
    writeJson(configPath, config);
  }
}

export function printOpenCodeNextSteps(): void {
  console.log('\n  Done! Restart OpenCode for the MCP server to load.');
  console.log('  Instructions are referenced from .opencode.json\n');
}

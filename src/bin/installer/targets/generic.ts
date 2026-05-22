/**
 * Generic print-only targets.
 * These tools don't have a well-known project-level MCP config path,
 * so we write .kirograph/<target>.md and print setup instructions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import { ensureDir, buildInstructionOpts } from '../common';
import { buildAgentInstructions } from '../instructions';

export interface GenericTargetConfig {
  id: string;
  label: string;
  mcpHint: string; // instructions printed to user
}

export function makeGenericInstaller(config: GenericTargetConfig) {
  function installEarly(_projectRoot: string): void {
    // No project-level MCP config for these targets.
  }

  function installLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
    const instructionsPath = path.join(projectRoot, '.kirograph', `${config.id}.md`);
    ensureDir(path.dirname(instructionsPath));
    fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
    console.log(`  ✓ ${config.label} instructions written to ${instructionsPath}`);
  }

  function uninit(projectRoot: string): void {
    const instructionsPath = path.join(projectRoot, '.kirograph', `${config.id}.md`);
    if (fs.existsSync(instructionsPath)) {
      fs.unlinkSync(instructionsPath);
      console.log(`  ✓ Removed .kirograph/${config.id}.md`);
    }
  }

  function printNextSteps(projectRoot: string): void {
    const escapedPath = projectRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    console.log(`\n  Done! ${config.label} instructions written to .kirograph/${config.id}.md`);
    console.log('  Configure the MCP server manually:');
    console.log(`    ${config.mcpHint.replace('{{path}}', escapedPath)}\n`);
  }

  return { installEarly, installLate, uninit, printNextSteps };
}

// ── Target definitions ───────────────────────────────────────────────────────

export const mistralVibe = makeGenericInstaller({
  id: 'mistral-vibe',
  label: 'Mistral Vibe',
  mcpHint: 'Add kirograph to your Mistral Vibe MCP settings:\n    Command: kirograph serve --mcp --path "{{path}}"',
});

export const ibmBob = makeGenericInstaller({
  id: 'ibm-bob',
  label: 'IBM Bob',
  mcpHint: 'Add kirograph to your IBM Bob MCP configuration:\n    Command: kirograph serve --mcp --path "{{path}}"',
});

export const crush = makeGenericInstaller({
  id: 'crush',
  label: 'Crush',
  mcpHint: 'Add kirograph to your Crush MCP configuration:\n    Command: kirograph serve --mcp --path "{{path}}"',
});

export const droidFactory = makeGenericInstaller({
  id: 'droid-factory',
  label: 'Droid Factory',
  mcpHint: 'Add kirograph to your Droid Factory MCP configuration:\n    Command: kirograph serve --mcp --path "{{path}}"',
});

export const forgeCode = makeGenericInstaller({
  id: 'forgecode',
  label: 'ForgeCode',
  mcpHint: 'Add kirograph to your ForgeCode MCP configuration:\n    Command: kirograph serve --mcp --path "{{path}}"',
});

export const iflowCli = makeGenericInstaller({
  id: 'iflow',
  label: 'iFlow CLI',
  mcpHint: 'Add kirograph to your iFlow MCP configuration:\n    Command: kirograph serve --mcp --path "{{path}}"',
});

export const qwenCode = makeGenericInstaller({
  id: 'qwen',
  label: 'Qwen Code',
  mcpHint: 'Add kirograph to your Qwen Code MCP configuration:\n    Command: kirograph serve --mcp --path "{{path}}"',
});

export const rovoDev = makeGenericInstaller({
  id: 'rovo',
  label: 'Atlassian Rovo Dev',
  mcpHint: 'Add kirograph to your Rovo Dev MCP configuration:\n    Command: kirograph serve --mcp --path "{{path}}"',
});

export const qoder = makeGenericInstaller({
  id: 'qoder',
  label: 'Qoder',
  mcpHint: 'Add kirograph to your Qoder MCP configuration:\n    Command: kirograph serve --mcp --path "{{path}}"',
});

/**
 * Generic print-only targets.
 * These tools don't have a well-known project-level MCP config path,
 * so we write .kirograph/<target>.md and print setup instructions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import { ensureDir, buildInstructionOpts, printMcpCommand } from '../common';
import { buildAgentInstructions } from '../instructions';

export interface GenericTargetConfig {
  id: string;
  label: string;
}

export function makeGenericInstaller(config: GenericTargetConfig) {
  function installEarly(_projectRoot: string): void {
    // No project-level MCP config for these targets.
  }

  function installLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
    const instructionsPath = path.join(projectRoot, '.kirograph', `${config.id}.md`);
    ensureDir(path.dirname(instructionsPath));
    fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
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
    printMcpCommand(`kirograph serve --mcp --path "${escapedPath}"`);
  }

  return { installEarly, installLate, uninit, printNextSteps };
}

// ── Target definitions ───────────────────────────────────────────────────────

export const mistralVibe = makeGenericInstaller({
  id: 'mistral-vibe',
  label: 'Mistral Vibe',
});

export const ibmBob = makeGenericInstaller({
  id: 'ibm-bob',
  label: 'IBM Bob',
});

export const crush = makeGenericInstaller({
  id: 'crush',
  label: 'Crush',
});

export const droidFactory = makeGenericInstaller({
  id: 'droid-factory',
  label: 'Droid Factory',
});

export const forgeCode = makeGenericInstaller({
  id: 'forgecode',
  label: 'ForgeCode',
});

export const iflowCli = makeGenericInstaller({
  id: 'iflow',
  label: 'iFlow CLI',
});

export const rovoDev = makeGenericInstaller({
  id: 'rovo',
  label: 'Atlassian Rovo Dev',
});

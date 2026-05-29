/**
 * Continue target.
 *
 * MCP: .continue/mcpServers/kirograph.json (project-level, JSON format)
 * Rules: .continue/rules/kirograph.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  buildInstructionOpts,
  writeJson,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const MCP_FILE = 'kirograph.json';
const RULES_FILE = 'kirograph.md';

export function installContinueEarly(projectRoot: string): void {
  // Write MCP config as a JSON file in .continue/mcpServers/
  const mcpDir = path.join(projectRoot, '.continue', 'mcpServers');
  ensureDir(mcpDir);
  const mcpPath = path.join(mcpDir, MCP_FILE);
  const config = {
    mcpServers: {
      kirograph: {
        command: KIROGRAPH_COMMAND,
        args: KIROGRAPH_MCP_ARGS,
      },
    },
  };
  writeJson(mcpPath, config);
  console.log(`  ✓ Continue MCP server registered in ${mcpPath}`);
}

export function installContinueLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'continue.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Continue instructions written to ${instructionsPath}`);

  // Write rules file in .continue/rules/
  const rulesDir = path.join(projectRoot, '.continue', 'rules');
  ensureDir(rulesDir);
  const rulePath = path.join(rulesDir, RULES_FILE);
  fs.writeFileSync(rulePath, buildAgentInstructions(opts));
  console.log(`  ✓ Continue rule written to ${rulePath}`);
}

export function uninitContinue(projectRoot: string): void {
  // Remove MCP file
  const mcpPath = path.join(projectRoot, '.continue', 'mcpServers', MCP_FILE);
  if (fs.existsSync(mcpPath)) {
    fs.unlinkSync(mcpPath);
    console.log(`  ✓ Removed .continue/mcpServers/${MCP_FILE}`);
  }

  // Remove rule file
  const rulePath = path.join(projectRoot, '.continue', 'rules', RULES_FILE);
  if (fs.existsSync(rulePath)) {
    fs.unlinkSync(rulePath);
    console.log(`  ✓ Removed .continue/rules/${RULES_FILE}`);
  }

  // Remove legacy config.json entry if it exists
  const legacyPath = path.join(projectRoot, '.continue', 'config.json');
  if (fs.existsSync(legacyPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      if (config.mcpServers?.kirograph) {
        delete config.mcpServers.kirograph;
        if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
        fs.writeFileSync(legacyPath, JSON.stringify(config, null, 2) + '\n');
        console.log(`  ✓ Removed legacy kirograph from .continue/config.json`);
      }
    } catch {}
  }
}

export function printContinueNextSteps(): void {
  console.log('\n  Done! Restart Continue for the MCP server to load.');
  console.log('  MCP is in .continue/mcpServers/kirograph.json');
  console.log('  KiroGraph rule is in .continue/rules/kirograph.md\n');
}

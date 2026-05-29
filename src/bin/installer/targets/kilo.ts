/**
 * Kilo Code target.
 *
 * MCP: kilo.json or .kilo/kilo.json (project-level, "mcp" key with type: "local")
 * Rules: .kilo/rules/kirograph.md + referenced in kilo.jsonc "instructions" array
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
} from '../common';
import { buildAgentInstructions } from '../instructions';

const KILO_MCP_NAME = 'kirograph';
const KILO_RULES_FILE = '.kilo/rules/kirograph.md';

export function installKiloEarly(projectRoot: string): void {
  // Write MCP to kilo.json (project-level)
  const configPath = path.join(projectRoot, 'kilo.json');
  const config = readJson(configPath);
  config.mcp = config.mcp ?? {};
  config.mcp[KILO_MCP_NAME] = {
    type: 'local',
    command: [KIROGRAPH_COMMAND, ...KIROGRAPH_MCP_ARGS],
    enabled: true,
  };
  writeJson(configPath, config);
  console.log(`  ✓ Kilo Code MCP server registered in ${configPath}`);
}

export function installKiloLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'kilo.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Kilo Code instructions written to ${instructionsPath}`);

  // Write rules file inside .kilo/rules/
  const rulesDir = path.join(projectRoot, '.kilo', 'rules');
  ensureDir(rulesDir);
  const rulePath = path.join(rulesDir, 'kirograph.md');
  fs.writeFileSync(rulePath, buildAgentInstructions(opts));
  console.log(`  ✓ Kilo Code rule written to ${rulePath}`);

  // Add to instructions array in kilo.jsonc (or kilo.json)
  const jsoncPath = path.join(projectRoot, 'kilo.jsonc');
  const jsonPath = path.join(projectRoot, 'kilo.json');
  const cfgPath = fs.existsSync(jsoncPath) ? jsoncPath : jsonPath;
  const cfg = readJson(cfgPath);
  const instructions: string[] = cfg.instructions ?? [];
  if (!instructions.includes(KILO_RULES_FILE)) {
    instructions.push(KILO_RULES_FILE);
  }
  cfg.instructions = instructions;
  writeJson(cfgPath, cfg);
  console.log(`  ✓ Kilo Code instructions referenced in ${cfgPath}`);
}

export function uninitKilo(projectRoot: string): void {
  // Remove MCP entry
  const configPath = path.join(projectRoot, 'kilo.json');
  if (fs.existsSync(configPath)) {
    const config = readJson(configPath);
    if (config.mcp?.[KILO_MCP_NAME]) {
      delete config.mcp[KILO_MCP_NAME];
      if (Object.keys(config.mcp).length === 0) delete config.mcp;
      writeJson(configPath, config);
      console.log(`  ✓ Removed kirograph from kilo.json mcp`);
    }
  }

  // Remove instructions reference
  const jsoncPath = path.join(projectRoot, 'kilo.jsonc');
  const jsonPath = path.join(projectRoot, 'kilo.json');
  const cfgPath = fs.existsSync(jsoncPath) ? jsoncPath : jsonPath;
  if (fs.existsSync(cfgPath)) {
    const cfg = readJson(cfgPath);
    if (Array.isArray(cfg.instructions)) {
      const idx = cfg.instructions.indexOf(KILO_RULES_FILE);
      if (idx !== -1) {
        cfg.instructions.splice(idx, 1);
        if (cfg.instructions.length === 0) delete cfg.instructions;
        writeJson(cfgPath, cfg);
        console.log(`  ✓ Removed kirograph instructions from ${cfgPath}`);
      }
    }
  }

  // Remove rule file
  const rulePath = path.join(projectRoot, '.kilo', 'rules', 'kirograph.md');
  if (fs.existsSync(rulePath)) {
    fs.unlinkSync(rulePath);
    console.log(`  ✓ Removed .kilo/rules/kirograph.md`);
  }
}

export function printKiloNextSteps(): void {
  console.log('\n  Done! Restart Kilo Code for the MCP server to load.');
  console.log('  MCP is in kilo.json');
  console.log('  KiroGraph rule is in .kilo/rules/kirograph.md\n');
}

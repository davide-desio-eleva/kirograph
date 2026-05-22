import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  KIROGRAPH_SERVER_NAME,
  readJson,
  writeJson,
} from '../common';
import { buildAgentInstructions } from '../instructions';
import { buildInstructionOpts } from '../common';

export function installContinueEarly(projectRoot: string): void {
  const configPath = path.join(projectRoot, '.continue', 'config.json');
  ensureDir(path.dirname(configPath));
  const config = readJson(configPath);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };
  writeJson(configPath, config);
  console.log(`  ✓ Continue MCP server registered in ${configPath}`);
}

export function installContinueLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'continue.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Continue instructions written to ${instructionsPath}`);

  const rulesDir = path.join(projectRoot, '.continue', 'rules');
  ensureDir(rulesDir);
  const rulePath = path.join(rulesDir, 'kirograph.md');
  fs.writeFileSync(rulePath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory)));
  console.log(`  ✓ Continue rule written to ${rulePath}`);
}

export function uninitContinue(projectRoot: string): void {
  const configPath = path.join(projectRoot, '.continue', 'config.json');
  if (fs.existsSync(configPath)) {
    const config = readJson(configPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      writeJson(configPath, config);
      console.log(`  ✓ Removed kirograph from .continue/config.json`);
    }
  }

  const rulePath = path.join(projectRoot, '.continue', 'rules', 'kirograph.md');
  if (fs.existsSync(rulePath)) {
    fs.unlinkSync(rulePath);
    console.log(`  ✓ Removed .continue/rules/kirograph.md`);
  }
}

export function printContinueNextSteps(): void {
  console.log('\n  Done! Restart Continue for the MCP server to load.');
  console.log('  KiroGraph rule is in .continue/rules/kirograph.md\n');
}

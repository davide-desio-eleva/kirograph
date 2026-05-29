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

export function installAmpEarly(projectRoot: string): void {
  const configPath = path.join(projectRoot, '.amp', 'config.json');
  ensureDir(path.dirname(configPath));
  const config = readJson(configPath);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  };
  writeJson(configPath, config);
  console.log(`  ✓ Sourcegraph Amp MCP server registered in ${configPath}`);
}

export function installAmpLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'amp.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(`  ✓ Amp instructions written to ${instructionsPath}`);

  const ampInstructionsPath = path.join(projectRoot, '.amp', 'instructions.md');
  ensureDir(path.dirname(ampInstructionsPath));
  fs.writeFileSync(ampInstructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(`  ✓ Amp instructions written to ${ampInstructionsPath}`);
}

export function uninitAmp(projectRoot: string): void {
  const configPath = path.join(projectRoot, '.amp', 'config.json');
  if (fs.existsSync(configPath)) {
    const config = readJson(configPath);
    if (config.mcpServers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.mcpServers[KIROGRAPH_SERVER_NAME];
      writeJson(configPath, config);
      console.log(`  ✓ Removed kirograph from .amp/config.json`);
    }
  }

  const ampInstructionsPath = path.join(projectRoot, '.amp', 'instructions.md');
  if (fs.existsSync(ampInstructionsPath)) {
    fs.unlinkSync(ampInstructionsPath);
    console.log(`  ✓ Removed .amp/instructions.md`);
  }
}

export function printAmpNextSteps(): void {
  console.log('\n  Done! Restart Sourcegraph Amp for the MCP server to load.');
  console.log('  KiroGraph instructions are in .amp/instructions.md\n');
}

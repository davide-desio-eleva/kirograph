import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  removeMcpServersConfig,
  writeMcpServersConfig,
} from '../common';
import { buildAgentInstructions } from '../instructions';
import { buildInstructionOpts } from '../common';

export function installTabnineEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.tabnine', 'mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(`  ✓ Tabnine MCP server registered in ${mcpPath}`);
}

export function installTabnineLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'tabnine.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(`  ✓ Tabnine instructions written to ${instructionsPath}`);

  const rulesPath = path.join(projectRoot, '.tabnine', 'instructions.md');
  ensureDir(path.dirname(rulesPath));
  fs.writeFileSync(rulesPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(`  ✓ Tabnine instructions written to ${rulesPath}`);
}

export function uninitTabnine(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.tabnine', 'mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .tabnine/mcp.json`);
  }

  const rulesPath = path.join(projectRoot, '.tabnine', 'instructions.md');
  if (fs.existsSync(rulesPath)) {
    fs.unlinkSync(rulesPath);
    console.log(`  ✓ Removed .tabnine/instructions.md`);
  }
}

export function printTabnineNextSteps(): void {
  console.log('\n  Done! Restart Tabnine for the MCP server to load.');
  console.log('  KiroGraph instructions are in .tabnine/instructions.md\n');
}

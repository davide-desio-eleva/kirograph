import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  printMcpCommand,
  upsertGeneratedBlock,
  removeGeneratedBlock,
} from '../common';
import { buildAgentInstructions } from '../instructions';
import { buildInstructionOpts } from '../common';

const GOOSE_BLOCK_ID = 'goose';

export function installGooseEarly(_projectRoot: string): void {
  // Block Goose MCP is configured via `goose mcp add` command.
  // We print the command in next steps.
}

export function installGooseLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'goose.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(`  ✓ Goose instructions written to ${instructionsPath}`);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const changed = upsertGeneratedBlock(agentsPath, GOOSE_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(changed
    ? `  ✓ AGENTS.md updated with KiroGraph instructions (Goose)`
    : `  ✓ AGENTS.md already up to date`);
}

export function uninitGoose(projectRoot: string): void {
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (removeGeneratedBlock(agentsPath, GOOSE_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from AGENTS.md (Goose)`);
  }
}

export function printGooseNextSteps(projectRoot: string): void {
  const escapedPath = projectRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  console.log('\n  Done! KiroGraph instructions are in AGENTS.md.');
  printMcpCommand(`goose mcp add kirograph -- kirograph serve --mcp --path "${escapedPath}"`);
}

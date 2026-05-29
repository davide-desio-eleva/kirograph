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

const REPLIT_BLOCK_ID = 'replit';

export function installReplitEarly(_projectRoot: string): void {
  // Replit MCP is configured through the Replit UI or .replit file.
  // We print instructions in next steps.
}

export function installReplitLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'replit.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(`  ✓ Replit instructions written to ${instructionsPath}`);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const changed = upsertGeneratedBlock(agentsPath, REPLIT_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(changed
    ? `  ✓ AGENTS.md updated with KiroGraph instructions (Replit)`
    : `  ✓ AGENTS.md already up to date`);
}

export function uninitReplit(projectRoot: string): void {
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (removeGeneratedBlock(agentsPath, REPLIT_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from AGENTS.md (Replit)`);
  }
}

export function printReplitNextSteps(projectRoot: string): void {
  console.log('\n  Done! KiroGraph instructions are in AGENTS.md.');
  printMcpCommand(`kirograph serve --mcp --path "${projectRoot}"`);
  console.log('  Configure this command in your Replit workspace MCP settings.');
}

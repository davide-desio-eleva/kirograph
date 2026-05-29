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

const AIDER_BLOCK_ID = 'aider';

export function installAiderEarly(_projectRoot: string): void {
  // Aider MCP is configured via CLI flags (--mcp) or .aider.conf.yml.
  // We print the setup command in next steps instead of writing outside the project.
}

export function installAiderLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'aider.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(`  ✓ Aider instructions written to ${instructionsPath}`);

  const conventionsPath = path.join(projectRoot, 'CONVENTIONS.md');
  const changed = upsertGeneratedBlock(conventionsPath, AIDER_BLOCK_ID, '## KiroGraph', buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(changed
    ? `  ✓ CONVENTIONS.md updated with KiroGraph instructions`
    : `  ✓ CONVENTIONS.md already up to date`);
}

export function uninitAider(projectRoot: string): void {
  const conventionsPath = path.join(projectRoot, 'CONVENTIONS.md');
  if (removeGeneratedBlock(conventionsPath, AIDER_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from CONVENTIONS.md`);
  }
}

export function printAiderNextSteps(projectRoot: string): void {
  const escapedPath = projectRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  console.log('\n  Done! KiroGraph instructions are in CONVENTIONS.md.');
  printMcpCommand(`aider --mcp "kirograph serve --mcp --path ${escapedPath}"`);
}

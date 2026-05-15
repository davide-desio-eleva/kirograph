import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import { ensureDir, removeGeneratedBlock, upsertGeneratedBlock } from '../common';
import { buildAgentInstructions } from '../instructions';

const CODEX_BLOCK_ID = 'codex';

export function installCodexEarly(_projectRoot: string): void {
  // Codex MCP config is user-scoped. We print the exact config in next steps
  // instead of writing outside the project from an installer command.
}

export function installCodexLate(projectRoot: string, cavemanMode?: CavemanMode | 'off'): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'codex.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(cavemanMode));
  console.log(`  ✓ Codex instructions written to ${instructionsPath}`);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const changed = upsertGeneratedBlock(agentsPath, CODEX_BLOCK_ID, '## KiroGraph', buildAgentInstructions(cavemanMode));
  console.log(changed
    ? `  ✓ Codex project instructions updated in ${agentsPath}`
    : `  ✓ Codex project instructions already up to date`);
}

export function uninitCodex(projectRoot: string): void {
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (removeGeneratedBlock(agentsPath, CODEX_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from AGENTS.md`);
  }
}

export function printCodexNextSteps(projectRoot: string): void {
  const escapedPath = projectRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  console.log('\n  Done! Codex project instructions are installed.');
  console.log('  Add the MCP server to Codex with:');
  console.log(`    codex mcp add kirograph -- kirograph serve --mcp --path "${escapedPath}"`);
  console.log('\n  Or add this to ~/.codex/config.toml:');
  console.log('    [mcp_servers.kirograph]');
  console.log('    command = "kirograph"');
  console.log(`    args = ["serve", "--mcp", "--path", "${escapedPath}"]\n`);
}

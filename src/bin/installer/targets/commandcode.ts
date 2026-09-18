/**
 * Command Code CLI target.
 *
 * Command Code (`cmd`, installed via `npm i -g command-code`) discovers MCP
 * servers from a project-scoped `.mcp.json` at the project root and reads
 * custom instructions from `AGENTS.md` (same conventions used by Codex/OpenCode).
 *
 * MCP:          .mcp.json (mcpServers, project scope — committed to VCS)
 * Instructions: .kirograph/commandcode.md + a generated block in AGENTS.md
 *
 * Command Code has no project-level hook system comparable to Claude/Codex, so
 * no auto-sync hook is written; sync is available on demand via the MCP tools.
 *
 * Docs: https://commandcode.ai/docs/mcp
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ensureDir,
  buildInstructionOpts,
  writeJson,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  removeMcpServersConfig,
  writeMcpServersConfig,
  upsertGeneratedBlock,
  removeGeneratedBlock,
  printMcpCommand,
  LateInstallOptions,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const COMMANDCODE_BLOCK_ID = 'commandcode';

export function installCommandCodeEarly(projectRoot: string): void {
  // Command Code project scope stores MCP servers in .mcp.json at the project root.
  const mcpPath = path.join(projectRoot, '.mcp.json');
  const written = writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(written
    ? `  ✓ Command Code MCP server registered in ${mcpPath}`
    : `  ✓ Command Code MCP already configured in ${mcpPath}`);
}

export function installCommandCodeLate(projectRoot: string, opts: LateInstallOptions): void {
  const resolvedOpts = buildInstructionOpts(opts, false);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'commandcode.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(resolvedOpts));
  console.log(`  ✓ Command Code instructions written to ${instructionsPath}`);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const changed = upsertGeneratedBlock(agentsPath, COMMANDCODE_BLOCK_ID, '## KiroGraph', buildAgentInstructions(resolvedOpts));
  console.log(changed
    ? `  ✓ Command Code project instructions updated in ${agentsPath}`
    : `  ✓ Command Code project instructions already up to date`);
}

export function uninitCommandCode(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .mcp.json`);
  }

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (removeGeneratedBlock(agentsPath, COMMANDCODE_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from AGENTS.md`);
  }
}

export function printCommandCodeNextSteps(projectRoot: string): void {
  const escapedPath = projectRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  console.log('\n  Done! Command Code project instructions and MCP server are installed.');
  console.log('  Command Code auto-discovers the server from .mcp.json (project scope).');
  console.log('  If it does not appear, add it explicitly:');
  printMcpCommand(`cmd mcp add kirograph -- kirograph serve --mcp --path "${escapedPath}"`);
}

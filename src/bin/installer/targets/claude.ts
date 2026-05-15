import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  appendImportLine,
  ensureDir,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  removeMcpServersConfig,
  removeImportLine,
  writeMcpServersConfig,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const CLAUDE_IMPORT = '@.kirograph/claude.md';

export function installClaudeEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(`  ✓ Claude MCP server registered in ${mcpPath}`);
}

export function installClaudeLate(projectRoot: string, cavemanMode?: CavemanMode | 'off'): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'claude.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(cavemanMode));
  console.log(`  ✓ Claude instructions written to ${instructionsPath}`);

  const memoryPath = path.join(projectRoot, 'CLAUDE.md');
  const changed = appendImportLine(memoryPath, CLAUDE_IMPORT, '## KiroGraph');
  console.log(changed
    ? `  ✓ Claude project memory updated in ${memoryPath}`
    : `  ✓ Claude project memory already imports ${CLAUDE_IMPORT}`);
}

export function uninitClaude(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .mcp.json`);
  }

  const memoryPath = path.join(projectRoot, 'CLAUDE.md');
  if (removeImportLine(memoryPath, CLAUDE_IMPORT)) {
    console.log(`  ✓ Removed KiroGraph import from CLAUDE.md`);
  }
}

export function printClaudeNextSteps(): void {
  console.log('\n  Done! Restart Claude Code for the MCP server and project memory to load.\n');
}

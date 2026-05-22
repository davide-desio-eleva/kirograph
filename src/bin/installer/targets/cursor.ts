import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  buildInstructionOpts,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  removeMcpServersConfig,
  writeMcpServersConfig,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const CURSOR_RULES_FILE = 'kirograph.mdc';

export function installCursorEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.cursor', 'mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(`  ✓ Cursor MCP server registered in ${mcpPath}`);
}

export function installCursorLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'cursor.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Cursor instructions written to ${instructionsPath}`);

  const rulesDir = path.join(projectRoot, '.cursor', 'rules');
  ensureDir(rulesDir);
  const rulePath = path.join(rulesDir, CURSOR_RULES_FILE);
  const frontmatter = [
    '---',
    'description: KiroGraph semantic code knowledge graph — use graph tools instead of grep/glob',
    'alwaysApply: true',
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(rulePath, frontmatter + buildAgentInstructions(opts));
  console.log(`  ✓ Cursor rule written to ${rulePath}`);
}

export function uninitCursor(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.cursor', 'mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .cursor/mcp.json`);
  }

  const rulePath = path.join(projectRoot, '.cursor', 'rules', CURSOR_RULES_FILE);
  if (fs.existsSync(rulePath)) {
    fs.unlinkSync(rulePath);
    console.log(`  ✓ Removed .cursor/rules/${CURSOR_RULES_FILE}`);
  }
}

export function printCursorNextSteps(): void {
  console.log('\n  Done! Restart Cursor for the MCP server to load.');
  console.log('  The kirograph rule is active in .cursor/rules/kirograph.mdc\n');
}

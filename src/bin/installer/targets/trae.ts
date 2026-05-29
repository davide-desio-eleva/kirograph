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

export function installTraeEarly(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.trae', 'mcp.json');
  const written = writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(written
    ? `  ✓ Trae MCP server registered in ${mcpPath}`
    : `  ✓ Trae MCP already configured in ${mcpPath}`);
}

export function installTraeLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const instructionsPath = path.join(projectRoot, '.kirograph', 'trae.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(`  ✓ Trae instructions written to ${instructionsPath}`);

  const rulesDir = path.join(projectRoot, '.trae', 'rules');
  ensureDir(rulesDir);
  const rulePath = path.join(rulesDir, 'kirograph.md');
  const frontmatter = '---\nalwaysApply: true\n---\n\n';
  fs.writeFileSync(rulePath, frontmatter + buildAgentInstructions(buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, undefined, enableDocs, enableData, enableSecurity, enableArchitecture)));
  console.log(`  ✓ Trae rule written to ${rulePath}`);
}

export function uninitTrae(projectRoot: string): void {
  const mcpPath = path.join(projectRoot, '.trae', 'mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .trae/mcp.json`);
  }

  const rulePath = path.join(projectRoot, '.trae', 'rules', 'kirograph.md');
  if (fs.existsSync(rulePath)) {
    fs.unlinkSync(rulePath);
    console.log(`  ✓ Removed .trae/rules/kirograph.md`);
  }
}

export function printTraeNextSteps(): void {
  console.log('\n  Done! Restart Trae for the MCP server to load.');
  console.log('  KiroGraph rule is in .trae/rules/kirograph.md\n');
}

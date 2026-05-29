import * as fs from 'fs';
import * as path from 'path';
import { KIROGRAPH_TOOL_NAMES } from '../../mcp/tool-names';
import type { InstructionOptions } from './instructions';
import type { CavemanMode } from './caveman';

export type InstallTarget = 'kiro' | 'claude' | 'codex' | 'cursor' | 'antigravity' | 'opencode' | 'windsurf' | 'cline' | 'copilot' | 'copilot-cli' | 'junie' | 'gemini-cli' | 'continue' | 'roo' | 'warp' | 'aider' | 'trae' | 'augment' | 'kilo' | 'amp' | 'devin' | 'replit' | 'goose' | 'openhands' | 'tabnine' | 'mistral-vibe' | 'ibm-bob' | 'crush' | 'droid-factory' | 'forgecode' | 'iflow' | 'qwen' | 'rovo' | 'qoder';

export const KIROGRAPH_SERVER_NAME = 'kirograph';
export const KIROGRAPH_COMMAND = 'kirograph';
export const KIROGRAPH_MCP_ARGS = ['serve', '--mcp'];
export const KIROGRAPH_SYNC_CMD = 'kirograph sync-if-dirty --quiet 2>/dev/null || true';
export const KIROGRAPH_TOOLS = KIROGRAPH_TOOL_NAMES;
export const KIROGRAPH_SCOPED_TOOLS = KIROGRAPH_TOOL_NAMES.map(name => `@kirograph/${name}`);

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function readJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

export function writeJson(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Write MCP server config to a JSON file under the mcpServers key.
 * Returns true if the config was written, false if already configured (idempotent).
 */
export function writeMcpServersConfig(configPath: string, serverConfig: object): boolean {
  ensureDir(path.dirname(configPath));
  const existing = readJson(configPath);
  existing.mcpServers = existing.mcpServers ?? {};
  if (existing.mcpServers[KIROGRAPH_SERVER_NAME]) {
    return false; // Already configured
  }
  existing.mcpServers[KIROGRAPH_SERVER_NAME] = serverConfig;
  writeJson(configPath, existing);
  return true;
}

export function removeMcpServersConfig(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  const existing = readJson(configPath);
  if (!existing.mcpServers?.[KIROGRAPH_SERVER_NAME]) return false;
  delete existing.mcpServers[KIROGRAPH_SERVER_NAME];
  writeJson(configPath, existing);
  return true;
}

export function appendImportLine(filePath: string, line: string, heading: string): boolean {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (existing.includes(line)) return false;

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const separator = existing.trim().length > 0 ? '\n' : '';
  fs.writeFileSync(filePath, existing + prefix + separator + heading + '\n' + line + '\n');
  return true;
}

export function removeImportLine(filePath: string, line: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const original = fs.readFileSync(filePath, 'utf8');
  const next = original
    .split('\n')
    .filter(l => l.trim() !== line)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  if (next === original) return false;
  fs.writeFileSync(filePath, next.endsWith('\n') ? next : next + '\n');
  return true;
}

export function upsertGeneratedBlock(filePath: string, blockId: string, heading: string, content: string): boolean {
  const start = `<!-- kirograph:${blockId}:start -->`;
  const end = `<!-- kirograph:${blockId}:end -->`;
  const block = `${start}\n${heading}\n\n${content.trim()}\n${end}`;
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);

  if (pattern.test(existing)) {
    const next = existing.replace(pattern, block);
    if (next === existing) return false;
    fs.writeFileSync(filePath, next.endsWith('\n') ? next : next + '\n');
    return true;
  }

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const separator = existing.trim().length > 0 ? '\n' : '';
  fs.writeFileSync(filePath, existing + prefix + separator + block + '\n');
  return true;
}

export function removeGeneratedBlock(filePath: string, blockId: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const start = `<!-- kirograph:${blockId}:start -->`;
  const end = `<!-- kirograph:${blockId}:end -->`;
  const original = fs.readFileSync(filePath, 'utf8');
  const pattern = new RegExp(`\\n?${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`);
  const next = original.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n');
  if (next === original) return false;
  fs.writeFileSync(filePath, next.endsWith('\n') ? next : next + '\n');
  return true;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build InstructionOptions from the installLate parameters.
 * Used by all targets to pass full feature config to buildAgentInstructions.
 */
export function buildInstructionOpts(
  cavemanMode?: CavemanMode | 'off',
  shellCompressionLevel?: string,
  enableMemory?: boolean,
  hasHooks?: boolean,
  enableDocs?: boolean,
  enableData?: boolean,
  enableSecurity?: boolean,
  enableArchitecture?: boolean,
): InstructionOptions {
  return {
    cavemanMode,
    shellCompressionLevel: (shellCompressionLevel as InstructionOptions['shellCompressionLevel']) ?? undefined,
    enableArchitecture: enableArchitecture ?? false,
    enableMemory: enableMemory ?? false,
    enableDocs: enableDocs ?? false,
    enableData: enableData ?? false,
    enableSecurity: enableSecurity ?? false,
    hasHooks: hasHooks ?? false,
  };
}

const violet = '\x1b[38;5;99m';
const resetAnsi = '\x1b[0m';
const dimAnsi = '\x1b[2m';
const boldAnsi = '\x1b[1m';

/**
 * Print a highlighted MCP config JSON block for targets that need user-scoped setup.
 */
export function printMcpSetup(configPath: string, projectRoot: string): void {
  const escapedPath = projectRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  console.log(`\n  ${dimAnsi}Add the MCP server manually:${resetAnsi}`);
  console.log(`  ${dimAnsi}Edit${resetAnsi} ${violet}${boldAnsi}${configPath}${resetAnsi} ${dimAnsi}and add:${resetAnsi}`);
  console.log(`  ${violet}{${resetAnsi}`);
  console.log(`  ${violet}  "mcpServers": {${resetAnsi}`);
  console.log(`  ${violet}    "kirograph": {${resetAnsi}`);
  console.log(`  ${violet}      "command": "kirograph",${resetAnsi}`);
  console.log(`  ${violet}      "args": ["serve", "--mcp", "--path", "${escapedPath}"]${resetAnsi}`);
  console.log(`  ${violet}    }${resetAnsi}`);
  console.log(`  ${violet}  }${resetAnsi}`);
  console.log(`  ${violet}}${resetAnsi}\n`);
}

/**
 * Print a highlighted CLI command for MCP registration.
 */
export function printMcpCommand(command: string): void {
  console.log(`\n  ${dimAnsi}Add the MCP server with:${resetAnsi}`);
  console.log(`  ${violet}${boldAnsi}${command}${resetAnsi}\n`);
}

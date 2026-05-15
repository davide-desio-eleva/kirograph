import * as fs from 'fs';
import * as path from 'path';
import { KIROGRAPH_TOOL_NAMES } from '../../mcp/tool-names';

export type InstallTarget = 'kiro' | 'claude' | 'codex';

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

export function writeMcpServersConfig(configPath: string, serverConfig: object): void {
  ensureDir(path.dirname(configPath));
  const existing = readJson(configPath);
  existing.mcpServers = existing.mcpServers ?? {};
  existing.mcpServers[KIROGRAPH_SERVER_NAME] = serverConfig;
  writeJson(configPath, existing);
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

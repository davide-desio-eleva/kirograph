/**
 * KiroGraph Installer — MCP server registration
 */

import * as fs from 'fs';
import * as path from 'path';

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function writeJson(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

export function writeMcpConfig(kiroDir: string): void {
  const mcpPath = path.join(kiroDir, 'settings', 'mcp.json');
  ensureDir(path.dirname(mcpPath));
  const existing = readJson(mcpPath);
  existing.mcpServers = existing.mcpServers ?? {};
  existing.mcpServers.kirograph = {
    command: 'kirograph',
    args: ['serve', '--mcp'],
    disabled: false,
    autoApprove: [
      'kirograph_search',
      'kirograph_context',
      'kirograph_callers',
      'kirograph_callees',
      'kirograph_impact',
      'kirograph_node',
      'kirograph_status',
      'kirograph_files',
      'kirograph_dead_code',
      'kirograph_circular_deps',
      'kirograph_path',
      'kirograph_type_hierarchy',
    ],
  };
  writeJson(mcpPath, existing);
  console.log(`  ✓ MCP server registered in ${mcpPath}`);
}

/**
 * KiroGraph Installer — MCP server registration
 */

import * as path from 'path';
import { KIROGRAPH_COMMAND, KIROGRAPH_MCP_ARGS, KIROGRAPH_TOOLS, writeMcpServersConfig } from './common';

export function writeMcpConfig(kiroDir: string): void {
  const mcpPath = path.join(kiroDir, 'settings', 'mcp.json');
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
    disabled: false,
    autoApprove: KIROGRAPH_TOOLS,
  });
  console.log(`  ✓ MCP server registered in ${mcpPath}`);
}

/**
 * KiroGraph Installer — MCP server registration
 */

import * as path from 'path';
import { KIROGRAPH_COMMAND, KIROGRAPH_MCP_ARGS, KIROGRAPH_TOOLS, KIROGRAPH_SERVER_NAME, writeMcpServersConfig, readJson, writeJson, ensureDir } from './common';
import { mergeToolList, readInstallState, updateInstallState } from './install-state';
import { FEATURE_TOOL_SETS } from '../../mcp/tool-names';

export interface McpFeatureFlags {
  enableArchitecture?: boolean;
  enableMemory?: boolean;
  enableWatchmen?: boolean;
  enableDocs?: boolean;
  enableData?: boolean;
  enableSecurity?: boolean;
  enablePatterns?: boolean;
  enableWiki?: boolean;
  enableCodeHealth?: boolean;
  enableNavigation?: boolean;
  enableComplexity?: boolean;
  enableGitContext?: boolean;
  enableEditPrimitives?: boolean;
  enableBranch?: boolean;
  enableAgentUtils?: boolean;
  enableGeneralCompression?: boolean;
  enableShellExec?: boolean;
  trackCallSites?: boolean;
}

function computeAutoApprove(features?: McpFeatureFlags): string[] {
  if (!features) return KIROGRAPH_TOOLS;
  const hidden = new Set<string>();
  for (const [flag, names] of Object.entries(FEATURE_TOOL_SETS)) {
    if ((features as Record<string, boolean | undefined>)[flag] === false) {
      for (const n of names) hidden.add(n);
    }
  }
  return KIROGRAPH_TOOLS.filter(n => !hidden.has(n));
}

export function writeMcpConfig(kiroDir: string, projectRoot?: string): void {
  const mcpPath = path.join(kiroDir, 'settings', 'mcp.json');
  const args = projectRoot
    ? [...KIROGRAPH_MCP_ARGS, '--path', projectRoot]
    : KIROGRAPH_MCP_ARGS;
  writeMcpServersConfig(mcpPath, {
    command: KIROGRAPH_COMMAND,
    args,
    disabled: false,
    autoApprove: KIROGRAPH_TOOLS,
  });
  console.log(`  ✓ MCP server registered in ${mcpPath}`);
}

/** Called after feature prompts to update autoApprove to match enabled features. */
export function updateMcpAutoApprove(kiroDir: string, features: McpFeatureFlags): void {
  const mcpPath = path.join(kiroDir, 'settings', 'mcp.json');
  const existing = readJson(mcpPath);
  if (!existing.mcpServers?.kirograph) return;
  existing.mcpServers.kirograph.autoApprove = computeAutoApprove(features);
  writeJson(mcpPath, existing);
}

/**
 * Write the final MCP config with the correct autoApprove in one atomic write.
 * Call this from installLate where feature flags are known.
 *
 * An existing entry is updated, not replaced: fields the user added are kept, and so are their
 * changes to autoApprove (a tool they removed stays removed, see mergeToolList). The command, its
 * arguments and the enabled state are always set.
 */
export function writeMcpConfigFinal(kiroDir: string, projectRoot: string, features: McpFeatureFlags): void {
  const mcpPath = path.join(kiroDir, 'settings', 'mcp.json');
  ensureDir(path.dirname(mcpPath));
  const config = readJson(mcpPath);
  config.mcpServers = config.mcpServers ?? {};
  const existing = config.mcpServers[KIROGRAPH_SERVER_NAME];
  const entry = existing && typeof existing === 'object' ? existing : {};
  const autoApprove = mergeToolList(
    computeAutoApprove(features),
    entry.autoApprove,
    readInstallState(kiroDir)?.autoApprove,
    KIROGRAPH_TOOLS,
  );
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    ...entry,
    command: KIROGRAPH_COMMAND,
    args: [...KIROGRAPH_MCP_ARGS, '--path', projectRoot],
    disabled: false,
    autoApprove,
  };
  writeJson(mcpPath, config);
  updateInstallState(kiroDir, { autoApprove });
  console.log(`  ✓ MCP server registered in ${mcpPath}`);
}

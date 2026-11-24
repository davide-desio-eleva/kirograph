/**
 * KiroGraph Installer — MCP server registration
 */

import * as fs from 'fs';
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

export interface McpLaunch {
  command: string;
  /** Arguments before `--path`: the absolute entry script (when resolved) followed by the serve arguments. */
  args: string[];
}

/**
 * The command a client runs to start this KiroGraph build. The Node binary and the entry script are
 * absolute, so a client started from the Dock or Finder, which does not read the shell profile, needs
 * no PATH lookup. Falls back to the bare `kirograph` command when the entry script cannot be located
 * (for example when the sources run under tsx).
 */
export function resolveMcpLaunch(entry: string | undefined = process.argv[1], node: string = process.execPath): McpLaunch {
  const fallback: McpLaunch = { command: KIROGRAPH_COMMAND, args: [...KIROGRAPH_MCP_ARGS] };
  if (!entry || !entry.endsWith('.js')) return fallback;
  try {
    return { command: node, args: [fs.realpathSync(entry), ...KIROGRAPH_MCP_ARGS] };
  } catch {
    return fallback;
  }
}

export type McpLaunchKind = 'none' | 'bare' | 'absolute' | 'missing';

/**
 * Classify the Kiro MCP entry: `bare` when it relies on PATH, `missing` when an absolute path it
 * names no longer exists (Node switched or reinstalled, the project moved), `absolute` when it is fine.
 */
export function inspectMcpLaunch(mcpPath: string): { kind: McpLaunchKind; command?: string; message: string } {
  if (!fs.existsSync(mcpPath)) return { kind: 'none', message: `${mcpPath} not found` };
  const entry = readJson(mcpPath).mcpServers?.[KIROGRAPH_SERVER_NAME];
  if (!entry || typeof entry.command !== 'string') return { kind: 'none', message: 'no kirograph server in the config' };
  const command: string = entry.command;
  if (command === KIROGRAPH_COMMAND) {
    return { kind: 'bare', command, message: `command "${command}" is looked up on PATH` };
  }
  const script = Array.isArray(entry.args) && typeof entry.args[0] === 'string' && entry.args[0].endsWith('.js') ? entry.args[0] : undefined;
  const missing = [command, script].filter((p): p is string => !!p && !fs.existsSync(p));
  if (missing.length > 0) {
    return { kind: 'missing', command, message: `${missing.join(', ')} does not exist` };
  }
  return { kind: 'absolute', command, message: `command ${command} exists` };
}

/** Rewrite only the command and arguments of the Kiro KiroGraph entry, keeping every other field. */
export function refreshMcpLaunch(mcpPath: string, projectRoot: string, launch: McpLaunch = resolveMcpLaunch()): void {
  const config = readJson(mcpPath);
  const entry = config.mcpServers?.[KIROGRAPH_SERVER_NAME];
  if (!entry || typeof entry !== 'object') return;
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    ...entry,
    command: launch.command,
    args: [...launch.args, '--path', projectRoot],
  };
  writeJson(mcpPath, config);
}

export function writeMcpConfig(kiroDir: string, projectRoot?: string): void {
  const mcpPath = path.join(kiroDir, 'settings', 'mcp.json');
  const launch = resolveMcpLaunch();
  const args = projectRoot
    ? [...launch.args, '--path', projectRoot]
    : launch.args;
  writeMcpServersConfig(mcpPath, {
    command: launch.command,
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
  const launch = resolveMcpLaunch();
  config.mcpServers[KIROGRAPH_SERVER_NAME] = {
    ...entry,
    command: launch.command,
    args: [...launch.args, '--path', projectRoot],
    disabled: false,
    autoApprove,
  };
  writeJson(mcpPath, config);
  updateInstallState(kiroDir, { autoApprove });
  console.log(`  ✓ MCP server registered in ${mcpPath}`);
}

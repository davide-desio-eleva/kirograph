/**
 * KiroGraph Installer — Kiro CLI agent config
 *
 * Writes .kiro/agents/kirograph.json — a workspace custom agent that wires up:
 *  - MCP server (kirograph tools)
 *  - steering file + workflow files as resources
 *  - hooks: sync on agentSpawn, userPromptSubmit, stop
 *
 * Sync strategy (CLI has no file-watch events unlike the IDE):
 *  - agentSpawn:       sync-if-dirty — catches edits made between sessions
 *  - userPromptSubmit: sync-if-dirty — keeps graph fresh within a session
 *  - stop:             sync-if-dirty --quiet — deferred flush, mirrors IDE agentStop
 */

import * as fs from 'fs';
import * as path from 'path';
import { KIROGRAPH_SCOPED_TOOLS, KIROGRAPH_SYNC_CMD } from './common';
import { mergeToolList, readInstallState, updateInstallState } from './install-state';

export interface CliAgentOptions {
  enableArchitecture?: boolean;
  enableSecurity?: boolean;
  enablePatterns?: boolean;
}

function buildAgentConfig(opts?: CliAgentOptions) {
  const workflowResources = [
    'file://.kiro/steering/kirograph-review.md',
    'file://.kiro/steering/kirograph-debug.md',
    'file://.kiro/steering/kirograph-onboard.md',
    'file://.kiro/steering/kirograph-refactor.md',
  ];
  if (opts?.enableArchitecture) {
    workflowResources.push('file://.kiro/steering/kirograph-architecture.md');
  }
  if (opts?.enableSecurity) {
    workflowResources.push('file://.kiro/steering/kirograph-security.md');
  }
  if (opts?.enablePatterns) {
    workflowResources.push('file://.kiro/steering/kirograph-patterns.md');
  }

  const slashCommands = [
    '/kirograph-review',
    '/kirograph-debug',
    ...(opts?.enableArchitecture ? ['/kirograph-architecture'] : []),
    '/kirograph-onboard',
    '/kirograph-refactor',
    ...(opts?.enableSecurity ? ['/kirograph-security'] : []),
    ...(opts?.enablePatterns ? ['/kirograph-patterns'] : []),
  ].join(', ');

  return {
    name: 'kirograph',
    description: `KiroGraph-aware agent — semantic code graph for symbol lookup, call graphs, impact analysis${opts?.enableArchitecture ? ', architecture metrics' : ''}${opts?.enableSecurity ? ', security auditing' : ''}${opts?.enablePatterns ? ', AST pattern search' : ''}. Workflow steering files are registered as resources — activate one with ${slashCommands}.`,
    resources: [
      'file://.kiro/steering/kirograph.md',
      ...workflowResources,
    ],
    tools: ['@builtin', '@kirograph'],
    allowedTools: KIROGRAPH_SCOPED_TOOLS,
    useLegacyMcpJson: true,
    hooks: {
      agentSpawn: [{ command: KIROGRAPH_SYNC_CMD }],
      userPromptSubmit: [{ command: KIROGRAPH_SYNC_CMD }],
      stop: [{ command: KIROGRAPH_SYNC_CMD }],
    },
  };
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

/** A resource the installer writes: one of KiroGraph's steering files. */
const MANAGED_RESOURCE = /^file:\/\/\.kiro\/steering\/kirograph(-[a-z-]+)?\.md$/;

/** True for a hook entry the installer writes (a KiroGraph command). */
function isKirographHook(entry: unknown): boolean {
  const command = (entry as { command?: unknown })?.command;
  return typeof command === 'string' && /\bkirograph\b/.test(command);
}

/** `ours`, then the entries of `theirs` not already in it. */
function union<T>(ours: T[], theirs: unknown): T[] {
  const out = [...ours];
  if (Array.isArray(theirs)) for (const t of theirs) if (!out.includes(t)) out.push(t);
  return out;
}

/**
 * The agent to write, given the one already on disk. KiroGraph's keys are updated; everything the
 * user added is kept: other keys (MCP servers, prompt, model...), resources, tools, hooks that do
 * not run kirograph, and their changes to allowedTools (see mergeToolList).
 */
export function mergeAgentConfig(
  generated: ReturnType<typeof buildAgentConfig>,
  existing: Record<string, any> | null,
  previousAllowedTools: string[] | undefined,
  projectRoot: string,
): Record<string, unknown> {
  if (!existing || typeof existing !== 'object') return generated;
  // A KiroGraph steering file of a feature that is off now: kept only while it is on disk (a
  // command such as `caveman` rewrites the agent without knowing which features are on)
  const keptResources = (Array.isArray(existing.resources) ? existing.resources : []).filter((r: unknown) =>
    typeof r !== 'string' || !MANAGED_RESOURCE.test(r) || fs.existsSync(path.join(projectRoot, r.slice('file://'.length))));
  const hooks: Record<string, unknown[]> = {};
  const existingHooks = existing.hooks && typeof existing.hooks === 'object' ? existing.hooks : {};
  for (const event of new Set([...Object.keys(generated.hooks), ...Object.keys(existingHooks)])) {
    const theirs = Array.isArray(existingHooks[event]) ? existingHooks[event].filter((h: unknown) => !isKirographHook(h)) : [];
    hooks[event] = [...((generated.hooks as Record<string, unknown[]>)[event] ?? []), ...theirs];
  }
  return {
    ...existing,
    ...generated,
    resources: union(generated.resources, keptResources),
    tools: union(generated.tools, existing.tools),
    allowedTools: mergeToolList(generated.allowedTools, existing.allowedTools, previousAllowedTools, KIROGRAPH_SCOPED_TOOLS),
    hooks,
  };
}

export function writeCliAgent(kiroDir: string, opts?: CliAgentOptions): void {
  const agentsDir = path.join(kiroDir, 'agents');
  ensureDir(agentsDir);
  const agentPath = path.join(agentsDir, 'kirograph.json');
  let existing: Record<string, any> | null = null;
  try { existing = JSON.parse(fs.readFileSync(agentPath, 'utf8')); } catch { /* none, or not JSON: written fresh */ }
  const merged = mergeAgentConfig(buildAgentConfig(opts), existing, readInstallState(kiroDir)?.allowedTools, path.dirname(kiroDir));
  writeJson(agentPath, merged);
  updateInstallState(kiroDir, { allowedTools: merged.allowedTools as string[] });
  console.log(`  ✓ CLI agent config written to ${agentPath}`);
}

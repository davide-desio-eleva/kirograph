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

export interface CliAgentOptions {
  enableArchitecture?: boolean;
  enableSecurity?: boolean;
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

  const slashCommands = [
    '/kirograph-review',
    '/kirograph-debug',
    ...(opts?.enableArchitecture ? ['/kirograph-architecture'] : []),
    '/kirograph-onboard',
    '/kirograph-refactor',
    ...(opts?.enableSecurity ? ['/kirograph-security'] : []),
  ].join(', ');

  return {
    name: 'kirograph',
    description: `KiroGraph-aware agent — semantic code graph for symbol lookup, call graphs, impact analysis${opts?.enableArchitecture ? ', architecture metrics' : ''}${opts?.enableSecurity ? ', and security auditing' : ''}. Workflow steering files are registered as resources — activate one with ${slashCommands}.`,
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

export function writeCliAgent(kiroDir: string, opts?: CliAgentOptions): void {
  const agentsDir = path.join(kiroDir, 'agents');
  ensureDir(agentsDir);
  const agentPath = path.join(agentsDir, 'kirograph.json');
  writeJson(agentPath, buildAgentConfig(opts));
  console.log(`  ✓ CLI agent config written to ${agentPath}`);
}

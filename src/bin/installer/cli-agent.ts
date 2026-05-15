/**
 * KiroGraph Installer — Kiro CLI agent config
 *
 * Writes .kiro/agents/kirograph.json — a workspace custom agent that wires up:
 *  - MCP server (kirograph tools)
 *  - steering file as resource (single source of truth for instructions + caveman rules)
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

function buildAgentConfig() {
  return {
    name: 'kirograph',
    description: 'KiroGraph-aware agent — uses the semantic code graph for faster, smarter exploration.',
    resources: ['file://.kiro/steering/kirograph.md'],
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

export function writeCliAgent(kiroDir: string): void {
  const agentsDir = path.join(kiroDir, 'agents');
  ensureDir(agentsDir);
  const agentPath = path.join(agentsDir, 'kirograph.json');
  writeJson(agentPath, buildAgentConfig());
  console.log(`  ✓ CLI agent config written to ${agentPath}`);
}

/**
 * KiroGraph Installer — Kiro hook file management
 *
 * Generates hooks in BOTH formats for compatibility:
 *
 * v2 (new Kiro IDE): `.kiro/hooks/<id>.json`
 *   { "version": "v1", "hooks": [{ "name", "trigger", "matcher?", "action": { type, command|prompt } }] }
 *
 * v1 (legacy Kiro IDE): `.kiro/hooks/<id>.kiro.hook`
 *   { "name", "version", "description", "when": { type, toolTypes? }, "then": { type, command|prompt } }
 *
 * Old Kiro ignores .json files; new Kiro ignores .kiro.hook files.
 * Writing both ensures KiroGraph works regardless of which IDE version the user runs.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const V2_EXT = '.json';
const V1_EXT = '.kiro.hook';

// ── Hook builders ─────────────────────────────────────────────────────────────

interface HookDef {
  id: string;
  description: string;
  v2: object;   // new Kiro IDE format
  v1: object;   // legacy Kiro IDE format
}

function buildWatchmenHook(synthesisMode: 'local' | 'agent'): HookDef {
  if (synthesisMode === 'local') {
    return {
      id: 'kirograph-watchmen',
      description: 'After memory capture, run local model synthesis if enough observations have accumulated.',
      v2: {
        version: 'v1',
        hooks: [{
          name: 'KiroGraph Watchmen',
          trigger: 'Stop',
          action: { type: 'command', command: 'kirograph mem watchmen synthesize --quiet 2>&1 || true' },
        }],
      },
      v1: {
        name: 'KiroGraph Watchmen',
        version: '1.0.0',
        description: 'After memory capture, run local model synthesis if enough observations have accumulated.',
        when: { type: 'agentStop' },
        then: { type: 'runCommand', command: 'kirograph mem watchmen synthesize --quiet 2>&1 || true' },
      },
    };
  }

  const watchmenPrompt = `Check if KiroGraph Watchmen synthesis should run: call kirograph_mem_store with kind='note' and content='watchmen check'. If the response does not include watchmenReady: true, do nothing and stop.

If watchmenReady: true:
1. Call kirograph_mem_search for each kind (decision, error, pattern, architecture, note) with limit 20.
2. Write or update the workspace brief: upsert the ## KiroGraph Watchmen section in each file listed in targetFiles. For .kiro/steering/kirograph-watchmen.md use inclusion: always frontmatter with sections for Decisions, Known Errors & Fixes, Recurring Patterns, and Architecture Notes. For all other files write a compact ## KiroGraph Watchmen block.
3. Generate skill files: if skillTargetDir is present in the response, identify recurring procedures (any procedure appearing in 3+ observations). For each, write a .kiro/steering/watchmen-<slug>.md file with inclusion: manual frontmatter, a short title, a "When to use" line with trigger phrases, and numbered steps. Prefix all generated files with watchmen- so they are distinguishable from hand-written steering files. Remove any .kiro/steering/watchmen-*.md files from previous runs that no longer match current patterns. If skillTargetDir is absent, embed a ## Recurring Procedures section in each targetFile instead, listing each procedure with trigger context and steps.
4. Store a kind='summary' observation briefly describing what was synthesized (e.g. "Synthesized 8 observations: updated kirograph-watchmen.md, wrote watchmen-auth-flow.md and watchmen-test-pattern.md").`;

  return {
    id: 'kirograph-watchmen',
    description: 'After memory capture, check if enough observations have accumulated. If so, synthesize them into workspace brief files.',
    v2: {
      version: 'v1',
      hooks: [{
        name: 'KiroGraph Watchmen',
        trigger: 'Stop',
        action: { type: 'agent', prompt: watchmenPrompt },
      }],
    },
    v1: {
      name: 'KiroGraph Watchmen',
      version: '1.0.0',
      description: 'After memory capture, check if enough observations have accumulated. If so, synthesize them into workspace brief files.',
      when: { type: 'agentStop' },
      then: { type: 'askAgent', prompt: watchmenPrompt },
    },
  };
}

const HOOKS: HookDef[] = [
  {
    id: 'kirograph-sync-if-dirty',
    description: 'Sync the KiroGraph index when the agent stops, picking up any file edits, creates, or deletes from the session.',
    v2: {
      version: 'v1',
      hooks: [{
        name: 'KiroGraph Sync on Agent Stop',
        trigger: 'Stop',
        action: { type: 'command', command: 'kirograph sync --quiet 2>&1 > /dev/null' },
      }],
    },
    v1: {
      name: 'KiroGraph Sync on Agent Stop',
      version: '1.0.0',
      description: 'Sync the KiroGraph index when the agent stops, picking up any file edits, creates, or deletes from the session.',
      when: { type: 'agentStop' },
      then: { type: 'runCommand', command: 'kirograph sync --quiet 2>&1 > /dev/null' },
    },
  },
  {
    id: 'kirograph-compress-hint',
    description: 'Remind the agent to use kirograph_exec for shell commands that benefit from token compression.',
    v2: {
      version: 'v1',
      hooks: [{
        name: 'KiroGraph Compression Hint',
        trigger: 'PreToolUse',
        matcher: 'execute_bash',
        action: {
          type: 'agent',
          prompt: 'If this shell command is a git operation, GitHub CLI, test runner, linter, build tool, file listing, grep/rg, docker/kubectl, AWS CLI, or package manager command, consider using the kirograph_exec MCP tool instead for 60-90% token savings. The tool compresses output automatically while preserving error details.',
        },
      }],
    },
    v1: {
      name: 'KiroGraph Compression Hint',
      version: '1.0.0',
      description: 'Remind the agent to use kirograph_exec for shell commands that benefit from token compression.',
      when: { type: 'preToolUse', toolTypes: ['shell'] },
      then: {
        type: 'askAgent',
        prompt: 'If this shell command is a git operation, GitHub CLI, test runner, linter, build tool, file listing, grep/rg, docker/kubectl, AWS CLI, or package manager command, consider using the kirograph_exec MCP tool instead for 60-90% token savings. The tool compresses output automatically while preserving error details.',
      },
    },
  },
  {
    id: 'kirograph-mem-capture',
    description: 'Prompt the agent to store important observations in memory at the end of each session.',
    v2: {
      version: 'v1',
      hooks: [{
        name: 'KiroGraph Memory Capture',
        trigger: 'Stop',
        action: {
          type: 'agent',
          prompt: 'Before ending, review what happened in this session. If there were any important decisions, bug root causes, architecture insights, error patterns, or lessons learned, store them using kirograph_mem_store with the appropriate kind (decision, error, pattern, architecture, note). Keep observations concise — one fact per observation. Skip if nothing noteworthy happened.',
        },
      }],
    },
    v1: {
      name: 'KiroGraph Memory Capture',
      version: '1.0.0',
      description: 'Prompt the agent to store important observations in memory at the end of each session.',
      when: { type: 'agentStop' },
      then: {
        type: 'askAgent',
        prompt: 'Before ending, review what happened in this session. If there were any important decisions, bug root causes, architecture insights, error patterns, or lessons learned, store them using kirograph_mem_store with the appropriate kind (decision, error, pattern, architecture, note). Keep observations concise — one fact per observation. Skip if nothing noteworthy happened.',
      },
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

/** Write a hook in both v2 (.json) and v1 (.kiro.hook) formats */
function writeHookDual(hooksDir: string, def: HookDef): void {
  writeJson(path.join(hooksDir, `${def.id}${V2_EXT}`), def.v2);
  writeJson(path.join(hooksDir, `${def.id}${V1_EXT}`), def.v1);
}

/** Write a hook in the specified format only, removing the other */
function writeHookForFormat(hooksDir: string, def: HookDef, format: KiroHookFormat): void {
  if (format === 'v2') {
    writeJson(path.join(hooksDir, `${def.id}${V2_EXT}`), def.v2);
    // Remove legacy file if it exists
    const legacyPath = path.join(hooksDir, `${def.id}${V1_EXT}`);
    if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
  } else {
    writeJson(path.join(hooksDir, `${def.id}${V1_EXT}`), def.v1);
    // Remove v2 file if it exists
    const v2Path = path.join(hooksDir, `${def.id}${V2_EXT}`);
    if (fs.existsSync(v2Path)) fs.unlinkSync(v2Path);
  }
}

/** Remove both format files for a given hook id */
function removeHookDual(hooksDir: string, id: string): void {
  for (const ext of [V2_EXT, V1_EXT]) {
    const p = path.join(hooksDir, `${id}${ext}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// ── Public ────────────────────────────────────────────────────────────────────

export type KiroHookFormat = 'v1-legacy' | 'v2';

export function writeHooks(kiroDir: string, opts?: { enableCompression?: boolean; enableMemory?: boolean; enableWatchmen?: boolean; watchmenSynthesisMode?: 'local' | 'agent'; enableWiki?: boolean; wikiSynthesisMode?: 'local' | 'agent'; wikiLintFrequency?: number; kiroHookFormat?: KiroHookFormat }): void {
  const hooksDir = path.join(kiroDir, 'hooks');
  ensureDir(hooksDir);

  const format = opts?.kiroHookFormat ?? 'v2';

  // Remove obsolete hook files from earlier versions
  const obsoleteFiles = [
    'kirograph-sync-on-save.json', 'kirograph-sync-on-create.json',
    'kirograph-mark-dirty-on-save.json', 'kirograph-mark-dirty-on-create.json',
    'kirograph-sync-on-delete.json',
    'kirograph-mark-dirty-on-save.kiro.hook',
    'kirograph-mark-dirty-on-create.kiro.hook',
    'kirograph-sync-on-delete.kiro.hook',
  ];
  for (const old of obsoleteFiles) {
    const p = path.join(hooksDir, old);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  for (const def of HOOKS) {
    // Skip compression hook if compression is disabled
    if (def.id === 'kirograph-compress-hint' && opts?.enableCompression === false) {
      removeHookDual(hooksDir, def.id);
      continue;
    }
    // Skip memory hook if memory is disabled
    if (def.id === 'kirograph-mem-capture' && !opts?.enableMemory) {
      removeHookDual(hooksDir, def.id);
      continue;
    }
    writeHookForFormat(hooksDir, def, format);
  }

  // Watchmen hook — built dynamically based on synthesis mode
  if (opts?.enableWatchmen) {
    const mode = opts.watchmenSynthesisMode ?? 'local';
    writeHookForFormat(hooksDir, buildWatchmenHook(mode), format);
  } else {
    removeHookDual(hooksDir, 'kirograph-watchmen');
  }

  // Wiki hooks — ingest trigger + periodic lint
  if (opts?.enableWiki) {
    const lintFreq = opts.wikiLintFrequency ?? 10;
    const wikiMode = opts.wikiSynthesisMode ?? 'agent';

    const wikiIngestPrompt = `If this session produced durable knowledge (design decisions, architecture insights, API contracts, process steps, domain facts), consider updating the wiki:
1. Call kirograph_wiki_ingest with the key findings as source text.
2. The tool returns a structured prompt. Pass it to yourself to generate a WIKI_DIFF.
3. Call kirograph_wiki_apply_diff with your generated diff.
Skip if the session was trivial (simple bug fix, no new knowledge).`;

    if (wikiMode === 'local') {
      writeHookForFormat(hooksDir, {
        id: 'kirograph-wiki-ingest',
        description: 'After each session, run local-model wiki synthesis over queued sources.',
        v2: {
          version: 'v1',
          hooks: [{
            name: 'KiroGraph Wiki Synthesize',
            trigger: 'Stop',
            action: { type: 'command', command: 'kirograph wiki synthesize --quiet 2>&1 || true' },
          }],
        },
        v1: {
          name: 'KiroGraph Wiki Synthesize',
          version: '1.0.0',
          description: 'After each session, run local-model wiki synthesis over queued sources.',
          when: { type: 'agentStop' },
          then: { type: 'runCommand', command: 'kirograph wiki synthesize --quiet 2>&1 || true' },
        },
      }, format);
    } else {
      writeHookForFormat(hooksDir, {
        id: 'kirograph-wiki-ingest',
        description: 'At the end of each session, prompt the agent to ingest any relevant knowledge into the wiki.',
        v2: {
          version: 'v1',
          hooks: [{
            name: 'KiroGraph Wiki Ingest',
            trigger: 'Stop',
            action: { type: 'agent', prompt: wikiIngestPrompt },
          }],
        },
        v1: {
          name: 'KiroGraph Wiki Ingest',
          version: '1.0.0',
          description: 'At the end of each session, prompt the agent to ingest any relevant knowledge into the wiki.',
          when: { type: 'agentStop' },
          then: { type: 'askAgent', prompt: wikiIngestPrompt },
        },
      }, format);
    }

    writeHookForFormat(hooksDir, {
      id: 'kirograph-wiki-lint',
      description: `Run wiki health check every ${lintFreq} sessions to catch broken links, orphan pages, and contradictions.`,
      v2: {
        version: 'v1',
        hooks: [{
          name: 'KiroGraph Wiki Lint',
          trigger: 'Stop',
          action: { type: 'command', command: 'kirograph wiki lint 2>&1 || true' },
        }],
      },
      v1: {
        name: 'KiroGraph Wiki Lint',
        version: '1.0.0',
        description: `Run wiki health check every ${lintFreq} sessions to catch broken links, orphan pages, and contradictions.`,
        when: { type: 'agentStop' },
        then: { type: 'runCommand', command: 'kirograph wiki lint 2>&1 || true' },
      },
    }, format);
  } else {
    removeHookDual(hooksDir, 'kirograph-wiki-ingest');
    removeHookDual(hooksDir, 'kirograph-wiki-lint');
  }

  console.log(`  ✓ Auto-sync hooks written to ${hooksDir}`);
}

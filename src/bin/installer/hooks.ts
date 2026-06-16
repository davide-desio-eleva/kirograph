/**
 * KiroGraph Installer — Kiro hook file management
 */

import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from '../../errors';

// ── Constants ─────────────────────────────────────────────────────────────────

const HOOK_EXT = '.kiro.hook';

// ── Hook builders ─────────────────────────────────────────────────────────────

function buildWatchmenHook(synthesisMode: 'local' | 'agent'): object {
  if (synthesisMode === 'local') {
    return {
      name: 'KiroGraph Watchmen',
      version: '1.0.0',
      description: 'After memory capture, run local model synthesis if enough observations have accumulated.',
      when: { type: 'agentStop' },
      then: { type: 'runCommand', command: 'kirograph mem watchmen synthesize --quiet 2>&1 || true' },
    };
  }
  return {
    name: 'KiroGraph Watchmen',
    version: '1.0.0',
    description: 'After memory capture, check if enough observations have accumulated. If so, synthesize them into workspace brief files.',
    when: { type: 'agentStop' },
    then: {
      type: 'askAgent',
      prompt: `Check if KiroGraph Watchmen synthesis should run: call kirograph_mem_store with kind='note' and content='watchmen check'. If the response does not include watchmenReady: true, do nothing and stop.

If watchmenReady: true:
1. Call kirograph_mem_search for each kind (decision, error, pattern, architecture, note) with limit 20.
2. Write or update the workspace brief: upsert the ## KiroGraph Watchmen section in each file listed in targetFiles. For .kiro/steering/kirograph-watchmen.md use inclusion: always frontmatter with sections for Decisions, Known Errors & Fixes, Recurring Patterns, and Architecture Notes. For all other files write a compact ## KiroGraph Watchmen block.
3. Generate skill files: if skillTargetDir is present in the response, identify recurring procedures (any procedure appearing in 3+ observations). For each, write a .kiro/steering/watchmen-<slug>.md file with inclusion: manual frontmatter, a short title, a "When to use" line with trigger phrases, and numbered steps. Prefix all generated files with watchmen- so they are distinguishable from hand-written steering files. Remove any .kiro/steering/watchmen-*.md files from previous runs that no longer match current patterns. If skillTargetDir is absent, embed a ## Recurring Procedures section in each targetFile instead, listing each procedure with trigger context and steps.
4. Store a kind='summary' observation briefly describing what was synthesized (e.g. "Synthesized 8 observations: updated kirograph-watchmen.md, wrote watchmen-auth-flow.md and watchmen-test-pattern.md").`,
    },
  };
}

const HOOKS: Array<{ filename: string; hook: object }> = [
  {
    filename: `kirograph-sync-if-dirty${HOOK_EXT}`,
    hook: {
      name: 'KiroGraph Sync on Agent Stop',
      version: '1.0.0',
      description: 'Sync the KiroGraph index when the agent stops, picking up any file edits, creates, or deletes from the session.',
      when: { type: 'agentStop' },
      then: { type: 'runCommand', command: 'kirograph sync --quiet 2>&1 > /dev/null' },
    },
  },
  {
    filename: `kirograph-compress-hint${HOOK_EXT}`,
    hook: {
      name: 'KiroGraph Compression Hint',
      version: '1.0.0',
      description: 'Remind the agent to use kirograph_exec for shell commands that benefit from token compression (git, gh, test, lint, build, docker, aws, grep).',
      when: { type: 'preToolUse', toolTypes: ['shell'] },
      then: {
        type: 'askAgent',
        prompt: 'If this shell command is a git operation, GitHub CLI, test runner, linter, build tool, file listing, grep/rg, docker/kubectl, AWS CLI, or package manager command, consider using the kirograph_exec MCP tool instead for 60-90% token savings. The tool compresses output automatically while preserving error details.',
      },
    },
  },
  {
    filename: `kirograph-mem-capture${HOOK_EXT}`,
    hook: {
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

function migrateOnIdleHooks(hooksDir: string): void {
  if (!fs.existsSync(hooksDir)) return;
  let files: string[];
  try {
    files = fs.readdirSync(hooksDir).filter(f => f.endsWith('.json') || f.endsWith(HOOK_EXT));
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = path.join(hooksDir, file);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      logWarn(`KiroGraph installer: could not read hook file ${filePath}`);
      continue;
    }
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      logWarn(`KiroGraph installer: could not parse hook file ${filePath}`);
      continue;
    }
    let changed = false;
    if (obj?.when?.type === 'onIdle') {
      obj.when.type = 'agentStop';
      changed = true;
    }
    // Migrate .json → .kiro.hook extension
    if (file.endsWith('.json') && file.startsWith('kirograph-')) {
      const newName = file.replace(/\.json$/, HOOK_EXT);
      const newPath = path.join(hooksDir, newName);
      try {
        fs.writeFileSync(newPath, JSON.stringify(obj, null, 2) + '\n');
        fs.unlinkSync(filePath);
      } catch {
        logWarn(`KiroGraph installer: could not migrate hook file ${filePath} → ${newName}`);
      }
    } else if (changed) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
      } catch {
        logWarn(`KiroGraph installer: could not write migrated hook file ${filePath}`);
      }
    }
  }
}

// ── Public ────────────────────────────────────────────────────────────────────

export function writeHooks(kiroDir: string, opts?: { enableCompression?: boolean; enableMemory?: boolean; enableWatchmen?: boolean; watchmenSynthesisMode?: 'local' | 'agent'; enableWiki?: boolean; wikiSynthesisMode?: 'local' | 'agent'; wikiLintFrequency?: number }): void {
  const hooksDir = path.join(kiroDir, 'hooks');
  ensureDir(hooksDir);

  migrateOnIdleHooks(hooksDir);

  const oldHooks = [
    'kirograph-sync-on-save.json', 'kirograph-sync-on-create.json',
    // Legacy .json versions (migrated to .kiro.hook)
    'kirograph-mark-dirty-on-save.json', 'kirograph-mark-dirty-on-create.json',
    'kirograph-sync-on-delete.json', 'kirograph-sync-if-dirty.json',
    'kirograph-compress-hint.json', 'kirograph-mem-capture.json',
    // Removed per-file hooks (consolidated into agentStop sync)
    `kirograph-mark-dirty-on-save${HOOK_EXT}`,
    `kirograph-mark-dirty-on-create${HOOK_EXT}`,
    `kirograph-sync-on-delete${HOOK_EXT}`,
  ];
  for (const old of oldHooks) {
    const p = path.join(hooksDir, old);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  for (const { filename, hook } of HOOKS) {
    // Skip compression hook if compression is disabled
    if (filename === `kirograph-compress-hint${HOOK_EXT}` && opts?.enableCompression === false) {
      const p = path.join(hooksDir, filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      continue;
    }
    // Skip memory hook if memory is disabled
    if (filename === `kirograph-mem-capture${HOOK_EXT}` && !opts?.enableMemory) {
      const p = path.join(hooksDir, filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      continue;
    }
    writeJson(path.join(hooksDir, filename), hook);
  }

  // Watchmen hook — built dynamically based on synthesis mode
  const watchmenHookPath = path.join(hooksDir, `kirograph-watchmen${HOOK_EXT}`);
  if (opts?.enableWatchmen) {
    const mode = opts.watchmenSynthesisMode ?? 'local';
    writeJson(watchmenHookPath, buildWatchmenHook(mode));
  } else {
    if (fs.existsSync(watchmenHookPath)) fs.unlinkSync(watchmenHookPath);
  }

  // Wiki hooks — ingest trigger + periodic lint
  const wikiIngestHookPath = path.join(hooksDir, `kirograph-wiki-ingest${HOOK_EXT}`);
  const wikiLintHookPath = path.join(hooksDir, `kirograph-wiki-lint${HOOK_EXT}`);
  if (opts?.enableWiki) {
    const lintFreq = opts.wikiLintFrequency ?? 10;
    const wikiMode = opts.wikiSynthesisMode ?? 'agent';

    if (wikiMode === 'local') {
      writeJson(wikiIngestHookPath, {
        name: 'KiroGraph Wiki Synthesize',
        version: '1.0.0',
        description: 'After each session, run local-model wiki synthesis over queued sources.',
        when: { type: 'agentStop' },
        then: { type: 'runCommand', command: 'kirograph wiki synthesize --quiet 2>&1 || true' },
      });
    } else {
      writeJson(wikiIngestHookPath, {
        name: 'KiroGraph Wiki Ingest',
        version: '1.0.0',
        description: 'At the end of each session, prompt the agent to ingest any relevant knowledge into the wiki.',
        when: { type: 'agentStop' },
        then: {
          type: 'askAgent',
          prompt: `If this session produced durable knowledge (design decisions, architecture insights, API contracts, process steps, domain facts), consider updating the wiki:
1. Call kirograph_wiki_ingest with the key findings as source text.
2. The tool returns a structured prompt. Pass it to yourself to generate a WIKI_DIFF.
3. Call kirograph_wiki_apply_diff with your generated diff.
Skip if the session was trivial (simple bug fix, no new knowledge).`,
        },
      });
    }

    writeJson(wikiLintHookPath, {
      name: 'KiroGraph Wiki Lint',
      version: '1.0.0',
      description: `Run wiki health check every ${lintFreq} sessions to catch broken links, orphan pages, and contradictions.`,
      when: { type: 'agentStop' },
      then: { type: 'runCommand', command: `kirograph wiki lint 2>&1 || true` },
    });
  } else {
    if (fs.existsSync(wikiIngestHookPath)) fs.unlinkSync(wikiIngestHookPath);
    if (fs.existsSync(wikiLintHookPath)) fs.unlinkSync(wikiLintHookPath);
  }

  console.log(`  ✓ Auto-sync hooks written to ${hooksDir}`);
}

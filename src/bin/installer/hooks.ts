/**
 * KiroGraph Installer — Kiro hook file management
 */

import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from '../../errors';

// ── Constants ─────────────────────────────────────────────────────────────────

const FILE_PATTERNS = [
  '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
  '**/*.py', '**/*.go', '**/*.rs', '**/*.java',
  '**/*.cs', '**/*.rb', '**/*.php', '**/*.swift',
  '**/*.kt', '**/*.dart',
  '**/*.ex', '**/*.exs',
  '**/*.scala', '**/*.sc', '**/*.lua', '**/*.zig',
  '**/*.sh', '**/*.bash', '**/*.ml', '**/*.mli',
  '**/*.elm', '**/*.sol', '**/*.vue', '**/*.m',
  '**/*.yaml', '**/*.yml',
  '**/*.tf', '**/*.tfvars',
  '**/*.css', '**/*.scss', '**/*.sass',
  '**/*.html',
];

const HOOK_EXT = '.kiro.hook';

const HOOKS: Array<{ filename: string; hook: object }> = [
  {
    filename: `kirograph-mark-dirty-on-save${HOOK_EXT}`,
    hook: {
      name: 'KiroGraph Mark Dirty on Save',
      version: '1.0.0',
      description: 'Mark the KiroGraph index as dirty when source files are saved. Sync is deferred to agent idle.',
      when: { type: 'fileEdited', patterns: FILE_PATTERNS },
      then: { type: 'askAgent', prompt: "A source file was saved. Run kirograph_exec with command 'kirograph mark-dirty' to mark the index as needing a sync. Do not explain, just run the tool silently." },
    },
  },
  {
    filename: `kirograph-mark-dirty-on-create${HOOK_EXT}`,
    hook: {
      name: 'KiroGraph Mark Dirty on Create',
      version: '1.0.0',
      description: 'Mark the KiroGraph index as dirty when source files are created.',
      when: { type: 'fileCreated', patterns: FILE_PATTERNS },
      then: { type: 'askAgent', prompt: "A source file was created. Run kirograph_exec with command 'kirograph mark-dirty' to mark the index as needing a sync. Do not explain, just run the tool silently." },
    },
  },
  {
    filename: `kirograph-sync-on-delete${HOOK_EXT}`,
    hook: {
      name: 'KiroGraph Sync on Delete',
      version: '1.0.0',
      description: 'Remove deleted files from the KiroGraph index immediately.',
      when: { type: 'fileDeleted', patterns: FILE_PATTERNS },
      then: { type: 'askAgent', prompt: "A source file was deleted. Run kirograph_exec with command 'kirograph sync-if-dirty' to update the index. Do not explain, just run the tool silently." },
    },
  },
  {
    filename: `kirograph-sync-if-dirty${HOOK_EXT}`,
    hook: {
      name: 'KiroGraph Deferred Sync',
      version: '1.0.0',
      description: 'Sync the KiroGraph index when the agent is idle and a dirty marker is present.',
      when: { type: 'agentStop' },
      then: { type: 'askAgent', prompt: "Run kirograph_exec with command 'kirograph sync-if-dirty --quiet' to sync the index if it was marked dirty. Do not explain, just run the tool silently." },
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

export function writeHooks(kiroDir: string, opts?: { enableCompression?: boolean }): void {
  const hooksDir = path.join(kiroDir, 'hooks');
  ensureDir(hooksDir);

  migrateOnIdleHooks(hooksDir);

  const oldHooks = [
    'kirograph-sync-on-save.json', 'kirograph-sync-on-create.json',
    // Legacy .json versions (migrated to .kiro.hook)
    'kirograph-mark-dirty-on-save.json', 'kirograph-mark-dirty-on-create.json',
    'kirograph-sync-on-delete.json', 'kirograph-sync-if-dirty.json',
    'kirograph-compress-hint.json',
  ];
  for (const old of oldHooks) {
    const p = path.join(hooksDir, old);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  for (const { filename, hook } of HOOKS) {
    // Skip compression hook if compression is disabled
    if (filename === `kirograph-compress-hint${HOOK_EXT}` && opts?.enableCompression === false) {
      // Remove the hook file if it exists from a previous install
      const p = path.join(hooksDir, filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      continue;
    }
    writeJson(path.join(hooksDir, filename), hook);
  }

  console.log(`  ✓ Auto-sync hooks written to ${hooksDir}`);
}

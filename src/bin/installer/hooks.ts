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
];

const HOOKS: Array<{ filename: string; hook: object }> = [
  {
    filename: 'kirograph-mark-dirty-on-save.json',
    hook: {
      name: 'KiroGraph Mark Dirty on Save',
      version: '1.0.0',
      description: 'Mark the KiroGraph index as dirty when source files are saved. Sync is deferred to agent idle.',
      when: { type: 'fileEdited', patterns: FILE_PATTERNS },
      then: { type: 'runCommand', command: 'kirograph mark-dirty 2>/dev/null || true' },
    },
  },
  {
    filename: 'kirograph-mark-dirty-on-create.json',
    hook: {
      name: 'KiroGraph Mark Dirty on Create',
      version: '1.0.0',
      description: 'Mark the KiroGraph index as dirty when source files are created.',
      when: { type: 'fileCreated', patterns: FILE_PATTERNS },
      then: { type: 'runCommand', command: 'kirograph mark-dirty 2>/dev/null || true' },
    },
  },
  {
    filename: 'kirograph-sync-on-delete.json',
    hook: {
      name: 'KiroGraph Sync on Delete',
      version: '1.0.0',
      description: 'Remove deleted files from the KiroGraph index immediately.',
      when: { type: 'fileDeleted', patterns: FILE_PATTERNS },
      then: { type: 'runCommand', command: 'kirograph sync-if-dirty 2>/dev/null || true' },
    },
  },
  {
    filename: 'kirograph-sync-if-dirty.json',
    hook: {
      name: 'KiroGraph Deferred Sync',
      version: '1.0.0',
      description: 'Sync the KiroGraph index when the agent is idle and a dirty marker is present. Batches multiple rapid saves into one sync.',
      when: { type: 'agentStop' },
      then: { type: 'runCommand', command: 'kirograph sync-if-dirty --quiet 2>/dev/null || true' },
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
    files = fs.readdirSync(hooksDir).filter(f => f.endsWith('.json'));
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
    if (obj?.when?.type === 'onIdle') {
      obj.when.type = 'agentStop';
      try {
        fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
      } catch {
        logWarn(`KiroGraph installer: could not write migrated hook file ${filePath}`);
      }
    }
  }
}

// ── Public ────────────────────────────────────────────────────────────────────

export function writeHooks(kiroDir: string): void {
  const hooksDir = path.join(kiroDir, 'hooks');
  ensureDir(hooksDir);

  migrateOnIdleHooks(hooksDir);

  const oldHooks = ['kirograph-sync-on-save.json', 'kirograph-sync-on-create.json'];
  for (const old of oldHooks) {
    const p = path.join(hooksDir, old);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  for (const { filename, hook } of HOOKS) {
    writeJson(path.join(hooksDir, filename), hook);
  }
  console.log(`  ✓ Auto-sync hooks written to ${hooksDir}`);
}

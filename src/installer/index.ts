/**
 * KiroGraph Installer for Kiro
 *
 * Wires up:
 *  1. .kiro/settings/mcp.json  — registers the MCP server
 *  2. .kiro/hooks/*.json       — auto-sync on file save/create/delete (via mark-dirty + sync-if-dirty)
 *  3. .kiro/steering/kirograph.md — teaches Kiro to use the graph tools
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { logWarn } from '../errors';

// ── Helpers ───────────────────────────────────────────────────────────────────

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function writeJson(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

// ── MCP Config ────────────────────────────────────────────────────────────────

function writeMcpConfig(kiroDir: string): void {
  const mcpPath = path.join(kiroDir, 'settings', 'mcp.json');
  ensureDir(path.dirname(mcpPath));
  const existing = readJson(mcpPath);
  existing.mcpServers = existing.mcpServers ?? {};
  existing.mcpServers.kirograph = {
    command: 'kirograph',
    args: ['serve', '--mcp'],
    disabled: false,
    autoApprove: [
      'kirograph_search',
      'kirograph_context',
      'kirograph_callers',
      'kirograph_callees',
      'kirograph_impact',
      'kirograph_node',
      'kirograph_status',
      'kirograph_files',
      'kirograph_dead_code',
      'kirograph_circular_deps',
      'kirograph_path',
      'kirograph_type_hierarchy',
    ],
  };
  writeJson(mcpPath, existing);
  console.log(`  ✓ MCP server registered in ${mcpPath}`);
}

// ── Kiro Hooks ────────────────────────────────────────────────────────────────

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
      when: {
        type: 'fileEdited',
        patterns: FILE_PATTERNS,
      },
      then: {
        type: 'runCommand',
        command: 'kirograph mark-dirty 2>/dev/null || true',
      },
    },
  },
  {
    filename: 'kirograph-mark-dirty-on-create.json',
    hook: {
      name: 'KiroGraph Mark Dirty on Create',
      version: '1.0.0',
      description: 'Mark the KiroGraph index as dirty when source files are created.',
      when: {
        type: 'fileCreated',
        patterns: FILE_PATTERNS,
      },
      then: {
        type: 'runCommand',
        command: 'kirograph mark-dirty 2>/dev/null || true',
      },
    },
  },
  {
    filename: 'kirograph-sync-on-delete.json',
    hook: {
      name: 'KiroGraph Sync on Delete',
      version: '1.0.0',
      description: 'Remove deleted files from the KiroGraph index immediately.',
      when: {
        type: 'fileDeleted',
        patterns: FILE_PATTERNS,
      },
      then: {
        type: 'runCommand',
        command: 'kirograph sync-if-dirty 2>/dev/null || true',
      },
    },
  },
  {
    filename: 'kirograph-sync-if-dirty.json',
    hook: {
      name: 'KiroGraph Deferred Sync',
      version: '1.0.0',
      description: 'Sync the KiroGraph index when the agent is idle and a dirty marker is present. Batches multiple rapid saves into one sync.',
      when: {
        type: 'agentStop',
      },
      then: {
        type: 'runCommand',
        command: 'kirograph sync-if-dirty --quiet 2>/dev/null || true',
      },
    },
  },
];

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

function writeHooks(kiroDir: string): void {
  const hooksDir = path.join(kiroDir, 'hooks');
  ensureDir(hooksDir);

  // Migrate existing hooks from onIdle → agentStop
  migrateOnIdleHooks(hooksDir);

  // Remove old sync hooks that are now replaced
  const oldHooks = [
    'kirograph-sync-on-save.json',
    'kirograph-sync-on-create.json',
  ];
  for (const old of oldHooks) {
    const p = path.join(hooksDir, old);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  for (const { filename, hook } of HOOKS) {
    writeJson(path.join(hooksDir, filename), hook);
  }
  console.log(`  ✓ Auto-sync hooks written to ${hooksDir}`);
}

// ── Steering File ─────────────────────────────────────────────────────────────

const STEERING_CONTENT = `---
inclusion: always
---

# KiroGraph

KiroGraph builds a semantic knowledge graph of your codebase for faster, smarter code exploration.

## When \`.kirograph/\` exists in the project

Use KiroGraph MCP tools for exploration instead of grep/glob/file reads:

| Tool | Use For |
|------|---------|
| \`kirograph_search\` | Find symbols by name (functions, classes, types) |
| \`kirograph_context\` | Get relevant code context for a task — **start here** |
| \`kirograph_callers\` | Find what calls a function |
| \`kirograph_callees\` | Find what a function calls |
| \`kirograph_impact\` | See what's affected by changing a symbol |
| \`kirograph_node\` | Get details + source code for a symbol |
| \`kirograph_status\` | Check index health and statistics |
| \`kirograph_files\` | List the indexed file structure |
| \`kirograph_dead_code\` | Find symbols with no incoming references |
| \`kirograph_circular_deps\` | Detect circular import dependencies |
| \`kirograph_path\` | Find the shortest path between two symbols |
| \`kirograph_type_hierarchy\` | Traverse class/interface inheritance |

### Workflow

1. Start with \`kirograph_context\` for any task — it returns entry points and related code in one call.
2. Use \`kirograph_search\` instead of grep for finding symbols.
3. Use \`kirograph_callers\`/\`kirograph_callees\` to trace code flow.
4. Use \`kirograph_impact\` before making changes to understand blast radius.
5. Use \`kirograph_files\` to explore the project structure.
6. Use \`kirograph_dead_code\` to identify unused code before refactoring.

### If \`.kirograph/\` does NOT exist

Ask the user: "This project doesn't have KiroGraph initialized. Run \`kirograph init -i\` to build a code knowledge graph for faster exploration?"
`;

function writeSteering(kiroDir: string): void {
  const steeringDir = path.join(kiroDir, 'steering');
  ensureDir(steeringDir);
  const steeringPath = path.join(steeringDir, 'kirograph.md');
  fs.writeFileSync(steeringPath, STEERING_CONTENT);
  console.log(`  ✓ Steering file written to ${steeringPath}`);
}

// ── Main Installer ────────────────────────────────────────────────────────────

export async function runInstaller(): Promise<void> {
  console.log('\n  KiroGraph Installer\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Determine workspace root
    const cwd = process.cwd();
    const kiroDir = path.join(cwd, '.kiro');

    console.log(`  Workspace: ${cwd}\n`);

    const proceed = await ask(rl, '  Install KiroGraph for this Kiro workspace? (Y/n) ');
    if (proceed.toLowerCase() === 'n') { console.log('  Cancelled.'); rl.close(); return; }
    console.log();

    // 1. MCP config
    writeMcpConfig(kiroDir);

    // 2. Hooks
    writeHooks(kiroDir);

    // 3. Steering
    writeSteering(kiroDir);

    // 4. Optionally init + index
    const doIndex = await ask(rl, '\n  Initialize and index this project now? (Y/n) ');
    if (doIndex.toLowerCase() !== 'n') {
      const KiroGraph = (await import('../index')).default;
      if (!KiroGraph.isInitialized(cwd)) {
        await KiroGraph.init(cwd);
        console.log('  ✓ Created .kirograph/');
      }
      const cg = await KiroGraph.open(cwd);
      console.log('  Indexing...');
      const result = await cg.indexAll({
        onProgress: p => process.stdout.write(`\r    ${p.phase} ${p.current}/${p.total}   `),
      });
      process.stdout.write('\n');
      console.log(`  ✓ Indexed ${result.filesIndexed} files, ${result.nodesCreated} symbols, ${result.edgesCreated} edges`);
      cg.close();
    }

    console.log('\n  Done! Restart Kiro for the MCP server to load.\n');
  } finally {
    rl.close();
  }
}

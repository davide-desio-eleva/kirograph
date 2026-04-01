#!/usr/bin/env node
/**
 * KiroGraph CLI
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { printBanner } from '../banner';
import { renderIndexProgress } from '../utils';

const program = new Command();

const violet = '\x1b[38;5;99m';
const bold   = '\x1b[1m';
const dim    = '\x1b[2m';
const green  = '\x1b[38;5;114m';
const reset  = '\x1b[0m';

function label(text: string): string { return `${dim}${text}${reset}`; }
function value(text: string): string { return `${violet}${bold}${text}${reset}`; }
function section(text: string): string { return `${violet}${bold}${text}${reset}`; }

/** Render a two-column table with violet borders. Entries: [label, value] pairs. */
function renderTable(entries: [string, string][], indent = '  '): string {
  if (entries.length === 0) return '';
  const colW = Math.max(...entries.map(([k]) => k.length));
  const top    = `${indent}${violet}┌${'─'.repeat(colW + 2)}┬${'─'.repeat(18)}┐${reset}`;
  const bottom = `${indent}${violet}└${'─'.repeat(colW + 2)}┴${'─'.repeat(18)}┘${reset}`;
  const rows = entries.map(([k, v], i) => {
    const sep = i < entries.length - 1
      ? `\n${indent}${violet}├${'─'.repeat(colW + 2)}┼${'─'.repeat(18)}┤${reset}`
      : '';
    const pad = ' '.repeat(colW - k.length);
    return `${indent}${violet}│${reset} ${dim}${k}${reset}${pad} ${violet}│${reset} ${violet}${bold}${v}${reset}${' '.repeat(Math.max(0, 16 - v.length))} ${violet}│${reset}${sep}`;
  });
  return [top, ...rows, bottom].join('\n');
}

program
  .name('kirograph')
  .description('Semantic code knowledge graph for Kiro')
  .version('0.1.0')
  .addHelpCommand(true)
  .hook('preAction', (thisCommand) => {
    const name = thisCommand.name();
    if (name === 'init') printBanner();
  });

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command('init [projectPath]')
  .description('Initialize KiroGraph in a project')
  .option('-i, --index', 'Index immediately after init')
  .action(async (projectPath: string | undefined, opts: { index?: boolean }) => {
    const KiroGraph = (await import('../index')).default;
    const target = path.resolve(projectPath ?? process.cwd());
    if (KiroGraph.isInitialized(target)) {
      console.log(`  ${dim}KiroGraph already initialized at ${target}${reset}`);
    } else {
      await KiroGraph.init(target);
      console.log(`  ${green}✓${reset} Initialized ${violet}${bold}.kirograph/${reset} in ${dim}${target}${reset}`);
    }
    if (opts.index) {
      const cg = await KiroGraph.open(target);
      console.log(`\n  ${dim}Indexing...${reset}`);
      const result = await cg.indexAll({
        force: true,
        onProgress: renderIndexProgress,
      });
      process.stdout.write('\n');
      console.log(`  ${green}✓${reset} ${value(String(result.filesIndexed))} ${dim}files,${reset} ${value(String(result.nodesCreated))} ${dim}symbols,${reset} ${value(String(result.edgesCreated))} ${dim}edges${reset} ${dim}(${result.duration}ms)${reset}`);
      if (result.errors.length) console.warn(`  \x1b[33m⚠ ${result.errors.length} warning(s)\x1b[0m`);
      const fallback = cg.getEngineFallback();
      if (fallback) console.warn(`  \x1b[33m⚠ Engine fallback: ${fallback}\x1b[0m`);
      cg.close();
    }
  });

// ── uninit / uninstall ────────────────────────────────────────────────────────

const UNINIT_FAREWELLS = [
  "Oh. So it's come to this.",
  "We're sorry to see you go. (Are we? Yes. We are.)",
  "Deleting months of carefully indexed knowledge. Bold move.",
  "Fine. We'll just sit here in the dark.",
  "You can always come back. We won't mention this.",
  "The graph remembers everything. Except, soon, anything.",
  "Somewhere a tree-sitter is crying.",
  "Uninstalling... and pretending it doesn't hurt.",
  "574 embeddings. Gone. Just like that.",
  "See you on the other side of `kirograph install`.",
];

async function runUninit(projectPath: string | undefined, opts: { force?: boolean }): Promise<void> {
  const target = path.resolve(projectPath ?? process.cwd());
  const dir = path.join(target, '.kirograph');
  if (!fs.existsSync(dir)) { console.log('Not initialized.'); return; }
  if (!opts.force) {
    printBanner();
    const farewell = UNINIT_FAREWELLS[Math.floor(Math.random() * UNINIT_FAREWELLS.length)]!;
    console.log(`  ${violet}${bold}${farewell}${reset}`);
    console.log(`\n  ${dim}This will remove .kirograph/, all Kiro hooks, and the steering file.${reset}`);
    console.log(`  ${dim}Your source code is untouched.${reset}\n`);
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>(resolve => rl.question(`  ${violet}Remove KiroGraph from this project?${reset} ${dim}(y/N)${reset} `, ans => {
      rl.close();
      if (ans.toLowerCase() !== 'y') {
        console.log(`\n  ${dim}Cancelled. The graph lives on.${reset}\n`);
        process.exit(0);
      }
      resolve();
    }));
    console.log();
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`  ${green}✓${reset} Removed .kirograph/`);

  // Remove .kiro hooks created by kirograph
  const kiroHooks = [
    'kirograph-mark-dirty-on-save.json',
    'kirograph-mark-dirty-on-create.json',
    'kirograph-sync-on-delete.json',
    'kirograph-sync-if-dirty.json',
    'kirograph-sync-on-save.json',
    'kirograph-sync-on-create.json',
  ];
  const hooksDir = path.join(target, '.kiro', 'hooks');
  let removedHooks = 0;
  for (const hook of kiroHooks) {
    const p = path.join(hooksDir, hook);
    if (fs.existsSync(p)) { fs.unlinkSync(p); removedHooks++; }
  }
  if (removedHooks > 0) console.log(`  ${green}✓${reset} Removed ${removedHooks} hook(s) from .kiro/hooks/`);

  // Remove .kiro/steering/kirograph.md
  const steeringPath = path.join(target, '.kiro', 'steering', 'kirograph.md');
  if (fs.existsSync(steeringPath)) {
    fs.unlinkSync(steeringPath);
    console.log(`  ${green}✓${reset} Removed .kiro/steering/kirograph.md`);
  }

  console.log(`\n  ${dim}Done. Run ${violet}kirograph install${reset}${dim} to come back anytime.${reset}\n`);
}

program
  .command('uninit [projectPath]')
  .description('Remove KiroGraph from a project')
  .option('--force', 'Skip confirmation')
  .action(runUninit);

program
  .command('uninstall [projectPath]')
  .description('Alias for uninit — remove KiroGraph from a project')
  .option('--force', 'Skip confirmation')
  .action(runUninit);

// ── index ─────────────────────────────────────────────────────────────────────
program
  .command('index [projectPath]')
  .description('Full index of a project')
  .option('--force', 'Force re-index all files')
  .action(async (projectPath: string | undefined, opts: { force?: boolean }) => {
    const KiroGraph = (await import('../index')).default;
    const target = path.resolve(projectPath ?? process.cwd());
    const cg = await KiroGraph.open(target);
    const result = await cg.indexAll({
      force: opts.force,
      onProgress: renderIndexProgress,
    });
    process.stdout.write('\n');
    console.log(`  ${green}✓${reset} ${value(String(result.filesIndexed))} ${dim}files,${reset} ${value(String(result.nodesCreated))} ${dim}symbols,${reset} ${value(String(result.edgesCreated))} ${dim}edges${reset} ${dim}(${result.duration}ms)${reset}`);
    if (result.errors.length) console.warn(`  \x1b[33m⚠ ${result.errors.length} warning(s)\x1b[0m`);
    const fallback = cg.getEngineFallback();
    if (fallback) console.warn(`  \x1b[33m⚠ Engine fallback: ${fallback}\x1b[0m`);
    cg.close();
  });

// ── sync ──────────────────────────────────────────────────────────────────────
program
  .command('sync [projectPath]')
  .description('Incremental sync of changed files')
  .option('--files <files...>', 'Specific files to sync')
  .action(async (projectPath: string | undefined, opts: { files?: string[] }) => {
    const KiroGraph = (await import('../index')).default;
    const target = path.resolve(projectPath ?? process.cwd());
    const cg = await KiroGraph.open(target);
    const result = await cg.sync(opts.files);
    const changed = result.added.length + result.modified.length + result.removed.length;
    if (changed === 0) {
      console.log(`  ${dim}Nothing to sync.${reset}`);
    } else {
      console.log(`  ${green}✓${reset} ${dim}added${reset} ${value(String(result.added.length))}  ${dim}modified${reset} ${value(String(result.modified.length))}  ${dim}removed${reset} ${value(String(result.removed.length))}  ${dim}(${result.duration}ms)${reset}`);
    }
    if (result.errors.length) console.warn(`  \x1b[33m⚠ ${result.errors.length} warning(s)\x1b[0m`);
    const fallback = cg.getEngineFallback();
    if (fallback) console.warn(`  \x1b[33m⚠ Engine fallback: ${fallback}\x1b[0m`);
    cg.close();
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command('status [projectPath]')
  .description('Show index statistics')
  .action(async (projectPath: string | undefined) => {
    const KiroGraph = (await import('../index')).default;
    const target = path.resolve(projectPath ?? process.cwd());
    const cg = await KiroGraph.open(target);
    const stats = await cg.getStats();

    console.log();
    console.log(section('  Graph'));
    console.log(`  ${label('Files')}      ${value(String(stats.files))}`);
    console.log(`  ${label('Symbols')}    ${value(String(stats.nodes))}`);
    console.log(`  ${label('Edges')}      ${value(String(stats.edges))}`);

    if (stats.frameworks.length > 0) {
      console.log(`  ${label('Frameworks')} ${value(stats.frameworks.join(', '))}`);
    }

    const kindEntries = Object.entries(stats.nodesByKind).sort((a, b) => b[1] - a[1]);
    if (kindEntries.length > 0) {
      console.log(`\n  ${label('By kind')}`);
      console.log(renderTable(kindEntries.map(([k, v]) => [k, String(v)])));
    }

    const langEntries = Object.entries(stats.filesByLanguage ?? {}).sort((a, b) => b[1] - a[1]);
    if (langEntries.length > 0) {
      console.log(`\n  ${label('By language')}`);
      console.log(renderTable(langEntries.map(([k, v]) => [k, String(v)])));
    }

    console.log();
    console.log(section('  Semantic Search'));
    if (stats.embeddingsEnabled) {
      const engineLabel =
        stats.semanticEngine === 'sqlite-vec' ? `sqlite-vec  ${dim}(${stats.vecIndexCount} entries in ANN index)${reset}` :
        stats.semanticEngine === 'orama'      ? `orama  ${dim}(hybrid — ${stats.vecIndexCount} docs in index)${reset}` :
        stats.semanticEngine === 'pglite'     ? `pglite+pgvector  ${dim}(hybrid — ${stats.vecIndexCount} rows in DB)${reset}` :
        `in-process cosine`;
      const total = stats.embeddableNodeCount > 0 ? stats.embeddableNodeCount : stats.nodes;
      const displayed = Math.min(stats.embeddingCount, total);
      const coverage = total > 0 ? Math.min(100, Math.round((stats.embeddingCount / total) * 100)) : 0;
      console.log(`  ${label('Status')}     ${green}${bold}enabled${reset}`);
      console.log(`  ${label('Model')}      ${value(stats.embeddingModel)}`);
      console.log(`  ${label('Engine')}     ${violet}${engineLabel}${reset}`);
      if (stats.engineFallback) {
        console.log(`  ${'\x1b[33m'}⚠ engine fallback: ${stats.engineFallback}${reset}`);
      }
      console.log(`  ${label('Indexed')}    ${value(`${displayed} / ${total}`)}  ${dim}(${coverage}%)${reset}`);
    } else {
      console.log(`  ${label('Status')}     ${dim}disabled${reset}`);
    }

    console.log();
    cg.close();
  });

// ── query ─────────────────────────────────────────────────────────────────────
program
  .command('query <search>')
  .description('Search for symbols')
  .option('--kind <kind>', 'Filter by kind')
  .option('--limit <n>', 'Max results', '10')
  .action(async (search: string, opts: { kind?: string; limit: string }) => {
    const KiroGraph = (await import('../index')).default;
    const cg = await KiroGraph.open(process.cwd());
    const results = cg.searchNodes(search, opts.kind as any, parseInt(opts.limit));
    if (results.length === 0) {
      console.log(`  ${dim}No results for${reset} ${violet}${bold}${search}${reset}`);
    } else {
      console.log();
      for (const r of results) {
        console.log(`  ${violet}${bold}${r.node.name}${reset}  ${dim}${r.node.kind}${reset}  ${dim}${r.node.filePath}:${r.node.startLine}${reset}`);
      }
      console.log(`\n  ${dim}${results.length} result(s)${reset}`);
    }
    cg.close();
  });

// ── files ─────────────────────────────────────────────────────────────────────
program
  .command('files [projectPath]')
  .description('Show project file structure from the index')
  .option('--format <fmt>', 'Output format: tree, flat, grouped', 'tree')
  .option('--filter <path>', 'Filter by directory prefix')
  .option('--pattern <glob>', 'Filter by glob pattern')
  .option('--max-depth <n>', 'Limit tree depth')
  .option('--no-metadata', 'Hide language/symbol counts')
  .option('--json', 'Output as JSON')
  .action(async (projectPath: string | undefined, opts: {
    format: string; filter?: string; pattern?: string;
    maxDepth?: string; metadata: boolean; json?: boolean;
  }) => {
    const KiroGraph = (await import('../index')).default;
    const target = path.resolve(projectPath ?? process.cwd());
    const cg = await KiroGraph.open(target);
    const tree = cg.getFiles({
      filterPath: opts.filter,
      pattern: opts.pattern,
      maxDepth: opts.maxDepth ? parseInt(opts.maxDepth) : undefined,
    });

    if (opts.json) { console.log(JSON.stringify(tree, null, 2)); cg.close(); return; }

    if (opts.format === 'flat') {
      printFlat(tree, opts.metadata);
    } else if (opts.format === 'grouped') {
      printGrouped(tree, opts.metadata);
    } else {
      printTree(tree, '', opts.metadata);
    }
    cg.close();
  });

function printTree(nodes: import('../index').FileTreeNode[], prefix: string, metadata: boolean): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    const meta = metadata && node.type === 'file' && node.language
      ? `  \x1b[90m[${node.language}${node.symbolCount ? ` · ${node.symbolCount} symbols` : ''}]\x1b[0m`
      : '';
    console.log(`${prefix}${connector}${node.name}${meta}`);
    if (node.children?.length) printTree(node.children, childPrefix, metadata);
  }
}

function printFlat(nodes: import('../index').FileTreeNode[], metadata: boolean, _prefix = ''): void {
  for (const node of nodes) {
    if (node.type === 'file') {
      const meta = metadata && node.language ? `  \x1b[90m[${node.language}]\x1b[0m` : '';
      console.log(`${node.path}${meta}`);
    }
    if (node.children) printFlat(node.children, metadata);
  }
}

function printGrouped(nodes: import('../index').FileTreeNode[], metadata: boolean): void {
  const byLang = new Map<string, string[]>();
  function collect(ns: import('../index').FileTreeNode[]): void {
    for (const n of ns) {
      if (n.type === 'file' && n.language) {
        const arr = byLang.get(n.language) ?? [];
        arr.push(n.path);
        byLang.set(n.language, arr);
      }
      if (n.children) collect(n.children);
    }
  }
  collect(nodes);
  for (const [lang, files] of byLang) {
    console.log(`\n  ${violet}${bold}${lang}${reset}  ${dim}(${files.length})${reset}`);
    for (const f of files) console.log(`  ${dim}${f}${reset}`);
  }
}

// ── context ───────────────────────────────────────────────────────────────────
program
  .command('context <task>')
  .description('Build relevant code context for a task')
  .option('--max-nodes <n>', 'Max symbols to include', '20')
  .option('--no-code', 'Exclude code snippets')
  .option('--format <fmt>', 'Output format: markdown, json', 'markdown')
  .action(async (task: string, opts: { maxNodes: string; code: boolean; format: string }) => {
    const KiroGraph = (await import('../index')).default;
    const cg = await KiroGraph.open(process.cwd());
    const ctx = await cg.buildContext(task, {
      maxNodes: parseInt(opts.maxNodes),
      includeCode: opts.code,
    });

    if (opts.format === 'json') {
      console.log(JSON.stringify({
        task: ctx.task,
        summary: ctx.summary,
        entryPoints: ctx.entryPoints.map(n => ({ kind: n.kind, name: n.name, file: n.filePath, line: n.startLine })),
        relatedNodes: ctx.relatedNodes.map(n => ({ kind: n.kind, name: n.name, file: n.filePath, line: n.startLine })),
        codeSnippets: Object.fromEntries(ctx.codeSnippets),
      }, null, 2));
      cg.close(); return;
    }

    // Markdown output
    console.log(`\n  ${section('Context:')} ${violet}${bold}${ctx.task}${reset}\n`);
    console.log(`  ${dim}${ctx.summary}${reset}`);
    if (ctx.entryPoints.length > 0) {
      console.log(`\n  ${section('Entry Points')}\n`);
      for (const n of ctx.entryPoints) {
        console.log(`  ${violet}${bold}${n.name}${reset}  ${dim}${n.kind}  ${n.filePath}:${n.startLine}${reset}`);
        if (ctx.codeSnippets.has(n.id)) {
          console.log(`\n  ${dim}\`\`\`${reset}`);
          for (const line of (ctx.codeSnippets.get(n.id) ?? '').split('\n')) {
            console.log(`  ${line}`);
          }
          console.log(`  ${dim}\`\`\`${reset}\n`);
        }
      }
    }
    if (ctx.relatedNodes.length > 0) {
      console.log(`\n  ${section('Related Symbols')}\n`);
      for (const n of ctx.relatedNodes) {
        console.log(`  ${dim}·${reset} ${violet}${n.name}${reset}  ${dim}${n.kind}  ${n.filePath}:${n.startLine}${reset}`);
      }
      console.log();
    }
    cg.close();
  });

// ── affected ──────────────────────────────────────────────────────────────────
program
  .command('affected [files...]')
  .description('Find test files affected by changed source files')
  .option('--stdin', 'Read file list from stdin (one per line)')
  .option('-d, --depth <n>', 'Max dependency traversal depth', '5')
  .option('-f, --filter <glob>', 'Custom glob to identify test files')
  .option('-j, --json', 'Output as JSON')
  .option('-q, --quiet', 'Output file paths only')
  .option('-p, --path <path>', 'Project path')
  .action(async (files: string[], opts: {
    stdin?: boolean; depth: string; filter?: string;
    json?: boolean; quiet?: boolean; path?: string;
  }) => {
    const KiroGraph = (await import('../index')).default;
    const target = path.resolve(opts.path ?? process.cwd());
    const cg = await KiroGraph.open(target);

    let changedFiles = [...files];

    if (opts.stdin) {
      const lines = fs.readFileSync('/dev/stdin', 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
      changedFiles.push(...lines);
    }

    if (changedFiles.length === 0) {
      console.error('No files provided. Pass files as arguments or use --stdin.');
      cg.close(); process.exit(1);
    }

    const affected = cg.getAffectedTests(changedFiles, {
      depth: parseInt(opts.depth),
      testPattern: opts.filter,
    });

    if (opts.json) {
      console.log(JSON.stringify({ changedFiles, affectedTests: affected }, null, 2));
    } else if (opts.quiet) {
      for (const f of affected) console.log(f);
    } else {
      if (affected.length === 0) {
        console.log(`  ${dim}No affected test files found.${reset}`);
      } else {
        console.log(`\n  ${section('Affected test files')}  ${dim}(${affected.length})${reset}\n`);
        for (const f of affected) console.log(`  ${violet}${bold}${f}${reset}`);
        console.log();
      }
    }
    cg.close();
  });

// ── mark-dirty ────────────────────────────────────────────────────────────────
program
  .command('mark-dirty [projectPath]')
  .description('Write a dirty marker to trigger deferred sync')
  .action(async (projectPath: string | undefined) => {
    const KiroGraph = (await import('../index')).default;
    const target = path.resolve(projectPath ?? process.cwd());
    if (!KiroGraph.isInitialized(target)) { process.exit(0); }
    const cg = await KiroGraph.open(target);
    cg.markDirty();
    cg.close();
  });

// ── sync-if-dirty ─────────────────────────────────────────────────────────────
program
  .command('sync-if-dirty [projectPath]')
  .description('Sync only if a dirty marker is present')
  .option('-q, --quiet', 'Suppress output')
  .action(async (projectPath: string | undefined, opts: { quiet?: boolean }) => {
    const KiroGraph = (await import('../index')).default;
    const target = path.resolve(projectPath ?? process.cwd());
    if (!KiroGraph.isInitialized(target)) { process.exit(0); }
    const cg = await KiroGraph.open(target);
    const result = await cg.syncIfDirty();
    if (!opts.quiet) {
      if (result) {
        const changed = result.added.length + result.modified.length + result.removed.length;
        if (changed === 0) {
          console.log(`  ${dim}Index up to date.${reset}`);
        } else {
          console.log(`  ${green}✓${reset} ${dim}added${reset} ${value(String(result.added.length))}  ${dim}modified${reset} ${value(String(result.modified.length))}  ${dim}removed${reset} ${value(String(result.removed.length))}  ${dim}(${result.duration}ms)${reset}`);
        }
        if (result.errors.length) console.warn(`  \x1b[33m⚠ ${result.errors.length} warning(s)\x1b[0m`);
        const fallback = cg.getEngineFallback();
        if (fallback) console.warn(`  \x1b[33m⚠ Engine fallback: ${fallback}\x1b[0m`);
      } else {
        console.log(`  ${dim}Not dirty, skipped.${reset}`);
      }
    }
    cg.close();
  });

// ── unlock ────────────────────────────────────────────────────────────────────
program
  .command('unlock [projectPath]')
  .description('Force-release a stale KiroGraph lock file')
  .action(async (projectPath: string | undefined) => {
    const lockPath = path.join(path.resolve(projectPath ?? process.cwd()), '.kirograph', 'kirograph.lock');
    if (!fs.existsSync(lockPath)) {
      console.log(`  ${dim}No lock file found.${reset}`);
      return;
    }
    const content = fs.readFileSync(lockPath, 'utf8').trim();
    fs.unlinkSync(lockPath);
    console.log(`  ${green}✓${reset} Lock released ${dim}(was held by: ${content})${reset}`);
  });

// ── install ───────────────────────────────────────────────────────────────────
program
  .command('install')
  .description('Configure KiroGraph for the current Kiro workspace')
  .action(async () => {
    const { runInstaller } = await import('../installer/index');
    await runInstaller();
  });

// ── serve ─────────────────────────────────────────────────────────────────────
program
  .command('serve')
  .description('Start the MCP server')
  .option('--mcp', 'Run as MCP stdio server')
  .option('--path <path>', 'Project path')
  .action(async (opts: { mcp?: boolean; path?: string }) => {
    if (!opts.mcp) {
      console.log(`\n  ${dim}Start the KiroGraph MCP server for Kiro.${reset}`);
      console.log(`\n  ${dim}Usage:${reset}  ${violet}${bold}kirograph serve --mcp${reset}`);
      console.log(`\n  ${dim}Add to${reset} ${violet}${bold}.kiro/settings/mcp.json${reset}${dim}:${reset}\n`);
      console.log(`  ${dim}${JSON.stringify({ mcpServers: { kirograph: { command: 'kirograph', args: ['serve', '--mcp'] } } }, null, 2).split('\n').join('\n  ')}${reset}\n`);
      return;
    }
    const { MCPServer } = await import('../mcp/server');
    const server = new MCPServer(opts.path ? path.resolve(opts.path) : process.cwd());
    await server.start();
  });

// ── Colored help renderer ─────────────────────────────────────────────────────
function printColoredHelp(): void {
  const c = {
    reset:        '\x1b[0m',
    bold:         '\x1b[1m',
    dim:          '\x1b[2m',
    violet:       '\x1b[38;5;99m',   // dark violet  — command names, $ prompt
    purple:       '\x1b[38;5;135m',  // medium purple — flags/options
    lavender:     '\x1b[38;5;141m',  // light purple  — usage keyword
    paleLavender: '\x1b[38;5;183m',  // pale lavender — section headers
    gray:         '\x1b[90m',
    white:        '\x1b[97m',
  };

  const commands: Array<{ name: string; args?: string; desc: string; opts?: string[] }> = [
    { name: 'install',       desc: 'Configure KiroGraph for the current Kiro workspace' },
    { name: 'init',          args: '[path]',    desc: 'Initialize KiroGraph in a project', opts: ['-i, --index  Index immediately after init'] },
    { name: 'uninit',        args: '[path]',    desc: 'Remove KiroGraph from a project',   opts: ['--force     Skip confirmation'] },
    { name: 'uninstall',     args: '[path]',    desc: 'Alias for uninit',                  opts: ['--force     Skip confirmation'] },
    { name: 'index',         args: '[path]',    desc: 'Full re-index of a project',        opts: ['--force     Force re-index all files'] },
    { name: 'sync',          args: '[path]',    desc: 'Incremental sync of changed files', opts: ['--files <f> Specific files to sync'] },
    { name: 'sync-if-dirty', args: '[path]',    desc: 'Sync only if a dirty marker is present', opts: ['-q, --quiet  Suppress output'] },
    { name: 'mark-dirty',    args: '[path]',    desc: 'Write a dirty marker for deferred sync' },
    { name: 'status',        args: '[path]',    desc: 'Show index statistics' },
    { name: 'query',         args: '<search>',  desc: 'Search for symbols',                opts: ['--kind <k>  Filter by kind', '--limit <n> Max results (default 10)'] },
    { name: 'context',       args: '<task>',    desc: 'Build relevant code context for a task', opts: ['--max-nodes <n>  Max symbols (default 20)', '--no-code        Exclude code snippets', '--format <fmt>   markdown | json'] },
    { name: 'files',         args: '[path]',    desc: 'Show project file structure from the index', opts: ['--format <fmt>   tree | flat | grouped', '--filter <path>  Filter by directory prefix', '--pattern <glob> Filter by glob', '--max-depth <n>  Limit tree depth', '--json           Output as JSON'] },
    { name: 'affected',      args: '[files...]', desc: 'Find test files affected by changed source files', opts: ['--stdin      Read file list from stdin', '-d, --depth <n>  Max traversal depth (default 5)', '-f, --filter <g> Custom glob for test files', '-j, --json       Output as JSON', '-q, --quiet      File paths only'] },
    { name: 'unlock',        args: '[path]',    desc: 'Force-release a stale lock file' },
    { name: 'serve',         desc: 'Start the MCP server',                                opts: ['--mcp        Run as MCP stdio server', '--path <p>   Project path'] },
  ];

  console.log(`\n${c.bold}${c.paleLavender}USAGE${c.reset}`);
  console.log(`  ${c.lavender}kirograph${c.reset} ${c.gray}<command>${c.reset} ${c.dim}[options]${c.reset}\n`);

  console.log(`${c.bold}${c.paleLavender}COMMANDS${c.reset}\n`);

  const nameWidth = Math.max(...commands.map(cmd => (cmd.name + (cmd.args ? ' ' + cmd.args : '')).length)) + 2;

  for (const cmd of commands) {
    const signature = cmd.name + (cmd.args ? ' ' + cmd.args : '');
    const namePart = `${c.lavender}${cmd.name}${c.reset}${cmd.args ? ' ' + c.dim + cmd.args + c.reset : ''}`;
    const pad = ' '.repeat(Math.max(0, nameWidth - signature.length));
    console.log(`  ${namePart}${pad}${c.gray}${cmd.desc}${c.reset}`);
    if (cmd.opts) {
      for (const opt of cmd.opts) {
        const [flag, ...rest] = opt.split(/  +/);
        const optPad = ' '.repeat(nameWidth + 2);
        console.log(`  ${optPad}${c.purple}${flag}${c.reset}${rest.length ? '  ' + c.dim + rest.join('  ') + c.reset : ''}`);
      }
      console.log();
    }
  }

  console.log(`${c.bold}${c.paleLavender}GLOBAL FLAGS${c.reset}\n`);
  console.log(`  ${c.purple}-h, --help${c.reset}     ${c.gray}Show this help${c.reset}`);
  console.log(`  ${c.purple}-V, --version${c.reset}  ${c.gray}Show version number${c.reset}`);
  console.log();

  console.log(`${c.bold}${c.paleLavender}EXAMPLES${c.reset}\n`);
  const examples = [
    ['kirograph install',                              'Wire up MCP + hooks + steering for the current workspace'],
    ['kirograph init --index',                         'Init and immediately index the project'],
    ['kirograph query useState',                       'Find all symbols named useState'],
    ['kirograph context "add dark mode"',              'Get relevant code context for a task'],
    ['kirograph affected src/auth.ts',                 'Find tests affected by a change'],
    ['git diff --name-only | kirograph affected --stdin', 'Affected tests from a git diff'],
    ['kirograph files --format grouped',               'Show files grouped by language'],
    ['kirograph serve --mcp',                          'Start the MCP server'],
  ];
  for (const [ex, desc] of examples) {
    console.log(`  ${c.violet}$${c.reset} ${c.lavender}${ex}${c.reset}`);
    console.log(`    ${c.dim}${desc}${c.reset}`);
  }
  console.log();
}

// Show banner + help when called with no arguments, otherwise parse normally
if (process.argv.length === 2) {
  printBanner();
  printColoredHelp();
  process.exit(0);
}

// Override --help / help command with colored output
program.configureHelp({ formatHelp: () => '' });
program.addHelpText('afterAll', '');
const originalHelp = program.helpInformation.bind(program);
program.helpInformation = () => {
  printBanner();
  printColoredHelp();
  return '';
};

program.parse(process.argv);

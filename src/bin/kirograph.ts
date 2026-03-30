#!/usr/bin/env node
/**
 * KiroGraph CLI
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { printBanner } from '../banner';

const program = new Command();

program
  .name('kirograph')
  .description('Semantic code knowledge graph for Kiro')
  .version('0.1.0')
  .addHelpCommand(true)
  .hook('preAction', (thisCommand) => {
    const name = thisCommand.name();
    if (name === 'install' || name === 'init') printBanner();
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
      console.log('KiroGraph already initialized.');
    } else {
      await KiroGraph.init(target);
      console.log(`Initialized .kirograph/ in ${target}`);
    }
    if (opts.index) {
      const cg = await KiroGraph.open(target);
      console.log('Indexing...');
      const result = await cg.indexAll({
        force: true,
        onProgress: p => process.stdout.write(`\r  ${p.phase} ${p.current}/${p.total}   `),
      });
      process.stdout.write('\n');
      console.log(`Done. ${result.filesIndexed} files, ${result.nodesCreated} symbols, ${result.edgesCreated} edges.`);
      if (result.errors.length) console.warn(`Warnings: ${result.errors.length}`);
      cg.close();
    }
  });

// ── uninit ────────────────────────────────────────────────────────────────────
program
  .command('uninit [projectPath]')
  .description('Remove KiroGraph from a project')
  .option('--force', 'Skip confirmation')
  .action(async (projectPath: string | undefined, opts: { force?: boolean }) => {
    const target = path.resolve(projectPath ?? process.cwd());
    const dir = path.join(target, '.kirograph');
    if (!fs.existsSync(dir)) { console.log('Not initialized.'); return; }
    if (!opts.force) {
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await new Promise<void>(resolve => rl.question('Remove .kirograph/? (y/N) ', ans => {
        rl.close();
        if (ans.toLowerCase() !== 'y') { console.log('Cancelled.'); process.exit(0); }
        resolve();
      }));
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('Removed .kirograph/');
  });

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
      onProgress: p => process.stdout.write(`\r  ${p.phase} ${p.current}/${p.total}   `),
    });
    process.stdout.write('\n');
    console.log(`Indexed ${result.filesIndexed} files, ${result.nodesCreated} symbols in ${result.duration}ms`);
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
    console.log(`Sync: +${result.added.length} ~${result.modified.length} -${result.removed.length} (${result.duration}ms)`);
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
    const stats = cg.getStats();
    console.log(`Files: ${stats.files}  Symbols: ${stats.nodes}  Edges: ${stats.edges}`);
    console.log('By kind:', Object.entries(stats.nodesByKind).map(([k, v]) => `${k}=${v}`).join(', '));
    if (stats.filesByLanguage && Object.keys(stats.filesByLanguage).length > 0) {
      console.log('By language:', Object.entries(stats.filesByLanguage).map(([k, v]) => `${k}=${v}`).join(', '));
    }
    console.log('Frameworks:', stats.frameworks.length > 0 ? stats.frameworks.join(', ') : 'none detected');
    const semanticLine = stats.embeddingsEnabled
      ? `Semantic search: enabled (${stats.embeddingCount} embeddings / ${stats.nodes} symbols)`
      : `Semantic search: disabled`;
    console.log(semanticLine);
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
    if (results.length === 0) { console.log('No results.'); } else {
      for (const r of results) {
        console.log(`${r.node.kind} ${r.node.name}  ${r.node.filePath}:${r.node.startLine}`);
      }
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
    console.log(`\n\x1b[1m${lang}\x1b[0m (${files.length})`);
    for (const f of files) console.log(`  ${f}`);
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
    console.log(`# Context: ${ctx.task}\n`);
    console.log(ctx.summary);
    if (ctx.entryPoints.length > 0) {
      console.log('\n## Entry Points\n');
      for (const n of ctx.entryPoints) {
        console.log(`### \`${n.name}\` (${n.kind}) — ${n.filePath}:${n.startLine}`);
        if (ctx.codeSnippets.has(n.id)) {
          console.log('```');
          console.log(ctx.codeSnippets.get(n.id));
          console.log('```');
        }
      }
    }
    if (ctx.relatedNodes.length > 0) {
      console.log('\n## Related Symbols\n');
      for (const n of ctx.relatedNodes) {
        console.log(`- \`${n.name}\` (${n.kind}) — ${n.filePath}:${n.startLine}`);
      }
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
        console.log('No affected test files found.');
      } else {
        console.log(`\nAffected test files (${affected.length}):\n`);
        for (const f of affected) console.log(`  ${f}`);
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
        console.log(`Sync: +${result.added.length} ~${result.modified.length} -${result.removed.length} (${result.duration}ms)`);
      } else {
        console.log('Not dirty, skipped.');
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
      console.log('No lock file found.');
      return;
    }
    const content = fs.readFileSync(lockPath, 'utf8').trim();
    fs.unlinkSync(lockPath);
    console.log(`Lock released (was held by: ${content}).`);
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
      console.log('Usage: kirograph serve --mcp');
      console.log('Add to .kiro/settings/mcp.json:');
      console.log(JSON.stringify({
        mcpServers: {
          kirograph: { command: 'kirograph', args: ['serve', '--mcp'] }
        }
      }, null, 2));
      return;
    }
    const { MCPServer } = await import('../mcp/server');
    const server = new MCPServer(opts.path ? path.resolve(opts.path) : process.cwd());
    await server.start();
  });

// Show banner + help when called with no arguments, otherwise parse normally
if (process.argv.length === 2) {
  printBanner();
  program.outputHelp();
  process.exit(0);
}

program.parse(process.argv);

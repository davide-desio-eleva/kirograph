import { Command } from 'commander';
import * as path from 'path';
import { loadConfig } from '../../config';
import { dim, reset, violet, bold, green, value } from '../ui';

/** Safely close KiroGraph and exit cleanly. */
function safeCloseAndExit(cg: any, code = 0): never {
  try { cg.close(); } catch { /* ignore */ }
  // Suppress any post-exit WASM crash output and exit cleanly
  try {
    const fs = require('fs');
    // Flush stdout/stderr, then close fd 2 to suppress libc++abi messages
    if (process.stdout.writableEnded === false) process.stdout.write('');
    if (process.stderr.writableEnded === false) process.stderr.write('');
    fs.closeSync(2);
    fs.closeSync(1);
  } catch { /* ignore */ }
  process.exit(code);
}

export function register(program: Command): void {
  const docs = program
    .command('docs')
    .description('Documentation navigation (requires enableDocs: true)');

  // ── toc ─────────────────────────────────────────────────────────────────────
  docs
    .command('toc [file]')
    .description('Print table of contents for a file or the whole project')
    .option('--tree', 'Show nested tree structure')
    .option('--json', 'Output as JSON')
    .action(async (file: string | undefined, opts: { tree?: boolean; json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableDocs) {
        console.error(`  ✖ Documentation indexing is not enabled. Set ${violet}${bold}enableDocs: true${reset} in .kirograph/config.json`);
        console.error(`  ${dim}Then re-run:${reset} ${violet}${bold}kirograph index${reset}`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized. Run: kirograph init'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDocsSchema();

      const { DocsQueries } = await import('../../docs/queries');
      const queries = new DocsQueries(db.getRawDb(), cwd);
      const toc = queries.getToc({ file, tree: opts.tree });

      if (toc.length === 0) {
        console.log(`  ${dim}No documentation sections found.${reset} Run ${violet}${bold}kirograph index${reset} first.`);
        cg.close(); return;
      }

      if (opts.json) {
        console.log(JSON.stringify(toc, null, 2));
      } else {
        for (const entry of toc) {
          const prefix = '#'.repeat(entry.level || 1);
          const summary = entry.summary ? ` ${dim}— ${entry.summary}${reset}` : '';
          console.log(`  ${prefix} ${bold}${entry.title}${reset}${summary}`);
          console.log(`    ${dim}${entry.id}${reset}`);
        }
      }
      cg.close();
    });

  // ── search ──────────────────────────────────────────────────────────────────
  docs
    .command('search <query>')
    .description('Search documentation sections')
    .option('--file <path>', 'Narrow search to a specific file')
    .option('--limit <n>', 'Max results', '10')
    .option('--json', 'Output as JSON')
    .action(async (query: string, opts: { file?: string; limit?: string; json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableDocs) {
        console.error(`  ✖ Documentation indexing is not enabled. Set ${violet}${bold}enableDocs: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDocsSchema();

      const { DocsQueries } = await import('../../docs/queries');
      const queries = new DocsQueries(db.getRawDb(), cwd, config);
      const results = await queries.searchSections(query, { file: opts.file, limit: parseInt(opts.limit ?? '10', 10) });

      if (results.length === 0) {
        console.log(`  ${dim}No sections found matching "${query}".${reset}`);
        cg.close(); return;
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const r of results) {
          const summary = r.section.summary ? `\n    ${dim}${r.section.summary}${reset}` : '';
          console.log(`  ${green}●${reset} ${bold}${r.section.title}${reset} ${dim}[${r.section.filePath}]${reset}${summary}`);
          console.log(`    ${dim}ID: ${r.section.id}${reset}`);
        }
      }
      cg.close();
    });

  // ── section ─────────────────────────────────────────────────────────────────
  docs
    .command('section <id>')
    .description('Print full content of a section by ID')
    .option('--context', 'Include ancestor headings and child summaries')
    .action(async (id: string, opts: { context?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableDocs) {
        console.error(`  ✖ Documentation indexing is not enabled. Set ${violet}${bold}enableDocs: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDocsSchema();

      const { DocsQueries } = await import('../../docs/queries');
      const queries = new DocsQueries(db.getRawDb(), cwd);
      const result = queries.getSection(id, { context: opts.context });

      if (!result) {
        // Suggest similar section IDs
        const rawDb = db.getRawDb();
        const idParts = id.split('::');
        const filePath = idParts[0] ?? '';
        const searchSlug = (idParts[1] ?? '').replace(/#\d+$/, '').split('/').pop() ?? '';

        let suggestions: Array<{ id: string; title: string }> = [];
        if (searchSlug) {
          suggestions = rawDb.all(
            `SELECT id, title FROM doc_sections WHERE file_path = ? AND id LIKE ? LIMIT 5`,
            [filePath, `%${searchSlug}%`],
          ) as Array<{ id: string; title: string }>;
        }
        if (suggestions.length === 0 && filePath) {
          suggestions = rawDb.all(
            `SELECT id, title FROM doc_sections WHERE file_path = ? ORDER BY position LIMIT 5`,
            [filePath],
          ) as Array<{ id: string; title: string }>;
        }

        console.error(`  ✖ Section "${id}" not found.`);
        if (suggestions.length > 0) {
          console.error(`\n  ${dim}Did you mean:${reset}`);
          for (const s of suggestions) {
            console.error(`    ${s.id}  ${dim}(${s.title})${reset}`);
          }
        } else {
          console.error(`\n  ${dim}Use ${violet}kirograph docs toc${reset}${dim} to list available section IDs.${reset}`);
        }
        safeCloseAndExit(cg, 1);
      }

      if (result.ancestors?.length) {
        console.log(`  ${dim}${result.ancestors.map(a => a.title).join(' > ')} > ${result.section.title}${reset}\n`);
      }

      console.log(result.content);

      if (result.children?.length) {
        console.log(`\n  ${dim}Child sections:${reset}`);
        for (const child of result.children) {
          const summary = child.summary ? ` — ${child.summary}` : '';
          console.log(`    ${dim}•${reset} ${child.title}${summary}`);
        }
      }
      cg.close();
    });

  // ── outline ─────────────────────────────────────────────────────────────────
  docs
    .command('outline <file>')
    .description('Print heading hierarchy for a document')
    .action(async (file: string) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableDocs) {
        console.error(`  ✖ Documentation indexing is not enabled. Set ${violet}${bold}enableDocs: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDocsSchema();

      const { DocsQueries } = await import('../../docs/queries');
      const queries = new DocsQueries(db.getRawDb(), cwd);
      const outline = queries.getOutline(file);

      if (outline.length === 0) {
        console.log(`  ${dim}No sections found in "${file}".${reset}`);
        cg.close(); return;
      }

      console.log(`\n  ${bold}${file}${reset}\n`);
      const render = (entries: any[], indent: string) => {
        for (const entry of entries) {
          const summary = entry.summary ? ` ${dim}— ${entry.summary}${reset}` : '';
          console.log(`${indent}  ${'#'.repeat(entry.level || 1)} ${entry.title}${summary}`);
          if (entry.children?.length) render(entry.children, indent + '  ');
        }
      };
      render(outline, '');
      cg.close();
    });

  // ── refs ────────────────────────────────────────────────────────────────────
  docs
    .command('refs <id>')
    .description('Show code ↔ doc cross-references')
    .action(async (id: string) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableDocs) {
        console.error(`  ✖ Documentation indexing is not enabled. Set ${violet}${bold}enableDocs: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDocsSchema();

      const { DocsQueries } = await import('../../docs/queries');
      const queries = new DocsQueries(db.getRawDb(), cwd);

      // Try as section ID first, then as qualified name
      let refs = queries.getRefs({ sectionId: id });
      if (refs.length === 0) {
        refs = queries.getRefs({ qualifiedName: id });
      }

      if (refs.length === 0) {
        console.log(`  ${dim}No cross-references found for "${id}".${reset}`);
        cg.close(); return;
      }

      for (const r of refs) {
        console.log(`  [${r.refType}] ${r.qualifiedName} ${dim}(confidence: ${r.confidence.toFixed(2)})${reset}`);
      }
      cg.close();
    });

  // ── reindex ─────────────────────────────────────────────────────────────────
  docs
    .command('reindex')
    .description('Force re-index all documentation files')
    .action(async () => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableDocs) {
        console.error(`  ✖ Documentation indexing is not enabled. Set ${violet}${bold}enableDocs: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDocsSchema();

      const { DocsIndexer } = await import('../../docs/indexer');
      const indexer = new DocsIndexer(db.getRawDb(), config, cwd);

      console.log(`  ${dim}Re-indexing documentation...${reset}`);
      const result = await indexer.indexAll({ force: true, onProgress: msg => console.log(`  ${dim}${msg}${reset}`) });

      console.log(`  ${green}✓${reset} ${value(String(result.filesIndexed))} ${dim}files,${reset} ${value(String(result.sectionsCreated))} ${dim}sections created,${reset} ${value(String(result.sectionsUpdated))} ${dim}updated,${reset} ${value(String(result.sectionsRemoved))} ${dim}removed${reset} ${dim}(${result.duration}ms)${reset}`);
      if (result.errors.length) {
        console.warn(`  \x1b[33m⚠ ${result.errors.length} error(s)\x1b[0m`);
        for (const err of result.errors.slice(0, 5)) console.warn(`    ${err}`);
      }
      cg.close();
    });

  // ── lint ────────────────────────────────────────────────────────────────────
  docs
    .command('lint')
    .description('Find broken refs, stale sections, FTS desync')
    .action(async () => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableDocs) {
        console.error(`  ✖ Documentation indexing is not enabled. Set ${violet}${bold}enableDocs: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDocsSchema();

      const { docsLint } = await import('../../docs/lint');
      const result = docsLint(db.getRawDb(), cwd);

      if (result.totalIssues === 0) {
        console.log(`  ${green}✓${reset} No issues found.`);
        cg.close(); return;
      }

      console.log(`  Found ${result.totalIssues} issue(s):\n`);

      if (result.brokenRefs.length > 0) {
        console.log(`  ${bold}Broken code refs:${reset} ${result.brokenRefs.length}`);
        for (const ref of result.brokenRefs.slice(0, 10)) {
          console.log(`    ${dim}${ref.sectionId} → ${ref.qualifiedName}${reset}`);
        }
        if (result.brokenRefs.length > 10) console.log(`    ${dim}…and ${result.brokenRefs.length - 10} more${reset}`);
      }

      if (result.staleSections.length > 0) {
        console.log(`  ${bold}Stale sections:${reset} ${result.staleSections.length}`);
        for (const s of result.staleSections.slice(0, 10)) {
          console.log(`    ${dim}${s.filePath} — ${s.id}${reset}`);
        }
        if (result.staleSections.length > 10) console.log(`    ${dim}…and ${result.staleSections.length - 10} more${reset}`);
      }

      if (result.ftsDesync) {
        console.log(`  ${bold}FTS desync:${reset} ${result.ftsDesync.sections} sections vs ${result.ftsDesync.ftsRows} FTS rows`);
      }

      if (result.orphanRefs > 0) {
        console.log(`  ${bold}Orphan refs:${reset} ${result.orphanRefs}`);
      }

      console.log(`\n  ${dim}Run ${violet}${bold}kirograph docs reindex${reset}${dim} to fix stale sections.${reset}`);
      cg.close();
    });

  // ── reembed ─────────────────────────────────────────────────────────────────
  docs
    .command('reembed')
    .description('Re-embed all doc sections with the current model')
    .action(async () => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableDocs) {
        console.error(`  ✖ Documentation indexing is not enabled. Set ${violet}${bold}enableDocs: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }
      if (!config.enableEmbeddings) {
        console.error(`  ✖ Embeddings are not enabled. Set ${violet}${bold}enableEmbeddings: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDocsSchema();

      const rawDb = db.getRawDb();
      const sections = rawDb.all('SELECT id, title, summary FROM doc_sections') as Array<{ id: string; title: string; summary: string | null }>;

      if (sections.length === 0) {
        console.log(`  ${dim}No doc sections to embed. Run ${violet}${bold}kirograph docs reindex${reset}${dim} first.${reset}`);
        cg.close(); return;
      }

      console.log(`  ${dim}Re-embedding ${sections.length} doc sections...${reset}`);
      const { DocsVectorManager } = await import('../../docs/vectors');
      const vectorMgr = new DocsVectorManager(config, rawDb);
      const embedded = await vectorMgr.reembed();
      console.log(`  ${green}✓${reset} Embedded ${value(String(embedded))} doc sections with model ${dim}${config.embeddingModel}${reset}`);
      cg.close();
    });
}

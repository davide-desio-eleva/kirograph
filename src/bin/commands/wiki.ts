/**
 * KiroGraph Wiki CLI
 *
 * kirograph wiki init
 * kirograph wiki ingest [source-file]
 * kirograph wiki apply-diff [diff-file]
 * kirograph wiki search <query>
 * kirograph wiki page <slug>
 * kirograph wiki list
 * kirograph wiki lint
 * kirograph wiki reindex
 * kirograph wiki status
 */

import { Command } from 'commander';
import * as fs from 'fs';
import { dim, reset, violet, bold, section, green } from '../ui';

const yellow = '\x1b[33m';

async function getWiki(cwd: string) {
  const { KiroGraphWiki } = await import('../../wiki/index');
  const { loadConfig } = await import('../../config');
  const KiroGraph = (await import('../../index')).default;

  if (!KiroGraph.isInitialized(cwd)) {
    console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
    process.exit(1);
  }
  const config = await loadConfig(cwd);
  if (!config.enableWiki) {
    console.error('  ✖ Wiki is not enabled. Set enableWiki: true in .kirograph/config.json');
    process.exit(1);
  }

  const cg = await KiroGraph.open(cwd);
  const db = cg.getDatabase();
  db.applyWikiSchema();

  const kirographDir = `${cwd}/.kirograph`;
  const wiki = new KiroGraphWiki(db.getRawDb(), kirographDir, {
    autoResolveConflicts: config.wikiAutoResolveConflicts,
  });
  wiki.initialize();
  return wiki;
}

function readStdinSync(): string {
  return fs.readFileSync('/dev/stdin', 'utf8');
}

export function register(program: Command): void {
  const wiki = program
    .command('wiki')
    .description('LLM-maintained structured wiki (requires enableWiki: true)');

  // ── init ───────────────────────────────────────────────────────────────────

  wiki
    .command('init')
    .description('Initialize wiki: create SCHEMA.md and MANIFEST.md in .kirograph/wiki/')
    .action(async () => {
      const { KiroGraphWiki } = await import('../../wiki/index');
      const KiroGraph = (await import('../../index')).default;
      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const { loadConfig } = await import('../../config');
      const config = await loadConfig(cwd);
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyWikiSchema();
      const w = new KiroGraphWiki(db.getRawDb(), `${cwd}/.kirograph`, {
        autoResolveConflicts: config.wikiAutoResolveConflicts,
      });
      w.initWiki();
      console.log(`\n  ${green}✓${reset}  Wiki initialized in ${dim}.kirograph/wiki/${reset}`);
      console.log(`  ${dim}Edit .kirograph/wiki/SCHEMA.md to customize naming and page structure.${reset}\n`);
    });

  // ── ingest ─────────────────────────────────────────────────────────────────

  wiki
    .command('ingest [source]')
    .description('Print the ingest prompt for the LLM (reads file or stdin)')
    .option('--name <name>', 'Source name to include in the prompt')
    .action(async (source: string | undefined, opts: { name?: string }) => {
      const cwd = process.cwd();
      const w = await getWiki(cwd);

      let content: string;
      let sourceName = opts.name ?? source ?? 'source';

      if (source && fs.existsSync(source)) {
        content = fs.readFileSync(source, 'utf8');
        sourceName = opts.name ?? source;
      } else if (source) {
        content = source;
      } else {
        content = readStdinSync();
      }

      const prompt = w.getIngestPrompt(content, sourceName);
      console.log(`\n  ${section('Wiki Ingest Prompt')} ${dim}(pass to LLM, then run wiki apply-diff)${reset}\n`);
      console.log(prompt);
      console.log();
    });

  // ── apply-diff ─────────────────────────────────────────────────────────────

  wiki
    .command('apply-diff [diff]')
    .description('Apply a WIKI_DIFF string to the wiki (reads file or stdin)')
    .action(async (diff: string | undefined) => {
      const cwd = process.cwd();
      const w = await getWiki(cwd);

      let rawDiff: string;
      if (diff && fs.existsSync(diff)) {
        rawDiff = fs.readFileSync(diff, 'utf8');
      } else if (diff) {
        rawDiff = diff;
      } else {
        rawDiff = readStdinSync();
      }

      const result = w.applyDiff(rawDiff);

      console.log(`\n  ${green}✓${reset}  Wiki diff applied\n`);
      if (result.created.length) {
        console.log(`  ${violet}Created:${reset}  ${result.created.join(', ')}`);
      }
      if (result.updated.length) {
        console.log(`  ${violet}Updated:${reset}  ${result.updated.join(', ')}`);
      }
      if (result.conflictsResolved.length) {
        console.log(`  ${green}Conflicts resolved:${reset}  ${result.conflictsResolved.join(', ')}`);
      }
      if (result.conflictsPending.length) {
        console.log(`\n  ${yellow}⚡ Conflicts pending (${result.conflictsPending.length}):${reset}`);
        for (const c of result.conflictsPending) {
          console.log(`  ${dim}  ${c.page} §${c.section}${reset}`);
          console.log(`    existing: "${c.existing}"`);
          console.log(`    incoming: "${c.incoming}" (source: ${c.source})`);
        }
      }
      console.log();
    });

  // ── search ─────────────────────────────────────────────────────────────────

  wiki
    .command('search <query>')
    .description('Full-text search over wiki pages')
    .option('--limit <n>', 'Max results', '5')
    .option('--format <fmt>', 'Output format: text, json', 'text')
    .action(async (query: string, opts: { limit: string; format: string }) => {
      const cwd = process.cwd();
      const w = await getWiki(cwd);
      const results = w.search(query, parseInt(opts.limit));

      if (opts.format === 'json') {
        console.log(JSON.stringify(results.map(r => ({
          slug: r.page.slug,
          title: r.page.title,
          score: r.score,
          updatedAt: r.page.updatedAt,
        })), null, 2));
        return;
      }

      if (results.length === 0) {
        console.log(`\n  ${dim}No wiki pages found for "${query}"${reset}\n`);
        return;
      }

      console.log(`\n  ${section('Wiki Search:')} ${violet}${bold}${query}${reset}\n`);
      for (const { page, score } of results) {
        console.log(`  ${violet}[${page.slug}]${reset} ${bold}${page.title}${reset}  ${dim}score: ${score.toFixed(3)}${reset}`);
        const preview = page.content.split('\n').find(l => l.trim() && !l.startsWith('#'));
        if (preview) console.log(`  ${dim}${preview.trim().slice(0, 120)}${reset}`);
        console.log();
      }
    });

  // ── page ───────────────────────────────────────────────────────────────────

  wiki
    .command('page <slug>')
    .description('Print the full content of a wiki page')
    .action(async (slug: string) => {
      const cwd = process.cwd();
      const w = await getWiki(cwd);
      const page = w.getPage(slug);
      if (!page) {
        console.error(`  ✖ Wiki page "${slug}" not found. Run \`kirograph wiki list\` to see available pages.`);
        process.exit(1);
      }
      console.log();
      console.log(page.content);
    });

  // ── list ───────────────────────────────────────────────────────────────────

  wiki
    .command('list')
    .description('List all wiki pages')
    .option('--format <fmt>', 'Output format: text, json', 'text')
    .action(async (opts: { format: string }) => {
      const cwd = process.cwd();
      const w = await getWiki(cwd);
      const pages = w.listPages();

      if (opts.format === 'json') {
        console.log(JSON.stringify(pages.map(p => ({
          slug: p.slug,
          title: p.title,
          sourceCount: p.sourceCount,
          updatedAt: p.updatedAt,
        })), null, 2));
        return;
      }

      const stats = w.getStats();
      console.log(`\n  ${section('Wiki')} ${dim}${stats.pageCount} page(s)${reset}\n`);
      if (pages.length === 0) {
        console.log(`  ${dim}No pages yet. Run \`kirograph wiki ingest\` to add pages.${reset}\n`);
        return;
      }
      for (const p of pages) {
        const date = new Date(p.updatedAt).toISOString().slice(0, 10);
        console.log(`  ${violet}${p.slug.padEnd(32)}${reset} ${p.title}  ${dim}(${p.sourceCount} src, ${date})${reset}`);
      }
      console.log();
    });

  // ── lint ───────────────────────────────────────────────────────────────────

  wiki
    .command('lint')
    .description('Health check the wiki for issues')
    .action(async () => {
      const cwd = process.cwd();
      const w = await getWiki(cwd);
      const issues = w.lint();

      if (issues.length === 0) {
        console.log(`\n  ${green}✓${reset}  Wiki lint passed — no issues found.\n`);
        return;
      }

      console.log(`\n  ${section('Wiki Lint')} ${yellow}${issues.length} issue(s)${reset}\n`);
      for (const issue of issues) {
        const icon = issue.kind === 'contradiction' ? '⚡' : issue.kind === 'orphan' ? '○' : issue.kind === 'broken_link' ? '🔗' : '⚠';
        console.log(`  ${icon} ${dim}[${issue.kind}]${reset} ${violet}${issue.slug}${reset}`);
        console.log(`    ${issue.detail}`);
        console.log();
      }
    });

  // ── reindex ────────────────────────────────────────────────────────────────

  wiki
    .command('reindex')
    .description('Rebuild SQLite index from .kirograph/wiki/*.md files')
    .action(async () => {
      const cwd = process.cwd();
      const w = await getWiki(cwd);
      const count = w.reindex();
      console.log(`\n  ${green}✓${reset}  Reindexed ${bold}${count}${reset} wiki page(s)\n`);
    });

  // ── status ─────────────────────────────────────────────────────────────────

  wiki
    .command('status')
    .description('Wiki subsystem stats')
    .action(async () => {
      const cwd = process.cwd();
      const w = await getWiki(cwd);
      const stats = w.getStats();
      const oldest = stats.oldestPage ? new Date(stats.oldestPage).toISOString().slice(0, 10) : 'n/a';
      const newest = stats.newestPage ? new Date(stats.newestPage).toISOString().slice(0, 10) : 'n/a';
      console.log(`\n  ${section('Wiki Status')}\n`);
      console.log(`  Pages:          ${bold}${stats.pageCount}${reset}`);
      console.log(`  Total sources:  ${bold}${stats.totalSources}${reset}`);
      console.log(`  Oldest page:    ${dim}${oldest}${reset}`);
      console.log(`  Newest page:    ${dim}${newest}${reset}`);
      console.log(`  Wiki dir:       ${dim}.kirograph/wiki/${reset}\n`);
    });

  // ── synthesize (local model) ───────────────────────────────────────────────

  wiki
    .command('synthesize')
    .description('Run local-model wiki synthesis: process the pending source queue (wikiSynthesisMode: local)')
    .option('--quiet', 'suppress progress output')
    .action(async (opts) => {
      const { KiroGraphWiki } = await import('../../wiki/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const cwd = process.cwd();

      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableWiki) {
        console.error('  ✖ Wiki is not enabled.');
        process.exit(1);
      }
      if (config.wikiSynthesisMode !== 'local') {
        console.error('  ✖ wikiSynthesisMode is not "local". This command is for local-model synthesis only.');
        process.exit(1);
      }

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyWikiSchema();
      const w = new KiroGraphWiki(db.getRawDb(), `${cwd}/.kirograph`, {
        autoResolveConflicts: config.wikiAutoResolveConflicts,
      });
      w.initialize();

      const queueCount = w.getQueueCount();
      if (queueCount === 0) {
        if (!opts.quiet) console.log(`\n  ${dim}Wiki queue is empty — nothing to synthesize.${reset}\n`);
        process.exit(0);
      }

      if (!opts.quiet) console.log(`\n  ${yellow}⟳${reset}  Synthesizing ${bold}${queueCount}${reset} queued source(s) with local model...\n`);

      const result = await w.synthesize(config.wikiLocalModel, !!opts.quiet);

      if (!opts.quiet) {
        if (result.processed > 0) {
          console.log(`  ${green}✓${reset}  Processed: ${bold}${result.processed}${reset} source(s)`);
          if (result.created.length) console.log(`  ${green}✓${reset}  Created:   ${result.created.join(', ')}`);
          if (result.updated.length) console.log(`  ${green}✓${reset}  Updated:   ${result.updated.join(', ')}`);
        }
        if (result.errors.length) {
          for (const e of result.errors) console.error(`  ${yellow}⚠${reset}  ${e}`);
        }
        console.log('');
      }
    });
}

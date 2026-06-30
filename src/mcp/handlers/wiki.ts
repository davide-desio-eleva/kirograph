import KiroGraph from '../../index';

export async function handleWiki(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  switch (toolName) {
    case 'kirograph_wiki_ingest': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

      const { KiroGraphWiki } = await import('../../wiki/index');
      const db = cg.getDatabase();
      db.applyWikiSchema();
      const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph', {
        autoResolveConflicts: (config as any).wikiAutoResolveConflicts ?? false,
      });
      wiki.initialize();

      const source = args.source as string ?? '';
      const sourceName = args.sourceName as string ?? 'source';
      if (!source) return 'source is required';

      if (config.wikiSynthesisMode === 'local') {
        wiki.queueSource(source, sourceName);
        const count = wiki.getQueueCount();
        return `Source "${sourceName}" queued for local wiki synthesis (${count} in queue). The agentStop hook will run "kirograph wiki synthesize" automatically.`;
      }

      const prompt = wiki.getIngestPrompt(source, sourceName);
      return `WIKI_INGEST_PROMPT\n${prompt}\n\nProduce WIKI_DIFF blocks following SCHEMA.md, then call kirograph_wiki_apply_diff with the diff string.`;
    }

    case 'kirograph_wiki_apply_diff': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

      const { KiroGraphWiki } = await import('../../wiki/index');
      const db = cg.getDatabase();
      db.applyWikiSchema();
      const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph', {
        autoResolveConflicts: (config as any).wikiAutoResolveConflicts ?? false,
      });
      wiki.initialize();

      const diff = args.diff as string ?? '';
      if (!diff) return 'diff is required';

      const result = wiki.applyDiff(diff);
      const lines: string[] = ['✓ Wiki diff applied'];
      if (result.created.length) lines.push(`  Created: ${result.created.join(', ')}`);
      if (result.updated.length) lines.push(`  Updated: ${result.updated.join(', ')}`);
      if (result.conflictsResolved.length) lines.push(`  Conflicts auto-resolved: ${result.conflictsResolved.join(', ')}`);
      if (result.conflictsPending.length) {
        lines.push(`  ⚡ Conflicts pending (${result.conflictsPending.length}):`);
        for (const c of result.conflictsPending) {
          lines.push(`    ${c.page} §${c.section}: "${c.existing}" vs "${c.incoming}" (source: ${c.source})`);
        }
      }
      return lines.join('\n');
    }

    case 'kirograph_wiki_search': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

      const { KiroGraphWiki } = await import('../../wiki/index');
      const db = cg.getDatabase();
      db.applyWikiSchema();
      const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph');
      wiki.initialize();

      const query = args.query as string ?? '';
      if (!query) return 'query is required';
      const limit = Math.min(Number(args.limit ?? 5), 20);

      const results = wiki.search(query, limit);
      if (results.length === 0) return `No wiki pages found for "${query}".`;

      const lines = [`Wiki Search: ${query}`, ''];
      for (const { page, score } of results) {
        lines.push(`[${page.slug}] ${page.title}  (score: ${score.toFixed(3)})`);
        // Show first non-heading line as preview
        const preview = page.content.split('\n').find(l => l.trim() && !l.startsWith('#'));
        if (preview) lines.push(`  ${preview.trim().slice(0, 120)}`);
        lines.push('');
      }
      return lines.join('\n').trim();
    }

    case 'kirograph_wiki_page': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

      const { KiroGraphWiki } = await import('../../wiki/index');
      const db = cg.getDatabase();
      db.applyWikiSchema();
      const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph');
      wiki.initialize();

      const slug = args.slug as string ?? '';
      if (!slug) return 'slug is required';

      const page = wiki.getPage(slug);
      if (!page) return `Wiki page "${slug}" not found. Use kirograph_wiki_list to see available pages.`;

      return page.content;
    }

    case 'kirograph_wiki_lint': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

      const { KiroGraphWiki } = await import('../../wiki/index');
      const db = cg.getDatabase();
      db.applyWikiSchema();
      const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph');
      wiki.initialize();

      const issues = wiki.lint();
      if (issues.length === 0) return '✓ Wiki lint passed — no issues found.';

      const lines = [`Wiki Lint — ${issues.length} issue(s)`, ''];
      for (const issue of issues) {
        const icon = issue.kind === 'contradiction' ? '⚡' : issue.kind === 'orphan' ? '○' : issue.kind === 'broken_link' ? '🔗' : '⚠';
        lines.push(`${icon} [${issue.kind}] ${issue.slug}`);
        lines.push(`  ${issue.detail}`);
        lines.push('');
      }
      return lines.join('\n').trim();
    }

    case 'kirograph_wiki_list': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

      const { KiroGraphWiki } = await import('../../wiki/index');
      const db = cg.getDatabase();
      db.applyWikiSchema();
      const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph');
      wiki.initialize();

      const pages = wiki.listPages();
      if (pages.length === 0) return 'Wiki is empty. Use kirograph_wiki_ingest to add pages.';

      const stats = wiki.getStats();
      const lines = [
        `Wiki — ${stats.pageCount} page(s), ${stats.totalSources} total sources`,
        '',
      ];
      for (const page of pages) {
        const date = new Date(page.updatedAt).toISOString().slice(0, 10);
        lines.push(`  ${page.slug.padEnd(32)} ${page.title}  (${page.sourceCount} src, ${date})`);
      }
      return lines.join('\n');
    }

    case 'kirograph_wiki_synthesize': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';
      if (config.wikiSynthesisMode !== 'local') return 'wikiSynthesisMode is not "local". This tool is for local-model synthesis only.';

      const { KiroGraphWiki } = await import('../../wiki/index');
      const db = cg.getDatabase();
      db.applyWikiSchema();
      const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph', {
        autoResolveConflicts: (config as any).wikiAutoResolveConflicts ?? false,
      });
      wiki.initialize();

      const queueCount = wiki.getQueueCount();
      if (queueCount === 0) return 'Wiki queue is empty — nothing to synthesize.';

      const result = await wiki.synthesize(config.wikiLocalModel, true);
      const synthLines = [`Wiki synthesis complete — processed ${result.processed} source(s).`];
      if (result.created.length) synthLines.push(`Created: ${result.created.join(', ')}`);
      if (result.updated.length) synthLines.push(`Updated: ${result.updated.join(', ')}`);
      if (result.errors.length) synthLines.push(`Errors: ${result.errors.join('; ')}`);
      return synthLines.join('\n');
    }

    case 'kirograph_wiki_init': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

      const { KiroGraphWiki } = await import('../../wiki/index');
      const db = cg.getDatabase();
      db.applyWikiSchema();
      const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph', {
        autoResolveConflicts: (config as any).wikiAutoResolveConflicts ?? false,
      });
      wiki.initWiki();
      return 'Wiki initialized. SCHEMA.md and MANIFEST.md created in .kirograph/wiki/.';
    }

    case 'kirograph_wiki_reindex': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

      const { KiroGraphWiki } = await import('../../wiki/index');
      const db = cg.getDatabase();
      db.applyWikiSchema();
      const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph');
      wiki.initialize();

      const count = wiki.reindex();
      return `Reindexed ${count} wiki page(s) from .kirograph/wiki/*.md.`;
    }

    case 'kirograph_wiki_status': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

      const { KiroGraphWiki } = await import('../../wiki/index');
      const db = cg.getDatabase();
      db.applyWikiSchema();
      const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph');
      wiki.initialize();

      const stats = wiki.getStats();
      const oldest = stats.oldestPage ? new Date(stats.oldestPage).toISOString().slice(0, 10) : 'n/a';
      const newest = stats.newestPage ? new Date(stats.newestPage).toISOString().slice(0, 10) : 'n/a';
      return [
        'Wiki Status:',
        `  Pages:         ${stats.pageCount}`,
        `  Total sources: ${stats.totalSources}`,
        `  Oldest page:   ${oldest}`,
        `  Newest page:   ${newest}`,
        `  Wiki dir:      .kirograph/wiki/`,
      ].join('\n');
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

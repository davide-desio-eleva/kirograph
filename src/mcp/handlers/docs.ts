import KiroGraph from '../../index';

export async function handleDocs(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  switch (toolName) {
    case 'kirograph_docs_toc': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableDocs) return 'Documentation indexing is not enabled. Set enableDocs: true in .kirograph/config.json and run kirograph index.';

      const { DocsQueries } = await import('../../docs/queries');
      const db = cg.getDatabase();
      db.applyDocsSchema();
      const docs = new DocsQueries(db.getRawDb(), projectRoot);

      const toc = docs.getToc({ file: args.file as string | undefined, tree: args.tree as boolean | undefined });
      if (toc.length === 0) return args.file ? `No sections found in "${args.file}".` : 'No documentation indexed. Run kirograph index.';

      const lines: string[] = [];
      const renderEntry = (entry: any, indent: string) => {
        const prefix = '#'.repeat(entry.level || 1);
        const summary = entry.summary ? ` — ${entry.summary}` : '';
        lines.push(`${indent}${prefix} ${entry.title}${summary}`);
        lines.push(`${indent}  ID: ${entry.id}`);
        if (entry.children?.length) {
          for (const child of entry.children) renderEntry(child, indent + '  ');
        }
      };

      if (args.tree) {
        for (const entry of toc) renderEntry(entry, '');
      } else {
        for (const entry of toc) {
          const prefix = '#'.repeat(entry.level || 1);
          const summary = entry.summary ? ` — ${entry.summary}` : '';
          lines.push(`${prefix} ${entry.title} [${entry.filePath}]${summary}`);
          lines.push(`  ID: ${entry.id}`);
        }
      }

      return lines.join('\n');
    }

    case 'kirograph_docs_search': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableDocs) return 'Documentation indexing is not enabled. Set enableDocs: true in .kirograph/config.json and run kirograph index.';

      const { DocsQueries } = await import('../../docs/queries');
      const db = cg.getDatabase();
      db.applyDocsSchema();
      const docs = new DocsQueries(db.getRawDb(), projectRoot, config);

      const results = await docs.searchSections(args.query as string, {
        file: args.file as string | undefined,
        limit: (args.limit as number) ?? 10,
      });

      if (results.length === 0) return `No documentation sections found matching "${args.query}".`;

      return results.map((r, i) => {
        const summary = r.section.summary ? `\n  ${r.section.summary}` : '';
        return `${i + 1}. ${r.section.title} [${r.section.filePath}]${summary}\n  ID: ${r.section.id}`;
      }).join('\n\n');
    }

    case 'kirograph_docs_section': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableDocs) return 'Documentation indexing is not enabled. Set enableDocs: true in .kirograph/config.json and run kirograph index.';

      const { DocsQueries } = await import('../../docs/queries');
      const db = cg.getDatabase();
      db.applyDocsSchema();
      const docs = new DocsQueries(db.getRawDb(), projectRoot);

      const result = docs.getSection(args.id as string, { context: args.context as boolean | undefined });
      if (!result) return `Section "${args.id}" not found.`;

      const lines: string[] = [];

      if (result.ancestors?.length) {
        lines.push('Breadcrumb: ' + result.ancestors.map(a => a.title).join(' > ') + ' > ' + result.section.title);
        lines.push('');
      }

      lines.push(result.content);

      if (result.children?.length) {
        lines.push('', '## Child sections:');
        for (const child of result.children) {
          const summary = child.summary ? ` — ${child.summary}` : '';
          lines.push(`  - ${child.title}${summary} (ID: ${child.id})`);
        }
      }

      return lines.join('\n');
    }

    case 'kirograph_docs_outline': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableDocs) return 'Documentation indexing is not enabled. Set enableDocs: true in .kirograph/config.json and run kirograph index.';

      const { DocsQueries } = await import('../../docs/queries');
      const db = cg.getDatabase();
      db.applyDocsSchema();
      const docs = new DocsQueries(db.getRawDb(), projectRoot);

      const outline = docs.getOutline(args.file as string);
      if (outline.length === 0) return `No sections found in "${args.file}". Is the file indexed?`;

      const lines: string[] = [`Outline: ${args.file}`, ''];
      const renderOutline = (entries: any[], indent: string) => {
        for (const entry of entries) {
          const summary = entry.summary ? ` — ${entry.summary}` : '';
          lines.push(`${indent}${'#'.repeat(entry.level || 1)} ${entry.title}${summary}`);
          if (entry.children?.length) renderOutline(entry.children, indent + '  ');
        }
      };
      renderOutline(outline, '');

      return lines.join('\n');
    }

    case 'kirograph_docs_refs': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableDocs) return 'Documentation indexing is not enabled. Set enableDocs: true in .kirograph/config.json and run kirograph index.';

      const { DocsQueries } = await import('../../docs/queries');
      const db = cg.getDatabase();
      db.applyDocsSchema();
      const docs = new DocsQueries(db.getRawDb(), projectRoot);

      const refs = docs.getRefs({
        sectionId: args.sectionId as string | undefined,
        qualifiedName: args.nodeId as string | undefined,
      });

      if (refs.length === 0) {
        if (args.sectionId) return `No code references found in section "${args.sectionId}".`;
        if (args.nodeId) return `No documentation sections reference "${args.nodeId}".`;
        return 'Provide either sectionId or nodeId to look up cross-references.';
      }

      return refs.map(r => {
        const direction = args.sectionId ? `→ ${r.qualifiedName}` : `← ${r.sectionTitle ?? r.sectionId}`;
        return `[${r.refType}] ${direction} (confidence: ${r.confidence.toFixed(2)})`;
      }).join('\n');
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

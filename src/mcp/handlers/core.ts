import KiroGraph from '../../index';
import type { NodeKind } from '../../types';
import { estimateTokens } from '../../compression/index';
import { clampLimit, mapKind, formatAge, estimateFileTokens } from './utils';

export async function handleCore(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  switch (toolName) {
    case 'kirograph_search': {
      const limit = clampLimit(args.limit as number | undefined, 10);
      const mode = (args.mode as string | undefined) ?? 'name';
      let nodes: Array<{ kind: string; name: string; filePath: string; startLine: number; qualifiedName: string }>;
      if (mode === 'similar') {
        nodes = cg.getDatabase().searchNodesByName(
          args.query as string,
          { kinds: args.kind ? [args.kind as NodeKind] : undefined, limit }
        );
      } else {
        nodes = cg.searchNodes(args.query as string, args.kind as NodeKind | undefined, limit).map(r => r.node);
      }
      if (nodes.length === 0) return `No symbols found matching "${args.query}".`;
      return nodes.map(n =>
        `${mapKind(n.kind as NodeKind)} ${n.name}\n  File: ${n.filePath}:${n.startLine}\n  Qualified: ${n.qualifiedName}`
      ).join('\n\n');
    }

    case 'kirograph_context': {
      const detail = (args.detail as string) ?? ((args.includeCode === false) ? 'summary' : 'full');
      const ctx = await cg.buildContext(args.task as string, {
        maxNodes: (args.maxNodes as number) ?? 20,
        includeCode: detail === 'full',
      });
      const lines: string[] = [ctx.summary, ''];
      if (ctx.entryPoints.length === 0) {
        lines.push('No matching symbols found. If this is a new feature, consider using kirograph_files to explore the codebase structure.');
      } else {
        lines.push('## Entry Points');
        for (const n of ctx.entryPoints) {
          lines.push(`- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`);
          if (detail === 'full' && ctx.codeSnippets.has(n.id)) {
            lines.push('```', ctx.codeSnippets.get(n.id)!, '```');
          } else if (detail === 'signatures') {
            if ((n as any).signature) lines.push(`  Signature: ${(n as any).signature}`);
            if ((n as any).docstring) lines.push(`  Docs: ${(n as any).docstring}`);
          }
        }
        if (ctx.relatedNodes.length > 0) {
          lines.push('', '## Related Symbols');
          for (const n of ctx.relatedNodes.slice(0, 10)) {
            lines.push(`- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`);
          }
        }
      }

      // Memory integration: surface relevant observations if memory is enabled
      try {
        const { loadConfig } = await import('../../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (config.enableMemory) {
          const { MemoryManager } = await import('../../memory/index');
          const db = cg.getDatabase();
          db.applyMemorySchema();
          const mem = new MemoryManager(config, db.getRawDb());
          mem.initialize();

          // Collect qualified names from entry points and related nodes
          const qualifiedNames = [
            ...ctx.entryPoints.map((n: any) => n.qualifiedName),
            ...ctx.relatedNodes.slice(0, 5).map((n: any) => n.qualifiedName),
          ].filter(Boolean);

          const contextLimit = config.memoryContextLimit ?? 3;
          const contextThreshold = config.memoryContextThreshold ?? 0.3;

          // Try linked observations first, fall back to search
          let memResults = mem.getLinkedObservations(qualifiedNames, contextLimit, contextThreshold);
          if (memResults.length === 0) {
            // Fall back to searching by task description
            memResults = (await mem.search(args.task as string, { limit: contextLimit }))
              .filter(r => r.score >= contextThreshold);
          }

          if (memResults.length > 0) {
            lines.push('', '## Related Memory');
            for (const r of memResults.slice(0, contextLimit)) {
              lines.push(`- [${r.observation.kind}] ${r.observation.content}`);
            }
          }
        }
      } catch { /* memory is non-critical — don't fail context on memory errors */ }

      // Docs integration: surface relevant doc sections if enabled and docsContextLimit > 0
      try {
        const projectRoot2 = cg.getProjectRoot();
        const config2 = await (await import('../../config')).loadConfig(projectRoot2);
        if (config2.enableDocs && config2.docsContextLimit > 0) {
          const db2 = cg.getDatabase();
          db2.applyDocsSchema();
          const { DocsQueries } = await import('../../docs/queries');
          const docsQueries = new DocsQueries(db2.getRawDb(), projectRoot2);

          // Collect qualified names from entry points
          const qNames = ctx.entryPoints.map((n: any) => n.qualifiedName).filter(Boolean);

          if (qNames.length > 0) {
            // Find doc sections that reference these symbols
            const docRefs = docsQueries.getRefs({ qualifiedName: qNames[0] });
            const additionalRefs = qNames.slice(1, 5).flatMap(qn => docsQueries.getRefs({ qualifiedName: qn }));
            const allDocRefs = [...docRefs, ...additionalRefs];

            // Deduplicate by section ID and take top N
            const seenSections = new Set<string>();
            const uniqueRefs = allDocRefs.filter(r => {
              if (seenSections.has(r.sectionId)) return false;
              seenSections.add(r.sectionId);
              return r.confidence >= config2.docsContextThreshold;
            }).slice(0, config2.docsContextLimit);

            if (uniqueRefs.length > 0) {
              lines.push('', '## Related Documentation');
              for (const ref of uniqueRefs) {
                const section = docsQueries.getSection(ref.sectionId);
                if (section) {
                  const summary = section.section.summary ?? section.section.title;
                  lines.push(`- [${ref.refType}] ${summary} — ${section.section.filePath} (ID: ${ref.sectionId})`);
                }
              }
            }
          }
        }
      } catch { /* docs is non-critical */ }

      // Data integration: surface relevant dataset schemas if enabled and dataContextLimit > 0
      try {
        const projectRoot3 = cg.getProjectRoot();
        const config3 = await (await import('../../config')).loadConfig(projectRoot3);
        if (config3.enableData && config3.dataContextLimit > 0) {
          const db3 = cg.getDatabase();
          db3.applyDataSchema();

          // Find datasets referenced by the entry point files
          const entryFiles = ctx.entryPoints.map((n: any) => n.filePath).filter(Boolean);
          if (entryFiles.length > 0) {
            const placeholders = entryFiles.map(() => '?').join(', ');
            const dataRefs = db3.getRawDb().all(
              `SELECT DISTINCT d.id, d.file_path, d.row_count, d.column_count
               FROM data_code_refs r JOIN data_datasets d ON r.dataset_id = d.id
               WHERE r.qualified_name IN (${placeholders})`,
              entryFiles,
            ) as any[];

            if (dataRefs.length > 0) {
              const { DataQueries } = await import('../../data/queries');
              const dq = new DataQueries(db3.getRawDb());
              const limit = config3.dataContextLimit;

              lines.push('', '## Related Data');
              for (const ref of dataRefs.slice(0, limit)) {
                const info = dq.describeDataset(ref.id);
                if (info) {
                  const colSummary = info.columns.map(c => `${c.name}:${c.inferredType}`).join(', ');
                  lines.push(`- **${ref.id}** (${ref.file_path}) — ${ref.row_count} rows, ${ref.column_count} cols`);
                  lines.push(`  Schema: ${colSummary}`);
                }
              }
            }
          }
        }
      } catch { /* data is non-critical */ }

      // Security integration: surface vulnerability warnings if enableSecurity is true
      try {
        const projectRootSec = cg.getProjectRoot();
        const configSec = await (await import('../../config')).loadConfig(projectRootSec);
        if (configSec.enableSecurity) {
          const dbSec = cg.getDatabase();
          dbSec.applySecuritySchema();
          const rawDbSec = dbSec.getRawDb();

          // Collect node IDs from entry points and related nodes
          const contextNodeIds = [
            ...ctx.entryPoints.map((n: any) => n.id),
            ...ctx.relatedNodes.map((n: any) => n.id),
          ].filter(Boolean);

          if (contextNodeIds.length > 0) {
            const { getSecurityWarningsForNodes, formatSecurityWarnings } = await import('../../security/context-warnings');
            const warnings = getSecurityWarningsForNodes(rawDbSec, contextNodeIds);

            if (warnings.length > 0) {
              // Build a name map for entry points
              const nodeNames = new Map<string, string>();
              for (const n of ctx.entryPoints) {
                nodeNames.set(n.id, n.name);
              }
              for (const n of ctx.relatedNodes) {
                nodeNames.set(n.id, n.name);
              }

              const secSection = formatSecurityWarnings(warnings, nodeNames);
              if (secSection) {
                lines.push(secSection);
              }
            }
          }
        }
      } catch { /* security is non-critical */ }

      // Pattern matches warning (when enablePatterns: true and pattern_matches table exists)
      try {
        const projectRootPat = cg.getProjectRoot();
        const configPat = await (await import('../../config')).loadConfig(projectRootPat);
        if ((configPat as any).enablePatterns) {
          const dbPat = cg.getDatabase();
          dbPat.applyPatternsSchema();
          const rawDbPat = dbPat.getRawDb();
          const tableExists = rawDbPat.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
          if (tableExists) {
            // Collect file paths from context nodes
            const contextFiles = [
              ...ctx.entryPoints.map((n: any) => n.filePath),
              ...ctx.relatedNodes.map((n: any) => n.filePath),
            ].filter(Boolean) as string[];
            const uniqueContextFiles = [...new Set(contextFiles)];

            if (uniqueContextFiles.length > 0) {
              const placeholders = uniqueContextFiles.map(() => '?').join(',');
              const patternRows: Array<{ file_path: string; pattern_id: string; severity: string; owasp_category: string; line: number }> =
                rawDbPat.all(
                  `SELECT file_path, pattern_id, severity, owasp_category, line FROM pattern_matches WHERE file_path IN (${placeholders}) ORDER BY severity DESC LIMIT 5`,
                  uniqueContextFiles
                );
              if (patternRows.length > 0) {
                const patternWarnings = patternRows.map(p =>
                  `- **${p.pattern_id}** [${p.severity.toUpperCase()}/${p.owasp_category}]: ${p.file_path}:${p.line}`
                ).join('\n');
                lines.push('', '## ⚠ Pattern Findings', '', patternWarnings);
                if (patternRows.length === 5) lines.push('', 'More findings — run `kirograph pattern --list` to see all rules.');
              }
            }
          }
        }
      } catch { /* non-critical */ }

      // Context savings estimation
      const graphTokens = lines.join('\n').length / 4; // rough token estimate
      const uniqueFiles = new Set([
        ...ctx.entryPoints.map((n: any) => n.filePath),
        ...ctx.relatedNodes.map((n: any) => n.filePath),
      ]);
      if (uniqueFiles.size > 0) {
        const naiveTokens = estimateFileTokens(cg.getProjectRoot(), [...uniqueFiles]);
        if (naiveTokens > 0) {
          const savingsPct = Math.round((1 - graphTokens / naiveTokens) * 100);
          if (savingsPct > 0) {
            lines.push('', `---`, `Context savings: ~${Math.round(graphTokens)} tokens (graph) vs ~${naiveTokens} tokens (full files) — ${savingsPct}% reduction`);
          }
        }
      }

      return lines.join('\n');
    }

    case 'kirograph_callers': {
      const limit = clampLimit(args.limit as number | undefined, 20);
      const results = cg.searchNodes(args.symbol as string, undefined, 5);
      if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
      const node = results[0].node;
      const callers = await cg.getCallers(node.id, limit);
      if (callers.length === 0) return `No callers found for \`${node.name}\`.`;
      return `Callers of \`${node.name}\`:\n` + callers.map(n =>
        `- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`
      ).join('\n');
    }

    case 'kirograph_callees': {
      const limit = clampLimit(args.limit as number | undefined, 20);
      const results = cg.searchNodes(args.symbol as string, undefined, 5);
      if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
      const node = results[0].node;
      const callees = await cg.getCallees(node.id, limit);
      if (callees.length === 0) return `\`${node.name}\` doesn't call any indexed symbols.`;
      return `\`${node.name}\` calls:\n` + callees.map(n =>
        `- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`
      ).join('\n');
    }

    case 'kirograph_impact': {
      const results = cg.searchNodes(args.symbol as string, undefined, 5);
      if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
      const node = results[0].node;
      const affected = await cg.getImpactRadius(node.id, (args.depth as number) ?? 2);
      if (affected.length === 0) return `No dependents found for \`${node.name}\`.`;

      let output = `Changing \`${node.name}\` may affect ${affected.length} symbol(s):\n` +
        affected.map(n => `- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`).join('\n');

      // Memory integration: surface observations linked to the target symbol
      try {
        const { loadConfig } = await import('../../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (config.enableMemory) {
          const { MemoryManager } = await import('../../memory/index');
          const db = cg.getDatabase();
          db.applyMemorySchema();
          const mem = new MemoryManager(config, db.getRawDb());
          mem.initialize();

          const contextLimit = config.memoryContextLimit ?? 3;
          const contextThreshold = config.memoryContextThreshold ?? 0.3;
          const memResults = mem.getLinkedObservations(
            [node.qualifiedName],
            contextLimit,
            contextThreshold
          );

          if (memResults.length > 0) {
            output += '\n\nRelated Memory:';
            for (const r of memResults) {
              const age = formatAge(r.observation.createdAt);
              output += `\n- [${r.observation.kind}] ${r.observation.content} (${age})`;
            }
          }
        }
      } catch { /* memory is non-critical */ }

      // Check if symbol has pattern matches
      try {
        const rawDbImp = cg.getDatabase().getRawDb();
        const tableExistsImp = rawDbImp.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
        if (tableExistsImp) {
          const symNode = rawDbImp.get('SELECT id FROM nodes WHERE name = ? LIMIT 1', [args.symbol]);
          if (symNode) {
            const patternMatches = rawDbImp.all(
              'SELECT pattern_id, severity, line FROM pattern_matches WHERE symbol_node_id = ?',
              [(symNode as { id: string }).id]
            ) as Array<{ pattern_id: string; severity: string; line: number }>;
            if (patternMatches.length > 0) {
              output += '\n\n⚠ This symbol has pattern matches:';
              for (const pm of patternMatches) {
                output += `\n  [${pm.severity.toUpperCase()}] ${pm.pattern_id} at line ${pm.line}`;
              }
            }
          }
        }
      } catch { /* non-critical */ }

      return output;
    }

    case 'kirograph_node': {
      let node: import('../../types').Node | null = null;
      if (args.qualified) {
        const row = cg.getDatabase().getRawDb().get(
          `SELECT * FROM nodes WHERE qualified_name = ? LIMIT 1`,
          [args.symbol as string]
        );
        if (row) {
          // Map DB row to Node shape (fields used below)
          node = {
            id: row.id, kind: row.kind, name: row.name, qualifiedName: row.qualified_name,
            filePath: row.file_path, language: row.language,
            startLine: row.start_line, endLine: row.end_line,
            startColumn: row.start_column, endColumn: row.end_column,
            docstring: row.docstring ?? undefined, signature: row.signature ?? undefined,
            visibility: row.visibility ?? undefined,
            isExported: row.is_exported === 1, isAsync: row.is_async === 1,
            isStatic: row.is_static === 1, isAbstract: row.is_abstract === 1,
          } as import('../../types').Node;
        }
      } else {
        const results = cg.searchNodes(args.symbol as string, undefined, 5);
        if (results.length > 0) node = results[0].node;
      }
      if (!node) return `Symbol "${args.symbol}" not found in index.`;
      const nodeDetail = (args.detail as string) ?? (args.includeCode ? 'full' : 'summary');
      const lines = [
        `${mapKind(node.kind)} \`${node.name}\``,
        `File: ${node.filePath}:${node.startLine}-${node.endLine}`,
        `Qualified: ${node.qualifiedName}`,
      ];
      if (nodeDetail === 'signatures' || nodeDetail === 'full') {
        if (node.signature) lines.push(`Signature: ${node.signature}`);
        if (node.docstring) lines.push(`Docs: ${node.docstring}`);
      }
      if (nodeDetail === 'full') {
        const src = cg.getNodeSource(node);
        if (src) lines.push('', '```', src, '```');
      }
      return lines.join('\n');
    }

    case 'kirograph_status': {
      const stats = await cg.getStats();
      const langLine = Object.entries(stats.filesByLanguage)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      const dbMb = (stats.dbSizeBytes / 1024 / 1024).toFixed(2);
      const semanticLines = stats.embeddingsEnabled
        ? [
            `  Semantic search: enabled`,
            `  Semantic model:  ${stats.embeddingModel}`,
            `  Semantic engine: ${
              stats.semanticEngine === 'turboquant' ? `turboquant (${stats.vecIndexCount} entries · ANN)` :
              stats.semanticEngine === 'turbovec'   ? `turbovec (${stats.vecIndexCount} entries · ${stats.turbovecBits ?? 4} bits · Rust/SIMD)` :
              stats.semanticEngine === 'sqlite-vec' ? `sqlite-vec (${stats.vecIndexCount} entries in ANN index)` :
              stats.semanticEngine === 'orama'      ? `orama hybrid (${stats.vecIndexCount} docs in index)` :
              stats.semanticEngine === 'pglite'     ? `pglite+pgvector (${stats.vecIndexCount} rows in DB)` :
              stats.semanticEngine === 'lancedb'    ? `lancedb (${stats.vecIndexCount} entries in ANN index)` :
              stats.semanticEngine === 'qdrant'     ? `qdrant (${stats.vecIndexCount} points in collection)` :
              stats.semanticEngine === 'typesense'  ? `typesense (${stats.vecIndexCount} documents in collection)` :
              'in-process cosine'
            }`,
            `  Embeddings:      ${stats.embeddingCount} / ${stats.embeddableNodeCount || stats.nodes} embeddable symbols`,
            ...(stats.engineFallback ? [`  ⚠ Engine fallback: ${stats.engineFallback}`] : []),
          ]
        : [`  Semantic search: disabled`];
      const frameworkLine = stats.frameworks.length > 0
        ? `  Frameworks: ${stats.frameworks.join(', ')}`
        : `  Frameworks: none detected`;
      const archLine = stats.architectureEnabled
        ? stats.architectureStats
          ? `  Architecture: enabled — ${stats.architectureStats.packages} packages, ${stats.architectureStats.layers} layers, ${stats.architectureStats.packageDeps} deps`
          : `  Architecture: enabled (not yet analyzed — run kirograph index)`
        : `  Architecture: disabled`;

      // Docs stats
      let docsLine = '  Documentation: disabled';
      try {
        const { loadConfig: loadCfg } = await import('../../config');
        const cfg = await loadCfg(cg.getProjectRoot());
        if (cfg.enableDocs) {
          const db = cg.getDatabase();
          db.applyDocsSchema();
          const rawDb = db.getRawDb();
          const docFiles = rawDb.get('SELECT COUNT(DISTINCT file_path) as cnt FROM doc_sections')?.cnt ?? 0;
          const docSections = rawDb.get('SELECT COUNT(*) as cnt FROM doc_sections')?.cnt ?? 0;
          const docRefs = rawDb.get('SELECT COUNT(*) as cnt FROM doc_code_refs')?.cnt ?? 0;
          docsLine = `  Documentation: enabled — ${docFiles} files, ${docSections} sections, ${docRefs} code refs`;
        }
      } catch { /* non-critical */ }

      // Data stats
      let dataLine = '  Data: disabled';
      try {
        const { loadConfig: loadCfg2 } = await import('../../config');
        const cfg2 = await loadCfg2(cg.getProjectRoot());
        if (cfg2.enableData) {
          const rawDb2 = cg.getDatabase().getRawDb();
          cg.getDatabase().applyDataSchema();
          const datasetCount = rawDb2.get('SELECT COUNT(*) as cnt FROM data_datasets')?.cnt ?? 0;
          if (datasetCount > 0) {
            const totalRows = rawDb2.get('SELECT SUM(row_count) as total FROM data_datasets')?.total ?? 0;
            const totalCols = rawDb2.get('SELECT SUM(column_count) as total FROM data_datasets')?.total ?? 0;
            const totalSize = rawDb2.get('SELECT SUM(file_size) as total FROM data_datasets')?.total ?? 0;
            const sizeMb = (totalSize / 1024 / 1024).toFixed(2);
            dataLine = `  Data: enabled — ${datasetCount} datasets, ${totalRows.toLocaleString()} rows, ${totalCols} columns (${sizeMb} MB source)`;
          } else {
            dataLine = `  Data: enabled (no datasets indexed yet — run kirograph index)`;
          }
        }
      } catch { /* non-critical */ }

      // Security stats
      let securityLine = '  Security: disabled';
      try {
        const { loadConfig: loadCfgSec } = await import('../../config');
        const cfgSec = await loadCfgSec(cg.getProjectRoot());
        if (cfgSec.enableSecurity) {
          const db = cg.getDatabase();
          db.applySecuritySchema();
          const rawDb = db.getRawDb();
          const depCount = rawDb.get('SELECT COUNT(*) as cnt FROM sec_dependencies')?.cnt ?? 0;
          const vulnCount = rawDb.get('SELECT COUNT(*) as cnt FROM sec_vulnerabilities')?.cnt ?? 0;
          const affectedCount = rawDb.get("SELECT COUNT(*) as cnt FROM sec_reachability WHERE verdict = 'affected'")?.cnt ?? 0;
          const staleCount = rawDb.get('SELECT COUNT(*) as cnt FROM sec_dependencies WHERE vuln_data_stale = 1')?.cnt ?? 0;
          const staleNote = staleCount > 0 ? ` ⚠ ${staleCount} stale` : '';
          securityLine = `  Security: enabled — ${depCount} deps, ${vulnCount} vulns (${affectedCount} affected)${staleNote}`;
        }
      } catch { /* non-critical */ }

      // Patterns stats
      let patternsLine = '  Patterns: disabled';
      try {
        const { loadConfig: loadCfgPat } = await import('../../config');
        const cfgP = await loadCfgPat(cg.getProjectRoot());
        if ((cfgP as any).enablePatterns) {
          const rawDbP = cg.getDatabase().getRawDb();
          const tableExistsP = rawDbP.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
          if (tableExistsP) {
            const matchCount = rawDbP.get('SELECT COUNT(*) as cnt FROM pattern_matches')?.cnt ?? 0;
            const fileCount = rawDbP.get('SELECT COUNT(DISTINCT file_path) as cnt FROM pattern_matches')?.cnt ?? 0;
            const ruleCount = rawDbP.get('SELECT COUNT(DISTINCT pattern_id) as cnt FROM pattern_matches')?.cnt ?? 0;
            patternsLine = `  Patterns: enabled — ${matchCount} matches, ${ruleCount} rules triggered, ${fileCount} files`;
          } else {
            patternsLine = `  Patterns: enabled (no data yet — run kirograph index)`;
          }
        }
      } catch { /* non-critical */ }

      // Sync state warning
      const threshold = stats.syncWarningThreshold ?? 10;
      const pendingFiles: number = stats.pendingFiles ?? 0;
      const syncRunning: boolean = stats.syncRunning ?? false;
      const syncLines: string[] = [];
      if (syncRunning) {
        syncLines.push(`  ⚠ Sync is currently running in the background.`);
      }
      if (threshold > 0 && pendingFiles >= threshold) {
        syncLines.push(
          `  ⚠ Index may be incomplete — ${pendingFiles} file${pendingFiles !== 1 ? 's' : ''} pending sync.` +
          (syncRunning ? ' Sync is running in background.' : ' Run `kirograph sync` to update.') +
          ` Would you like to wait before proceeding?`
        );
      }

      // Token savings summary
      const { TokenTracker } = await import('../../compression/tracker');
      const tracker = new TokenTracker(cg.getProjectRoot());
      const gainStats = tracker.getStats('session');
      const gainLines: string[] = [];
      if (gainStats.totalCommands > 0) {
        gainLines.push(`  Compression: ${gainStats.totalCommands} commands, ${gainStats.savingsPercent}% avg savings (${gainStats.totalSaved.toLocaleString()} tokens saved this session)`);
      }

      return [
        `KiroGraph Status`,
        `  Project: ${cg.getProjectRoot()}`,
        `  Files indexed: ${stats.files}`,
        `  Symbols: ${stats.nodes}`,
        `  Relationships: ${stats.edges}`,
        `  By kind: ${Object.entries(stats.nodesByKind).map(([k, v]) => `${k}=${v}`).join(', ')}`,
        langLine ? `  By language: ${langLine}` : '',
        frameworkLine,
        archLine,
        docsLine,
        dataLine,
        securityLine,
        patternsLine,
        `  DB size: ${dbMb} MB`,
        ...semanticLines,
        ...syncLines,
        ...gainLines,
      ].filter(Boolean).join('\n');
    }

    case 'kirograph_files': {
      const format = (args.format as string) ?? 'tree';
      const includeMetadata = args.includeMetadata !== false;
      const tree = cg.getFiles({
        filterPath: args.filterPath as string | undefined,
        pattern: args.pattern as string | undefined,
        maxDepth: args.maxDepth as number | undefined,
      });

      if (format === 'flat') {
        const flat: string[] = [];
        function flattenTree(nodes: import('../../index').FileTreeNode[]): void {
          for (const node of nodes) {
            if (node.type === 'file') {
              const meta = includeMetadata && node.language ? ` [${node.language}${node.symbolCount ? ` · ${node.symbolCount}` : ''}]` : '';
              flat.push(`${node.path}${meta}`);
            }
            if (node.children?.length) flattenTree(node.children);
          }
        }
        flattenTree(tree);
        return flat.length > 0 ? flat.join('\n') : 'No indexed files found.';
      }

      if (format === 'grouped') {
        const groups = new Map<string, import('../../index').FileTreeNode[]>();
        function groupTree(nodes: import('../../index').FileTreeNode[]): void {
          for (const node of nodes) {
            if (node.type === 'file') {
              const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '.';
              if (!groups.has(dir)) groups.set(dir, []);
              groups.get(dir)!.push(node);
            }
            if (node.children?.length) groupTree(node.children);
          }
        }
        groupTree(tree);
        const lines: string[] = [];
        for (const [dir, files] of [...groups.entries()].sort()) {
          lines.push(`${dir}/`);
          for (const f of files) {
            const meta = includeMetadata && f.language ? ` [${f.language}${f.symbolCount ? ` · ${f.symbolCount}` : ''}]` : '';
            lines.push(`  ${f.name}${meta}`);
          }
        }
        return lines.length > 0 ? lines.join('\n') : 'No indexed files found.';
      }

      if (format === 'compact') {
        // rtk-style compact: directory summary with file counts and language breakdown
        const dirStats = new Map<string, { files: number; symbols: number; langs: Map<string, number> }>();
        function compactTree(nodes: import('../../index').FileTreeNode[]): void {
          for (const node of nodes) {
            if (node.type === 'file') {
              const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '.';
              const stat = dirStats.get(dir) || { files: 0, symbols: 0, langs: new Map() };
              stat.files++;
              stat.symbols += node.symbolCount || 0;
              if (node.language) stat.langs.set(node.language, (stat.langs.get(node.language) || 0) + 1);
              dirStats.set(dir, stat);
            }
            if (node.children?.length) compactTree(node.children);
          }
        }
        compactTree(tree);
        const totalFiles = [...dirStats.values()].reduce((s, d) => s + d.files, 0);
        const totalSymbols = [...dirStats.values()].reduce((s, d) => s + d.symbols, 0);
        const lines: string[] = [`${totalFiles} files, ${totalSymbols} symbols in ${dirStats.size} directories:\n`];
        for (const [dir, stat] of [...dirStats.entries()].sort()) {
          const langSummary = [...stat.langs.entries()].map(([l, c]) => `${l}:${c}`).join(' ');
          lines.push(`${dir}/ (${stat.files} files, ${stat.symbols} symbols) ${langSummary}`);
        }
        return lines.join('\n');
      }

      // Default: tree format
      const lines: string[] = [];
      function renderTree(nodes: import('../../index').FileTreeNode[], prefix: string): void {
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          const isLast = i === nodes.length - 1;
          const connector = isLast ? '└── ' : '├── ';
          const childPrefix = prefix + (isLast ? '    ' : '│   ');
          const meta = includeMetadata && node.type === 'file' && node.language
            ? `  [${node.language}${node.symbolCount ? ` · ${node.symbolCount} symbols` : ''}]`
            : '';
          lines.push(`${prefix}${connector}${node.name}${meta}`);
          if (node.children?.length) renderTree(node.children, childPrefix);
        }
      }
      renderTree(tree, '');
      return lines.length > 0 ? lines.join('\n') : 'No indexed files found.';
    }

    case 'kirograph_affected': {
      const files = (args.files as string[]) ?? [];
      if (files.length === 0) return 'No files provided. Pass file paths in the "files" array.';

      const affected = cg.getAffectedTests(files, {
        depth: (args.depth as number) ?? 5,
        testPattern: args.testPattern as string | undefined,
      });

      if (affected.length === 0) return `No affected test files found for the provided ${files.length} changed file(s).`;
      return `Affected test files (${affected.length}) for ${files.length} changed file(s):\n\n` +
        affected.map(f => `- ${f}`).join('\n');
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

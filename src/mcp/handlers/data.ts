import KiroGraph from '../../index';

const queryTracker = new Map<string, { offsets: number[]; lastCall: number }>();

function checkPaginationLoop(dataset: string, offset: number | undefined, response: string): string {
  const now = Date.now();
  const key = dataset;
  const currentOffset = offset ?? 0;

  // Clean stale entries (older than 60s)
  for (const [k, v] of queryTracker) {
    if (now - v.lastCall > 60_000) queryTracker.delete(k);
  }

  const entry = queryTracker.get(key) ?? { offsets: [], lastCall: 0 };
  entry.offsets.push(currentOffset);
  entry.lastCall = now;

  // Keep only last 10 offsets
  if (entry.offsets.length > 10) entry.offsets = entry.offsets.slice(-10);
  queryTracker.set(key, entry);

  // Check for pagination pattern: >5 calls with incrementing offsets
  if (entry.offsets.length > 5) {
    const recent = entry.offsets.slice(-6);
    let isIncrementing = true;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i]! <= recent[i - 1]!) { isIncrementing = false; break; }
    }
    if (isIncrementing) {
      return response + '\n\n⚠ Pagination detected. Consider using kirograph_data_aggregate for summary statistics instead of paginating through all rows.';
    }
  }

  return response;
}

export async function handleData(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  switch (toolName) {
    case 'kirograph_data_list': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

      const { DataQueries } = await import('../../data/queries');
      const db = cg.getDatabase();
      db.applyDataSchema();
      const dq = new DataQueries(db.getRawDb());
      const datasets = dq.listDatasets();

      if (datasets.length === 0) return 'No datasets indexed. Run kirograph index or kirograph data reindex.';

      return datasets.map(ds => {
        const sizeMb = (ds.fileSize / 1024 / 1024).toFixed(2);
        return `${ds.id} (${ds.format})\n  File: ${ds.filePath}\n  Rows: ${ds.rowCount.toLocaleString()} | Columns: ${ds.columnCount} | Size: ${sizeMb} MB`;
      }).join('\n\n');
    }

    case 'kirograph_data_describe': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

      const { DataQueries } = await import('../../data/queries');
      const db = cg.getDatabase();
      db.applyDataSchema();
      const dq = new DataQueries(db.getRawDb());

      if (args.column) {
        const col = dq.describeColumn(args.dataset as string, args.column as string);
        if (!col) return `Column "${args.column}" not found in dataset "${args.dataset}".`;
        return [
          `Column: ${col.name}`,
          `Type: ${col.inferredType}`,
          `Nullable: ${col.nullable} (${(col.nullPct * 100).toFixed(1)}% null)`,
          `Cardinality: ${col.cardinality}`,
          col.minValue ? `Min: ${col.minValue}` : '',
          col.maxValue ? `Max: ${col.maxValue}` : '',
          col.meanValue !== null ? `Mean: ${col.meanValue.toFixed(2)}` : '',
          `Samples: ${col.sampleValues.join(', ')}`,
        ].filter(Boolean).join('\n');
      }

      const result = dq.describeDataset(args.dataset as string);
      if (!result) return `Dataset "${args.dataset}" not found. Use kirograph_data_list to see available datasets.`;

      const lines = [
        `Dataset: ${result.dataset.id} (${result.dataset.format})`,
        `File: ${result.dataset.filePath}`,
        `Rows: ${result.dataset.rowCount.toLocaleString()} | Columns: ${result.dataset.columnCount}`,
        '',
        'Columns:',
      ];
      for (const col of result.columns) {
        const nullInfo = col.nullable ? ` (${(col.nullPct * 100).toFixed(0)}% null)` : '';
        const samples = col.sampleValues.length > 0 ? ` — samples: ${col.sampleValues.slice(0, 3).join(', ')}` : '';
        const summary = col.summary ? ` [${col.summary}]` : '';
        lines.push(`  ${col.name}: ${col.inferredType}${nullInfo} [${col.cardinality} distinct]${samples}${summary}`);
      }

      // Validation rules
      const rules = dq.validationRules(args.dataset as string);
      if (rules && rules.length > 0) {
        lines.push('', 'Validation rules:');
        for (const r of rules.slice(0, 10)) {
          lines.push(`  ${r.column}: ${r.rules.join('; ')}`);
        }
      }

      // Sample data hints
      const hints = dq.sampleHints(args.dataset as string);
      if (hints && hints.length > 0) {
        lines.push('', 'Sample data hints:');
        for (const h of hints.slice(0, 10)) {
          lines.push(`  ${h.column}: ${h.hint}`);
        }
      }

      return lines.join('\n');
    }

    case 'kirograph_data_query': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

      const { DataQueries } = await import('../../data/queries');
      const db = cg.getDatabase();
      db.applyDataSchema();
      const dq = new DataQueries(db.getRawDb());

      const result = dq.queryRows(args.dataset as string, {
        filters: args.filters as any[],
        columns: args.columns as string[],
        limit: (args.limit as number) ?? 100,
        offset: (args.offset as number) ?? 0,
      });

      if (!result) return `Dataset "${args.dataset}" not found.`;
      if (result.rows.length === 0) return `No rows match the given filters (${result.totalMatching} total in dataset).`;

      const header = `${result.rows.length} rows returned (${result.totalMatching} total matching):\n`;
      const rowStrs = result.rows.slice(0, 50).map((row, i) => {
        const vals = Object.entries(row).map(([k, v]) => `${k}=${v ?? 'null'}`).join(', ');
        return `  ${i + 1}. ${vals}`;
      });
      if (result.rows.length > 50) rowStrs.push(`  …and ${result.rows.length - 50} more rows`);
      let response = header + rowStrs.join('\n');

      // Token budget enforcement
      const maxChars = config.dataMaxResponseTokens * 4;
      if (response.length > maxChars) {
        response = response.slice(0, maxChars) + '\n\n[truncated: response exceeded token budget]';
      }

      // Anti-loop detection
      response = checkPaginationLoop(args.dataset as string, args.offset as number | undefined, response);

      return response;
    }

    case 'kirograph_data_aggregate': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

      const { DataQueries } = await import('../../data/queries');
      const db = cg.getDatabase();
      db.applyDataSchema();
      const dq = new DataQueries(db.getRawDb());

      const result = dq.aggregate(args.dataset as string, {
        groupBy: (args.groupBy as string[]) ?? [],
        metrics: (args.metrics as any[]) ?? [],
        filters: args.filters as any[],
      });

      if (!result) return `Dataset "${args.dataset}" not found.`;
      if (result.rows.length === 0) return 'No results (empty dataset or all rows filtered out).';

      const keys = Object.keys(result.rows[0]);
      const header = keys.join(' | ');
      const separator = keys.map(() => '---').join(' | ');
      const rows = result.rows.slice(0, 100).map(row => keys.map(k => row[k] ?? 'null').join(' | '));

      let response = `${header}\n${separator}\n${rows.join('\n')}${result.rows.length > 100 ? `\n…and ${result.rows.length - 100} more groups` : ''}`;

      // Token budget enforcement
      const maxChars = config.dataMaxResponseTokens * 4;
      if (response.length > maxChars) {
        response = response.slice(0, maxChars) + '\n\n[truncated: response exceeded token budget]';
      }

      return response;
    }

    case 'kirograph_data_search': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

      const { DataQueries } = await import('../../data/queries');
      const db = cg.getDatabase();
      db.applyDataSchema();
      const dq = new DataQueries(db.getRawDb());

      const cols = dq.searchColumns(args.dataset as string, args.query as string);
      if (cols.length === 0) return `No columns matching "${args.query}" in dataset "${args.dataset}".`;

      return cols.map(c => {
        const samples = c.sampleValues.length > 0 ? ` — samples: ${c.sampleValues.slice(0, 3).join(', ')}` : '';
        return `${c.name}: ${c.inferredType} [${c.cardinality} distinct]${samples}`;
      }).join('\n');
    }

    case 'kirograph_data_join': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

      const { DataQueries } = await import('../../data/queries');
      const db = cg.getDatabase();
      db.applyDataSchema();
      const dq = new DataQueries(db.getRawDb());

      try {
        const result = dq.join({
          left: args.left as string,
          right: args.right as string,
          leftColumn: args.leftColumn as string,
          rightColumn: args.rightColumn as string,
          type: (args.type as any) ?? 'inner',
          columns: args.columns as string[] | undefined,
          limit: args.limit as number | undefined,
        });

        if (!result) return `Dataset not found. Verify both dataset IDs with kirograph_data_list.`;

        const joinTypeStr = String(args.type ?? 'inner').toUpperCase();
        const header = `Join: ${args.left}.${args.leftColumn} ${joinTypeStr} JOIN ${args.right}.${args.rightColumn}\nMatching rows: ${result.totalMatching} (showing ${result.rows.length})`;
        if (result.rows.length === 0) return `${header}\n\nNo matching rows.`;

        const lines = result.rows.map(r => JSON.stringify(r));
        let response = `${header}\n\n${lines.join('\n')}`;

        // Token budget enforcement
        const maxChars = config.dataMaxResponseTokens * 4;
        if (response.length > maxChars) {
          response = response.slice(0, maxChars) + '\n\n[truncated: response exceeded token budget]';
        }

        return response;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'kirograph_data_correlations': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

      const { DataQueries } = await import('../../data/queries');
      const db = cg.getDatabase();
      db.applyDataSchema();
      const dq = new DataQueries(db.getRawDb());

      const pairs = dq.correlations(args.dataset as string, args.threshold as number | undefined);
      if (pairs === null) return `Dataset "${args.dataset}" not found.`;
      if (pairs.length === 0) return `No correlations above threshold ${args.threshold ?? 0.3} found. The dataset may have fewer than 2 numeric columns or no significant correlations.`;

      const lines = pairs.map(p =>
        `${p.column1} ↔ ${p.column2}: ${p.correlation > 0 ? '+' : ''}${p.correlation.toFixed(4)} (${p.strength})`
      );
      return `Correlations for "${args.dataset}" (threshold: ${args.threshold ?? 0.3}):\n\n${lines.join('\n')}`;
    }

    case 'kirograph_data_quality': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

      const { DataQueries } = await import('../../data/queries');
      const db = cg.getDatabase();
      db.applyDataSchema();
      const dq = new DataQueries(db.getRawDb());

      const quality = dq.quality(args.dataset as string);
      if (quality === null) return `Dataset "${args.dataset}" not found.`;
      if (quality.length === 0) return `No quality issues detected in "${args.dataset}". All columns look healthy.`;

      const lines = quality.map(q =>
        `${q.column} (risk: ${(q.riskScore * 100).toFixed(0)}%): ${q.issues.join('; ')}`
      );
      return `Quality report for "${args.dataset}" (${quality.length} columns with issues):\n\n${lines.join('\n')}`;
    }

    case 'kirograph_data_drift': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

      const { DataQueries } = await import('../../data/queries');
      const db = cg.getDatabase();
      db.applyDataSchema();
      const dq = new DataQueries(db.getRawDb());

      const drift = dq.detectDrift(args.dataset as string);
      if (drift === null) return `Dataset "${args.dataset}" not found.`;
      if (!drift.hasDrift) {
        const rowDelta = drift.rowCountDelta !== 0
          ? ` (rows: ${drift.rowCountDelta > 0 ? '+' : ''}${drift.rowCountDelta})`
          : '';
        return `No schema drift detected for "${args.dataset}".${rowDelta}`;
      }
      const driftLines = [`Schema drift detected for "${args.dataset}":`];
      if (drift.addedColumns?.length) driftLines.push(`  Added columns: ${drift.addedColumns.join(', ')}`);
      if (drift.removedColumns?.length) driftLines.push(`  Removed columns: ${drift.removedColumns.join(', ')}`);
      if ((drift as any).typeChanges?.length) {
        for (const tc of (drift as any).typeChanges) {
          driftLines.push(`  Type change: ${tc.column} ${tc.from} → ${tc.to}`);
        }
      }
      if (drift.rowCountDelta !== 0) driftLines.push(`  Row count delta: ${drift.rowCountDelta > 0 ? '+' : ''}${drift.rowCountDelta}`);
      return driftLines.join('\n');
    }

    case 'kirograph_data_history': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

      const { DataQueries } = await import('../../data/queries');
      const db = cg.getDatabase();
      db.applyDataSchema();
      const dq = new DataQueries(db.getRawDb());

      const limit = Math.min(Number(args.limit ?? 10), 50);
      const history = dq.getHistory(args.dataset as string, limit);
      if (history === null) return `Dataset "${args.dataset}" not found.`;
      if (history.length === 0) return `No history snapshots for "${args.dataset}".`;

      const histLines = [`Schema history for "${args.dataset}" (${history.length} snapshot(s)):\n`];
      for (const snap of history) {
        const date = new Date(snap.snapshotAt).toISOString().replace('T', ' ').slice(0, 19);
        const colNames = snap.columns.map((c: any) => c.name).join(', ');
        histLines.push(`${date}  rows: ${snap.rowCount.toLocaleString()}  cols: ${snap.columnCount}  schema: ${colNames}`);
      }
      return histLines.join('\n');
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

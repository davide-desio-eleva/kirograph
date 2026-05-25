import { Command } from 'commander';
import { loadConfig } from '../../config';
import { dim, reset, violet, bold, green, value } from '../ui';

export function register(program: Command): void {
  const data = program
    .command('data')
    .description('Tabular data navigation (requires enableData: true)');

  // ── list ────────────────────────────────────────────────────────────────────
  data
    .command('list')
    .description('List all indexed datasets')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        console.error(`  ${dim}Then re-run:${reset} ${violet}${bold}kirograph index${reset}`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized. Run: kirograph init'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataQueries } = await import('../../data/queries');
      const dq = new DataQueries(db.getRawDb());
      const datasets = dq.listDatasets();

      if (datasets.length === 0) {
        console.log(`  ${dim}No datasets indexed.${reset} Run ${violet}${bold}kirograph index${reset} first.`);
        cg.close(); return;
      }

      if (opts.json) {
        console.log(JSON.stringify(datasets, null, 2));
      } else {
        console.log(`\n  ${bold}Indexed Datasets${reset} (${datasets.length})\n`);
        for (const ds of datasets) {
          const sizeMb = (ds.fileSize / 1024 / 1024).toFixed(2);
          console.log(`  ${green}${ds.id}${reset}`);
          console.log(`    ${dim}File:${reset} ${ds.filePath}  ${dim}Format:${reset} ${ds.format}`);
          console.log(`    ${dim}Rows:${reset} ${ds.rowCount.toLocaleString()}  ${dim}Columns:${reset} ${ds.columnCount}  ${dim}Size:${reset} ${sizeMb} MB`);
          console.log();
        }
      }
      cg.close();
    });

  // ── describe ────────────────────────────────────────────────────────────────
  data
    .command('describe <dataset>')
    .description('Show schema and column profiles for a dataset')
    .option('--column <name>', 'Deep dive on a single column')
    .option('--json', 'Output as JSON')
    .action(async (dataset: string, opts: { column?: string; json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataQueries } = await import('../../data/queries');
      const dq = new DataQueries(db.getRawDb());

      if (opts.column) {
        const col = dq.describeColumn(dataset, opts.column);
        if (!col) {
          console.error(`  ✖ Column "${opts.column}" not found in dataset "${dataset}".`);
          cg.close(); process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify(col, null, 2));
        } else {
          console.log(`\n  ${bold}${col.name}${reset} ${dim}(${col.inferredType})${reset}`);
          console.log(`    ${dim}Position:${reset}    ${col.position}`);
          console.log(`    ${dim}Nullable:${reset}    ${col.nullable ? 'yes' : 'no'} (${col.nullPct.toFixed(1)}% null, ${col.nullCount} nulls)`);
          console.log(`    ${dim}Cardinality:${reset} ${col.cardinality}`);
          if (col.minValue != null) console.log(`    ${dim}Min:${reset}         ${col.minValue}`);
          if (col.maxValue != null) console.log(`    ${dim}Max:${reset}         ${col.maxValue}`);
          if (col.meanValue != null) console.log(`    ${dim}Mean:${reset}        ${col.meanValue.toFixed(4)}`);
          if (col.sampleValues.length > 0) console.log(`    ${dim}Samples:${reset}     ${col.sampleValues.join(', ')}`);
          console.log();
        }
        cg.close(); return;
      }

      const info = dq.describeDataset(dataset);
      if (!info) {
        console.error(`  ✖ Dataset "${dataset}" not found. Run ${violet}${bold}kirograph data list${reset} to see available datasets.`);
        cg.close(); process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(info, null, 2));
      } else {
        const ds = info.dataset;
        const sizeMb = (ds.fileSize / 1024 / 1024).toFixed(2);
        console.log(`\n  ${bold}${ds.id}${reset}`);
        console.log(`  ${dim}File:${reset} ${ds.filePath}  ${dim}Format:${reset} ${ds.format}  ${dim}Size:${reset} ${sizeMb} MB`);
        console.log(`  ${dim}Rows:${reset} ${ds.rowCount.toLocaleString()}  ${dim}Columns:${reset} ${ds.columnCount}`);
        console.log(`\n  ${bold}Columns:${reset}\n`);

        const maxNameLen = Math.max(...info.columns.map(c => c.name.length), 4);
        console.log(`  ${'Name'.padEnd(maxNameLen)}  ${'Type'.padEnd(8)}  ${'Null%'.padEnd(6)}  ${'Card'.padEnd(6)}  Samples`);
        console.log(`  ${'-'.repeat(maxNameLen)}  ${'-'.repeat(8)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}  -------`);
        for (const col of info.columns) {
          const nullPct = col.nullPct > 0 ? `${col.nullPct.toFixed(1)}%` : '0%';
          const samples = col.sampleValues.slice(0, 3).join(', ');
          console.log(`  ${col.name.padEnd(maxNameLen)}  ${col.inferredType.padEnd(8)}  ${nullPct.padEnd(6)}  ${String(col.cardinality).padEnd(6)}  ${dim}${samples}${reset}`);
        }
        console.log();
      }
      cg.close();
    });

  // ── query ───────────────────────────────────────────────────────────────────
  data
    .command('query <dataset>')
    .description('Query rows with filters')
    .option('--filter <expr...>', 'Filters in format column:op:value (e.g. age:gt:18)')
    .option('--columns <cols>', 'Comma-separated column names to project')
    .option('--limit <n>', 'Max rows to return', '20')
    .option('--offset <n>', 'Offset for pagination', '0')
    .option('--json', 'Output as JSON')
    .action(async (dataset: string, opts: { filter?: string[]; columns?: string; limit?: string; offset?: string; json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataQueries } = await import('../../data/queries');
      const dq = new DataQueries(db.getRawDb());

      // Parse filters
      const filters = (opts.filter ?? []).map(f => {
        const parts = f.split(':');
        if (parts.length < 3) {
          console.error(`  ✖ Invalid filter format: "${f}". Expected column:op:value`);
          process.exit(1);
        }
        const column = parts[0]!;
        const op = parts[1]! as any;
        const val = parts.slice(2).join(':'); // value may contain colons
        return { column, op, value: val };
      });

      const columns = opts.columns ? opts.columns.split(',').map(c => c.trim()) : undefined;
      const limit = parseInt(opts.limit ?? '20', 10);
      const offset = parseInt(opts.offset ?? '0', 10);

      const result = dq.queryRows(dataset, { filters, columns, limit, offset });
      if (!result) {
        console.error(`  ✖ Dataset "${dataset}" not found.`);
        cg.close(); process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${dim}Showing ${result.rows.length} of ${result.totalMatching} matching rows${reset}\n`);
        if (result.rows.length > 0) {
          // Simple table output
          const keys = Object.keys(result.rows[0]!).filter(k => k !== 'rowid');
          const widths = keys.map(k => Math.max(k.length, ...result.rows.map(r => String(r[k] ?? '').slice(0, 30).length)));
          // Header
          console.log('  ' + keys.map((k, i) => k.padEnd(widths[i]!)).join('  '));
          console.log('  ' + widths.map(w => '-'.repeat(w)).join('  '));
          // Rows
          for (const row of result.rows) {
            console.log('  ' + keys.map((k, i) => String(row[k] ?? '').slice(0, 30).padEnd(widths[i]!)).join('  '));
          }
        }
        console.log();
      }
      cg.close();
    });

  // ── aggregate ───────────────────────────────────────────────────────────────
  data
    .command('aggregate <dataset>')
    .description('Server-side aggregation (GROUP BY)')
    .requiredOption('--group-by <cols>', 'Comma-separated columns to group by')
    .requiredOption('--metric <expr...>', 'Metrics in format op:column (e.g. sum:amount, avg:price)')
    .option('--filter <expr...>', 'Filters in format column:op:value')
    .option('--json', 'Output as JSON')
    .action(async (dataset: string, opts: { groupBy: string; metric: string[]; filter?: string[]; json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataQueries } = await import('../../data/queries');
      const dq = new DataQueries(db.getRawDb());

      const groupBy = opts.groupBy.split(',').map(c => c.trim());
      const metrics = opts.metric.map(m => {
        const [op, ...colParts] = m.split(':');
        const column = colParts.join(':');
        if (!op || !column) {
          console.error(`  ✖ Invalid metric format: "${m}". Expected op:column (e.g. sum:amount)`);
          process.exit(1);
        }
        return { op: op as any, column };
      });

      const filters = (opts.filter ?? []).map(f => {
        const parts = f.split(':');
        if (parts.length < 3) { console.error(`  ✖ Invalid filter: "${f}"`); process.exit(1); }
        return { column: parts[0]!, op: parts[1]! as any, value: parts.slice(2).join(':') };
      });

      const result = dq.aggregate(dataset, { groupBy, metrics, filters });
      if (!result) {
        console.error(`  ✖ Dataset "${dataset}" not found.`);
        cg.close(); process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${dim}${result.rows.length} groups${reset}\n`);
        if (result.rows.length > 0) {
          const keys = Object.keys(result.rows[0]!);
          const widths = keys.map(k => Math.max(k.length, ...result.rows.map(r => String(r[k] ?? '').slice(0, 20).length)));
          console.log('  ' + keys.map((k, i) => k.padEnd(widths[i]!)).join('  '));
          console.log('  ' + widths.map(w => '-'.repeat(w)).join('  '));
          for (const row of result.rows) {
            console.log('  ' + keys.map((k, i) => String(row[k] ?? '').slice(0, 20).padEnd(widths[i]!)).join('  '));
          }
        }
        console.log();
      }
      cg.close();
    });

  // ── search ──────────────────────────────────────────────────────────────────
  data
    .command('search <dataset> <query>')
    .description('Search column names and sample values by keyword')
    .option('--json', 'Output as JSON')
    .action(async (dataset: string, query: string, opts: { json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataQueries } = await import('../../data/queries');
      const dq = new DataQueries(db.getRawDb());
      const results = dq.searchColumns(dataset, query);

      if (results.length === 0) {
        console.log(`  ${dim}No columns matching "${query}" in dataset "${dataset}".${reset}`);
        cg.close(); return;
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(`\n  ${bold}Columns matching "${query}"${reset} (${results.length})\n`);
        for (const col of results) {
          const samples = col.sampleValues.slice(0, 5).join(', ');
          console.log(`  ${green}${col.name}${reset} ${dim}(${col.inferredType})${reset}`);
          console.log(`    ${dim}Cardinality:${reset} ${col.cardinality}  ${dim}Null:${reset} ${col.nullPct.toFixed(1)}%`);
          if (samples) console.log(`    ${dim}Samples:${reset} ${samples}`);
          console.log();
        }
      }
      cg.close();
    });

  // ── index ───────────────────────────────────────────────────────────────────
  data
    .command('index')
    .description('Index all data files (incremental)')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        console.error(`  ${dim}Then re-run:${reset} ${violet}${bold}kirograph index${reset}`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized. Run: kirograph init'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataIndexer } = await import('../../data/indexer');
      const indexer = new DataIndexer(db.getRawDb(), config, cwd);
      const result = await indexer.indexAll({
        onProgress: (msg) => { if (!opts.json) console.log(`  ${dim}${msg}${reset}`); },
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${green}✓${reset} Indexed ${bold}${result.datasetsIndexed}${reset} datasets, ${result.rowsIndexed.toLocaleString()} rows, ${result.columnsProfiled} columns (${result.duration}ms)`);
        if (result.errors.length > 0) {
          console.log(`  ${dim}Errors (${result.errors.length}):${reset}`);
          for (const err of result.errors.slice(0, 5)) {
            console.log(`    ✖ ${err}`);
          }
        }
        console.log();
      }
      cg.close();
    });

  // ── reindex ─────────────────────────────────────────────────────────────────
  data
    .command('reindex')
    .description('Force re-index all data files (ignores content hashes)')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataIndexer } = await import('../../data/indexer');
      const indexer = new DataIndexer(db.getRawDb(), config, cwd);
      const result = await indexer.indexAll({
        force: true,
        onProgress: (msg) => { if (!opts.json) console.log(`  ${dim}${msg}${reset}`); },
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${green}✓${reset} Re-indexed ${bold}${result.datasetsIndexed}${reset} datasets, ${result.rowsIndexed.toLocaleString()} rows, ${result.columnsProfiled} columns (${result.duration}ms)`);
        if (result.errors.length > 0) {
          console.log(`  ${dim}Errors (${result.errors.length}):${reset}`);
          for (const err of result.errors.slice(0, 5)) {
            console.log(`    ✖ ${err}`);
          }
        }
        console.log();
      }
      cg.close();
    });

  // ── join ────────────────────────────────────────────────────────────────────
  data
    .command('join <left> <right>')
    .description('SQL JOIN across two indexed datasets')
    .requiredOption('--left-col <col>', 'Join column from left dataset')
    .requiredOption('--right-col <col>', 'Join column from right dataset')
    .option('--type <type>', 'Join type: inner, left, right', 'inner')
    .option('--columns <cols>', 'Comma-separated column projection (prefix with dataset ID)')
    .option('--limit <n>', 'Max rows', '100')
    .option('--json', 'Output as JSON')
    .action(async (left: string, right: string, opts: { leftCol: string; rightCol: string; type?: string; columns?: string; limit?: string; json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataQueries } = await import('../../data/queries');
      const dq = new DataQueries(db.getRawDb());

      try {
        const result = dq.join({
          left,
          right,
          leftColumn: opts.leftCol,
          rightColumn: opts.rightCol,
          type: (opts.type as any) ?? 'inner',
          columns: opts.columns ? opts.columns.split(',').map(c => c.trim()) : undefined,
          limit: parseInt(opts.limit ?? '100', 10),
        });

        if (!result) {
          console.error(`  ✖ One or both datasets not found. Run ${violet}${bold}kirograph data list${reset} to see available datasets.`);
          cg.close(); process.exit(1);
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`\n  ${dim}${opts.type?.toUpperCase() ?? 'INNER'} JOIN: ${left}.${opts.leftCol} = ${right}.${opts.rightCol}${reset}`);
          console.log(`  ${dim}Showing ${result.rows.length} of ${result.totalMatching} matching rows${reset}\n`);
          if (result.rows.length > 0) {
            const keys = Object.keys(result.rows[0]!);
            const widths = keys.map(k => Math.max(k.length, ...result.rows.map(r => String(r[k] ?? '').slice(0, 25).length)));
            console.log('  ' + keys.map((k, i) => k.padEnd(widths[i]!)).join('  '));
            console.log('  ' + widths.map(w => '-'.repeat(w)).join('  '));
            for (const row of result.rows) {
              console.log('  ' + keys.map((k, i) => String(row[k] ?? '').slice(0, 25).padEnd(widths[i]!)).join('  '));
            }
          }
          console.log();
        }
      } catch (err) {
        console.error(`  ✖ ${err instanceof Error ? err.message : String(err)}`);
        cg.close(); process.exit(1);
      }
      cg.close();
    });

  // ── correlations ────────────────────────────────────────────────────────────
  data
    .command('correlations <dataset>')
    .description('Pairwise Pearson correlations between numeric columns')
    .option('--threshold <n>', 'Min absolute correlation to include', '0.3')
    .option('--json', 'Output as JSON')
    .action(async (dataset: string, opts: { threshold?: string; json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataQueries } = await import('../../data/queries');
      const dq = new DataQueries(db.getRawDb());
      const threshold = parseFloat(opts.threshold ?? '0.3');
      const pairs = dq.correlations(dataset, threshold);

      if (pairs === null) {
        console.error(`  ✖ Dataset "${dataset}" not found.`);
        cg.close(); process.exit(1);
      }

      if (pairs.length === 0) {
        console.log(`  ${dim}No correlations above threshold ${threshold}.${reset}`);
        cg.close(); return;
      }

      if (opts.json) {
        console.log(JSON.stringify(pairs, null, 2));
      } else {
        console.log(`\n  ${bold}Correlations${reset} (threshold: ${threshold}, ${pairs.length} pairs)\n`);
        for (const p of pairs) {
          const sign = p.correlation > 0 ? '+' : '';
          const bar = '█'.repeat(Math.round(Math.abs(p.correlation) * 10));
          const color = p.strength === 'strong' ? green : dim;
          console.log(`  ${color}${bar}${reset} ${sign}${p.correlation.toFixed(4)}  ${p.column1} ↔ ${p.column2}  ${dim}(${p.strength})${reset}`);
        }
        console.log();
      }
      cg.close();
    });

  // ── quality ─────────────────────────────────────────────────────────────────
  data
    .command('quality <dataset>')
    .description('Data quality triage: rank columns by risk')
    .option('--json', 'Output as JSON')
    .action(async (dataset: string, opts: { json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataQueries } = await import('../../data/queries');
      const dq = new DataQueries(db.getRawDb());
      const quality = dq.quality(dataset);

      if (quality === null) {
        console.error(`  ✖ Dataset "${dataset}" not found.`);
        cg.close(); process.exit(1);
      }

      if (quality.length === 0) {
        console.log(`  ${green}✓${reset} No quality issues detected. All columns look healthy.`);
        cg.close(); return;
      }

      if (opts.json) {
        console.log(JSON.stringify(quality, null, 2));
      } else {
        console.log(`\n  ${bold}Quality Report${reset} (${quality.length} columns with issues)\n`);
        for (const q of quality) {
          const pct = (q.riskScore * 100).toFixed(0);
          const bar = '█'.repeat(Math.round(q.riskScore * 10));
          console.log(`  ${bar} ${pct}%  ${bold}${q.column}${reset}`);
          for (const issue of q.issues) {
            console.log(`       ${dim}• ${issue}${reset}`);
          }
        }
        console.log();
      }
      cg.close();
    });

  // ── history ──────────────────────────────────────────────────────────────────
  data
    .command('history <dataset>')
    .description('Show history of schema changes for a dataset')
    .option('--limit <n>', 'Max snapshots to show', '10')
    .option('--json', 'Output as JSON')
    .action(async (dataset: string, opts: { limit?: string; json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataQueries } = await import('../../data/queries');
      const dq = new DataQueries(db.getRawDb());
      const limit = parseInt(opts.limit ?? '10', 10);
      const history = dq.getHistory(dataset, limit);

      if (history === null) {
        console.error(`  ✖ Dataset "${dataset}" not found.`);
        cg.close(); process.exit(1);
      }

      if (history.length === 0) {
        console.log(`  ${dim}No history snapshots for "${dataset}".${reset}`);
        cg.close(); return;
      }

      if (opts.json) {
        console.log(JSON.stringify(history, null, 2));
      } else {
        console.log(`\n  ${bold}Schema History${reset} for ${green}${dataset}${reset} (${history.length} snapshots)\n`);
        for (const snap of history) {
          const date = new Date(snap.snapshotAt).toISOString().replace('T', ' ').slice(0, 19);
          console.log(`  ${bold}${date}${reset}`);
          console.log(`    ${dim}Rows:${reset} ${snap.rowCount.toLocaleString()}  ${dim}Columns:${reset} ${snap.columnCount}  ${dim}Hash:${reset} ${snap.contentHash.slice(0, 12)}…`);
          const colNames = snap.columns.map(c => c.name).join(', ');
          console.log(`    ${dim}Schema:${reset} ${colNames}`);
          console.log();
        }
      }
      cg.close();
    });

  // ── drift ───────────────────────────────────────────────────────────────────
  data
    .command('drift <dataset>')
    .description('Show schema drift between last two indexes')
    .option('--json', 'Output as JSON')
    .action(async (dataset: string, opts: { json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataQueries } = await import('../../data/queries');
      const dq = new DataQueries(db.getRawDb());
      const drift = dq.detectDrift(dataset);

      if (drift === null) {
        console.error(`  ✖ Dataset "${dataset}" not found.`);
        cg.close(); process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(drift, null, 2));
      } else {
        if (!drift.hasDrift) {
          console.log(`\n  ${green}✓${reset} No schema drift detected for "${dataset}".`);
          if (drift.rowCountDelta !== 0) {
            const sign = drift.rowCountDelta > 0 ? '+' : '';
            console.log(`    ${dim}Row count change:${reset} ${sign}${drift.rowCountDelta}`);
          }
        } else {
          console.log(`\n  ${bold}Schema Drift${reset} for ${green}${dataset}${reset}\n`);
          if (drift.addedColumns.length > 0) {
            console.log(`  ${green}+ Added columns:${reset} ${drift.addedColumns.join(', ')}`);
          }
          if (drift.removedColumns.length > 0) {
            console.log(`  ${value}− Removed columns:${reset} ${drift.removedColumns.join(', ')}`);
          }
          if (drift.changedColumns.length > 0) {
            console.log(`  ${bold}~ Changed columns:${reset}`);
            for (const col of drift.changedColumns) {
              console.log(`    ${col.name}: ${col.changes.join(', ')}`);
            }
          }
          if (drift.rowCountDelta !== 0) {
            const sign = drift.rowCountDelta > 0 ? '+' : '';
            console.log(`\n  ${dim}Row count change:${reset} ${sign}${drift.rowCountDelta}`);
          }
        }
        console.log();
      }
      cg.close();
    });

  // ── lint ────────────────────────────────────────────────────────────────────
  data
    .command('lint')
    .description('Validate data index integrity')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.enableData) {
        console.error(`  ✖ Data indexing is not enabled. Set ${violet}${bold}enableData: true${reset} in .kirograph/config.json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ KiroGraph not initialized.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyDataSchema();

      const { DataLinter } = await import('../../data/lint');
      const linter = new DataLinter(db.getRawDb(), cwd);
      const result = linter.lint();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${bold}Data Lint${reset} — ${result.datasetsChecked} datasets checked, ${result.healthy} healthy\n`);
        if (result.issues.length === 0) {
          console.log(`  ${green}✓${reset} No issues found. Index is healthy.`);
        } else {
          for (const issue of result.issues) {
            const icon = issue.severity === 'error' ? '✖' : issue.severity === 'warning' ? '⚠' : 'ℹ';
            const prefix = issue.dataset ? `[${issue.dataset}] ` : '';
            console.log(`  ${icon} ${prefix}${issue.message}`);
          }
        }
        console.log();
      }
      cg.close();
    });
}

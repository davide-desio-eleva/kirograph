/**
 * Data Indexer
 *
 * Orchestrates: scan data files → parse → profile columns → persist rows to SQLite.
 * Supports incremental re-indexing via content hashes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import picomatch from 'picomatch';
import type { KiroGraphConfig } from '../config';
import type { DataSet, DataColumn, DataIndexResult, ParsedRow } from './types';
import { getDataParser } from './parsers/index';
import { ColumnProfiler } from './profiler';

/**
 * Generate a dataset ID from a file path.
 * Slugifies the relative path: tests/fixtures/users.csv → tests-fixtures-users
 */
function generateDatasetId(filePath: string): string {
  return filePath
    .replace(/\.[^.]+$/, '')  // remove extension
    .replace(/[/\\]/g, '-')   // replace path separators
    .replace(/[^a-zA-Z0-9-_]/g, '-') // replace special chars
    .replace(/-+/g, '-')      // collapse multiple dashes
    .replace(/^-|-$/g, '')    // trim leading/trailing dashes
    .toLowerCase();
}

export class DataIndexer {
  private readonly db: any;
  private readonly config: KiroGraphConfig;
  private readonly projectRoot: string;

  constructor(db: any, config: KiroGraphConfig, projectRoot: string) {
    this.db = db;
    this.config = config;
    this.projectRoot = projectRoot;
  }

  async indexAll(opts?: { force?: boolean; onProgress?: (msg: string) => void }): Promise<DataIndexResult> {
    const start = Date.now();
    const result: DataIndexResult = {
      datasetsIndexed: 0, rowsIndexed: 0, columnsProfiled: 0, errors: [], duration: 0,
    };

    const files = this.scanDataFiles();
    opts?.onProgress?.(`data: found ${files.length} data files`);

    for (const relPath of files) {
      try {
        const indexed = await this.indexFile(relPath, opts?.force ?? false);
        if (indexed) {
          result.datasetsIndexed++;
          result.rowsIndexed += indexed.rows;
          result.columnsProfiled += indexed.columns;
        }
      } catch (err) {
        result.errors.push(`${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Remove datasets for files that no longer exist
    this.removeDeletedDatasets(files);

    // Link data files to code (if enabled)
    if ((this.config as any).dataLinkCode !== false && result.datasetsIndexed > 0) {
      try {
        const { DataCodeLinker } = await import('./linker');
        const linker = new DataCodeLinker(this.db, this.projectRoot);
        const refsCreated = linker.linkAll();
        opts?.onProgress?.(`data: linked ${refsCreated} code references`);
      } catch {
        // Non-critical — linking failure shouldn't block indexing
      }
    }

    result.duration = Date.now() - start;
    return result;
  }

  async indexFile(relPath: string, force = false): Promise<{ rows: number; columns: number } | null> {
    const absPath = path.join(this.projectRoot, relPath);
    if (!fs.existsSync(absPath)) return null;

    const stat = fs.statSync(absPath);
    if (stat.size > (this.config as any).dataMaxFileSize) return null;

    // Check content hash for incremental
    const fileBuffer = fs.readFileSync(absPath);
    const contentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    const datasetId = generateDatasetId(relPath);

    if (!force) {
      const existing = this.db.get('SELECT content_hash FROM data_datasets WHERE id = ?', [datasetId]);
      if (existing?.content_hash === contentHash) return null; // unchanged
    }

    // Get parser
    const parser = getDataParser(relPath);
    if (!parser) return null;

    // Parse and profile
    const profiler = new ColumnProfiler();
    const allRows: ParsedRow[] = [];
    const maxRows = (this.config as any).dataMaxRows ?? 1_000_000;

    const { columns, totalRows } = await parser.parse(absPath, {
      maxRows,
      onBatch: (rows, cols) => {
        profiler.addBatch(rows, cols);
        allRows.push(...rows);
      },
    });

    if (columns.length === 0) return null;

    // Finalize profiles
    const columnProfiles = profiler.finalize(datasetId);

    // Persist in transaction
    this.db.run('BEGIN');
    try {
      // Delete old dataset data
      const rowTableName = `data_rows_${datasetId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      this.db.run(`DROP TABLE IF EXISTS "${rowTableName}"`);
      this.db.run('DELETE FROM data_columns WHERE dataset_id = ?', [datasetId]);
      this.db.run('DELETE FROM data_datasets WHERE id = ?', [datasetId]);

      // Insert dataset
      this.db.run(`
        INSERT INTO data_datasets (id, file_path, format, row_count, column_count, file_size, content_hash, summary, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [datasetId, relPath, parser.name, totalRows, columns.length, stat.size, contentHash, null, Date.now()]);

      // Insert column profiles
      for (const col of columnProfiles) {
        this.db.run(`
          INSERT INTO data_columns (id, dataset_id, name, position, inferred_type, nullable, null_count, null_pct, cardinality, min_value, max_value, mean_value, sample_values, summary, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          col.id, col.datasetId, col.name, col.position, col.inferredType,
          col.nullable ? 1 : 0, col.nullCount, col.nullPct, col.cardinality,
          col.minValue, col.maxValue, col.meanValue,
          JSON.stringify(col.sampleValues), col.summary, col.updatedAt,
        ]);
      }

      // Create row table with dynamic schema
      const colDefs = columns.map(c => `"${c.replace(/"/g, '""')}" TEXT`).join(', ');
      this.db.run(`CREATE TABLE "${rowTableName}" (rowid INTEGER PRIMARY KEY AUTOINCREMENT, ${colDefs})`);

      // Insert rows in batches
      const colNames = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      const insertStmt = `INSERT INTO "${rowTableName}" (${colNames}) VALUES (${placeholders})`;

      for (const row of allRows) {
        const values = columns.map(c => {
          const v = row[c];
          if (v === null || v === undefined) return null;
          if (typeof v === 'object') return JSON.stringify(v);
          return v;
        });
        this.db.run(insertStmt, values);
      }

      // Save history snapshot for drift detection
      const historyColumns = columnProfiles.map(col => ({
        name: col.name,
        type: col.inferredType,
        cardinality: col.cardinality,
        nullPct: col.nullPct,
      }));
      this.db.run(`
        INSERT INTO data_dataset_history (dataset_id, snapshot_at, row_count, column_count, columns_json, content_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [datasetId, Date.now(), totalRows, columns.length, JSON.stringify(historyColumns), contentHash]);

      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    return { rows: totalRows, columns: columns.length };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private scanDataFiles(): string[] {
    const includePatterns = (this.config as any).dataInclude ?? [];
    const excludePatterns = (this.config as any).dataExclude ?? [];
    const includeMatchers = includePatterns.map((p: string) => picomatch(p));
    const excludeMatchers = excludePatterns.map((p: string) => picomatch(p));
    const results: string[] = [];

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.projectRoot, full).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          if (excludeMatchers.some((m: any) => m(rel + '/'))) continue;
          walk(full);
        } else if (entry.isFile()) {
          if (excludeMatchers.some((m: any) => m(rel))) continue;
          if (includeMatchers.some((m: any) => m(rel))) {
            // Verify a parser exists for this format
            if (getDataParser(rel)) {
              results.push(rel);
            }
          }
        }
      }
    };

    walk(this.projectRoot);
    return results;
  }

  private removeDeletedDatasets(currentFiles: string[]): void {
    const currentSet = new Set(currentFiles.map(f => generateDatasetId(f)));
    const indexed = (this.db.all('SELECT id FROM data_datasets') as Array<{ id: string }>).map(r => r.id);

    for (const id of indexed) {
      if (!currentSet.has(id)) {
        const rowTableName = `data_rows_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        this.db.run(`DROP TABLE IF EXISTS "${rowTableName}"`);
        this.db.run('DELETE FROM data_columns WHERE dataset_id = ?', [id]);
        this.db.run('DELETE FROM data_code_refs WHERE dataset_id = ?', [id]);
        this.db.run('DELETE FROM data_datasets WHERE id = ?', [id]);
      }
    }
  }
}

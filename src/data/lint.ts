/**
 * Data Lint
 *
 * Integrity checks for the data index:
 * - Row count mismatch (stored vs actual table rows)
 * - Schema consistency (columns in profile vs actual table)
 * - Stale datasets (source file deleted or changed)
 * - Missing optional deps (files skipped due to missing xlsx/parquetjs-lite)
 * - Orphan code refs (refs pointing to deleted datasets)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface LintIssue {
  severity: 'error' | 'warning' | 'info';
  dataset?: string;
  message: string;
}

export interface LintResult {
  issues: LintIssue[];
  datasetsChecked: number;
  healthy: number;
}

export class DataLinter {
  private readonly db: any;
  private readonly projectRoot: string;

  constructor(db: any, projectRoot: string) {
    this.db = db;
    this.projectRoot = projectRoot;
  }

  lint(): LintResult {
    const issues: LintIssue[] = [];
    const datasets = this.db.all('SELECT * FROM data_datasets') as any[];
    let healthy = 0;

    for (const ds of datasets) {
      const dsIssues: LintIssue[] = [];

      // Check source file exists
      const absPath = path.join(this.projectRoot, ds.file_path);
      if (!fs.existsSync(absPath)) {
        dsIssues.push({ severity: 'error', dataset: ds.id, message: `Source file missing: ${ds.file_path}` });
      } else {
        // Check content hash (stale detection)
        try {
          const content = fs.readFileSync(absPath);
          const currentHash = crypto.createHash('sha256').update(content).digest('hex');
          if (currentHash !== ds.content_hash) {
            dsIssues.push({ severity: 'warning', dataset: ds.id, message: `Content changed since last index (hash mismatch). Run kirograph data reindex.` });
          }
        } catch {
          dsIssues.push({ severity: 'warning', dataset: ds.id, message: `Cannot read source file: ${ds.file_path}` });
        }
      }

      // Check row count matches actual table
      const tableName = `data_rows_${ds.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      try {
        const countRow = this.db.get(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
        const actualRows = countRow?.cnt ?? 0;
        if (actualRows !== ds.row_count) {
          dsIssues.push({ severity: 'error', dataset: ds.id, message: `Row count mismatch: metadata says ${ds.row_count}, table has ${actualRows}` });
        }
      } catch {
        dsIssues.push({ severity: 'error', dataset: ds.id, message: `Row table "${tableName}" does not exist` });
      }

      // Check column count matches profiles
      const profileCount = this.db.get('SELECT COUNT(*) as cnt FROM data_columns WHERE dataset_id = ?', [ds.id])?.cnt ?? 0;
      if (profileCount !== ds.column_count) {
        dsIssues.push({ severity: 'warning', dataset: ds.id, message: `Column count mismatch: metadata says ${ds.column_count}, profiles has ${profileCount}` });
      }

      if (dsIssues.length === 0) {
        healthy++;
      }
      issues.push(...dsIssues);
    }

    // Check for orphan code refs
    const orphanRefs = this.db.all(`
      SELECT r.dataset_id, r.qualified_name FROM data_code_refs r
      LEFT JOIN data_datasets d ON r.dataset_id = d.id
      WHERE d.id IS NULL
    `) as any[];

    if (orphanRefs.length > 0) {
      issues.push({ severity: 'warning', message: `${orphanRefs.length} orphan code ref(s) pointing to deleted datasets` });
    }

    // Check for missing optional deps
    try {
      require.resolve('xlsx');
    } catch {
      // Check if any xlsx/xls files exist in include patterns
      const xlsxFiles = this.db.all(`SELECT file_path FROM data_datasets WHERE format IN ('xlsx', 'xls')`) as any[];
      if (xlsxFiles.length === 0) {
        // Check if there are xlsx files on disk that were skipped
        issues.push({ severity: 'info', message: `Optional dep 'xlsx' not installed. Excel files (.xlsx/.xls) will be skipped during indexing.` });
      }
    }

    try {
      require.resolve('parquetjs-lite');
    } catch {
      issues.push({ severity: 'info', message: `Optional dep 'parquetjs-lite' not installed. Parquet files will be skipped during indexing.` });
    }

    return { issues, datasetsChecked: datasets.length, healthy };
  }
}

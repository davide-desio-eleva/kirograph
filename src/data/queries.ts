/**
 * Data Queries
 *
 * Read-side helpers for MCP tools and CLI commands.
 * Handles: list, describe, query (with filters), aggregate, search.
 */

import type { DataSet, DataColumn, QueryFilter, AggregateMetric, CorrelationPair, JoinType, ColumnQuality } from './types';
import { buildWhereClause } from './filters';

export interface ValidationRule {
  column: string;
  rules: string[];
}

export interface SampleHint {
  column: string;
  hint: string;
}

export class DataQueries {
  private readonly db: any;

  constructor(db: any) {
    this.db = db;
  }

  // ── List ────────────────────────────────────────────────────────────────────

  listDatasets(): DataSet[] {
    const rows = this.db.all('SELECT * FROM data_datasets ORDER BY file_path') as any[];
    return rows.map(r => ({
      id: r.id,
      filePath: r.file_path,
      format: r.format,
      rowCount: r.row_count,
      columnCount: r.column_count,
      fileSize: r.file_size,
      contentHash: r.content_hash,
      summary: r.summary,
      indexedAt: r.indexed_at,
    }));
  }

  // ── Describe ────────────────────────────────────────────────────────────────

  describeDataset(datasetId: string): { dataset: DataSet; columns: DataColumn[] } | null {
    const ds = this.db.get('SELECT * FROM data_datasets WHERE id = ?', [datasetId]);
    if (!ds) return null;

    const cols = this.db.all(
      'SELECT * FROM data_columns WHERE dataset_id = ? ORDER BY position',
      [datasetId],
    ) as any[];

    return {
      dataset: {
        id: ds.id, filePath: ds.file_path, format: ds.format,
        rowCount: ds.row_count, columnCount: ds.column_count,
        fileSize: ds.file_size, contentHash: ds.content_hash,
        summary: ds.summary, indexedAt: ds.indexed_at,
      },
      columns: cols.map(c => ({
        id: c.id, datasetId: c.dataset_id, name: c.name, position: c.position,
        inferredType: c.inferred_type, nullable: !!c.nullable,
        nullCount: c.null_count, nullPct: c.null_pct, cardinality: c.cardinality,
        minValue: c.min_value, maxValue: c.max_value, meanValue: c.mean_value,
        sampleValues: c.sample_values ? JSON.parse(c.sample_values) : [],
        summary: c.summary, updatedAt: c.updated_at,
      })),
    };
  }

  describeColumn(datasetId: string, columnName: string): DataColumn | null {
    const col = this.db.get(
      'SELECT * FROM data_columns WHERE dataset_id = ? AND name = ?',
      [datasetId, columnName],
    );
    if (!col) return null;
    return {
      id: col.id, datasetId: col.dataset_id, name: col.name, position: col.position,
      inferredType: col.inferred_type, nullable: !!col.nullable,
      nullCount: col.null_count, nullPct: col.null_pct, cardinality: col.cardinality,
      minValue: col.min_value, maxValue: col.max_value, meanValue: col.mean_value,
      sampleValues: col.sample_values ? JSON.parse(col.sample_values) : [],
      summary: col.summary, updatedAt: col.updated_at,
    };
  }

  // ── Query (filtered rows) ───────────────────────────────────────────────────

  queryRows(
    datasetId: string,
    opts?: { filters?: QueryFilter[]; columns?: string[]; limit?: number; offset?: number },
  ): { rows: any[]; totalMatching: number } | null {
    const ds = this.db.get('SELECT * FROM data_datasets WHERE id = ?', [datasetId]);
    if (!ds) return null;

    const tableName = `data_rows_${datasetId.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    // Get valid columns
    const validCols = new Set<string>(
      (this.db.all('SELECT name FROM data_columns WHERE dataset_id = ?', [datasetId]) as any[]).map(r => r.name),
    );

    // Build WHERE clause
    const { where, params } = buildWhereClause(opts?.filters ?? [], validCols);

    // Column projection
    let selectCols = '*';
    if (opts?.columns && opts.columns.length > 0) {
      for (const c of opts.columns) {
        if (!validCols.has(c)) throw new Error(`Invalid column: "${c}"`);
      }
      selectCols = opts.columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
    }

    const limit = Math.min(opts?.limit ?? 500, 500); // hard cap
    const offset = opts?.offset ?? 0;

    // Count total matching
    const countRow = this.db.get(`SELECT COUNT(*) as cnt FROM "${tableName}" ${where}`, params);
    const totalMatching = countRow?.cnt ?? 0;

    // Fetch rows
    const rows = this.db.all(
      `SELECT ${selectCols} FROM "${tableName}" ${where} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return { rows, totalMatching };
  }

  // ── Aggregate ───────────────────────────────────────────────────────────────

  aggregate(
    datasetId: string,
    opts: { groupBy: string[]; metrics: AggregateMetric[]; filters?: QueryFilter[] },
  ): { rows: any[] } | null {
    const ds = this.db.get('SELECT * FROM data_datasets WHERE id = ?', [datasetId]);
    if (!ds) return null;

    const tableName = `data_rows_${datasetId.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    // Get valid columns
    const validCols = new Set<string>(
      (this.db.all('SELECT name FROM data_columns WHERE dataset_id = ?', [datasetId]) as any[]).map(r => r.name),
    );

    // Validate group by columns
    for (const col of opts.groupBy) {
      if (!validCols.has(col)) throw new Error(`Invalid group-by column: "${col}"`);
    }

    // Build SELECT clause
    const selectParts: string[] = [];
    for (const col of opts.groupBy) {
      selectParts.push(`"${col.replace(/"/g, '""')}"`);
    }
    for (const metric of opts.metrics) {
      if (!validCols.has(metric.column) && metric.op !== 'count') {
        throw new Error(`Invalid metric column: "${metric.column}"`);
      }
      const colRef = `"${metric.column.replace(/"/g, '""')}"`;
      const alias = metric.alias ?? `${metric.op}_${metric.column}`;
      switch (metric.op) {
        case 'count': selectParts.push(`COUNT(${colRef}) as "${alias}"`); break;
        case 'count_distinct': selectParts.push(`COUNT(DISTINCT ${colRef}) as "${alias}"`); break;
        case 'sum': selectParts.push(`SUM(CAST(${colRef} AS REAL)) as "${alias}"`); break;
        case 'avg': selectParts.push(`AVG(CAST(${colRef} AS REAL)) as "${alias}"`); break;
        case 'min': selectParts.push(`MIN(${colRef}) as "${alias}"`); break;
        case 'max': selectParts.push(`MAX(${colRef}) as "${alias}"`); break;
      }
    }

    // Build WHERE
    const { where, params } = buildWhereClause(opts.filters ?? [], validCols);

    // Build GROUP BY
    const groupByClause = opts.groupBy.length > 0
      ? `GROUP BY ${opts.groupBy.map(c => `"${c.replace(/"/g, '""')}"`).join(', ')}`
      : '';

    const sql = `SELECT ${selectParts.join(', ')} FROM "${tableName}" ${where} ${groupByClause} LIMIT 1000`;
    const rows = this.db.all(sql, params);

    return { rows };
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  searchColumns(datasetId: string, query: string): DataColumn[] {
    const pattern = `%${query.toLowerCase()}%`;
    const cols = this.db.all(`
      SELECT * FROM data_columns
      WHERE dataset_id = ? AND (LOWER(name) LIKE ? OR LOWER(sample_values) LIKE ? OR LOWER(summary) LIKE ?)
      ORDER BY position
    `, [datasetId, pattern, pattern, pattern]) as any[];

    return cols.map(c => ({
      id: c.id, datasetId: c.dataset_id, name: c.name, position: c.position,
      inferredType: c.inferred_type, nullable: !!c.nullable,
      nullCount: c.null_count, nullPct: c.null_pct, cardinality: c.cardinality,
      minValue: c.min_value, maxValue: c.max_value, meanValue: c.mean_value,
      sampleValues: c.sample_values ? JSON.parse(c.sample_values) : [],
      summary: c.summary, updatedAt: c.updated_at,
    }));
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  getStats(): { datasets: number; totalRows: number; totalColumns: number } {
    const datasets = this.db.get('SELECT COUNT(*) as cnt FROM data_datasets')?.cnt ?? 0;
    const totalRows = this.db.get('SELECT SUM(row_count) as total FROM data_datasets')?.total ?? 0;
    const totalColumns = this.db.get('SELECT COUNT(*) as cnt FROM data_columns')?.cnt ?? 0;
    return { datasets, totalRows, totalColumns };
  }

  // ── Join ────────────────────────────────────────────────────────────────────

  join(opts: {
    left: string;
    right: string;
    leftColumn: string;
    rightColumn: string;
    type?: JoinType;
    columns?: string[];
    limit?: number;
  }): { rows: any[]; totalMatching: number } | null {
    // Verify both datasets exist
    const leftDs = this.db.get('SELECT * FROM data_datasets WHERE id = ?', [opts.left]);
    const rightDs = this.db.get('SELECT * FROM data_datasets WHERE id = ?', [opts.right]);
    if (!leftDs) return null;
    if (!rightDs) return null;

    const leftTable = `data_rows_${opts.left.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const rightTable = `data_rows_${opts.right.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    // Validate join columns exist
    const leftCols = new Set<string>(
      (this.db.all('SELECT name FROM data_columns WHERE dataset_id = ?', [opts.left]) as any[]).map(r => r.name),
    );
    const rightCols = new Set<string>(
      (this.db.all('SELECT name FROM data_columns WHERE dataset_id = ?', [opts.right]) as any[]).map(r => r.name),
    );

    if (!leftCols.has(opts.leftColumn)) throw new Error(`Column "${opts.leftColumn}" not found in left dataset "${opts.left}"`);
    if (!rightCols.has(opts.rightColumn)) throw new Error(`Column "${opts.rightColumn}" not found in right dataset "${opts.right}"`);

    // Build join type
    const joinType = opts.type ?? 'inner';
    const joinKeyword = joinType === 'left' ? 'LEFT JOIN' : joinType === 'right' ? 'RIGHT JOIN' : 'INNER JOIN';

    // Column projection: prefix with L. or R. for disambiguation
    let selectCols: string;
    if (opts.columns && opts.columns.length > 0) {
      selectCols = opts.columns.map(c => {
        if (c.startsWith(`${opts.left}.`)) {
          const col = c.slice(opts.left.length + 1);
          if (!leftCols.has(col)) throw new Error(`Invalid column: "${c}"`);
          return `L."${col.replace(/"/g, '""')}" as "${opts.left}.${col}"`;
        } else if (c.startsWith(`${opts.right}.`)) {
          const col = c.slice(opts.right.length + 1);
          if (!rightCols.has(col)) throw new Error(`Invalid column: "${c}"`);
          return `R."${col.replace(/"/g, '""')}" as "${opts.right}.${col}"`;
        }
        // Try left first, then right
        if (leftCols.has(c)) return `L."${c.replace(/"/g, '""')}" as "${opts.left}.${c}"`;
        if (rightCols.has(c)) return `R."${c.replace(/"/g, '""')}" as "${opts.right}.${c}"`;
        throw new Error(`Column "${c}" not found in either dataset`);
      }).join(', ');
    } else {
      // Select all columns from both, prefixed
      const leftSelect = Array.from(leftCols).map(c => `L."${c.replace(/"/g, '""')}" as "${opts.left}.${c}"`);
      const rightSelect = Array.from(rightCols).map(c => `R."${c.replace(/"/g, '""')}" as "${opts.right}.${c}"`);
      selectCols = [...leftSelect, ...rightSelect].join(', ');
    }

    const limit = Math.min(opts.limit ?? 100, 500);
    const leftCol = `L."${opts.leftColumn.replace(/"/g, '""')}"`;
    const rightCol = `R."${opts.rightColumn.replace(/"/g, '""')}"`;

    // Count
    const countSql = `SELECT COUNT(*) as cnt FROM "${leftTable}" L ${joinKeyword} "${rightTable}" R ON ${leftCol} = ${rightCol}`;
    const countRow = this.db.get(countSql);
    const totalMatching = countRow?.cnt ?? 0;

    // Fetch
    const sql = `SELECT ${selectCols} FROM "${leftTable}" L ${joinKeyword} "${rightTable}" R ON ${leftCol} = ${rightCol} LIMIT ?`;
    const rows = this.db.all(sql, [limit]);

    return { rows, totalMatching };
  }

  // ── Correlations ────────────────────────────────────────────────────────────

  correlations(datasetId: string, threshold = 0.3): CorrelationPair[] | null {
    const ds = this.db.get('SELECT * FROM data_datasets WHERE id = ?', [datasetId]);
    if (!ds) return null;

    const tableName = `data_rows_${datasetId.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    // Get numeric columns
    const numericCols = (this.db.all(
      `SELECT name FROM data_columns WHERE dataset_id = ? AND inferred_type IN ('integer', 'float')`,
      [datasetId],
    ) as any[]).map(r => r.name);

    if (numericCols.length < 2) return [];

    // Compute pairwise Pearson correlations using SQL
    const results: CorrelationPair[] = [];

    for (let i = 0; i < numericCols.length; i++) {
      for (let j = i + 1; j < numericCols.length; j++) {
        const col1 = numericCols[i]!;
        const col2 = numericCols[j]!;
        const c1 = `"${col1.replace(/"/g, '""')}"`;
        const c2 = `"${col2.replace(/"/g, '""')}"`;

        // Pearson correlation via SQL:
        // r = (n*sum(xy) - sum(x)*sum(y)) / sqrt((n*sum(x²) - sum(x)²) * (n*sum(y²) - sum(y)²))
        const row = this.db.get(`
          SELECT
            COUNT(*) as n,
            SUM(CAST(${c1} AS REAL) * CAST(${c2} AS REAL)) as sum_xy,
            SUM(CAST(${c1} AS REAL)) as sum_x,
            SUM(CAST(${c2} AS REAL)) as sum_y,
            SUM(CAST(${c1} AS REAL) * CAST(${c1} AS REAL)) as sum_x2,
            SUM(CAST(${c2} AS REAL) * CAST(${c2} AS REAL)) as sum_y2
          FROM "${tableName}"
          WHERE ${c1} IS NOT NULL AND ${c2} IS NOT NULL
            AND typeof(${c1}) != 'text' AND typeof(${c2}) != 'text'
        `);

        if (!row || row.n < 3) continue;

        const n = row.n;
        const numerator = n * row.sum_xy - row.sum_x * row.sum_y;
        const denomX = n * row.sum_x2 - row.sum_x * row.sum_x;
        const denomY = n * row.sum_y2 - row.sum_y * row.sum_y;
        const denom = Math.sqrt(denomX * denomY);

        if (denom === 0) continue;

        const correlation = numerator / denom;
        const absCorr = Math.abs(correlation);

        if (absCorr < threshold) continue;

        const strength: CorrelationPair['strength'] =
          absCorr >= 0.7 ? 'strong' :
          absCorr >= 0.4 ? 'moderate' :
          absCorr >= 0.2 ? 'weak' : 'negligible';

        results.push({ column1: col1, column2: col2, correlation: Math.round(correlation * 10000) / 10000, strength });
      }
    }

    // Sort by absolute correlation descending
    results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
    return results;
  }

  // ── History ──────────────────────────────────────────────────────────────────

  getHistory(datasetId: string, limit = 20): Array<{
    id: number;
    datasetId: string;
    snapshotAt: number;
    rowCount: number;
    columnCount: number;
    columns: Array<{ name: string; type: string; cardinality: number; nullPct: number }>;
    contentHash: string;
  }> | null {
    const ds = this.db.get('SELECT id FROM data_datasets WHERE id = ?', [datasetId]);
    if (!ds) return null;

    const rows = this.db.all(
      'SELECT * FROM data_dataset_history WHERE dataset_id = ? ORDER BY snapshot_at DESC LIMIT ?',
      [datasetId, limit],
    ) as any[];

    return rows.map(r => ({
      id: r.id,
      datasetId: r.dataset_id,
      snapshotAt: r.snapshot_at,
      rowCount: r.row_count,
      columnCount: r.column_count,
      columns: JSON.parse(r.columns_json),
      contentHash: r.content_hash,
    }));
  }

  // ── Drift Detection ─────────────────────────────────────────────────────────

  detectDrift(datasetId: string): {
    hasDrift: boolean;
    addedColumns: string[];
    removedColumns: string[];
    changedColumns: Array<{ name: string; changes: string[] }>;
    rowCountDelta: number;
  } | null {
    const ds = this.db.get('SELECT id FROM data_datasets WHERE id = ?', [datasetId]);
    if (!ds) return null;

    const snapshots = this.db.all(
      'SELECT * FROM data_dataset_history WHERE dataset_id = ? ORDER BY snapshot_at DESC LIMIT 2',
      [datasetId],
    ) as any[];

    if (snapshots.length < 2) {
      return { hasDrift: false, addedColumns: [], removedColumns: [], changedColumns: [], rowCountDelta: 0 };
    }

    const latest = snapshots[0];
    const previous = snapshots[1];
    const latestCols: Array<{ name: string; type: string; cardinality: number; nullPct: number }> = JSON.parse(latest.columns_json);
    const prevCols: Array<{ name: string; type: string; cardinality: number; nullPct: number }> = JSON.parse(previous.columns_json);

    const latestMap = new Map(latestCols.map(c => [c.name, c]));
    const prevMap = new Map(prevCols.map(c => [c.name, c]));

    const addedColumns: string[] = [];
    const removedColumns: string[] = [];
    const changedColumns: Array<{ name: string; changes: string[] }> = [];

    // Find added columns
    for (const col of latestCols) {
      if (!prevMap.has(col.name)) addedColumns.push(col.name);
    }

    // Find removed columns
    for (const col of prevCols) {
      if (!latestMap.has(col.name)) removedColumns.push(col.name);
    }

    // Find changed columns
    for (const col of latestCols) {
      const prev = prevMap.get(col.name);
      if (!prev) continue;
      const changes: string[] = [];
      if (col.type !== prev.type) changes.push(`type: ${prev.type} → ${col.type}`);
      if (col.cardinality !== prev.cardinality) changes.push(`cardinality: ${prev.cardinality} → ${col.cardinality}`);
      if (Math.abs(col.nullPct - prev.nullPct) > 0.01) changes.push(`nullPct: ${prev.nullPct.toFixed(1)}% → ${col.nullPct.toFixed(1)}%`);
      if (changes.length > 0) changedColumns.push({ name: col.name, changes });
    }

    const rowCountDelta = latest.row_count - previous.row_count;
    const hasDrift = addedColumns.length > 0 || removedColumns.length > 0 || changedColumns.length > 0;

    return { hasDrift, addedColumns, removedColumns, changedColumns, rowCountDelta };
  }

  // ── Quality ─────────────────────────────────────────────────────────────────

  quality(datasetId: string): ColumnQuality[] | null {
    const ds = this.db.get('SELECT * FROM data_datasets WHERE id = ?', [datasetId]);
    if (!ds) return null;

    const cols = this.db.all(
      'SELECT * FROM data_columns WHERE dataset_id = ? ORDER BY position',
      [datasetId],
    ) as any[];

    if (cols.length === 0) return [];

    const results: ColumnQuality[] = [];

    for (const col of cols) {
      const issues: string[] = [];
      let nullRisk = 0;
      let cardinalityRisk = 0;
      let typeRisk = 0;

      // Null rate risk
      const nullPct = col.null_pct ?? 0;
      if (nullPct > 50) {
        issues.push(`High null rate (${nullPct.toFixed(1)}%)`);
        nullRisk = 0.4;
      } else if (nullPct > 20) {
        issues.push(`Moderate null rate (${nullPct.toFixed(1)}%)`);
        nullRisk = 0.2;
      } else if (nullPct > 5) {
        issues.push(`Some nulls (${nullPct.toFixed(1)}%)`);
        nullRisk = 0.1;
      }

      // Cardinality anomalies
      const cardinality = col.cardinality ?? 0;
      const rowCount = ds.row_count ?? 1;

      if (cardinality === 1 && rowCount > 10) {
        issues.push('Constant value (cardinality=1)');
        cardinalityRisk = 0.3;
      } else if (cardinality / rowCount > 0.95 && rowCount > 100) {
        issues.push('Near-unique (>95% distinct)');
        cardinalityRisk = 0.1;
      }

      // Type issues
      if (col.inferred_type === 'string' && col.cardinality < 20 && rowCount > 100) {
        issues.push('Low-cardinality string (consider enum/category)');
        typeRisk = 0.05;
      }

      const riskScore = Math.min(nullRisk + cardinalityRisk + typeRisk, 1.0);

      if (issues.length > 0) {
        results.push({ column: col.name, riskScore, nullRisk, cardinalityRisk, typeRisk, issues });
      }
    }

    // Sort by risk score descending
    results.sort((a, b) => b.riskScore - a.riskScore);
    return results;
  }

  // ── Validation Rules ────────────────────────────────────────────────────────

  /**
   * Infer validation rules from column profiles.
   * Returns rules the code should apply when reading/writing this dataset.
   */
  validationRules(datasetId: string): ValidationRule[] | null {
    const info = this.describeDataset(datasetId);
    if (!info) return null;

    const results: ValidationRule[] = [];

    for (const col of info.columns) {
      const rules: string[] = [];

      // Required/nullable
      if (!col.nullable) {
        rules.push('required (never null)');
      } else if (col.nullPct < 0.01) {
        rules.push('rarely null (<1%) — consider required');
      }

      // Type constraint
      rules.push(`type: ${col.inferredType}`);

      // Range constraints for numeric
      if ((col.inferredType === 'integer' || col.inferredType === 'float') && col.minValue != null && col.maxValue != null) {
        rules.push(`range: ${col.minValue} to ${col.maxValue}`);
      }

      // Enum constraint for low-cardinality strings
      if (col.inferredType === 'string' && col.cardinality <= 20 && info.dataset.rowCount > 50) {
        rules.push(`enum (${col.cardinality} distinct values): ${col.sampleValues.join(', ')}`);
      }

      // Uniqueness
      if (col.cardinality === info.dataset.rowCount && info.dataset.rowCount > 10) {
        rules.push('unique (all values distinct)');
      }

      if (rules.length > 1) { // always has at least the type rule
        results.push({ column: col.name, rules });
      }
    }

    return results;
  }

  // ── Sample Data Generation Hints ────────────────────────────────────────────

  /**
   * From column profiles, provide hints for generating realistic test data.
   */
  sampleHints(datasetId: string): SampleHint[] | null {
    const info = this.describeDataset(datasetId);
    if (!info) return null;

    const results: SampleHint[] = [];

    for (const col of info.columns) {
      let hint: string;

      switch (col.inferredType) {
        case 'integer':
          if (col.minValue != null && col.maxValue != null) {
            hint = `Random integer between ${col.minValue} and ${col.maxValue}`;
          } else {
            hint = 'Random integer';
          }
          if (col.cardinality === info.dataset.rowCount) hint += ' (must be unique)';
          break;

        case 'float':
          if (col.minValue != null && col.maxValue != null) {
            hint = `Random float between ${col.minValue} and ${col.maxValue}`;
            if (col.meanValue != null) hint += ` (mean ≈ ${col.meanValue.toFixed(2)})`;
          } else {
            hint = 'Random float';
          }
          break;

        case 'boolean':
          hint = 'Random boolean (true/false)';
          break;

        case 'date':
          if (col.minValue && col.maxValue) {
            hint = `Random date between ${col.minValue} and ${col.maxValue}`;
          } else {
            hint = 'Random ISO date string';
          }
          break;

        case 'string':
          if (col.cardinality <= 10 && info.dataset.rowCount > 20) {
            hint = `Pick from: ${col.sampleValues.join(', ')}`;
          } else if (col.cardinality === info.dataset.rowCount) {
            // Looks like an ID or email
            const name = col.name.toLowerCase();
            if (name.includes('email')) hint = 'Generate unique email (e.g. user{n}@example.com)';
            else if (name.includes('id') || name.includes('uuid')) hint = 'Generate unique ID/UUID';
            else if (name.includes('name')) hint = 'Generate unique name string';
            else if (name.includes('url') || name.includes('link')) hint = 'Generate unique URL';
            else hint = `Generate unique string (${col.cardinality} distinct in source)`;
          } else {
            hint = `Random string (${col.cardinality} distinct values in source)`;
            if (col.sampleValues.length > 0) hint += `. Examples: ${col.sampleValues.slice(0, 3).join(', ')}`;
          }
          break;

        default:
          hint = `Generate ${col.inferredType} value`;
      }

      if (col.nullable && col.nullPct > 0.05) {
        hint += ` — ${(col.nullPct * 100).toFixed(0)}% chance of null`;
      }

      results.push({ column: col.name, hint });
    }

    return results;
  }
}

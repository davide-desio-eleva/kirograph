/**
 * Column Profiler
 *
 * Analyzes parsed rows to produce column profiles:
 * - Type inference (string, integer, float, boolean, date, null, mixed)
 * - Null count and percentage
 * - Cardinality (distinct values)
 * - Min/max values
 * - Mean (for numeric columns)
 * - Sample values (up to 5)
 */

import type { DataColumn, InferredType, ParsedRow } from './types';

interface ColumnStats {
  name: string;
  position: number;
  types: Map<string, number>;  // type → count
  nullCount: number;
  totalCount: number;
  distinctValues: Set<string>;
  numericSum: number;
  numericCount: number;
  minValue: string | null;
  maxValue: string | null;
  samples: string[];
}

function detectType(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'float';
  }
  if (typeof value === 'string') {
    // Try to detect dates
    if (/^\d{4}-\d{2}-\d{2}/.test(value) && !isNaN(Date.parse(value))) return 'date';
    return 'string';
  }
  return 'string';
}

function inferFinalType(types: Map<string, number>, totalCount: number): InferredType {
  // Remove null from consideration
  const nonNull = new Map(types);
  nonNull.delete('null');

  if (nonNull.size === 0) return 'null';
  if (nonNull.size === 1) return [...nonNull.keys()][0] as InferredType;

  // integer + float → float
  if (nonNull.size === 2 && nonNull.has('integer') && nonNull.has('float')) return 'float';

  // If one type dominates (>80%), use it
  for (const [type, count] of nonNull) {
    if (count / totalCount > 0.8) return type as InferredType;
  }

  return 'mixed';
}

/**
 * Profile columns from a batch of rows.
 * Call repeatedly with batches, then call finalize() to get the final profiles.
 */
export class ColumnProfiler {
  private stats = new Map<string, ColumnStats>();
  private columnOrder: string[] = [];

  /**
   * Process a batch of rows.
   */
  addBatch(rows: ParsedRow[], columns: string[]): void {
    // Initialize stats for new columns
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      if (!this.stats.has(col)) {
        this.columnOrder.push(col);
        this.stats.set(col, {
          name: col,
          position: this.columnOrder.length - 1,
          types: new Map(),
          nullCount: 0,
          totalCount: 0,
          distinctValues: new Set(),
          numericSum: 0,
          numericCount: 0,
          minValue: null,
          maxValue: null,
          samples: [],
        });
      }
    }

    // Process each row
    for (const row of rows) {
      for (const col of columns) {
        const stat = this.stats.get(col)!;
        const value = row[col];
        stat.totalCount++;

        if (value === null || value === undefined) {
          stat.nullCount++;
          stat.types.set('null', (stat.types.get('null') ?? 0) + 1);
          continue;
        }

        const type = detectType(value);
        stat.types.set(type, (stat.types.get(type) ?? 0) + 1);

        // Track distinct values (cap at 10000 to avoid memory issues)
        const strVal = String(value);
        if (stat.distinctValues.size < 10_000) {
          stat.distinctValues.add(strVal);
        }

        // Numeric stats
        if (typeof value === 'number' && !isNaN(value)) {
          stat.numericSum += value;
          stat.numericCount++;
          const numStr = String(value);
          if (stat.minValue === null || value < parseFloat(stat.minValue)) stat.minValue = numStr;
          if (stat.maxValue === null || value > parseFloat(stat.maxValue)) stat.maxValue = numStr;
        } else if (type === 'string' || type === 'date') {
          if (stat.minValue === null || strVal < stat.minValue) stat.minValue = strVal;
          if (stat.maxValue === null || strVal > stat.maxValue) stat.maxValue = strVal;
        }

        // Collect samples (up to 5 unique)
        if (stat.samples.length < 5 && !stat.samples.includes(strVal) && strVal.length <= 100) {
          stat.samples.push(strVal);
        }
      }
    }
  }

  /**
   * Finalize and return column profiles.
   */
  finalize(datasetId: string): DataColumn[] {
    const now = Date.now();
    const profiles: DataColumn[] = [];

    for (const col of this.columnOrder) {
      const stat = this.stats.get(col)!;
      const inferredType = inferFinalType(stat.types, stat.totalCount);
      const nullPct = stat.totalCount > 0 ? stat.nullCount / stat.totalCount : 0;
      const meanValue = stat.numericCount > 0 ? stat.numericSum / stat.numericCount : null;

      profiles.push({
        id: `${datasetId}::${col}#column`,
        datasetId,
        name: col,
        position: stat.position,
        inferredType,
        nullable: stat.nullCount > 0,
        nullCount: stat.nullCount,
        nullPct,
        cardinality: stat.distinctValues.size,
        minValue: stat.minValue,
        maxValue: stat.maxValue,
        meanValue,
        sampleValues: stat.samples,
        summary: generateColumnSummary(col, inferredType, stat, nullPct),
        updatedAt: now,
      });
    }

    return profiles;
  }
}

/**
 * Generate a natural-language summary for a column based on its profile.
 */
function generateColumnSummary(
  name: string,
  type: InferredType,
  stat: ColumnStats,
  nullPct: number,
): string {
  const parts: string[] = [];
  const cardinality = stat.distinctValues.size;
  const total = stat.totalCount;

  // Type description
  if (type === 'integer' || type === 'float') {
    parts.push(`Numeric (${type})`);
    if (stat.minValue != null && stat.maxValue != null) {
      parts.push(`range ${stat.minValue}–${stat.maxValue}`);
    }
  } else if (type === 'boolean') {
    parts.push('Boolean flag');
  } else if (type === 'date') {
    parts.push('Date/timestamp');
    if (stat.minValue && stat.maxValue) {
      parts.push(`from ${stat.minValue} to ${stat.maxValue}`);
    }
  } else if (type === 'string') {
    if (cardinality <= 10 && total > 20) {
      parts.push(`Categorical (${cardinality} values)`);
    } else if (cardinality === total && total > 10) {
      parts.push('Unique identifier');
    } else {
      parts.push('Text');
    }
  } else {
    parts.push(type);
  }

  // Cardinality insight
  if (cardinality === 1 && total > 1) {
    parts.push('constant');
  } else if (total > 0 && cardinality / total > 0.95 && total > 10) {
    parts.push('near-unique');
  }

  // Null info
  if (nullPct > 0.5) {
    parts.push(`mostly null (${(nullPct * 100).toFixed(0)}%)`);
  } else if (nullPct > 0.1) {
    parts.push(`some nulls (${(nullPct * 100).toFixed(0)}%)`);
  }

  return parts.join(', ');
}

/**
 * Structured Filter → SQL WHERE Clause Builder
 *
 * Converts QueryFilter objects into parameterized SQL.
 * Zero injection surface — column names are validated against schema,
 * values are always parameterized.
 */

import type { QueryFilter } from './types';

interface SQLClause {
  where: string;
  params: any[];
}

/**
 * Validate that a column name exists in the schema.
 * Prevents SQL injection via column names.
 */
function validateColumn(column: string, validColumns: Set<string>): string {
  if (!validColumns.has(column)) {
    throw new Error(`Invalid column: "${column}". Available columns: ${[...validColumns].join(', ')}`);
  }
  // Quote column name to handle spaces and reserved words
  return `"${column.replace(/"/g, '""')}"`;
}

/**
 * Build a parameterized WHERE clause from structured filters.
 * All filters are ANDed together.
 *
 * @param filters - Array of QueryFilter objects
 * @param validColumns - Set of valid column names (from schema)
 * @returns SQL WHERE clause and parameter array
 */
export function buildWhereClause(filters: QueryFilter[], validColumns: Set<string>): SQLClause {
  if (filters.length === 0) {
    return { where: '', params: [] };
  }

  const conditions: string[] = [];
  const params: any[] = [];

  for (const filter of filters) {
    const col = validateColumn(filter.column, validColumns);

    switch (filter.op) {
      case 'eq':
        conditions.push(`${col} = ?`);
        params.push(filter.value);
        break;

      case 'neq':
        conditions.push(`${col} != ?`);
        params.push(filter.value);
        break;

      case 'gt':
        conditions.push(`${col} > ?`);
        params.push(filter.value);
        break;

      case 'gte':
        conditions.push(`${col} >= ?`);
        params.push(filter.value);
        break;

      case 'lt':
        conditions.push(`${col} < ?`);
        params.push(filter.value);
        break;

      case 'lte':
        conditions.push(`${col} <= ?`);
        params.push(filter.value);
        break;

      case 'contains':
        conditions.push(`${col} LIKE ?`);
        params.push(`%${filter.value}%`);
        break;

      case 'in': {
        if (!Array.isArray(filter.value) || filter.value.length === 0) {
          conditions.push('0'); // Always false
        } else {
          const placeholders = filter.value.map(() => '?').join(',');
          conditions.push(`${col} IN (${placeholders})`);
          params.push(...filter.value);
        }
        break;
      }

      case 'is_null':
        if (filter.value === true || filter.value === 'true') {
          conditions.push(`${col} IS NULL`);
        } else {
          conditions.push(`${col} IS NOT NULL`);
        }
        break;

      case 'between': {
        if (!Array.isArray(filter.value) || filter.value.length !== 2) {
          throw new Error(`"between" filter requires a [min, max] array`);
        }
        conditions.push(`${col} BETWEEN ? AND ?`);
        params.push(filter.value[0], filter.value[1]);
        break;
      }

      default:
        throw new Error(`Unknown filter operator: "${(filter as any).op}"`);
    }
  }

  return {
    where: `WHERE ${conditions.join(' AND ')}`,
    params,
  };
}

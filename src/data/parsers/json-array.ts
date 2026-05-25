/**
 * JSON Array Parser
 *
 * Handles: .json files that contain an array of objects
 * For files in data/ directories (not package.json, tsconfig.json, etc.)
 */

import * as fs from 'fs';
import type { DataFormatParser, ParsedRow } from '../types';

const BATCH_SIZE = 10_000;

export const jsonArrayParser: DataFormatParser = {
  name: 'json',
  extensions: ['.json'],
  isAvailable: () => true,

  async parse(filePath, opts) {
    const content = fs.readFileSync(filePath, 'utf8');
    let data: unknown;

    try {
      data = JSON.parse(content);
    } catch {
      return { columns: [], totalRows: 0 };
    }

    // Must be an array of objects
    if (!Array.isArray(data) || data.length === 0) {
      return { columns: [], totalRows: 0 };
    }

    // Check first element is an object
    if (typeof data[0] !== 'object' || data[0] === null || Array.isArray(data[0])) {
      return { columns: [], totalRows: 0 };
    }

    const columnSet = new Set<string>();
    let totalRows = 0;
    let batch: ParsedRow[] = [];

    for (const item of data) {
      if (totalRows >= opts.maxRows) break;
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;

      const row: ParsedRow = {};
      for (const [key, value] of Object.entries(item)) {
        columnSet.add(key);
        if (value === null || value === undefined) {
          row[key] = null;
        } else if (typeof value === 'object') {
          row[key] = JSON.stringify(value);
        } else {
          row[key] = value as string | number | boolean;
        }
      }

      batch.push(row);
      totalRows++;

      if (batch.length >= BATCH_SIZE) {
        opts.onBatch(batch, [...columnSet]);
        batch = [];
      }
    }

    const columns = [...columnSet];
    if (batch.length > 0) {
      opts.onBatch(batch, columns);
    }

    return { columns, totalRows };
  },
};

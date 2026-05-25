/**
 * Parquet Parser (Optional Dependency)
 *
 * Handles: .parquet
 * Requires: parquetjs-lite package (optional dependency)
 * Gracefully returns isAvailable()=false if not installed.
 */

import type { DataFormatParser, ParsedRow } from '../types';

const BATCH_SIZE = 10_000;

let parquetModule: any = null;
let parquetChecked = false;

function tryLoadParquet(): boolean {
  if (parquetChecked) return parquetModule !== null;
  parquetChecked = true;
  try {
    parquetModule = require('parquetjs-lite');
    return true;
  } catch {
    try {
      parquetModule = require('parquetjs');
      return true;
    } catch {
      return false;
    }
  }
}

export const parquetParser: DataFormatParser = {
  name: 'parquet',
  extensions: ['.parquet'],

  isAvailable(): boolean {
    return tryLoadParquet();
  },

  async parse(filePath, opts) {
    if (!tryLoadParquet()) {
      return { columns: [], totalRows: 0 };
    }

    const reader = await parquetModule.ParquetReader.openFile(filePath);
    const schema = reader.getSchema();
    const columns = Object.keys(schema.fields);

    const cursor = reader.getCursor();
    let totalRows = 0;
    let batch: ParsedRow[] = [];
    let record: any;

    while ((record = await cursor.next()) && totalRows < opts.maxRows) {
      const row: ParsedRow = {};
      for (const col of columns) {
        const val = record[col];
        if (val === null || val === undefined) {
          row[col] = null;
        } else if (val instanceof Date) {
          row[col] = val.toISOString();
        } else if (Buffer.isBuffer(val)) {
          row[col] = val.toString('utf8');
        } else if (typeof val === 'bigint') {
          row[col] = Number(val);
        } else if (typeof val === 'object') {
          row[col] = JSON.stringify(val);
        } else {
          row[col] = val;
        }
      }

      batch.push(row);
      totalRows++;

      if (batch.length >= BATCH_SIZE) {
        opts.onBatch(batch, columns);
        batch = [];
      }
    }

    if (batch.length > 0) {
      opts.onBatch(batch, columns);
    }

    await reader.close();
    return { columns, totalRows };
  },
};

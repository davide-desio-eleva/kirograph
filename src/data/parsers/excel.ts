/**
 * Excel Parser (Optional Dependency)
 *
 * Handles: .xlsx, .xls
 * Requires: xlsx package (optional dependency)
 * Gracefully returns isAvailable()=false if not installed.
 */

import type { DataFormatParser, ParsedRow } from '../types';

const BATCH_SIZE = 10_000;

let xlsxModule: any = null;
let xlsxChecked = false;

function tryLoadXlsx(): boolean {
  if (xlsxChecked) return xlsxModule !== null;
  xlsxChecked = true;
  try {
    xlsxModule = require('xlsx');
    return true;
  } catch {
    return false;
  }
}

export const excelParser: DataFormatParser = {
  name: 'xlsx',
  extensions: ['.xlsx', '.xls'],

  isAvailable(): boolean {
    return tryLoadXlsx();
  },

  async parse(filePath, opts) {
    if (!tryLoadXlsx()) {
      return { columns: [], totalRows: 0 };
    }

    const workbook = xlsxModule.readFile(filePath, { type: 'file', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return { columns: [], totalRows: 0 };

    const sheet = workbook.Sheets[sheetName];
    const jsonData = xlsxModule.utils.sheet_to_json(sheet, { defval: null }) as Record<string, any>[];

    if (jsonData.length === 0) return { columns: [], totalRows: 0 };

    const columns = Object.keys(jsonData[0]);
    let totalRows = 0;
    let batch: ParsedRow[] = [];

    for (const item of jsonData) {
      if (totalRows >= opts.maxRows) break;

      const row: ParsedRow = {};
      for (const col of columns) {
        const val = item[col];
        if (val === null || val === undefined) {
          row[col] = null;
        } else if (val instanceof Date) {
          row[col] = val.toISOString();
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

    return { columns, totalRows };
  },
};

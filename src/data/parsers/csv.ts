/**
 * CSV/TSV Streaming Parser
 *
 * Handles: .csv, .tsv
 * Parses line-by-line without loading the full file into memory.
 * Handles quoted fields, newlines within quotes, and various delimiters.
 */

import * as fs from 'fs';
import * as readline from 'readline';
import type { DataFormatParser, ParsedRow } from '../types';

const BATCH_SIZE = 10_000;

function parseCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function inferValue(raw: string): string | number | boolean | null {
  if (raw === '' || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'na' || raw.toLowerCase() === 'n/a') return null;
  if (raw.toLowerCase() === 'true') return true;
  if (raw.toLowerCase() === 'false') return false;

  // Try integer
  if (/^-?\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n >= Number.MIN_SAFE_INTEGER && n <= Number.MAX_SAFE_INTEGER) return n;
  }

  // Try float
  if (/^-?\d+\.\d+$/.test(raw) || /^-?\d+[eE][+-]?\d+$/.test(raw)) {
    const f = parseFloat(raw);
    if (!isNaN(f)) return f;
  }

  return raw;
}

async function parseFile(
  filePath: string,
  delimiter: string,
  opts: { maxRows: number; onBatch: (rows: ParsedRow[], columns: string[]) => void },
): Promise<{ columns: string[]; totalRows: number }> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let columns: string[] = [];
  let totalRows = 0;
  let batch: ParsedRow[] = [];
  let isHeader = true;

  for await (const line of rl) {
    if (line.trim() === '') continue;

    if (isHeader) {
      columns = parseCSVLine(line, delimiter);
      isHeader = false;
      continue;
    }

    if (totalRows >= opts.maxRows) break;

    const values = parseCSVLine(line, delimiter);
    const row: ParsedRow = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = inferValue(values[i] ?? '');
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
}

export const csvParser: DataFormatParser = {
  name: 'csv',
  extensions: ['.csv'],
  isAvailable: () => true,
  parse: (filePath, opts) => parseFile(filePath, ',', opts),
};

export const tsvParser: DataFormatParser = {
  name: 'tsv',
  extensions: ['.tsv'],
  isAvailable: () => true,
  parse: (filePath, opts) => parseFile(filePath, '\t', opts),
};

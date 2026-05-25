/**
 * JSONL/NDJSON Streaming Parser
 *
 * Handles: .jsonl, .ndjson
 * Parses one JSON object per line without loading the full file.
 */

import * as fs from 'fs';
import * as readline from 'readline';
import type { DataFormatParser, ParsedRow } from '../types';

const BATCH_SIZE = 10_000;

export const jsonlParser: DataFormatParser = {
  name: 'jsonl',
  extensions: ['.jsonl', '.ndjson'],
  isAvailable: () => true,

  async parse(filePath, opts) {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const columnSet = new Set<string>();
    let totalRows = 0;
    let batch: ParsedRow[] = [];

    for await (const line of rl) {
      if (line.trim() === '') continue;
      if (totalRows >= opts.maxRows) break;

      try {
        const obj = JSON.parse(line);
        if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue;

        const row: ParsedRow = {};
        for (const [key, value] of Object.entries(obj)) {
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
      } catch {
        // Skip malformed lines
      }
    }

    const columns = [...columnSet];
    if (batch.length > 0) {
      opts.onBatch(batch, columns);
    }

    return { columns, totalRows };
  },
};

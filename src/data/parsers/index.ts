/**
 * Data Format Registry
 *
 * Maps file extensions to their appropriate parser.
 * Gracefully skips formats whose optional dependencies are not installed.
 */

import type { DataFormatParser } from '../types';
import { csvParser, tsvParser } from './csv';
import { jsonlParser } from './jsonl';
import { jsonArrayParser } from './json-array';
import { excelParser } from './excel';
import { parquetParser } from './parquet';

// ── Registry ──────────────────────────────────────────────────────────────────

const allParsers: DataFormatParser[] = [
  csvParser,
  tsvParser,
  jsonlParser,
  jsonArrayParser,
  excelParser,
  parquetParser,
];

/** Extension → parser lookup */
const extensionMap = new Map<string, DataFormatParser>();
for (const parser of allParsers) {
  for (const ext of parser.extensions) {
    extensionMap.set(ext.toLowerCase(), parser);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get the parser for a given file extension.
 * Returns null if no parser is registered or the optional dep is missing.
 */
export function getDataParser(filePath: string): DataFormatParser | null {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const parser = extensionMap.get(ext) ?? null;
  if (!parser) return null;
  if (!parser.isAvailable()) return null;
  return parser;
}

/**
 * Check if a file extension is supported for data parsing.
 */
export function isSupportedDataFormat(filePath: string): boolean {
  return getDataParser(filePath) !== null;
}

/**
 * Get all supported extensions (only those with available deps).
 */
export function getAvailableExtensions(): string[] {
  const available: string[] = [];
  for (const [ext, parser] of extensionMap) {
    if (parser.isAvailable()) available.push(ext);
  }
  return available;
}

/**
 * Get extensions that are registered but have missing optional deps.
 */
export function getUnavailableExtensions(): Array<{ ext: string; parser: string }> {
  const unavailable: Array<{ ext: string; parser: string }> = [];
  for (const [ext, parser] of extensionMap) {
    if (!parser.isAvailable()) {
      unavailable.push({ ext, parser: parser.name });
    }
  }
  return unavailable;
}

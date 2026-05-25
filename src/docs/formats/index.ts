/**
 * Documentation Format Registry
 *
 * Maps file extensions to their appropriate parser.
 * New parsers are registered here as they are implemented.
 */

import type { DocFormatParser, ParseResult } from '../types';
import { markdownParser } from './markdown';
import { rstParser } from './rst';
import { asciidocParser } from './asciidoc';
import { rdocParser } from './rdoc';
import { orgParser } from './org';
import { htmlParser } from './html';
import { plaintextParser } from './plaintext';
import { openapiParser, isOpenAPI } from './openapi';

// ── Registry ──────────────────────────────────────────────────────────────────

const parsers: DocFormatParser[] = [
  markdownParser,
  rstParser,
  asciidocParser,
  rdocParser,
  orgParser,
  htmlParser,
  plaintextParser,
];

/** Extension → parser lookup (built once at module load) */
const extensionMap = new Map<string, DocFormatParser>();
for (const parser of parsers) {
  for (const ext of parser.extensions) {
    extensionMap.set(ext.toLowerCase(), parser);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get the parser for a given file extension.
 * Returns null if no parser is registered for the extension.
 */
export function getParser(filePath: string): DocFormatParser | null {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return extensionMap.get(ext) ?? null;
}

/**
 * Parse a documentation file into sections.
 * Returns null if no parser is available for the file format.
 * Supports content-based detection for OpenAPI specs.
 */
export function parseDocFile(content: string, filePath: string): ParseResult | null {
  // Content-based detection: OpenAPI specs in .yaml/.yml/.json files
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if ((ext === '.yaml' || ext === '.yml' || ext === '.json') && isOpenAPI(content, filePath)) {
    return openapiParser.parse(content, filePath);
  }

  const parser = getParser(filePath);
  if (!parser) return null;
  return parser.parse(content, filePath);
}

/**
 * Check if a file extension is supported for documentation parsing.
 */
export function isSupportedDocFormat(filePath: string): boolean {
  return getParser(filePath) !== null;
}

/**
 * Get all supported file extensions.
 */
export function getSupportedExtensions(): string[] {
  return [...extensionMap.keys()];
}

/**
 * Get all registered parser names.
 */
export function getRegisteredParsers(): string[] {
  return parsers.map(p => p.name);
}

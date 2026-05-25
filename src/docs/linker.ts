/**
 * Code ↔ Documentation Linker
 *
 * Detects references to code symbols within documentation sections.
 * Strategies:
 *   1. Backtick references: `functionName`, `ClassName.method`
 *   2. Import-style paths: from './auth/service'
 *   3. Identifier patterns: CamelCase, snake_case words that match indexed symbols
 */

import type { DocCodeRef, DocRefType } from './types';

// ── Patterns ──────────────────────────────────────────────────────────────────

// Backtick-wrapped code references
const BACKTICK_RE = /`([^`\n]+)`/g;

// Common identifier patterns (CamelCase, snake_case, SCREAMING_SNAKE)
const IDENTIFIER_RE = /\b([A-Z][a-zA-Z0-9]+(?:\.[a-zA-Z][a-zA-Z0-9]*)?)\b/g;
const SNAKE_CASE_RE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

// Import-style paths
const IMPORT_PATH_RE = /(?:from|import)\s+['"]([^'"]+)['"]/g;

// Words to ignore (too common to be meaningful symbol references)
const IGNORE_WORDS = new Set([
  'TODO', 'NOTE', 'FIXME', 'HACK', 'WARNING', 'IMPORTANT', 'DEPRECATED',
  'README', 'LICENSE', 'CHANGELOG', 'CONTRIBUTING',
  'HTTP', 'HTTPS', 'JSON', 'HTML', 'CSS', 'SQL', 'API', 'REST', 'CRUD',
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
  'String', 'Number', 'Boolean', 'Object', 'Array', 'Function', 'Promise',
  'Error', 'Date', 'Map', 'Set', 'RegExp', 'Buffer', 'Symbol',
  'True', 'False', 'None', 'Null', 'Undefined',
  'This', 'Self', 'Super', 'Class', 'Interface', 'Type',
]);

/**
 * Extract candidate symbol references from documentation content.
 * Returns unique candidate names that should be looked up against the graph.
 */
export function extractCandidateRefs(content: string): string[] {
  const candidates = new Set<string>();

  // 1. Backtick references (highest confidence)
  let match: RegExpExecArray | null;
  BACKTICK_RE.lastIndex = 0;
  while ((match = BACKTICK_RE.exec(content)) !== null) {
    const ref = match[1].trim();
    // Skip if it looks like a command, path, or URL
    if (ref.includes(' ') || ref.startsWith('/') || ref.startsWith('http') || ref.startsWith('$')) continue;
    // Handle Class.method notation
    if (ref.includes('.')) {
      const parts = ref.split('.');
      for (const part of parts) {
        if (part.length >= 2 && !IGNORE_WORDS.has(part)) candidates.add(part);
      }
    }
    if (ref.length >= 2 && !IGNORE_WORDS.has(ref)) candidates.add(ref);
  }

  // 2. CamelCase identifiers (medium confidence)
  IDENTIFIER_RE.lastIndex = 0;
  while ((match = IDENTIFIER_RE.exec(content)) !== null) {
    const ref = match[1];
    if (!IGNORE_WORDS.has(ref) && ref.length >= 3) {
      candidates.add(ref);
    }
  }

  // 3. snake_case identifiers (medium confidence)
  SNAKE_CASE_RE.lastIndex = 0;
  while ((match = SNAKE_CASE_RE.exec(content)) !== null) {
    const ref = match[1];
    if (ref.length >= 4) candidates.add(ref);
  }

  return [...candidates];
}

/**
 * Resolve candidate references against the code graph.
 * Returns DocCodeRef entries for symbols that actually exist in the index.
 *
 * @param sectionId - The doc section ID
 * @param candidates - Candidate symbol names extracted from the section
 * @param db - Raw SQLite database handle
 */
export function resolveCodeRefs(
  sectionId: string,
  candidates: string[],
  db: any,
): DocCodeRef[] {
  if (candidates.length === 0) return [];

  const refs: DocCodeRef[] = [];
  const seen = new Set<string>();

  // Batch lookup: find nodes matching any candidate name
  // Use a chunked approach to avoid SQLite variable limits
  const CHUNK_SIZE = 50;
  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.all(
      `SELECT name, qualified_name FROM nodes WHERE name IN (${placeholders}) GROUP BY qualified_name`,
      chunk,
    ) as Array<{ name: string; qualified_name: string }>;

    for (const row of rows) {
      const key = `${sectionId}:${row.qualified_name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Determine ref type based on context
      const refType: DocRefType = 'mentions';
      const confidence = chunk.includes(row.name) ? 0.8 : 0.6;

      refs.push({
        sectionId,
        qualifiedName: row.qualified_name,
        refType,
        confidence,
      });
    }
  }

  return refs;
}

/**
 * Run the full linking pipeline for a section.
 * Extracts candidates from content, resolves against the graph, returns refs.
 */
export function linkSection(
  sectionId: string,
  content: string,
  db: any,
): DocCodeRef[] {
  const candidates = extractCandidateRefs(content);
  return resolveCodeRefs(sectionId, candidates, db);
}

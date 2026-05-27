/**
 * Refactoring Tools
 *
 * - rename: Preview all locations that reference a symbol (rename preview)
 * - suggest: Community-driven refactoring suggestions
 */

import type { GraphDatabase } from '../db/database';

export interface RenameLocation {
  filePath: string;
  line: number;
  column?: number;
  context: string; // The referencing symbol's name
  edgeKind: string;
}

export interface RenamePreview {
  symbol: string;
  kind: string;
  filePath: string;
  line: number;
  references: RenameLocation[];
  totalReferences: number;
}

export interface RefactorSuggestion {
  type: 'move' | 'split' | 'extract' | 'group';
  description: string;
  symbols: string[];
  rationale: string;
  priority: 'high' | 'medium' | 'low';
}

/**
 * Generate a rename preview: find all locations that reference a symbol.
 * This shows what would need to change if the symbol is renamed.
 */
export function renamePreview(db: GraphDatabase, symbolName: string): RenamePreview | null {
  const rawDb = db.getRawDb();

  // Find the target symbol
  const target = rawDb.get(
    `SELECT id, name, kind, file_path as filePath, start_line as line FROM nodes WHERE name = ? LIMIT 1`,
    [symbolName]
  ) as any;

  if (!target) {
    // Try qualified name
    const qualified = rawDb.get(
      `SELECT id, name, kind, file_path as filePath, start_line as line FROM nodes WHERE qualified_name LIKE ? LIMIT 1`,
      [`%${symbolName}`]
    ) as any;
    if (!qualified) return null;
    Object.assign(target, qualified);
  }

  // Find all edges pointing TO this symbol (references, calls, imports)
  const incomingEdges = rawDb.all(
    `SELECT e.source, e.kind, e.line, e.column, n.name as sourceName, n.file_path as sourceFile, n.start_line as sourceLine
     FROM edges e
     JOIN nodes n ON n.id = e.source
     WHERE e.target = ?
     ORDER BY n.file_path, e.line`,
    [target.id]
  ) as any[];

  // Find all edges FROM this symbol (for completeness — shows what it calls)
  const outgoingEdges = rawDb.all(
    `SELECT e.target, e.kind, e.line, e.column, n.name as targetName, n.file_path as targetFile
     FROM edges e
     JOIN nodes n ON n.id = e.target
     WHERE e.source = ? AND e.kind IN ('imports', 'exports')`,
    [target.id]
  ) as any[];

  const references: RenameLocation[] = [];

  for (const edge of incomingEdges) {
    references.push({
      filePath: edge.sourceFile,
      line: edge.line ?? edge.sourceLine,
      column: edge.column ?? undefined,
      context: edge.sourceName,
      edgeKind: edge.kind,
    });
  }

  // Also include export/import edges from the symbol itself
  for (const edge of outgoingEdges) {
    references.push({
      filePath: edge.targetFile,
      line: edge.line ?? 0,
      column: edge.column ?? undefined,
      context: edge.targetName,
      edgeKind: edge.kind,
    });
  }

  return {
    symbol: target.name,
    kind: target.kind,
    filePath: target.filePath,
    line: target.line,
    references,
    totalReferences: references.length,
  };
}

/**
 * Generate refactoring suggestions based on graph structure.
 * Looks for:
 * - Symbols that are far from their most-connected peers (move candidates)
 * - Files with too many symbols in different "clusters" (split candidates)
 * - Groups of related symbols scattered across files (group candidates)
 */
export function suggestRefactorings(db: GraphDatabase, limit = 10): RefactorSuggestion[] {
  const rawDb = db.getRawDb();
  const suggestions: RefactorSuggestion[] = [];

  // 1. Find files with high fan-out to a single other directory (move candidates)
  const crossDirEdges = rawDb.all(
    `SELECT
       n1.file_path as sourceFile,
       n2.file_path as targetFile,
       COUNT(*) as edgeCount
     FROM edges e
     JOIN nodes n1 ON n1.id = e.source
     JOIN nodes n2 ON n2.id = e.target
     WHERE e.kind = 'calls'
       AND n1.file_path != n2.file_path
     GROUP BY n1.file_path, n2.file_path
     HAVING edgeCount >= 5
     ORDER BY edgeCount DESC
     LIMIT 20`
  ) as any[];

  for (const row of crossDirEdges.slice(0, 5)) {
    const sourceDir = row.sourceFile.split('/').slice(0, -1).join('/');
    const targetDir = row.targetFile.split('/').slice(0, -1).join('/');
    if (sourceDir !== targetDir) {
      suggestions.push({
        type: 'move',
        description: `\`${row.sourceFile}\` has ${row.edgeCount} calls to \`${row.targetFile}\` — consider co-locating related code`,
        symbols: [row.sourceFile, row.targetFile],
        rationale: `High cross-directory coupling (${row.edgeCount} call edges) suggests these files belong together`,
        priority: row.edgeCount >= 10 ? 'high' : 'medium',
      });
    }
  }

  // 2. Find large files (split candidates)
  const largeFiles = rawDb.all(
    `SELECT file_path, COUNT(*) as symbolCount
     FROM nodes
     WHERE kind IN ('function', 'method', 'class')
     GROUP BY file_path
     HAVING symbolCount >= 15
     ORDER BY symbolCount DESC
     LIMIT 10`
  ) as any[];

  for (const file of largeFiles.slice(0, 3)) {
    suggestions.push({
      type: 'split',
      description: `\`${file.file_path}\` has ${file.symbolCount} functions/classes — consider splitting into focused modules`,
      symbols: [file.file_path],
      rationale: `Files with many symbols often handle multiple responsibilities`,
      priority: file.symbolCount >= 30 ? 'high' : 'medium',
    });
  }

  // 3. Find exported symbols with zero callers (dead export candidates)
  const deadExports = rawDb.all(
    `SELECT n.name, n.kind, n.file_path as filePath
     FROM nodes n
     WHERE n.is_exported = 1
       AND n.kind IN ('function', 'method', 'class')
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target = n.id AND e.kind = 'calls')
     LIMIT 10`
  ) as any[];

  if (deadExports.length >= 3) {
    suggestions.push({
      type: 'extract',
      description: `${deadExports.length} exported symbols have no callers — consider removing exports or the symbols themselves`,
      symbols: deadExports.slice(0, 5).map((d: any) => `${d.kind} \`${d.name}\` in ${d.filePath}`),
      rationale: `Exported symbols with no callers are dead API surface — they add maintenance burden without value`,
      priority: deadExports.length >= 8 ? 'high' : 'low',
    });
  }

  return suggestions.slice(0, limit);
}

/**
 * KiroGraph Database Layer
 * Wraps node-sqlite3-wasm for portability (no native bindings needed).
 */

import * as path from 'path';
import * as fs from 'fs';
import type { Node, Edge, FileRecord, NodeKind, Language } from '../types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Database } = require('node-sqlite3-wasm');

export class GraphDatabase {
  private db: any;
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    const dbDir = path.join(projectRoot, '.kirograph');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'kirograph.db');
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.applySchema();
  }

  private applySchema(): void {
    const schemaPath = path.join(__dirname, '../db/schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    this.db.exec(sql);
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  upsertFile(record: FileRecord): void {
    this.db.run(
      `INSERT OR REPLACE INTO files (path, content_hash, language, file_size, symbol_count, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [record.path, record.contentHash, record.language, record.fileSize, record.symbolCount, record.indexedAt]
    );
  }

  getFile(filePath: string): FileRecord | null {
    const row = this.db.get('SELECT * FROM files WHERE path = ?', [filePath]);
    return row ? this.rowToFile(row) : null;
  }

  getAllFiles(): FileRecord[] {
    return this.db.all('SELECT * FROM files').map(this.rowToFile);
  }

  deleteFile(filePath: string): void {
    // Cascade deletes nodes (and their edges via FK)
    this.db.run('DELETE FROM nodes WHERE file_path = ?', [filePath]);
    this.db.run('DELETE FROM files WHERE path = ?', [filePath]);
  }

  private rowToFile(row: any): FileRecord {
    return {
      path: row.path,
      contentHash: row.content_hash,
      language: row.language as Language,
      fileSize: row.file_size,
      symbolCount: row.symbol_count,
      indexedAt: row.indexed_at,
    };
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────

  upsertNode(node: Node): void {
    this.db.run(
      `INSERT OR REPLACE INTO nodes
        (id, kind, name, qualified_name, file_path, language,
         start_line, end_line, start_column, end_column,
         docstring, signature, visibility,
         is_exported, is_async, is_static, is_abstract,
         decorators, type_parameters, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        node.id, node.kind, node.name, node.qualifiedName, node.filePath, node.language,
        node.startLine, node.endLine, node.startColumn, node.endColumn,
        node.docstring ?? null, node.signature ?? null, node.visibility ?? null,
        node.isExported ? 1 : 0, node.isAsync ? 1 : 0,
        node.isStatic ? 1 : 0, node.isAbstract ? 1 : 0,
        node.decorators ? JSON.stringify(node.decorators) : null,
        node.typeParameters ? JSON.stringify(node.typeParameters) : null,
        node.updatedAt,
      ]
    );
    // Keep FTS in sync
    this.db.run(
      `INSERT OR REPLACE INTO nodes_fts (id, name, qualified_name, docstring, signature)
       VALUES (?, ?, ?, ?, ?)`,
      [node.id, node.name, node.qualifiedName, node.docstring ?? '', node.signature ?? '']
    );
  }

  getNode(id: string): Node | null {
    const row = this.db.get('SELECT * FROM nodes WHERE id = ?', [id]);
    return row ? this.rowToNode(row) : null;
  }

  getNodesByFile(filePath: string): Node[] {
    return this.db.all('SELECT * FROM nodes WHERE file_path = ?', [filePath]).map(this.rowToNode);
  }

  searchNodes(query: string, kind?: NodeKind, limit = 20): Node[] {
    if (kind) {
      return this.db.all(
        `SELECT n.* FROM nodes n
         JOIN nodes_fts f ON n.id = f.id
         WHERE nodes_fts MATCH ? AND n.kind = ?
         ORDER BY rank LIMIT ?`,
        [query + '*', kind, limit]
      ).map(this.rowToNode);
    }
    return this.db.all(
      `SELECT n.* FROM nodes n
       JOIN nodes_fts f ON n.id = f.id
       WHERE nodes_fts MATCH ?
       ORDER BY rank LIMIT ?`,
      [query + '*', limit]
    ).map(this.rowToNode);
  }

  searchNodesByName(name: string, kind?: NodeKind, limit = 20): Node[] {
    const pattern = `%${name}%`;
    if (kind) {
      return this.db.all(
        'SELECT * FROM nodes WHERE name LIKE ? AND kind = ? LIMIT ?',
        [pattern, kind, limit]
      ).map(this.rowToNode);
    }
    return this.db.all(
      'SELECT * FROM nodes WHERE name LIKE ? LIMIT ?',
      [pattern, limit]
    ).map(this.rowToNode);
  }

  deleteNodesByFile(filePath: string): void {
    const ids = this.db.all('SELECT id FROM nodes WHERE file_path = ?', [filePath]).map((r: any) => r.id);
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.run(`DELETE FROM edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`, [...ids, ...ids]);
    this.db.run(`DELETE FROM nodes_fts WHERE id IN (${placeholders})`, ids);
    this.db.run(`DELETE FROM nodes WHERE file_path = ?`, [filePath]);
  }

  private rowToNode(row: any): Node {
    return {
      id: row.id,
      kind: row.kind as NodeKind,
      name: row.name,
      qualifiedName: row.qualified_name,
      filePath: row.file_path,
      language: row.language as Language,
      startLine: row.start_line,
      endLine: row.end_line,
      startColumn: row.start_column,
      endColumn: row.end_column,
      docstring: row.docstring ?? undefined,
      signature: row.signature ?? undefined,
      visibility: row.visibility ?? undefined,
      isExported: row.is_exported === 1,
      isAsync: row.is_async === 1,
      isStatic: row.is_static === 1,
      isAbstract: row.is_abstract === 1,
      decorators: row.decorators ? JSON.parse(row.decorators) : undefined,
      typeParameters: row.type_parameters ? JSON.parse(row.type_parameters) : undefined,
      updatedAt: row.updated_at,
    };
  }

  // ── Edges ──────────────────────────────────────────────────────────────────

  insertEdge(edge: Edge): void {
    this.db.run(
      `INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, column)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [edge.source, edge.target, edge.kind, edge.metadata ? JSON.stringify(edge.metadata) : null, edge.line ?? null, edge.column ?? null]
    );
  }

  getCallers(nodeId: string, limit = 30): Node[] {
    return this.db.all(
      `SELECT n.* FROM nodes n
       JOIN edges e ON e.source = n.id
       WHERE e.target = ? AND e.kind = 'calls'
       LIMIT ?`,
      [nodeId, limit]
    ).map(this.rowToNode);
  }

  getCallees(nodeId: string, limit = 30): Node[] {
    return this.db.all(
      `SELECT n.* FROM nodes n
       JOIN edges e ON e.target = n.id
       WHERE e.source = ? AND e.kind = 'calls'
       LIMIT ?`,
      [nodeId, limit]
    ).map(this.rowToNode);
  }

  getImpactRadius(nodeId: string, depth = 2): Node[] {
    // BFS over 'calls' and 'imports' edges (dependents)
    const visited = new Set<string>([nodeId]);
    let frontier = [nodeId];
    for (let d = 0; d < depth; d++) {
      if (frontier.length === 0) break;
      const placeholders = frontier.map(() => '?').join(',');
      const rows = this.db.all(
        `SELECT DISTINCT source FROM edges WHERE target IN (${placeholders}) AND kind IN ('calls','imports')`,
        frontier
      );
      frontier = [];
      for (const row of rows) {
        if (!visited.has(row.source)) {
          visited.add(row.source);
          frontier.push(row.source);
        }
      }
    }
    visited.delete(nodeId);
    if (visited.size === 0) return [];
    const ids = [...visited];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.all(`SELECT * FROM nodes WHERE id IN (${placeholders})`, ids).map(this.rowToNode);
  }

  getEdgesForNodes(nodeIds: string[]): Edge[] {
    if (nodeIds.length === 0) return [];
    const placeholders = nodeIds.map(() => '?').join(',');
    return this.db.all(
      `SELECT * FROM edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`,
      [...nodeIds, ...nodeIds]
    ).map((row: any) => ({
      source: row.source,
      target: row.target,
      kind: row.kind,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      line: row.line ?? undefined,
      column: row.column ?? undefined,
    }));
  }

  /**
   * Find files that import (depend on) the given file path.
   * Used for affected-test traversal.
   */
  getDependentFiles(filePath: string): string[] {
    // Find nodes in the target file
    const targetNodes = this.db.all('SELECT id FROM nodes WHERE file_path = ?', [filePath]);
    if (targetNodes.length === 0) return [];
    const ids = targetNodes.map((r: any) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    // Find source nodes that call/import these target nodes
    const rows = this.db.all(
      `SELECT DISTINCT n.file_path FROM nodes n
       JOIN edges e ON e.source = n.id
       WHERE e.target IN (${placeholders}) AND e.kind IN ('calls','imports')
       AND n.file_path != ?`,
      [...ids, filePath]
    );
    return rows.map((r: any) => r.file_path);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  getStats(): { files: number; nodes: number; edges: number; nodesByKind: Record<string, number> } {
    const files = this.db.get('SELECT COUNT(*) as c FROM files').c;
    const nodes = this.db.get('SELECT COUNT(*) as c FROM nodes').c;
    const edges = this.db.get('SELECT COUNT(*) as c FROM edges').c;
    const kindRows = this.db.all('SELECT kind, COUNT(*) as c FROM nodes GROUP BY kind');
    const nodesByKind: Record<string, number> = {};
    for (const row of kindRows) nodesByKind[row.kind] = row.c;
    return { files, nodes, edges, nodesByKind };
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN');
    try {
      const result = fn();
      this.db.run('COMMIT');
      return result;
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

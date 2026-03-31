/**
 * KiroGraph Database Layer
 * Wraps node-sqlite3-wasm for portability (no native bindings needed).
 */

import * as path from 'path';
import * as fs from 'fs';
import type { Node, Edge, FileRecord, NodeKind, Language, GraphStats, NodeContext, NodeMetrics, SearchOptions } from '../types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Database } = require('node-sqlite3-wasm');

const CURRENT_SCHEMA_VERSION = 1;

export class GraphDatabase {
  private db: any;
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    const dbDir = path.join(projectRoot, '.kirograph');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'kirograph.db');
    this.db = new Database(dbPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=120000;
      PRAGMA synchronous=NORMAL;
      PRAGMA cache_size=-64000;
      PRAGMA temp_store=MEMORY;
      PRAGMA mmap_size=268435456;
    `);
    this.applySchema();
  }

  private applySchema(): void {
    const schemaPath = path.join(__dirname, '../db/schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    this.db.exec(sql);
    this.runMigrations();
  }

  private runMigrations(): void {
    // Record initial schema version if not present
    const versionRow = this.db.get('SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1');
    const currentVersion = versionRow ? versionRow.version : 0;

    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      // Migration 1: schema.sql now includes all columns — nothing extra needed.
      // The schema CREATE IF NOT EXISTS statements handle initial setup.
      this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)',
        [CURRENT_SCHEMA_VERSION, Date.now()]);
    }

    // Add attempted_strategies column to unresolved_refs if not present.
    // SQLite throws if the column already exists, so we catch that error.
    try {
      this.db.run('ALTER TABLE unresolved_refs ADD COLUMN attempted_strategies TEXT');
    } catch {
      // Column already exists — nothing to do.
    }
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

  getNodesByKind(kind: Node['kind']): Node[] {
    return this.db.all('SELECT * FROM nodes WHERE kind = ?', [kind]).map(this.rowToNode);
  }

  findNodesByExactName(name: string, kinds?: NodeKind[], limit = 20): Node[] {
    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => '?').join(',');
      return this.db.all(
        `SELECT * FROM nodes WHERE name = ? AND kind IN (${placeholders}) LIMIT ?`,
        [name, ...kinds, limit]
      ).map(this.rowToNode);
    }
    return this.db.all(
      'SELECT * FROM nodes WHERE name = ? LIMIT ?',
      [name, limit]
    ).map(this.rowToNode);
  }

  searchNodes(query: string, opts: SearchOptions = {}): Node[] {
    const { kinds, languages, limit = 20 } = opts;
    // Sanitize for FTS5: escape special chars and append wildcard
    const safe = query.replace(/['"*()]/g, ' ').trim();
    const ftsQuery = safe ? safe + '*' : safe;

    const conditions: string[] = ['nodes_fts MATCH ?'];
    const params: any[] = [ftsQuery];

    if (kinds && kinds.length > 0) {
      conditions.push(`n.kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
    if (languages && languages.length > 0) {
      conditions.push(`n.language IN (${languages.map(() => '?').join(',')})`);
      params.push(...languages);
    }
    params.push(limit);

    return this.db.all(
      `SELECT n.* FROM nodes n
       JOIN nodes_fts f ON n.id = f.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY rank LIMIT ?`,
      params
    ).map(this.rowToNode);
  }

  searchNodesByName(name: string, opts: SearchOptions = {}): Node[] {
    const { kinds, languages, limit = 20 } = opts;
    const pattern = `%${name}%`;
    const conditions: string[] = ['name LIKE ?'];
    const params: any[] = [pattern];

    if (kinds && kinds.length > 0) {
      conditions.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
    if (languages && languages.length > 0) {
      conditions.push(`language IN (${languages.map(() => '?').join(',')})`);
      params.push(...languages);
    }
    params.push(limit);

    return this.db.all(
      `SELECT * FROM nodes WHERE ${conditions.join(' AND ')} LIMIT ?`,
      params
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

  // ── Unresolved References ──────────────────────────────────────────────────

  insertUnresolvedRef(sourceId: string, refName: string, refKind: string, filePath: string, line?: number, column?: number): void {
    this.db.run(
      `INSERT INTO unresolved_refs (source_id, ref_name, ref_kind, file_path, line, column)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sourceId, refName, refKind, filePath, line ?? null, column ?? null]
    );
  }

  deleteUnresolvedRefsByFile(filePath: string): void {
    this.db.run('DELETE FROM unresolved_refs WHERE file_path = ?', [filePath]);
  }

  /**
   * Resolve pending references:
   * - refKind='function': 3-strategy name matching → 'calls' edge
   * - refKind='import': path-based resolution → 'imports' edge
   *
   * Returns the number of edges successfully created.
   */
  resolveUnresolvedRefs(): number {
    const refs = this.db.all('SELECT * FROM unresolved_refs');
    let resolved = 0;

    for (const ref of refs) {
      const { id: refId, source_id: sourceId, ref_name: refName, ref_kind: refKind, file_path: filePath, line, column } = ref;

      if (refKind === 'function') {
        // Strategy 1: exact name match
        let target = this.db.get('SELECT id FROM nodes WHERE name = ? LIMIT 1', [refName]);

        // Strategy 2: qualified name suffix
        if (!target) {
          target = this.db.get(
            `SELECT id FROM nodes WHERE qualified_name LIKE ? LIMIT 1`,
            [`%::${refName}`]
          );
        }

        // Strategy 3: case-insensitive
        if (!target) {
          target = this.db.get(
            'SELECT id FROM nodes WHERE lower(name) = lower(?) LIMIT 1',
            [refName]
          );
        }

        if (target) {
          this.insertEdge({ source: sourceId, target: target.id, kind: 'calls', line: line ?? undefined, column: column ?? undefined });
          this.db.run('DELETE FROM unresolved_refs WHERE id = ?', [refId]);
          resolved++;
        }
      } else if (refKind === 'import') {
        // Resolve import path to an indexed file
        const targetFileNode = this.resolveImportPath(refName, filePath);
        if (targetFileNode) {
          this.insertEdge({ source: sourceId, target: targetFileNode, kind: 'imports', line: line ?? undefined, column: column ?? undefined });
          this.db.run('DELETE FROM unresolved_refs WHERE id = ?', [refId]);
          resolved++;
        }
      }
    }

    return resolved;
  }

  /** @deprecated Use resolveUnresolvedRefs() */
  resolveCallEdges(): number {
    return this.resolveUnresolvedRefs();
  }

  /**
   * Resolve a module import path to the ID of the first node in the target file.
   * Returns null if no indexed file matches.
   */
  private resolveImportPath(importPath: string, sourceFilePath: string): string | null {
    // Only resolve relative imports
    if (!importPath.startsWith('.')) return null;

    const sourceDir = sourceFilePath.replace(/[^/]+$/, '');
    // Normalize the relative path
    const segments = (sourceDir + importPath).split('/');
    const normalized: string[] = [];
    for (const seg of segments) {
      if (seg === '..') normalized.pop();
      else if (seg !== '.') normalized.push(seg);
    }
    const basePath = normalized.join('/');

    // Try exact match, then with common extensions
    const candidates = [
      basePath,
      basePath + '.ts',
      basePath + '.tsx',
      basePath + '.js',
      basePath + '.jsx',
      basePath + '/index.ts',
      basePath + '/index.tsx',
      basePath + '/index.js',
    ];

    for (const candidate of candidates) {
      const row = this.db.get('SELECT id FROM nodes WHERE file_path = ? LIMIT 1', [candidate]);
      if (row) return row.id;
    }

    return null;
  }

  // ── Node Context & Metrics ─────────────────────────────────────────────────

  getNodeContext(nodeId: string): NodeContext | null {
    const node = this.getNode(nodeId);
    if (!node) return null;

    const ancestors = this.db.all(
      `SELECT n.* FROM nodes n
       JOIN edges e ON e.target = n.id
       WHERE e.source = ? AND e.kind = 'contains'`,
      [nodeId]
    ).map(this.rowToNode);

    const children = this.db.all(
      `SELECT n.* FROM nodes n
       JOIN edges e ON e.source = n.id
       WHERE e.target = n.id AND e.source = ? AND e.kind = 'contains'`,
      [nodeId]
    ).map(this.rowToNode);

    const callers = this.getCallers(nodeId, 20);
    const callees = this.getCallees(nodeId, 20);

    return { node, ancestors, children, callers, callees };
  }

  getNodeMetrics(nodeId: string): NodeMetrics {
    const incomingEdgeCount = (this.db.get('SELECT COUNT(*) as c FROM edges WHERE target = ?', [nodeId])?.c ?? 0);
    const outgoingEdgeCount = (this.db.get('SELECT COUNT(*) as c FROM edges WHERE source = ?', [nodeId])?.c ?? 0);
    const callCount = (this.db.get(`SELECT COUNT(*) as c FROM edges WHERE source = ? AND kind = 'calls'`, [nodeId])?.c ?? 0);
    const callerCount = (this.db.get(`SELECT COUNT(*) as c FROM edges WHERE target = ? AND kind = 'calls'`, [nodeId])?.c ?? 0);
    const childCount = (this.db.get(`SELECT COUNT(*) as c FROM edges WHERE source = ? AND kind = 'contains'`, [nodeId])?.c ?? 0);
    return { incomingEdgeCount, outgoingEdgeCount, callCount, callerCount, childCount };
  }

  // ── Graph Analysis ─────────────────────────────────────────────────────────

  /**
   * Find symbols with no incoming edges (potential dead code).
   * Excludes exported symbols since they may be consumed externally.
   */
  findDeadCode(limit = 50): Node[] {
    return this.db.all(
      `SELECT * FROM nodes
       WHERE kind IN ('function','method','class')
         AND is_exported = 0
         AND id NOT IN (SELECT DISTINCT target FROM edges)
       LIMIT ?`,
      [limit]
    ).map(this.rowToNode);
  }

  /**
   * Find circular import dependencies using DFS over import edges.
   * Returns arrays of file paths forming cycles.
   */
  findCircularDependencies(): string[][] {
    // Build adjacency map: file → imported files
    const rows = this.db.all(
      `SELECT DISTINCT n1.file_path as src, n2.file_path as dst
       FROM edges e
       JOIN nodes n1 ON n1.id = e.source
       JOIN nodes n2 ON n2.id = e.target
       WHERE e.kind = 'imports' AND n1.file_path != n2.file_path`
    );

    const adj = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!adj.has(row.src)) adj.set(row.src, new Set());
      adj.get(row.src)!.add(row.dst);
    }

    const cycles: string[][] = [];
    const visited = new Set<string>();
    const pathSet = new Set<string>();
    const pathArr: string[] = [];

    function dfs(node: string): void {
      if (pathSet.has(node)) {
        const cycleStart = pathArr.indexOf(node);
        cycles.push(pathArr.slice(cycleStart).concat(node));
        return;
      }
      if (visited.has(node)) return;
      visited.add(node);
      pathSet.add(node);
      pathArr.push(node);
      for (const neighbor of adj.get(node) ?? []) {
        dfs(neighbor);
      }
      pathArr.pop();
      pathSet.delete(node);
    }

    for (const node of adj.keys()) {
      if (!visited.has(node)) dfs(node);
    }

    return cycles;
  }

  /**
   * Find the shortest path between two nodes via directed BFS (outgoing edges only).
   */
  findPath(fromId: string, toId: string, maxDepth = 10): Node[] {
    if (fromId === toId) {
      const node = this.getNode(fromId);
      return node ? [node] : [];
    }

    const prev = new Map<string, string>();
    const queue: string[] = [fromId];
    const visited = new Set<string>([fromId]);
    let depth = 0;

    outer: while (queue.length > 0 && depth < maxDepth) {
      const levelSize = queue.length;
      depth++;
      for (let i = 0; i < levelSize; i++) {
        const current = queue.shift()!;
        // Directed: only follow outgoing edges
        const rows = this.db.all(
          `SELECT DISTINCT target as next FROM edges WHERE source = ?`,
          [current]
        );
        for (const row of rows) {
          if (!visited.has(row.next)) {
            visited.add(row.next);
            prev.set(row.next, current);
            if (row.next === toId) break outer;
            queue.push(row.next);
          }
        }
      }
    }

    if (!prev.has(toId)) return [];

    // Reconstruct path
    const pathIds: string[] = [];
    let cur: string | undefined = toId;
    while (cur !== undefined) {
      pathIds.unshift(cur);
      cur = prev.get(cur);
    }

    const result: Node[] = [];
    for (const id of pathIds) {
      const node = this.getNode(id);
      if (node) result.push(node);
    }
    return result;
  }

  /**
   * Traverse type hierarchy via 'extends' and 'implements' edges.
   * direction 'up' = base types, 'down' = derived types, 'both' = all.
   */
  getTypeHierarchy(nodeId: string, direction: 'up' | 'down' | 'both' = 'both'): Node[] {
    const visited = new Set<string>([nodeId]);
    const frontier = [nodeId];
    const result: Node[] = [];

    while (frontier.length > 0) {
      const current = frontier.shift()!;
      let rows: any[] = [];

      if (direction === 'up' || direction === 'both') {
        // current extends/implements something → go up
        const up = this.db.all(
          `SELECT target as id FROM edges WHERE source = ? AND kind IN ('extends','implements')`,
          [current]
        );
        rows = rows.concat(up);
      }
      if (direction === 'down' || direction === 'both') {
        // something extends/implements current → go down
        const down = this.db.all(
          `SELECT source as id FROM edges WHERE target = ? AND kind IN ('extends','implements')`,
          [current]
        );
        rows = rows.concat(down);
      }

      for (const row of rows) {
        if (!visited.has(row.id)) {
          visited.add(row.id);
          frontier.push(row.id);
          const node = this.getNode(row.id);
          if (node) result.push(node);
        }
      }
    }

    return result;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getEmbeddingCount(): number {
    try {
      const row = this.db.get('SELECT COUNT(*) as c FROM vectors');
      return row ? row.c : 0;
    } catch {
      return 0;
    }
  }

  storeEmbedding(nodeId: string, embedding: Float32Array, model: string): void {
    const buf = Buffer.from(embedding.buffer);
    this.db.run(
      `INSERT OR REPLACE INTO vectors (node_id, embedding, model, created_at) VALUES (?, ?, ?, ?)`,
      [nodeId, buf, model, Date.now()]
    );
  }

  getEmbeddedNodeIds(): string[] {
    return this.db.all('SELECT node_id FROM vectors').map((r: any) => r.node_id);
  }

  getAllEmbeddings(): Array<{ nodeId: string; embedding: Float32Array }> {
    const rows = this.db.all('SELECT node_id, embedding FROM vectors');
    return rows.map((r: any) => ({
      nodeId: r.node_id as string,
      embedding: new Float32Array(
        (r.embedding as Buffer).buffer,
        (r.embedding as Buffer).byteOffset,
        (r.embedding as Buffer).byteLength / 4
      ),
    }));
  }

  getAllNodes(): import('../types').Node[] {
    return this.db.all('SELECT * FROM nodes').map(this.rowToNode);
  }

  getStats(): GraphStats {
    const files = this.db.get('SELECT COUNT(*) as c FROM files').c;
    const nodes = this.db.get('SELECT COUNT(*) as c FROM nodes').c;
    const edges = this.db.get('SELECT COUNT(*) as c FROM edges').c;
    const kindRows = this.db.all('SELECT kind, COUNT(*) as c FROM nodes GROUP BY kind');
    const nodesByKind: Record<string, number> = {};
    for (const row of kindRows) nodesByKind[row.kind] = row.c;
    const langRows = this.db.all('SELECT language, COUNT(*) as c FROM files GROUP BY language');
    const filesByLanguage: Record<string, number> = {};
    for (const row of langRows) filesByLanguage[row.language] = row.c;
    const dbPath = path.join(this.projectRoot, '.kirograph', 'kirograph.db');
    let dbSizeBytes = 0;
    try { dbSizeBytes = fs.statSync(dbPath).size; } catch { /* ignore */ }
    const embeddingCount = this.getEmbeddingCount();
    return { files, nodes, edges, nodesByKind, filesByLanguage, dbSizeBytes, embeddingCount, embeddingsEnabled: false, embeddingModel: '', useVecIndex: false, vecIndexCount: 0, frameworks: [] };
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

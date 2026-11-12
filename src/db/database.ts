/**
 * KiroGraph Database Layer
 * Wraps node-sqlite3-wasm for portability (no native bindings needed).
 */

import * as path from 'path';
import * as fs from 'fs';
import type { Node, Edge, FileRecord, NodeKind, Language, GraphStats, NodeContext, NodeMetrics, SearchOptions } from '../types';
import type { ArchPackage, ArchLayer, ArchPackageDep, ArchLayerDep, ArchCoupling } from '../architecture/types';
import type { RouteMountFact } from '../extraction/extractor';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Database } = require('node-sqlite3-wasm');
import { BusyRetryDatabase, clearStaleDbLock } from './db-lock';
import { recoverHotJournal } from './journal-recovery';

const CURRENT_SCHEMA_VERSION = 4;

/** Parameters per multi-row statement. SQLite allows more; a smaller statement is cheaper to parse. */
const MAX_PARAMS_PER_STATEMENT = 1000;
/** Rows per statement, largest first. Powers of two keep the number of distinct statements small. */
const GROUP_SIZES = [128, 64, 32, 16, 8, 4, 2, 1];

export class GraphDatabase {
  private db: any;
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    const dbDir = path.join(projectRoot, '.kirograph');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'kirograph.db');

    // ── Lock check ────────────────────────────────────────────────────────────
    // The WASM driver locks by creating kirograph.db.lock and never removes it when the
    // process dies. A stale one is cleared here. A live holder is waited for by the driver's
    // busy_timeout (set first in the PRAGMAs below), so a long sync is not cut short.
    const lockPath = path.join(dbDir, 'kirograph.db.lock');
    const lockFree = clearStaleDbLock(dbDir, lockPath);
    // A process killed mid-write leaves a hot journal that the driver can never roll back by
    // itself (see journal-recovery.ts); without this the open waits for the busy timeout and fails
    if (lockFree) recoverHotJournal(dbPath, lockPath);

    this.db = new BusyRetryDatabase(new Database(dbPath), dbDir, lockPath);
    this.db.exec(`
      PRAGMA busy_timeout=120000;
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
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

  /**
   * Apply memory schema tables. Called when enableMemory is true.
   * Safe to call multiple times (CREATE IF NOT EXISTS).
   */
  applyMemorySchema(): void {
    const schemaPath = path.join(__dirname, '../db/memory-schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      this.db.exec(sql);
    }
  }

  /**
   * Apply docs schema tables. Called when enableDocs is true.
   * Safe to call multiple times (CREATE IF NOT EXISTS).
   */
  applyDocsSchema(): void {
    const schemaPath = path.join(__dirname, '../db/docs-schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      this.db.exec(sql);
    }
  }

  /**
   * Apply data schema tables. Called when enableData is true.
   * Safe to call multiple times (CREATE IF NOT EXISTS).
   */
  applyDataSchema(): void {
    const schemaPath = path.join(__dirname, '../db/data-schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      this.db.exec(sql);
    }
    // Migrate existing DBs: add columns introduced after initial release.
    const tryAlter = (stmt: string) => { try { this.db.run(stmt); } catch { /* already exists */ } };
    tryAlter('ALTER TABLE data_datasets ADD COLUMN metadata_json TEXT');
  }

  /**
   * Apply patterns schema tables. Called when enablePatterns is true.
   * Safe to call multiple times (CREATE IF NOT EXISTS).
   */
  applyPatternsSchema(): void {
    const schemaPath = path.join(__dirname, '../db/patterns-schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      this.db.exec(sql);
    }
    // Migrate existing DBs: add new columns introduced after initial release.
    const tryAlter = (stmt: string) => { try { this.db.run(stmt); } catch { /* already exists */ } };
    tryAlter('ALTER TABLE pattern_matches ADD COLUMN symbol_node_id TEXT');
    tryAlter('CREATE INDEX IF NOT EXISTS idx_pm_symbol ON pattern_matches(symbol_node_id)');
  }

  /**
   * Apply security schema tables. Called when enableSecurity is true.
   * Safe to call multiple times (CREATE IF NOT EXISTS).
   */
  applySecuritySchema(): void {
    const schemaPath = path.join(__dirname, '../db/security-schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      this.db.exec(sql);
    }
    // Migrate existing DBs: add new columns introduced after initial release.
    const tryAlter = (stmt: string) => { try { this.db.run(stmt); } catch { /* already exists */ } };
    tryAlter('ALTER TABLE sec_dependencies ADD COLUMN license TEXT');
    tryAlter('ALTER TABLE sec_dependencies ADD COLUMN latest_version TEXT');
    tryAlter('ALTER TABLE sec_dependencies ADD COLUMN latest_published INTEGER');
    tryAlter('ALTER TABLE sec_dependencies ADD COLUMN staleness_score REAL');
    tryAlter('ALTER TABLE sec_vulnerabilities ADD COLUMN epss_score REAL');
    tryAlter('ALTER TABLE sec_vulnerabilities ADD COLUMN epss_percentile REAL');
    tryAlter('ALTER TABLE sec_vulnerabilities ADD COLUMN epss_fetched_at INTEGER');
    tryAlter('CREATE INDEX IF NOT EXISTS idx_sec_deps_license ON sec_dependencies(license)');
    tryAlter('CREATE INDEX IF NOT EXISTS idx_sec_deps_staleness ON sec_dependencies(staleness_score)');
    tryAlter('CREATE INDEX IF NOT EXISTS idx_sec_vulns_epss ON sec_vulnerabilities(epss_score)');
    tryAlter('ALTER TABLE sec_vulnerabilities ADD COLUMN risk_score REAL');
    tryAlter('CREATE INDEX IF NOT EXISTS idx_sec_vulns_risk ON sec_vulnerabilities(risk_score)');
    tryAlter('ALTER TABLE sec_vulnerabilities ADD COLUMN first_detected_at INTEGER');
    tryAlter('ALTER TABLE sec_vulnerabilities ADD COLUMN fix_available_since INTEGER');
    tryAlter('ALTER TABLE sec_vulnerabilities ADD COLUMN suppressed_at INTEGER');
    tryAlter('ALTER TABLE sec_vulnerabilities ADD COLUMN remediated_at INTEGER');
  }

  /**
   * Apply wiki schema tables. Called when enableWiki is true.
   * Safe to call multiple times (CREATE IF NOT EXISTS).
   */
  applyWikiSchema(): void {
    const schemaPath = path.join(__dirname, '../db/wiki-schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      this.db.exec(sql);
    }
  }

  /**
   * Get the raw database handle (for MemoryDatabase).
   */
  getRawDb(): any {
    return this.db;
  }

  private runMigrations(): void {
    // Record initial schema version if not present
    const versionRow = this.db.get('SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1');
    const currentVersion = versionRow ? versionRow.version : 0;

    if (currentVersion < 4) {
      // Migration 4: edges had no unique key, so INSERT OR IGNORE ignored nothing and every pass
      // that adds the same edge (the security analysis adds declared_in, depends_on and
      // has_vulnerability on each run) added it again: a real project had 218,849 rows for 654
      // distinct edges, and the table and its five indexes were 70% of the file. Remove the
      // copies (the first of each stays) and make the key unique. line and column can be NULL, and
      // NULLs are distinct in an index, so they enter the key as -1.
      this.transaction(() => {
        this.db.run(`DELETE FROM edges WHERE id NOT IN (
          SELECT MIN(id) FROM edges GROUP BY source, target, kind, COALESCE(line, -1), COALESCE("column", -1))`);
        this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
          ON edges (source, target, kind, COALESCE(line, -1), COALESCE("column", -1))`);
        this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [4, Date.now()]);
      });
      this.reclaimSpace();
    }
    if (currentVersion < 3) {
      // Migration 3: nodes_fts is an external-content table (content_rowid = nodes.rowid), but its
      // rows used to be inserted without a rowid and deleted by the id column, which is not
      // indexed, so every delete scanned the whole table. Rows now carry the node's rowid and are
      // deleted by it. Rebuild once so existing rows line up with their nodes.
      try { this.db.run("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')"); } catch { /* no fts table yet */ }
      this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [3, Date.now()]);
    }
    if (currentVersion < 2) {
      // Migration 2: add complexity metric columns to nodes table.
      for (const col of [
        'complexity_cyclomatic INTEGER',
        'complexity_cognitive INTEGER',
        'complexity_halstead TEXT',
        'maintainability_index REAL',
        'nesting_depth INTEGER',
      ]) {
        try { this.db.run(`ALTER TABLE nodes ADD COLUMN ${col}`); } catch { /* already exists */ }
      }
      this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [2, Date.now()]);
    }
    if (currentVersion < 1) {
      // Migration 1: schema.sql CREATE IF NOT EXISTS handles initial setup.
      this.db.run('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)',
        [1, Date.now()]);
    }

    // Add metadata column to unresolved_refs if not present (call-site facts, e.g. argKind).
    try {
      this.db.run('ALTER TABLE unresolved_refs ADD COLUMN metadata TEXT');
    } catch {
      // Column already exists — nothing to do.
    }

    // Add attempted_strategies column to unresolved_refs if not present.
    // SQLite throws if the column already exists, so we catch that error.
    try {
      this.db.run('ALTER TABLE unresolved_refs ADD COLUMN attempted_strategies TEXT');
    } catch {
      // Column already exists — nothing to do.
    }

    // Add confidence columns to edges if not present.
    try {
      this.db.run("ALTER TABLE edges ADD COLUMN confidence TEXT NOT NULL DEFAULT 'extracted'");
    } catch {
      // Column already exists — nothing to do.
    }
    try {
      this.db.run('ALTER TABLE edges ADD COLUMN confidence_score REAL NOT NULL DEFAULT 1.0');
    } catch {
      // Column already exists — nothing to do.
    }
  }

  /**
   * Gives back the pages a large delete freed, when they are a good part of the file. VACUUM
   * rewrites the whole file, so it is not done for a few pages. A failure is ignored: the file is
   * only bigger than it needs to be.
   */
  private reclaimSpace(): void {
    try {
      const pageSize = this.db.get('PRAGMA page_size').page_size as number;
      const free = this.db.get('PRAGMA freelist_count').freelist_count as number;
      const total = this.db.get('PRAGMA page_count').page_count as number;
      if (free * pageSize >= 16 * 1024 * 1024 && free / total >= 0.25) this.db.run('VACUUM');
    } catch { /* not worth failing an open for */ }
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
    // The edges table has no foreign keys, so nothing cascades: deleteNodesByFile removes the
    // file's edges and full-text entries along with its nodes.
    this.deleteNodesByFile(filePath);
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

  /** Column list of the nodes table, in the order of `nodeParams`. */
  private static readonly NODE_COLUMNS =
    `(id, kind, name, qualified_name, file_path, language,
       start_line, end_line, start_column, end_column,
       docstring, signature, visibility,
       is_exported, is_async, is_static, is_abstract,
       decorators, type_parameters, updated_at,
       complexity_cyclomatic, complexity_cognitive, complexity_halstead,
       maintainability_index, nesting_depth)`;
  private static readonly NODE_ROW = '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';

  private nodeParams(node: Node): unknown[] {
    return [
      node.id, node.kind, node.name, node.qualifiedName, node.filePath, node.language,
      node.startLine, node.endLine, node.startColumn, node.endColumn,
      node.docstring ?? null, node.signature ?? null, node.visibility ?? null,
      node.isExported ? 1 : 0, node.isAsync ? 1 : 0,
      node.isStatic ? 1 : 0, node.isAbstract ? 1 : 0,
      node.decorators ? JSON.stringify(node.decorators) : null,
      node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      node.updatedAt,
      node.complexityCyclomatic ?? null, node.complexityCognitive ?? null,
      node.complexityHalstead ?? null, node.maintainabilityIndex ?? null,
      node.nestingDepth ?? null,
    ];
  }

  /**
   * Inserts many rows with few statements. Calls into the WASM driver cost far more than the rows
   * themselves (about 20 µs a call against 5 µs a row), so rows go in groups. Group sizes are
   * powers of two: only a handful of distinct statements are ever prepared, and they stay cached.
   */
  private multiInsert(head: string, rowSql: string, rows: unknown[][]): void {
    if (rows.length === 0) return;
    const maxRows = Math.max(1, Math.floor(MAX_PARAMS_PER_STATEMENT / rows[0].length));
    const sizes = GROUP_SIZES.filter(s => s <= maxRows);
    let i = 0;
    while (i < rows.length) {
      const size = sizes.find(s => s <= rows.length - i)!;
      const params: unknown[] = [];
      for (let k = 0; k < size; k++) for (const v of rows[i + k]) params.push(v);
      this.db.run(`${head} VALUES ${Array(size).fill(rowSql).join(',')}`, params);
      i += size;
    }
  }

  /**
   * Same result as calling `upsertNode` for each node, in a few statements. When the same id
   * appears twice the later node wins, as INSERT OR REPLACE did row by row.
   */
  upsertNodes(nodes: Node[]): void {
    if (nodes.length === 0) return;
    const byId = new Map<string, Node>();
    for (const n of nodes) byId.set(n.id, n);
    const unique = [...byId.values()];
    this.multiInsert(`INSERT OR REPLACE INTO nodes ${GraphDatabase.NODE_COLUMNS}`, GraphDatabase.NODE_ROW,
      unique.map(n => this.nodeParams(n)));
    // Full-text index: one statement per group of ids, each node under its own rowid
    const ids = unique.map(n => n.id);
    let i = 0;
    while (i < ids.length) {
      const size = GROUP_SIZES.find(s => s <= ids.length - i)!;
      this.db.run(
        `INSERT OR REPLACE INTO nodes_fts (rowid, id, name, qualified_name, docstring, signature)
         SELECT rowid, id, name, qualified_name, COALESCE(docstring, ''), COALESCE(signature, '')
         FROM nodes WHERE id IN (${Array(size).fill('?').join(',')})`,
        ids.slice(i, i + size),
      );
      i += size;
    }
  }

  upsertNode(node: Node): void {
    const inserted = this.db.run(
      `INSERT OR REPLACE INTO nodes ${GraphDatabase.NODE_COLUMNS} VALUES ${GraphDatabase.NODE_ROW}`,
      this.nodeParams(node),
    );
    // Keep FTS in sync, under the node's own rowid so it can be deleted by rowid (see deleteNodesByFile)
    this.db.run(
      `INSERT OR REPLACE INTO nodes_fts (rowid, id, name, qualified_name, docstring, signature)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [(inserted as { lastInsertRowid: number }).lastInsertRowid,
        node.id, node.name, node.qualifiedName, node.docstring ?? '', node.signature ?? '']
    );
  }

  getNode(id: string): Node | null {
    const row = this.db.get('SELECT * FROM nodes WHERE id = ?', [id]);
    return row ? this.rowToNode(row) : null;
  }

  /** Number of nodes in a file, without loading them. */
  countNodesByFile(filePath: string): number {
    return this.db.get('SELECT count(*) AS c FROM nodes WHERE file_path = ?', [filePath]).c;
  }

  /** Number of edges that start or end at a node of the file: what getEdgesForNodes would return. */
  countEdgesTouchingFile(filePath: string): number {
    return this.db.get(
      `SELECT count(*) AS c FROM edges
       WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)
          OR target IN (SELECT id FROM nodes WHERE file_path = ?)`,
      [filePath, filePath],
    ).c;
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
    // Sanitize for FTS5: strip special chars and append wildcard.
    // Both the MATCH value and LIMIT are inlined (not bound via ?) because
    // node-sqlite3-wasm passes bound parameters through to FTS5's own query
    // parser before SQLite substitutes them, causing "syntax error near ?".
    const safe = query
      .replace(/\b(AND|OR|NOT)\b/g, ' ')       // FTS5 boolean operators
      .replace(/['"*()?\-+^~:{}\\\.\/,]/g, ' ')  // FTS5 special chars (incl. / and ,)
      .replace(/\s+/g, ' ')
      .trim();
    if (!safe) return [];

    const ftsQuery = safe + '*';
    const safeLimit = Math.max(1, Math.floor(Number(limit)));

    const conditions: string[] = [];
    const params: any[] = [];

    if (kinds && kinds.length > 0) {
      conditions.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
    if (languages && languages.length > 0) {
      conditions.push(`language IN (${languages.map(() => '?').join(',')})`);
      params.push(...languages);
    }

    const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    return this.db.all(
      `SELECT * FROM nodes
       WHERE id IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH '${ftsQuery}')
       ${where}
       LIMIT ${safeLimit}`,
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
    // By rowid: the FTS table has no index on id, so deleting by id scanned the whole table for
    // every file, which made a sync slower the larger the project. Must run before the nodes
    // are deleted: an external-content table reads the old values from them.
    this.db.run(`DELETE FROM nodes_fts WHERE rowid IN (SELECT rowid FROM nodes WHERE file_path = ?)`, [filePath]);
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
      complexityCyclomatic: row.complexity_cyclomatic ?? undefined,
      complexityCognitive: row.complexity_cognitive ?? undefined,
      complexityHalstead: row.complexity_halstead ?? undefined,
      maintainabilityIndex: row.maintainability_index ?? undefined,
      nestingDepth: row.nesting_depth ?? undefined,
    };
  }

  // ── Edges ──────────────────────────────────────────────────────────────────

  insertEdge(edge: Edge): void {
    this.db.run(
      `INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, column, confidence, confidence_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [edge.source, edge.target, edge.kind, edge.metadata ? JSON.stringify(edge.metadata) : null, edge.line ?? null, edge.column ?? null, edge.confidence ?? 'extracted', edge.confidenceScore ?? 1.0]
    );
  }

  /** Same result as calling `insertEdge` for each edge, in a few statements. */
  insertEdges(edges: Edge[]): void {
    this.multiInsert(
      'INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, column, confidence, confidence_score)',
      '(?, ?, ?, ?, ?, ?, ?, ?)',
      edges.map(e => [e.source, e.target, e.kind, e.metadata ? JSON.stringify(e.metadata) : null,
        e.line ?? null, e.column ?? null, e.confidence ?? 'extracted', e.confidenceScore ?? 1.0]),
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

  insertUnresolvedRef(sourceId: string, refName: string, refKind: string, filePath: string, line?: number, column?: number, metadata?: Record<string, unknown>): void {
    this.db.run(
      `INSERT INTO unresolved_refs (source_id, ref_name, ref_kind, file_path, line, column, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sourceId, refName, refKind, filePath, line ?? null, column ?? null, metadata ? JSON.stringify(metadata) : null]
    );
  }

  /** Same result as calling `insertUnresolvedRef` for each reference, in a few statements. */
  insertUnresolvedRefs(filePath: string, refs: Array<{ sourceId: string; refName: string; refKind: string; line?: number; column?: number; metadata?: Record<string, unknown> }>): void {
    this.multiInsert(
      'INSERT INTO unresolved_refs (source_id, ref_name, ref_kind, file_path, line, column, metadata)',
      '(?, ?, ?, ?, ?, ?, ?)',
      refs.map(r => [r.sourceId, r.refName, r.refKind, filePath, r.line ?? null, r.column ?? null,
        r.metadata ? JSON.stringify(r.metadata) : null]),
    );
  }

  deleteUnresolvedRefsByFile(filePath: string): void {
    this.db.run('DELETE FROM unresolved_refs WHERE file_path = ?', [filePath]);
    // Route mounts are per-file extraction facts too: they are rewritten with the file
    this.db.run('DELETE FROM route_mounts WHERE file_path = ?', [filePath]);
  }

  insertRouteMount(filePath: string, mount: RouteMountFact): void {
    this.db.run(
      'INSERT INTO route_mounts (file_path, plugin_name, imported_name, specifier, prefix, line, inline_start, inline_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [filePath, mount.pluginName, mount.importedName, mount.specifier, mount.prefix, mount.line,
        mount.inlineStart ?? null, mount.inlineEnd ?? null]
    );
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
        let confidence: 'extracted' | 'inferred' | 'ambiguous' = 'inferred';
        let confidenceScore = 1.0;

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
          // Case-insensitive match is less certain
          if (target) confidenceScore = 0.8;
        }

        // Check if there are multiple candidates (ambiguous)
        if (target) {
          const candidateCount = this.db.get('SELECT COUNT(*) as cnt FROM nodes WHERE name = ?', [refName]);
          if (candidateCount && candidateCount.cnt > 1) {
            confidence = 'ambiguous';
            confidenceScore = 1.0 / candidateCount.cnt;
          }
        }

        if (target) {
          this.insertEdge({ source: sourceId, target: target.id, kind: 'calls', line: line ?? undefined, column: column ?? undefined, confidence, confidenceScore });
          this.db.run('DELETE FROM unresolved_refs WHERE id = ?', [refId]);
          resolved++;
        }
      } else if (refKind === 'import') {
        // Resolve import path to an indexed file
        const targetFileNode = this.resolveImportPath(refName, filePath);
        if (targetFileNode) {
          this.insertEdge({ source: sourceId, target: targetFileNode, kind: 'imports', line: line ?? undefined, column: column ?? undefined, confidence: 'inferred', confidenceScore: 1.0 });
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

  /**
   * Returns embeddable nodes in pages for memory-efficient streaming.
   * `kinds` filters by node kind (e.g. ['function','method','class']).
   * Returns an empty array when offset >= total count.
   */
  getEmbeddableNodesPaged(kinds: string[], limit: number, offset: number): import('../types').Node[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => '?').join(',');
    return this.db.all(
      `SELECT * FROM nodes WHERE kind IN (${placeholders}) LIMIT ? OFFSET ?`,
      [...kinds, limit, offset]
    ).map(this.rowToNode);
  }

  /** Count of nodes whose kind is in the provided list. */
  countEmbeddableNodes(kinds: string[]): number {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => '?').join(',');
    const row = this.db.get(`SELECT COUNT(*) as c FROM nodes WHERE kind IN (${placeholders})`, kinds);
    return row?.c ?? 0;
  }

  getAllEdges(): Edge[] {
    return this.db.all('SELECT source, target, kind FROM edges').map((row: any) => ({
      source: row.source,
      target: row.target,
      kind: row.kind,
    }));
  }

  /**
   * Find the top-N most-connected nodes by total edge degree (in + out).
   * Excludes 'contains' edges (structural nesting, not semantic connections).
   */
  findHotspots(limit = 20): Array<Node & { degree: number; inDegree: number; outDegree: number }> {
    const rows = this.db.all(
      `SELECT n.*,
         (SELECT COUNT(*) FROM edges WHERE target = n.id AND kind != 'contains') AS in_degree,
         (SELECT COUNT(*) FROM edges WHERE source = n.id AND kind != 'contains') AS out_degree,
         (SELECT COUNT(*) FROM edges WHERE (source = n.id OR target = n.id) AND kind != 'contains') AS degree
       FROM nodes n
       ORDER BY degree DESC
       LIMIT ?`,
      [limit]
    );
    return rows.map((row: any) => ({
      ...this.rowToNode(row),
      degree: row.degree as number,
      inDegree: row.in_degree as number,
      outDegree: row.out_degree as number,
    }));
  }

  /**
   * Find surprising cross-file connections: direct edges between nodes in
   * structurally distant files. Scored by path distance × edge-kind weight.
   */
  findSurprisingConnections(limit = 20): Array<{ source: Node; target: Node; kind: string; score: number }> {
    const KIND_WEIGHT: Record<string, number> = {
      calls: 1.0, references: 0.8, type_of: 0.7, returns: 0.6,
      decorates: 0.6, extends: 0.5, implements: 0.5,
    };

    const rows: Array<{ source: string; target: string; kind: string; source_file: string; target_file: string }> =
      this.db.all(
        `SELECT e.source, e.target, e.kind,
                ns.file_path AS source_file, nt.file_path AS target_file
         FROM edges e
         JOIN nodes ns ON ns.id = e.source
         JOIN nodes nt ON nt.id = e.target
         WHERE ns.file_path != nt.file_path
           AND e.kind NOT IN ('contains', 'import', 'imports')
         LIMIT 5000`
      );

    // Score: path distance × kind weight
    const scored = rows.map(row => {
      const srcDirs = row.source_file.split('/').slice(0, -1);
      const tgtDirs = row.target_file.split('/').slice(0, -1);
      let common = 0;
      for (let i = 0; i < Math.min(srcDirs.length, tgtDirs.length); i++) {
        if (srcDirs[i] === tgtDirs[i]) common++;
        else break;
      }
      const maxDirs = Math.max(srcDirs.length, tgtDirs.length, 1);
      const pathSimilarity = common / maxDirs;
      const kindWeight = KIND_WEIGHT[row.kind] ?? 0.4;
      return { ...row, score: (1 - pathSimilarity) * kindWeight };
    });

    // Sort desc, deduplicate by source+target+kind
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const top: typeof scored = [];
    for (const row of scored) {
      const key = `${row.source}|${row.target}|${row.kind}`;
      if (!seen.has(key)) {
        seen.add(key);
        top.push(row);
        if (top.length >= limit) break;
      }
    }

    const result: Array<{ source: Node; target: Node; kind: string; score: number }> = [];
    for (const row of top) {
      const src = this.getNode(row.source);
      const tgt = this.getNode(row.target);
      if (src && tgt) result.push({ source: src, target: tgt, kind: row.kind, score: row.score });
    }
    return result;
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
    return { files, nodes, edges, nodesByKind, filesByLanguage, dbSizeBytes, embeddingCount, embeddingsEnabled: false, embeddingModel: '', useVecIndex: false, semanticEngine: 'cosine' as const, vecIndexCount: 0, engineFallback: null, embeddableNodeCount: 0, frameworks: [], architectureEnabled: false };
  }

  // ── Architecture ──────────────────────────────────────────────────────────

  clearArchitecture(): void {
    this.db.run('DELETE FROM arch_coupling');
    this.db.run('DELETE FROM arch_layer_deps');
    this.db.run('DELETE FROM arch_package_deps');
    this.db.run('DELETE FROM arch_file_layers');
    this.db.run('DELETE FROM arch_file_packages');
    this.db.run('DELETE FROM arch_layers');
    this.db.run('DELETE FROM arch_packages');
  }

  upsertArchPackage(pkg: ArchPackage): void {
    this.db.run(
      `INSERT OR REPLACE INTO arch_packages
        (id, name, path, source, language, manifest_path, version, external_deps, metadata, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        pkg.id, pkg.name, pkg.path, pkg.source,
        pkg.language ?? null, pkg.manifestPath ?? null, pkg.version ?? null,
        pkg.externalDeps ? JSON.stringify(pkg.externalDeps) : null,
        pkg.metadata ? JSON.stringify(pkg.metadata) : null,
        pkg.updatedAt,
      ]
    );
  }

  upsertArchLayer(layer: ArchLayer): void {
    this.db.run(
      `INSERT OR REPLACE INTO arch_layers (id, name, source, patterns, metadata, updated_at)
       VALUES (?,?,?,?,?,?)`,
      [
        layer.id, layer.name, layer.source,
        JSON.stringify(layer.patterns),
        layer.metadata ? JSON.stringify(layer.metadata) : null,
        layer.updatedAt,
      ]
    );
  }

  upsertArchFilePackage(filePath: string, packageId: string): void {
    this.db.run(
      'INSERT OR IGNORE INTO arch_file_packages (file_path, package_id) VALUES (?,?)',
      [filePath, packageId]
    );
  }

  upsertArchFileLayer(filePath: string, layerId: string, confidence: number, matchedPattern: string): void {
    this.db.run(
      `INSERT OR REPLACE INTO arch_file_layers (file_path, layer_id, confidence, matched_pattern)
       VALUES (?,?,?,?)`,
      [filePath, layerId, confidence, matchedPattern]
    );
  }

  upsertArchPackageDep(sourcePkg: string, targetPkg: string, depCount: number, files?: Array<{ from: string; to: string }>): void {
    this.db.run(
      `INSERT OR REPLACE INTO arch_package_deps (source_pkg, target_pkg, dep_count, files)
       VALUES (?,?,?,?)`,
      [sourcePkg, targetPkg, depCount, files ? JSON.stringify(files) : null]
    );
  }

  upsertArchLayerDep(sourceLayer: string, targetLayer: string, depCount: number): void {
    this.db.run(
      `INSERT OR REPLACE INTO arch_layer_deps (source_layer, target_layer, dep_count)
       VALUES (?,?,?)`,
      [sourceLayer, targetLayer, depCount]
    );
  }

  upsertArchCoupling(coupling: ArchCoupling): void {
    this.db.run(
      `INSERT OR REPLACE INTO arch_coupling (package_id, afferent, efferent, instability, updated_at)
       VALUES (?,?,?,?,?)`,
      [coupling.packageId, coupling.afferent, coupling.efferent, coupling.instability, coupling.updatedAt]
    );
  }

  getArchPackages(): ArchPackage[] {
    return this.db.all('SELECT * FROM arch_packages').map((r: any): ArchPackage => ({
      id: r.id,
      name: r.name,
      path: r.path,
      source: r.source,
      language: r.language ?? undefined,
      manifestPath: r.manifest_path ?? undefined,
      version: r.version ?? undefined,
      externalDeps: r.external_deps ? JSON.parse(r.external_deps) : undefined,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      updatedAt: r.updated_at,
    }));
  }

  getArchLayers(): ArchLayer[] {
    return this.db.all('SELECT * FROM arch_layers').map((r: any): ArchLayer => ({
      id: r.id,
      name: r.name,
      source: r.source,
      patterns: JSON.parse(r.patterns),
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      updatedAt: r.updated_at,
    }));
  }

  getArchPackageDeps(): ArchPackageDep[] {
    return this.db.all('SELECT * FROM arch_package_deps').map((r: any): ArchPackageDep => ({
      sourcePkg: r.source_pkg,
      targetPkg: r.target_pkg,
      depCount: r.dep_count,
      files: r.files ? JSON.parse(r.files) : undefined,
    }));
  }

  getArchLayerDeps(): ArchLayerDep[] {
    return this.db.all('SELECT * FROM arch_layer_deps').map((r: any): ArchLayerDep => ({
      sourceLayer: r.source_layer,
      targetLayer: r.target_layer,
      depCount: r.dep_count,
    }));
  }

  getArchCoupling(): ArchCoupling[] {
    return this.db.all('SELECT * FROM arch_coupling').map((r: any): ArchCoupling => ({
      packageId: r.package_id,
      afferent: r.afferent,
      efferent: r.efferent,
      instability: r.instability,
      updatedAt: r.updated_at,
    }));
  }

  getArchStats(): { packages: number; layers: number; packageDeps: number } {
    return {
      packages: this.db.get('SELECT COUNT(*) as c FROM arch_packages')?.c ?? 0,
      layers: this.db.get('SELECT COUNT(*) as c FROM arch_layers')?.c ?? 0,
      packageDeps: this.db.get('SELECT COUNT(*) as c FROM arch_package_deps')?.c ?? 0,
    };
  }

  /**
   * Return file-to-file import relationships by joining edges + nodes.
   * Used by ArchitectureAnalyzer to roll up package-level dependencies.
   */
  getFileImportPairs(): Array<{ sourceFile: string; targetFile: string }> {
    return this.db.all(
      `SELECT DISTINCT n1.file_path as source_file, n2.file_path as target_file
       FROM edges e
       JOIN nodes n1 ON n1.id = e.source
       JOIN nodes n2 ON n2.id = e.target
       WHERE e.kind = 'imports' AND n1.file_path != n2.file_path`
    ).map((r: any) => ({ sourceFile: r.source_file, targetFile: r.target_file }));
  }

  getArchFilePackages(): Array<{ filePath: string; packageId: string }> {
    return this.db.all('SELECT file_path, package_id FROM arch_file_packages')
      .map((r: any) => ({ filePath: r.file_path, packageId: r.package_id }));
  }

  getArchFileLayers(): Array<{ filePath: string; layerId: string; confidence: number; matchedPattern: string }> {
    return this.db.all('SELECT file_path, layer_id, confidence, matched_pattern FROM arch_file_layers')
      .map((r: any) => ({
        filePath: r.file_path,
        layerId: r.layer_id,
        confidence: r.confidence,
        matchedPattern: r.matched_pattern,
      }));
  }

  getArchitectureResult(): {
    packages: ArchPackage[];
    layers: ArchLayer[];
    packageDeps: ArchPackageDep[];
    layerDeps: ArchLayerDep[];
    coupling: ArchCoupling[];
  } {
    return {
      packages: this.getArchPackages(),
      layers: this.getArchLayers(),
      packageDeps: this.getArchPackageDeps(),
      layerDeps: this.getArchLayerDeps(),
      coupling: this.getArchCoupling(),
    };
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  /**
   * Runs `fn` in one transaction. The process stays marked as a writer for the whole call, so
   * another process does not mistake this lock for a stale one.
   */
  transaction<T>(fn: () => T): T {
    const release = this.db.hold();
    try {
      this.db.run('BEGIN');
      try {
        const result = fn();
        this.db.run('COMMIT');
        return result;
      } catch (err) {
        this.db.run('ROLLBACK');
        throw err;
      }
    } finally {
      release();
    }
  }

  private savepointDepth = 0;

  /**
   * Runs `fn` inside the current transaction and undoes only its own writes if it throws.
   * Must be called inside `transaction()`. The name depends only on the nesting depth, so the
   * statements are the same every time and stay in the statement cache.
   */
  savepoint<T>(fn: () => T): T {
    const name = `kg_sp${this.savepointDepth++}`;
    try {
      this.db.run(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        this.db.run(`RELEASE ${name}`);
        return result;
      } catch (err) {
        this.db.run(`ROLLBACK TO ${name}`);
        this.db.run(`RELEASE ${name}`);
        throw err;
      }
    } finally {
      this.savepointDepth--;
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * KiroGraph LanceDB Index
 *
 * ANN vector search backed by @lancedb/lancedb (Apache Arrow / Lance format).
 * The database is persisted to .kirograph/lancedb/ (Lance columnar file storage).
 *
 * Opt-in: set config.semanticEngine = 'lancedb'
 * Required optional dependency (not installed by default):
 *   npm install @lancedb/lancedb
 *
 * Key characteristics:
 *   - Pure JS/WASM, no native compilation required
 *   - Columnar storage (Apache Lance format) — efficient for batch reads/writes
 *   - ANN search via IVF-PQ or HNSW index for sub-linear query time
 *   - Native upsert via mergeInsert (single round-trip, no delete+insert dance)
 */

import * as path from 'path';
import { requireEngine } from '../shared/engines';
import { logDebug, logWarn, logError } from '../errors';
import type { Node } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_DIM  = 768;
const DB_DIR       = 'lancedb';
const TABLE_NAME   = 'kg_nodes';

// ── LanceDBIndex ──────────────────────────────────────────────────────────────

export class LanceDBIndex {
  private db: any    = null;
  private table: any = null;
  private _available = false;
  private dbPath: string;

  constructor(
    private readonly kirographDir: string,
    private readonly dim = DEFAULT_DIM,
  ) {
    this.dbPath = path.join(kirographDir, DB_DIR);
  }

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Load @lancedb/lancedb, open the file-persisted database, and open or create
   * the kg_nodes table. Silent no-op when the optional dep is missing.
   */
  async initialize(): Promise<void> {
    if (this._available) return;

    let lancedb: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      lancedb = requireEngine('@lancedb/lancedb');
    } catch {
      logDebug('LanceDBIndex: @lancedb/lancedb not installed — LanceDB engine unavailable');
      return;
    }

    try {
      this.db = await lancedb.connect(this.dbPath);

      const existingTables: string[] = await this.db.tableNames();
      if (existingTables.includes(TABLE_NAME)) {
        this.table = await this.db.openTable(TABLE_NAME);
      } else {
        // Create table with a dummy record so LanceDB knows the schema, then delete it.
        this.table = await this.db.createTable(TABLE_NAME, [{
          node_id:   '__init__',
          name:      '__init__',
          kind:      'function',
          file_path: '',
          signature: '',
          vector:    new Float32Array(this.dim),
        }]);
        await this.table.delete(`node_id = '__init__'`);
      }

      this._available = true;
      logDebug('LanceDBIndex: ready', { path: this.dbPath, dim: this.dim });
    } catch (err) {
      logError('LanceDBIndex: initialization failed', { error: String(err) });
    }
  }

  /**
   * Insert or update a node using LanceDB's native mergeInsert — a single
   * round-trip that updates the row if node_id exists, inserts it otherwise.
   */
  async upsert(node: Node, embedding: Float32Array): Promise<void> {
    if (!this._available || !this.table) return;

    try {
      await this.table
        .mergeInsert('node_id')
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute([{
          node_id:   node.id,
          name:      node.name,
          kind:      node.kind,
          file_path: node.filePath,
          signature: node.signature ?? '',
          vector:    embedding,
        }]);
    } catch (err) {
      logWarn('LanceDBIndex: upsert failed', { nodeId: node.id, error: String(err) });
    }
  }

  /**
   * Remove a node's record from the index.
   */
  async delete(nodeId: string): Promise<void> {
    if (!this._available || !this.table) return;

    try {
      await this.table.delete(`node_id = '${nodeId.replace(/'/g, "''")}'`);
    } catch (err) {
      logWarn('LanceDBIndex: delete failed', { nodeId, error: String(err) });
    }
  }

  /**
   * ANN vector search. Returns node IDs ordered by cosine similarity (descending).
   */
  async search(queryVec: Float32Array, topN = 10): Promise<string[]> {
    if (!this._available || !this.table) return [];

    try {
      const results = await this.table
        .search(queryVec)
        .distanceType('cosine')
        .limit(topN)
        .toArray();

      return results.map((row: any) => row.node_id as string);
    } catch (err) {
      logWarn('LanceDBIndex: search failed', { error: String(err) });
      return [];
    }
  }

  /** Return all node IDs currently stored in the index. */
  async getEmbeddedNodeIds(): Promise<string[]> {
    if (!this._available || !this.table) return [];
    try {
      const rows = await this.table.query().select(['node_id']).toArray();
      return rows.map((row: any) => row.node_id as string);
    } catch {
      return [];
    }
  }

  /** Number of records currently in the index. */
  async count(): Promise<number> {
    if (!this._available || !this.table) return 0;
    try {
      return await this.table.countRows();
    } catch {
      return 0;
    }
  }
}

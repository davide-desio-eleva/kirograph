/**
 * KiroGraph PGLite Index
 *
 * Hybrid search (full-text + exact vector) backed by @electric-sql/pglite + pgvector.
 * The database is persisted to .kirograph/pglite/ (PGLite's WAL-based file storage).
 *
 * Opt-in: set config.semanticEngine = 'pglite'
 * Required optional dependency (not installed by default):
 *   npm install @electric-sql/pglite
 *
 * Key advantages over other engines:
 *   - Pure WASM, no native compilation required (unlike sqlite-vec)
 *   - Exact nearest-neighbour search (deterministic, unlike ANN approximation)
 *   - Native SQL upsert via ON CONFLICT — no remove+insert dance (unlike Orama)
 *   - HNSW index for fast approximate search when the table grows large
 *   - Full-text search via PostgreSQL tsvector + ts_rank combined in one query
 */

import * as path from 'path';
import { requireEngine } from '../shared/engines';
import { logDebug, logWarn, logError } from '../errors';
import type { Node } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_DIM = 768;
const DB_DIR      = 'pglite';

// Weight for vector score vs full-text score in hybrid ranking (must sum to 1.0)
const VECTOR_WEIGHT = 0.7;
const FTS_WEIGHT    = 0.3;

// ── PGliteIndex ───────────────────────────────────────────────────────────────

export class PGliteIndex {
  private db: any = null;
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
   * Load @electric-sql/pglite, open the file-persisted database, enable pgvector,
   * and apply the schema (idempotent — safe to call on every startup).
   * Silent no-op when the optional dep is missing.
   */
  async initialize(): Promise<void> {
    if (this._available) return;

    let PGlite: any;
    let vector: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = requireEngine('@electric-sql/pglite');
      PGlite = mod.PGlite;
    } catch {
      logDebug('PGliteIndex: @electric-sql/pglite not installed — PGlite engine unavailable');
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vectorMod = requireEngine('@electric-sql/pglite/vector');
      vector = vectorMod.vector ?? vectorMod;
    } catch {
      logDebug('PGliteIndex: @electric-sql/pglite/vector not available — PGlite engine unavailable');
      return;
    }

    try {
      this.db = new PGlite(`file://${this.dbPath}`, { extensions: { vector } });
      await this.db.waitReady;

      await this.db.exec(`
        CREATE EXTENSION IF NOT EXISTS vector;

        CREATE TABLE IF NOT EXISTS kg_nodes (
          node_id   TEXT PRIMARY KEY,
          name      TEXT NOT NULL DEFAULT '',
          kind      TEXT NOT NULL DEFAULT '',
          file_path TEXT NOT NULL DEFAULT '',
          signature TEXT NOT NULL DEFAULT '',
          embedding vector(${this.dim}) NOT NULL
        );

        CREATE INDEX IF NOT EXISTS kg_nodes_hnsw_idx
          ON kg_nodes USING hnsw (embedding vector_cosine_ops);

        CREATE INDEX IF NOT EXISTS kg_nodes_name_idx
          ON kg_nodes USING GIN (to_tsvector('english', name || ' ' || signature));
      `);

      this._available = true;
      logDebug('PGliteIndex: ready', { path: this.dbPath, dim: this.dim });
    } catch (err) {
      logError('PGliteIndex: initialization failed', { error: String(err) });
    }
  }

  /**
   * Insert or update a node's record using PostgreSQL's native ON CONFLICT upsert.
   */
  async upsert(node: Node, embedding: Float32Array): Promise<void> {
    if (!this._available || !this.db) return;

    try {
      await this.db.query(
        `INSERT INTO kg_nodes (node_id, name, kind, file_path, signature, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (node_id) DO UPDATE SET
           name      = EXCLUDED.name,
           kind      = EXCLUDED.kind,
           file_path = EXCLUDED.file_path,
           signature = EXCLUDED.signature,
           embedding = EXCLUDED.embedding`,
        [
          node.id,
          node.name,
          node.kind,
          node.filePath,
          node.signature ?? '',
          `[${Array.from(embedding).join(',')}]`,
        ],
      );
    } catch (err) {
      logWarn('PGliteIndex: upsert failed', { nodeId: node.id, error: String(err) });
    }
  }

  /**
   * Remove a node's record from the index.
   */
  async delete(nodeId: string): Promise<void> {
    if (!this._available || !this.db) return;

    try {
      await this.db.query('DELETE FROM kg_nodes WHERE node_id = $1', [nodeId]);
    } catch (err) {
      logWarn('PGliteIndex: delete failed', { nodeId, error: String(err) });
    }
  }

  /**
   * Hybrid search: combines pgvector cosine distance with PostgreSQL full-text
   * ranking in a single SQL query. Returns node IDs ordered by combined score.
   *
   * Score = VECTOR_WEIGHT × (1 - cosine_distance) + FTS_WEIGHT × ts_rank
   */
  async search(queryText: string, queryVec: Float32Array, topN = 10): Promise<string[]> {
    if (!this._available || !this.db) return [];

    try {
      const vecLiteral = `[${Array.from(queryVec).join(',')}]`;
      const result = await this.db.query(
        `SELECT node_id,
                (${VECTOR_WEIGHT} * (1 - (embedding <=> $1::vector))
                 + ${FTS_WEIGHT}  * ts_rank(
                     to_tsvector('english', name || ' ' || signature),
                     plainto_tsquery('english', $2)
                   )
                ) AS score
         FROM kg_nodes
         ORDER BY score DESC
         LIMIT $3`,
        [vecLiteral, queryText, topN],
      );

      return (result.rows ?? []).map((row: any) => row.node_id as string);
    } catch (err) {
      logWarn('PGliteIndex: search failed', { error: String(err) });
      return [];
    }
  }

  /** Return all node IDs currently stored in the index. */
  async getEmbeddedNodeIds(): Promise<string[]> {
    if (!this._available || !this.db) return [];
    try {
      const result = await this.db.query('SELECT node_id FROM kg_nodes');
      return (result.rows ?? []).map((row: any) => row.node_id as string);
    } catch {
      return [];
    }
  }

  /** Number of documents currently in the index. */
  async count(): Promise<number> {
    if (!this._available || !this.db) return 0;
    try {
      const result = await this.db.query('SELECT COUNT(*) AS count FROM kg_nodes');
      return parseInt(result.rows[0]?.count ?? '0', 10);
    } catch {
      return 0;
    }
  }
}

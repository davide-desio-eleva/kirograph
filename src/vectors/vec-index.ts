/**
 * KiroGraph sqlite-vec ANN Index
 *
 * Opt-in ANN index backed by sqlite-vec (the successor to sqlite-vss).
 * Uses better-sqlite3 to load the sqlite-vec extension into a dedicated
 * .kirograph/vec.db file, keeping it separate from the main node-sqlite3-wasm
 * database to avoid WAL-mode conflicts.
 *
 * Required optional dependencies (not installed by default):
 *   npm install better-sqlite3 sqlite-vec
 *
 * If either package is missing, VecIndex silently marks itself unavailable
 * and VectorManager falls back to in-process cosine search.
 */

import * as path from 'path';
import { logDebug, logWarn, logError } from '../errors';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_DIM = 768;

// ── VecIndex ──────────────────────────────────────────────────────────────────

export class VecIndex {
  private db: any = null;
  private _available = false;
  private dim: number;

  constructor(
    private readonly kirographDir: string,
    dim = DEFAULT_DIM,
  ) {
    this.dim = dim;
  }

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Load better-sqlite3 + sqlite-vec and create the vec schema.
   * No-op and silent when optional deps are missing.
   */
  async initialize(): Promise<void> {
    if (this._available) return;

    const dbPath = path.join(this.kirographDir, 'vec.db');

    let BetterSQLite: any;
    let sqliteVec: any;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      BetterSQLite = require('better-sqlite3');
    } catch {
      logDebug('VecIndex: better-sqlite3 not installed — sqlite-vec unavailable');
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sqliteVec = require('sqlite-vec');
    } catch {
      logDebug('VecIndex: sqlite-vec not installed — falling back to in-process cosine search');
      return;
    }

    try {
      this.db = new BetterSQLite(dbPath);
      sqliteVec.load(this.db);

      // Drop stale schema if vec_nodes_map is missing the vec_rowid column
      // (legacy schema used rowid AUTOINCREMENT + node_id; new schema uses node_id PK + vec_rowid)
      const mapInfo: any[] = this.db.pragma('table_info(vec_nodes_map)');
      const hasVecRowid = mapInfo.some((col: any) => col.name === 'vec_rowid');
      if (mapInfo.length > 0 && !hasVecRowid) {
        logDebug('VecIndex: stale schema detected, rebuilding vec.db');
        this.db.exec(`
          DROP TABLE IF EXISTS vec_nodes_map;
          DROP TABLE IF EXISTS vec_nodes;
        `);
      }

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_nodes
          USING vec0(embedding float[${this.dim}]);
        CREATE TABLE IF NOT EXISTS vec_nodes_map (
          node_id TEXT PRIMARY KEY NOT NULL,
          vec_rowid INTEGER NOT NULL
        );
      `);

      this._available = true;
      logDebug('VecIndex: initialized', { dbPath, dim: this.dim });
    } catch (err) {
      logError('VecIndex: initialization failed', { error: String(err) });
      this._available = false;
      if (this.db) {
        try { this.db.close(); } catch { /* ignore */ }
        this.db = null;
      }
    }
  }

  /**
   * Insert or update the embedding for a node.
   * We let vec_nodes auto-assign its rowid (avoiding the SQLITE_INTEGER type
   * mismatch that occurs when passing explicit JS number rowids to vec0).
   * The auto-assigned rowid is stored in vec_nodes_map for later lookup.
   * vec0 tables don't support UPDATE, so updates are a DELETE + INSERT pair.
   */
  upsert(nodeId: string, embedding: Float32Array): void {
    if (!this._available || !this.db) return;

    try {
      const existing = this.db
        .prepare('SELECT vec_rowid FROM vec_nodes_map WHERE node_id = ?')
        .get(nodeId) as { vec_rowid: number } | undefined;

      if (existing) {
        // Remove old vector, re-insert with a fresh auto-assigned rowid
        this.db.prepare('DELETE FROM vec_nodes WHERE rowid = ?').run(existing.vec_rowid);
        const result = this.db.prepare('INSERT INTO vec_nodes(embedding) VALUES (?)').run(embedding);
        this.db.prepare('UPDATE vec_nodes_map SET vec_rowid = ? WHERE node_id = ?')
          .run(result.lastInsertRowid, nodeId);
      } else {
        // First time: insert vector, then record the rowid sqlite-vec chose
        const result = this.db.prepare('INSERT INTO vec_nodes(embedding) VALUES (?)').run(embedding);
        this.db.prepare('INSERT INTO vec_nodes_map(node_id, vec_rowid) VALUES (?, ?)')
          .run(nodeId, result.lastInsertRowid);
      }
    } catch (err) {
      logWarn('VecIndex: upsert failed', { nodeId, error: String(err) });
    }
  }

  /**
   * Remove a node's embedding from the index.
   * Called explicitly when a node is deleted; stale entries are also filtered
   * harmlessly in search() since GraphDatabase.getNode() will return null.
   */
  delete(nodeId: string): void {
    if (!this._available || !this.db) return;

    try {
      const existing = this.db
        .prepare('SELECT vec_rowid FROM vec_nodes_map WHERE node_id = ?')
        .get(nodeId) as { vec_rowid: number } | undefined;

      if (existing) {
        this.db.prepare('DELETE FROM vec_nodes WHERE rowid = ?').run(existing.vec_rowid);
        this.db.prepare('DELETE FROM vec_nodes_map WHERE node_id = ?').run(nodeId);
      }
    } catch (err) {
      logWarn('VecIndex: delete failed', { nodeId, error: String(err) });
    }
  }

  /**
   * ANN search: returns node IDs ordered by ascending distance.
   * Uses sqlite-vec KNN syntax: `WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
   */
  search(queryVec: Float32Array, topN = 10): string[] {
    if (!this._available || !this.db) return [];

    try {
      const rows = this.db.prepare(`
        SELECT m.node_id, v.distance
        FROM vec_nodes v
        JOIN vec_nodes_map m ON m.vec_rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
        ORDER BY v.distance
      `).all(queryVec, topN);

      return rows.map((r: any) => r.node_id as string);
    } catch (err) {
      logWarn('VecIndex: search failed', { error: String(err) });
      return [];
    }
  }

  /** Returns the number of entries currently in the vec index. */
  count(): number {
    if (!this._available || !this.db) return 0;
    try {
      const row = this.db.prepare('SELECT COUNT(*) as c FROM vec_nodes_map').get();
      return row ? (row.c as number) : 0;
    } catch {
      return 0;
    }
  }

  close(): void {
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
      this._available = false;
    }
  }
}

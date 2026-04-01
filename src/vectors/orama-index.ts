/**
 * KiroGraph Orama Index
 *
 * Hybrid search (full-text + vector) backed by @orama/orama.
 * The index is persisted to .kirograph/orama.json via @orama/plugin-data-persistence.
 *
 * Opt-in: set config.semanticEngine = 'orama'
 * Required optional dependencies (not installed by default):
 *   npm install @orama/orama @orama/plugin-data-persistence
 *
 * Key advantage over cosine/sqlite-vec: Orama combines full-text relevance and
 * vector similarity in a single hybrid query, producing higher-quality results
 * than running the two searches separately and merging by priority.
 */

import * as path from 'path';
import * as fs from 'fs';
import { logDebug, logWarn, logError } from '../errors';
import type { Node } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_DIM = 768;
const INDEX_FILE  = 'orama.json';

// ── OramaIndex ────────────────────────────────────────────────────────────────

export class OramaIndex {
  private db: any = null;
  private _available = false;
  private indexPath: string;

  // Lazily-loaded Orama functions
  private orama: {
    create: Function;
    insert: Function;
    remove: Function;
    search: Function;
    count: Function;
  } | null = null;
  private persistence: {
    persistToFile: Function;
    restoreFromFile: Function;
  } | null = null;

  constructor(
    private readonly kirographDir: string,
    private readonly dim = DEFAULT_DIM,
  ) {
    this.indexPath = path.join(kirographDir, INDEX_FILE);
  }

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Load @orama/orama + @orama/plugin-data-persistence, then either restore
   * the persisted index from orama.json or create a fresh one.
   * Silent no-op when optional deps are missing.
   */
  async initialize(): Promise<void> {
    if (this._available) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const oramaModule = require('@orama/orama');
      this.orama = {
        create:  oramaModule.create,
        insert:  oramaModule.insert,
        remove:  oramaModule.remove,
        search:  oramaModule.search,
        count:   oramaModule.count,
      };
    } catch {
      logDebug('OramaIndex: @orama/orama not installed — Orama engine unavailable');
      return;
    }

    try {
      // persistToFile / restoreFromFile live in the /server subpath (Node.js only)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const persistModule = require('@orama/plugin-data-persistence/server');
      this.persistence = {
        persistToFile:   persistModule.persistToFile,
        restoreFromFile: persistModule.restoreFromFile,
      };
    } catch {
      logDebug('OramaIndex: @orama/plugin-data-persistence not installed — Orama engine unavailable');
      return;
    }

    try {
      if (fs.existsSync(this.indexPath)) {
        this.db = await this.persistence!.restoreFromFile('json', this.indexPath);
        logDebug('OramaIndex: restored from disk', { path: this.indexPath });
      } else {
        this.db = await this.orama!.create({
          schema: {
            nodeId:    'enum',    // exact-match filterable field (not full-text indexed)
            name:      'string',
            kind:      'string',
            filePath:  'string',
            signature: 'string',
            embedding: `vector[${this.dim}]`,
          },
        });
        logDebug('OramaIndex: created fresh index', { dim: this.dim });
      }
      this._available = true;
    } catch (err) {
      logError('OramaIndex: initialization failed', { error: String(err) });
    }
  }

  /**
   * Insert or replace a node's document in the index.
   * Orama has no native upsert, so we remove any existing doc first.
   */
  async upsert(node: Node, embedding: Float32Array): Promise<void> {
    if (!this._available || !this.db) return;

    try {
      // Remove existing document if present (exact match on enum field — no full-text)
      const existing = await this.orama!.search(this.db, {
        term: '',
        where: { nodeId: { eq: node.id } },
        limit: 1,
      });
      if (existing?.hits?.length > 0) {
        for (const hit of existing.hits) {
          await this.orama!.remove(this.db, hit.id);
        }
      }

      await this.orama!.insert(this.db, {
        nodeId:    node.id,
        name:      node.name,
        kind:      node.kind,
        filePath:  node.filePath,
        signature: node.signature ?? '',
        embedding: Array.from(embedding),
      });
    } catch (err) {
      logWarn('OramaIndex: upsert failed', { nodeId: node.id, error: String(err) });
    }
  }

  /**
   * Remove a node's document from the index.
   */
  async delete(nodeId: string): Promise<void> {
    if (!this._available || !this.db) return;

    try {
      const existing = await this.orama!.search(this.db, {
        term: '',
        where: { nodeId: { eq: nodeId } },
        limit: 1,
      });
      if (existing?.hits?.length > 0) {
        for (const hit of existing.hits) {
          await this.orama!.remove(this.db, hit.id);
        }
      }
    } catch (err) {
      logWarn('OramaIndex: delete failed', { nodeId, error: String(err) });
    }
  }

  /**
   * Hybrid search: combines full-text relevance on name/kind/filePath/signature
   * with vector similarity on the embedding field.
   * Returns node IDs ordered by Orama's combined score (best first).
   */
  async search(queryText: string, queryVec: Float32Array, topN = 10): Promise<string[]> {
    if (!this._available || !this.db) return [];

    try {
      const results = await this.orama!.search(this.db, {
        term:  queryText,
        mode:  'hybrid',
        vector: {
          value:    Array.from(queryVec),
          property: 'embedding',
        },
        limit:      topN,
        similarity: 0.3,
      });

      return (results?.hits ?? []).map((hit: any) => hit.document.nodeId as string);
    } catch (err) {
      logWarn('OramaIndex: search failed', { error: String(err) });
      return [];
    }
  }

  /** Persist the in-memory index to .kirograph/orama.json. */
  async save(): Promise<void> {
    if (!this._available || !this.db || !this.persistence) return;

    try {
      await this.persistence.persistToFile(this.db, 'json', this.indexPath);
      logDebug('OramaIndex: saved to disk', { path: this.indexPath });
    } catch (err) {
      logWarn('OramaIndex: save failed', { error: String(err) });
    }
  }

  /** Return all node IDs currently stored in the index. */
  async getEmbeddedNodeIds(): Promise<string[]> {
    if (!this._available || !this.db) return [];
    try {
      const results = await this.orama!.search(this.db, { term: '', limit: 1_000_000, includeVectors: false });
      return (results?.hits ?? []).map((hit: any) => hit.document.nodeId as string);
    } catch {
      return [];
    }
  }

  /** Number of documents currently in the index. */
  async count(): Promise<number> {
    if (!this._available || !this.db) return 0;
    try {
      return await this.orama!.count(this.db);
    } catch {
      return 0;
    }
  }
}

/**
 * KiroGraph Qdrant Index
 *
 * ANN vector search backed by Qdrant running in embedded mode.
 * The engine spawns the Qdrant binary as a managed child process, persisting
 * data to .kirograph/qdrant/ via QDRANT__STORAGE__STORAGE_PATH.
 *
 * Opt-in: set config.semanticEngine = 'qdrant'
 * Required optional dependency (not installed by default):
 *   npm install qdrant-local
 *
 * Uses @qdrant/qdrant-js (QdrantClient) for the REST API — available as a
 * transitive dependency of qdrant-local.
 *
 * Key characteristics:
 *   - Full Qdrant feature set: filtering, payload indexing, HNSW ANN search
 *   - Data persisted to disk across restarts
 *   - Async startup check via /readyz (no blocking sleep)
 *   - Cosine distance metric
 *   - Node IDs stored in payload; deterministic UUIDs used as Qdrant point IDs
 */

import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import * as fs from 'fs';
import { logDebug, logWarn, logError } from '../errors';
import type { Node } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_DIM  = 768;
const STORAGE_DIR  = 'qdrant';
const COLLECTION   = 'kg_nodes';
const READYZ_TIMEOUT_MS  = 10_000;
const READYZ_POLL_MS     = 100;
const SERVER_STATE_FILE  = 'qdrant-server.json';
export const DASHBOARD_SUBDIR = 'qdrant/dashboard'; // relative to kirographDir

interface ServerState { pid: number; port: number; }

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive a deterministic UUID from an arbitrary string (e.g. "function:abc123"). */
function toUuid(nodeId: string): string {
  const h = crypto.createHash('md5').update(nodeId).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

/** Find a random free TCP port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer().listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Poll GET http://127.0.0.1:{port}/readyz until 200 or timeout. */
function waitReady(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function check() {
      const req = http.get(`http://127.0.0.1:${port}/readyz`, res => {
        if (res.statusCode === 200) return resolve();
        scheduleRetry();
      });
      req.on('error', scheduleRetry);
      req.setTimeout(200, () => { req.destroy(); scheduleRetry(); });
    }

    function scheduleRetry() {
      if (Date.now() >= deadline) return reject(new Error('Qdrant readyz timeout'));
      setTimeout(check, READYZ_POLL_MS);
    }

    check();
  });
}

// ── QdrantIndex ───────────────────────────────────────────────────────────────

export class QdrantIndex {
  private client: any       = null;
  private child:  any       = null;
  private _available        = false;
  private _ownedProcess     = false;
  private storagePath:      string;
  private stateFile:        string;

  constructor(
    private readonly kirographDir: string,
    private readonly dim = DEFAULT_DIM,
  ) {
    this.storagePath = path.join(kirographDir, STORAGE_DIR);
    this.stateFile   = path.join(kirographDir, SERVER_STATE_FILE);
  }

  isAvailable(): boolean { return this._available; }

  private readState(): ServerState | null {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as ServerState; }
    catch { return null; }
  }
  private writeState(s: ServerState): void {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(s)); } catch { /* ignore */ }
  }
  private clearState(): void {
    try { fs.unlinkSync(this.stateFile); } catch { /* ignore */ }
  }
  private isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  /** The HTTP port of the running server, or null if not available. */
  getPort(): number | null {
    if (this._available) {
      const s = this.readState();
      return s?.port ?? null;
    }
    const s = this.readState();
    if (s && this.isProcessAlive(s.pid)) return s.port;
    return null;
  }

  /**
   * Locate the Qdrant binary (via qdrant-local), spawn it with a project-scoped
   * storage path, wait until /readyz responds, then ensure the collection exists.
   * Silent no-op when qdrant-local is not installed.
   */
  async initialize(): Promise<void> {
    if (this._available) return;

    // ── 1. Locate binary via qdrant-local ─────────────────────────────────────
    let binPath: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkgPath = require.resolve('qdrant-local/package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const { directory, name } = pkg.qdrantBinary as { directory: string; name: string };
      const exeName = ['win32', 'cygwin'].includes(process.platform) ? `${name}.exe` : name;
      binPath = path.join(path.dirname(pkgPath), directory, exeName);
      if (!fs.existsSync(binPath)) {
        logDebug('QdrantIndex: qdrant binary not found — run: npm install qdrant-local');
        return;
      }
    } catch {
      logDebug('QdrantIndex: qdrant-local not installed — Qdrant engine unavailable');
      return;
    }

    // ── 2. Load @qdrant/qdrant-js client ──────────────────────────────────────
    let QdrantClient: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      QdrantClient = require('@qdrant/qdrant-js').QdrantClient;
    } catch {
      logDebug('QdrantIndex: @qdrant/qdrant-js not available — Qdrant engine unavailable');
      return;
    }

    // ── 3. Try to reuse an already-running server ─────────────────────────────
    const saved = this.readState();
    if (saved) {
      if (this.isProcessAlive(saved.pid)) {
        try {
          await waitReady(saved.port, 3_000);
          this.client = new QdrantClient({ host: '127.0.0.1', port: saved.port, checkCompatibility: false });
          await this.ensureCollection();
          this._available    = true;
          this._ownedProcess = false;
          logDebug('QdrantIndex: reused running server', { pid: saved.pid, port: saved.port });
          return;
        } catch {
          // Stale — kill and respawn
          try { process.kill(saved.pid, 'SIGKILL'); } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 300));
        }
      }
      this.clearState();
    }

    // ── 4. Spawn Qdrant binary ────────────────────────────────────────────────
    try {
      fs.mkdirSync(this.storagePath, { recursive: true });

      const port = await getFreePort();

      // Auto-serve dashboard if UI files are present
      const dashboardDir = path.join(this.kirographDir, DASHBOARD_SUBDIR);
      const staticEnv: Record<string, string> = fs.existsSync(dashboardDir)
        ? { QDRANT__SERVICE__STATIC_CONTENT_DIR: dashboardDir }
        : {};

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawn } = require('child_process');
      this.child = spawn(binPath, [], {
        stdio: 'ignore',
        env: {
          ...process.env,
          QDRANT__SERVICE__HTTP_PORT:    String(port),
          QDRANT__STORAGE__STORAGE_PATH: this.storagePath,
          QDRANT__LOG_LEVEL:             'WARN',
          ...staticEnv,
        },
      });

      this.child.unref();

      // ── 5. Wait until Qdrant is ready ──────────────────────────────────────
      await waitReady(port, READYZ_TIMEOUT_MS);

      this.writeState({ pid: this.child.pid, port });

      this.client = new QdrantClient({ host: '127.0.0.1', port, checkCompatibility: false });

      // ── 6. Ensure collection exists ────────────────────────────────────────
      await this.ensureCollection();

      this._available    = true;
      this._ownedProcess = true;
      logDebug('QdrantIndex: ready', { storagePath: this.storagePath, port, dim: this.dim });
    } catch (err) {
      logError('QdrantIndex: initialization failed', { error: String(err) });
    }
  }

  private async ensureCollection(): Promise<void> {
    const existsResult = await this.client.collectionExists(COLLECTION);
    const exists = typeof existsResult === 'object' ? existsResult.exists : existsResult;
    if (!exists) {
      await this.client.createCollection(COLLECTION, {
        vectors: { size: this.dim, distance: 'Cosine' },
      });
    }
  }

  /**
   * Upsert a node's embedding with retry logic.
   * Qdrant's upsert is idempotent — the same point ID is overwritten if it already exists.
   * Retries up to 3 times with exponential backoff to handle transient connection failures.
   */
  async upsert(node: Node, embedding: Float32Array): Promise<void> {
    if (!this._available || !this.client) return;

    const point = {
      id:      toUuid(node.id),
      vector:  Array.from(embedding),
      payload: {
        node_id:   node.id,
        name:      node.name,
        kind:      node.kind,
        file_path: node.filePath,
        signature: node.signature ?? '',
      },
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.client.upsert(COLLECTION, { points: [point] });
        return;
      } catch (err) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        } else {
          logWarn('QdrantIndex: upsert failed', { nodeId: node.id, error: String(err) });
        }
      }
    }
  }

  /**
   * Batch upsert multiple nodes' embeddings in a single HTTP request.
   * Much more efficient than individual upserts for bulk indexing.
   * Retries up to 3 times with exponential backoff.
   */
  async bulkUpsert(nodes: Node[], embeddings: Float32Array[]): Promise<void> {
    if (!this._available || !this.client) return;
    if (nodes.length === 0) return;

    const points = nodes.map((node, i) => ({
      id:      toUuid(node.id),
      vector:  Array.from(embeddings[i]!),
      payload: {
        node_id:   node.id,
        name:      node.name,
        kind:      node.kind,
        file_path: node.filePath,
        signature: node.signature ?? '',
      },
    }));

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.client.upsert(COLLECTION, { points });
        return;
      } catch (err) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        } else {
          logWarn('QdrantIndex: bulk upsert failed', { count: nodes.length, error: String(err) });
        }
      }
    }
  }

  /**
   * Remove a point from the collection with retry logic.
   */
  async delete(nodeId: string): Promise<void> {
    if (!this._available || !this.client) return;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.client.delete(COLLECTION, { points: [toUuid(nodeId)] });
        return;
      } catch (err) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        } else {
          logWarn('QdrantIndex: delete failed', { nodeId, error: String(err) });
        }
      }
    }
  }

  /**
   * ANN vector search. Returns node IDs ordered by cosine similarity (descending).
   */
  async search(queryVec: Float32Array, topN = 10): Promise<string[]> {
    if (!this._available || !this.client) return [];

    try {
      const results = await this.client.search(COLLECTION, {
        vector:       Array.from(queryVec),
        limit:        topN,
        with_payload: ['node_id'],
      });
      return results.map((r: any) => r.payload.node_id as string);
    } catch (err) {
      logWarn('QdrantIndex: search failed', { error: String(err) });
      return [];
    }
  }

  /**
   * Return all node IDs currently stored in the collection (paginated scroll).
   */
  async getEmbeddedNodeIds(): Promise<string[]> {
    if (!this._available || !this.client) return [];

    const ids: string[] = [];
    let offset: string | number | null = null;

    try {
      do {
        const page: { points: any[]; next_page_offset: string | number | null } =
          await this.client.scroll(COLLECTION, {
            with_payload: ['node_id'],
            with_vector:  false,
            limit:        1000,
            ...(offset !== null ? { offset } : {}),
          });
        for (const pt of page.points) {
          if (pt.payload?.node_id) ids.push(pt.payload.node_id as string);
        }
        offset = page.next_page_offset ?? null;
      } while (offset !== null);
    } catch {
      return ids;
    }

    return ids;
  }

  /** Disconnect the client. The Qdrant server keeps running as a daemon. */
  close(): void {
    this._available = false;
    this.child  = null;
    this.client = null;
  }

  /** Number of points currently in the collection. */
  async count(): Promise<number> {
    if (!this._available || !this.client) return 0;
    try {
      const result = await this.client.count(COLLECTION, { exact: true });
      return result.count;
    } catch {
      return 0;
    }
  }
}

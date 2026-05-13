/**
 * KiroGraph Typesense Index
 *
 * ANN vector search backed by Typesense running in embedded mode.
 * The engine downloads the Typesense binary on first use (cached at
 * ~/.kirograph/bin/), then spawns it as a managed child process persisting
 * data to .kirograph/typesense/.
 *
 * Opt-in: set config.semanticEngine = 'typesense'
 * Required optional dependency (not installed by default):
 *   npm install typesense
 *
 * Key characteristics:
 *   - HNSW ANN vector search with cosine distance
 *   - Binary auto-downloaded on first use (~37MB, cached globally)
 *   - No separate server setup required
 *   - Async startup check via /health
 *   - Node IDs used directly as Typesense document IDs (colon sanitised)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import { homedir } from 'os';
import { logDebug, logWarn, logError } from '../errors';
import type { Node } from '../types';
import { extractBinaryFromTarGz } from '../bin/installer/archive';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_DIM        = 768;
const STORAGE_DIR        = 'typesense';
const COLLECTION         = 'kg_nodes';
const API_KEY            = 'kirograph-local';
const TYPESENSE_VERSION  = '28.0';
const BIN_CACHE_DIR      = path.join(homedir(), '.kirograph', 'bin');
const HEALTH_TIMEOUT_MS  = 60_000;
const HEALTH_POLL_MS     = 200;
const SERVER_STATE_FILE  = 'typesense-server.json';

interface ServerState { pid: number; apiPort: number; peeringPort: number; }

// ── Binary management ─────────────────────────────────────────────────────────

function getBinaryUrl(): string | null {
  const v = TYPESENSE_VERSION;
  const { platform, arch } = process;

  if (platform === 'darwin') {
    const a = arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64';
    return `https://dl.typesense.org/releases/${v}/typesense-server-${v}-${a}.tar.gz`;
  }
  if (platform === 'linux') {
    const a = arch === 'arm64' ? 'linux-arm64' : 'linux-amd64';
    return `https://dl.typesense.org/releases/${v}/typesense-server-${v}-${a}.tar.gz`;
  }
  return null; // Windows not supported via auto-download
}

function getBinPath(): string {
  return path.join(BIN_CACHE_DIR, `typesense-server-${TYPESENSE_VERSION}`);
}

/**
 * Download the Typesense binary tarball and extract it using the shared archive utility.
 * The binary is cached at ~/.kirograph/bin/typesense-server-{version}.
 */
async function downloadBinary(url: string, destPath: string): Promise<void> {
  fs.mkdirSync(BIN_CACHE_DIR, { recursive: true });
  await extractBinaryFromTarGz(url, 'typesense-server', destPath);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Sanitise node_id for use as a Typesense document ID (no colons allowed). */
function toDocId(nodeId: string): string {
  return nodeId.replace(/:/g, '__');
}

/** Find two random free TCP ports. */
function getFreePorts(count: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const ports: number[] = [];
    const servers: ReturnType<typeof http.createServer>[] = [];
    let done = 0;
    for (let i = 0; i < count; i++) {
      const srv = http.createServer();
      servers.push(srv);
      srv.listen(0, '127.0.0.1', () => {
        ports.push((srv.address() as { port: number }).port);
        done++;
        if (done === count) {
          // Close all servers first, then resolve
          let closed = 0;
          for (const s of servers) s.close(() => { if (++closed === count) resolve(ports); });
        }
      });
      srv.on('error', reject);
    }
  });
}

/** Poll GET http://127.0.0.1:{port}/health until ok:true or timeout. */
function waitReady(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function check() {
      const req = http.get(`http://127.0.0.1:${port}/health`, res => {
        let body = '';
        res.on('data', (c: string) => body += c);
        res.on('end', () => {
          try {
            if (JSON.parse(body).ok === true) return resolve();
          } catch { /* ignore */ }
          scheduleRetry();
        });
      });
      req.on('error', scheduleRetry);
      req.setTimeout(300, () => { req.destroy(); scheduleRetry(); });
    }

    function scheduleRetry() {
      if (Date.now() >= deadline) return reject(new Error('Typesense health timeout'));
      setTimeout(check, HEALTH_POLL_MS);
    }

    check();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const _silentLogger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, info: () => {}, trace: () => {}, setLevel: () => {} };

function makeClientConfig(port: number) {
  return {
    nodes: [{ host: '127.0.0.1', port, protocol: 'http' }],
    apiKey: API_KEY,
    connectionTimeoutSeconds: 10,
    retryIntervalSeconds: 0.1,
    numRetries: 3,
    logger: _silentLogger,
    logLevel: 'silent' as const,
  };
}

// ── TypesenseIndex ────────────────────────────────────────────────────────────

export class TypesenseIndex {
  private client:      any    = null;
  private child:       any    = null;
  private _available          = false;
  private _ownedProcess       = false;   // true only when we spawned the child ourselves
  private _failReason: string | null = null;
  private storagePath: string;
  private stateFile:   string;

  constructor(
    private readonly kirographDir: string,
    private readonly dim = DEFAULT_DIM,
  ) {
    this.storagePath = path.join(kirographDir, STORAGE_DIR);
    this.stateFile   = path.join(kirographDir, SERVER_STATE_FILE);
  }

  private readState(): ServerState | null {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as ServerState;
    } catch { return null; }
  }

  private writeState(state: ServerState): void {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(state)); } catch { /* ignore */ }
  }

  private clearState(): void {
    try { fs.unlinkSync(this.stateFile); } catch { /* ignore */ }
  }

  private isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  isAvailable(): boolean {
    return this._available;
  }

  getFailReason(): string | null {
    return this._failReason;
  }

  /**
   * Download the Typesense binary if needed, spawn it with a project-scoped
   * data directory, wait until /health responds, then ensure the collection
   * exists. Silent no-op when `typesense` npm package is not installed.
   */
  async initialize(): Promise<void> {
    if (this._available) return;

    // ── 1. Load typesense client ───────────────────────────────────────────────
    let TypesenseClient: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      TypesenseClient = require('typesense').Client;
    } catch {
      logDebug('TypesenseIndex: typesense not installed — Typesense engine unavailable');
      return;
    }

    // ── 2. Locate or download binary ──────────────────────────────────────────
    const binPath = getBinPath();
    if (!fs.existsSync(binPath)) {
      const url = getBinaryUrl();
      if (!url) {
        logDebug('TypesenseIndex: no Typesense binary available for this platform');
        this._failReason = 'Typesense binary not available for this platform';
        return;
      }
      process.stdout.write(`  Downloading Typesense ${TYPESENSE_VERSION} binary (~37 MB, cached for future use)…\n`);
      try {
        await downloadBinary(url, binPath);
        process.stdout.write(`  Typesense binary ready.\n`);
      } catch (err) {
        process.stdout.write(`  Typesense binary download failed: ${String(err)}\n`);
        logError('TypesenseIndex: binary download failed', { error: String(err) });
        this._failReason = `binary download failed: ${String(err)}`;
        return;
      }
    }

    // ── 3. Try to reuse an already-running server ─────────────────────────────
    const saved = this.readState();
    if (saved) {
      const alive = this.isProcessAlive(saved.pid);
      if (alive) {
        try {
          await waitReady(saved.apiPort, 5_000);
          // Reconnect to the existing process
          this.client = new TypesenseClient(makeClientConfig(saved.apiPort));
          await this.ensureCollection();
          this._available    = true;
          this._ownedProcess = false;
          logDebug('TypesenseIndex: reused running server', { pid: saved.pid, port: saved.apiPort });
          return;
        } catch {
          // Process alive but not healthy — kill it so we can acquire the lock
          logDebug('TypesenseIndex: stale process detected, killing', { pid: saved.pid });
          try { process.kill(saved.pid, 'SIGKILL'); } catch { /* ignore */ }
          // Wait briefly for the lock to be released
          await new Promise(r => setTimeout(r, 500));
        }
      }
      this.clearState();
    }

    // ── 4. Spawn a new Typesense process ──────────────────────────────────────
    let startupLog = '';
    try {
      fs.mkdirSync(this.storagePath, { recursive: true });

      // Remove stale RocksDB lock files that prevent a new process from starting
      for (const sub of ['db', 'meta']) {
        const lockFile = path.join(this.storagePath, sub, 'LOCK');
        try { fs.unlinkSync(lockFile); } catch { /* doesn't exist, fine */ }
      }

      const [apiPort, peeringPort] = await getFreePorts(2);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawn } = require('child_process');
      this.child = spawn(binPath, [
        `--data-dir=${this.storagePath}`,
        `--api-key=${API_KEY}`,
        `--api-port=${apiPort}`,
        `--peering-port=${peeringPort}`,
        '--enable-cors',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      const onLog = (chunk: Buffer) => { startupLog += chunk.toString('utf8'); };
      this.child.stdout?.on('data', onLog);
      this.child.stderr?.on('data', onLog);
      this.child.unref();

      // Only kill the server on user interruption, not on normal command exit
      // (we want the server to persist as a background daemon across commands)
      // ── 5. Wait until ready ────────────────────────────────────────────────
      process.stdout.write(`  Starting Typesense server on port ${apiPort}…\n`);

      const exitPromise = new Promise<never>((_, reject) => {
        this.child.once('exit', (code: number | null, signal: string | null) => {
          this.clearState();
          const out = startupLog.trim();
          const detail = out ? `\n${out}` : '';
          reject(new Error(`Typesense process exited (code=${code}, signal=${signal})${detail}`));
        });
      });

      await Promise.race([waitReady(apiPort, HEALTH_TIMEOUT_MS), exitPromise]);

      // Detach stdout/stderr so the pipe handles don't keep the parent event
      // loop alive after the command finishes.
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();

      process.stdout.write(`  Typesense server ready.\n`);

      this.writeState({ pid: this.child.pid, apiPort, peeringPort });

      this.client = new TypesenseClient(makeClientConfig(apiPort));

      await this.ensureCollection();

      this._available    = true;
      this._ownedProcess = true;
      logDebug('TypesenseIndex: ready', { storagePath: this.storagePath, port: apiPort, dim: this.dim });
    } catch (err) {
      const msg = String(err);
      const log = (startupLog ?? '').trim();
      const detail = log ? `\n  Server output:\n${log.split('\n').map(l => `    ${l}`).join('\n')}` : '';
      process.stdout.write(`  Typesense initialization failed: ${msg}${detail}\n`);
      logError('TypesenseIndex: initialization failed', { error: msg });
      this._failReason = msg;
      try { this.child?.kill(); } catch { /* ignore */ }
    }
  }

  private async ensureCollection(): Promise<void> {
    const exists = await this.client.collections(COLLECTION).exists();
    if (!exists) {
      await this.client.collections().create({
        name:   COLLECTION,
        fields: [
          { name: 'node_id',   type: 'string' },
          { name: 'name',      type: 'string' },
          { name: 'kind',      type: 'string', facet: true },
          { name: 'file_path', type: 'string' },
          { name: 'signature', type: 'string' },
          { name: 'vector',    type: 'float[]', num_dim: this.dim },
        ],
      });
    }
  }

  /**
   * Insert or update a node's embedding. Typesense's upsert overwrites the
   * document if the `id` already exists.
   */
  async upsert(node: Node, embedding: Float32Array): Promise<void> {
    if (!this._available || !this.client) return;

    try {
      await this.client.collections(COLLECTION).documents().upsert({
        id:        toDocId(node.id),
        node_id:   node.id,
        name:      node.name,
        kind:      node.kind,
        file_path: node.filePath,
        signature: node.signature ?? '',
        vector:    Array.from(embedding),
      });
    } catch (err) {
      logWarn('TypesenseIndex: upsert failed', { nodeId: node.id, error: String(err) });
    }
  }

  /**
   * Bulk upsert a batch of nodes. Uses Typesense's import endpoint (single
   * HTTP request per batch) to avoid connection churn on large codebases.
   */
  async bulkUpsert(nodes: Node[], embeddings: Float32Array[]): Promise<void> {
    if (!this._available || !this.client || nodes.length === 0) return;

    const docs = nodes.map((node, i) => ({
      id:        toDocId(node.id),
      node_id:   node.id,
      name:      node.name,
      kind:      node.kind,
      file_path: node.filePath,
      signature: node.signature ?? '',
      vector:    Array.from(embeddings[i]!),
    }));

    try {
      await this.client.collections(COLLECTION).documents().import(docs, { action: 'upsert' });
    } catch (err) {
      logWarn('TypesenseIndex: bulkUpsert failed', { count: docs.length, error: String(err) });
    }
  }

  /**
   * Remove a document from the collection.
   */
  async delete(nodeId: string): Promise<void> {
    if (!this._available || !this.client) return;

    try {
      await this.client.collections(COLLECTION).documents(toDocId(nodeId)).delete();
    } catch (err) {
      const msg = String(err);
      if (!msg.includes('404') && !msg.includes('ObjectNotFound')) {
        logWarn('TypesenseIndex: delete failed', { nodeId, error: msg });
      }
    }
  }

  /**
   * ANN vector search. Returns node IDs ordered by cosine similarity (descending).
   */
  async search(queryVec: Float32Array, topN = 10): Promise<string[]> {
    if (!this._available || !this.client) return [];

    try {
      // Use multiSearch (POST) to avoid the 4000-char GET query string limit
      // that would be exceeded by inlining 768-dimensional vectors.
      const result = await this.client.multiSearch.perform(
        {
          searches: [{
            collection:     COLLECTION,
            q:              '*',
            vector_query:   `vector:([${Array.from(queryVec).join(',')}], k:${topN})`,
            per_page:       topN,
            include_fields: 'node_id',
          }],
        },
        {},
      );
      const hits = result?.results?.[0]?.hits ?? [];
      return hits.map((h: any) => h.document.node_id as string);
    } catch (err) {
      logWarn('TypesenseIndex: search failed', { error: String(err) });
      return [];
    }
  }

  /**
   * Return all node IDs currently stored in the collection via paginated export.
   */
  async getEmbeddedNodeIds(): Promise<string[]> {
    if (!this._available || !this.client) return [];

    const ids: string[] = [];
    try {
      const jsonl: string = await this.client
        .collections(COLLECTION)
        .documents()
        .export({ include_fields: 'node_id', batch_size: 1000 });

      for (const line of jsonl.split('\n')) {
        if (!line.trim()) continue;
        try {
          const doc = JSON.parse(line);
          if (doc.node_id) ids.push(doc.node_id as string);
        } catch { /* skip malformed line */ }
      }
    } catch {
      return ids;
    }

    return ids;
  }

  /** Number of documents currently in the collection. */
  async count(): Promise<number> {
    if (!this._available || !this.client) return 0;
    try {
      const result = await this.client.collections(COLLECTION).documents().search({
        q: '*', per_page: 0,
      });
      return result.found ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Disconnect the client. The Typesense server keeps running as a background
   * daemon so the next command can reconnect instantly via the state file.
   */
  close(): void {
    this._available = false;
    this.child  = null;
    this.client = null;
  }
}

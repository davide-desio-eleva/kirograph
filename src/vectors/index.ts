/**
 * KiroGraph Vector Manager
 *
 * Semantic search via configurable local embedding models using @huggingface/transformers v3.
 * Mirrors CodeGraph src/vectors/ (embedder.ts + manager.ts) adapted for KiroGraph:
 *   - Cache dir: ~/.kirograph/models/ (not ~/.codegraph/models/)
 *   - Embeddings stored in the `vectors` SQLite table
 *   - Cosine similarity search done in-process by default (no extra deps)
 *   - ANN search via sqlite-vec opt-in: set config.useVecIndex = true
 *     (requires `npm install better-sqlite3 sqlite-vec`)
 *   - Disabled by default; opt-in via config.enableEmbeddings = true
 */

import * as path from 'path';
import * as fs from 'fs';
import { homedir } from 'os';
import { logDebug, logWarn, logError } from '../errors';
import type { KiroGraphConfig } from '../config';
import type { Node } from '../types';
import type { GraphDatabase } from '../db/database';
import { VecIndex } from './vec-index';
import { OramaIndex } from './orama-index';
import { PGliteIndex } from './pglite-index';
import { LanceDBIndex } from './lancedb-index';
import { QdrantIndex } from './qdrant-index';
import { TypesenseIndex } from './typesense-index';
import { TurboQuantIndex, writeTurboQuantStats } from './turboquant-index';
import { TurboVecIndex } from './turbovec-index';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'nomic-ai/nomic-embed-text-v1.5';
const DEFAULT_EMBEDDING_DIM = 768;
const GLOBAL_MODELS_DIR = path.join(homedir(), '.kirograph', 'models');
const BATCH_SIZE = 32;
const MIN_BATCH_SIZE = 4;
const MAX_TOKEN_CHARS = 2000;

/** Node kinds worth embedding — high information density */
const EMBEDDABLE_KINDS = new Set<Node['kind']>([
  'function', 'method', 'class', 'interface', 'type_alias', 'component', 'module',
]);

// ── Embedder ──────────────────────────────────────────────────────────────────

type Pipeline = any;
let transformers: typeof import('@huggingface/transformers') | null = null;

async function getTransformers() {
  if (!transformers) {
    transformers = await import('@huggingface/transformers');
  }
  return transformers;
}

/**
 * Build a searchable text representation of a node.
 * Mirrors CodeGraph TextEmbedder.createNodeText().
 * Truncated to MAX_TOKEN_CHARS to stay within the model's memory-safe token limit.
 * Priority: kind + name > qualified name > file path > signature > docstring.
 * This ensures the most important search signal is always preserved.
 */
function nodeToText(node: Node): string {
  const parts = [`${node.kind}: ${node.name}`];
  if (node.qualifiedName && node.qualifiedName !== node.name) {
    parts.push(`path: ${node.qualifiedName}`);
  }
  parts.push(`file: ${node.filePath}`);
  if (node.signature) parts.push(`signature: ${node.signature}`);
  if (node.docstring) parts.push(`documentation: ${node.docstring}`);
  const text = parts.join('\n');
  if (text.length > MAX_TOKEN_CHARS) {
    logDebug(`nodeToText: truncated ${node.id} from ${text.length} to ${MAX_TOKEN_CHARS} chars`);
    return text.slice(0, MAX_TOKEN_CHARS);
  }
  return text;
}

/** Cosine similarity between two equal-length Float32Arrays. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Extract a flat Float32Array from the transformer pipeline output. */
function toFloat32Array(data: unknown): Float32Array {
  if (data instanceof Float32Array) return data;
  if (Array.isArray(data)) return new Float32Array(data);
  if (data && typeof data === 'object' && 'length' in data) {
    return Float32Array.from(Array.from(data as ArrayLike<number>));
  }
  throw new Error('Unsupported embedding data format');
}

// ── VectorManager ─────────────────────────────────────────────────────────────

export class VectorManager {
  private pipeline: Pipeline | null = null;
  private _initialized = false;
  private vecIndex: VecIndex | null = null;
  private oramaIndex: OramaIndex | null = null;
  private pgliteIndex: PGliteIndex | null = null;
  private lancedbIndex: LanceDBIndex | null = null;
  private qdrantIndex: QdrantIndex | null = null;
  private typesenseIndex: TypesenseIndex | null = null;
  private turboquantIndex: TurboQuantIndex | null = null;
  private turbovecIndex: TurboVecIndex | null = null;
  private _engineFallback: string | null = null;

  constructor(
    private readonly db: GraphDatabase,
    private readonly config: KiroGraphConfig,
    private readonly projectRoot?: string,
  ) {}

  isInitialized(): boolean {
    return this.config.enableEmbeddings === true && this._initialized;
  }

  /** Non-null when the configured engine failed to load and cosine is being used instead. */
  getEngineFallback(): string | null {
    return this._engineFallback;
  }

  /**
   * Load the embedding model. No-op when embeddings are disabled.
   * Fails silently so callers can continue without semantic search.
   * When config.useVecIndex is true, also initializes the sqlite-vec ANN index.
   */
  async initialize(onProgress?: (file: string, loaded: number, total: number, done: boolean) => void): Promise<void> {
    if (!this.config.enableEmbeddings) {
      logDebug('VectorManager: embeddings disabled');
      return;
    }
    if (this._initialized) return;

    const rawModel = this.config.embeddingModel || DEFAULT_MODEL;
    // Guard against an invalid model ID (e.g. 'y' typed by mistake in the installer)
    const modelId = rawModel.includes('/') ? rawModel : DEFAULT_MODEL;
    if (rawModel !== modelId) {
      logWarn(`VectorManager: invalid embeddingModel "${rawModel}", using default instead`, { default: DEFAULT_MODEL });
    }
    const cacheDir = GLOBAL_MODELS_DIR;

    try {
      const { pipeline, env } = await getTransformers();
      env.cacheDir = cacheDir;

      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      // Skip remote check if model already cached (HuggingFace uses '--' as path separator)
      // HuggingFace transformers v3 stores models as <org>/<model>/ (v2 used <org>--<model>)
      const cached = fs.existsSync(path.join(cacheDir, modelId));
      if (cached) env.allowRemoteModels = false;

      let lastFile = '';
      this.pipeline = await pipeline('feature-extraction', modelId, {
        dtype: 'auto',
        ...(!cached && onProgress ? {
          progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
            if (p.status === 'progress' && p.file) {
              lastFile = p.file;
              onProgress(p.file, p.loaded ?? 0, p.total ?? 0, false);
            } else if (p.status === 'done' && lastFile) {
              onProgress(lastFile, 1, 1, true);
              lastFile = '';
            }
          },
        } : {}),
      });

      // Validate embeddingDim against the model's actual output shape.
      // Run a single test embedding and compare dims[1] to config.embeddingDim.
      // If they differ, warn and update the runtime dim so downstream engines
      // are initialised with the correct size (config.json is not rewritten here).
      try {
        const testOut = await this.pipeline('test', { pooling: 'mean', normalize: true });
        const actualDim: number = testOut.dims?.[1] ?? (testOut.data?.length as number);
        const configuredDim = this.config.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
        if (actualDim && actualDim !== configuredDim) {
          logWarn(
            `VectorManager: embeddingDim mismatch — config says ${configuredDim} but model outputs ${actualDim}. Using actual dim.`,
            { model: modelId, configuredDim, actualDim },
          );
          // Patch the runtime config so all engine constructors below use the correct dim
          (this.config as unknown as Record<string, unknown>).embeddingDim = actualDim;
        }
      } catch { /* test embedding failed — proceed with configured dim */ }

      this._initialized = true;
      logDebug('VectorManager: model loaded', { modelId, embeddingDim: this.config.embeddingDim ?? DEFAULT_EMBEDDING_DIM });
    } catch (err) {
      logError('VectorManager: failed to load embedding model', {
        model: modelId,
        error: String(err),
      });
      this._initialized = false;
      return;
    }

    // Initialize the selected search engine
    const engine = this.config.semanticEngine ?? (this.config.useVecIndex ? 'sqlite-vec' : 'cosine');

    if (this.projectRoot && engine !== 'cosine') {
      const kirographDir = path.join(this.projectRoot, '.kirograph');

      const embeddingDim = this.config.embeddingDim ?? DEFAULT_EMBEDDING_DIM;

    if (engine === 'sqlite-vec') {
        this.vecIndex = new VecIndex(kirographDir, embeddingDim);
        await this.vecIndex.initialize();
        if (this.vecIndex.isAvailable()) {
          logDebug('VectorManager: sqlite-vec ANN index ready');
        } else {
          this._engineFallback = 'sqlite-vec unavailable — run: npm install better-sqlite3 sqlite-vec';
          logDebug('VectorManager: sqlite-vec unavailable, falling back to in-process cosine');
        }
      } else if (engine === 'orama') {
        this.oramaIndex = new OramaIndex(kirographDir, embeddingDim);
        await this.oramaIndex.initialize();
        if (this.oramaIndex.isAvailable()) {
          logDebug('VectorManager: Orama hybrid index ready');
        } else {
          this._engineFallback = 'orama unavailable — run: npm install @orama/orama @orama/plugin-data-persistence';
          logDebug('VectorManager: Orama unavailable, falling back to in-process cosine');
        }
      } else if (engine === 'pglite') {
        this.pgliteIndex = new PGliteIndex(kirographDir, embeddingDim);
        await this.pgliteIndex.initialize();
        if (this.pgliteIndex.isAvailable()) {
          logDebug('VectorManager: PGlite+pgvector hybrid index ready');
        } else {
          this._engineFallback = 'pglite unavailable — run: npm install @electric-sql/pglite';
          logDebug('VectorManager: PGlite unavailable, falling back to in-process cosine');
        }
      } else if (engine === 'lancedb') {
        this.lancedbIndex = new LanceDBIndex(kirographDir, embeddingDim);
        await this.lancedbIndex.initialize();
        if (this.lancedbIndex.isAvailable()) {
          logDebug('VectorManager: LanceDB ANN index ready');
        } else {
          this._engineFallback = 'lancedb unavailable — run: npm install @lancedb/lancedb';
          logDebug('VectorManager: LanceDB unavailable, falling back to in-process cosine');
        }
      } else if (engine === 'qdrant') {
        this.qdrantIndex = new QdrantIndex(kirographDir, embeddingDim);
        await this.qdrantIndex.initialize();
        if (this.qdrantIndex.isAvailable()) {
          logDebug('VectorManager: Qdrant ANN index ready');
        } else {
          this._engineFallback = 'qdrant unavailable — run: npm install qdrant-local';
          logDebug('VectorManager: Qdrant unavailable, falling back to in-process cosine');
        }
      } else if (engine === 'typesense') {
        this.typesenseIndex = new TypesenseIndex(kirographDir, embeddingDim);
        await this.typesenseIndex.initialize();
        if (this.typesenseIndex.isAvailable()) {
          logDebug('VectorManager: Typesense ANN index ready');
        } else {
          const reason = this.typesenseIndex.getFailReason();
          this._engineFallback = reason
            ? `typesense initialization failed: ${reason}`
            : 'typesense unavailable — run: npm install typesense';
          logDebug('VectorManager: Typesense unavailable, falling back to in-process cosine');
        }
      } else if (engine === 'turboquant') {
        const bits = this.config.turboquantBits ?? 3;
        this.turboquantIndex = new TurboQuantIndex(kirographDir, 'turboquant.bin', embeddingDim, bits);
        await this.turboquantIndex.initialize();
        if (this.turboquantIndex.isAvailable()) {
          logDebug('VectorManager: TurboQuant ANN index ready', { bits });
        } else {
          this._engineFallback = 'turboquant unavailable — run: npm install turboquant-js';
          logDebug('VectorManager: TurboQuant unavailable, falling back to in-process cosine');
        }
      } else if (engine === 'turbovec') {
        const bits = this.config.turbovecBits ?? 4;
        this.turbovecIndex = new TurboVecIndex(kirographDir, 'turbovec.tvim', embeddingDim, bits);
        await this.turbovecIndex.initialize();
        if (this.turbovecIndex.isAvailable()) {
          logDebug('VectorManager: TurboVec ANN index ready', { bits });
        } else {
          this._engineFallback = 'turbovec unavailable — build it: cd native/turbovec-node && npm install && npm run build';
          logDebug('VectorManager: TurboVec unavailable, falling back to in-process cosine');
        }
      }
    }
  }

  /**
   * Embed a single node and persist to the vectors table.
   * Skips silently when disabled; logs on failure without throwing.
   */
  async embedNode(node: Node): Promise<void> {
    if (!this.config.enableEmbeddings) return;
    if (!this._initialized || !this.pipeline) {
      logError('Embedding model unavailable', { model: this.config.embeddingModel });
      return;
    }
    if (!EMBEDDABLE_KINDS.has(node.kind)) return;

    try {
      const text = `search_document: ${nodeToText(node)}`;
      const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
      const embedding = toFloat32Array(output.data);
      // non-cosine engines are sole stores of record when active — skip the SQLite vectors table
      if (!this.vecIndex?.isAvailable() && !this.oramaIndex?.isAvailable() && !this.pgliteIndex?.isAvailable() && !this.lancedbIndex?.isAvailable() && !this.qdrantIndex?.isAvailable() && !this.typesenseIndex?.isAvailable() && !this.turboquantIndex?.isAvailable() && !this.turbovecIndex?.isAvailable()) {
        this.db.storeEmbedding(node.id, embedding, this.config.embeddingModel || DEFAULT_MODEL);
      }
      this.vecIndex?.upsert(node.id, embedding);
      if (this.oramaIndex?.isAvailable()) await this.oramaIndex.upsert(node, embedding);
      if (this.pgliteIndex?.isAvailable()) await this.pgliteIndex.upsert(node, embedding);
      if (this.lancedbIndex?.isAvailable()) await this.lancedbIndex.upsert(node, embedding);
      if (this.qdrantIndex?.isAvailable()) await this.qdrantIndex.upsert(node, embedding);
      if (this.typesenseIndex?.isAvailable()) await this.typesenseIndex.upsert(node, embedding);
      this.turboquantIndex?.upsert(node.id, embedding);
      this.turbovecIndex?.upsert(node.id, embedding);
    } catch (err) {
      logWarn('Failed to embed node', { nodeId: node.id, error: String(err) });
    }
  }

  /** Number of entries currently in the active ANN/hybrid index (0 when not in use). */
  async vecIndexCount(): Promise<number> {
    if (this.turbovecIndex?.isAvailable()) return this.turbovecIndex.count();
    if (this.turboquantIndex?.isAvailable()) return this.turboquantIndex.count();
    if (this.vecIndex?.isAvailable()) return this.vecIndex.count();
    if (this.oramaIndex?.isAvailable()) return this.oramaIndex.count();
    if (this.pgliteIndex?.isAvailable()) return this.pgliteIndex.count();
    if (this.lancedbIndex?.isAvailable()) return this.lancedbIndex.count();
    if (this.qdrantIndex?.isAvailable()) return this.qdrantIndex.count();
    if (this.typesenseIndex?.isAvailable()) return this.typesenseIndex.count();
    return 0;
  }

  /**
   * Remove embeddings for the given node IDs from the active index.
   * For cosine the `vectors` SQLite table is cleaned up automatically via FK cascade
   * when nodes are deleted. For sqlite-vec, orama, and pglite the engine itself is
   * the sole store of record, so we delete from it explicitly here.
   */
  async deleteEmbeddings(nodeIds: string[]): Promise<void> {
    for (const id of nodeIds) {
      this.vecIndex?.delete(id);
      if (this.oramaIndex?.isAvailable()) await this.oramaIndex.delete(id);
      if (this.pgliteIndex?.isAvailable()) await this.pgliteIndex.delete(id);
      if (this.lancedbIndex?.isAvailable()) await this.lancedbIndex.delete(id);
      if (this.qdrantIndex?.isAvailable()) await this.qdrantIndex.delete(id);
      if (this.typesenseIndex?.isAvailable()) await this.typesenseIndex.delete(id);
      this.turboquantIndex?.delete(id);
      this.turbovecIndex?.delete(id);
    }
  }

  /**
   * Embed all eligible nodes in the database that don't yet have embeddings.
   * Streams nodes in pages to avoid loading the entire node set into memory —
   * critical for large codebases (100K+ symbols) where a single getAllNodes()
   * call can exhaust the Node.js heap or the WASM linear memory.
   *
   * Uses dynamic batch sizing: starts at BATCH_SIZE, halves on OOM errors,
   * and recovers back to full size after successful batches.
   *
   * Emits a pre-flight warning via onProgress when the embeddable node count
   * exceeds LARGE_CODEBASE_THRESHOLD so the CLI can surface it to the user.
   */
  async embedAll(onProgress?: (current: number, total: number) => void): Promise<number> {
    if (!this.isInitialized() || !this.pipeline) return 0;

    const modelId = this.config.embeddingModel || DEFAULT_MODEL;
    const EMBEDDABLE_KINDS_ARRAY = [...EMBEDDABLE_KINDS] as string[];

    // Pre-flight: count embeddable nodes without loading them
    const totalEmbeddable = this.db.countEmbeddableNodes(EMBEDDABLE_KINDS_ARRAY);
    const LARGE_CODEBASE_THRESHOLD = 100_000;
    if (totalEmbeddable > LARGE_CODEBASE_THRESHOLD) {
      // Signal the large-codebase warning via a special progress event.
      // current=-1 is the sentinel; the CLI renderer checks for it.
      onProgress?.(-1, totalEmbeddable);
    }

    // Collect already-embedded IDs (needed to skip nodes already in the index)
    const existingIds = new Set(
      this.typesenseIndex?.isAvailable()
        ? await this.typesenseIndex.getEmbeddedNodeIds()
        : this.qdrantIndex?.isAvailable()
        ? await this.qdrantIndex.getEmbeddedNodeIds()
        : this.lancedbIndex?.isAvailable()
        ? await this.lancedbIndex.getEmbeddedNodeIds()
        : this.pgliteIndex?.isAvailable()
          ? await this.pgliteIndex.getEmbeddedNodeIds()
          : this.oramaIndex?.isAvailable()
            ? await this.oramaIndex.getEmbeddedNodeIds()
            : this.turbovecIndex?.isAvailable()
              ? this.turbovecIndex.getEmbeddedIds()
              : this.turboquantIndex?.isAvailable()
              ? this.turboquantIndex.getEmbeddedIds()
              : this.vecIndex?.isAvailable()
                ? this.vecIndex.getEmbeddedNodeIds()
                : this.db.getEmbeddedNodeIds()
    );

    // Stream nodes in pages — never hold more than PAGE_SIZE nodes in memory at once
    const PAGE_SIZE = 2000;
    let pageOffset = 0;
    let processed = 0;
    let currentBatchSize = BATCH_SIZE;
    let consecutiveSuccesses = 0;

    // We need to know the total pending count for progress reporting.
    // Approximate: totalEmbeddable - existingIds.size (may be slightly off if
    // existingIds contains IDs for non-embeddable kinds, but close enough).
    const totalPending = Math.max(0, totalEmbeddable - existingIds.size);
    if (totalPending === 0) {
      if (this.oramaIndex?.isAvailable()) await this.oramaIndex.save();
      return 0;
    }

    logDebug(`VectorManager: embedding ~${totalPending} nodes (${existingIds.size} already embedded, streaming in pages of ${PAGE_SIZE})`);

    // Buffer of pending nodes from the current page
    let pageBuffer: Node[] = [];
    let pageBufferOffset = 0; // index within pageBuffer
    let pageExhausted = false;

    const fetchNextPage = () => {
      const page = this.db.getEmbeddableNodesPaged(EMBEDDABLE_KINDS_ARRAY, PAGE_SIZE, pageOffset);
      pageOffset += page.length;
      pageBuffer = page.filter(n => !existingIds.has(n.id));
      pageBufferOffset = 0;
      if (page.length < PAGE_SIZE) pageExhausted = true;
    };

    fetchNextPage();

    while (pageBuffer.length > 0 || (!pageExhausted && pageBufferOffset >= pageBuffer.length)) {
      // Refill page buffer when exhausted
      if (pageBufferOffset >= pageBuffer.length) {
        if (pageExhausted) break;
        fetchNextPage();
        if (pageBuffer.length === 0) break;
      }

      // Slice a batch from the current page buffer
      const batch = pageBuffer.slice(pageBufferOffset, pageBufferOffset + currentBatchSize);
      if (batch.length === 0) break;

      const texts = batch.map(n => `search_document: ${nodeToText(n)}`);

      try {
        const outputs = await this.pipeline(texts, { pooling: 'mean', normalize: true });
        const dims: number[] = outputs.dims;
        const dim = dims[1] ?? (this.config.embeddingDim ?? DEFAULT_EMBEDDING_DIM);
        const flat = toFloat32Array(outputs.data);

        const tsNodes: Node[] = [];
        const tsEmbeddings: Float32Array[] = [];
        const qdNodes: Node[] = [];
        const qdEmbeddings: Float32Array[] = [];

        for (let j = 0; j < batch.length; j++) {
          const node = batch[j]!;
          const embedding = flat.slice(j * dim, (j + 1) * dim);
          if (!this.vecIndex?.isAvailable() && !this.oramaIndex?.isAvailable() && !this.pgliteIndex?.isAvailable() && !this.lancedbIndex?.isAvailable() && !this.qdrantIndex?.isAvailable() && !this.typesenseIndex?.isAvailable() && !this.turboquantIndex?.isAvailable() && !this.turbovecIndex?.isAvailable()) {
            this.db.storeEmbedding(node.id, embedding, modelId);
          }
          this.vecIndex?.upsert(node.id, embedding);
          if (this.oramaIndex?.isAvailable()) await this.oramaIndex.upsert(node, embedding);
          if (this.pgliteIndex?.isAvailable()) await this.pgliteIndex.upsert(node, embedding);
          if (this.lancedbIndex?.isAvailable()) await this.lancedbIndex.upsert(node, embedding);
          if (this.qdrantIndex?.isAvailable()) { qdNodes.push(node); qdEmbeddings.push(embedding); }
          if (this.typesenseIndex?.isAvailable()) { tsNodes.push(node); tsEmbeddings.push(embedding); }
          this.turboquantIndex?.upsert(node.id, embedding);
          this.turbovecIndex?.upsert(node.id, embedding);
        }

        if (qdNodes.length > 0) await this.qdrantIndex!.bulkUpsert(qdNodes, qdEmbeddings);
        if (tsNodes.length > 0) await this.typesenseIndex!.bulkUpsert(tsNodes, tsEmbeddings);

        pageBufferOffset += batch.length;
        processed += batch.length;
        consecutiveSuccesses++;

        if (currentBatchSize < BATCH_SIZE && consecutiveSuccesses >= 5) {
          currentBatchSize = Math.min(currentBatchSize * 2, BATCH_SIZE);
          logDebug(`VectorManager: batch size recovered to ${currentBatchSize}`);
          consecutiveSuccesses = 0;
        }
      } catch (err) {
        const errMsg = String(err);
        const isOOM = errMsg.includes('bad allocation') || errMsg.includes('OOM') || errMsg.includes('out of memory');

        if (isOOM && currentBatchSize > MIN_BATCH_SIZE) {
          currentBatchSize = Math.max(Math.floor(currentBatchSize / 2), MIN_BATCH_SIZE);
          consecutiveSuccesses = 0;
          logWarn(`VectorManager: OOM at batch offset ${pageBufferOffset} — reducing batch size to ${currentBatchSize} and retrying`, {
            batchSize: currentBatchSize,
            nodeIds: batch.slice(0, 3).map(n => n.id),
          });
          // Don't advance pageBufferOffset — retry the same batch
        } else if (isOOM && currentBatchSize <= MIN_BATCH_SIZE) {
          logError(`VectorManager: OOM even at minimum batch size ${MIN_BATCH_SIZE} — skipping ${batch.length} nodes`, {
            batchStart: pageBufferOffset,
            skippedNodes: batch.map(n => `${n.kind}:${n.name} (${n.filePath})`).slice(0, 5),
          });
          pageBufferOffset += batch.length;
          processed += batch.length;
          consecutiveSuccesses = 0;
        } else {
          logWarn(`VectorManager: batch embedding failed at offset ${pageBufferOffset}`, {
            batchSize: currentBatchSize,
            error: errMsg,
          });
          pageBufferOffset += batch.length;
          processed += batch.length;
          consecutiveSuccesses = 0;
        }
      }

      onProgress?.(processed, totalPending);
    }

    if (this.oramaIndex?.isAvailable()) await this.oramaIndex.save();

    if (this.turboquantIndex?.isAvailable()) {
      await this.turboquantIndex.save();
      if (this.projectRoot) {
        const kirographDir = path.join(this.projectRoot, '.kirograph');
        const stats = this.turboquantIndex.memoryStats();
        const count = this.turboquantIndex.count();
        const dim = this.config.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
        const rawBytes = count * dim * 4;
        writeTurboQuantStats(kirographDir, {
          count,
          dim,
          bits: this.config.turboquantBits ?? 3,
          compressionRatio: stats.compressionRatio,
          actualBytes: stats.actualBytes,
          rawBytes,
          savedBytes: rawBytes - stats.actualBytes,
        });
      }
    }

    if (this.turbovecIndex?.isAvailable()) {
      await this.turbovecIndex.save();
      logDebug('VectorManager: TurboVec index saved', {
        count: this.turbovecIndex.count(),
        bits: this.config.turbovecBits ?? 4,
      });
    }

    logDebug(`VectorManager: embedding complete — ${processed} processed, final batch size: ${currentBatchSize}`);

    return processed;
  }

  /**
   * Semantic search: embed the query and return top-N nodes by similarity.
   *
   * When sqlite-vec is available (useVecIndex: true), delegates ANN search to
   * VecIndex (fast, sub-linear). Otherwise falls back to in-process cosine
   * similarity over all stored embeddings (linear scan, no extra deps).
   *
   * Returns empty array when not initialized.
   */
  async search(query: string, topN = 10): Promise<Node[]> {
    if (!this.isInitialized() || !this.pipeline) return [];

    try {
      const text = `search_query: ${query}`;
      const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
      const queryVec = toFloat32Array(output.data);

      let nodeIds: string[];

      if (this.pgliteIndex?.isAvailable()) {
        // Hybrid search via PGlite+pgvector — exact vector + full-text in one SQL query
        nodeIds = await this.pgliteIndex.search(query, queryVec, topN);
      } else if (this.oramaIndex?.isAvailable()) {
        // Hybrid search via Orama — full-text + vector combined
        nodeIds = await this.oramaIndex.search(query, queryVec, topN);
      } else if (this.lancedbIndex?.isAvailable()) {
        // ANN search via LanceDB — columnar Lance format, cosine metric
        nodeIds = await this.lancedbIndex.search(queryVec, topN);
      } else if (this.qdrantIndex?.isAvailable()) {
        // ANN search via Qdrant — HNSW index, cosine metric
        nodeIds = await this.qdrantIndex.search(queryVec, topN);
      } else if (this.typesenseIndex?.isAvailable()) {
        // ANN search via Typesense — HNSW index, cosine metric
        nodeIds = await this.typesenseIndex.search(queryVec, topN);
      } else if (this.turbovecIndex?.isAvailable()) {
        // ANN search via TurboVec — Rust/SIMD NEON+AVX-512 quantized index
        nodeIds = this.turbovecIndex.search(queryVec, topN);
      } else if (this.turboquantIndex?.isAvailable()) {
        // ANN search via TurboQuant — compressed in-memory index, zero native deps
        nodeIds = this.turboquantIndex.search(queryVec, topN);
      } else if (this.vecIndex?.isAvailable()) {
        // ANN search via sqlite-vec — fast, sub-linear
        nodeIds = this.vecIndex.search(queryVec, topN);
      } else {
        // In-process cosine similarity — linear scan over all stored embeddings
        const allEmbeddings = this.db.getAllEmbeddings();
        nodeIds = allEmbeddings
          .map(({ nodeId, embedding }) => ({ nodeId, score: cosine(queryVec, embedding) }))
          .filter(r => r.score >= 0.3)
          .sort((a, b) => b.score - a.score)
          .slice(0, topN)
          .map(r => r.nodeId);
      }

      const results: Node[] = [];
      for (const nodeId of nodeIds) {
        const node = this.db.getNode(nodeId);
        if (node) results.push(node);
      }
      return results;
    } catch (err) {
      logWarn('VectorManager: search failed', { error: String(err) });
      return [];
    }
  }

  /** Release engine resources (e.g. kill Qdrant child process). */
  close(): void {
    this.qdrantIndex?.close();
    this.typesenseIndex?.close();
    this.turbovecIndex?.close();
  }
}

/**
 * KiroGraph Vector Manager
 *
 * Semantic search using nomic-ai/nomic-embed-text-v1.5 via @xenova/transformers.
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

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'nomic-ai/nomic-embed-text-v1.5';
const EMBEDDING_DIM = 768; // nomic-embed-text-v1.5 produces 768-dim vectors
const GLOBAL_MODELS_DIR = path.join(homedir(), '.kirograph', 'models');
const BATCH_SIZE = 32;

/** Node kinds worth embedding — high information density */
const EMBEDDABLE_KINDS = new Set<Node['kind']>([
  'function', 'method', 'class', 'interface', 'type_alias', 'component', 'module',
]);

// ── Embedder ──────────────────────────────────────────────────────────────────

type Pipeline = any;
let transformers: typeof import('@xenova/transformers') | null = null;

async function getTransformers() {
  if (!transformers) {
    transformers = await import('@xenova/transformers');
  }
  return transformers;
}

/**
 * Build a searchable text representation of a node.
 * Mirrors CodeGraph TextEmbedder.createNodeText().
 */
function nodeToText(node: Node): string {
  const parts = [`${node.kind}: ${node.name}`];
  if (node.qualifiedName && node.qualifiedName !== node.name) {
    parts.push(`path: ${node.qualifiedName}`);
  }
  parts.push(`file: ${node.filePath}`);
  if (node.signature) parts.push(`signature: ${node.signature}`);
  if (node.docstring) parts.push(`documentation: ${node.docstring}`);
  return parts.join('\n');
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

  constructor(
    private readonly db: GraphDatabase,
    private readonly config: KiroGraphConfig,
    private readonly projectRoot?: string,
  ) {}

  isInitialized(): boolean {
    return this.config.enableEmbeddings === true && this._initialized;
  }

  /**
   * Load the embedding model. No-op when embeddings are disabled.
   * Fails silently so callers can continue without semantic search.
   * When config.useVecIndex is true, also initializes the sqlite-vec ANN index.
   */
  async initialize(): Promise<void> {
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
      const cached = fs.existsSync(path.join(cacheDir, modelId.replace('/', '--')));
      if (cached) env.allowRemoteModels = false;

      this.pipeline = await pipeline('feature-extraction', modelId, { quantized: true });
      this._initialized = true;
      logDebug('VectorManager: model loaded', { modelId });
    } catch (err) {
      logError('VectorManager: failed to load embedding model', {
        model: modelId,
        error: String(err),
      });
      this._initialized = false;
      return;
    }

    // Initialize sqlite-vec ANN index when opted in
    if (this.config.useVecIndex && this.projectRoot) {
      const kirographDir = path.join(this.projectRoot, '.kirograph');
      this.vecIndex = new VecIndex(kirographDir, EMBEDDING_DIM);
      await this.vecIndex.initialize();
      if (this.vecIndex.isAvailable()) {
        logDebug('VectorManager: sqlite-vec ANN index ready');
      } else {
        logDebug('VectorManager: sqlite-vec unavailable, using in-process cosine search');
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
      this.db.storeEmbedding(node.id, embedding, this.config.embeddingModel || DEFAULT_MODEL);
      this.vecIndex?.upsert(node.id, embedding);
    } catch (err) {
      logWarn('Failed to embed node', { nodeId: node.id, error: String(err) });
    }
  }

  /** Number of entries currently in the sqlite-vec ANN index (0 when not in use). */
  vecIndexCount(): number {
    return this.vecIndex?.count() ?? 0;
  }

  /**
   * Remove embeddings for the given node IDs from the vec index.
   * The `vectors` table in the main DB is cleaned up automatically via FK cascade
   * when nodes are deleted; this only needs to handle the sqlite-vec side.
   */
  deleteEmbeddings(nodeIds: string[]): void {
    if (!this.vecIndex?.isAvailable()) return;
    for (const id of nodeIds) {
      this.vecIndex.delete(id);
    }
  }

  /**
   * Embed all eligible nodes in the database that don't yet have embeddings.
   * Processes in batches of BATCH_SIZE.
   */
  async embedAll(onProgress?: (current: number, total: number) => void): Promise<number> {
    if (!this.isInitialized() || !this.pipeline) return 0;

    const modelId = this.config.embeddingModel || DEFAULT_MODEL;
    const allNodes = this.db.getAllNodes().filter(n => EMBEDDABLE_KINDS.has(n.kind));
    const existingIds = new Set(this.db.getEmbeddedNodeIds());
    const pending = allNodes.filter(n => !existingIds.has(n.id));

    if (pending.length === 0) return 0;

    let processed = 0;
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const texts = batch.map(n => `search_document: ${nodeToText(n)}`);

      try {
        const outputs = await this.pipeline(texts, { pooling: 'mean', normalize: true });
        const dims: number[] = outputs.dims;
        const dim = dims[1] ?? EMBEDDING_DIM;
        const flat = toFloat32Array(outputs.data);

        for (let j = 0; j < batch.length; j++) {
          const node = batch[j]!;
          const embedding = flat.slice(j * dim, (j + 1) * dim);
          this.db.storeEmbedding(node.id, embedding, modelId);
          this.vecIndex?.upsert(node.id, embedding);
        }
      } catch (err) {
        logWarn('VectorManager: batch embedding failed', { batchStart: i, error: String(err) });
      }

      processed += batch.length;
      onProgress?.(processed, pending.length);
    }

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

      if (this.vecIndex?.isAvailable()) {
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
}

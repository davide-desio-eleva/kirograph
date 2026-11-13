/**
 * KiroGraph Docs — Vector embedding and search
 *
 * Reuses the same embedding model and pipeline as the memory module,
 * but operates on doc_vectors table independently.
 */

import type { KiroGraphConfig } from '../config';
import type { DocSection, DocSearchResult } from './types';
import { logDebug, logWarn, logError } from '../errors';
import { TurboQuantIndex, writeTurboQuantStats } from '../vectors/turboquant-index';

const MAX_TOKEN_CHARS = 2000;

// ── Embedder (reuses the same pipeline as memory/code vectors) ───────────────

let transformers: typeof import('@huggingface/transformers') | null = null;
let pipeline: any = null;
let pipelineModel: string | null = null;

async function getTransformers() {
  if (!transformers) {
    transformers = await import('@huggingface/transformers');
  }
  return transformers;
}

async function getPipeline(modelName: string, cacheDir: string) {
  if (pipeline && pipelineModel === modelName) return pipeline;

  const tf = await getTransformers();
  pipeline = await tf.pipeline('feature-extraction', modelName, {
    cache_dir: cacheDir,
    dtype: 'fp32',
  } as any);
  pipelineModel = modelName;
  return pipeline;
}

/**
 * Build searchable text from a doc section.
 * Uses title + summary for embedding (concise, semantically rich).
 */
function sectionToText(section: DocSection): string {
  const parts = [section.title];
  if (section.summary) parts.push(section.summary);
  const text = parts.join(': ');
  return text.length > MAX_TOKEN_CHARS ? text.slice(0, MAX_TOKEN_CHARS) : text;
}

/** A `doc_sections` row as a DocSection. */
function rowToSection(row: any): DocSection {
  return {
    id: row.id,
    filePath: row.file_path,
    title: row.title,
    level: row.level,
    parentId: row.parent_id ?? null,
    summary: row.summary ?? null,
    byteStart: row.byte_start,
    byteEnd: row.byte_end,
    contentHash: row.content_hash,
    tags: row.tags ? JSON.parse(row.tags) : [],
    position: row.position,
    updatedAt: row.updated_at,
  };
}

/** Cosine similarity between two Float32Arrays */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── DocsVectorManager ────────────────────────────────────────────────────────

export class DocsVectorManager {
  private config: KiroGraphConfig;
  private db: any; // raw SQLite handle
  private modelName: string;
  private cacheDir: string;
  private tqIndex: TurboQuantIndex | null = null;
  private tqInitialized = false;
  private _kirographDir: string | undefined;

  constructor(config: KiroGraphConfig, db: any, kirographDir?: string) {
    this.config = config;
    this.db = db;
    this.modelName = config.embeddingModel ?? 'nomic-ai/nomic-embed-text-v1.5';

    const { homedir } = require('os');
    const pathMod = require('path');
    this.cacheDir = pathMod.join(homedir(), '.kirograph', 'models');

    if (kirographDir && (config as any).turboquantMemDocs) {
      const bits = (config as any).turboquantBits ?? 3;
      const dim = config.embeddingDim ?? 768;
      this.tqIndex = new TurboQuantIndex(kirographDir, 'turboquant-doc.bin', dim, bits);
      this._kirographDir = kirographDir;
    }
  }

  /** Lazily initialize the TurboQuant index on first use. */
  private async ensureTQReady(): Promise<void> {
    if (this.tqInitialized) return;
    this.tqInitialized = true;
    if (this.tqIndex) await this.tqIndex.initialize();
  }

  /**
   * Check if embeddings are enabled in config.
   */
  isEnabled(): boolean {
    return !!this.config.enableEmbeddings;
  }

  /**
   * Embed a single doc section and store in doc_vectors.
   */
  async embedSection(section: DocSection): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const text = sectionToText(section);
      const embedding = await this.embed(text);
      if (embedding) {
        const buffer = Buffer.from(embedding.buffer);
        this.db.run(
          'INSERT OR REPLACE INTO doc_vectors (section_id, embedding, model, created_at) VALUES (?, ?, ?, ?)',
          [section.id, buffer, this.modelName, Date.now()],
        );
        if (this.tqIndex) {
          await this.ensureTQReady();
          this.tqIndex.upsert(section.id, embedding);
        }
      }
    } catch (err) {
      logWarn(`Failed to embed doc section ${section.id}: ${err}`);
    }
  }

  /**
   * Embed multiple sections in batch.
   */
  async embedBatch(sections: DocSection[]): Promise<number> {
    if (!this.isEnabled()) return 0;

    let embedded = 0;
    for (const section of sections) {
      try {
        await this.embedSection(section);
        embedded++;
      } catch (err) {
        logWarn(`Failed to embed doc section ${section.id}: ${err}`);
      }
    }
    return embedded;
  }

  /**
   * Embeds the sections that need it: those with no vector for the current model, and those
   * rewritten since their vector was made (a section's `updated_at` is set when its file is
   * indexed again). Removes the vectors of sections that no longer exist.
   *
   * Embedding every section on every sync cost one model call per section (tens of milliseconds
   * each on a CPU) even when no document had changed; this does no model call, and does not load
   * the model, when nothing needs it.
   */
  async embedPending(): Promise<number> {
    if (!this.isEnabled()) return 0;
    this.db.run('DELETE FROM doc_vectors WHERE section_id NOT IN (SELECT id FROM doc_sections)');
    const rows = this.db.all(
      `SELECT s.* FROM doc_sections s
         LEFT JOIN doc_vectors v ON v.section_id = s.id AND v.model = ?
        WHERE v.section_id IS NULL OR v.created_at < s.updated_at
        ORDER BY s.file_path, s.position`,
      [this.modelName],
    ) as any[];
    if (rows.length === 0) return 0;
    return this.embedBatch(rows.map(rowToSection));
  }

  /**
   * Vector search over doc sections.
   * Returns scored sections sorted by cosine similarity.
   * Falls back to empty results if embeddings are disabled.
   */
  async search(query: string, limit = 10): Promise<Array<{ sectionId: string; score: number }>> {
    if (!this.isEnabled()) return [];

    try {
      const queryEmbedding = await this.embed(query);
      if (!queryEmbedding) return [];

      // ANN path: TurboQuant index replaces the O(n) linear scan
      if (this.tqIndex) {
        await this.ensureTQReady();
        if (this.tqIndex.isAvailable()) {
          const hits = this.tqIndex.searchWithScores(queryEmbedding, limit);
          return hits.map(({ id, score }) => ({ sectionId: id, score }));
        }
      }

      // Fallback: linear cosine scan over all stored embeddings
      const allVectors = this.db.all(
        'SELECT section_id, embedding FROM doc_vectors WHERE model = ?',
        [this.modelName],
      ) as Array<{ section_id: string; embedding: Buffer }>;

      if (allVectors.length === 0) return [];

      const scored: Array<{ sectionId: string; score: number }> = [];
      for (const { section_id, embedding } of allVectors) {
        const vec = new Float32Array(
          embedding.buffer,
          embedding.byteOffset,
          embedding.byteLength / 4,
        );
        scored.push({ sectionId: section_id, score: cosine(queryEmbedding, vec) });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    } catch (err) {
      logError('Docs vector search failed', { error: err });
      return [];
    }
  }

  /**
   * Check if there are vectors with a mismatched model.
   */
  hasModelMismatch(): boolean {
    const mismatch = this.db.get(
      'SELECT COUNT(*) as cnt FROM doc_vectors WHERE model != ?',
      [this.modelName],
    )?.cnt ?? 0;
    return mismatch > 0;
  }

  /**
   * Get vector stats.
   */
  getStats(): { total: number; currentModel: number; mismatch: number } {
    const total = this.db.get('SELECT COUNT(*) as cnt FROM doc_vectors')?.cnt ?? 0;
    const currentModel = this.db.get(
      'SELECT COUNT(*) as cnt FROM doc_vectors WHERE model = ?',
      [this.modelName],
    )?.cnt ?? 0;
    return { total, currentModel, mismatch: total - currentModel };
  }

  /**
   * Re-embed all doc sections with the current model.
   */
  async reembed(batchSize = 32): Promise<number> {
    // Delete all existing doc vectors
    this.db.run('DELETE FROM doc_vectors');

    // Reset TurboQuant index so it rebuilds from scratch
    if (this.tqIndex) {
      this.tqIndex.close();
      this.tqInitialized = false;
    }

    // Get all sections
    const rows = this.db.all('SELECT * FROM doc_sections ORDER BY file_path, position') as any[];
    const sections: DocSection[] = rows.map(rowToSection);

    let embedded = 0;
    for (let i = 0; i < sections.length; i += batchSize) {
      const batch = sections.slice(i, i + batchSize);
      embedded += await this.embedBatch(batch);
    }

    if (this.tqIndex?.isAvailable() && this._kirographDir) {
      await this.tqIndex.save();
      const stats = this.tqIndex.memoryStats();
      const dim = this.config.embeddingDim ?? 768;
      const rawBytes = embedded * dim * 4;
      writeTurboQuantStats(this._kirographDir, {
        docsEnabled: true,
        docsCount: embedded,
        docsActualBytes: stats.actualBytes,
        docsRawBytes: rawBytes,
      });
    }

    return embedded;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async embed(text: string): Promise<Float32Array | null> {
    try {
      const pipe = await getPipeline(this.modelName, this.cacheDir);
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      return output.data as Float32Array;
    } catch (err) {
      logDebug(`Doc embedding failed: ${err}`);
      return null;
    }
  }
}

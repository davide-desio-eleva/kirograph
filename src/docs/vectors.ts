/**
 * KiroGraph Docs — Vector embedding and search
 *
 * Reuses the same embedding model and pipeline as the memory module,
 * but operates on doc_vectors table independently.
 */

import type { KiroGraphConfig } from '../config';
import type { DocSection, DocSearchResult } from './types';
import { logDebug, logWarn, logError } from '../errors';

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

  constructor(config: KiroGraphConfig, db: any) {
    this.config = config;
    this.db = db;
    this.modelName = config.embeddingModel ?? 'nomic-ai/nomic-embed-text-v1.5';

    const { homedir } = require('os');
    const path = require('path');
    this.cacheDir = path.join(homedir(), '.kirograph', 'models');
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
   * Vector search over doc sections.
   * Returns scored sections sorted by cosine similarity.
   * Falls back to empty results if embeddings are disabled.
   */
  async search(query: string, limit = 10): Promise<Array<{ sectionId: string; score: number }>> {
    if (!this.isEnabled()) return [];

    try {
      const queryEmbedding = await this.embed(query);
      if (!queryEmbedding) return [];

      // Get all doc vectors with matching model
      const allVectors = this.db.all(
        'SELECT section_id, embedding FROM doc_vectors WHERE model = ?',
        [this.modelName],
      ) as Array<{ section_id: string; embedding: Buffer }>;

      if (allVectors.length === 0) return [];

      // Compute cosine similarity for each
      const scored: Array<{ sectionId: string; score: number }> = [];
      for (const { section_id, embedding } of allVectors) {
        const vec = new Float32Array(
          embedding.buffer,
          embedding.byteOffset,
          embedding.byteLength / 4,
        );
        const score = cosine(queryEmbedding, vec);
        scored.push({ sectionId: section_id, score });
      }

      // Sort by score descending, take top N
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

    // Get all sections
    const rows = this.db.all('SELECT * FROM doc_sections ORDER BY file_path, position') as any[];
    const sections: DocSection[] = rows.map((row: any) => ({
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
    }));

    let embedded = 0;
    for (let i = 0; i < sections.length; i += batchSize) {
      const batch = sections.slice(i, i + batchSize);
      embedded += await this.embedBatch(batch);
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

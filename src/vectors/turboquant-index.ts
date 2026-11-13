/**
 * KiroGraph TurboQuant ANN Index
 *
 * Wraps turboquant-js (Google TurboQuant algorithm) as a drop-in ANN index.
 * Compresses embeddings at index time via Walsh-Hadamard rotation + Lloyd-Max
 * scalar quantization — zero native dependencies.
 *
 * Optional dep: npm install turboquant-js
 *
 * Algorithm: https://research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/
 * Implementation: https://github.com/danilodevhub/turboquant-js (by Danilo Dev)
 *
 * Falls back silently to cosine if turboquant-js is not installed.
 *
 * Compression at 3 bits (default):
 *   768-dim Float32 (3,072 bytes) → ~120 bytes (≈25× smaller)
 *   10K vectors: ~30 MB raw → ~1.2 MB compressed
 */

import * as path from 'path';
import { requireEngine } from '../shared/engines';
import * as fs from 'fs';
import { logDebug, logWarn, logError } from '../errors';

// ── TurboQuantStats ───────────────────────────────────────────────────────────

export interface TurboQuantStats {
  count: number;
  dim: number;
  bits: number;
  compressionRatio: number;
  actualBytes: number;
  rawBytes: number;
  savedBytes: number;
  memEnabled: boolean;
  memCount: number;
  memActualBytes: number;
  memRawBytes: number;
  docsEnabled: boolean;
  docsCount: number;
  docsActualBytes: number;
  docsRawBytes: number;
  updatedAt: number;
}

const STATS_FILE = 'turboquant-stats.json';

export function readTurboQuantStats(kirographDir: string): TurboQuantStats | null {
  try {
    const p = path.join(kirographDir, STATS_FILE);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as TurboQuantStats;
  } catch {
    return null;
  }
}

export function writeTurboQuantStats(kirographDir: string, patch: Partial<TurboQuantStats>): void {
  const p = path.join(kirographDir, STATS_FILE);
  const tmp = p + '.tmp';
  try {
    const existing = readTurboQuantStats(kirographDir) ?? {
      count: 0, dim: 768, bits: 3,
      compressionRatio: 1, actualBytes: 0, rawBytes: 0, savedBytes: 0,
      memEnabled: false, memCount: 0, memActualBytes: 0, memRawBytes: 0,
      docsEnabled: false, docsCount: 0, docsActualBytes: 0, docsRawBytes: 0,
      updatedAt: 0,
    };
    const updated: TurboQuantStats = { ...existing, ...patch, updatedAt: Math.floor(Date.now() / 1000) };
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
    fs.renameSync(tmp, p);
  } catch (err) {
    logWarn('TurboQuantIndex: failed to write stats file', { error: String(err) });
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ── TurboQuantIndex ───────────────────────────────────────────────────────────

export class TurboQuantIndex {
  private index: any = null;
  private _available = false;

  constructor(
    private readonly kirographDir: string,
    private readonly binName: string,   // 'turboquant.bin' | 'turboquant-mem.bin' | 'turboquant-doc.bin'
    private readonly dim: number,
    private readonly bits: number = 3,
  ) {}

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Load turboquant-js and restore index from disk if the .bin file exists.
   * Silent no-op when the optional dependency is missing.
   */
  async initialize(): Promise<void> {
    if (this._available) return;

    let TQModule: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      TQModule = requireEngine('turboquant-js');
    } catch {
      logDebug('TurboQuantIndex: turboquant-js not installed — turboquant engine unavailable');
      return;
    }

    // Handle various export shapes (default export, named export, CJS wrapper)
    const VectorIndex =
      TQModule?.VectorIndex ??
      TQModule?.default?.VectorIndex ??
      (typeof TQModule === 'function' ? TQModule : null);

    if (!VectorIndex || typeof VectorIndex !== 'function') {
      logWarn('TurboQuantIndex: unrecognised turboquant-js module shape — turboquant engine unavailable');
      return;
    }

    const binPath = path.join(this.kirographDir, this.binName);

    try {
      if (fs.existsSync(binPath) && typeof VectorIndex.fromBuffer === 'function') {
        const nodeBuf = fs.readFileSync(binPath);
        // fromBuffer() requires a pure ArrayBuffer, not a Node Buffer/Uint8Array
        const ab = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);
        this.index = VectorIndex.fromBuffer(ab, { dimension: this.dim, bits: this.bits });
        logDebug('TurboQuantIndex: restored from disk', { binPath });
      } else {
        this.index = new VectorIndex({ dimension: this.dim, bits: this.bits });
        logDebug('TurboQuantIndex: new index', { dim: this.dim, bits: this.bits });
      }
      this._available = true;
    } catch (err) {
      logError('TurboQuantIndex: initialization failed', { error: String(err) });
      this._available = false;
      this.index = null;
    }
  }

  /** Add or update an embedding (turboquant-js compresses at index time). */
  upsert(id: string, vec: Float32Array): void {
    if (!this._available || !this.index) return;
    try {
      this.index.add(id, vec);
    } catch (err) {
      logWarn('TurboQuantIndex: upsert failed', { id, error: String(err) });
    }
  }

  /** Remove an entry from the index (permanent via turboquant-js remove()). */
  delete(id: string): void {
    if (!this._available || !this.index) return;
    try {
      this.index.remove(id);
    } catch (err) {
      logWarn('TurboQuantIndex: delete failed', { id, error: String(err) });
    }
  }

  /** ANN search: returns IDs sorted by descending similarity. */
  search(queryVec: Float32Array, topN = 10): string[] {
    return this.searchWithScores(queryVec, topN).map(r => r.id);
  }

  /**
   * ANN search: returns [{id, score}] sorted by descending similarity.
   * Used by MemoryVectorManager and DocsVectorManager to preserve scores for
   * hybrid merge.
   */
  searchWithScores(queryVec: Float32Array, topN = 10): Array<{ id: string; score: number }> {
    if (!this._available || !this.index) return [];
    try {
      const raw: unknown = this.index.search(queryVec, topN);
      return this._normaliseSearchResults(raw).slice(0, topN);
    } catch (err) {
      logWarn('TurboQuantIndex: search failed', { error: String(err) });
      return [];
    }
  }

  /**
   * Persist the compressed index to disk atomically.
   * Called once at the end of `kirograph index` — not on every upsert.
   */
  async save(): Promise<void> {
    if (!this._available || !this.index) return;
    if (typeof this.index.toBuffer !== 'function') {
      logDebug('TurboQuantIndex: toBuffer() not available — index not persisted');
      return;
    }

    const binPath = path.join(this.kirographDir, this.binName);
    const tmp = binPath + '.tmp';
    try {
      const raw = this.index.toBuffer();
      // toBuffer() may return ArrayBuffer — Node fs requires Buffer/TypedArray
      const buf = raw instanceof ArrayBuffer ? Buffer.from(raw) : (raw as Buffer);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, binPath);
      logDebug('TurboQuantIndex: saved', { binPath, bytes: buf.length });
    } catch (err) {
      logWarn('TurboQuantIndex: save failed', { error: String(err) });
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  /**
   * Memory usage stats from the compressed index.
   * Falls back to a formula-based estimate when memoryUsage is unavailable.
   */
  memoryStats(): { totalBits: number; bitsPerVector: number; compressionRatio: number; actualBytes: number } {
    if (this._available && this.index?.memoryUsage) {
      return this.index.memoryUsage as { totalBits: number; bitsPerVector: number; compressionRatio: number; actualBytes: number };
    }
    const n = this.count();
    const rawBytes = n * this.dim * 4;
    const actualBytes = Math.ceil(n * this.dim * this.bits / 8);
    return {
      totalBits: actualBytes * 8,
      bitsPerVector: this.bits * this.dim,
      compressionRatio: actualBytes > 0 ? rawBytes / actualBytes : 1,
      actualBytes,
    };
  }

  count(): number {
    if (!this._available || !this.index) return 0;
    try {
      // idToIndex is an internal Map — reliable count that survives remove()
      if (this.index.idToIndex instanceof Map) return this.index.idToIndex.size;
      if (typeof this.index.size === 'number') return this.index.size;
    } catch { /* ignore */ }
    return 0;
  }

  /** All IDs currently in the index. */
  getEmbeddedIds(): string[] {
    if (!this._available || !this.index) return [];
    try {
      if (this.index.idToIndex instanceof Map) {
        return [...this.index.idToIndex.keys()];
      }
    } catch { /* ignore */ }
    return [];
  }

  close(): void {
    this.index = null;
    this._available = false;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _normaliseSearchResults(raw: unknown): Array<{ id: string; score: number }> {
    if (!Array.isArray(raw)) return [];

    return raw
      .map((item: unknown, rank: number) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>;
          const id = (obj['id'] ?? obj['key'] ?? '') as string;
          const score = (obj['score'] ?? obj['similarity'] ?? obj['distance'] ?? (1 - rank / raw.length)) as number;
          return { id, score: typeof score === 'number' ? score : 1 - rank / raw.length };
        }
        if (Array.isArray(item) && item.length >= 2) {
          return { id: String(item[0]), score: typeof item[1] === 'number' ? item[1] : 1 - rank / raw.length };
        }
        if (typeof item === 'string') {
          return { id: item, score: 1 - rank / raw.length };
        }
        return null;
      })
      .filter((r): r is { id: string; score: number } => r !== null && r.id.length > 0);
  }
}

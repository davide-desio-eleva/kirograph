/**
 * KiroGraph TurboVec ANN Index
 *
 * Wraps turbovec-node (napi-rs bindings for RyanCodrai/turbovec) as a
 * drop-in ANN index.  Uses the same TurboQuant algorithm as turboquant-js
 * but backed by a Rust/SIMD implementation — NEON on ARM, AVX-512BW on
 * x86 — and supports 2, 3, or 4 bits per coordinate.
 *
 * Build the native addon once before use:
 *   cd native/turbovec-node && npm install && npm run build
 *
 * Requires: Rust toolchain (rustup), plus openblas on Linux.
 * On macOS the Accelerate framework is used automatically (no extra dep).
 *
 * Falls back silently to cosine if turbovec-node is not built/installed.
 *
 * dim constraint: must be a positive multiple of 8 (768 ✓, 384 ✓).
 * bit_width: 2 (highest compression), 3 (balanced), 4 (highest quality).
 *
 * Upstream: https://github.com/RyanCodrai/turbovec
 */

import * as path from 'path';
import * as fs from 'fs';
import { logDebug, logWarn, logError } from '../errors';

// ── TurboVecIndex ─────────────────────────────────────────────────────────────

export class TurboVecIndex {
  private index: any = null;
  private _available = false;

  constructor(
    private readonly kirographDir: string,
    private readonly binName: string,
    private readonly dim: number,
    private readonly bits: number = 4,
  ) {}

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Load the native addon and restore the index from disk if the bin file
   * exists.  Silent no-op when the addon is not built.
   */
  async initialize(): Promise<void> {
    if (this._available) return;

    let TVModule: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      TVModule = require('turbovec-node');
    } catch {
      logDebug('TurboVecIndex: turbovec-node not found — run: cd native/turbovec-node && npm install && npm run build');
      return;
    }

    const TurboVecIndexClass =
      TVModule?.TurboVecIndex ??
      TVModule?.default?.TurboVecIndex ??
      null;

    if (!TurboVecIndexClass || typeof TurboVecIndexClass !== 'function') {
      logWarn('TurboVecIndex: unrecognised turbovec-node module shape — turbovec engine unavailable');
      return;
    }

    // turbovec requires dim to be a positive multiple of 8
    if (this.dim <= 0 || this.dim % 8 !== 0) {
      logWarn('TurboVecIndex: dim must be a positive multiple of 8', { dim: this.dim });
      return;
    }

    const binPath = path.join(this.kirographDir, this.binName);

    try {
      if (fs.existsSync(binPath) && typeof TurboVecIndexClass.load === 'function') {
        this.index = TurboVecIndexClass.load(binPath);
        logDebug('TurboVecIndex: restored from disk', { binPath });
      } else {
        this.index = new TurboVecIndexClass(this.dim, this.bits);
        logDebug('TurboVecIndex: new index', { dim: this.dim, bits: this.bits });
      }
      this._available = true;
    } catch (err) {
      logError('TurboVecIndex: initialization failed', { error: String(err) });
      this._available = false;
      this.index = null;
    }
  }

  /** Insert or update a vector. */
  upsert(id: string, vec: Float32Array): void {
    if (!this._available || !this.index) return;
    try {
      this.index.add(id, vec);
    } catch (err) {
      logWarn('TurboVecIndex: upsert failed', { id, error: String(err) });
    }
  }

  /** Remove a vector from the index. */
  delete(id: string): void {
    if (!this._available || !this.index) return;
    try {
      this.index.remove(id);
    } catch (err) {
      logWarn('TurboVecIndex: delete failed', { id, error: String(err) });
    }
  }

  /** ANN search — returns IDs sorted by descending similarity. */
  search(queryVec: Float32Array, topN = 10): string[] {
    return this.searchWithScores(queryVec, topN).map(r => r.id);
  }

  /** ANN search — returns [{id, score}] sorted by descending similarity. */
  searchWithScores(queryVec: Float32Array, topN = 10): Array<{ id: string; score: number }> {
    if (!this._available || !this.index) return [];
    try {
      const results: Array<{ id: string; score: number }> = this.index.search(queryVec, topN);
      return results.slice(0, topN);
    } catch (err) {
      logWarn('TurboVecIndex: search failed', { error: String(err) });
      return [];
    }
  }

  /**
   * Persist the index to disk atomically.
   * Saves `<binName>` (turbovec binary) and `<binName>.ids` (JSON string-ID sidecar).
   */
  async save(): Promise<void> {
    if (!this._available || !this.index) return;

    const binPath = path.join(this.kirographDir, this.binName);
    const tmpBin = binPath + '.tmp';

    try {
      this.index.save(tmpBin);
      // Rust saves to `tmpBin` and `tmpBin + ".ids"` — atomically rename both
      if (fs.existsSync(tmpBin)) {
        fs.renameSync(tmpBin, binPath);
      }
      const tmpIds = tmpBin + '.ids';
      if (fs.existsSync(tmpIds)) {
        fs.renameSync(tmpIds, binPath + '.ids');
      }
      logDebug('TurboVecIndex: saved', { binPath });
    } catch (err) {
      logWarn('TurboVecIndex: save failed', { error: String(err) });
      for (const f of [tmpBin, tmpBin + '.ids']) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    }
  }

  /** Compression stats (formula-based, mirrors turboquant-index.ts). */
  memoryStats(): { totalBits: number; bitsPerVector: number; compressionRatio: number; actualBytes: number } {
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
      return typeof this.index.len === 'function' ? (this.index.len() as number) : 0;
    } catch { return 0; }
  }

  getEmbeddedIds(): string[] {
    if (!this._available || !this.index) return [];
    try {
      return typeof this.index.getIds === 'function' ? (this.index.getIds() as string[]) : [];
    } catch { return []; }
  }

  close(): void {
    try { this.index?.close(); } catch { /* ignore */ }
    this.index = null;
    this._available = false;
  }
}

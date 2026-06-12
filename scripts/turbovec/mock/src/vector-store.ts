export interface VectorEntry {
  id: string;
  vec: Float32Array;
  metadata: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export class VectorStore {
  private entries = new Map<string, VectorEntry>();

  upsert(id: string, vec: Float32Array, metadata: Record<string, unknown> = {}): void {
    this.entries.set(id, { id, vec, metadata });
  }

  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  search(query: Float32Array, topN = 5): SearchResult[] {
    const results: SearchResult[] = [];
    for (const entry of this.entries.values()) {
      results.push({ id: entry.id, score: this._dot(query, entry.vec), metadata: entry.metadata });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, topN);
  }

  count(): number { return this.entries.size; }

  ids(): string[] { return Array.from(this.entries.keys()); }

  private _dot(a: Float32Array, b: Float32Array): number {
    let s = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
    return s;
  }
}

export function normalizeVector(v: Float32Array): Float32Array {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm) as Float32Array;
}

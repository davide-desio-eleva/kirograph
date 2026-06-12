import type { GraphNode, GraphEdge } from './graph';

export interface IndexEntry {
  id: string;
  filePath: string;
  symbolName: string;
  kind: 'class' | 'function' | 'interface' | 'type' | 'const' | 'enum';
  startLine: number;
  endLine: number;
  docstring?: string;
  embedding?: Float32Array;
}

export interface SearchResult {
  entry: IndexEntry;
  score: number;
  highlights: string[];
}

export interface IndexStats {
  totalEntries: number;
  byKind: Record<string, number>;
  byFile: Map<string, number>;
  embeddedCount: number;
  indexSizeBytes: number;
  lastUpdated: number;
}

export interface IndexQuery {
  text?: string;
  kind?: IndexEntry['kind'];
  filePath?: string;
  limit?: number;
  minScore?: number;
}

export class IndexManager {
  private entries = new Map<string, IndexEntry>();
  private fileIndex = new Map<string, Set<string>>();
  private kindIndex = new Map<string, Set<string>>();

  add(entry: IndexEntry): void {
    this.entries.set(entry.id, entry);

    const fileSet = this.fileIndex.get(entry.filePath) ?? new Set<string>();
    fileSet.add(entry.id);
    this.fileIndex.set(entry.filePath, fileSet);

    const kindSet = this.kindIndex.get(entry.kind) ?? new Set<string>();
    kindSet.add(entry.id);
    this.kindIndex.set(entry.kind, kindSet);
  }

  remove(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    this.fileIndex.get(entry.filePath)?.delete(id);
    this.kindIndex.get(entry.kind)?.delete(id);
    return true;
  }

  get(id: string): IndexEntry | undefined {
    return this.entries.get(id);
  }

  byFile(filePath: string): IndexEntry[] {
    const ids = this.fileIndex.get(filePath) ?? new Set<string>();
    return [...ids].map(id => this.entries.get(id)!).filter(Boolean);
  }

  byKind(kind: IndexEntry['kind']): IndexEntry[] {
    const ids = this.kindIndex.get(kind) ?? new Set<string>();
    return [...ids].map(id => this.entries.get(id)!).filter(Boolean);
  }

  removeFile(filePath: string): number {
    const ids = [...(this.fileIndex.get(filePath) ?? [])];
    for (const id of ids) this.remove(id);
    return ids.length;
  }

  search(query: IndexQuery): SearchResult[] {
    let candidates = [...this.entries.values()];

    if (query.filePath) {
      candidates = candidates.filter(e => e.filePath === query.filePath);
    }
    if (query.kind) {
      candidates = candidates.filter(e => e.kind === query.kind);
    }
    if (query.text) {
      const q = query.text.toLowerCase();
      candidates = candidates.filter(e =>
        e.symbolName.toLowerCase().includes(q) ||
        e.docstring?.toLowerCase().includes(q)
      );
    }

    const results: SearchResult[] = candidates.map(entry => ({
      entry,
      score: this.scoreEntry(entry, query.text ?? ''),
      highlights: this.extractHighlights(entry, query.text ?? ''),
    }));

    results.sort((a, b) => b.score - a.score);

    const minScore = query.minScore ?? 0;
    return results
      .filter(r => r.score >= minScore)
      .slice(0, query.limit ?? 20);
  }

  stats(): IndexStats {
    const byKind: Record<string, number> = {};
    const byFile = new Map<string, number>();
    let embeddedCount = 0;

    for (const entry of this.entries.values()) {
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
      byFile.set(entry.filePath, (byFile.get(entry.filePath) ?? 0) + 1);
      if (entry.embedding) embeddedCount++;
    }

    return {
      totalEntries: this.entries.size,
      byKind,
      byFile,
      embeddedCount,
      indexSizeBytes: this.entries.size * 512,
      lastUpdated: Date.now(),
    };
  }

  clear(): void {
    this.entries.clear();
    this.fileIndex.clear();
    this.kindIndex.clear();
  }

  private scoreEntry(entry: IndexEntry, text: string): number {
    if (!text) return 0.5;
    const q = text.toLowerCase();
    const name = entry.symbolName.toLowerCase();
    if (name === q) return 1.0;
    if (name.startsWith(q)) return 0.9;
    if (name.includes(q)) return 0.7;
    if (entry.docstring?.toLowerCase().includes(q)) return 0.5;
    return 0.1;
  }

  private extractHighlights(entry: IndexEntry, text: string): string[] {
    if (!text) return [];
    const highlights: string[] = [];
    if (entry.symbolName.toLowerCase().includes(text.toLowerCase())) {
      highlights.push(entry.symbolName);
    }
    if (entry.docstring) {
      const idx = entry.docstring.toLowerCase().indexOf(text.toLowerCase());
      if (idx >= 0) {
        const start = Math.max(0, idx - 30);
        const end = Math.min(entry.docstring.length, idx + text.length + 30);
        highlights.push('...' + entry.docstring.slice(start, end) + '...');
      }
    }
    return highlights;
  }
}

export function buildIndexFromNodes(nodes: GraphNode[], edges: GraphEdge[]): IndexManager {
  const manager = new IndexManager();
  for (const node of nodes) {
    manager.add({
      id: node.id,
      filePath: (node.metadata['filePath'] as string) ?? 'unknown',
      symbolName: node.label,
      kind: (node.metadata['kind'] as IndexEntry['kind']) ?? 'function',
      startLine: (node.metadata['startLine'] as number) ?? 0,
      endLine: (node.metadata['endLine'] as number) ?? 0,
      docstring: node.metadata['docstring'] as string | undefined,
    });
  }
  return manager;
}

export function mergeIndexes(...managers: IndexManager[]): IndexManager {
  const merged = new IndexManager();
  for (const manager of managers) {
    const s = manager.stats();
    for (const [file] of s.byFile) {
      for (const entry of manager.byFile(file)) {
        merged.add(entry);
      }
    }
  }
  return merged;
}

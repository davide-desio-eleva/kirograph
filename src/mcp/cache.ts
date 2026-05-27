/**
 * KiroGraph File Read Cache
 *
 * In-memory, session-scoped file cache. First read returns full content,
 * subsequent reads of unchanged files return a compact "cached" marker (~13 tokens).
 * Uses content hashing (SHA-256) to detect changes.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

export interface CacheEntry {
  contentHash: string;
  content: string;
  lastRead: number;
  readCount: number;
}

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  hitRate: number;
}

export interface ReadResult {
  content: string;
  cached: boolean;
  changed: boolean;
  /** Previous content (for diff mode) */
  previousContent?: string;
}

export class FileReadCache {
  private cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  /**
   * Read a file with caching. Returns full content on first read or if changed,
   * returns a compact marker if unchanged since last read.
   */
  read(filePath: string, noCache = false): ReadResult {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err: any) {
      throw new Error(`Cannot read file: ${err.message}`);
    }

    if (noCache) {
      const hash = this.hashContent(content);
      const previous = this.cache.get(filePath);
      this.cache.set(filePath, {
        contentHash: hash,
        content,
        lastRead: Date.now(),
        readCount: (previous?.readCount ?? 0) + 1,
      });
      this.misses++;
      return { content, cached: false, changed: false };
    }

    const hash = this.hashContent(content);
    const existing = this.cache.get(filePath);

    if (existing && existing.contentHash === hash) {
      // Cache hit — file unchanged
      this.hits++;
      existing.lastRead = Date.now();
      existing.readCount++;
      return {
        content: `[cached: unchanged since ${this.formatTimestamp(existing.lastRead)}] (${existing.readCount} reads)`,
        cached: true,
        changed: false,
      };
    }

    // Cache miss or file changed
    this.misses++;
    const previousContent = existing?.content;
    this.cache.set(filePath, {
      contentHash: hash,
      content,
      lastRead: Date.now(),
      readCount: (existing?.readCount ?? 0) + 1,
    });

    if (existing) {
      // File changed since last read
      return { content, cached: false, changed: true, previousContent };
    }

    // First read
    return { content, cached: false, changed: false };
  }

  /**
   * Get the previously cached content for a file (used by diff mode).
   */
  getPreviousContent(filePath: string): string | undefined {
    return this.cache.get(filePath)?.content;
  }

  /**
   * Check if a file is in the cache.
   */
  has(filePath: string): boolean {
    return this.cache.has(filePath);
  }

  /**
   * Invalidate cache entries for specific files (e.g., after sync).
   */
  invalidate(filePaths: string[]): void {
    for (const fp of filePaths) {
      this.cache.delete(fp);
    }
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 100) : 0,
    };
  }

  /**
   * List all cached file paths with their metadata.
   */
  listEntries(): Array<{ path: string; readCount: number; lastRead: number }> {
    return [...this.cache.entries()].map(([p, e]) => ({
      path: p,
      readCount: e.readCount,
      lastRead: e.lastRead,
    }));
  }

  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private formatTimestamp(ts: number): string {
    const diff = Date.now() - ts;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  }
}

// Singleton instance — session-scoped (lives as long as the MCP server process)
let _instance: FileReadCache | null = null;

export function getFileReadCache(): FileReadCache {
  if (!_instance) {
    _instance = new FileReadCache();
  }
  return _instance;
}

export function resetFileReadCache(): void {
  _instance?.clear();
  _instance = null;
}

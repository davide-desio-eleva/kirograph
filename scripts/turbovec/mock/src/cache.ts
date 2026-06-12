export interface CacheEntry<T> {
  key: string;
  value: T;
  createdAt: number;
  expiresAt: number;
  hitCount: number;
}

export interface CacheOptions {
  maxSize?: number;
  defaultTtlMs?: number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
}

export class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: CacheOptions = {}) {
    this.maxSize = options.maxSize ?? 512;
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) { this.misses++; return undefined; }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }
    entry.hitCount++;
    this.hits++;
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (this.cache.has(key)) this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) { this.cache.delete(oldest); this.evictions++; }
    }
    const now = Date.now();
    this.cache.set(key, {
      key,
      value,
      createdAt: now,
      expiresAt: now + (ttlMs ?? this.defaultTtlMs),
      hitCount: 0,
    });
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) { this.cache.delete(key); return false; }
    return true;
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  evictExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) { this.cache.delete(key); count++; }
    }
    return count;
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  keys(): string[] {
    return [...this.cache.keys()];
  }

  values(): T[] {
    return [...this.cache.values()].map(e => e.value);
  }
}

export class TwoLevelCache<T> {
  private l1: LRUCache<T>;
  private l2: LRUCache<T>;

  constructor(l1Options: CacheOptions, l2Options: CacheOptions) {
    this.l1 = new LRUCache<T>(l1Options);
    this.l2 = new LRUCache<T>(l2Options);
  }

  get(key: string): T | undefined {
    const l1Hit = this.l1.get(key);
    if (l1Hit !== undefined) return l1Hit;
    const l2Hit = this.l2.get(key);
    if (l2Hit !== undefined) {
      this.l1.set(key, l2Hit);
      return l2Hit;
    }
    return undefined;
  }

  set(key: string, value: T, ttlMs?: number): void {
    this.l1.set(key, value, ttlMs);
    this.l2.set(key, value, ttlMs ? ttlMs * 4 : undefined);
  }

  invalidate(key: string): void {
    this.l1.delete(key);
    this.l2.delete(key);
  }

  stats(): { l1: CacheStats; l2: CacheStats } {
    return { l1: this.l1.stats(), l2: this.l2.stats() };
  }
}

export class EmbeddingCache {
  private cache: LRUCache<Float32Array>;

  constructor(maxEntries = 1024) {
    this.cache = new LRUCache<Float32Array>({ maxSize: maxEntries, defaultTtlMs: 3_600_000 });
  }

  get(text: string): Float32Array | undefined {
    return this.cache.get(this.hash(text));
  }

  set(text: string, embedding: Float32Array): void {
    this.cache.set(this.hash(text), embedding);
  }

  has(text: string): boolean {
    return this.cache.has(this.hash(text));
  }

  stats(): CacheStats {
    return this.cache.stats();
  }

  private hash(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
  }
}

export function memoize<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
  keyFn: (...args: TArgs) => string,
  cache: LRUCache<TReturn>,
): (...args: TArgs) => TReturn {
  return (...args: TArgs): TReturn => {
    const key = keyFn(...args);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = fn(...args);
    cache.set(key, result);
    return result;
  };
}

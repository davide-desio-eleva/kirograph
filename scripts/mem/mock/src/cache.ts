export class CacheEntry<T> {
  constructor(
    public value: T,
    public expiresAt: number
  ) {}

  isExpired(): boolean {
    return Date.now() > this.expiresAt;
  }
}

export class MemoryCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, new CacheEntry(value, Date.now() + ttlMs));
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry || entry.isExpired()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

export function memoize<T>(fn: (...args: unknown[]) => T, ttlMs = 60_000) {
  const cache = new MemoryCache<T>();
  return (...args: unknown[]): T => {
    const key = JSON.stringify(args);
    const cached = cache.get(key);
    if (cached !== null) return cached;
    const result = fn(...args);
    cache.set(key, result, ttlMs);
    return result;
  };
}

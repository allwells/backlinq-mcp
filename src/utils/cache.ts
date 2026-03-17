// In-memory cache with TTL — used for Common Crawl fallback results
// WAT file parsing is expensive; never re-fetch the same domain within the cache window.

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

class MemoryCache {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
}

export const cache = new MemoryCache();

/** 24 hours in milliseconds */
export const TTL_24H = 24 * 60 * 60 * 1000;

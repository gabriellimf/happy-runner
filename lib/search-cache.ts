export const SEARCH_CACHE_TTL_MS = 60_000;
export const SEARCH_CACHE_MAX_ENTRIES = 200;

interface SearchCacheEntry<T> {
  expiresAt: number;
  value: T;
}

export function createSearchCache<T>(now: () => number = () => Date.now()) {
  const entries = new Map<string, SearchCacheEntry<T>>();

  return {
    clear(): void {
      entries.clear();
    },
    get(key: string): T | undefined {
      const entry = entries.get(key);

      if (!entry) {
        return undefined;
      }

      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }

      return entry.value;
    },
    set(key: string, value: T): void {
      entries.delete(key);
      entries.set(key, {
        expiresAt: now() + SEARCH_CACHE_TTL_MS,
        value,
      });

      if (entries.size > SEARCH_CACHE_MAX_ENTRIES) {
        const oldestKey = entries.keys().next().value;

        if (oldestKey !== undefined) {
          entries.delete(oldestKey);
        }
      }
    },
    get size(): number {
      return entries.size;
    },
  };
}

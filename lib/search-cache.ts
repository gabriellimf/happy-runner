export const SEARCH_CACHE_TTL_MS = 60_000;

// The intent and pick judgments depend only on the query text and the candidate
// ids, both of which are already in the cache key. They do not depend on the
// queue, so they stay valid far longer than a Spotify result list. Caching them
// longer cuts paid TypeSafe calls when guests ask for the same songs.
// The similar judgment keys on the queue, so it must keep the short lifetime.
export const INTENT_PICK_CACHE_TTL_MS = 900_000;

export const SEARCH_CACHE_MAX_ENTRIES = 200;

interface SearchCacheEntry<T> {
  expiresAt: number;
  value: T;
}

export function createSearchCache<T>(
  now: () => number = () => Date.now(),
  ttlMs: number = SEARCH_CACHE_TTL_MS,
) {
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
        expiresAt: now() + ttlMs,
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

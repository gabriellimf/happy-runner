import { describe, expect, it } from "vitest";

import {
  createSearchCache,
  SEARCH_CACHE_MAX_ENTRIES,
  SEARCH_CACHE_TTL_MS,
} from "../lib/search-cache";

describe("search cache", () => {
  it("expires entries after the configured TTL", () => {
    let now = 1_000;
    const cache = createSearchCache<string[]>(() => now);

    cache.set("query", ["result"]);
    expect(cache.get("query")).toEqual(["result"]);

    now += SEARCH_CACHE_TTL_MS;
    expect(cache.get("query")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entry when the cache reaches its cap", () => {
    const cache = createSearchCache<string>(() => 1_000);

    for (let index = 0; index <= SEARCH_CACHE_MAX_ENTRIES; index += 1) {
      cache.set(`query-${index}`, `result-${index}`);
    }

    expect(cache.size).toBe(SEARCH_CACHE_MAX_ENTRIES);
    expect(cache.get("query-0")).toBeUndefined();
    expect(cache.get("query-1")).toBe("result-1");
  });
});

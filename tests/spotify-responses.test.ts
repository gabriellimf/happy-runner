import { describe, expect, it } from "vitest";

import {
  MAX_SEARCH_RESULTS,
  parseSpotifySearchResults,
} from "../lib/spotify-responses";

describe("Spotify response parsing", () => {
  it("caps parsed search results at the shared maximum", () => {
    const items = Array.from({ length: MAX_SEARCH_RESULTS + 2 }, (_, index) => ({
      album: { images: [] },
      artists: [{ name: "Artista" }],
      duration_ms: 180_000,
      id: `track-${index}`,
      name: `Faixa ${index}`,
      type: "track",
      uri: `spotify:track:track-${index}`,
    }));

    const results = parseSpotifySearchResults({ tracks: { items } });

    expect(results).toHaveLength(MAX_SEARCH_RESULTS);
    expect(results.map(({ id }) => id)).toEqual(
      items.slice(0, MAX_SEARCH_RESULTS).map(({ id }) => id),
    );
  });
});

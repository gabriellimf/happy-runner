import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as searchGet } from "../app/api/search/route";
import {
  getQueue,
  search,
} from "../lib/spotify";
import type { QueueResponse, Track } from "../lib/spotify-responses";
import {
  getTypeSafeClient,
  isTypeSafeCircuitOpen,
  logTypeSafeError,
} from "../lib/typesafe";
import { resetSearchJudgmentCaches } from "../lib/search-judgment";

vi.mock("../lib/spotify", () => ({
  getQueue: vi.fn(),
  search: vi.fn(),
}));

vi.mock("../lib/typesafe", () => ({
  getTypeSafeClient: vi.fn(),
  isTypeSafeCircuitOpen: vi.fn(),
  logTypeSafeError: vi.fn(),
  recordTypeSafeFailure: vi.fn(),
  recordTypeSafeSuccess: vi.fn(),
}));

const ITEMS: Track[] = [
  {
    artists: ["Artista"],
    coverUrl: null,
    durationMs: 180_000,
    id: "track-1",
    title: "Faixa 1",
    uri: "spotify:track:0123456789012345678901",
  },
];

const EMPTY_QUEUE: QueueResponse = { nowPlaying: null, next: [] };

beforeEach(() => {
  vi.resetAllMocks();
  resetSearchJudgmentCaches();
  vi.mocked(search).mockResolvedValue(ITEMS);
  vi.mocked(getQueue).mockResolvedValue(EMPTY_QUEUE);
  vi.mocked(isTypeSafeCircuitOpen).mockReturnValue(false);
  vi.mocked(getTypeSafeClient).mockImplementation(() => {
    throw new Error("private initialization detail");
  });
});

describe("GET /api/search fail-open boundary", () => {
  it("returns Spotify items when TypeSafe client construction throws", async () => {
    const response = await searchGet(
      new Request("http://localhost/api/search?q=faixa"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ items: ITEMS });
    expect(logTypeSafeError).toHaveBeenCalledWith(
      "search-judgment",
      expect.any(Error),
    );
  });
});

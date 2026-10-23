import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as searchGet } from "../app/api/search/route";
import { judgeSearch } from "../lib/search-judgment";
import { getQueue, search, SpotifyApiError } from "../lib/spotify";
import type { QueueResponse, Track } from "../lib/spotify-responses";

vi.mock("../lib/search-judgment", () => ({ judgeSearch: vi.fn() }));
vi.mock("../lib/spotify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/spotify")>()),
  getQueue: vi.fn(),
  search: vi.fn(),
}));

const ITEMS: Track[] = [
  {
    artists: ["Artista"],
    coverUrl: null,
    durationMs: 180_000,
    id: "id-1",
    title: "Faixa 1",
    uri: "spotify:track:id-1",
  },
  {
    artists: ["Artista"],
    coverUrl: null,
    durationMs: 180_000,
    id: "id-2",
    title: "Faixa 2",
    uri: "spotify:track:id-2",
  },
];

const EMPTY_QUEUE: QueueResponse = { nowPlaying: null, next: [] };

function queueTrack(id: string) {
  return { artists: ["Artista"], coverUrl: null, id, title: `Faixa ${id}` };
}

function request(query: string): Request {
  return new Request(
    `http://localhost/api/search?q=${encodeURIComponent(query)}`,
  );
}

beforeEach(() => {
  vi.mocked(judgeSearch).mockResolvedValue({ blocked: false, similarIds: [] });
  vi.mocked(search).mockResolvedValue(ITEMS);
  vi.mocked(getQueue).mockResolvedValue(EMPTY_QUEUE);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/search with TypeSafe checks", () => {
  it("returns no items and skips Spotify and TypeSafe for a playback command", async () => {
    const response = await searchGet(request("pula essa"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(search).not.toHaveBeenCalled();
    expect(getQueue).not.toHaveBeenCalled();
    expect(judgeSearch).not.toHaveBeenCalled();
  });

  it("returns no items when TypeSafe blocks the query after the search", async () => {
    vi.mocked(judgeSearch).mockResolvedValue({
      blocked: true,
      similarIds: [],
    });

    const response = await searchGet(request("bom dia pessoal"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(search).toHaveBeenCalledWith("bom dia pessoal");
    expect(judgeSearch).toHaveBeenCalledWith(
      "bom dia pessoal",
      ITEMS,
      EMPTY_QUEUE,
    );
  });

  it("does not search or judge queries that fail validation", async () => {
    const response = await searchGet(request("abc"));

    expect(response.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
    expect(getQueue).not.toHaveBeenCalled();
    expect(judgeSearch).not.toHaveBeenCalled();
  });

  it("omits autoAddId when TypeSafe did not judge the candidates", async () => {
    const response = await searchGet(request("  faixa  "));

    expect(await response.json()).toEqual({ items: ITEMS });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(judgeSearch).toHaveBeenCalledWith("faixa", ITEMS, EMPTY_QUEUE);
  });

  it("returns the confident pick as autoAddId", async () => {
    vi.mocked(judgeSearch).mockResolvedValue({
      autoAddId: "id-2",
      blocked: false,
      similarIds: [],
    });

    const response = await searchGet(request("faixa"));

    expect(await response.json()).toEqual({ items: ITEMS, autoAddId: "id-2" });
  });

  it("returns autoAddId null when no candidate is confident", async () => {
    vi.mocked(judgeSearch).mockResolvedValue({
      autoAddId: null,
      blocked: false,
      similarIds: [],
    });

    const response = await searchGet(request("faixa"));

    expect(await response.json()).toEqual({ items: ITEMS, autoAddId: null });
  });

  it("returns search items when the judgment promise rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(judgeSearch).mockRejectedValue(new Error("private failure"));

    const response = await searchGet(request("faixa"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ items: ITEMS });
    consoleError.mockRestore();
  });
});

describe("GET /api/search duplicate hints", () => {
  it("flags a track that is queued or playing as exact, decided by code", async () => {
    const queue: QueueResponse = {
      nowPlaying: queueTrack("id-1"),
      next: [queueTrack("id-2")],
    };

    vi.mocked(getQueue).mockResolvedValue(queue);

    const response = await searchGet(request("faixa"));

    expect(await response.json()).toEqual({
      inQueue: { "id-1": "exact", "id-2": "exact" },
      items: ITEMS,
    });
    expect(judgeSearch).toHaveBeenCalledWith("faixa", ITEMS, queue);
  });

  it("flags tracks Jev judged to be another version as version", async () => {
    vi.mocked(getQueue).mockResolvedValue({
      nowPlaying: queueTrack("other"),
      next: [],
    });
    vi.mocked(judgeSearch).mockResolvedValue({
      blocked: false,
      similarIds: ["id-2"],
    });

    const response = await searchGet(request("faixa"));

    expect(await response.json()).toEqual({
      inQueue: { "id-2": "version" },
      items: ITEMS,
    });
  });

  it("keeps exact over version when both apply", async () => {
    vi.mocked(getQueue).mockResolvedValue({
      nowPlaying: queueTrack("id-1"),
      next: [],
    });
    vi.mocked(judgeSearch).mockResolvedValue({
      blocked: false,
      similarIds: ["id-1"],
    });

    const response = await searchGet(request("faixa"));

    expect(await response.json()).toEqual({
      inQueue: { "id-1": "exact" },
      items: ITEMS,
    });
  });

  it("omits inQueue when nothing matches", async () => {
    vi.mocked(getQueue).mockResolvedValue({
      nowPlaying: queueTrack("other"),
      next: [],
    });

    const response = await searchGet(request("faixa"));

    expect(await response.json()).toEqual({ items: ITEMS });
  });

  it("fails open when the queue read fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.mocked(getQueue).mockRejectedValue(new SpotifyApiError(502, "boom"));

    const response = await searchGet(request("faixa"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: ITEMS });
    expect(judgeSearch).toHaveBeenCalledWith("faixa", ITEMS, undefined);
    consoleError.mockRestore();
  });

  it("still fails when the search itself fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.mocked(search).mockRejectedValue(new SpotifyApiError(502, "boom"));

    const response = await searchGet(request("faixa"));

    expect(response.status).toBe(502);
    expect(judgeSearch).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

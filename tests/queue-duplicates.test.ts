import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSimilarQuestions,
  hasQueuedTracks,
  markQueued,
  queuedTrackIds,
  queueState,
  readQueueOrUndefined,
  resolveSimilarIds,
  SIMILAR_QUEUED_CONFIDENCE,
} from "../lib/queue-duplicates";
import { getQueue } from "../lib/spotify";
import type { QueueResponse, QueueTrack, Track } from "../lib/spotify-responses";

vi.mock("../lib/spotify", () => ({ getQueue: vi.fn() }));

function queueTrack(id: string): QueueTrack {
  return { artists: ["Artista"], coverUrl: null, id, title: `Faixa ${id}` };
}

function track(id: string): Track {
  return {
    artists: ["Artista"],
    coverUrl: null,
    durationMs: 180_000,
    id,
    title: `Faixa ${id}`,
    uri: `spotify:track:${id}`,
  };
}

const QUEUE: QueueResponse = {
  nowPlaying: queueTrack("playing"),
  next: [queueTrack("next-1"), queueTrack("next-2")],
};

afterEach(() => {
  vi.resetAllMocks();
});

describe("queue duplicates", () => {
  it("collects the playing and queued ids", () => {
    expect(queuedTrackIds(QUEUE)).toEqual(
      new Set(["playing", "next-1", "next-2"]),
    );
    expect(queuedTrackIds({ nowPlaying: null, next: [] })).toEqual(new Set());
  });

  it("tells whether the queue has any track", () => {
    expect(hasQueuedTracks(QUEUE)).toBe(true);
    expect(hasQueuedTracks({ nowPlaying: null, next: [queueTrack("a")] })).toBe(
      true,
    );
    expect(hasQueuedTracks({ nowPlaying: null, next: [] })).toBe(false);
  });

  it("sends only titles and artists to TypeSafe, never ids or covers", () => {
    expect(queueState(QUEUE)).toEqual({
      now_playing: { title: "Faixa playing", artists: ["Artista"] },
      next: [
        { title: "Faixa next-1", artists: ["Artista"] },
        { title: "Faixa next-2", artists: ["Artista"] },
      ],
    });
  });

  it("builds one noul per candidate that is not an exact match", () => {
    const idsByKey = new Map([
      ["c1", "a"],
      ["c2", "b"],
      ["c3", "c"],
    ]);

    const questions = buildSimilarQuestions(idsByKey, new Set(["b"]));

    expect(Object.keys(questions)).toEqual(["similar_c1", "similar_c3"]);
    expect(questions.similar_c1.type).toBe("noul");
    expect(JSON.stringify(questions.similar_c1)).toContain("candidates.c1");
    expect(JSON.stringify(questions.similar_c3)).toContain("candidates.c3");
  });

  it("resolves similar ids at the threshold and skips exact ids", () => {
    const idsByKey = new Map([
      ["c1", "a"],
      ["c2", "b"],
      ["c3", "c"],
      ["c4", "d"],
    ]);
    const answers = {
      similar_c1: { noul: SIMILAR_QUEUED_CONFIDENCE, type: "noul" },
      similar_c2: { noul: 0.99, type: "noul" },
      similar_c3: { noul: SIMILAR_QUEUED_CONFIDENCE - 0.01, type: "noul" },
    };

    expect(resolveSimilarIds(answers, idsByKey, new Set(["b"]))).toEqual(["a"]);
  });

  it("ignores answers that are not noul answers", () => {
    const idsByKey = new Map([["c1", "a"]]);

    expect(
      resolveSimilarIds(
        { similar_c1: { choice: "c1", confidence: 1, type: "choice" } },
        idsByKey,
        new Set(),
      ),
    ).toEqual([]);
    expect(resolveSimilarIds({ similar_c1: null }, idsByKey, new Set())).toEqual(
      [],
    );
  });

  it("marks exact over version", () => {
    const tracks = [track("a"), track("b"), track("c")];

    expect(markQueued(tracks, new Set(["a"]), ["a", "b"])).toEqual({
      a: "exact",
      b: "version",
    });
    expect(markQueued(tracks, new Set(), [])).toEqual({});
  });

  it("returns the queue from Spotify", async () => {
    vi.mocked(getQueue).mockResolvedValue(QUEUE);

    await expect(readQueueOrUndefined()).resolves.toBe(QUEUE);
  });

  it("returns undefined and logs only safe metadata when the read fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.mocked(getQueue).mockRejectedValue(new Error("private upstream text"));

    await expect(readQueueOrUndefined()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith({
      errorClass: "Error",
      feature: "queue-read",
    });
    consoleError.mockRestore();
  });
});

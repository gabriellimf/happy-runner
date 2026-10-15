import { beforeEach, describe, expect, it, vi } from "vitest";

import { judgeSearch } from "../lib/search-judgment";
import type { QueueResponse, Track } from "../lib/spotify-responses";
import { getTypeSafeClient, logTypeSafeError } from "../lib/typesafe";

vi.mock("../lib/typesafe", () => ({
  getTypeSafeClient: vi.fn(),
  logTypeSafeError: vi.fn(),
}));

const systemOne = vi.fn();

function track(id: string, title: string, artist: string): Track {
  return {
    artists: [artist],
    coverUrl: null,
    durationMs: 180_000,
    id,
    title,
    uri: `spotify:track:${id.padEnd(22, "0")}`,
  };
}

const TRACKS = [
  track("id-1", "Evidências - Karaoke", "Karaoke Hits"),
  track("id-2", "Evidências", "Chitãozinho & Xororó"),
];

function answerWith(
  intent: [choice: string, confidence: number],
  pick: [choice: string, confidence: number],
  similar: Record<string, number> = {},
): void {
  systemOne.mockResolvedValue({
    answers: {
      intent: { choice: intent[0], confidence: intent[1], type: "choice" },
      pick: { choice: pick[0], confidence: pick[1], type: "choice" },
      ...Object.fromEntries(
        Object.entries(similar).map(([id, noul]) => [
          id,
          { noul, type: "noul" },
        ]),
      ),
    },
  });
}

function queueOf(...ids: string[]): QueueResponse {
  const [first, ...rest] = ids.map((id) => ({
    artists: ["Alguém"],
    coverUrl: null,
    id,
    title: `Faixa ${id}`,
  }));

  return { nowPlaying: first ?? null, next: rest };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getTypeSafeClient).mockReturnValue({ systemOne } as never);
});

describe("judgeSearch", () => {
  it("does not judge when TypeSafe is not configured", async () => {
    vi.mocked(getTypeSafeClient).mockReturnValue(null);

    await expect(judgeSearch("evidencias", TRACKS)).resolves.toEqual({
      blocked: false,
      similarIds: [],
    });
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("does not call TypeSafe when there are no tracks", async () => {
    await expect(judgeSearch("evidencias", [])).resolves.toEqual({
      blocked: false,
      similarIds: [],
    });
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("asks both questions in one request over one shared state", async () => {
    answerWith(["song", 0.99], ["c2", 0.97]);

    await judgeSearch("evidencias", TRACKS);

    expect(systemOne).toHaveBeenCalledTimes(1);

    const request = systemOne.mock.calls[0][0];

    expect(request.state).toEqual({
      guest_text: "evidencias",
      candidates: {
        c1: { title: "Evidências - Karaoke", artists: ["Karaoke Hits"] },
        c2: { title: "Evidências", artists: ["Chitãozinho & Xororó"] },
      },
    });
    expect(Object.keys(request.questions)).toEqual(["intent", "pick"]);
  });

  it("returns the confident pick as autoAddId", async () => {
    answerWith(["song", 0.99], ["c2", 0.9]);

    await expect(judgeSearch("evidencias", TRACKS)).resolves.toEqual({
      autoAddId: "id-2",
      blocked: false,
      similarIds: [],
    });
  });

  it("returns autoAddId null when no candidate is confident enough", async () => {
    answerWith(["song", 0.99], ["c2", 0.89]);

    await expect(judgeSearch("evidencias", TRACKS)).resolves.toEqual({
      autoAddId: null,
      blocked: false,
      similarIds: [],
    });
  });

  it.each([
    ["command", 0.5],
    ["other", 0.9],
  ])("blocks on %s at %d and ignores the speculative pick", async (intent, confidence) => {
    answerWith([intent, confidence], ["c2", 0.99], { similar_c1: 0.99 });

    await expect(
      judgeSearch("bom dia pessoal", TRACKS, queueOf("queued")),
    ).resolves.toEqual({ blocked: true, similarIds: [] });
  });

  it("keeps the pick when the intent is not confident enough to block", async () => {
    answerWith(["other", 0.89], ["c2", 0.99]);

    await expect(judgeSearch("evidencias", TRACKS)).resolves.toEqual({
      autoAddId: "id-2",
      blocked: false,
      similarIds: [],
    });
  });

  it("fails open and logs when TypeSafe fails", async () => {
    const failure = new Error("boom");
    systemOne.mockRejectedValue(failure);

    await expect(
      judgeSearch("evidencias", TRACKS, queueOf("queued")),
    ).resolves.toEqual({ blocked: false, similarIds: [] });
    expect(logTypeSafeError).toHaveBeenCalledWith("search-judgment", failure);
  });

  describe("with a queue", () => {
    it("adds the queue to the state and one similar question per candidate", async () => {
      answerWith(["song", 0.99], ["c2", 0.97], {
        similar_c1: 0.1,
        similar_c2: 0.1,
      });

      await judgeSearch("evidencias", TRACKS, queueOf("queued-1", "queued-2"));

      expect(systemOne).toHaveBeenCalledTimes(1);

      const request = systemOne.mock.calls[0][0];

      expect(request.state.queue).toEqual({
        now_playing: { title: "Faixa queued-1", artists: ["Alguém"] },
        next: [{ title: "Faixa queued-2", artists: ["Alguém"] }],
      });
      expect(Object.keys(request.questions).sort()).toEqual([
        "intent",
        "pick",
        "similar_c1",
        "similar_c2",
      ]);
      expect(request.questions.similar_c1.type).toBe("noul");
    });

    it("returns candidates at or above the similar threshold", async () => {
      answerWith(["song", 0.99], ["c2", 0.97], {
        similar_c1: 0.8,
        similar_c2: 0.79,
      });

      await expect(
        judgeSearch("evidencias", TRACKS, queueOf("queued")),
      ).resolves.toEqual({
        autoAddId: "id-2",
        blocked: false,
        similarIds: ["id-1"],
      });
    });

    it("asks no similar question for a track that is already in the queue", async () => {
      answerWith(["song", 0.99], ["c2", 0.97], { similar_c1: 0.99 });

      const judgment = await judgeSearch(
        "evidencias",
        TRACKS,
        queueOf("id-2", "queued"),
      );
      const request = systemOne.mock.calls[0][0];

      expect(Object.keys(request.questions).sort()).toEqual([
        "intent",
        "pick",
        "similar_c1",
      ]);
      expect(judgment.similarIds).toEqual(["id-1"]);
    });

    it("skips similar questions and the queue state when every candidate is queued", async () => {
      answerWith(["song", 0.99], ["c2", 0.97]);

      await judgeSearch("evidencias", TRACKS, queueOf("id-1", "id-2"));

      const request = systemOne.mock.calls[0][0];

      expect(request.state).not.toHaveProperty("queue");
      expect(Object.keys(request.questions)).toEqual(["intent", "pick"]);
    });

    it("skips similar questions when the queue is empty", async () => {
      answerWith(["song", 0.99], ["c2", 0.97]);

      await judgeSearch("evidencias", TRACKS, { nowPlaying: null, next: [] });

      const request = systemOne.mock.calls[0][0];

      expect(request.state).not.toHaveProperty("queue");
      expect(Object.keys(request.questions)).toEqual(["intent", "pick"]);
    });

    it("ignores a missing similar answer", async () => {
      answerWith(["song", 0.99], ["c2", 0.97]);

      const judgment = await judgeSearch(
        "evidencias",
        TRACKS,
        queueOf("queued"),
      );

      expect(judgment.similarIds).toEqual([]);
    });
  });
});

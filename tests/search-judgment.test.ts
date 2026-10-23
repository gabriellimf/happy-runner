import { beforeEach, describe, expect, it, vi } from "vitest";

import { APIError, APITimeoutError } from "@typesafe-ai/sdk";

import {
  judgeSearch,
  resetSearchJudgmentCaches,
} from "../lib/search-judgment";
import type { QueueResponse, Track } from "../lib/spotify-responses";
import { MAX_SEARCH_RESULTS } from "../lib/spotify-responses";
import {
  getTypeSafeClient,
  isTypeSafeCircuitOpen,
  logTypeSafeError,
  recordTypeSafeFailure,
  recordTypeSafeSuccess,
} from "../lib/typesafe";

vi.mock("../lib/typesafe", () => ({
  getTypeSafeClient: vi.fn(),
  isTypeSafeCircuitOpen: vi.fn(),
  logTypeSafeError: vi.fn(),
  recordTypeSafeFailure: vi.fn(),
  recordTypeSafeSuccess: vi.fn(),
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
  resetSearchJudgmentCaches();
  vi.mocked(getTypeSafeClient).mockReturnValue({ systemOne } as never);
  vi.mocked(isTypeSafeCircuitOpen).mockReturnValue(false);
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

  it("fails open when TypeSafe client construction throws", async () => {
    const failure = new Error("constructor failed");
    vi.mocked(getTypeSafeClient).mockImplementation(() => {
      throw failure;
    });

    await expect(judgeSearch("evidencias", TRACKS)).resolves.toEqual({
      blocked: false,
      similarIds: [],
    });
    expect(logTypeSafeError).toHaveBeenCalledWith("search-judgment", failure);
    expect(recordTypeSafeFailure).toHaveBeenCalledOnce();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("skips TypeSafe while the circuit breaker is open", async () => {
    vi.mocked(isTypeSafeCircuitOpen).mockReturnValue(true);

    await expect(judgeSearch("evidencias", TRACKS)).resolves.toEqual({
      blocked: false,
      similarIds: [],
    });
    expect(getTypeSafeClient).not.toHaveBeenCalled();
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

  it("fails open and logs a 400 without counting it as a service failure", async () => {
    const failure = new APIError(
      400,
      { detail: "invalid question" },
      new Headers(),
      "Bad Request",
    );
    systemOne.mockRejectedValue(failure);

    await expect(judgeSearch("evidencias", TRACKS)).resolves.toEqual({
      blocked: false,
      similarIds: [],
    });
    expect(recordTypeSafeFailure).toHaveBeenCalledWith(failure);
    expect(logTypeSafeError).toHaveBeenCalledWith("search-judgment", failure);
  });

  it("fails open when the SDK request times out", async () => {
    const failure = new APITimeoutError(2_000);
    systemOne.mockRejectedValue(failure);

    await expect(judgeSearch("timeout-case", TRACKS)).resolves.toEqual({
      blocked: false,
      similarIds: [],
    });
    expect(logTypeSafeError).toHaveBeenCalledWith("search-judgment", failure);
  });

  it.each([
    ["an empty answers object", {}],
    [
      "a missing pick answer",
      {
        intent: { choice: "song", confidence: 0.99, type: "choice" },
      },
    ],
    [
      "a string confidence",
      {
        intent: { choice: "command", confidence: "1", type: "choice" },
        pick: { choice: "c1", confidence: 0.99, type: "choice" },
      },
    ],
    [
      "a NaN confidence",
      {
        intent: { choice: "song", confidence: 0.99, type: "choice" },
        pick: { choice: "c1", confidence: Number.NaN, type: "choice" },
      },
    ],
  ])("fails open for %s", async (_label, answers) => {
    systemOne.mockResolvedValue({ answers });

    await expect(judgeSearch("malformed-answer", TRACKS)).resolves.toEqual({
      blocked: false,
      similarIds: [],
    });
    expect(recordTypeSafeSuccess).not.toHaveBeenCalled();
    expect(recordTypeSafeFailure).toHaveBeenCalledOnce();
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

    it("caches intent and pick for a normalized query and empty queue", async () => {
      answerWith(["song", 0.99], ["c2", 0.97]);
      const emptyQueue: QueueResponse = { nowPlaying: null, next: [] };

      await judgeSearch("EVIDENCIAS", TRACKS, emptyQueue);
      await judgeSearch(" evidencias ", TRACKS, emptyQueue);

      expect(systemOne).toHaveBeenCalledOnce();
    });

    it("keys cached similar answers by queue state", async () => {
      answerWith(["song", 0.99], ["c2", 0.97], {
        similar_c1: 0.8,
        similar_c2: 0.1,
      });
      const firstQueue = queueOf("queued-1");

      await judgeSearch("evidencias", TRACKS, firstQueue);
      await judgeSearch("evidencias", TRACKS, firstQueue);

      expect(systemOne).toHaveBeenCalledOnce();

      answerWith(["song", 0.99], ["c1", 0.97], {
        similar_c1: 0.1,
        similar_c2: 0.9,
      });
      const secondQueue = queueOf("queued-2");
      const judgment = await judgeSearch("evidencias", TRACKS, secondQueue);

      expect(systemOne).toHaveBeenCalledTimes(2);
      expect(Object.keys(systemOne.mock.calls[1][0].questions)).toEqual([
        "similar_c1",
        "similar_c2",
      ]);
      expect(judgment).toEqual({
        autoAddId: "id-2",
        blocked: false,
        similarIds: ["id-2"],
      });
    });

    it("caps candidates before building any TypeSafe questions", async () => {
      const tracks = Array.from({ length: MAX_SEARCH_RESULTS + 2 }, (_, index) =>
        track(`candidate-${index + 1}`, `Faixa ${index + 1}`, "Artista"),
      );
      answerWith(["song", 0.99], [`c${MAX_SEARCH_RESULTS}`, 0.99]);

      const judgment = await judgeSearch("faixas", tracks);
      const request = systemOne.mock.calls[0][0];

      expect(Object.keys(request.state.candidates)).toHaveLength(
        MAX_SEARCH_RESULTS,
      );
      expect(judgment.autoAddId).toBe(tracks[MAX_SEARCH_RESULTS - 1]?.id);
    });

    it.each([
      ["missing", { similar_c1: { noul: 0.99, type: "noul" } }],
      [
        "malformed",
        {
          similar_c1: { noul: 0.99, type: "noul" },
          similar_c2: { noul: "0.1", type: "noul" },
        },
      ],
    ])("does not cache a %s similar answer", async (_label, invalidAnswers) => {
      answerWith(["song", 0.99], ["c2", 0.97]);
      await judgeSearch("evidencias", TRACKS);

      systemOne.mockResolvedValueOnce({ answers: invalidAnswers });
      const queue = queueOf("queued");
      const judgment = await judgeSearch("evidencias", TRACKS, queue);

      expect(judgment).toEqual({
        autoAddId: "id-2",
        blocked: false,
        similarIds: [],
      });
      expect(logTypeSafeError).toHaveBeenLastCalledWith(
        "search-judgment",
        expect.any(TypeError),
      );

      answerWith(["song", 0.99], ["c2", 0.97], {
        similar_c1: 0.99,
        similar_c2: 0.1,
      });
      await expect(judgeSearch("evidencias", TRACKS, queue)).resolves.toEqual({
        autoAddId: "id-2",
        blocked: false,
        similarIds: ["id-1"],
      });
      expect(systemOne).toHaveBeenCalledTimes(3);
    });

    it("keeps a cached pick when the similarity request fails", async () => {
      answerWith(["song", 0.99], ["c2", 0.97]);
      await judgeSearch("evidencias", TRACKS);

      const failure = new APITimeoutError(2_000);
      systemOne.mockRejectedValue(failure);

      await expect(
        judgeSearch("evidencias", TRACKS, queueOf("queued")),
      ).resolves.toEqual({
        autoAddId: "id-2",
        blocked: false,
        similarIds: [],
      });
      expect(logTypeSafeError).toHaveBeenCalledWith("search-judgment", failure);
    });
  });
});

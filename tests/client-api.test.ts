import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addTrack,
  ClientApiError,
  ClientNetworkError,
  fetchQueue,
  searchTracks,
} from "../lib/client/api";
import { CLIENT_MESSAGES, getClientErrorMessage } from "../lib/client/errors";
import type { Track } from "../lib/spotify-responses";

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), { headers, status });
}

function track(): Track {
  return {
    artists: ["Artista"],
    coverUrl: null,
    durationMs: 180_000,
    id: "track-id",
    title: "Música",
    uri: "spotify:track:1234567890123456789012",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("client API", () => {
  it("uses only the same-origin search and queue endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [track()] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ nowPlaying: null, next: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const signal = new AbortController().signal;
    await searchTracks("abba & queen", signal);
    await addTrack(track().uri);
    await fetchQueue();

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/search?q=abba%20%26%20queen",
      expect.objectContaining({ cache: "no-store", method: "GET", signal }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/queue",
      expect.objectContaining({
        body: JSON.stringify({ uri: track().uri }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      "/api/queue",
      expect.objectContaining({ cache: "no-store", method: "GET" }),
    ]);
  });

  it.each([
    ["INVALID_INPUT", CLIENT_MESSAGES.genericError],
    ["NO_ACTIVE_DEVICE", CLIENT_MESSAGES.noActiveDevice],
    ["RATE_LIMITED", CLIENT_MESSAGES.rateLimited],
    ["UPSTREAM_ERROR", CLIENT_MESSAGES.genericError],
    ["INTERNAL_ERROR", CLIENT_MESSAGES.genericError],
    ["UNKNOWN_CODE", CLIENT_MESSAGES.genericError],
  ] as const)("maps API code %s to a pt-BR message", (code, message) => {
    const error = new ClientApiError(500, code, undefined);

    expect(getClientErrorMessage(error, true)).toBe(message);
  });

  it("maps a non-JSON API error body to the generic message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>Gateway error</html>", { status: 502 }),
      ),
    );

    let failure: unknown;

    try {
      await searchTracks("abba");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ClientApiError);
    expect(getClientErrorMessage(failure, true)).toBe(
      CLIENT_MESSAGES.genericError,
    );
  });

  it("maps network failures and offline state to the offline message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    let failure: unknown;

    try {
      await searchTracks("abba");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ClientNetworkError);
    expect(getClientErrorMessage(failure, true)).toBe(CLIENT_MESSAGES.offline);
    expect(
      getClientErrorMessage(
        new ClientApiError(503, "NO_ACTIVE_DEVICE", undefined),
        false,
      ),
    ).toBe(CLIENT_MESSAGES.offline);
  });

  it("reads Retry-After from an API error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { error: { code: "RATE_LIMITED", message: "ignored" } },
          429,
          { "Retry-After": "20" },
        ),
      ),
    );

    let failure: unknown;

    try {
      await fetchQueue();
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 20,
      status: 429,
    });
  });
});

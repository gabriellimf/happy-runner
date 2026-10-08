import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import queueSample from "../docs/samples/queue-response.json";
import { GET as searchGet } from "../app/api/search/route";
import { GET as queueGet, POST as queuePost } from "../app/api/queue/route";
import { apiErrorResponse } from "../lib/api-errors";
import {
  resetSearchCache,
  SpotifyApiError,
  SpotifyConfigError,
} from "../lib/spotify";

const TEST_CLIENT_ID = "test-client-id-not-a-credential";
const TEST_CLIENT_SECRET = "test-client-secret-not-a-credential";
const TEST_REFRESH_TOKEN = "test-refresh-token-not-a-credential";
const TEST_ACCESS_TOKEN = "test-access-token-not-a-credential";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const VALID_TRACK_URI = "spotify:track:0123456789012345678901";
const TEST_MAX_QUEUE_REQUEST_BODY_BYTES = 1_024;

interface ApiRequest {
  init?: RequestInit;
  url: URL;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");

  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function installSpotifyFetch(responses: Response[]): {
  apiRequests: ApiRequest[];
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const queuedResponses = [...responses];
  const apiRequests: ApiRequest[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);

      if (url.href === TOKEN_URL) {
        return jsonResponse({
          access_token: TEST_ACCESS_TOKEN,
          expires_in: 3_600,
          token_type: "Bearer",
        });
      }

      apiRequests.push({ init, url });
      const response = queuedResponses.shift();

      if (!response) {
        throw new Error("Unexpected Spotify API request.");
      }

      return response;
    },
  );

  vi.stubGlobal("fetch", fetchMock);

  return { apiRequests, fetchMock };
}

function searchRequest(query?: string): Request {
  const url =
    query === undefined
      ? "http://localhost/api/search"
      : `http://localhost/api/search?q=${encodeURIComponent(query)}`;

  return new Request(url);
}

function queuePostRequest(body: string): Request {
  return new Request("http://localhost/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function queuePostStreamRequest(bytes: Uint8Array): {
  bytesProduced: () => number;
  request: Request;
  wasCancelled: () => boolean;
} {
  let bytesProduced = 0;
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const byte = bytes[bytesProduced];

        if (byte === undefined) {
          controller.close();
          return;
        }

        controller.enqueue(new Uint8Array([byte]));
        bytesProduced += 1;
      },
      cancel() {
        wasCancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const requestInit: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
  };

  return {
    bytesProduced: () => bytesProduced,
    request: new Request("http://localhost/api/queue", requestInit),
    wasCancelled: () => wasCancelled,
  };
}

function validSearchTrack() {
  return {
    type: "track",
    id: "sample-track-id",
    uri: "spotify:track:abcdefghijklmnopqrstuv",
    name: "Sample song",
    artists: [{ name: "Sample artist" }],
    duration_ms: 123_456,
    album: {
      images: [
        { url: "https://images.example/640.jpg", width: 640 },
        { url: "https://images.example/300.jpg", width: 300 },
        { url: "https://images.example/64.jpg", width: 64 },
      ],
    },
  };
}

beforeEach(() => {
  vi.stubEnv("SPOTIFY_CLIENT_ID", TEST_CLIENT_ID);
  vi.stubEnv("SPOTIFY_CLIENT_SECRET", TEST_CLIENT_SECRET);
  vi.stubEnv("SPOTIFY_REFRESH_TOKEN", TEST_REFRESH_TOKEN);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected Spotify request.");
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetSearchCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/search", () => {
  it.each([
    ["missing", undefined],
    ["short", "abc"],
    ["trimmed short", "  abc  "],
  ])("rejects a %s query", async (_label, query) => {
    const response = await searchGet(searchRequest(query));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "Digite pelo menos 4 caracteres",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects queries longer than 100 characters after trimming", async () => {
    const response = await searchGet(searchRequest(` ${"a".repeat(101)} `));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "A busca deve ter no máximo 100 caracteres",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a raw query longer than 400 UTF-16 code units before trimming", async () => {
    const response = await searchGet(searchRequest("a".repeat(401)));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "A busca deve ter no máximo 100 caracteres",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a query with exactly 100 characters", async () => {
    const query = "a".repeat(100);
    const { apiRequests } = installSpotifyFetch([
      jsonResponse({ tracks: { items: [] } }),
    ]);

    const response = await searchGet(searchRequest(query));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0]?.url.searchParams.get("q")).toBe(query);
  });

  it("counts a surrogate-pair emoji as one query character", async () => {
    const query = "🎵abc";
    const { apiRequests } = installSpotifyFetch([
      jsonResponse({ tracks: { items: [] } }),
    ]);

    const response = await searchGet(searchRequest(query));

    expect(response.status).toBe(200);
    expect(apiRequests[0]?.url.searchParams.get("q")).toBe(query);
  });

  it("returns mapped tracks and caches by trimmed lowercase query", async () => {
    const track = validSearchTrack();
    const { apiRequests } = installSpotifyFetch([
      jsonResponse({
        tracks: {
          items: [
            track,
            { ...track, type: "episode" },
            { ...track, duration_ms: "123456" },
            { ...track, artists: [{ name: null }] },
          ],
        },
      }),
    ]);

    const firstResponse = await searchGet(searchRequest("  Song  "));
    const secondResponse = await searchGet(searchRequest("song"));

    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({
      items: [
        {
          id: "sample-track-id",
          uri: "spotify:track:abcdefghijklmnopqrstuv",
          title: "Sample song",
          artists: ["Sample artist"],
          coverUrl: "https://images.example/300.jpg",
          durationMs: 123_456,
        },
      ],
    });
    expect(await secondResponse.json()).toEqual({
      items: [
        {
          id: "sample-track-id",
          uri: "spotify:track:abcdefghijklmnopqrstuv",
          title: "Sample song",
          artists: ["Sample artist"],
          coverUrl: "https://images.example/300.jpg",
          durationMs: 123_456,
        },
      ],
    });
    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0]?.url.pathname).toBe("/v1/search");
    expect({
      limit: apiRequests[0]?.url.searchParams.get("limit"),
      market: apiRequests[0]?.url.searchParams.get("market"),
      query: apiRequests[0]?.url.searchParams.get("q"),
      type: apiRequests[0]?.url.searchParams.get("type"),
    }).toEqual({
      limit: "5",
      market: "BR",
      query: "Song",
      type: "track",
    });
  });

  it("returns an empty item list when Spotify finds no tracks", async () => {
    installSpotifyFetch([jsonResponse({ tracks: { items: [] } })]);

    const response = await searchGet(searchRequest("none"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  it("does not cache failed Spotify searches", async () => {
    const { apiRequests } = installSpotifyFetch([
      jsonResponse({ error: { message: "private upstream message" } }, 500),
      jsonResponse({ tracks: { items: [] } }),
    ]);

    const failedResponse = await searchGet(searchRequest("Song"));
    const successfulResponse = await searchGet(searchRequest("song"));

    expect(failedResponse.status).toBe(502);
    expect(await failedResponse.json()).toEqual({
      error: {
        code: "UPSTREAM_ERROR",
        message: "Algo deu errado, tente de novo",
      },
    });
    expect(successfulResponse.status).toBe(200);
    expect(apiRequests).toHaveLength(2);
  });

  it("maps Spotify rate limits without exposing the upstream body", async () => {
    installSpotifyFetch([
      jsonResponse(
        { error: { message: "private upstream message", reason: "QUOTA_EXCEEDED" } },
        429,
        { "Retry-After": "6.2" },
      ),
    ]);

    const response = await searchGet(searchRequest("Song"));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(await response.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Muita gente pedindo, tente de novo",
      },
    });
  });

  it("maps rate limits even when Spotify returns a non-JSON error body", async () => {
    installSpotifyFetch([
      new Response("private upstream message", {
        status: 429,
        headers: { "Retry-After": "8" },
      }),
    ]);

    const response = await searchGet(searchRequest("Song"));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("8");
    expect(await response.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Muita gente pedindo, tente de novo",
      },
    });
  });
});

describe("POST /api/queue", () => {
  it("adds a valid track URI without a body or device_id", async () => {
    const { apiRequests } = installSpotifyFetch([
      new Response(null, { status: 204 }),
    ]);

    const response = await queuePost(
      queuePostRequest(JSON.stringify({ uri: VALID_TRACK_URI })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0]?.url.pathname).toBe("/v1/me/player/queue");
    expect(apiRequests[0]?.url.searchParams.get("uri")).toBe(VALID_TRACK_URI);
    expect(apiRequests[0]?.url.href).toContain(
      "uri=spotify%3Atrack%3A0123456789012345678901",
    );
    expect(apiRequests[0]?.url.searchParams.has("device_id")).toBe(false);
    expect(apiRequests[0]?.init?.method).toBe("POST");
    expect(apiRequests[0]?.init?.body).toBeUndefined();
  });

  it("treats a non-JSON 2xx body as a successful add", async () => {
    installSpotifyFetch([
      new Response("x".repeat(27), { status: 200 }),
    ]);

    const response = await queuePost(
      queuePostRequest(JSON.stringify({ uri: VALID_TRACK_URI })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects a body above the limit when Content-Length is too large", async () => {
    const body = " ".repeat(TEST_MAX_QUEUE_REQUEST_BODY_BYTES + 1);
    const request = new Request("http://localhost/api/queue", {
      method: "POST",
      headers: {
        "Content-Length": String(new TextEncoder().encode(body).byteLength),
        "Content-Type": "application/json",
      },
      body,
    });

    const response = await queuePost(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "URI de música inválida",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops reading a streamed body after one byte exceeds the limit", async () => {
    const serializedBody = JSON.stringify({ uri: VALID_TRACK_URI });
    const bodyText = `${serializedBody}${" ".repeat(
      TEST_MAX_QUEUE_REQUEST_BODY_BYTES + 1 - serializedBody.length,
    )}`;
    const streamedRequest = queuePostStreamRequest(
      new TextEncoder().encode(bodyText),
    );

    expect(streamedRequest.request.headers.has("Content-Length")).toBe(false);

    const response = await queuePost(streamedRequest.request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "URI de música inválida",
      },
    });
    expect(streamedRequest.bytesProduced()).toBe(
      TEST_MAX_QUEUE_REQUEST_BODY_BYTES + 1,
    );
    expect(streamedRequest.wasCancelled()).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a valid JSON body exactly at the size limit", async () => {
    const serializedBody = JSON.stringify({ uri: VALID_TRACK_URI });
    const paddingLength =
      TEST_MAX_QUEUE_REQUEST_BODY_BYTES -
      new TextEncoder().encode(serializedBody).byteLength;
    const body = `${serializedBody}${" ".repeat(paddingLength)}`;
    installSpotifyFetch([new Response(null, { status: 204 })]);

    expect(new TextEncoder().encode(body).byteLength).toBe(
      TEST_MAX_QUEUE_REQUEST_BODY_BYTES,
    );

    const response = await queuePost(queuePostRequest(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it.each([
    ["missing URI", {}],
    ["null URI", { uri: null }],
    ["non-string URI", { uri: 123 }],
    ["episode URI", { uri: `spotify:episode:${"a".repeat(22)}` }],
    ["Spotify URL", { uri: "https://open.spotify.com/track/123" }],
    ["local URI", { uri: "spotify:local:artist:album:title:1" }],
    ["short track ID", { uri: "spotify:track:short" }],
    ["track ID with wrong length", { uri: `spotify:track:${"a".repeat(23)}` }],
    ["track URI with whitespace", { uri: ` ${VALID_TRACK_URI}` }],
  ])("rejects a %s", async (_label, body) => {
    const response = await queuePost(queuePostRequest(JSON.stringify(body)));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "URI de música inválida",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and a missing body", async () => {
    const malformedResponse = await queuePost(queuePostRequest("{"));
    const missingBodyResponse = await queuePost(
      new Request("http://localhost/api/queue", { method: "POST" }),
    );

    expect(malformedResponse.status).toBe(400);
    expect(missingBodyResponse.status).toBe(400);
    expect(await malformedResponse.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "URI de música inválida",
      },
    });
    expect(await missingBodyResponse.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "URI de música inválida",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps every player endpoint 404 to the offline error", async () => {
    installSpotifyFetch([
      jsonResponse(
        { error: { message: "private upstream message" } },
        404,
      ),
    ]);

    const response = await queuePost(
      queuePostRequest(JSON.stringify({ uri: VALID_TRACK_URI })),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "NO_ACTIVE_DEVICE",
        message: "Player offline, tente em instantes",
      },
    });
  });

  it("maps NO_ACTIVE_DEVICE reasons regardless of upstream status", async () => {
    installSpotifyFetch([
      jsonResponse(
        { error: { reason: "NO_ACTIVE_DEVICE", message: "private message" } },
        403,
      ),
    ]);

    const response = await queuePost(
      queuePostRequest(JSON.stringify({ uri: VALID_TRACK_URI })),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "NO_ACTIVE_DEVICE",
        message: "Player offline, tente em instantes",
      },
    });
  });

  it("maps Spotify 5xx errors to a generic upstream error", async () => {
    installSpotifyFetch([
      jsonResponse({ error: { message: "private upstream message" } }, 503),
    ]);

    const response = await queuePost(
      queuePostRequest(JSON.stringify({ uri: VALID_TRACK_URI })),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "UPSTREAM_ERROR",
        message: "Algo deu errado, tente de novo",
      },
    });
  });

  it("maps Spotify 429 errors and rounds Retry-After up to seconds", async () => {
    installSpotifyFetch([
      jsonResponse(
        { error: { message: "private upstream message", reason: "QUOTA_EXCEEDED" } },
        429,
        { "Retry-After": "6.2" },
      ),
    ]);

    const response = await queuePost(
      queuePostRequest(JSON.stringify({ uri: VALID_TRACK_URI })),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(await response.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Muita gente pedindo, tente de novo",
      },
    });
  });
});

describe("GET /api/queue", () => {
  it("returns mapped queue tracks in Spotify order", async () => {
    const { apiRequests } = installSpotifyFetch([jsonResponse(queueSample)]);
    const response = await queueGet();
    const playing = queueSample.currently_playing;
    const firstQueuedTrack = queueSample.queue[0];

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(apiRequests[0]?.url.pathname).toBe("/v1/me/player/queue");
    expect(apiRequests[0]?.init?.method).toBeUndefined();
    expect(await response.json()).toEqual({
      nowPlaying: {
        id: playing.id,
        title: playing.name,
        artists: playing.artists.map((artist) => artist.name),
        coverUrl:
          playing.album.images.find((image) => image.width === 300)?.url ??
          playing.album.images[0]?.url ??
          null,
      },
      next: queueSample.queue.map((track) => ({
        id: track.id,
        title: track.name,
        artists: track.artists.map((artist) => artist.name),
        coverUrl:
          track.album.images.find((image) => image.width === 300)?.url ??
          track.album.images[0]?.url ??
          null,
      })),
    });
    expect(firstQueuedTrack.type).toBe("track");
  });

  it("drops non-track and malformed queue items", async () => {
    const firstTrack = queueSample.queue[0];
    const responseBody = {
      ...queueSample,
      queue: [
        ...queueSample.queue,
        { ...firstTrack, type: "episode" },
        { type: "ad" },
        { ...firstTrack, id: null },
        { ...firstTrack, artists: [{ name: null }] },
      ],
    };
    const { apiRequests } = installSpotifyFetch([jsonResponse(responseBody)]);

    const response = await queueGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.next).toHaveLength(queueSample.queue.length);
    expect(body.next.map((track: { id: string }) => track.id)).toEqual(
      queueSample.queue.map((track) => track.id),
    );
    expect(apiRequests).toHaveLength(1);
  });

  it("returns an empty queue when nothing is playing", async () => {
    installSpotifyFetch([
      jsonResponse({ ...queueSample, currently_playing: null }),
    ]);

    const response = await queueGet();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ nowPlaying: null, next: [] });
  });

  it("returns an empty queue when currently_playing is absent", async () => {
    installSpotifyFetch([jsonResponse({ queue: queueSample.queue })]);

    const response = await queueGet();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ nowPlaying: null, next: [] });
  });

  it("returns an empty queue when Spotify returns an empty body", async () => {
    installSpotifyFetch([new Response(null, { status: 200 })]);

    const response = await queueGet();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ nowPlaying: null, next: [] });
  });

  it("tolerates a missing queue array", async () => {
    installSpotifyFetch([
      jsonResponse({ currently_playing: queueSample.currently_playing }),
    ]);

    const response = await queueGet();
    const playing = queueSample.currently_playing;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      nowPlaying: {
        id: playing.id,
        title: playing.name,
        artists: playing.artists.map((artist) => artist.name),
        coverUrl:
          playing.album.images.find((image) => image.width === 300)?.url ??
          playing.album.images[0]?.url ??
          null,
      },
      next: [],
    });
  });

  it("maps player endpoint 404 responses to the offline error", async () => {
    installSpotifyFetch([
      jsonResponse({ error: { message: "private upstream message" } }, 404),
    ]);

    const response = await queueGet();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "NO_ACTIVE_DEVICE",
        message: "Player offline, tente em instantes",
      },
    });
  });

  it("maps player endpoint 429 responses without exposing the upstream body", async () => {
    installSpotifyFetch([
      jsonResponse(
        { error: { message: "private upstream message", reason: "QUOTA_EXCEEDED" } },
        429,
        { "Retry-After": "8" },
      ),
    ]);

    const response = await queueGet();

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("8");
    expect(await response.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Muita gente pedindo, tente de novo",
      },
    });
  });
});

describe("central API error mapping", () => {
  it("returns generic internal errors and logs only safe metadata", async () => {
    const consoleError = vi.spyOn(console, "error");
    const response = apiErrorResponse(
      new SpotifyConfigError("SPOTIFY_CLIENT_SECRET"),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Algo deu errado, tente de novo",
      },
    });
    expect(consoleError).toHaveBeenCalledWith({
      errorClass: "SpotifyConfigError",
      status: undefined,
      reason: undefined,
    });
  });

  it("maps unknown Spotify API failures to a generic upstream error", async () => {
    const response = apiErrorResponse(
      new SpotifyApiError(400, "private upstream message"),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "UPSTREAM_ERROR",
        message: "Algo deu errado, tente de novo",
      },
    });
  });
});

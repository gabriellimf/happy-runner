import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_CLIENT_ID = "test-client-id-not-a-credential";
const TEST_CLIENT_SECRET = "test-client-secret-not-a-credential";
const TEST_REFRESH_TOKEN = "test-refresh-token-not-a-credential";
const TEST_ACCESS_TOKEN = "test-access-token-not-a-credential";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

async function loadSpotify() {
  vi.resetModules();
  return import("../lib/spotify");
}

function tokenResponse(
  accessToken = TEST_ACCESS_TOKEN,
  expiresIn = 3_600,
): Response {
  return jsonResponse({
    access_token: accessToken,
    expires_in: expiresIn,
    token_type: "Bearer",
  });
}

function fetchUntilAborted(
  signal: AbortSignal | null | undefined,
  onAbort?: (reason: unknown) => void,
): Promise<Response> {
  if (!signal) {
    return Promise.reject(new Error("The mocked fetch needs an abort signal."));
  }

  return new Promise<Response>((_resolve, reject) => {
    const rejectOnAbort = () => {
      onAbort?.(signal.reason);
      reject(signal.reason);
    };

    if (signal.aborted) {
      rejectOnAbort();
      return;
    }

    signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
}

function responseWithStalledBody(
  signal: AbortSignal | null | undefined,
  status = 200,
  headers?: HeadersInit,
): Response {
  if (!signal) {
    throw new Error("The mocked fetch needs an abort signal.");
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      const errorOnAbort = () => controller.error(signal.reason);

      if (signal.aborted) {
        errorOnAbort();
      } else {
        signal.addEventListener("abort", errorOnAbort, { once: true });
      }
    },
  });

  return new Response(body, { status, headers });
}

function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected the request to reject.");
    },
    (error: unknown) => error,
  );
}

beforeEach(() => {
  vi.stubEnv("SPOTIFY_CLIENT_ID", TEST_CLIENT_ID);
  vi.stubEnv("SPOTIFY_CLIENT_SECRET", TEST_CLIENT_SECRET);
  vi.stubEnv("SPOTIFY_REFRESH_TOKEN", TEST_REFRESH_TOKEN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Spotify request adapter", () => {
  it("reuses a cached token and sends it as a bearer token", async () => {
    const spotify = await loadSpotify();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: 1 }))
      .mockResolvedValueOnce(jsonResponse({ value: 2 }));

    vi.stubGlobal("fetch", fetchMock);

    await spotify.request("/me");
    await spotify.request("/me/player/queue");

    const tokenCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === TOKEN_URL,
    );
    const apiCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) !== TOKEN_URL,
    );

    expect(tokenCalls).toHaveLength(1);
    expect(apiCalls).toHaveLength(2);
    expect(
      new Headers(apiCalls[0][1]?.headers).get("Authorization"),
    ).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
  });

  it("refreshes the token when the 60 second safety margin passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));

    const spotify = await loadSpotify();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse("first-access-token"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(tokenResponse("second-access-token"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    vi.stubGlobal("fetch", fetchMock);

    await spotify.request("/me");
    vi.setSystemTime(Date.now() + 3_540_000);
    await spotify.request("/me");

    const tokenCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === TOKEN_URL,
    );
    const apiCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) !== TOKEN_URL,
    );

    expect(tokenCalls).toHaveLength(2);
    expect(
      new Headers(apiCalls[0][1]?.headers).get("Authorization"),
    ).toBe("Bearer first-access-token");
    expect(
      new Headers(apiCalls[1][1]?.headers).get("Authorization"),
    ).toBe("Bearer second-access-token");
  });

  it("shares one token refresh across concurrent requests", async () => {
    const spotify = await loadSpotify();
    let resolveToken!: (response: Response) => void;
    const tokenPromise = new Promise<Response>((resolve) => {
      resolveToken = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>((input) => {
      if (String(input) === TOKEN_URL) {
        return tokenPromise;
      }

      return Promise.resolve(jsonResponse({ ok: true }));
    });

    vi.stubGlobal("fetch", fetchMock);

    const firstRequest = spotify.request("/me");
    const secondRequest = spotify.request("/me/player/queue");

    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === TOKEN_URL),
    ).toHaveLength(1);

    resolveToken(tokenResponse());
    await Promise.all([firstRequest, secondRequest]);
  });

  it("does not let one caller abort a shared token refresh", async () => {
    const spotify = await loadSpotify();
    let resolveToken!: (response: Response) => void;
    const tokenPromise = new Promise<Response>((resolve) => {
      resolveToken = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (String(input) === TOKEN_URL) {
        const signal = init?.signal;

        return new Promise<Response>((resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }

          signal?.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
          void tokenPromise.then(resolve, reject);
        });
      }

      if (init?.signal?.aborted) {
        return Promise.reject(init.signal.reason);
      }

      return Promise.resolve(jsonResponse({ ok: true }));
    });

    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const firstRequest = spotify.requestRaw("/me", {
      signal: controller.signal,
    });
    const secondRequest = spotify.requestRaw("/me/player/queue");
    const firstExpectation = expect(firstRequest).rejects.toMatchObject({
      message: "Spotify API request was aborted.",
    });
    const secondExpectation = expect(secondRequest).resolves.toMatchObject({
      status: 200,
      bodyText: '{"ok":true}',
    });
    const tokenCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === TOKEN_URL,
    );

    expect(tokenCalls).toHaveLength(1);
    controller.abort();
    resolveToken(tokenResponse());

    await Promise.all([firstExpectation, secondExpectation]);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === TOKEN_URL),
    ).toHaveLength(1);
  });

  it("waits for a short Retry-After value and retries once", async () => {
    vi.useFakeTimers();

    const spotify = await loadSpotify();
    let apiCallCount = 0;
    const fetchMock = vi.fn<typeof fetch>((input) => {
      if (String(input) === TOKEN_URL) {
        return Promise.resolve(tokenResponse());
      }

      apiCallCount += 1;
      return Promise.resolve(
        apiCallCount === 1
          ? jsonResponse(
              { message: "Too many requests", reason: "RATE_LIMITED" },
              429,
              { "Retry-After": "3" },
            )
          : jsonResponse({ ok: true }),
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const requestPromise = spotify.request<{ ok: boolean }>("/me");
    await vi.advanceTimersByTimeAsync(0);

    expect(apiCallCount).toBe(1);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(apiCallCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(requestPromise).resolves.toEqual({ ok: true });
    expect(apiCallCount).toBe(2);
  });

  it("waits and retries once when Retry-After is exactly 5 seconds", async () => {
    vi.useFakeTimers();

    const spotify = await loadSpotify();
    let apiCallCount = 0;
    const fetchMock = vi.fn<typeof fetch>((input) => {
      if (String(input) === TOKEN_URL) {
        return Promise.resolve(tokenResponse());
      }

      apiCallCount += 1;
      return Promise.resolve(
        apiCallCount === 1
          ? jsonResponse(
              { message: "Too many requests", reason: "RATE_LIMITED" },
              429,
              { "Retry-After": "5" },
            )
          : jsonResponse({ ok: true }),
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const requestPromise = spotify.request<{ ok: boolean }>("/me");
    await vi.advanceTimersByTimeAsync(0);
    expect(apiCallCount).toBe(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(apiCallCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(requestPromise).resolves.toEqual({ ok: true });
    expect(apiCallCount).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("throws a rate-limit error when Retry-After exceeds the retry cap", async () => {
    const spotify = await loadSpotify();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "Too many requests", reason: "QUOTA_EXCEEDED" },
          429,
          { "Retry-After": "6" },
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(spotify.request("/me")).rejects.toMatchObject({
      message: "Too many requests",
      reason: "QUOTA_EXCEEDED",
      retryAfterSeconds: 6,
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a rate-limit error after a second 429 and preserves its header", async () => {
    vi.useFakeTimers();

    const spotify = await loadSpotify();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "Too many requests", reason: "RATE_LIMITED" },
          429,
          { "Retry-After": "1" },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "Quota exceeded", reason: "QUOTA_EXCEEDED" },
          429,
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    const requestPromise = spotify.request("/me");
    const rateLimitExpectation = expect(requestPromise).rejects.toMatchObject({
      message: "Quota exceeded",
      reason: "QUOTA_EXCEEDED",
      retryAfterSeconds: undefined,
      status: 429,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await rateLimitExpectation;
  });

  it("adds query parameters and serializes JSON request bodies", async () => {
    const spotify = await loadSpotify();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ queued: true }));

    vi.stubGlobal("fetch", fetchMock);

    await spotify.request("/me/player/queue", {
      body: { uri: "spotify:track:test" },
      method: "POST",
      query: { position: 2, market: "BR" },
    });

    const [requestUrl, requestInit] = fetchMock.mock.calls[1];

    expect(String(requestUrl)).toBe(
      "https://api.spotify.com/v1/me/player/queue?position=2&market=BR",
    );
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(requestInit?.body).toBe(JSON.stringify({ uri: "spotify:track:test" }));
  });

  it("maps Spotify status, message, and reason to the API error", async () => {
    const spotify = await loadSpotify();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message: "No active device found.",
              reason: "NO_ACTIVE_DEVICE",
              status: 404,
            },
          },
          404,
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(spotify.request("/me/player/queue")).rejects.toMatchObject({
      message: "No active device found.",
      reason: "NO_ACTIVE_DEVICE",
      status: 404,
    });
  });

  it("maps invalid_grant to an auth error without exposing credentials", async () => {
    const spotify = await loadSpotify();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        { error: "invalid_grant", error_description: "Refresh token expired" },
        400,
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const error = await spotify
      .request("/me")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(spotify.SpotifyAuthError);

    const errorMessage = error instanceof Error ? error.message : "";
    for (const secret of [
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET,
      TEST_REFRESH_TOKEN,
    ]) {
      expect(errorMessage).not.toContain(secret);
    }
    expect(errorMessage).toContain("scripts/get-refresh-token.ts");
  });

  it("names a missing environment variable without exposing its value", async () => {
    vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "");

    const spotify = await loadSpotify();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(spotify.request("/me")).rejects.toMatchObject({
      message: "Missing required environment variable SPOTIFY_REFRESH_TOKEN.",
      variable: "SPOTIFY_REFRESH_TOKEN",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined for 204 responses and empty success bodies", async () => {
    const spotify = await loadSpotify();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    await expect(spotify.request("/me/player/queue")).resolves.toBeUndefined();
    await expect(spotify.request("/me/player/queue")).resolves.toBeUndefined();
  });

  it("uses refresh grant form data and Basic client authentication", async () => {
    const spotify = await loadSpotify();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    vi.stubGlobal("fetch", fetchMock);

    await spotify.request("/me");

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    const tokenHeaders = new Headers(tokenInit?.headers);
    const tokenBody = new URLSearchParams(String(tokenInit?.body));

    expect(String(tokenUrl)).toBe(TOKEN_URL);
    expect(tokenInit?.method).toBe("POST");
    expect(tokenHeaders.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(tokenHeaders.get("Authorization")).toBe(
      `Basic ${Buffer.from(
        `${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`,
        "utf8",
      ).toString("base64")}`,
    );
    expect(Object.fromEntries(tokenBody)).toEqual({
      grant_type: "refresh_token",
      refresh_token: TEST_REFRESH_TOKEN,
    });
  });

  it("redacts configured credentials and the access token from API errors", async () => {
    const spotify = await loadSpotify();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message: `${TEST_CLIENT_ID} ${TEST_CLIENT_SECRET} ${TEST_REFRESH_TOKEN} ${TEST_ACCESS_TOKEN}`,
              reason: `${TEST_CLIENT_SECRET} ${TEST_ACCESS_TOKEN}`,
            },
          },
          500,
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    const error = await spotify
      .request("/me")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(spotify.SpotifyApiError);

    if (!(error instanceof spotify.SpotifyApiError)) {
      throw new Error("Expected a Spotify API error.");
    }

    for (const secret of [
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET,
      TEST_REFRESH_TOKEN,
      TEST_ACCESS_TOKEN,
    ]) {
      expect(error.message).not.toContain(secret);
      expect(error.reason).not.toContain(secret);
    }
  });

  it("preserves network failures as the cause of a typed API error", async () => {
    const spotify = await loadSpotify();
    const networkCause = new Error("socket unavailable");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(networkCause);

    vi.stubGlobal("fetch", fetchMock);

    const error = await spotify
      .request("/me")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(spotify.SpotifyApiError);

    if (!(error instanceof spotify.SpotifyApiError)) {
      throw new Error("Expected a Spotify API error.");
    }

    expect(error.cause).toBe(networkCause);
    expect(error.message).toBe(
      "Spotify API request failed due to a network error.",
    );
  });

  it("preserves token refresh network failures and retries on the next request", async () => {
    vi.useFakeTimers();

    const spotify = await loadSpotify();
    const networkCause = new Error("token endpoint unavailable");
    let tokenCallCount = 0;
    const fetchMock = vi.fn<typeof fetch>((input) => {
      if (String(input) === TOKEN_URL) {
        tokenCallCount += 1;

        return tokenCallCount === 1
          ? Promise.reject(networkCause)
          : Promise.resolve(tokenResponse());
      }

      return Promise.resolve(jsonResponse({ ok: true }));
    });

    vi.stubGlobal("fetch", fetchMock);

    const firstErrorPromise = captureRejection(spotify.request("/me"));
    await vi.advanceTimersByTimeAsync(0);
    const error = await firstErrorPromise;

    expect(error).toBeInstanceOf(spotify.SpotifyApiError);

    if (!(error instanceof spotify.SpotifyApiError)) {
      throw new Error("Expected a Spotify API error.");
    }

    expect(error.message).toBe(
      "Spotify token refresh request failed due to a network error.",
    );
    expect(error.cause).toBe(networkCause);
    expect(vi.getTimerCount()).toBe(0);

    await expect(spotify.request<{ ok: boolean }>("/me")).resolves.toEqual({
      ok: true,
    });
    expect(tokenCallCount).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out an API fetch after 10 seconds and clears its timer", async () => {
    vi.useFakeTimers();

    const spotify = await loadSpotify();
    const abortReasons: unknown[] = [];
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (String(input) === TOKEN_URL) {
        return Promise.resolve(tokenResponse());
      }

      return fetchUntilAborted(init?.signal, (reason) => {
        abortReasons.push(reason);
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const errorPromise = captureRejection(spotify.request("/me"));
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(spotify.SpotifyApiError);

    if (!(error instanceof spotify.SpotifyApiError)) {
      throw new Error("Expected a Spotify API error.");
    }

    expect(error.message).toBe("Spotify API request timed out after 10 seconds.");
    expect(abortReasons).toHaveLength(1);
    expect(error.cause).toBe(abortReasons[0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out while reading an API response body and clears its timer", async () => {
    vi.useFakeTimers();

    const spotify = await loadSpotify();
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (String(input) === TOKEN_URL) {
        return Promise.resolve(tokenResponse());
      }

      return Promise.resolve(responseWithStalledBody(init?.signal));
    });

    vi.stubGlobal("fetch", fetchMock);

    const errorPromise = captureRejection(spotify.request("/me"));
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(spotify.SpotifyApiError);

    if (!(error instanceof spotify.SpotifyApiError)) {
      throw new Error("Expected a Spotify API error.");
    }

    expect(error.message).toBe("Spotify API request timed out after 10 seconds.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out token refresh and lets the next request retry", async () => {
    vi.useFakeTimers();

    const spotify = await loadSpotify();
    const abortReasons: unknown[] = [];
    let tokenCallCount = 0;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (String(input) === TOKEN_URL) {
        tokenCallCount += 1;

        if (tokenCallCount === 1) {
          return fetchUntilAborted(init?.signal, (reason) => {
            abortReasons.push(reason);
          });
        }

        return Promise.resolve(tokenResponse());
      }

      return Promise.resolve(jsonResponse({ ok: true }));
    });

    vi.stubGlobal("fetch", fetchMock);

    const errorPromise = captureRejection(spotify.request("/me"));
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(spotify.SpotifyApiError);

    if (!(error instanceof spotify.SpotifyApiError)) {
      throw new Error("Expected a Spotify API error.");
    }

    expect(error.message).toBe(
      "Spotify token refresh request timed out after 10 seconds.",
    );
    expect(abortReasons).toHaveLength(1);
    expect(error.cause).toBe(abortReasons[0]);
    expect(vi.getTimerCount()).toBe(0);

    await expect(spotify.request<{ ok: boolean }>("/me")).resolves.toEqual({
      ok: true,
    });
    expect(tokenCallCount).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out while reading the token response body and retries the refresh", async () => {
    vi.useFakeTimers();

    const spotify = await loadSpotify();
    let tokenCallCount = 0;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (String(input) === TOKEN_URL) {
        tokenCallCount += 1;

        return Promise.resolve(
          tokenCallCount === 1
            ? responseWithStalledBody(init?.signal)
            : tokenResponse(),
        );
      }

      return Promise.resolve(jsonResponse({ ok: true }));
    });

    vi.stubGlobal("fetch", fetchMock);

    const errorPromise = captureRejection(spotify.request("/me"));
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(spotify.SpotifyApiError);

    if (!(error instanceof spotify.SpotifyApiError)) {
      throw new Error("Expected a Spotify API error.");
    }

    expect(error.message).toBe(
      "Spotify token refresh request timed out after 10 seconds.",
    );
    expect(vi.getTimerCount()).toBe(0);

    await expect(spotify.request<{ ok: boolean }>("/me")).resolves.toEqual({
      ok: true,
    });
    expect(tokenCallCount).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps caller aborts distinct from timeouts and preserves the caller reason", async () => {
    vi.useFakeTimers();

    const spotify = await loadSpotify();
    const callerController = new AbortController();
    const callerReason = new Error("caller cancelled the request");
    let apiSignal: AbortSignal | null | undefined;
    let abortReason: unknown;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (String(input) === TOKEN_URL) {
        return Promise.resolve(tokenResponse());
      }

      apiSignal = init?.signal;
      return fetchUntilAborted(apiSignal, (reason) => {
        abortReason = reason;
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const errorPromise = captureRejection(
      spotify.request("/me", { signal: callerController.signal }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(apiSignal).toBeDefined();

    callerController.abort(callerReason);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(spotify.SpotifyApiError);

    if (!(error instanceof spotify.SpotifyApiError)) {
      throw new Error("Expected a Spotify API error.");
    }

    expect(error.message).toBe("Spotify API request was aborted.");
    expect(error.message).not.toContain("timed out");
    expect(error.cause).toBe(callerReason);
    expect(abortReason).toBe(callerReason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears timeout timers after a fast response", async () => {
    vi.useFakeTimers();

    const spotify = await loadSpotify();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    vi.stubGlobal("fetch", fetchMock);

    await expect(spotify.request<{ ok: boolean }>("/me")).resolves.toEqual({
      ok: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives the API retry a fresh timeout signal after a 429", async () => {
    vi.useFakeTimers();

    const spotify = await loadSpotify();
    const apiSignals: AbortSignal[] = [];
    let apiCallCount = 0;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (String(input) === TOKEN_URL) {
        return Promise.resolve(tokenResponse());
      }

      if (init?.signal) {
        apiSignals.push(init.signal);
      }

      apiCallCount += 1;
      return Promise.resolve(
        apiCallCount === 1
          ? jsonResponse(
              { message: "Too many requests", reason: "RATE_LIMITED" },
              429,
              { "Retry-After": "1" },
            )
          : jsonResponse({ ok: true }),
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const requestPromise = spotify.request<{ ok: boolean }>("/me");
    await vi.advanceTimersByTimeAsync(0);
    expect(apiCallCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(requestPromise).resolves.toEqual({ ok: true });

    expect(apiSignals).toHaveLength(2);
    expect(apiSignals[1]).not.toBe(apiSignals[0]);
    expect(apiSignals[1].aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a fresh body-read timeout after a 429 retry wait", async () => {
    vi.useFakeTimers();

    const spotify = await loadSpotify();
    const apiSignals: AbortSignal[] = [];
    let apiCallCount = 0;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (String(input) === TOKEN_URL) {
        return Promise.resolve(tokenResponse());
      }

      if (init?.signal) {
        apiSignals.push(init.signal);
      }

      apiCallCount += 1;

      return Promise.resolve(
        apiCallCount === 1
          ? jsonResponse(
              { message: "Too many requests", reason: "RATE_LIMITED" },
              429,
              { "Retry-After": "2" },
            )
          : responseWithStalledBody(init?.signal),
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const errorPromise = captureRejection(spotify.request("/me"));
    await vi.advanceTimersByTimeAsync(0);
    expect(apiCallCount).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(apiCallCount).toBe(2);
    expect(apiSignals[1].aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(spotify.SpotifyApiError);

    if (!(error instanceof spotify.SpotifyApiError)) {
      throw new Error("Expected a Spotify API error.");
    }

    expect(error.message).toBe("Spotify API request timed out after 10 seconds.");
    expect(vi.getTimerCount()).toBe(0);
  });
});

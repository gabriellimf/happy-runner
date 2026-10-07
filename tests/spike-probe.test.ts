import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  allowlistedHeaders,
  buildOutputPath,
  redact,
  runCli,
  summarizeDevices,
  summarizeQueue,
  writeQueueSample,
} from "../scripts/spike-probe";
import type { ProbeOverrides } from "../scripts/spike-probe";

const TEST_CLIENT_ID = "probe-test-client-id";
const TEST_CLIENT_SECRET = "probe-test-client-secret";
const TEST_REFRESH_TOKEN = "probe-test-refresh-token";
const TEST_ACCESS_TOKEN = "probe-test-access-token";
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

function mockSpotifyFetch(
  respond: (url: URL, init: RequestInit | undefined) => Response,
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    if (String(input) === TOKEN_URL) {
      return Promise.resolve(
        jsonResponse({
          access_token: TEST_ACCESS_TOKEN,
          expires_in: 3_600,
          token_type: "Bearer",
        }),
      );
    }

    return Promise.resolve(respond(new URL(String(input)), init));
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeOverrides(overrides: ProbeOverrides = {}) {
  const files = new Map<string, string>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeTextFile = vi.fn(async (path: string, contents: string) => {
    files.set(path, contents);
  });
  const ensureDirectory = vi.fn(async () => {});
  const dependencies: ProbeOverrides = {
    dateNow: () => new Date("2026-10-07T18:02:00.154Z"),
    ensureDirectory,
    monotonicNow: () => 0,
    outputDirectory: "/tmp/happy-runner-spike-output",
    samplePath: "/tmp/happy-runner-queue-response.json",
    sleep: async () => {},
    stderr: (line) => stderr.push(line),
    stdout: (line) => stdout.push(line),
    writeTextFile,
    ...overrides,
  };

  return {
    dependencies,
    ensureDirectory,
    files,
    stderr,
    stdout,
    writeTextFile,
  };
}

function getSavedResult(
  files: Map<string, string>,
  step: string,
): Record<string, unknown> {
  const entry = [...files.entries()].find(([path]) =>
    path.includes(`/${step}-`),
  );

  if (!entry) {
    throw new Error(`No saved ${step} result was found.`);
  }

  return JSON.parse(entry[1]) as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("SPOTIFY_CLIENT_ID", TEST_CLIENT_ID);
  vi.stubEnv("SPOTIFY_CLIENT_SECRET", TEST_CLIENT_SECRET);
  vi.stubEnv("SPOTIFY_REFRESH_TOKEN", TEST_REFRESH_TOKEN);
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockRejectedValue(
      new Error("Unexpected network access in a probe test."),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Spotify probe redaction", () => {
  it("redacts secrets, device ids, and owner identity in nested arrays", () => {
    const redacted = redact(
      {
        access_token: TEST_ACCESS_TOKEN,
        accessToken: TEST_ACCESS_TOKEN,
        refresh_token: TEST_REFRESH_TOKEN,
        refreshToken: TEST_REFRESH_TOKEN,
        client_secret: TEST_CLIENT_SECRET,
        clientSecret: TEST_CLIENT_SECRET,
        Authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
        devices: [{ id: "device-id", name: "Owner phone", type: "smartphone" }],
        available_devices: [{ id: "available-device-id", type: "speaker" }],
        playlist: {
          owner: {
            display_name: "Playlist owner",
            href: "https://api.spotify.com/v1/users/owner-id",
            id: "owner-id",
            uri: "spotify:user:owner-id",
          },
        },
        nested: [
          {
            items: [
              {
                authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
                refresh_token: TEST_REFRESH_TOKEN,
              },
            ],
          },
        ],
        queue: [
          {
            name: "Public track name",
            uri: "spotify:track:public-track-id",
          },
        ],
      },
      [TEST_ACCESS_TOKEN, TEST_CLIENT_SECRET, TEST_REFRESH_TOKEN],
    );

    expect(redacted).toMatchObject({
      access_token: "[redacted]",
      accessToken: "[redacted]",
      refresh_token: "[redacted]",
      refreshToken: "[redacted]",
      client_secret: "[redacted]",
      clientSecret: "[redacted]",
      Authorization: "[redacted]",
      devices: [{ id: "[redacted]", name: "[redacted]", type: "smartphone" }],
      available_devices: [{ id: "[redacted]", type: "speaker" }],
      playlist: {
        owner: {
          display_name: "[redacted]",
          href: "[redacted]",
          id: "[redacted]",
          uri: "[redacted]",
        },
      },
      nested: [
        {
          items: [
            {
              authorization: "[redacted]",
              refresh_token: "[redacted]",
            },
          ],
        },
      ],
      queue: [
        {
          name: "Public track name",
          uri: "spotify:track:public-track-id",
        },
      ],
    });
    expect(JSON.stringify(redacted)).not.toContain(TEST_ACCESS_TOKEN);
    expect(JSON.stringify(redacted)).not.toContain(TEST_REFRESH_TOKEN);
    expect(JSON.stringify(redacted)).not.toContain(TEST_CLIENT_SECRET);
  });

  it("keeps only the approved response headers", () => {
    const headers = allowlistedHeaders(
      new Headers({
        Authorization: "Bearer private-token",
        "Content-Type": "application/json",
        Date: "Wed, 07 Oct 2026 18:02:00 GMT",
        "Retry-After": "12",
        Server: "spotify-edge",
        "Set-Cookie": "private-cookie",
        "X-RateLimit-Limit": "30",
        "RateLimit-Remaining": "10",
        "X-Internal-Request": "private-value",
      }),
    );

    expect(headers).toEqual({
      "content-type": "application/json",
      date: "Wed, 07 Oct 2026 18:02:00 GMT",
      "retry-after": "12",
      server: "spotify-edge",
      "x-ratelimit-limit": "30",
      "ratelimit-remaining": "10",
    });
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("set-cookie");
    expect(headers).not.toHaveProperty("x-internal-request");
  });

  it("refuses to write a sample that still contains an unredacted deny-list value", async () => {
    const writeTextFile = vi.fn(async () => {});
    const ensureDirectory = vi.fn(async () => {});

    await expect(
      writeQueueSample(
        {
          access_token: "still-visible-token",
          queue: [],
        },
        {
          ensureDirectory,
          samplePath: "/tmp/unsafe-queue-sample.json",
          writeTextFile,
        },
      ),
    ).rejects.toThrow("Refusing to write queue sample");

    expect(ensureDirectory).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});

describe("Spotify probe summaries and output", () => {
  it("summarizes queue counts, item types, URIs, and names", () => {
    expect(
      summarizeQueue({
        currently_playing: { name: "Current track" },
        queue: [
          {
            type: "track",
            uri: "spotify:track:track-one",
            name: "Track One",
          },
          {
            type: "episode",
            uri: "spotify:episode:episode-one",
            name: "Episode One",
          },
        ],
      }),
    ).toEqual({
      currentlyPlayingPresent: true,
      queueItemCount: 2,
      itemTypes: ["track", "episode"],
      items: [
        {
          type: "track",
          uri: "spotify:track:track-one",
          name: "Track One",
        },
        {
          type: "episode",
          uri: "spotify:episode:episode-one",
          name: "Episode One",
        },
      ],
    });
  });

  it("summarizes devices without including ids or names", () => {
    expect(
      summarizeDevices({
        devices: [
          {
            id: "private-device-id",
            name: "Owner's phone",
            type: "smartphone",
            is_active: true,
            is_restricted: false,
          },
        ],
      }),
    ).toEqual({
      deviceCount: 1,
      devices: [
        {
          type: "smartphone",
          is_active: true,
          is_restricted: false,
        },
      ],
    });
  });

  it("builds an output path with a UTC timestamp", () => {
    expect(
      buildOutputPath(
        "queue",
        new Date("2026-10-07T18:02:00.154Z"),
        "/tmp/probe-output",
      ),
    ).toBe("/tmp/probe-output/queue-20261007T180200154Z.json");
  });

  it("writes a pretty, redacted sample with a trailing newline", async () => {
    const responseBody = {
      currently_playing: null,
      queue: [
        {
          name: "Public track name",
          uri: "spotify:track:public-track-id",
        },
      ],
    };
    const redactedBody = redact(responseBody);
    const writeTextFile = vi.fn(async () => {});
    const ensureDirectory = vi.fn(async () => {});

    await writeQueueSample(redactedBody, {
      ensureDirectory,
      samplePath: "/tmp/queue-response.json",
      writeTextFile,
    });

    expect(ensureDirectory).toHaveBeenCalledWith("/tmp");
    expect(writeTextFile).toHaveBeenCalledWith(
      "/tmp/queue-response.json",
      `${JSON.stringify(responseBody, null, 2)}\n`,
    );
  });
});

describe("Spotify probe CLI", () => {
  it("runs add from search and checks the queue at about 2 and 6 seconds", async () => {
    let queueReadCount = 0;
    let monotonicTime = 0;
    const queueUri = "spotify:track:track-one";
    const fetchMock = mockSpotifyFetch((url, init) => {
      if (url.pathname === "/v1/search") {
        expect(url.searchParams.get("type")).toBe("track");
        expect(url.searchParams.get("market")).toBe("BR");
        expect(url.searchParams.get("limit")).toBe("1");
        expect(url.searchParams.get("q")).toBe("Track One");

        return jsonResponse({
          tracks: {
            items: [{ name: "Track One", uri: queueUri }],
          },
        });
      }

      if (url.pathname === "/v1/me/player/queue" && init?.method === "POST") {
        expect(url.searchParams.get("uri")).toBe(queueUri);
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/v1/me/player/queue") {
        queueReadCount += 1;
        return jsonResponse({
          currently_playing: null,
          queue:
            queueReadCount === 1
              ? [{ name: "Track One", uri: queueUri }]
              : [],
        });
      }

      throw new Error(`Unexpected mocked endpoint: ${url.pathname}`);
    });
    const delays: number[] = [];
    const { dependencies, files, stdout } = makeOverrides({
      monotonicNow: () => monotonicTime,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        monotonicTime += milliseconds;
      },
    });

    await expect(
      runCli(
        ["add", "--query", "Track One", "--note", "screen-on"],
        dependencies,
      ),
    ).resolves.toBe(0);

    const result = getSavedResult(files, "add");
    const apiCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) !== TOKEN_URL,
    );

    expect(apiCalls).toHaveLength(4);
    expect(delays).toEqual([2_000, 4_000]);
    expect(result).toMatchObject({
      note: "screen-on",
      track: { name: "Track One", uri: queueUri },
      addResponse: { status: 204, body: null },
      queueChecks: [
        { requestedAfterMs: 2_000, appearsInQueue: true },
        { requestedAfterMs: 6_000, appearsInQueue: false },
      ],
    });
    expect(stdout.join("\n")).toContain("Add summary:");
  });

  it("saves the 404 no-active-device response body", async () => {
    const fetchMock = mockSpotifyFetch((url, init) => {
      if (url.pathname === "/v1/me/player/queue" && init?.method === "POST") {
        return jsonResponse(
          {
            error: {
              message: "No active device found",
              reason: "NO_ACTIVE_DEVICE",
              status: 404,
            },
          },
          404,
        );
      }

      if (url.pathname === "/v1/me/player/queue") {
        return jsonResponse({ currently_playing: null, queue: [] });
      }

      throw new Error(`Unexpected mocked endpoint: ${url.pathname}`);
    });
    const { dependencies, files } = makeOverrides();

    await expect(
      runCli(
        ["add", "spotify:track:track-one", "--note", "app-closed"],
        dependencies,
      ),
    ).resolves.toBe(0);

    const result = getSavedResult(files, "add");
    const apiCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) !== TOKEN_URL,
    );

    expect(apiCalls).toHaveLength(3);
    expect(result).toMatchObject({
      note: "app-closed",
      addResponse: {
        status: 404,
        body: {
          error: {
            message: "No active device found",
            reason: "NO_ACTIVE_DEVICE",
            status: 404,
          },
        },
      },
    });
  });

  it("stops burst at the first 429 and saves Retry-After and its body", async () => {
    let apiCallCount = 0;
    const fetchMock = mockSpotifyFetch((url) => {
      if (url.pathname !== "/v1/me/player/queue") {
        throw new Error(`Unexpected mocked endpoint: ${url.pathname}`);
      }

      apiCallCount += 1;

      if (apiCallCount === 3) {
        return jsonResponse(
          {
            error: {
              message: "Too many requests",
              reason: "QUOTA_EXCEEDED",
            },
          },
          429,
          {
            "Retry-After": "17",
            "X-RateLimit-Remaining": "0",
            "Set-Cookie": "must-not-be-saved",
          },
        );
      }

      return jsonResponse({ currently_playing: null, queue: [] });
    });
    const { dependencies, files, stdout } = makeOverrides();

    await expect(
      runCli(["burst", "--yes"], dependencies),
    ).resolves.toBe(0);

    const result = getSavedResult(files, "burst");
    const apiCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) !== TOKEN_URL,
    );

    expect(apiCallCount).toBe(3);
    expect(apiCalls).toHaveLength(3);
    expect(result).toMatchObject({
      callsMade: 3,
      rateLimitResponse: {
        status: 429,
        headers: {
          "retry-after": "17",
          "x-ratelimit-remaining": "0",
        },
        body: {
          error: {
            reason: "QUOTA_EXCEEDED",
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-saved");
    expect(stdout.join("\n")).toContain(
      "may lock the Spotify app for the Retry-After time",
    );
  });

  it("stops burst at both the 60-call and 30-second caps", async () => {
    let callCount = 0;
    mockSpotifyFetch((url) => {
      if (url.pathname !== "/v1/me/player/queue") {
        throw new Error(`Unexpected mocked endpoint: ${url.pathname}`);
      }

      callCount += 1;
      return jsonResponse({ currently_playing: null, queue: [] });
    });
    const callCapRun = makeOverrides();

    await expect(
      runCli(["burst", "--yes"], callCapRun.dependencies),
    ).resolves.toBe(0);

    expect(callCount).toBe(60);
    expect(getSavedResult(callCapRun.files, "burst")).toMatchObject({
      callsMade: 60,
      stopReason: "call-cap",
    });

    let elapsedMs = 0;
    callCount = 0;
    mockSpotifyFetch((url) => {
      if (url.pathname !== "/v1/me/player/queue") {
        throw new Error(`Unexpected mocked endpoint: ${url.pathname}`);
      }

      callCount += 1;
      elapsedMs += 1_000;
      return jsonResponse({ currently_playing: null, queue: [] });
    });
    const timeCapRun = makeOverrides({
      monotonicNow: () => elapsedMs,
    });

    await expect(
      runCli(["burst", "--yes"], timeCapRun.dependencies),
    ).resolves.toBe(0);

    expect(callCount).toBe(30);
    expect(getSavedResult(timeCapRun.files, "burst")).toMatchObject({
      callsMade: 30,
      elapsedMs: 30_000,
      stopReason: "time-cap",
    });
  });

  it("reports a deadline abort near 30 seconds as a time cap", async () => {
    let elapsedMs = 0;
    let apiCallCount = 0;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (String(input) === TOKEN_URL) {
        return Promise.resolve(
          jsonResponse({
            access_token: TEST_ACCESS_TOKEN,
            expires_in: 3_600,
            token_type: "Bearer",
          }),
        );
      }

      apiCallCount += 1;

      if (apiCallCount === 1) {
        elapsedMs = 29_999;
        return Promise.resolve(
          jsonResponse({ currently_playing: null, queue: [] }),
        );
      }

      const signal = init?.signal;

      if (!signal) {
        return Promise.reject(new Error("Expected a deadline signal."));
      }

      return new Promise<Response>((resolve, reject) => {
        const responseTimer = setTimeout(
          () => resolve(jsonResponse({ currently_playing: null, queue: [] })),
          100,
        );
        const rejectOnAbort = () => {
          clearTimeout(responseTimer);
          elapsedMs = 30_000;
          reject(signal.reason);
        };

        if (signal.aborted) {
          rejectOnAbort();
        } else {
          signal.addEventListener("abort", rejectOnAbort, { once: true });
        }
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const { dependencies, files } = makeOverrides({
      monotonicNow: () => elapsedMs,
    });

    await expect(
      runCli(["burst", "--yes"], dependencies),
    ).resolves.toBe(0);

    expect(apiCallCount).toBe(2);
    expect(getSavedResult(files, "burst")).toMatchObject({
      callsMade: 2,
      elapsedMs: 30_000,
      stopReason: "time-cap",
      calls: [
        { status: 200 },
        { status: null, error: "Request failed before an HTTP response." },
      ],
    });
  });

  it("keeps an early burst network failure labeled as a request error", async () => {
    mockSpotifyFetch(() => {
      throw new Error("socket unavailable");
    });
    const { dependencies, files } = makeOverrides({
      monotonicNow: () => 100,
    });

    await expect(
      runCli(["burst", "--yes"], dependencies),
    ).resolves.toBe(1);

    expect(getSavedResult(files, "burst")).toMatchObject({
      callsMade: 1,
      stopReason: "request-error",
    });
  });

  it("requires --yes before sending burst requests", async () => {
    const fetchMock = vi.mocked(fetch);
    const { dependencies, stderr, stdout } = makeOverrides();

    await expect(runCli(["burst"], dependencies)).resolves.toBe(2);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdout.join("\n")).toContain("may lock the Spotify app");
    expect(stderr.join("\n")).toContain("burst requires --yes");
  });

  it("prints only the missing environment variable name and exits non-zero", async () => {
    vi.stubEnv("SPOTIFY_CLIENT_ID", "");
    const fetchMock = vi.mocked(fetch);
    const { dependencies, files, stderr } = makeOverrides();

    await expect(runCli(["queue"], dependencies)).resolves.toBe(1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("SPOTIFY_CLIENT_ID");
    expect(stderr.join("\n")).not.toContain(TEST_CLIENT_SECRET);
    expect(files.size).toBe(1);
    expect([...files.values()][0]).toContain("Missing required environment variable");
  });

  it("writes the redacted queue body when --save-sample is used", async () => {
    const fetchMock = mockSpotifyFetch((url) => {
      if (url.pathname !== "/v1/me/player/queue") {
        throw new Error(`Unexpected mocked endpoint: ${url.pathname}`);
      }

      return jsonResponse({
        currently_playing: null,
        queue: [
          {
            name: "Public track name",
            uri: "spotify:track:public-track-id",
          },
        ],
      });
    });
    const { dependencies, files, writeTextFile } = makeOverrides();

    await expect(
      runCli(["queue", "--save-sample"], dependencies),
    ).resolves.toBe(0);

    const sampleWrite = writeTextFile.mock.calls.find(
      ([path]) => path === dependencies.samplePath,
    );

    expect(sampleWrite).toBeDefined();
    expect(sampleWrite?.[1]).toBe(
      `${JSON.stringify(
        {
          currently_playing: null,
          queue: [
            {
              name: "Public track name",
              uri: "spotify:track:public-track-id",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    expect(files.size).toBe(2);
    expect(fetchMock).toHaveBeenCalled();
  });
});

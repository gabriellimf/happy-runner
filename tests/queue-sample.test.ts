import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const samplePath = resolve(
  process.cwd(),
  "docs/samples/queue-response.json",
);
const forbiddenKeys = new Set([
  "access_token",
  "refresh_token",
  "client_secret",
  "display_name",
  "available_devices",
]);
const forbiddenValuePatterns = [
  /open\.spotify\.com\/users?\//i,
  /\/users?\/[^/?#\s]+/i,
  /spotify:users?:/i,
  /Bearer /i,
  /(?:BQ|AQ)[A-Za-z0-9_-]{20,}/,
];
let samplePromise: Promise<unknown> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Queue sample values must be objects.");
  }

  return value;
}

function readQueueSample(): Promise<unknown> {
  if (!samplePromise) {
    samplePromise = readFile(samplePath, "utf8").then(
      (text) => JSON.parse(text) as unknown,
    );
  }

  return samplePromise;
}

function collectStrings(
  value: unknown,
  strings: string[],
  keys: string[],
): void {
  if (typeof value === "string") {
    strings.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, strings, keys);
    }
    return;
  }

  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key.toLowerCase());
      collectStrings(item, strings, keys);
    }
  }
}

describe("queue response sample", () => {
  it("parses as JSON and has the expected top-level fields", async () => {
    const sample = asRecord(await readQueueSample());

    expect(sample).toHaveProperty("currently_playing");
    expect(sample).toHaveProperty("queue");
  });

  it("contains a non-empty queue of track items", async () => {
    const queue = asRecord(await readQueueSample()).queue;

    expect(Array.isArray(queue)).toBe(true);
    if (!Array.isArray(queue)) {
      throw new Error("Queue sample queue must be an array.");
    }

    expect(queue.length).toBeGreaterThan(0);
    for (const value of queue) {
      const item = asRecord(value);

      expect(item.type).toBe("track");
      expect(typeof item.uri).toBe("string");
      if (typeof item.uri === "string") {
        expect(item.uri.startsWith("spotify:track:")).toBe(true);
      }
      expect(typeof item.name).toBe("string");
    }
  });

  it("contains no forbidden identity or credential values", async () => {
    const value = await readQueueSample();
    const strings: string[] = [];
    const keys: string[] = [];
    collectStrings(value, strings, keys);

    const allStrings = [...strings, ...keys];

    expect(keys.filter((key) => forbiddenKeys.has(key))).toEqual([]);
    expect(
      allStrings.filter((string) =>
        forbiddenValuePatterns.some((pattern) => pattern.test(string)),
      ),
    ).toEqual([]);
  });

  it("recognizes user identifiers in Spotify URLs and URIs", () => {
    const examples = [
      "https://open.spotify.com/user/abc123",
      "spotify:user:abc123",
      "https://api.spotify.com/v1/users/abc123/playlists",
    ];

    for (const example of examples) {
      expect(
        forbiddenValuePatterns.some((pattern) => pattern.test(example)),
      ).toBe(true);
    }
  });
});

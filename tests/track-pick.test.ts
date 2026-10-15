import { describe, expect, it } from "vitest";

import type { Track } from "../lib/spotify-responses";
import { buildPickRequest, resolvePick } from "../lib/track-pick";

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
  track("id-3", "Evidências", "Cover Band"),
];

const PICK_IDS = new Map([
  ["c1", "id-1"],
  ["c2", "id-2"],
  ["c3", "id-3"],
]);

describe("buildPickRequest", () => {
  it("sends only titles and artists, keyed by position", () => {
    expect(buildPickRequest(TRACKS).candidates).toEqual({
      c1: { title: "Evidências - Karaoke", artists: ["Karaoke Hits"] },
      c2: { title: "Evidências", artists: ["Chitãozinho & Xororó"] },
      c3: { title: "Evidências", artists: ["Cover Band"] },
    });
  });

  it("offers one criterion per candidate plus none, and reads guest_text", () => {
    const { question } = buildPickRequest(TRACKS);

    expect(Object.keys(question.criteria)).toEqual(["c1", "c2", "c3", "none"]);
    expect(JSON.stringify(question.instructions)).toContain("`guest_text`");
  });

  it("maps each key back to the Spotify track id", () => {
    expect(buildPickRequest(TRACKS).idsByKey).toEqual(PICK_IDS);
  });
});

describe("resolvePick", () => {
  it("maps a confident answer back to the Spotify track id", () => {
    expect(resolvePick({ choice: "c2", confidence: 0.9 }, PICK_IDS)).toBe(
      "id-2",
    );
  });

  it.each([
    ["a confident none answer", "none", 0.99],
    ["a pick below 0.9", "c2", 0.89],
    ["an unknown label", "c9", 0.99],
  ])("returns null for %s", (_label, choice, confidence) => {
    expect(resolvePick({ choice, confidence }, PICK_IDS)).toBeNull();
  });
});

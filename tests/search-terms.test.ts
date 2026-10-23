import { describe, expect, it } from "vitest";

import { isExplicitVersionQuery } from "../lib/search-terms";

describe("isExplicitVersionQuery", () => {
  it.each([
    "karaoke",
    "remix",
    "ao vivo",
    "LIVE",
    "acústico",
    "ACUSTICO",
    "cover",
    "instrumental",
    "versão",
    "VERSAO",
    "playback",
  ])("matches an explicit version term in %j", (query) => {
    expect(isExplicitVersionQuery(`Evidências ${query}`)).toBe(true);
  });

  it.each(["lively", "remixing", "playbacked", "crossover"])(
    "does not match a partial version term in %j",
    (query) => {
      expect(isExplicitVersionQuery(query)).toBe(false);
    },
  );
});

import { describe, expect, it } from "vitest";

import {
  blocksIntent,
  intentQuestion,
  isPlaybackCommand,
} from "../lib/intent-gate";

describe("isPlaybackCommand", () => {
  it.each([
    "pula essa",
    "Pula essa!",
    "para a música",
    "para a musica",
    "muda essa",
    "tira essa porcaria",
    "troca de música",
    "  PRÓXIMA  ",
    "proxima musica",
  ])("blocks %j", (query) => {
    expect(isPlaybackCommand(query)).toBe(true);
  });

  it.each([
    "pula",
    "para",
    "muda",
    "pula pula",
    "pula essa parte",
    "tira teima",
    "evidências",
    "para sempre",
    "a música",
    "próxima parada",
  ])("keeps %j for the model to judge", (query) => {
    expect(isPlaybackCommand(query)).toBe(false);
  });
});

describe("intentQuestion", () => {
  it("offers the four intents as criteria and reads guest_text", () => {
    const question = intentQuestion();

    expect(Object.keys(question.criteria)).toEqual([
      "song",
      "lyric",
      "command",
      "other",
    ]);
    expect(JSON.stringify(question.instructions)).toContain("`guest_text`");
  });
});

describe("blocksIntent", () => {
  it.each([
    ["command", 0.5, true],
    ["command", 0.49, false],
    ["other", 0.9, true],
    ["other", 0.89, false],
    ["song", 0.99, false],
    ["lyric", 0.99, false],
  ])("%s at %d blocks: %s", (choice, confidence, blocked) => {
    expect(blocksIntent({ choice, confidence })).toBe(blocked);
  });
});

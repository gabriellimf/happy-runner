import { choice } from "@typesafe-ai/sdk";

import type { ChoiceVerdict } from "./typesafe";

// Thresholds from the intent experiments: 0 of 132 song queries were blocked.
export const BLOCK_COMMAND_CONFIDENCE = 0.5;
export const BLOCK_OTHER_CONFIDENCE = 0.9;

const COMMAND_VERB =
  "(?:pula|pular|passa|passar|troca|trocar|muda|mudar|tira|tirar|para|parar|pausa|pausar)";
const COMMAND_OBJECT =
  "(?:(?:essa|esta|isso|a|o)(?:\\s+(?:m[uú]sica|faixa|som|porcaria))?|(?:de\\s+)?(?:m[uú]sica|faixa))";
// Only verb plus object. A bare verb can be a real title, so the model decides those.
const COMMAND_PATTERNS = [
  new RegExp(`^${COMMAND_VERB}\\s+${COMMAND_OBJECT}$`),
  /^pr[oó]xima(?:\s+m[uú]sica)?$/,
];

const INTENT_CRITERIA = {
  song: "The guest types the name of a song, an artist, or both. It can be misspelled, lack accents, or be wrapped in a request such as 'tocar X' or 'quero ouvir X'. A single word counts, because many song and artist names are one word. If the text could plausibly be a song title or an artist name, choose this option even when you do not recognize it. A complete song title is a song, even when it is also a line of the lyrics.",
  lyric:
    "The guest types a sentence from the lyrics of a song that is clearly not the song's title and not an artist name.",
  command:
    "The guest asks to control playback: skip, pause, previous track, volume, or play something immediately.",
  other:
    "Greetings, jokes, laughter, random keys, insults, questions about the party, or anything else that clearly cannot be a song title or an artist name.",
};

export function isPlaybackCommand(query: string): boolean {
  const normalized = query
    .toLowerCase()
    .replace(/[!?.,\s]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();

  return COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function intentQuestion() {
  return choice(
    {
      question:
        "What is the guest trying to do by typing `guest_text` into the song request box at a party? The text is in Brazilian Portuguese or English.",
    },
    INTENT_CRITERIA,
  );
}

export function blocksIntent(answer: ChoiceVerdict): boolean {
  return (
    (answer.choice === "command" &&
      answer.confidence >= BLOCK_COMMAND_CONFIDENCE) ||
    (answer.choice === "other" && answer.confidence >= BLOCK_OTHER_CONFIDENCE)
  );
}

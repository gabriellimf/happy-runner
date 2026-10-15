import { choice } from "@typesafe-ai/sdk";

import type { Track } from "./spotify-responses";
import type { ChoiceVerdict } from "./typesafe";

export const AUTO_ADD_CONFIDENCE = 0.9;

const RULES = [
  "If the guest names a version (karaoke, live, remix, instrumental, acoustic, cover, sped up), the wanted track is that version of the song they named.",
  "Otherwise the wanted track is the officially released recording by the original artist. Karaoke versions, covers by other artists, tributes, remixes, instrumentals, lullaby versions and sped-up versions are not wanted.",
  "The guest's text can be misspelled, lack accents, or give only part of the title or the artist.",
  "If the guest typed only an artist name or a vague word, so that several different songs fit, no candidate is wanted.",
];

// Candidates are keyed by position, so the model never sees Spotify ids.
export function buildPickRequest(tracks: readonly Track[]) {
  const candidates: Record<string, { artists: string[]; title: string }> = {};
  const criteria: Record<string, string> = {};
  const idsByKey = new Map<string, string>();

  tracks.forEach((track, index) => {
    const key = `c${index + 1}`;

    candidates[key] = { title: track.title, artists: track.artists };
    criteria[key] = `The track in \`candidates.${key}\``;
    idsByKey.set(key, track.id);
  });
  criteria.none = "No candidate is the track the guest wants";

  const question = choice(
    {
      question:
        "Which track in `candidates` is the one the guest wants, based on `guest_text`? The guest is at a party in Brazil and is typing into a song request box.",
      rules: RULES,
    },
    criteria,
  );

  return { candidates, idsByKey, question };
}

// Returns the id to add on Enter, or null when no candidate is confident enough.
export function resolvePick(
  answer: ChoiceVerdict,
  idsByKey: ReadonlyMap<string, string>,
): string | null {
  return answer.confidence >= AUTO_ADD_CONFIDENCE
    ? (idsByKey.get(answer.choice) ?? null)
    : null;
}

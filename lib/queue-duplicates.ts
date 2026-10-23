import { noul } from "@typesafe-ai/sdk";

import { getQueue } from "./spotify";
import type {
  InQueue,
  QueueResponse,
  QueueTrack,
  Track,
} from "./spotify-responses";

// Untuned starting point. A false warning only costs the guest an extra tap,
// so this leans high. Check it on labeled queue cases before relying on it.
export const SIMILAR_QUEUED_CONFIDENCE = 0.8;
const MAX_QUEUE_STATE_NEXT_TRACKS = 10;

const SIMILAR_CRITERIA = {
  true: "Another recording or version of a song in the queue. Remasters, re-releases on another album, live, acoustic, remix, karaoke, instrumental and cover versions all count.",
  false:
    "No track in the queue is the same song. A different song by the same artist, or a song with a similar title, does not count.",
};

export function queuedTrackIds(queue: QueueResponse): Set<string> {
  const ids = new Set(queue.next.map((track) => track.id));

  if (queue.nowPlaying) {
    ids.add(queue.nowPlaying.id);
  }

  return ids;
}

export function hasQueuedTracks(queue: QueueResponse): boolean {
  return queue.nowPlaying !== null || queue.next.length > 0;
}

// The queue is only a hint here, so a failed read must not fail the request.
export async function readQueueOrUndefined(): Promise<
  QueueResponse | undefined
> {
  try {
    return await getQueue();
  } catch (error) {
    console.error({
      errorClass:
        error instanceof Error ? error.constructor.name : "UnknownError",
      feature: "queue-read",
    });
    return undefined;
  }
}

function summarize(track: QueueTrack): { artists: string[]; title: string } {
  return { title: track.title, artists: track.artists };
}

export function queueState(queue: QueueResponse) {
  return {
    now_playing: queue.nowPlaying ? summarize(queue.nowPlaying) : null,
    next: queue.next.slice(0, MAX_QUEUE_STATE_NEXT_TRACKS).map(summarize),
  };
}

export function similarQuestionId(candidateKey: string): string {
  return `similar_${candidateKey}`;
}

// One Noul per candidate. They run in parallel with the other questions, and
// code decides later which answers apply. Exact matches need no question.
export function buildSimilarQuestions(
  idsByKey: ReadonlyMap<string, string>,
  exactIds: ReadonlySet<string>,
) {
  const questions: Record<string, ReturnType<typeof noul>> = {};

  for (const [key, id] of idsByKey) {
    if (!exactIds.has(id)) {
      questions[similarQuestionId(key)] = noul(
        `Is the song of \`candidates.${key}\` the same song as any track in \`queue\`, even in a different version?`,
        SIMILAR_CRITERIA,
      );
    }
  }

  return questions;
}

type SimilarAnswers = Readonly<Record<string, unknown>>;

function noulOf(answer: unknown): number | undefined {
  if (
    typeof answer === "object" &&
    answer !== null &&
    "noul" in answer &&
    typeof answer.noul === "number"
  ) {
    return answer.noul;
  }

  return undefined;
}

// Ids of candidates that Jev judged to be another version of a queued song.
export function resolveSimilarIds(
  answers: SimilarAnswers,
  idsByKey: ReadonlyMap<string, string>,
  exactIds: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];

  for (const [key, id] of idsByKey) {
    const noulValue = noulOf(answers[similarQuestionId(key)]);

    if (
      !exactIds.has(id) &&
      noulValue !== undefined &&
      noulValue >= SIMILAR_QUEUED_CONFIDENCE
    ) {
      ids.push(id);
    }
  }

  return ids;
}

export function markQueued(
  tracks: readonly Track[],
  exactIds: ReadonlySet<string>,
  similarIds: readonly string[],
): InQueue {
  const inQueue: InQueue = {};

  for (const track of tracks) {
    if (exactIds.has(track.id)) {
      inQueue[track.id] = "exact";
    } else if (similarIds.includes(track.id)) {
      inQueue[track.id] = "version";
    }
  }

  return inQueue;
}

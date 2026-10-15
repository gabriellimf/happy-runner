import { blocksIntent, intentQuestion } from "./intent-gate";
import {
  buildSimilarQuestions,
  hasQueuedTracks,
  queueState,
  queuedTrackIds,
  resolveSimilarIds,
} from "./queue-duplicates";
import type { QueueResponse, Track } from "./spotify-responses";
import { buildPickRequest, resolvePick } from "./track-pick";
import { getTypeSafeClient, logTypeSafeError } from "./typesafe";

export interface SearchJudgment {
  // The id to add on Enter. null: no candidate is confident enough.
  // undefined: TypeSafe did not judge, so the caller keeps the first result.
  autoAddId?: string | null;
  // True when the text is not a song request. The caller drops the results.
  blocked: boolean;
  // Candidates that are another version of a song already in the queue.
  similarIds: string[];
}

const NOT_BLOCKED: SearchJudgment = { blocked: false, similarIds: [] };

// All questions read the same state and run in parallel, so one request answers them.
// The queue is optional. Without it, no similar-song question is asked.
// Fails open: any TypeSafe problem blocks nothing and picks nothing.
export async function judgeSearch(
  query: string,
  tracks: readonly Track[],
  queue?: QueueResponse,
): Promise<SearchJudgment> {
  const client = getTypeSafeClient();

  if (!client || tracks.length === 0) {
    return NOT_BLOCKED;
  }

  const pick = buildPickRequest(tracks);
  const exactIds = queue ? queuedTrackIds(queue) : new Set<string>();
  const similar =
    queue && hasQueuedTracks(queue)
      ? buildSimilarQuestions(pick.idsByKey, exactIds)
      : {};
  const asksSimilar = Object.keys(similar).length > 0;

  try {
    const { answers } = await client.systemOne({
      state: {
        guest_text: query,
        candidates: pick.candidates,
        ...(queue && asksSimilar ? { queue: queueState(queue) } : {}),
      },
      questions: { ...similar, intent: intentQuestion(), pick: pick.question },
    });

    if (blocksIntent(answers.intent)) {
      return { blocked: true, similarIds: [] };
    }

    return {
      autoAddId: resolvePick(answers.pick, pick.idsByKey),
      blocked: false,
      similarIds: resolveSimilarIds(answers, pick.idsByKey, exactIds),
    };
  } catch (error) {
    logTypeSafeError("search-judgment", error);
    return NOT_BLOCKED;
  }
}

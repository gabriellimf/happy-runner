import { blocksIntent, intentQuestion } from "./intent-gate";
import {
  buildSimilarQuestions,
  hasQueuedTracks,
  queueState,
  queuedTrackIds,
  resolveSimilarIds,
} from "./queue-duplicates";
import {
  INTENT_PICK_CACHE_TTL_MS,
  createSearchCache,
} from "./search-cache";
import { MAX_SEARCH_RESULTS } from "./spotify-responses";
import type { QueueResponse, Track } from "./spotify-responses";
import {
  buildPickCandidates,
  buildPickRequest,
  resolvePick,
} from "./track-pick";
import {
  getTypeSafeClient,
  isTypeSafeCircuitOpen,
  logTypeSafeError,
  recordTypeSafeFailure,
  recordTypeSafeSuccess,
} from "./typesafe";
import type { ChoiceVerdict } from "./typesafe";

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

interface CachedIntentPickJudgment {
  autoAddId?: string | null;
  blocked: boolean;
}

const intentPickCache = createSearchCache<CachedIntentPickJudgment>(
  () => Date.now(),
  INTENT_PICK_CACHE_TTL_MS,
);
const similarCache = createSearchCache<string[]>();

function isChoiceVerdict(answer: unknown): answer is ChoiceVerdict {
  return (
    typeof answer === "object" &&
    answer !== null &&
    "choice" in answer &&
    typeof answer.choice === "string" &&
    "confidence" in answer &&
    typeof answer.confidence === "number" &&
    Number.isFinite(answer.confidence)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValidSimilarAnswers(
  answers: unknown,
  questionIds: readonly string[],
): answers is Readonly<Record<string, unknown>> {
  return (
    isRecord(answers) &&
    questionIds.every((questionId) => {
      const answer = answers[questionId];

      return (
        isRecord(answer) &&
        answer.type === "noul" &&
        typeof answer.noul === "number" &&
        Number.isFinite(answer.noul) &&
        answer.noul >= 0 &&
        answer.noul <= 1
      );
    })
  );
}

export function resetSearchJudgmentCaches(): void {
  intentPickCache.clear();
  similarCache.clear();
}

// All questions read the same state and run in parallel, so one request answers them.
// The queue is optional. Without it, no similar-song question is asked.
// TypeSafe must never stop a guest from searching or adding.
// Keep every SDK operation inside this fail-open boundary.
export async function judgeSearch(
  query: string,
  tracks: readonly Track[],
  queue?: QueueResponse,
): Promise<SearchJudgment> {
  if (tracks.length === 0) {
    return NOT_BLOCKED;
  }

  let fallbackJudgment: CachedIntentPickJudgment | undefined;

  try {
    if (isTypeSafeCircuitOpen()) {
      return NOT_BLOCKED;
    }

    const client = getTypeSafeClient();

    if (!client) {
      return NOT_BLOCKED;
    }

    const judgedTracks = tracks.slice(0, MAX_SEARCH_RESULTS);
    const exactIds = queue ? queuedTrackIds(queue) : new Set<string>();
    const asksSimilar = Boolean(
      queue &&
        hasQueuedTracks(queue) &&
        judgedTracks.some((track) => !exactIds.has(track.id)),
    );
    const intentPickKey = JSON.stringify([
      query.trim().toLowerCase(),
      judgedTracks.map(({ id }) => id),
    ]);
    const cachedIntentPick = intentPickCache.get(intentPickKey);
    fallbackJudgment = cachedIntentPick;

    if (cachedIntentPick?.blocked) {
      return { blocked: true, similarIds: [] };
    }

    const similarKey =
      asksSimilar && queue
        ? JSON.stringify([
            intentPickKey,
            queueState(queue),
            [...exactIds].sort(),
          ])
        : undefined;
    const cachedSimilarIds =
      similarKey === undefined ? undefined : similarCache.get(similarKey);

    if (
      cachedIntentPick &&
      (!asksSimilar || cachedSimilarIds !== undefined)
    ) {
      return {
        ...cachedIntentPick,
        similarIds: cachedSimilarIds ?? [],
      };
    }

    const pick =
      cachedIntentPick === undefined
        ? buildPickRequest(judgedTracks)
        : undefined;
    const candidateData = pick ?? buildPickCandidates(judgedTracks);
    const similar =
      asksSimilar && cachedSimilarIds === undefined
        ? buildSimilarQuestions(candidateData.idsByKey, exactIds)
        : {};
    const questions = {
      ...similar,
      ...(pick
        ? { intent: intentQuestion(), pick: pick.question }
        : {}),
    };

    if (Object.keys(questions).length === 0) {
      return cachedIntentPick
        ? {
            ...cachedIntentPick,
            similarIds: cachedSimilarIds ?? [],
          }
        : NOT_BLOCKED;
    }

    const { answers } = await client.systemOne({
      state: {
        guest_text: query,
        candidates: candidateData.candidates,
        ...(Object.keys(similar).length > 0 && queue
          ? { queue: queueState(queue) }
          : {}),
      },
      questions,
    });

    let judgment = cachedIntentPick;

    if (judgment === undefined) {
      if (
        !pick ||
        !isChoiceVerdict(answers.intent) ||
        !isChoiceVerdict(answers.pick)
      ) {
        throw new TypeError("TypeSafe returned invalid choice answers.");
      }

      judgment = blocksIntent(answers.intent)
        ? { blocked: true }
        : {
            autoAddId: resolvePick(answers.pick, candidateData.idsByKey),
            blocked: false,
          };
      intentPickCache.set(intentPickKey, judgment);
      fallbackJudgment = judgment;
    }

    if (judgment.blocked) {
      recordTypeSafeSuccess();
      return { blocked: true, similarIds: [] };
    }

    let similarIds = cachedSimilarIds ?? [];

    if (
      similarKey !== undefined &&
      cachedSimilarIds === undefined &&
      Object.keys(similar).length > 0
    ) {
      const similarQuestionIds = Object.keys(similar);

      if (!hasValidSimilarAnswers(answers, similarQuestionIds)) {
        throw new TypeError("TypeSafe returned invalid similar answers.");
      }

      similarIds = resolveSimilarIds(answers, candidateData.idsByKey, exactIds);
      similarCache.set(similarKey, similarIds);
    }

    recordTypeSafeSuccess();
    return { ...judgment, similarIds };
  } catch (error) {
    recordTypeSafeFailure(error);
    logTypeSafeError("search-judgment", error);
    return fallbackJudgment && !fallbackJudgment.blocked
      ? { ...fallbackJudgment, similarIds: [] }
      : NOT_BLOCKED;
  }
}

import { apiErrorResponse, invalidInputResponse } from "../../../lib/api-errors";
import { isPlaybackCommand } from "../../../lib/intent-gate";
import {
  markQueued,
  queuedTrackIds,
  readQueueOrUndefined,
} from "../../../lib/queue-duplicates";
import { judgeSearch } from "../../../lib/search-judgment";
import { search } from "../../../lib/spotify";
import type { InQueue, Track } from "../../../lib/spotify-responses";

const MIN_QUERY_LENGTH = 4;
const MAX_QUERY_LENGTH = 100;
const MAX_RAW_QUERY_LENGTH = 400;

interface SearchResponse {
  autoAddId?: string | null;
  inQueue?: InQueue;
  items: Track[];
}

export async function GET(request: Request): Promise<Response> {
  const rawQuery = new URL(request.url).searchParams.get("q") ?? "";
  const maximumLengthMessage = `A busca deve ter no máximo ${MAX_QUERY_LENGTH} caracteres`;

  if (rawQuery.length > MAX_RAW_QUERY_LENGTH) {
    return invalidInputResponse(maximumLengthMessage);
  }

  const query = rawQuery.trim();
  let queryLength = 0;
  const queryCharacters = query[Symbol.iterator]();

  while (true) {
    const character = queryCharacters.next();

    if (character.done) {
      break;
    }

    queryLength += 1;

    if (queryLength > MAX_QUERY_LENGTH) {
      return invalidInputResponse(maximumLengthMessage);
    }
  }

  if (queryLength < MIN_QUERY_LENGTH) {
    return invalidInputResponse("Digite pelo menos 4 caracteres");
  }

  try {
    if (isPlaybackCommand(query)) {
      return Response.json({ items: [] });
    }

    // The queue read only feeds the duplicate hint, so it runs alongside the search.
    const [items, queue] = await Promise.all([
      search(query),
      readQueueOrUndefined(),
    ]);
    const { autoAddId, blocked, similarIds } = await judgeSearch(
      query,
      items,
      queue,
    );

    if (blocked) {
      return Response.json({ items: [] });
    }

    const inQueue = queue
      ? markQueued(items, queuedTrackIds(queue), similarIds)
      : {};
    const body: SearchResponse = { items };

    if (autoAddId !== undefined) {
      body.autoAddId = autoAddId;
    }

    if (Object.keys(inQueue).length > 0) {
      body.inQueue = inQueue;
    }

    return Response.json(body);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

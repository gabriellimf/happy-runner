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
import { logTypeSafeError } from "../../../lib/typesafe";

const MIN_QUERY_LENGTH = 4;
const MAX_QUERY_LENGTH = 100;
const MAX_RAW_QUERY_LENGTH = 400;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

interface SearchResponse {
  autoAddId?: string | null;
  inQueue?: InQueue;
  items: Track[];
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: Request): Promise<Response> {
  const rawQuery = new URL(request.url).searchParams.get("q") ?? "";
  const maximumLengthMessage = `A busca deve ter no máximo ${MAX_QUERY_LENGTH} caracteres`;

  if (rawQuery.length > MAX_RAW_QUERY_LENGTH) {
    return noStore(invalidInputResponse(maximumLengthMessage));
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
      return noStore(invalidInputResponse(maximumLengthMessage));
    }
  }

  if (queryLength < MIN_QUERY_LENGTH) {
    return noStore(invalidInputResponse("Digite pelo menos 4 caracteres"));
  }

  try {
    if (isPlaybackCommand(query)) {
      return Response.json({ items: [] }, { headers: NO_STORE_HEADERS });
    }

    // The queue read only feeds the duplicate hint, so it runs alongside the search.
    const [items, queue] = await Promise.all([
      search(query),
      readQueueOrUndefined(),
    ]);
    let autoAddId: string | null | undefined;
    let blocked = false;
    let similarIds: string[] = [];

    try {
      ({ autoAddId, blocked, similarIds } = await judgeSearch(
        query,
        items,
        queue,
      ));
    } catch (error) {
      logTypeSafeError("search-judgment", error);
    }

    if (blocked) {
      return Response.json({ items: [] }, { headers: NO_STORE_HEADERS });
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

    return Response.json(body, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return apiErrorResponse(error, { headers: NO_STORE_HEADERS });
  }
}

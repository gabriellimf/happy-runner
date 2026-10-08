import { apiErrorResponse, invalidInputResponse } from "../../../lib/api-errors";
import { search } from "../../../lib/spotify";

const MIN_QUERY_LENGTH = 4;
const MAX_QUERY_LENGTH = 100;
const MAX_RAW_QUERY_LENGTH = 400;

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
    return Response.json({ items: await search(query) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

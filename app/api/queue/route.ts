import {
  apiErrorResponse,
  invalidInputResponse,
} from "../../../lib/api-errors";
import { readJsonBody } from "../../../lib/request-body";
import { addToQueue, getQueue } from "../../../lib/spotify";

const TRACK_URI_PATTERN = /^spotify:track:[A-Za-z0-9]{22}$/;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const MAX_QUEUE_REQUEST_BODY_BYTES = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(): Promise<Response> {
  try {
    return Response.json(await getQueue(), { headers: NO_STORE_HEADERS });
  } catch (error) {
    return apiErrorResponse(error, {
      headers: NO_STORE_HEADERS,
      playerEndpoint: true,
    });
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;

  try {
    body = await readJsonBody(request, MAX_QUEUE_REQUEST_BODY_BYTES);
  } catch {
    return invalidInputResponse("URI de música inválida");
  }

  if (
    !isRecord(body) ||
    typeof body.uri !== "string" ||
    !TRACK_URI_PATTERN.test(body.uri)
  ) {
    return invalidInputResponse("URI de música inválida");
  }

  try {
    await addToQueue(body.uri);
    return Response.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, { playerEndpoint: true });
  }
}

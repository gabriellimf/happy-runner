import type { QueueResponse, QueueTrack, Track } from "../spotify-responses";

export class ClientApiError extends Error {
  readonly code: string | null;
  readonly retryAfterSeconds: number | undefined;
  readonly status: number;

  constructor(
    status: number,
    code: string | null,
    retryAfterSeconds: number | undefined,
  ) {
    super(`API request failed with status ${status}`);
    this.name = "ClientApiError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
  }
}

export class ClientNetworkError extends Error {
  constructor() {
    super("Network request failed");
    this.name = "ClientNetworkError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTrack(value: unknown): value is Track {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.uri === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.artists) &&
    value.artists.every((artist) => typeof artist === "string") &&
    (value.coverUrl === null || typeof value.coverUrl === "string") &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs)
  );
}

function isQueueTrack(value: unknown): value is QueueTrack {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.artists) &&
    value.artists.every((artist) => typeof artist === "string") &&
    (value.coverUrl === null || typeof value.coverUrl === "string")
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }

  const seconds = Number(value);

  return Number.isFinite(seconds) ? seconds : undefined;
}

async function request(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch (error) {
    if (
      init.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw error;
    }

    throw new ClientNetworkError();
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }

    throw error;
  }
}

async function readApiError(response: Response): Promise<ClientApiError> {
  const body = await readJsonBody(response);
  const error = isRecord(body) ? body.error : undefined;
  const code =
    isRecord(error) && typeof error.code === "string" ? error.code : null;

  return new ClientApiError(
    response.status,
    code,
    parseRetryAfter(response.headers.get("Retry-After")),
  );
}

export async function searchTracks(
  query: string,
  signal?: AbortSignal,
): Promise<Track[]> {
  const response = await request(
    `/api/search?q=${encodeURIComponent(query)}`,
    { method: "GET", signal, cache: "no-store" },
  );

  if (!response.ok) {
    throw await readApiError(response);
  }

  const body = await readJsonBody(response);

  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error("Search response has an invalid shape");
  }

  const tracks = body.items.filter(isTrack);

  return tracks.slice(0, 5);
}

export async function addTrack(uri: string): Promise<void> {
  const response = await request("/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uri }),
  });

  if (!response.ok) {
    throw await readApiError(response);
  }

  const body = await readJsonBody(response);

  if (!isRecord(body) || body.ok !== true) {
    throw new Error("Queue add response has an invalid shape");
  }
}

export async function fetchQueue(signal?: AbortSignal): Promise<QueueResponse> {
  const response = await request("/api/queue", {
    method: "GET",
    signal,
    cache: "no-store",
  });

  if (!response.ok) {
    throw await readApiError(response);
  }

  const body = await readJsonBody(response);

  if (
    !isRecord(body) ||
    !(body.nowPlaying === null || isQueueTrack(body.nowPlaying)) ||
    !Array.isArray(body.next) ||
    !body.next.every(isQueueTrack)
  ) {
    throw new Error("Queue response has an invalid shape");
  }

  return {
    nowPlaying: body.nowPlaying,
    next: body.next,
  };
}

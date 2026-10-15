import {
  SpotifyApiError,
  SpotifyAuthError,
  SpotifyConfigError,
  SpotifyRateLimitError,
} from "./spotify";

interface ApiErrorOptions {
  headers?: HeadersInit;
  playerEndpoint?: boolean;
}

function logApiError(error: unknown): void {
  const spotifyError =
    error instanceof SpotifyApiError || error instanceof SpotifyRateLimitError
      ? error
      : undefined;

  console.error({
    errorClass:
      error instanceof Error ? error.constructor.name : "UnknownError",
    status: spotifyError?.status,
    reason: spotifyError?.reason,
  });
}

function isNoActiveDeviceError(
  error: unknown,
  playerEndpoint: boolean,
): boolean {
  if (
    (error instanceof SpotifyApiError ||
      error instanceof SpotifyRateLimitError) &&
    error.reason === "NO_ACTIVE_DEVICE"
  ) {
    return true;
  }

  return (
    playerEndpoint &&
    error instanceof SpotifyApiError &&
    error.status === 404
  );
}

export function invalidInputResponse(message: string): Response {
  return Response.json(
    { error: { code: "INVALID_INPUT", message } },
    { status: 400 },
  );
}

export function alreadyInQueueResponse(): Response {
  return Response.json(
    {
      error: {
        code: "ALREADY_IN_QUEUE",
        message: "Essa música já está na fila",
      },
    },
    { status: 409 },
  );
}

export function apiErrorResponse(
  error: unknown,
  { headers: responseHeaders, playerEndpoint = false }: ApiErrorOptions = {},
): Response {
  logApiError(error);

  const headers = new Headers(responseHeaders);
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "Algo deu errado, tente de novo";

  if (isNoActiveDeviceError(error, playerEndpoint)) {
    status = 503;
    code = "NO_ACTIVE_DEVICE";
    message = "Player offline, tente em instantes";
  } else if (error instanceof SpotifyRateLimitError) {
    status = 429;
    code = "RATE_LIMITED";
    message = "Muita gente pedindo, tente de novo";

    if (
      error.retryAfterSeconds !== undefined &&
      Number.isFinite(error.retryAfterSeconds) &&
      error.retryAfterSeconds >= 0
    ) {
      headers.set("Retry-After", String(Math.ceil(error.retryAfterSeconds)));
    }
  } else if (error instanceof SpotifyApiError) {
    status = 502;
    code = "UPSTREAM_ERROR";
  } else if (
    error instanceof SpotifyAuthError ||
    error instanceof SpotifyConfigError
  ) {
    status = 500;
  }

  return Response.json(
    { error: { code, message } },
    { status, headers },
  );
}

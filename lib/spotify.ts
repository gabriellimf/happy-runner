import { Buffer } from "node:buffer";

const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1/";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const SPOTIFY_FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_SECONDS = 5;

interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface CachedAccessToken {
  accessToken: string;
  expiresAt: number;
}

interface SpotifyErrorDetails {
  message?: string;
  reason?: string;
}

export interface SpotifyRequestInit extends Omit<RequestInit, "body"> {
  body?: unknown;
  query?:
    | URLSearchParams
    | Readonly<
        Record<string, boolean | null | number | string | undefined>
      >;
}

export interface SpotifyRawResponse {
  status: number;
  headers: Headers;
  bodyText: string;
}

let cachedAccessToken: CachedAccessToken | undefined;
let tokenRefreshInFlight: Promise<string> | undefined;

export class SpotifyError extends Error {
  constructor(message: string, cause?: unknown) {
    if (cause === undefined) {
      super(message);
    } else {
      super(message, { cause });
    }

    this.name = new.target.name;
  }
}

export class SpotifyConfigError extends SpotifyError {
  readonly variable: string;

  constructor(variable: string) {
    super(`Missing required environment variable ${variable}.`);
    this.variable = variable;
  }
}

export class SpotifyAuthError extends SpotifyError {
  readonly reason: string;

  constructor(reason = "invalid_grant") {
    super(
      "Spotify refresh token is invalid or revoked. Run scripts/get-refresh-token.ts again.",
    );
    this.reason = reason;
  }
}

export class SpotifyApiError extends SpotifyError {
  readonly reason: string | undefined;
  readonly status: number | undefined;

  constructor(
    status: number | undefined,
    message: string,
    reason?: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.status = status;
    this.reason = reason;
  }
}

export class SpotifyRateLimitError extends SpotifyError {
  readonly reason: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly status = 429;

  constructor(
    retryAfterSeconds: number | undefined,
    message = "Spotify rate limit exceeded.",
    reason?: string,
  ) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
    this.reason = reason;
  }
}

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];

  if (!value?.trim()) {
    throw new SpotifyConfigError(name);
  }

  return value;
}

function getCredentials(): SpotifyCredentials {
  return {
    clientId: requireEnvironmentVariable("SPOTIFY_CLIENT_ID"),
    clientSecret: requireEnvironmentVariable("SPOTIFY_CLIENT_SECRET"),
    refreshToken: requireEnvironmentVariable("SPOTIFY_REFRESH_TOKEN"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmptyString(
  ...values: Array<unknown>
): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

function redactSecrets(
  value: string,
  credentials: SpotifyCredentials,
  accessToken?: string,
): string {
  let safeValue = value;

  for (const secret of [
    credentials.clientId,
    credentials.clientSecret,
    credentials.refreshToken,
    accessToken,
  ]) {
    if (secret) {
      safeValue = safeValue.replaceAll(secret, "[redacted]");
    }
  }

  return safeValue;
}

function parseErrorDetails(
  body: unknown,
  credentials: SpotifyCredentials,
  accessToken?: string,
): SpotifyErrorDetails {
  if (!isRecord(body)) {
    return {};
  }

  const nestedError = isRecord(body.error) ? body.error : undefined;
  const errorCode = typeof body.error === "string" ? body.error : undefined;
  const message = firstNonEmptyString(
    nestedError?.message,
    body.message,
    body.error_description,
    errorCode,
  );
  const reason = firstNonEmptyString(
    nestedError?.reason,
    body.reason,
    errorCode,
  );

  return {
    ...(message
      ? { message: redactSecrets(message, credentials, accessToken) }
      : {}),
    ...(reason
      ? { reason: redactSecrets(reason, credentials, accessToken) }
      : {}),
  };
}

function parseJsonBody(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }

  return JSON.parse(text) as unknown;
}

async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit,
  context: "API" | "token refresh",
): Promise<{ response: Response; text: string }> {
  const timeoutController = new AbortController();
  const timeoutReason = new Error("Spotify fetch timeout.");
  const timeout = setTimeout(() => {
    timeoutController.abort(timeoutReason);
  }, SPOTIFY_FETCH_TIMEOUT_MS);
  const requestDescription =
    context === "API" ? "API request" : "token refresh request";
  let response: Response | undefined;
  let signal: AbortSignal | undefined;

  try {
    const callerSignal = init.signal ?? undefined;
    signal = callerSignal
      ? AbortSignal.any([timeoutController.signal, callerSignal])
      : timeoutController.signal;
    response = await fetch(input, { ...init, signal });
    const text = await response.text();

    return { response, text };
  } catch (cause) {
    if (signal?.aborted) {
      const abortReason = signal.reason ?? cause;
      const message =
        abortReason === timeoutReason
          ? `Spotify ${requestDescription} timed out after ${SPOTIFY_FETCH_TIMEOUT_MS / 1_000} seconds.`
          : `Spotify ${requestDescription} was aborted.`;

      throw new SpotifyApiError(undefined, message, undefined, abortReason);
    }

    if (response) {
      throw new SpotifyApiError(
        response.status,
        `Spotify ${context} response could not be read.`,
        undefined,
        cause,
      );
    }

    throw new SpotifyApiError(
      undefined,
      `Spotify ${requestDescription} failed due to a network error.`,
      undefined,
      cause,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshAccessToken(
  credentials: SpotifyCredentials,
): Promise<string> {
  const authorization = Buffer.from(
    `${credentials.clientId}:${credentials.clientSecret}`,
    "utf8",
  ).toString("base64");
  const { response, text } = await fetchWithTimeout(
    SPOTIFY_TOKEN_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${authorization}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
      }),
    },
    "token refresh",
  );
  let body: unknown;

  try {
    body = parseJsonBody(text);
  } catch (cause) {
    throw new SpotifyApiError(
      response.status,
      "Spotify token refresh returned an invalid response.",
      undefined,
      cause,
    );
  }

  const details = parseErrorDetails(body, credentials);

  if (!response.ok) {
    if (details.reason === "invalid_grant") {
      throw new SpotifyAuthError();
    }

    throw new SpotifyApiError(
      response.status,
      details.message ??
        `Spotify token refresh failed with status ${response.status}.`,
      details.reason,
    );
  }

  if (
    !isRecord(body) ||
    typeof body.access_token !== "string" ||
    !body.access_token ||
    typeof body.expires_in !== "number" ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0
  ) {
    throw new SpotifyApiError(
      response.status,
      "Spotify token refresh returned an invalid access token response.",
    );
  }

  const accessToken = body.access_token;
  cachedAccessToken = {
    accessToken,
    expiresAt:
      Date.now() + body.expires_in * 1_000 - TOKEN_EXPIRY_MARGIN_MS,
  };

  return accessToken;
}

async function getAccessToken(
  credentials: SpotifyCredentials,
): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) {
    return cachedAccessToken.accessToken;
  }

  const refreshPromise =
    tokenRefreshInFlight ??
    (tokenRefreshInFlight = refreshAccessToken(credentials));

  try {
    return await refreshPromise;
  } finally {
    if (tokenRefreshInFlight === refreshPromise) {
      tokenRefreshInFlight = undefined;
    }
  }
}

function buildSpotifyUrl(
  path: string,
  query: SpotifyRequestInit["query"],
): URL {
  const url = new URL(
    `${SPOTIFY_API_BASE_URL}${path.replace(/^\/+/, "")}`,
  );

  if (
    url.origin !== "https://api.spotify.com" ||
    (!url.pathname.startsWith("/v1/") && url.pathname !== "/v1")
  ) {
    throw new TypeError("Spotify request paths must stay under /v1.");
  }

  if (query instanceof URLSearchParams) {
    for (const [key, value] of query) {
      url.searchParams.append(key, value);
    }
  } else if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url;
}

function createSpotifyRequest(
  path: string,
  init: SpotifyRequestInit,
): { fetchInit: RequestInit; url: URL } {
  const { body, query, ...requestOptions } = init;
  const url = buildSpotifyUrl(path, query);
  const headers = new Headers(requestOptions.headers);
  const fetchInit: RequestInit = { ...requestOptions, headers };

  if (body !== undefined) {
    const jsonBody = JSON.stringify(body);

    if (jsonBody === undefined) {
      throw new TypeError("Spotify request body must be JSON serializable.");
    }

    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    fetchInit.body = jsonBody;
  }

  return { fetchInit, url };
}

async function fetchSpotify(
  url: URL,
  init: RequestInit,
  credentials: SpotifyCredentials,
): Promise<{ accessToken: string; response: Response; text: string }> {
  const accessToken = await getAccessToken(credentials);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  const { response, text } = await fetchWithTimeout(
    url,
    { ...init, headers },
    "API",
  );

  return { accessToken, response, text };
}

export async function requestRaw(
  path: string,
  init: SpotifyRequestInit = {},
): Promise<SpotifyRawResponse> {
  const credentials = getCredentials();
  const { fetchInit, url } = createSpotifyRequest(path, init);
  const { accessToken, response, text } = await fetchSpotify(
    url,
    fetchInit,
    credentials,
  );

  return {
    status: response.status,
    headers: response.headers,
    bodyText: redactSecrets(text, credentials, accessToken),
  };
}

function readErrorDetails(
  text: string,
  response: Response,
  credentials: SpotifyCredentials,
  accessToken: string,
): SpotifyErrorDetails {
  try {
    return parseErrorDetails(parseJsonBody(text), credentials, accessToken);
  } catch (cause) {
    if (cause instanceof SpotifyApiError) {
      throw cause;
    }

    throw new SpotifyApiError(
      response.status,
      "Spotify returned an invalid error response.",
      undefined,
      cause,
    );
  }
}

function parseRetryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();

  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) {
    return undefined;
  }

  const seconds = Number(value);

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function parseSuccessBody<T>(
  response: Response,
  text: string,
): T | undefined {
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new SpotifyApiError(
      response.status,
      "Spotify returned an invalid JSON response.",
      undefined,
      cause,
    );
  }
}

export async function request<T = unknown>(
  path: string,
  init: SpotifyRequestInit = {},
): Promise<T | undefined> {
  const credentials = getCredentials();
  const { fetchInit, url } = createSpotifyRequest(path, init);
  let { accessToken, response, text } = await fetchSpotify(
    url,
    fetchInit,
    credentials,
  );

  if (response.status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(response);
    const details = readErrorDetails(text, response, credentials, accessToken);

    if (
      retryAfterSeconds === undefined ||
      retryAfterSeconds > MAX_RETRY_AFTER_SECONDS
    ) {
      throw new SpotifyRateLimitError(
        retryAfterSeconds,
        details.message,
        details.reason,
      );
    }

    await wait(retryAfterSeconds * 1_000);
    ({ accessToken, response, text } = await fetchSpotify(
      url,
      fetchInit,
      credentials,
    ));

    if (response.status === 429) {
      const retryAfter = parseRetryAfterSeconds(response);
      const retryDetails = readErrorDetails(
        text,
        response,
        credentials,
        accessToken,
      );

      throw new SpotifyRateLimitError(
        retryAfter,
        retryDetails.message,
        retryDetails.reason,
      );
    }
  }

  if (!response.ok) {
    const details = readErrorDetails(text, response, credentials, accessToken);

    throw new SpotifyApiError(
      response.status,
      details.message ??
        `Spotify API request failed with status ${response.status}.`,
      details.reason,
    );
  }

  return parseSuccessBody<T>(response, text);
}

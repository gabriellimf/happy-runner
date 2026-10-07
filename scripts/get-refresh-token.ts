import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1_000;

export const SPOTIFY_AUTH_SCOPES = [
  "user-modify-playback-state",
  "user-read-playback-state",
] as const;

interface AuthorizationUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
}

interface AuthorizationCodeExchangeOptions {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

class SpotifyAuthScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function buildAuthorizationUrl({
  clientId,
  redirectUri,
  state,
}: AuthorizationUrlOptions): URL {
  const url = new URL(SPOTIFY_AUTHORIZE_URL);

  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SPOTIFY_AUTH_SCOPES.join(" "),
    state,
  }).toString();

  return url;
}

export function parseAuthorizationCallback(
  callbackUrl: string | URL,
  expectedState: string,
): string {
  const url =
    typeof callbackUrl === "string" ? new URL(callbackUrl) : callbackUrl;

  if (url.searchParams.get("state") !== expectedState) {
    throw new SpotifyAuthScriptError(
      "Spotify callback state did not match. Authorization was stopped.",
    );
  }

  const authorizationError = url.searchParams.get("error");

  if (authorizationError === "access_denied") {
    throw new SpotifyAuthScriptError(
      "Spotify access was denied. Run the script again and approve access.",
    );
  }

  if (authorizationError) {
    throw new SpotifyAuthScriptError(
      "Spotify authorization failed. Run the script again.",
    );
  }

  const code = url.searchParams.get("code");

  if (!code) {
    throw new SpotifyAuthScriptError(
      "Spotify callback did not include an authorization code.",
    );
  }

  return code;
}

export async function exchangeAuthorizationCode({
  clientId,
  clientSecret,
  code,
  redirectUri,
  fetchImpl = fetch,
  signal,
}: AuthorizationCodeExchangeOptions): Promise<string> {
  const authorization = Buffer.from(
    `${clientId}:${clientSecret}`,
    "utf8",
  ).toString("base64");
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Basic ${authorization}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  };

  if (signal) {
    requestInit.signal = signal;
  }

  let response: Response;

  try {
    response = await fetchImpl(SPOTIFY_TOKEN_URL, requestInit);
  } catch {
    throw new SpotifyAuthScriptError(
      "Spotify token exchange request failed. Check your network connection.",
    );
  }

  let responseBody: string;

  try {
    responseBody = await response.text();
  } catch {
    throw new SpotifyAuthScriptError(
      "Spotify token exchange response could not be read.",
    );
  }

  let tokenResponse: unknown;

  try {
    tokenResponse = responseBody.trim()
      ? (JSON.parse(responseBody) as unknown)
      : undefined;
  } catch {
    if (!response.ok) {
      throw new SpotifyAuthScriptError(
        `Spotify token exchange failed with HTTP ${response.status}.`,
      );
    }

    throw new SpotifyAuthScriptError(
      "Spotify token exchange returned an invalid response.",
    );
  }

  if (!response.ok) {
    if (
      typeof tokenResponse === "object" &&
      tokenResponse !== null &&
      "error" in tokenResponse &&
      tokenResponse.error === "invalid_grant"
    ) {
      throw new SpotifyAuthScriptError(
        "Spotify rejected the authorization code. Run the script again.",
      );
    }

    throw new SpotifyAuthScriptError(
      `Spotify token exchange failed with HTTP ${response.status}.`,
    );
  }

  if (
    typeof tokenResponse !== "object" ||
    tokenResponse === null ||
    !("refresh_token" in tokenResponse) ||
    typeof tokenResponse.refresh_token !== "string" ||
    !tokenResponse.refresh_token
  ) {
    throw new SpotifyAuthScriptError(
      "Spotify did not return a refresh token. Confirm authorization and try again.",
    );
  }

  return tokenResponse.refresh_token;
}

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];

  if (!value?.trim()) {
    throw new SpotifyAuthScriptError(
      `Missing required environment variable: ${name}.`,
    );
  }

  return value;
}

function getLoopbackPort(redirectUri: string): number {
  let url: URL;

  try {
    url = new URL(redirectUri);
  } catch {
    throw new SpotifyAuthScriptError(
      "SPOTIFY_REDIRECT_URI must be an HTTP loopback URI for 127.0.0.1 with an explicit port and /callback path.",
    );
  }

  const port = Number(url.port);

  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.pathname !== "/callback" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.href !== redirectUri
  ) {
    throw new SpotifyAuthScriptError(
      "SPOTIFY_REDIRECT_URI must be an HTTP loopback URI for 127.0.0.1 with an explicit port and /callback path.",
    );
  }

  return port;
}

function startServer(server: Server, port: number): Promise<void> {
  return new Promise((resolveStart, rejectStart) => {
    const onListening = () => {
      server.off("error", onError);
      resolveStart();
    };
    const onError = () => {
      server.off("listening", onListening);
      rejectStart(
        new SpotifyAuthScriptError(
          "Could not start the local callback server. Check whether the redirect URI port is available.",
        ),
      );
    };

    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(port, "127.0.0.1");
  });
}

function stopServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolveStop, rejectStop) => {
    server.close((error) => {
      if (error) {
        rejectStop(
          new SpotifyAuthScriptError(
            "Could not stop the local callback server.",
          ),
        );
        return;
      }

      resolveStop();
    });
  });
}

async function runAuthorizationFlow(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  port: number,
): Promise<string> {
  const state = randomBytes(32).toString("hex");
  const authorizationUrl = buildAuthorizationUrl({
    clientId,
    redirectUri,
    state,
  });
  const redirectPath = new URL(redirectUri).pathname;
  const abortController = new AbortController();
  let resolveResult!: (refreshToken: string) => void;
  let rejectResult!: (error: Error) => void;
  let settled = false;
  let callbackHandled = false;
  const callbackResult = new Promise<string>((resolveResultPromise, reject) => {
    resolveResult = resolveResultPromise;
    rejectResult = reject;
  });
  const server = createServer((request, response) => {
    const respond = (status: number, body: string) => {
      response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end(body);
    };

    if (request.method !== "GET") {
      respond(405, "Use the Spotify authorization link.");
      return;
    }

    let callbackUrl: URL;

    try {
      callbackUrl = new URL(request.url ?? "/", redirectUri);
    } catch {
      respond(400, "Invalid callback.");
      return;
    }

    if (callbackUrl.pathname !== redirectPath) {
      respond(404, "Not found.");
      return;
    }

    if (callbackHandled || settled) {
      respond(409, "Authorization has already finished.");
      return;
    }

    callbackHandled = true;

    void (async () => {
      try {
        const code = parseAuthorizationCallback(callbackUrl, state);
        const refreshToken = await exchangeAuthorizationCode({
          clientId,
          clientSecret,
          code,
          redirectUri,
          signal: abortController.signal,
        });

        respond(200, "Authorization complete. Return to the terminal.");

        if (!settled) {
          settled = true;
          resolveResult(refreshToken);
        }
      } catch (error) {
        respond(400, "Authorization failed. Return to the terminal.");

        if (!settled) {
          settled = true;
          rejectResult(
            error instanceof SpotifyAuthScriptError
              ? error
              : new SpotifyAuthScriptError("Spotify authorization failed."),
          );
        }
      }
    })();
  });

  await startServer(server, port);

  server.on("error", () => {
    abortController.abort();

    if (!settled) {
      settled = true;
      rejectResult(
        new SpotifyAuthScriptError("The local callback server failed."),
      );
    }
  });

  const timeout = setTimeout(() => {
    abortController.abort();

    if (!settled) {
      settled = true;
      rejectResult(
        new SpotifyAuthScriptError(
          "Spotify authorization timed out. Run the script again.",
        ),
      );
    }
  }, AUTHORIZATION_TIMEOUT_MS);

  process.stdout.write(
    `Open this URL in a browser:\n${authorizationUrl.href}\n`,
  );

  try {
    return await callbackResult;
  } finally {
    clearTimeout(timeout);
    await stopServer(server);
  }
}

async function runCli(): Promise<void> {
  const clientId = requireEnvironmentVariable("SPOTIFY_CLIENT_ID");
  const clientSecret = requireEnvironmentVariable("SPOTIFY_CLIENT_SECRET");
  const redirectUri = requireEnvironmentVariable("SPOTIFY_REDIRECT_URI");
  const port = getLoopbackPort(redirectUri);
  const refreshToken = await runAuthorizationFlow(
    clientId,
    clientSecret,
    redirectUri,
    port,
  );

  process.stdout.write(`${refreshToken}\n`);
}

function isEntrypoint(): boolean {
  const entryPath = process.argv[1];

  return (
    entryPath !== undefined &&
    import.meta.url === pathToFileURL(resolve(entryPath)).href
  );
}

if (isEntrypoint()) {
  void runCli().catch((error: unknown) => {
    const message =
      error instanceof SpotifyAuthScriptError
        ? error.message
        : "Spotify authorization failed.";

    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

import { describe, expect, it, vi } from "vitest";

import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  parseAuthorizationCallback,
  SPOTIFY_AUTH_SCOPES,
} from "../scripts/get-refresh-token";

describe("Spotify owner authorization helpers", () => {
  it("builds an authorization URL with the required scopes and callback state", () => {
    const url = buildAuthorizationUrl({
      clientId: "test-client-id",
      redirectUri: "http://127.0.0.1:8888/callback",
      state: "random-state-value",
    });

    expect(url.origin + url.pathname).toBe(
      "https://accounts.spotify.com/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8888/callback",
    );
    expect(url.searchParams.get("scope")).toBe(SPOTIFY_AUTH_SCOPES.join(" "));
    expect(url.searchParams.get("state")).toBe("random-state-value");
  });

  it("rejects a callback with a mismatched state", () => {
    expect(() =>
      parseAuthorizationCallback(
        "http://127.0.0.1:8888/callback?code=not-a-real-code&state=wrong",
        "expected-state",
      ),
    ).toThrow("Spotify callback state did not match");
  });

  it("reports denied access without exposing callback values", () => {
    expect(() =>
      parseAuthorizationCallback(
        "http://127.0.0.1:8888/callback?error=access_denied&state=expected-state",
        "expected-state",
      ),
    ).toThrow("Spotify access was denied");
  });

  it("exchanges the code with Basic authentication and returns the refresh token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );
    const refreshToken = await exchangeAuthorizationCode({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      code: "test-authorization-code",
      redirectUri: "http://127.0.0.1:8888/callback",
      fetchImpl: fetchMock,
    });
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    const tokenHeaders = new Headers(tokenInit?.headers);
    const tokenBody = new URLSearchParams(String(tokenInit?.body));

    expect(refreshToken).toBe("test-refresh-token");
    expect(String(tokenUrl)).toBe("https://accounts.spotify.com/api/token");
    expect(tokenInit?.method).toBe("POST");
    expect(tokenHeaders.get("Authorization")).toBe(
      `Basic ${Buffer.from(
        "test-client-id:test-client-secret",
        "utf8",
      ).toString("base64")}`,
    );
    expect(tokenHeaders.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(tokenBody)).toEqual({
      code: "test-authorization-code",
      grant_type: "authorization_code",
      redirect_uri: "http://127.0.0.1:8888/callback",
    });
  });

  it("fails clearly when Spotify does not return a refresh token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "not-for-output" }), {
        status: 200,
      }),
    );

    await expect(
      exchangeAuthorizationCode({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        code: "test-authorization-code",
        redirectUri: "http://127.0.0.1:8888/callback",
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow("Spotify did not return a refresh token");
  });

  it("does not expose the client secret or authorization code in exchange errors", async () => {
    const clientSecret = "test-client-secret-not-a-credential";
    const authorizationCode = "test-authorization-code-not-a-credential";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: `${clientSecret} ${authorizationCode}`,
        }),
        { status: 400 },
      ),
    );

    const error = await exchangeAuthorizationCode({
      clientId: "test-client-id",
      clientSecret,
      code: authorizationCode,
      redirectUri: "http://127.0.0.1:8888/callback",
      fetchImpl: fetchMock,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);

    const errorMessage = error instanceof Error ? error.message : "";
    expect(errorMessage).not.toContain(clientSecret);
    expect(errorMessage).not.toContain(authorizationCode);
  });
});

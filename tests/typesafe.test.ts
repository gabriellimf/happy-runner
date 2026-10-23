import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  TypeSafeError,
} from "@typesafe-ai/sdk";

import {
  getTypeSafeClient,
  isTypeSafeCircuitOpen,
  logTypeSafeError,
  recordTypeSafeFailure,
  recordTypeSafeSuccess,
  TYPESAFE_CIRCUIT_COOLDOWN_MS,
  TYPESAFE_CIRCUIT_FAILURE_THRESHOLD,
} from "../lib/typesafe";

const { typeSafeClientMock } = vi.hoisted(() => ({
  typeSafeClientMock: vi.fn(function TypeSafeClientMock() {}),
}));

vi.mock("@typesafe-ai/sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@typesafe-ai/sdk")>();

  return {
    ...sdk,
    TypeSafeClient: typeSafeClientMock,
  };
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  recordTypeSafeSuccess();
  typeSafeClientMock.mockImplementation(function () {
    throw new TypeSafeError("private constructor details");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function apiError(status: number): APIError {
  return new APIError(status, undefined, new Headers());
}

describe("TypeSafe client", () => {
  it("logs and returns null when client construction fails", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(getTypeSafeClient()).toBeNull();
    expect(consoleError).toHaveBeenCalledWith({
      errorClass: "TypeSafeError",
      feature: "client-init",
    });
  });

  it.each([400, 429])(
    "logs only the HTTP %i status for SDK API errors",
    (status) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const error = new APIError(
        status,
        { detail: "private response body" },
        new Headers(),
        "private error message",
      );

      logTypeSafeError("search-judgment", error);

      expect(consoleError).toHaveBeenCalledWith({
        errorClass: "APIError",
        feature: "search-judgment",
        status,
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private");
    },
  );
});

describe("TypeSafe circuit breaker", () => {
  it("clears the open state after cooldown and reopens on another failure", () => {
    vi.useFakeTimers();

    const failure = new APIConnectionError("service unavailable");

    for (let count = 1; count < TYPESAFE_CIRCUIT_FAILURE_THRESHOLD; count += 1) {
      recordTypeSafeFailure(failure);
    }

    expect(isTypeSafeCircuitOpen()).toBe(false);

    recordTypeSafeFailure(failure);
    expect(isTypeSafeCircuitOpen()).toBe(true);

    vi.advanceTimersByTime(TYPESAFE_CIRCUIT_COOLDOWN_MS - 1);
    expect(isTypeSafeCircuitOpen()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isTypeSafeCircuitOpen()).toBe(false);

    recordTypeSafeFailure(failure);
    expect(isTypeSafeCircuitOpen()).toBe(true);

    recordTypeSafeSuccess();
    expect(isTypeSafeCircuitOpen()).toBe(false);
  });

  it("resets the failure count on the first success", () => {
    for (let failure = 1; failure < TYPESAFE_CIRCUIT_FAILURE_THRESHOLD; failure += 1) {
      recordTypeSafeFailure(new APIConnectionError("service unavailable"));
    }

    recordTypeSafeSuccess();

    for (let failure = 1; failure < TYPESAFE_CIRCUIT_FAILURE_THRESHOLD; failure += 1) {
      recordTypeSafeFailure(new APIConnectionError("service unavailable"));
    }

    expect(isTypeSafeCircuitOpen()).toBe(false);
    recordTypeSafeFailure(new APIConnectionError("service unavailable"));
    expect(isTypeSafeCircuitOpen()).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])(
    "does not count HTTP %i as a service failure",
    (status) => {
      for (
        let failure = 0;
        failure < TYPESAFE_CIRCUIT_FAILURE_THRESHOLD;
        failure += 1
      ) {
        recordTypeSafeFailure(apiError(status));
      }

      expect(isTypeSafeCircuitOpen()).toBe(false);
    },
  );

  it.each([408, 429, 500, 503, 599])(
    "counts HTTP %i as a service failure",
    (status) => {
      const failure = apiError(status);

      for (
        let count = 0;
        count < TYPESAFE_CIRCUIT_FAILURE_THRESHOLD;
        count += 1
      ) {
        recordTypeSafeFailure(failure);
      }

      expect(isTypeSafeCircuitOpen()).toBe(true);
    },
  );

  it.each([
    ["network", new APIConnectionError("network failure")],
    ["timeout", new APITimeoutError(2_000)],
  ])("counts SDK %s errors as service failures", (_label, failure) => {
    for (
      let count = 0;
      count < TYPESAFE_CIRCUIT_FAILURE_THRESHOLD;
      count += 1
    ) {
      recordTypeSafeFailure(failure);
    }

    expect(isTypeSafeCircuitOpen()).toBe(true);
  });
});

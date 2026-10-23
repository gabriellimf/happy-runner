import {
  APIConnectionError,
  APIError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";

// Pinned: the confidence thresholds were tuned against this exact version.
export const TYPESAFE_MODEL = "jev-1.14.0";

const REQUEST_TIMEOUT_MS = 2_000;

export const TYPESAFE_CIRCUIT_FAILURE_THRESHOLD = 3;
export const TYPESAFE_CIRCUIT_COOLDOWN_MS = 30_000;

export interface ChoiceVerdict {
  choice: string;
  confidence: number;
}

let cached: { apiKey: string; client: TypeSafeClient } | undefined;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

// Three failures allow two transient blips. The 30-second cooldown gives the
// service a short recovery window. This is per-instance, so it is best-effort
// on a serverless deployment.
export function isTypeSafeCircuitOpen(): boolean {
  if (circuitOpenUntil === 0) {
    return false;
  }

  if (Date.now() < circuitOpenUntil) {
    return true;
  }

  circuitOpenUntil = 0;
  return false;
}

function isServiceFailure(error: unknown): boolean {
  return (
    error instanceof APIConnectionError ||
    (error instanceof APIError &&
      (error.status === 408 ||
        error.status === 429 ||
        (error.status >= 500 && error.status < 600)))
  );
}

export function recordTypeSafeFailure(error: unknown): void {
  if (!isServiceFailure(error)) {
    return;
  }

  consecutiveFailures += 1;

  if (consecutiveFailures >= TYPESAFE_CIRCUIT_FAILURE_THRESHOLD) {
    circuitOpenUntil = Date.now() + TYPESAFE_CIRCUIT_COOLDOWN_MS;
  }
}

export function recordTypeSafeSuccess(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

// Returns null when TYPESAFE_API_KEY is not set, so callers skip the check.
export function getTypeSafeClient(): TypeSafeClient | null {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();

  if (!apiKey) {
    return null;
  }

  try {
    if (cached?.apiKey !== apiKey) {
      cached = {
        apiKey,
        client: new TypeSafeClient({
          apiKey,
          defaultModel: TYPESAFE_MODEL,
          retry: { maxRetries: 0 },
          timeout: REQUEST_TIMEOUT_MS,
        }),
      };
    }

    return cached.client;
  } catch (error) {
    recordTypeSafeFailure(error);
    logTypeSafeError("client-init", error);
    return null;
  }
}

export function logTypeSafeError(feature: string, error: unknown): void {
  console.error({
    errorClass:
      error instanceof Error ? error.constructor.name : "UnknownError",
    feature,
    ...(error instanceof APIError ? { status: error.status } : {}),
  });
}

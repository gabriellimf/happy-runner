import { TypeSafeClient } from "@typesafe-ai/sdk";

// Pinned: the confidence thresholds were tuned against this exact version.
export const TYPESAFE_MODEL = "jev-1.14.0";

const REQUEST_TIMEOUT_MS = 2_000;

export interface ChoiceVerdict {
  choice: string;
  confidence: number;
}

let cached: { apiKey: string; client: TypeSafeClient } | undefined;

// Returns null when TYPESAFE_API_KEY is not set, so callers skip the check.
export function getTypeSafeClient(): TypeSafeClient | null {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();

  if (!apiKey) {
    return null;
  }

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
}

export function logTypeSafeError(feature: string, error: unknown): void {
  console.error({
    errorClass:
      error instanceof Error ? error.constructor.name : "UnknownError",
    feature,
  });
}

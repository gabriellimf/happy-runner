import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { requestRaw, SpotifyConfigError } from "../lib/spotify.ts";
import type { SpotifyRequestInit } from "../lib/spotify.ts";

const REDACTED_VALUE = "[redacted]";
const BURST_MAX_CALLS = 60;
const BURST_MAX_DURATION_MS = 30_000;
const QUEUE_CHECK_TIMES_MS = [2_000, 6_000] as const;
const SEARCH_LIMIT = 1;
const RESPONSE_HEADER_NAMES = new Set([
  "content-type",
  "date",
  "retry-after",
  "server",
]);
const SECRET_FIELD_NAMES = new Set([
  "access_token",
  "accesstoken",
  "authorization",
  "client_secret",
  "clientsecret",
  "refresh_token",
  "refreshtoken",
]);
const OWNER_FIELD_NAMES = new Set([
  "display_name",
  "displayname",
  "owner_id",
  "ownerid",
  "owner_name",
  "ownername",
  "user_id",
  "userid",
  "user_name",
  "username",
]);
const DEVICE_COLLECTION_NAMES = new Set([
  "available_devices",
  "availabledevices",
  "devices",
]);
const USER_URI_PATTERN = /spotify:user:(?!\[redacted\])[^\s"'`,}\]]+/i;
const USER_URL_PATTERN = /\/users?\/(?!\[redacted\])[^/?#\s"'`,}\]]+/i;
const BURST_WARNING =
  "WARNING: burst sends up to 60 sequential queue requests for 30 seconds. A 429 response may lock the Spotify app for the Retry-After time.";
const USAGE = [
  "Usage:",
  "  node --env-file=.env.local scripts/spike-probe.ts queue [--save-sample]",
  "  node --env-file=.env.local scripts/spike-probe.ts devices",
  '  node --env-file=.env.local scripts/spike-probe.ts add <track-uri> [--note "<text>"]',
  '  node --env-file=.env.local scripts/spike-probe.ts add --query "<text>" [--note "<text>"]',
  "  node --env-file=.env.local scripts/spike-probe.ts burst --yes",
  "",
  BURST_WARNING,
].join("\n");

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_OUTPUT_DIRECTORY = resolve(REPOSITORY_ROOT, "spike-output");
const DEFAULT_SAMPLE_PATH = resolve(
  REPOSITORY_ROOT,
  "docs",
  "samples",
  "queue-response.json",
);

type ProbeStep = "queue" | "devices" | "add" | "burst";

interface RedactionContext {
  owner: boolean;
  user: boolean;
  device: boolean;
}

interface QueueItemSummary {
  type: string | null;
  uri: string | null;
  name: string | null;
}

export interface QueueSummary {
  currentlyPlayingPresent: boolean;
  queueItemCount: number;
  itemTypes: Array<string | null>;
  items: QueueItemSummary[];
}

export interface DeviceSummary {
  deviceCount: number;
  devices: Array<{
    type: string | null;
    is_active: boolean | null;
    is_restricted: boolean | null;
  }>;
}

export interface ProbeOverrides {
  dateNow?: () => Date;
  ensureDirectory?: (path: string) => Promise<void>;
  monotonicNow?: () => number;
  outputDirectory?: string;
  samplePath?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  stderr?: (line: string) => void;
  stdout?: (line: string) => void;
  writeTextFile?: (path: string, contents: string) => Promise<void>;
}

interface ProbeRuntime {
  dateNow: () => Date;
  ensureDirectory: (path: string) => Promise<void>;
  monotonicNow: () => number;
  outputDirectory: string;
  samplePath: string;
  secrets: string[];
  sleep: (milliseconds: number) => Promise<void>;
  stderr: (line: string) => void;
  stdout: (line: string) => void;
  writeTextFile: (path: string, contents: string) => Promise<void>;
}

interface CapturedResponse {
  status: number | null;
  headers: Record<string, string>;
  body: unknown;
  elapsedMs: number;
  error?: string;
}

type AddSource =
  | { kind: "uri"; trackUri: string }
  | { kind: "query"; query: string };

type ProbeCommand =
  | { step: "queue"; saveSample: boolean }
  | { step: "devices" }
  | { step: "add"; source: AddSource; note?: string }
  | { step: "burst"; confirmed: boolean };

class ProbeArgumentError extends Error {}

class ProbeSampleError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredSecretValues(): string[] {
  return [
    process.env.SPOTIFY_CLIENT_ID,
    process.env.SPOTIFY_CLIENT_SECRET,
    process.env.SPOTIFY_REFRESH_TOKEN,
  ].filter((value): value is string => Boolean(value));
}

function preserveShapeAsRedacted(value: unknown): unknown {
  if (typeof value === "string") {
    return REDACTED_VALUE;
  }

  if (typeof value === "number") {
    return 0;
  }

  if (typeof value === "boolean") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.map(preserveShapeAsRedacted);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        preserveShapeAsRedacted(child),
      ]),
    );
  }

  return value;
}

function shouldRedactField(
  key: string,
  value: unknown,
  context: RedactionContext,
): boolean {
  const normalizedKey = key.toLowerCase();

  return (
    SECRET_FIELD_NAMES.has(normalizedKey) ||
    OWNER_FIELD_NAMES.has(normalizedKey) ||
    normalizedKey === "device_id" ||
    normalizedKey === "deviceid" ||
    (normalizedKey === "owner" && typeof value === "string") ||
    (normalizedKey === "device" && typeof value === "string") ||
    ((context.owner || context.user) &&
      ["display_name", "href", "id", "name", "uri"].includes(normalizedKey)) ||
    (context.device && ["id", "name"].includes(normalizedKey))
  );
}

function redactString(
  value: string,
  key: string,
  secrets: readonly string[],
): string {
  let safeValue = value;

  for (const secret of secrets) {
    if (secret) {
      safeValue = safeValue.replaceAll(secret, REDACTED_VALUE);
    }
  }

  if (key.toLowerCase() === "href" && USER_URL_PATTERN.test(safeValue)) {
    return REDACTED_VALUE;
  }

  return safeValue
    .replace(
      /spotify:user:(?!\[redacted\])[^\s"'`,}\]]+/gi,
      "spotify:user:[redacted]",
    )
    .replace(
      /\/(users?)\/(?!\[redacted\])[^/?#\s"'`,}\]]+/gi,
      "/$1/[redacted]",
    );
}

function redactValue(
  value: unknown,
  secrets: readonly string[],
  key = "",
  context: RedactionContext = { owner: false, user: false, device: false },
): unknown {
  if (shouldRedactField(key, value, context)) {
    return preserveShapeAsRedacted(value);
  }

  if (typeof value === "string") {
    return redactString(value, key, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((child) => redactValue(child, secrets, key, context));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => {
      const normalizedKey = childKey.toLowerCase();
      const childContext: RedactionContext = {
        owner: context.owner || normalizedKey === "owner",
        user: context.user || normalizedKey === "user",
        device:
          context.device ||
          normalizedKey === "device" ||
          DEVICE_COLLECTION_NAMES.has(normalizedKey),
      };

      return [
        childKey,
        redactValue(childValue, secrets, childKey, childContext),
      ];
    }),
  );
}

export function redact(
  value: unknown,
  secrets: readonly string[] = configuredSecretValues(),
): unknown {
  return redactValue(value, secrets);
}

export function allowlistedHeaders(
  headers: Headers,
): Record<string, string> {
  const allowed: Record<string, string> = {};

  headers.forEach((value, name) => {
    const normalizedName = name.toLowerCase();

    if (
      RESPONSE_HEADER_NAMES.has(normalizedName) ||
      normalizedName.startsWith("x-ratelimit-") ||
      normalizedName.startsWith("ratelimit-")
    ) {
      allowed[normalizedName] = value;
    }
  });

  return allowed;
}

function redactHeaders(
  headers: Headers,
  secrets: readonly string[],
): Record<string, string> {
  const redactedHeaders: Record<string, string> = {};

  for (const [name, value] of Object.entries(allowlistedHeaders(headers))) {
    const safeValue = redact(value, secrets);

    if (typeof safeValue === "string") {
      redactedHeaders[name] = safeValue;
    }
  }

  return redactedHeaders;
}

function parseResponseBody(bodyText: string): unknown {
  if (!bodyText.trim()) {
    return null;
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

function safeRequestError(error: unknown): string {
  if (error instanceof SpotifyConfigError) {
    return `Missing required environment variable: ${error.variable}.`;
  }

  return "Request failed before an HTTP response.";
}

function resolveRuntime(overrides: ProbeOverrides): ProbeRuntime {
  return {
    dateNow: overrides.dateNow ?? (() => new Date()),
    ensureDirectory:
      overrides.ensureDirectory ??
      (async (path) => {
        await mkdir(path, { recursive: true });
      }),
    monotonicNow: overrides.monotonicNow ?? (() => performance.now()),
    outputDirectory: overrides.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY,
    samplePath: overrides.samplePath ?? DEFAULT_SAMPLE_PATH,
    secrets: configuredSecretValues(),
    sleep:
      overrides.sleep ??
      ((milliseconds) =>
        new Promise((resolveSleep) => {
          setTimeout(resolveSleep, milliseconds);
        })),
    stderr:
      overrides.stderr ??
      ((line) => {
        process.stderr.write(`${line}\n`);
      }),
    stdout:
      overrides.stdout ??
      ((line) => {
        process.stdout.write(`${line}\n`);
      }),
    writeTextFile:
      overrides.writeTextFile ??
      (async (path, contents) => {
        await writeFile(path, contents, { encoding: "utf8" });
      }),
  };
}

function writeSafeLine(
  writer: (line: string) => void,
  line: string,
  secrets: readonly string[],
): void {
  const safeLine = redact(line, secrets);

  if (typeof safeLine === "string") {
    writer(safeLine);
  }
}

function formatUtcTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

export function buildOutputPath(
  step: ProbeStep,
  date: Date,
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
): string {
  return resolve(
    outputDirectory,
    `${step}-${formatUtcTimestamp(date)}.json`,
  );
}

async function saveResult(
  step: ProbeStep,
  recordedAt: Date,
  result: unknown,
  runtime: ProbeRuntime,
): Promise<string> {
  const outputPath = buildOutputPath(
    step,
    recordedAt,
    runtime.outputDirectory,
  );
  const safeResult = redact(result, runtime.secrets);

  await runtime.ensureDirectory(runtime.outputDirectory);
  await runtime.writeTextFile(
    outputPath,
    `${JSON.stringify(safeResult, null, 2)}\n`,
  );

  return outputPath;
}

async function captureResponse(
  path: string,
  init: SpotifyRequestInit,
  runtime: ProbeRuntime,
): Promise<CapturedResponse> {
  const startedAt = runtime.monotonicNow();

  try {
    const response = await requestRaw(path, init);
    const parsedBody = parseResponseBody(response.bodyText);

    return {
      status: response.status,
      headers: redactHeaders(response.headers, runtime.secrets),
      body: redact(parsedBody, runtime.secrets),
      elapsedMs: Math.max(0, Math.round(runtime.monotonicNow() - startedAt)),
    };
  } catch (error) {
    const message = safeRequestError(error);

    return {
      status: null,
      headers: {},
      body: redact({ error: message }, runtime.secrets),
      elapsedMs: Math.max(0, Math.round(runtime.monotonicNow() - startedAt)),
      error: message,
    };
  }
}

function getQueueItems(body: unknown): unknown[] {
  return isRecord(body) && Array.isArray(body.queue) ? body.queue : [];
}

function stringField(
  value: unknown,
  key: string,
): string | null {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : null;
}

export function summarizeQueue(body: unknown): QueueSummary {
  const queueItems = getQueueItems(body);

  return {
    currentlyPlayingPresent:
      isRecord(body) &&
      Object.prototype.hasOwnProperty.call(body, "currently_playing"),
    queueItemCount: queueItems.length,
    itemTypes: queueItems.map((item) => stringField(item, "type")),
    items: queueItems.map((item) => ({
      type: stringField(item, "type"),
      uri: stringField(item, "uri"),
      name: stringField(item, "name"),
    })),
  };
}

export function summarizeDevices(body: unknown): DeviceSummary {
  const devices =
    isRecord(body) && Array.isArray(body.devices) ? body.devices : [];

  return {
    deviceCount: devices.length,
    devices: devices.map((device) => ({
      type: stringField(device, "type"),
      is_active:
        isRecord(device) && typeof device.is_active === "boolean"
          ? device.is_active
          : null,
      is_restricted:
        isRecord(device) && typeof device.is_restricted === "boolean"
          ? device.is_restricted
          : null,
    })),
  };
}

function getFirstTrack(
  body: unknown,
): { uri: string; name: string | null } | undefined {
  if (!isRecord(body) || !isRecord(body.tracks) || !Array.isArray(body.tracks.items)) {
    return undefined;
  }

  const firstTrack = body.tracks.items[0];
  const uri = stringField(firstTrack, "uri");

  if (!uri) {
    return undefined;
  }

  return {
    uri,
    name: stringField(firstTrack, "name"),
  };
}

function parseProbeCommand(args: string[]): ProbeCommand {
  const [step, ...options] = args;

  if (step !== "queue" && step !== "devices" && step !== "add" && step !== "burst") {
    throw new ProbeArgumentError("Choose one step: queue, devices, add, or burst.");
  }

  const positionals: string[] = [];
  let query: string | undefined;
  let note: string | undefined;
  let saveSample = false;
  let confirmed = false;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];

    if (option === "--save-sample") {
      saveSample = true;
      continue;
    }

    if (option === "--yes") {
      confirmed = true;
      continue;
    }

    if (option === "--query" || option === "--note") {
      const value = options[index + 1];

      if (!value || value.startsWith("--")) {
        throw new ProbeArgumentError(`${option} needs a value.`);
      }

      if (option === "--query") {
        query = value;
      } else {
        note = value;
      }

      index += 1;
      continue;
    }

    if (option.startsWith("--")) {
      throw new ProbeArgumentError(`Unknown option: ${option}.`);
    }

    positionals.push(option);
  }

  if (step === "queue") {
    if (positionals.length > 0 || query !== undefined || note !== undefined || confirmed) {
      throw new ProbeArgumentError("queue accepts only the --save-sample option.");
    }

    return { step, saveSample };
  }

  if (step === "devices") {
    if (
      positionals.length > 0 ||
      query !== undefined ||
      note !== undefined ||
      saveSample ||
      confirmed
    ) {
      throw new ProbeArgumentError("devices does not accept options.");
    }

    return { step };
  }

  if (step === "burst") {
    if (positionals.length > 0 || query !== undefined || note !== undefined || saveSample) {
      throw new ProbeArgumentError("burst accepts only the --yes option.");
    }

    return { step, confirmed };
  }

  if (saveSample || confirmed) {
    throw new ProbeArgumentError("add accepts a track URI or --query, plus optional --note.");
  }

  if (query !== undefined && positionals.length === 0) {
    if (!query.trim()) {
      throw new ProbeArgumentError("--query needs non-empty text.");
    }

    return {
      step,
      source: { kind: "query", query },
      ...(note === undefined ? {} : { note }),
    };
  }

  if (query === undefined && positionals.length === 1) {
    return {
      step,
      source: { kind: "uri", trackUri: positionals[0] },
      ...(note === undefined ? {} : { note }),
    };
  }

  throw new ProbeArgumentError(
    'add needs one track URI or --query "<text>".',
  );
}

function isHttpSuccess(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

async function runQueue(
  command: Extract<ProbeCommand, { step: "queue" }>,
  runtime: ProbeRuntime,
): Promise<number> {
  const recordedAt = runtime.dateNow();
  const response = await captureResponse(
    "me/player/queue",
    { method: "GET" },
    runtime,
  );
  const summary = summarizeQueue(response.body);
  const outputPath = await saveResult(
    "queue",
    recordedAt,
    {
      step: "queue",
      recordedAt: recordedAt.toISOString(),
      response,
      summary,
      sampleRequested: command.saveSample,
    },
    runtime,
  );

  writeSafeLine(
    runtime.stdout,
    `Queue summary: ${JSON.stringify(redact(summary, runtime.secrets))}`,
    runtime.secrets,
  );
  writeSafeLine(
    runtime.stdout,
    `Saved result: spike-output/${basename(outputPath)}`,
    runtime.secrets,
  );

  if (response.error) {
    writeSafeLine(runtime.stderr, response.error, runtime.secrets);
  }

  if (command.saveSample) {
    if (response.status !== 200 || !isRecord(response.body)) {
      throw new ProbeSampleError(
        "Queue sample not written. Expected an HTTP 200 JSON object.",
      );
    }

    await writeQueueSample(response.body, {
      ensureDirectory: runtime.ensureDirectory,
      samplePath: runtime.samplePath,
      writeTextFile: runtime.writeTextFile,
    });
    writeSafeLine(
      runtime.stdout,
      "Saved sample: docs/samples/queue-response.json",
      runtime.secrets,
    );
  }

  return response.status === null ? 1 : 0;
}

async function runDevices(runtime: ProbeRuntime): Promise<number> {
  const recordedAt = runtime.dateNow();
  const response = await captureResponse(
    "me/player/devices",
    { method: "GET" },
    runtime,
  );
  const summary = summarizeDevices(response.body);
  const outputPath = await saveResult(
    "devices",
    recordedAt,
    {
      step: "devices",
      recordedAt: recordedAt.toISOString(),
      response,
      summary,
    },
    runtime,
  );

  writeSafeLine(
    runtime.stdout,
    `Devices summary: ${JSON.stringify(redact(summary, runtime.secrets))}`,
    runtime.secrets,
  );
  writeSafeLine(
    runtime.stdout,
    `Saved result: spike-output/${basename(outputPath)}`,
    runtime.secrets,
  );

  if (response.error) {
    writeSafeLine(runtime.stderr, response.error, runtime.secrets);
  }

  return response.status === null ? 1 : 0;
}

function getQueueContainsTrack(body: unknown, trackUri: string): boolean {
  return getQueueItems(body).some(
    (item) => stringField(item, "uri") === trackUri,
  );
}

async function runAdd(
  command: Extract<ProbeCommand, { step: "add" }>,
  runtime: ProbeRuntime,
): Promise<number> {
  const recordedAt = runtime.dateNow();
  let trackUri: string | undefined;
  let trackName: string | null = null;
  let searchResponse: CapturedResponse | null = null;

  if (command.source.kind === "uri") {
    trackUri = command.source.trackUri;
  } else {
    searchResponse = await captureResponse(
      "search",
      {
        method: "GET",
        query: {
          type: "track",
          market: "BR",
          limit: SEARCH_LIMIT,
          q: command.source.query,
        },
      },
      runtime,
    );

    if (!isHttpSuccess(searchResponse.status)) {
      const outputPath = await saveResult(
        "add",
        recordedAt,
        {
          step: "add",
          recordedAt: recordedAt.toISOString(),
          note: command.note ?? null,
          searchResponse,
          addResponse: null,
          queueChecks: [],
        },
        runtime,
      );

      writeSafeLine(
        runtime.stdout,
        `Add search: HTTP ${searchResponse.status ?? "unavailable"}. No queue request was made.`,
        runtime.secrets,
      );
      writeSafeLine(
        runtime.stdout,
        `Saved result: spike-output/${basename(outputPath)}`,
        runtime.secrets,
      );

      if (searchResponse.error) {
        writeSafeLine(runtime.stderr, searchResponse.error, runtime.secrets);
      }

      return searchResponse.status === null ? 1 : 0;
    }

    const firstTrack = getFirstTrack(searchResponse.body);

    if (!firstTrack) {
      const outputPath = await saveResult(
        "add",
        recordedAt,
        {
          step: "add",
          recordedAt: recordedAt.toISOString(),
          note: command.note ?? null,
          searchResponse,
          addResponse: null,
          queueChecks: [],
        },
        runtime,
      );

      writeSafeLine(
        runtime.stdout,
        "Add search: no track found. No queue request was made.",
        runtime.secrets,
      );
      writeSafeLine(
        runtime.stdout,
        `Saved result: spike-output/${basename(outputPath)}`,
        runtime.secrets,
      );

      return 0;
    }

    trackUri = firstTrack.uri;
    trackName = firstTrack.name;
  }

  if (!trackUri) {
    throw new ProbeArgumentError("No track URI was resolved.");
  }

  const addResponse = await captureResponse(
    "me/player/queue",
    {
      method: "POST",
      query: { uri: trackUri },
    },
    runtime,
  );
  const addCompletedAt = runtime.monotonicNow();
  const queueChecks: Array<{
    requestedAfterMs: number;
    actualAfterMs: number;
    response: CapturedResponse;
    appearsInQueue: boolean | null;
  }> = [];

  for (const requestedAfterMs of QUEUE_CHECK_TIMES_MS) {
    const delayMs = Math.max(
      0,
      requestedAfterMs - (runtime.monotonicNow() - addCompletedAt),
    );

    await runtime.sleep(delayMs);

    const actualAfterMs = Math.max(
      0,
      Math.round(runtime.monotonicNow() - addCompletedAt),
    );
    const response = await captureResponse(
      "me/player/queue",
      { method: "GET" },
      runtime,
    );

    queueChecks.push({
      requestedAfterMs,
      actualAfterMs,
      response,
      appearsInQueue: isHttpSuccess(response.status)
        ? getQueueContainsTrack(response.body, trackUri)
        : null,
    });
  }

  const outputPath = await saveResult(
    "add",
    recordedAt,
    {
      step: "add",
      recordedAt: recordedAt.toISOString(),
      note: command.note ?? null,
      track: { uri: trackUri, name: trackName },
      searchResponse,
      addResponse,
      queueChecks,
    },
    runtime,
  );
  const summary = {
    track: { uri: trackUri, name: trackName },
    addStatus: addResponse.status,
    queueChecks: queueChecks.map((check) => ({
      afterMs: check.actualAfterMs,
      appearsInQueue: check.appearsInQueue,
      status: check.response.status,
    })),
  };

  writeSafeLine(
    runtime.stdout,
    `Add summary: ${JSON.stringify(redact(summary, runtime.secrets))}`,
    runtime.secrets,
  );
  writeSafeLine(
    runtime.stdout,
    `Saved result: spike-output/${basename(outputPath)}`,
    runtime.secrets,
  );

  for (const response of [
    ...(searchResponse ? [searchResponse] : []),
    addResponse,
    ...queueChecks.map((check) => check.response),
  ]) {
    if (response.error) {
      writeSafeLine(runtime.stderr, response.error, runtime.secrets);
    }
  }

  return [
    ...(searchResponse ? [searchResponse] : []),
    addResponse,
    ...queueChecks.map((check) => check.response),
  ].some((response) => response.status === null)
    ? 1
    : 0;
}

function formatElapsedSeconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(2);
}

async function runBurst(runtime: ProbeRuntime): Promise<number> {
  const recordedAt = runtime.dateNow();
  const startedAt = runtime.monotonicNow();
  const calls: Array<{
    status: number | null;
    headers: Record<string, string>;
    elapsedMs: number;
    error?: string;
  }> = [];
  let rateLimitResponse:
    | { status: 429; headers: Record<string, string>; body: unknown }
    | null = null;
  let requestFailed = false;

  while (
    calls.length < BURST_MAX_CALLS &&
    runtime.monotonicNow() - startedAt < BURST_MAX_DURATION_MS
  ) {
    const remainingMs =
      BURST_MAX_DURATION_MS - (runtime.monotonicNow() - startedAt);
    const deadlineSignal = AbortSignal.timeout(
      Math.max(0, Math.floor(remainingMs)),
    );
    const response = await captureResponse(
      "me/player/queue",
      {
        method: "GET",
        signal: deadlineSignal,
      },
      runtime,
    );
    const call = {
      status: response.status,
      headers: response.headers,
      elapsedMs: Math.max(
        0,
        Math.round(runtime.monotonicNow() - startedAt),
      ),
      ...(response.error ? { error: response.error } : {}),
    };

    calls.push(call);

    if (response.status === 429) {
      rateLimitResponse = {
        status: 429,
        headers: response.headers,
        body: response.body,
      };
      break;
    }

    if (response.status === null) {
      const timeBudgetSpent =
        deadlineSignal.aborted ||
        runtime.monotonicNow() - startedAt >= BURST_MAX_DURATION_MS;

      requestFailed = !timeBudgetSpent;
      break;
    }
  }

  const elapsedMs = Math.max(
    0,
    Math.round(runtime.monotonicNow() - startedAt),
  );
  const summary = rateLimitResponse
    ? `stopped at 429 after ${calls.length} calls over ${formatElapsedSeconds(elapsedMs)} s`
    : `no 429 in ${calls.length} calls over ${formatElapsedSeconds(elapsedMs)} s`;
  const outputPath = await saveResult(
    "burst",
    recordedAt,
    {
      step: "burst",
      recordedAt: recordedAt.toISOString(),
      callsMade: calls.length,
      elapsedMs,
      summary,
      calls,
      rateLimitResponse,
      stopReason: rateLimitResponse
        ? "rate-limit"
        : requestFailed
          ? "request-error"
          : calls.length >= BURST_MAX_CALLS
            ? "call-cap"
            : "time-cap",
    },
    runtime,
  );

  writeSafeLine(runtime.stdout, summary, runtime.secrets);
  writeSafeLine(
    runtime.stdout,
    `Saved result: spike-output/${basename(outputPath)}`,
    runtime.secrets,
  );

  if (requestFailed) {
    const lastCall = calls[calls.length - 1];

    if (lastCall?.error) {
      writeSafeLine(runtime.stderr, lastCall.error, runtime.secrets);
    }

    return 1;
  }

  return 0;
}

function isMaskedValue(value: unknown): boolean {
  if (value === null) {
    return true;
  }

  if (typeof value === "string") {
    return value === REDACTED_VALUE || value === "spotify:user:[redacted]";
  }

  if (typeof value === "number") {
    return value === 0;
  }

  if (typeof value === "boolean") {
    return value === false;
  }

  if (Array.isArray(value)) {
    return value.every(isMaskedValue);
  }

  return (
    isRecord(value) &&
    Object.values(value).every(isMaskedValue)
  );
}

function containsUnsafeSampleValue(
  value: unknown,
  key = "",
  context: RedactionContext = { owner: false, user: false, device: false },
): boolean {
  if (
    shouldRedactField(key, value, context) &&
    !isMaskedValue(value)
  ) {
    return true;
  }

  if (
    typeof value === "string" &&
    (USER_URI_PATTERN.test(value) || USER_URL_PATTERN.test(value))
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((child) => containsUnsafeSampleValue(child, key, context));
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(([childKey, childValue]) => {
    const childKeyNormalized = childKey.toLowerCase();
    const childContext: RedactionContext = {
      owner: context.owner || childKeyNormalized === "owner",
      user: context.user || childKeyNormalized === "user",
      device:
        context.device ||
        childKeyNormalized === "device" ||
        DEVICE_COLLECTION_NAMES.has(childKeyNormalized),
    };

    return containsUnsafeSampleValue(
      childValue,
      childKey,
      childContext,
    );
  });
}

export async function writeQueueSample(
  redactedBody: unknown,
  overrides: Pick<
    ProbeOverrides,
    "ensureDirectory" | "samplePath" | "writeTextFile"
  > = {},
): Promise<void> {
  if (containsUnsafeSampleValue(redactedBody)) {
    throw new ProbeSampleError(
      "Refusing to write queue sample because sensitive values remain unredacted.",
    );
  }

  const runtime = resolveRuntime(overrides);

  await runtime.ensureDirectory(dirname(runtime.samplePath));
  await runtime.writeTextFile(
    runtime.samplePath,
    `${JSON.stringify(redactedBody, null, 2)}\n`,
  );
}

function parseUsage(args: string[]): ProbeCommand {
  return parseProbeCommand(args);
}

function safeCliError(error: unknown): string {
  if (
    error instanceof ProbeArgumentError ||
    error instanceof ProbeSampleError
  ) {
    return error.message;
  }

  if (error instanceof SpotifyConfigError) {
    return `Missing required environment variable: ${error.variable}.`;
  }

  return "Spotify probe failed. Error details were not printed.";
}

export async function runCli(
  args = process.argv.slice(2),
  overrides: ProbeOverrides = {},
): Promise<number> {
  const runtime = resolveRuntime(overrides);

  if (
    args.length === 0 ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    writeSafeLine(runtime.stdout, USAGE, runtime.secrets);
    return 0;
  }

  let command: ProbeCommand;

  try {
    command = parseUsage(args);
  } catch (error) {
    writeSafeLine(runtime.stderr, safeCliError(error), runtime.secrets);
    return 2;
  }

  if (command.step === "burst") {
    writeSafeLine(runtime.stdout, BURST_WARNING, runtime.secrets);

    if (!command.confirmed) {
      writeSafeLine(
        runtime.stderr,
        "burst requires --yes. No Spotify request was sent.",
        runtime.secrets,
      );
      return 2;
    }
  }

  try {
    if (command.step === "queue") {
      return await runQueue(command, runtime);
    }

    if (command.step === "devices") {
      return await runDevices(runtime);
    }

    if (command.step === "add") {
      return await runAdd(command, runtime);
    }

    return await runBurst(runtime);
  } catch (error) {
    writeSafeLine(runtime.stderr, safeCliError(error), runtime.secrets);
    return 1;
  }
}

function isEntrypoint(): boolean {
  const entryPath = process.argv[1];

  return (
    entryPath !== undefined &&
    import.meta.url === pathToFileURL(resolve(entryPath)).href
  );
}

if (isEntrypoint()) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

import type { QueueResponse } from "../spotify-responses";
import { ClientApiError, fetchQueue } from "./api";
import { isOfflineError } from "./errors";

export const QUEUE_POLL_INTERVAL_MS = 5_000;
export const QUEUE_BACKOFF_FLOOR_MS = 5_000;
export const QUEUE_BACKOFF_CAP_MS = 60_000;
export const QUEUE_BACKOFF_START_MS = 10_000;

export type QueueNotice = "error" | "offline" | "rate-limited";

export interface QueueState {
  data: QueueResponse | null;
  isLoading: boolean;
  notice: QueueNotice | null;
}

interface QueueMachineOptions {
  fetchQueue?: (signal: AbortSignal) => Promise<QueueResponse>;
  isOnline?: () => boolean;
}

interface QueueMachine {
  getSnapshot: () => QueueState;
  refresh: () => Promise<void>;
  setHidden: (hidden: boolean) => void;
  start: () => void;
  stop: () => void;
  subscribe: (listener: () => void) => () => void;
}

interface RetryDelay {
  backoffMs: number;
  delayMs: number;
}

const INITIAL_STATE: QueueState = {
  data: null,
  isLoading: true,
  notice: null,
};

export function getRetryDelay(
  retryAfterSeconds: number | undefined,
  previousBackoffMs: number,
): RetryDelay {
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
    const delayMs = Math.min(
      Math.max(
        retryAfterSeconds * 1_000,
        QUEUE_BACKOFF_FLOOR_MS,
      ),
      QUEUE_BACKOFF_CAP_MS,
    );

    return { backoffMs: delayMs, delayMs };
  }

  const delayMs = Math.min(
    Math.max(previousBackoffMs * 2, QUEUE_BACKOFF_START_MS),
    QUEUE_BACKOFF_CAP_MS,
  );

  return { backoffMs: delayMs, delayMs };
}

function browserIsOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function isRateLimited(error: unknown): error is ClientApiError {
  return (
    error instanceof ClientApiError &&
    (error.status === 429 || error.code === "RATE_LIMITED")
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createQueueMachine(
  options: QueueMachineOptions = {},
): QueueMachine {
  const requestQueue =
    options.fetchQueue ?? ((signal: AbortSignal) => fetchQueue(signal));
  const listeners = new Set<() => void>();
  let state = INITIAL_STATE;
  let running = false;
  let hidden = false;
  let refreshWhenVisible = false;
  let refreshQueued = false;
  let backoffMs = QUEUE_POLL_INTERVAL_MS;
  let notBefore: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let activeController: AbortController | null = null;

  function publish(nextState: QueueState): void {
    state = nextState;

    for (const listener of listeners) {
      listener();
    }
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): QueueState {
    return state;
  }

  function scheduleNext(delayMs: number): void {
    if (!running || hidden) {
      return;
    }

    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void pollNow();
    }, delayMs);
  }

  function deferUntilRateLimitExpires(): boolean {
    if (notBefore === null) {
      return false;
    }

    const remainingMs = notBefore - Date.now();

    if (remainingMs <= 0) {
      notBefore = null;
      return false;
    }

    if (timer === null) {
      scheduleNext(remainingMs);
    }

    return true;
  }

  async function pollNow(): Promise<void> {
    if (!running || hidden) {
      return;
    }

    if (deferUntilRateLimitExpires()) {
      return;
    }

    if (inFlight) {
      refreshQueued = true;
      return inFlight;
    }

    clearTimer();
    publish({
      ...state,
      isLoading: state.data === null,
    });

    const requestController = new AbortController();
    activeController = requestController;
    let requestWasAborted = false;
    const request = (async () => {
      let nextDelayMs = QUEUE_POLL_INTERVAL_MS;
      let succeeded = false;

      try {
        const data = await requestQueue(requestController.signal);

        if (
          requestController.signal.aborted ||
          activeController !== requestController
        ) {
          return;
        }

        succeeded = true;
        backoffMs = QUEUE_POLL_INTERVAL_MS;
        notBefore = null;
        publish({ data, isLoading: false, notice: null });
      } catch (error) {
        if (
          requestController.signal.aborted ||
          activeController !== requestController ||
          isAbortError(error)
        ) {
          requestWasAborted = true;
          return;
        }

        const rateLimited = isRateLimited(error);

        if (rateLimited) {
          const retry = getRetryDelay(error.retryAfterSeconds, backoffMs);
          backoffMs = retry.backoffMs;
          nextDelayMs = retry.delayMs;
          notBefore = Date.now() + retry.delayMs;
        } else {
          const retry = getRetryDelay(undefined, backoffMs);
          backoffMs = retry.backoffMs;
          nextDelayMs = retry.delayMs;
          notBefore = null;
        }

        const notice: QueueNotice = rateLimited
          ? "rate-limited"
          : isOfflineError(error, options.isOnline?.() ?? browserIsOnline())
            ? "offline"
            : "error";

        publish({ ...state, isLoading: false, notice });
      } finally {
        if (activeController !== requestController) {
          return;
        }

        activeController = null;
        inFlight = null;

        if (requestWasAborted || !running || hidden) {
          return;
        }

        if (refreshQueued) {
          refreshQueued = false;
          if (succeeded) {
            void pollNow();
          } else {
            scheduleNext(nextDelayMs);
          }

          return;
        }

        scheduleNext(nextDelayMs);
      }
    })();

    inFlight = request;

    return request;
  }

  function refresh(): Promise<void> {
    if (!running) {
      return Promise.resolve();
    }

    if (hidden) {
      refreshWhenVisible = true;
      return Promise.resolve();
    }

    if (deferUntilRateLimitExpires()) {
      return Promise.resolve();
    }

    clearTimer();

    if (inFlight) {
      refreshQueued = true;
      return inFlight;
    }

    return pollNow();
  }

  function setHidden(nextHidden: boolean): void {
    if (hidden === nextHidden) {
      return;
    }

    hidden = nextHidden;

    if (hidden) {
      clearTimer();
      return;
    }

    if (refreshWhenVisible || running) {
      refreshWhenVisible = false;
      refreshQueued = false;
      void refresh();
    }
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;

    if (!hidden && inFlight === null) {
      void pollNow();
    }
  }

  function stop(): void {
    running = false;
    clearTimer();
    refreshQueued = false;
    refreshWhenVisible = false;

    const controller = activeController;
    activeController = null;
    inFlight = null;
    controller?.abort();
  }

  return {
    getSnapshot,
    refresh,
    setHidden,
    start,
    stop,
    subscribe,
  };
}

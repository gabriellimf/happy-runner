import { afterEach, describe, expect, it, vi } from "vitest";

import { createAddMachine } from "../lib/client/add-machine";
import { ClientApiError } from "../lib/client/api";
import {
  createQueueMachine,
  getRetryDelay,
  QUEUE_BACKOFF_CAP_MS,
  QUEUE_BACKOFF_FLOOR_MS,
  QUEUE_POLL_INTERVAL_MS,
} from "../lib/client/queue-machine";
import type { SearchState } from "../lib/client/search-machine";
import type { QueueResponse, Track } from "../lib/spotify-responses";

type MockFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { headers, status });
}

function queueResponse(): QueueResponse {
  return { nowPlaying: null, next: [] };
}

function track(): Track {
  return {
    artists: ["Artista"],
    coverUrl: null,
    durationMs: 180_000,
    id: "track-id",
    title: "Música",
    uri: "spotify:track:1234567890123456789012",
  };
}

function errorResponse(
  code: string,
  status: number,
  headers?: HeadersInit,
): Response {
  return jsonResponse(
    { error: { code, message: "mensagem não usada" } },
    status,
    headers,
  );
}

function stubFetch(implementation: MockFetch) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

async function flushPromises(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("queue machine polling", () => {
  it("polls immediately and every five seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(queueResponse())),
    );
    const machine = createQueueMachine();

    machine.start();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(QUEUE_POLL_INTERVAL_MS - 1);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    machine.stop();
  });

  it("pauses while hidden and refreshes immediately when visible", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(queueResponse())),
    );
    const machine = createQueueMachine();

    machine.start();
    await flushPromises();
    machine.setHidden(true);
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_INTERVAL_MS * 3);
    expect(fetchMock).toHaveBeenCalledOnce();

    machine.setHidden(false);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    machine.stop();
  });

  it("refreshes immediately when connectivity returns", async () => {
    let online = false;
    let requestCount = 0;
    const fetchMock = stubFetch(() => {
      requestCount += 1;

      return requestCount === 1
        ? Promise.reject(new TypeError("Network unavailable"))
        : Promise.resolve(jsonResponse(queueResponse()));
    });
    const machine = createQueueMachine({ isOnline: () => online });

    machine.start();
    await flushPromises();
    expect(machine.getSnapshot().notice).toBe("offline");

    online = true;
    void machine.refresh();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(machine.getSnapshot().notice).toBeNull();
    machine.stop();
  });

  it("keeps visible, online, and post-add refreshes behind a 429 deadline", async () => {
    vi.useFakeTimers();
    let requestCount = 0;
    const fetchMock = stubFetch(() => {
      requestCount += 1;

      return Promise.resolve(
        requestCount === 1
          ? errorResponse("RATE_LIMITED", 429, { "Retry-After": "20" })
          : jsonResponse(queueResponse()),
      );
    });
    const machine = createQueueMachine();

    machine.start();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    machine.setHidden(true);
    machine.setHidden(false);
    void machine.refresh();
    void machine.refresh();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    machine.stop();
  });

  it("refreshes immediately after a non-429 server error", async () => {
    vi.useFakeTimers();
    let requestCount = 0;
    const fetchMock = stubFetch(() => {
      requestCount += 1;

      return Promise.resolve(
        requestCount === 1
          ? errorResponse("INTERNAL_ERROR", 500)
          : jsonResponse(queueResponse()),
      );
    });
    const machine = createQueueMachine();

    machine.start();
    await flushPromises();
    expect(machine.getSnapshot().notice).toBe("error");

    void machine.refresh();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(machine.getSnapshot().notice).toBeNull();
    machine.stop();
  });

  it("honors Retry-After and clamps the delay to five through sixty seconds", async () => {
    vi.useFakeTimers();
    let requestCount = 0;
    const fetchMock = stubFetch(() => {
      requestCount += 1;

      return Promise.resolve(
        requestCount === 1
          ? errorResponse("RATE_LIMITED", 429, { "Retry-After": "20" })
          : jsonResponse(queueResponse()),
      );
    });
    const machine = createQueueMachine();

    machine.start();
    await flushPromises();
    expect(machine.getSnapshot().notice).toBe("rate-limited");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(getRetryDelay(1, QUEUE_POLL_INTERVAL_MS).delayMs).toBe(
      QUEUE_BACKOFF_FLOOR_MS,
    );
    expect(getRetryDelay(120, QUEUE_POLL_INTERVAL_MS).delayMs).toBe(
      QUEUE_BACKOFF_CAP_MS,
    );
    machine.stop();
  });

  it("doubles the delay after repeated 429 responses without Retry-After", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(() =>
      Promise.resolve(errorResponse("RATE_LIMITED", 429)),
    );
    const machine = createQueueMachine();

    machine.start();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    machine.stop();
  });

  it("backs off after a non-429 queue failure", async () => {
    vi.useFakeTimers();
    let requestCount = 0;
    const fetchMock = stubFetch(() => {
      requestCount += 1;

      return Promise.resolve(
        requestCount === 1
          ? errorResponse("INTERNAL_ERROR", 500)
          : jsonResponse(queueResponse()),
      );
    });
    const machine = createQueueMachine();

    machine.start();
    await flushPromises();
    expect(machine.getSnapshot().notice).toBe("error");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    machine.stop();
  });

  it("resets the fallback backoff to five seconds after one success", async () => {
    vi.useFakeTimers();
    let requestCount = 0;
    const fetchMock = stubFetch(() => {
      requestCount += 1;

      return Promise.resolve(
        requestCount === 2
          ? jsonResponse(queueResponse())
          : errorResponse("RATE_LIMITED", 429),
      );
    });
    const machine = createQueueMachine();

    machine.start();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(QUEUE_POLL_INTERVAL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    machine.stop();
  });

  it("queues the post-add refresh behind an in-flight poll", async () => {
    vi.useFakeTimers();
    let resolveFirstQueue: ((response: Response) => void) | undefined;
    let resolveSecondQueue: ((response: Response) => void) | undefined;
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    let queueRequestCount = 0;
    const fetchMock = stubFetch((input, init) => {
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }

      queueRequestCount += 1;
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      const promise =
        queueRequestCount === 1
          ? new Promise<Response>((resolve) => {
              resolveFirstQueue = resolve;
            })
          : new Promise<Response>((resolve) => {
              resolveSecondQueue = resolve;
            });

      return promise.finally(() => {
        activeRequests -= 1;
      });
    });
    const queue = createQueueMachine();
    queue.start();

    let currentText = "abba";
    const searchState: SearchState = {
      errorMessage: null,
      items: [],
      phase: "idle",
      query: "",
      resultQuery: null,
      text: currentText,
    };
    const add = createAddMachine({
      addRequest: async (uri) => {
        const response = await fetchMock("/api/queue", {
          body: JSON.stringify({ uri }),
          method: "POST",
        });

        if (!response.ok) {
          throw new ClientApiError(response.status, null, undefined);
        }
      },
      getSearchSnapshot: () => searchState,
      getText: () => currentText,
      refreshQueue: () => {
        void queue.refresh();
      },
      searchNow: async () => ({ kind: "invalid" }),
      setText: (text) => {
        currentText = text;
      },
    });

    await add.add(track());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(queueRequestCount).toBe(1);

    resolveFirstQueue?.(jsonResponse(queueResponse()));
    await flushPromises();

    expect(queueRequestCount).toBe(2);
    expect(maximumActiveRequests).toBe(1);

    resolveSecondQueue?.(jsonResponse(queueResponse()));
    await flushPromises();
    queue.stop();
  });

  it("does not run a queued refresh before Retry-After expires", async () => {
    vi.useFakeTimers();
    let resolveFirstQueue: ((response: Response) => void) | undefined;
    let queueRequestCount = 0;
    const fetchMock = stubFetch((input, init) => {
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }

      queueRequestCount += 1;

      if (queueRequestCount === 1) {
        return new Promise((resolve) => {
          resolveFirstQueue = resolve;
        });
      }

      return Promise.resolve(jsonResponse(queueResponse()));
    });
    const machine = createQueueMachine();

    machine.start();
    void machine.refresh();
    resolveFirstQueue?.(
      errorResponse("RATE_LIMITED", 429, { "Retry-After": "20" }),
    );
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    machine.stop();
  });

  it("reports an offline queue failure", async () => {
    const fetchMock = stubFetch(() =>
      Promise.reject(new TypeError("Network unavailable")),
    );
    const machine = createQueueMachine({ isOnline: () => false });

    machine.start();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(machine.getSnapshot().notice).toBe("offline");
    machine.stop();
  });

  it("aborts an in-flight queue request on stop without publishing an error", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch((_input, init) => {
      const signal = init?.signal;

      if (!signal) {
        throw new Error("Queue fetch did not receive an abort signal");
      }

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const machine = createQueueMachine();

    machine.start();
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);

    machine.stop();
    await flushPromises();

    expect(signal?.aborted).toBe(true);
    expect(machine.getSnapshot().notice).toBeNull();
    await vi.advanceTimersByTimeAsync(QUEUE_BACKOFF_CAP_MS);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("starts a fresh queue request after stop aborts the previous run", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchMock = stubFetch((_input, init) => {
      const signal = init?.signal;

      if (!signal) {
        throw new Error("Queue fetch did not receive an abort signal");
      }

      signals.push(signal);

      if (signals.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }

      return Promise.resolve(jsonResponse(queueResponse()));
    });
    const machine = createQueueMachine();

    machine.start();
    machine.stop();
    machine.start();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(machine.getSnapshot()).toMatchObject({
      data: queueResponse(),
      notice: null,
    });
    machine.stop();
  });
});

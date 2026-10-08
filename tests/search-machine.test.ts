import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSearchMachine,
  MIN_SEARCH_QUERY_LENGTH,
  SEARCH_DEBOUNCE_MS,
} from "../lib/client/search-machine";
import type { Track } from "../lib/spotify-responses";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function track(id: string): Track {
  return {
    artists: ["Artista"],
    coverUrl: null,
    durationMs: 180_000,
    id,
    title: `Faixa ${id}`,
    uri: `spotify:track:${id.padEnd(22, "0")}`,
  };
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

describe("search machine", () => {
  it("does not search until the trimmed query has four characters", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ items: [track("result")] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const machine = createSearchMachine();

    machine.setText(" abc ");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);
    machine.setText("🎵🎵");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);

    expect(MIN_SEARCH_QUERY_LENGTH).toBe(4);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(machine.getSnapshot().phase).toBe("idle");
  });

  it("waits 300 ms before searching and trims the query", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ items: [track("result")] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const machine = createSearchMachine();

    machine.setText(" abba ");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/search?q=abba");
    expect(machine.getSnapshot()).toMatchObject({
      phase: "results",
      query: "abba",
      resultQuery: "abba",
    });
  });

  it("aborts a stale request and does not publish its late result", async () => {
    vi.useFakeTimers();
    let resolveOldRequest: ((response: Response) => void) | undefined;
    let oldSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).includes("abba")) {
          oldSignal = init?.signal;

          return new Promise((resolve) => {
            resolveOldRequest = resolve;
          });
        }

        return Promise.resolve(
          jsonResponse({ items: [track("new-result")] }),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const machine = createSearchMachine();

    machine.setText("abba");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledOnce();

    machine.setText("queen");
    expect(oldSignal?.aborted).toBe(true);
    resolveOldRequest?.(jsonResponse({ items: [track("stale-result")] }));
    await flushPromises();
    expect(machine.getSnapshot().items).toEqual([]);
    expect(machine.getSnapshot().phase).toBe("debouncing");

    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();

    expect(machine.getSnapshot().items.map(({ id }) => id)).toEqual([
      "new-result",
    ]);
    expect(machine.getSnapshot().resultQuery).toBe("queen");
  });
});

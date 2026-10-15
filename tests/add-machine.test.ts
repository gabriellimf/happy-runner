import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADD_SUCCESS_DURATION_MS,
  ADD_SUCCESS_FADE_MS,
  createAddMachine,
} from "../lib/client/add-machine";
import { createSearchMachine } from "../lib/client/search-machine";
import { CLIENT_MESSAGES } from "../lib/client/errors";
import type { Track } from "../lib/spotify-responses";

type MockFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
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

function createHarness(fetchImplementation: MockFetch) {
  const fetchMock = vi.fn(fetchImplementation);
  vi.stubGlobal("fetch", fetchMock);
  const search = createSearchMachine();
  const refreshQueue = vi.fn();
  const add = createAddMachine({
    getSearchSnapshot: search.getSnapshot,
    getText: search.getText,
    refreshQueue,
    searchNow: search.searchNow,
    setText: search.setText,
  });

  return { add, fetchMock, refreshQueue, search };
}

async function flushPromises(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

async function loadSearch(
  search: ReturnType<typeof createSearchMachine>,
  text = "abba",
): Promise<void> {
  search.setText(text);
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
}

function searchAndAddResponse(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (String(input).startsWith("/api/search")) {
    return Promise.resolve(jsonResponse({ items: [track("first")] }));
  }

  if (init?.method === "POST") {
    return Promise.resolve(jsonResponse({ ok: true }));
  }

  return Promise.resolve(jsonResponse({ nowPlaying: null, next: [] }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("add machine duplicate handling", () => {
  function respondWith(body: Record<string, unknown>): MockFetch {
    return (input, init) =>
      String(input).startsWith("/api/search")
        ? Promise.resolve(jsonResponse(body))
        : searchAndAddResponse(input, init);
  }

  function posts(harness: ReturnType<typeof createHarness>) {
    return harness.fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
  }

  it("shows a hint and adds nothing on Enter when the first result is another version of a queued song", async () => {
    vi.useFakeTimers();
    const harness = createHarness(
      respondWith({
        inQueue: { first: "version" },
        items: [track("first")],
      }),
    );
    await loadSearch(harness.search);

    await harness.add.submit("abba");

    expect(posts(harness)).toHaveLength(0);
    expect(harness.add.getSnapshot()).toMatchObject({
      isAdding: false,
      notice: { kind: "hint", text: CLIENT_MESSAGES.versionInQueue },
    });
    expect(harness.search.getText()).toBe("abba");
    expect(harness.refreshQueue).not.toHaveBeenCalled();
  });

  it("applies the same rule to the fresh search that Enter runs", async () => {
    vi.useFakeTimers();
    const harness = createHarness(
      respondWith({
        inQueue: { first: "version" },
        items: [track("first")],
      }),
    );
    harness.search.setText("abba");

    await harness.add.submit("abba");

    expect(posts(harness)).toHaveLength(0);
    expect(harness.add.getSnapshot().notice).toMatchObject({
      kind: "hint",
      text: CLIENT_MESSAGES.versionInQueue,
    });
  });

  it("checks the version flag of the autoAddId track, not of the first result", async () => {
    vi.useFakeTimers();
    const harness = createHarness(
      respondWith({
        autoAddId: "second",
        inQueue: { first: "version" },
        items: [track("first"), track("second")],
      }),
    );
    await loadSearch(harness.search);

    await harness.add.submit("abba");

    expect(posts(harness)).toHaveLength(1);
    expect(posts(harness)[0][1]?.body).toBe(
      JSON.stringify({ uri: track("second").uri }),
    );
  });

  it("still adds a version when the guest taps it", async () => {
    vi.useFakeTimers();
    const harness = createHarness(
      respondWith({
        inQueue: { first: "version" },
        items: [track("first")],
      }),
    );
    await loadSearch(harness.search);

    await harness.add.add(track("first"));

    expect(posts(harness)).toHaveLength(1);
    expect(harness.add.getSnapshot().notice?.text).toBe(
      "Adicionada à fila: Faixa first",
    );
  });

  it("sends an exact match to the server and shows its already-in-queue message", async () => {
    vi.useFakeTimers();
    const harness = createHarness((input, init) => {
      if (init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "ALREADY_IN_QUEUE",
                message: "Essa música já está na fila",
              },
            },
            409,
          ),
        );
      }

      return respondWith({
        inQueue: { first: "exact" },
        items: [track("first")],
      })(input, init);
    });
    await loadSearch(harness.search);

    await harness.add.submit("abba");

    expect(posts(harness)).toHaveLength(1);
    expect(harness.add.getSnapshot().notice).toMatchObject({
      kind: "error",
      text: CLIENT_MESSAGES.alreadyInQueue,
    });
    expect(harness.search.getText()).toBe("abba");
    expect(harness.refreshQueue).not.toHaveBeenCalled();
  });
});

describe("add machine Enter fast path", () => {
  it("adds the track chosen by autoAddId instead of the first result", async () => {
    vi.useFakeTimers();
    const harness = createHarness((input, init) =>
      String(input).startsWith("/api/search")
        ? Promise.resolve(
            jsonResponse({
              autoAddId: "second",
              items: [track("first"), track("second")],
            }),
          )
        : searchAndAddResponse(input, init),
    );
    await loadSearch(harness.search);

    await harness.add.submit("abba");

    const post = harness.fetchMock.mock.calls[1];

    expect(post[0]).toBe("/api/queue");
    expect(post[1]?.body).toBe(
      JSON.stringify({ uri: track("second").uri }),
    );
    expect(harness.add.getSnapshot().notice?.text).toBe(
      "Adicionada à fila: Faixa second",
    );
  });

  it.each([
    ["autoAddId is null", null],
    ["autoAddId is not in the results", "missing"],
  ])("shows a hint and adds nothing when %s", async (_label, autoAddId) => {
    vi.useFakeTimers();
    const harness = createHarness((input, init) =>
      String(input).startsWith("/api/search")
        ? Promise.resolve(
            jsonResponse({
              autoAddId,
              items: [track("first"), track("second")],
            }),
          )
        : searchAndAddResponse(input, init),
    );
    await loadSearch(harness.search);

    await harness.add.submit("abba");

    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.add.getSnapshot()).toMatchObject({
      isAdding: false,
      notice: { kind: "hint", text: CLIENT_MESSAGES.pickSuggestion },
    });
    expect(harness.search.getText()).toBe("abba");
    expect(harness.refreshQueue).not.toHaveBeenCalled();
  });

  it("shows a hint and adds nothing when the fresh search is not confident", async () => {
    vi.useFakeTimers();
    const harness = createHarness((input, init) =>
      String(input).startsWith("/api/search")
        ? Promise.resolve(
            jsonResponse({ autoAddId: null, items: [track("first")] }),
          )
        : searchAndAddResponse(input, init),
    );
    harness.search.setText("abba");

    await harness.add.submit("abba");

    expect(
      harness.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
    expect(harness.add.getSnapshot()).toMatchObject({
      isAdding: false,
      notice: { kind: "hint", text: CLIENT_MESSAGES.pickSuggestion },
    });
  });

  it("adds the first current result without running another search", async () => {
    vi.useFakeTimers();
    const harness = createHarness(searchAndAddResponse);
    await loadSearch(harness.search);

    await harness.add.submit("abba");

    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.fetchMock.mock.calls[1][0]).toBe("/api/queue");
    expect(harness.fetchMock.mock.calls[1][1]?.method).toBe("POST");
    expect(harness.search.getText()).toBe("");
    expect(harness.add.getSnapshot().notice?.text).toBe(
      "Adicionada à fila: Faixa first",
    );
    expect(harness.refreshQueue).toHaveBeenCalledOnce();
  });

  it("runs a fresh search immediately when debounce is pending", async () => {
    vi.useFakeTimers();
    const harness = createHarness(searchAndAddResponse);
    harness.search.setText("abba");

    await harness.add.submit("abba");
    await vi.advanceTimersByTimeAsync(300);

    expect(
      harness.fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/search"),
      ),
    ).toHaveLength(1);
    expect(
      harness.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("aborts an in-flight suggestion search and searches again on Enter", async () => {
    vi.useFakeTimers();
    let resolveOldSearch: ((response: Response) => void) | undefined;
    let resolvePost: ((response: Response) => void) | undefined;
    let firstSearchSignal: AbortSignal | null | undefined;
    let searchCount = 0;
    const harness = createHarness(
      (input, init) => {
        if (init?.method === "POST") {
          return new Promise((resolve) => {
            resolvePost = resolve;
          });
        }

        if (String(input).startsWith("/api/search")) {
          searchCount += 1;

          if (searchCount === 1) {
            firstSearchSignal = init?.signal;

            return new Promise((resolve) => {
              resolveOldSearch = resolve;
            });
          }
        }

        return searchAndAddResponse(input, init);
      },
    );
    harness.search.setText("abba");
    await vi.advanceTimersByTimeAsync(300);
    expect(searchCount).toBe(1);

    const submit = harness.add.submit("abba");
    expect(firstSearchSignal?.aborted).toBe(true);
    await flushPromises();

    expect(searchCount).toBe(2);
    expect(harness.search.getSnapshot().items.map(({ id }) => id)).toEqual([
      "first",
    ]);
    expect(
      harness.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);

    resolveOldSearch?.(
      jsonResponse({ items: [track("stale-result")] }),
    );
    await flushPromises();
    expect(harness.search.getSnapshot().items.map(({ id }) => id)).toEqual(["first"]);

    resolvePost?.(jsonResponse({ ok: true }));
    await submit;
  });

  it("retries a failed search on Enter and adds the new first result", async () => {
    vi.useFakeTimers();
    let searchCount = 0;
    const harness = createHarness((input, init) => {
      if (String(input).startsWith("/api/search")) {
        searchCount += 1;

        return searchCount === 1
          ? Promise.resolve(
              jsonResponse(
                { error: { code: "UPSTREAM_ERROR", message: "ignored" } },
                502,
              ),
            )
          : searchAndAddResponse(input, init);
      }

      return searchAndAddResponse(input, init);
    });
    await loadSearch(harness.search);
    expect(harness.search.getSnapshot().phase).toBe("error");

    await harness.add.submit("abba");

    expect(searchCount).toBe(2);
    expect(
      harness.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("does not add when the current search is empty", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/search")) {
        return Promise.resolve(jsonResponse({ items: [] }));
      }

      return Promise.resolve(jsonResponse({ ok: true }));
    });
    const harness = createHarness(fetchMock);
    await loadSearch(harness.search);

    await harness.add.submit("abba");

    expect(harness.fetchMock).toHaveBeenCalledOnce();
    expect(harness.add.getSnapshot().notice).toBeNull();
    expect(harness.search.getSnapshot().phase).toBe("empty");
  });

  it("shows an underlength Enter warning and resets it when text changes", async () => {
    vi.useFakeTimers();
    const harness = createHarness(searchAndAddResponse);

    await harness.add.submit("abc");

    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(harness.add.getSnapshot().notice).toMatchObject({
      kind: "warning",
      text: "Digite pelo menos 4 letras",
    });

    harness.search.setText("ab");
    harness.add.clearNotice();

    expect(harness.add.getSnapshot().notice).toBeNull();
    expect(harness.search.getSnapshot().phase).toBe("idle");
  });

  it("guards two same-tick submits while the add request is in flight", async () => {
    vi.useFakeTimers();
    let resolvePost: ((response: Response) => void) | undefined;
    const harness = createHarness((input, init) => {
      if (init?.method === "POST") {
        return new Promise((resolve) => {
          resolvePost = resolve;
        });
      }

      return searchAndAddResponse(input, init);
    });
    await loadSearch(harness.search);

    const firstSubmit = harness.add.submit("abba");
    const secondSubmit = harness.add.submit("abba");

    expect(harness.add.getSnapshot().isAdding).toBe(true);
    expect(
      harness.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);

    resolvePost?.(jsonResponse({ ok: true }));
    await Promise.all([firstSubmit, secondSubmit]);

    expect(harness.refreshQueue).toHaveBeenCalledOnce();
  });

  it("clears the input only when it still matches the submit snapshot", async () => {
    vi.useFakeTimers();
    let resolvePost: ((response: Response) => void) | undefined;
    const harness = createHarness((input, init) => {
      if (init?.method === "POST") {
        return new Promise((resolve) => {
          resolvePost = resolve;
        });
      }

      return searchAndAddResponse(input, init);
    });
    await loadSearch(harness.search);

    const submit = harness.add.submit("abba");
    harness.search.setText("newer query");
    resolvePost?.(jsonResponse({ ok: true }));
    await submit;

    expect(harness.search.getText()).toBe("newer query");
    expect(harness.search.getSnapshot().phase).toBe("debouncing");
  });

  it.each([
    ["HTML", () => new Response("<html>portal</html>", { status: 200 })],
    ["an empty object", () => jsonResponse({})],
    ["ok false", () => jsonResponse({ ok: false })],
  ])("rejects a 200 add response with %s", async (_label, makeResponse) => {
    vi.useFakeTimers();
    const harness = createHarness((input) => {
      if (String(input).startsWith("/api/search")) {
        return Promise.resolve(jsonResponse({ items: [track("first")] }));
      }

      return Promise.resolve(makeResponse());
    });
    await loadSearch(harness.search);

    await harness.add.submit("abba");

    expect(harness.add.getSnapshot().notice).toMatchObject({
      kind: "error",
      text: "Algo deu errado, tente de novo",
    });
    expect(harness.search.getText()).toBe("abba");
    expect(harness.refreshQueue).not.toHaveBeenCalled();
  });

  it("shows success for four seconds and then fades for 150 ms", async () => {
    vi.useFakeTimers();
    const harness = createHarness(searchAndAddResponse);
    await loadSearch(harness.search);
    await harness.add.submit("abba");

    expect(harness.add.getSnapshot().notice?.kind).toBe("success");
    await vi.advanceTimersByTimeAsync(ADD_SUCCESS_DURATION_MS - 1);
    expect(harness.add.getSnapshot().isNoticeFading).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.add.getSnapshot().isNoticeFading).toBe(true);
    await vi.advanceTimersByTimeAsync(ADD_SUCCESS_FADE_MS);

    expect(harness.add.getSnapshot().notice).toBeNull();
  });
});

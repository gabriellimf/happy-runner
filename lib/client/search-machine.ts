import type { Track } from "../spotify-responses";
import { searchTracks } from "./api";
import { getClientErrorMessage } from "./errors";

export const MIN_SEARCH_QUERY_LENGTH = 4;
export const SEARCH_DEBOUNCE_MS = 300;

export type SearchPhase =
  | "idle"
  | "debouncing"
  | "loading"
  | "results"
  | "empty"
  | "error";

export interface SearchState {
  errorMessage: string | null;
  items: Track[];
  phase: SearchPhase;
  query: string;
  resultQuery: string | null;
  text: string;
}

export type SearchNowResult =
  | { kind: "success"; items: Track[] }
  | { kind: "error"; message: string }
  | { kind: "invalid" }
  | { kind: "stale" };

interface SearchMachineOptions {
  isOnline?: () => boolean;
  search?: (query: string, signal: AbortSignal) => Promise<Track[]>;
}

interface SearchMachine {
  getSnapshot: () => SearchState;
  getText: () => string;
  resume: () => void;
  searchNow: (text?: string) => Promise<SearchNowResult>;
  setText: (text: string) => void;
  subscribe: (listener: () => void) => () => void;
  suspend: () => void;
}

const INITIAL_STATE: SearchState = {
  errorMessage: null,
  items: [],
  phase: "idle",
  query: "",
  resultQuery: null,
  text: "",
};

export function isSearchQueryValid(text: string): boolean {
  return Array.from(text.trim()).length >= MIN_SEARCH_QUERY_LENGTH;
}

export function createSearchMachine(
  options: SearchMachineOptions = {},
): SearchMachine {
  const search = options.search ?? searchTracks;
  const listeners = new Set<() => void>();
  let state = INITIAL_STATE;
  let active = true;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;

  function publish(nextState: SearchState): void {
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

  function abortCurrentRequest(): void {
    controller?.abort();
    controller = null;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): SearchState {
    return state;
  }

  function getText(): string {
    return state.text;
  }

  function isCurrentRequest(
    requestGeneration: number,
    requestController: AbortController,
  ): boolean {
    return (
      active &&
      requestGeneration === generation &&
      !requestController.signal.aborted
    );
  }

  async function executeSearch(
    query: string,
    requestGeneration: number,
  ): Promise<SearchNowResult> {
    const requestController = new AbortController();
    controller = requestController;

    publish({
      ...state,
      errorMessage: null,
      phase: "loading",
      query,
    });

    try {
      const items = await search(query, requestController.signal);

      if (!isCurrentRequest(requestGeneration, requestController)) {
        return { kind: "stale" };
      }

      publish({
        ...state,
        errorMessage: null,
        items,
        phase: items.length > 0 ? "results" : "empty",
        query,
        resultQuery: query,
      });

      return { kind: "success", items };
    } catch (error) {
      if (!isCurrentRequest(requestGeneration, requestController)) {
        return { kind: "stale" };
      }

      const message = getClientErrorMessage(
        error,
        options.isOnline?.(),
      );

      publish({
        ...state,
        errorMessage: message,
        items: [],
        phase: "error",
        query,
        resultQuery: query,
      });

      return { kind: "error", message };
    } finally {
      if (controller === requestController) {
        controller = null;
      }
    }
  }

  function setText(text: string): void {
    if (!active) {
      return;
    }

    clearTimer();
    abortCurrentRequest();
    generation += 1;

    const query = text.trim();
    const validQuery = isSearchQueryValid(text);

    publish({
      ...state,
      errorMessage: null,
      items: validQuery ? state.items : [],
      phase: validQuery ? "debouncing" : "idle",
      query,
      resultQuery: validQuery ? state.resultQuery : null,
      text,
    });

    if (!validQuery) {
      return;
    }

    const requestGeneration = generation;

    timer = setTimeout(() => {
      timer = null;
      void executeSearch(query, requestGeneration);
    }, SEARCH_DEBOUNCE_MS);
  }

  function searchNow(text = state.text): Promise<SearchNowResult> {
    if (!active) {
      return Promise.resolve({ kind: "stale" });
    }

    const query = text.trim();

    if (!isSearchQueryValid(text)) {
      return Promise.resolve({ kind: "invalid" });
    }

    clearTimer();
    abortCurrentRequest();
    generation += 1;

    return executeSearch(query, generation);
  }

  function suspend(): void {
    active = false;
    clearTimer();
    abortCurrentRequest();
    generation += 1;
  }

  function resume(): void {
    active = true;
  }

  return {
    getSnapshot,
    getText,
    resume,
    searchNow,
    setText,
    subscribe,
    suspend,
  };
}

import type { Track } from "../spotify-responses";
import { addTrack } from "./api";
import { CLIENT_MESSAGES, getClientErrorMessage } from "./errors";
import {
  isSearchQueryValid,
  type SearchNowResult,
  type SearchState,
} from "./search-machine";

export const ADD_SUCCESS_DURATION_MS = 4_000;
export const ADD_SUCCESS_FADE_MS = 150;

export interface AddNotice {
  kind: "error" | "hint" | "success" | "warning";
  text: string;
}

export interface AddState {
  activeTrackId: string | null;
  isAdding: boolean;
  isNoticeFading: boolean;
  notice: AddNotice | null;
}

interface AddMachineOptions {
  addRequest?: (uri: string) => Promise<void>;
  focusInput?: () => void;
  getSearchSnapshot: () => SearchState;
  getText: () => string;
  isOnline?: () => boolean;
  refreshQueue: () => void;
  searchNow: (text: string) => Promise<SearchNowResult>;
  setText: (text: string) => void;
}

interface AddMachine {
  add: (track: Track, submittedText?: string) => Promise<void>;
  clearNotice: () => void;
  dispose: () => void;
  getSnapshot: () => AddState;
  submit: (text: string) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
}

const INITIAL_STATE: AddState = {
  activeTrackId: null,
  isAdding: false,
  isNoticeFading: false,
  notice: null,
};

function selectAutoAddTrack(
  items: readonly Track[],
  autoAddId: string | null | undefined,
): Track | undefined {
  return autoAddId === undefined
    ? items[0]
    : items.find((track) => track.id === autoAddId);
}

// Enter must not add a track that Jev judged to be another version of a queued song.
// Tapping the suggestion still adds it.
function isQueuedVersion(
  track: Track,
  inQueue: SearchState["inQueue"],
): boolean {
  return inQueue?.[track.id] === "version";
}

export function createAddMachine(options: AddMachineOptions): AddMachine {
  const addRequest = options.addRequest ?? addTrack;
  const listeners = new Set<() => void>();
  let state = INITIAL_STATE;
  let inFlight = false;
  let successTimer: ReturnType<typeof setTimeout> | null = null;

  function publish(nextState: AddState): void {
    state = nextState;

    for (const listener of listeners) {
      listener();
    }
  }

  function clearSuccessTimer(): void {
    if (successTimer !== null) {
      clearTimeout(successTimer);
      successTimer = null;
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): AddState {
    return state;
  }

  function clearNotice(): void {
    clearSuccessTimer();
    publish({ ...state, isNoticeFading: false, notice: null });
  }

  function showSuccess(title: string): void {
    clearSuccessTimer();
    const notice: AddNotice = {
      kind: "success",
      text: `Adicionada à fila: ${title}`,
    };

    publish({ ...state, isNoticeFading: false, notice });
    successTimer = setTimeout(() => {
      if (state.notice === notice) {
        publish({ ...state, isNoticeFading: true });
        successTimer = setTimeout(() => {
          successTimer = null;

          if (state.notice === notice) {
            publish({
              ...state,
              isNoticeFading: false,
              notice: null,
            });
          }
        }, ADD_SUCCESS_FADE_MS);
      }
    }, ADD_SUCCESS_DURATION_MS);
  }

  function showError(error: unknown): void {
    publish({
      ...state,
      isNoticeFading: false,
      notice: {
        kind: "error",
        text: getClientErrorMessage(error, options.isOnline?.()),
      },
    });
  }

  function showSuggestionHint(text: string = CLIENT_MESSAGES.pickSuggestion): void {
    clearSuccessTimer();
    publish({
      ...state,
      isNoticeFading: false,
      notice: { kind: "hint", text },
    });
  }

  function begin(trackId: string | null): boolean {
    if (inFlight) {
      return false;
    }

    inFlight = true;
    clearSuccessTimer();
    publish({
      activeTrackId: trackId,
      isAdding: true,
      isNoticeFading: false,
      notice: null,
    });

    return true;
  }

  async function addToQueue(track: Track, submittedText: string): Promise<void> {
    publish({ ...state, activeTrackId: track.id });
    await addRequest(track.uri);

    if (options.getText() === submittedText) {
      options.setText("");
    }

    options.focusInput?.();
    showSuccess(track.title);
    options.refreshQueue();
  }

  async function add(
    track: Track,
    submittedText = options.getText(),
  ): Promise<void> {
    if (!begin(track.id)) {
      return;
    }

    try {
      await addToQueue(track, submittedText);
    } catch (error) {
      showError(error);
    } finally {
      inFlight = false;
      publish({ ...state, activeTrackId: null, isAdding: false });
    }
  }

  async function submit(text: string): Promise<void> {
    if (inFlight) {
      return;
    }

    if (!isSearchQueryValid(text)) {
      clearSuccessTimer();
      publish({
        ...state,
        notice: { kind: "warning", text: CLIENT_MESSAGES.shortQuery },
      });
      return;
    }

    const submittedText = text;
    const query = text.trim();
    const searchState = options.getSearchSnapshot();
    const currentSearch =
      searchState.query === query && searchState.resultQuery === query;

    if (currentSearch && searchState.phase === "empty") {
      clearNotice();
      return;
    }

    if (currentSearch && searchState.phase === "results") {
      const track = selectAutoAddTrack(
        searchState.items,
        searchState.autoAddId,
      );

      if (!track) {
        showSuggestionHint();
      } else if (isQueuedVersion(track, searchState.inQueue)) {
        showSuggestionHint(CLIENT_MESSAGES.versionInQueue);
      } else {
        await add(track, submittedText);
      }

      return;
    }

    if (!begin(null)) {
      return;
    }

    try {
      const result = await options.searchNow(query);

      if (result.kind !== "success" || result.items.length === 0) {
        return;
      }

      const track = selectAutoAddTrack(result.items, result.autoAddId);

      if (!track) {
        showSuggestionHint();
        return;
      }

      if (isQueuedVersion(track, result.inQueue)) {
        showSuggestionHint(CLIENT_MESSAGES.versionInQueue);
        return;
      }

      await addToQueue(track, submittedText);
    } catch (error) {
      showError(error);
    } finally {
      inFlight = false;
      publish({ ...state, activeTrackId: null, isAdding: false });
    }
  }

  function dispose(): void {
    clearSuccessTimer();
  }

  return {
    add,
    clearNotice,
    dispose,
    getSnapshot,
    submit,
    subscribe,
  };
}

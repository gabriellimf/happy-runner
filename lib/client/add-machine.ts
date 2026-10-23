import { isExplicitVersionQuery } from "../search-terms";
import type { Track } from "../spotify-responses";
import { ClientApiError, addTrack } from "./api";
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
  addRequest?: (uri: string, force?: boolean) => Promise<void>;
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
  if (autoAddId === undefined || autoAddId === null) {
    return items[0];
  }

  return items.find((track) => track.id === autoAddId);
}

// Enter warns on a queued version unless the guest explicitly requested one.
// Tapping a suggestion still adds it.
function isQueuedVersion(
  track: Track,
  inQueue: SearchState["inQueue"],
  query: string,
): boolean {
  return (
    inQueue?.[track.id] === "version" && !isExplicitVersionQuery(query)
  );
}

export function createAddMachine(options: AddMachineOptions): AddMachine {
  const addRequest = options.addRequest ?? addTrack;
  const listeners = new Set<() => void>();
  let state = INITIAL_STATE;
  let inFlight = false;
  let successTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingDuplicate:
    | { query: string; track: Track }
    | undefined;
  // A copy-limit refusal stays terminal for this query; Enter cannot override it.
  let terminalRefusal: { query: string; trackId: string } | undefined;

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
    pendingDuplicate = undefined;
    terminalRefusal = undefined;
    publish({ ...state, isNoticeFading: false, notice: null });
  }

  function rememberQueueRefusal(
    error: unknown,
    track: Track,
    submittedText: string,
  ): void {
    if (!(error instanceof ClientApiError)) {
      return;
    }

    if (error.code === "ALREADY_IN_QUEUE") {
      terminalRefusal = undefined;
      pendingDuplicate = { query: submittedText, track };
    } else if (error.code === "TRACK_COPY_LIMIT") {
      pendingDuplicate = undefined;
      terminalRefusal = { query: submittedText, trackId: track.id };
    }
  }

  function consumeDuplicateConfirmation(
    track: Track | undefined,
    submittedText: string,
  ): boolean {
    const matches =
      track !== undefined &&
      pendingDuplicate?.track.id === track.id &&
      pendingDuplicate.query === submittedText;

    if (matches) {
      pendingDuplicate = undefined;
    }

    return matches;
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

  async function addToQueue(
    track: Track,
    submittedText: string,
    force = false,
  ): Promise<void> {
    publish({ ...state, activeTrackId: track.id });
    if (force) {
      await addRequest(track.uri, true);
    } else {
      await addRequest(track.uri);
    }

    pendingDuplicate = undefined;
    terminalRefusal = undefined;
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
    if (
      terminalRefusal?.query === submittedText &&
      terminalRefusal.trackId === track.id
    ) {
      return;
    }

    if (!begin(track.id)) {
      return;
    }

    pendingDuplicate = undefined;
    terminalRefusal = undefined;

    try {
      await addToQueue(track, submittedText);
    } catch (error) {
      rememberQueueRefusal(error, track, submittedText);
      showError(error);
    } finally {
      inFlight = false;
      publish({ ...state, activeTrackId: null, isAdding: false });
    }
  }

  async function addFromSubmit(
    track: Track,
    submittedText: string,
    force: boolean,
  ): Promise<void> {
    if (!begin(track.id)) {
      return;
    }

    try {
      await addToQueue(track, submittedText, force);
    } catch (error) {
      rememberQueueRefusal(error, track, submittedText);
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

    if (pendingDuplicate && pendingDuplicate.query !== text) {
      pendingDuplicate = undefined;
    }
    if (terminalRefusal && terminalRefusal.query !== text) {
      terminalRefusal = undefined;
    }

    if (!isSearchQueryValid(text)) {
      pendingDuplicate = undefined;
      terminalRefusal = undefined;
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
    const hasCurrentResults =
      currentSearch && searchState.phase === "results";

    if (
      terminalRefusal?.query === submittedText &&
      !hasCurrentResults
    ) {
      return;
    }

    if (currentSearch && searchState.phase === "empty") {
      clearNotice();
      return;
    }

    if (currentSearch && searchState.phase === "results") {
      const confirmedDuplicate =
        pendingDuplicate?.query === submittedText ? pendingDuplicate : undefined;

      if (confirmedDuplicate) {
        const force = consumeDuplicateConfirmation(
          confirmedDuplicate.track,
          submittedText,
        );
        await addFromSubmit(confirmedDuplicate.track, submittedText, force);
        return;
      }

      const track = selectAutoAddTrack(
        searchState.items,
        searchState.autoAddId,
      );

      if (
        terminalRefusal?.query === submittedText &&
        (!track || terminalRefusal.trackId === track.id)
      ) {
        return;
      }

      if (!track) {
        consumeDuplicateConfirmation(undefined, submittedText);
        showSuggestionHint();
      } else if (isQueuedVersion(track, searchState.inQueue, submittedText)) {
        consumeDuplicateConfirmation(undefined, submittedText);
        showSuggestionHint(CLIENT_MESSAGES.versionInQueue);
      } else {
        const force = consumeDuplicateConfirmation(track, submittedText);
        await addFromSubmit(track, submittedText, force);
      }

      return;
    }

    if (!begin(null)) {
      return;
    }

    pendingDuplicate = undefined;
    terminalRefusal = undefined;
    let trackToAdd: Track | undefined;

    try {
      const result = await options.searchNow(query);

      if (result.kind !== "success" || result.items.length === 0) {
        return;
      }

      const track = selectAutoAddTrack(result.items, result.autoAddId);

      if (!track) {
        consumeDuplicateConfirmation(undefined, submittedText);
        showSuggestionHint();
        return;
      }

      if (isQueuedVersion(track, result.inQueue, submittedText)) {
        consumeDuplicateConfirmation(undefined, submittedText);
        showSuggestionHint(CLIENT_MESSAGES.versionInQueue);
        return;
      }

      trackToAdd = track;
      await addToQueue(track, submittedText);
    } catch (error) {
      if (trackToAdd) {
        rememberQueueRefusal(error, trackToAdd, submittedText);
      }
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

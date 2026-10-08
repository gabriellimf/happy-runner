"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type { AddState } from "../lib/client/add-machine";
import { createAddMachine } from "../lib/client/add-machine";
import type { SearchNowResult, SearchState } from "../lib/client/search-machine";
import type { Track } from "../lib/spotify-responses";

interface UseAddTrackOptions {
  focusInput?: () => void;
  getSearchSnapshot: () => SearchState;
  getText: () => string;
  refreshQueue: () => void;
  searchNow: (text: string) => Promise<SearchNowResult>;
  setText: (text: string) => void;
}

interface AddTrackHook {
  add: (track: Track) => Promise<void>;
  clearNotice: () => void;
  state: AddState;
  submit: (text: string) => Promise<void>;
}

export function useAddTrack(options: UseAddTrackOptions): AddTrackHook {
  const [machine] = useState(() => createAddMachine(options));
  const state = useSyncExternalStore(
    machine.subscribe,
    machine.getSnapshot,
    machine.getSnapshot,
  );

  useEffect(
    () => () => {
      machine.dispose();
    },
    [machine],
  );

  return {
    add: machine.add,
    clearNotice: machine.clearNotice,
    state,
    submit: machine.submit,
  };
}

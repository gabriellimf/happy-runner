"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { createSearchMachine } from "../lib/client/search-machine";

export function useSearch() {
  const [machine] = useState(() => createSearchMachine());
  const state = useSyncExternalStore(
    machine.subscribe,
    machine.getSnapshot,
    machine.getSnapshot,
  );

  useEffect(() => {
    machine.resume();

    return () => {
      machine.suspend();
    };
  }, [machine]);

  return {
    getSnapshot: machine.getSnapshot,
    getText: machine.getText,
    searchNow: machine.searchNow,
    setText: machine.setText,
    state,
  };
}

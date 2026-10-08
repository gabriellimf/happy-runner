"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { createQueueMachine } from "../lib/client/queue-machine";

export function useQueue() {
  const [machine] = useState(() => createQueueMachine());
  const state = useSyncExternalStore(
    machine.subscribe,
    machine.getSnapshot,
    machine.getSnapshot,
  );

  useEffect(() => {
    const handleVisibilityChange = () => {
      machine.setHidden(document.visibilityState === "hidden");
    };
    const handleOnline = () => {
      void machine.refresh();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    machine.setHidden(document.visibilityState === "hidden");
    machine.start();

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      machine.stop();
    };
  }, [machine]);

  const refresh = useCallback(() => {
    void machine.refresh();
  }, [machine]);

  return { refresh, state };
}

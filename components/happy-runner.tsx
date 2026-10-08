"use client";

import { useRef } from "react";

import { useAddTrack } from "../hooks/use-add-track";
import { useQueue } from "../hooks/use-queue";
import { useSearch } from "../hooks/use-search";
import { CLIENT_MESSAGES } from "../lib/client/errors";
import { isSearchQueryValid } from "../lib/client/search-machine";
import type { SearchPhase } from "../lib/client/search-machine";
import { QueueSection } from "./queue-section";
import { SearchForm } from "./search-form";
import type { StatusMessageValue } from "./status-message";
import { StatusMessage } from "./status-message";
import { SuggestionList } from "./suggestion-list";

function getSearchMessage(
  phase: SearchPhase,
  text: string,
  errorMessage: string | null,
): StatusMessageValue | null {
  switch (phase) {
    case "empty":
      return { kind: "empty", text: CLIENT_MESSAGES.emptySearch };
    case "error":
      return {
        kind: "error",
        text: errorMessage ?? CLIENT_MESSAGES.genericError,
      };
    case "idle":
      return { kind: "hint", text: CLIENT_MESSAGES.shortQuery };
    case "loading":
      return { kind: "loading", text: "Buscando..." };
    case "results":
    case "debouncing":
    default:
      return !isSearchQueryValid(text)
        ? { kind: "hint", text: CLIENT_MESSAGES.shortQuery }
        : null;
  }
}

export function HappyRunner() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const search = useSearch();
  const queue = useQueue();
  const add = useAddTrack({
    focusInput: () => {
      inputRef.current?.focus();
    },
    getSearchSnapshot: search.getSnapshot,
    getText: search.getText,
    refreshQueue: queue.refresh,
    searchNow: search.searchNow,
    setText: search.setText,
  });
  const statusMessage: StatusMessageValue | null = add.state.notice
    ? add.state.notice
    : getSearchMessage(
        search.state.phase,
        search.state.text,
        search.state.errorMessage,
      );

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col gap-6 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
      <header>
        <h1 className="text-sm font-semibold tracking-tight">Happy Runner</h1>
      </header>
      <section aria-label="Busca de músicas" className="space-y-2">
        <SearchForm
          isAdding={add.state.isAdding}
          isDisabled={!isSearchQueryValid(search.state.text) || add.state.isAdding}
          inputRef={(input) => {
            inputRef.current = input;
          }}
          onSubmit={() => {
            void add.submit(search.state.text);
          }}
          onTextChange={(text) => {
            search.setText(text);
            add.clearNotice();
          }}
          text={search.state.text}
        />
        <StatusMessage
          fading={add.state.isNoticeFading}
          liveText={
            add.state.isAdding
              ? "Adicionando à fila"
              : search.state.phase === "results" &&
                  search.state.resultQuery === search.state.query
                ? `${search.state.items.length} ${
                    search.state.items.length === 1 ? "sugestão" : "sugestões"
                  }`
                : undefined
          }
          message={statusMessage}
        />
        <SuggestionList
          activeTrackId={add.state.activeTrackId}
          isAdding={add.state.isAdding}
          items={search.state.items}
          onSelect={(track) => {
            void add.add(track);
          }}
          phase={search.state.phase}
          query={search.state.query}
          resultQuery={search.state.resultQuery}
        />
      </section>
      <QueueSection state={queue.state} />
    </div>
  );
}

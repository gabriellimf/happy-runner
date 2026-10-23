import type { InQueue, InQueueKind, Track } from "../lib/spotify-responses";
import type { SearchPhase } from "../lib/client/search-machine";
import { PlusIcon } from "./icons";
import { TrackRow } from "./track-row";

const QUEUE_BADGES: Record<InQueueKind, string> = {
  exact: "Já na fila",
  version: "Versão na fila",
};

interface SuggestionListProps {
  activeTrackId: string | null;
  inQueue?: InQueue;
  isAdding: boolean;
  items: Track[];
  onSelect: (track: Track) => void;
  phase: SearchPhase;
  query: string;
  resultQuery: string | null;
}

function SuggestionSkeleton() {
  return (
    <li
      aria-hidden="true"
      className="grid min-h-[72px] grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-3 rounded-row bg-surface px-3 py-2 motion-safe:animate-pulse"
    >
      <span className="size-14 rounded-chip bg-surface-3" />
      <span className="min-w-0 space-y-2">
        <span className="block h-4 w-3/4 rounded bg-surface-3" />
        <span className="block h-3 w-1/2 rounded bg-surface-3" />
      </span>
    </li>
  );
}

export function SuggestionList({
  activeTrackId,
  inQueue,
  isAdding,
  items,
  onSelect,
  phase,
  query,
  resultQuery,
}: SuggestionListProps) {
  const isLoading = phase === "loading";
  const hasSuggestions = items.length > 0;

  if (!hasSuggestions && !isLoading) {
    return null;
  }

  return (
    <div className="space-y-2">
      <ul aria-label="Sugestões" className="space-y-2">
        {items.slice(0, 5).map((track, index) => {
          const isBusyRow = activeTrackId === track.id;
          return (
            <li
              className="motion-safe:animate-rise-in"
              key={track.id}
              style={{ animationDelay: `${index * 40}ms` }}
            >
              <button
                aria-busy={isBusyRow || undefined}
                className={`flex min-h-[72px] w-full items-center gap-3 rounded-row bg-surface px-3 py-2 text-left touch-manipulation focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base active:bg-surface-2 motion-safe:active:scale-[0.98] motion-safe:transition-transform duration-100 ${
                  index === 0 ? "ring-1 ring-accent" : ""
                } ${isAdding ? "opacity-60" : ""}`}
                disabled={isAdding}
                onClick={() => onSelect(track)}
                type="button"
              >
                <span className="sr-only">Adicionar </span>
                <span className="min-w-0 flex-1">
                  <TrackRow coverSize="small" track={track} />
                  {inQueue?.[track.id] ? (
                    <span className="mt-1 ml-[68px] block rounded-pill bg-surface-3 px-2 py-0.5 text-caption text-warn-ink">
                      {QUEUE_BADGES[inQueue[track.id]]}
                    </span>
                  ) : null}
                </span>
                <span
                  aria-hidden="true"
                  className={
                    isBusyRow
                      ? "flex size-11 shrink-0 items-center justify-center rounded-pill ring-1 ring-inset ring-accent"
                      : index === 0
                        ? "flex size-11 shrink-0 items-center justify-center rounded-pill bg-accent text-body font-semibold text-on-accent"
                        : "flex size-11 shrink-0 items-center justify-center rounded-pill bg-surface-3 text-ink"
                  }
                >
                  {isBusyRow
                    ? null
                    : index === 0
                      ? "↵"
                      : <PlusIcon className="size-5" />}
                </span>
              </button>
            </li>
          );
        })}
        {isLoading && !hasSuggestions
          ? Array.from({ length: 3 }, (_, index) => (
              <SuggestionSkeleton key={`search-skeleton-${index}`} />
            ))
          : null}
      </ul>
      {phase === "results" && resultQuery === query ? (
        <p className="px-1 text-meta text-ink-2">
          Enter adiciona a primeira. Toque em outra para escolher.
        </p>
      ) : null}
    </div>
  );
}

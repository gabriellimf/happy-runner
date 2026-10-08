import type { Track } from "../lib/spotify-responses";
import type { SearchPhase } from "../lib/client/search-machine";
import { TrackRow } from "./track-row";

interface SuggestionListProps {
  activeTrackId: string | null;
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
      className="grid min-h-16 grid-cols-[3rem_minmax(0,1fr)] items-center gap-3 rounded-xl bg-zinc-900 p-2 motion-safe:animate-pulse"
    >
      <span className="size-12 rounded-lg bg-zinc-800" />
      <span className="min-w-0 space-y-2">
        <span className="block h-4 w-3/4 rounded bg-zinc-800" />
        <span className="block h-3 w-1/2 rounded bg-zinc-800" />
      </span>
    </li>
  );
}

export function SuggestionList({
  activeTrackId,
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
        {items.slice(0, 5).map((track, index) => (
          <li key={track.id}>
            <button
              aria-busy={activeTrackId === track.id || undefined}
              className={`min-h-16 w-full rounded-xl bg-zinc-900 p-2 text-left focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 active:scale-[0.98] active:bg-zinc-800 motion-safe:transition-transform duration-100 touch-manipulation ${
                index === 0 ? "border-l-2 border-emerald-400" : ""
              } ${isAdding ? "opacity-60" : ""}`}
              disabled={isAdding}
              onClick={() => onSelect(track)}
              type="button"
            >
              <span className="sr-only">Adicionar </span>
              <TrackRow track={track} />
            </button>
          </li>
        ))}
        {isLoading && !hasSuggestions
          ? Array.from({ length: 3 }, (_, index) => (
              <SuggestionSkeleton key={`search-skeleton-${index}`} />
            ))
          : null}
      </ul>
      {phase === "results" && resultQuery === query ? (
        <p className="px-1 text-sm text-zinc-400">
          Enter adiciona a primeira. Toque em outra para escolher.
        </p>
      ) : null}
    </div>
  );
}

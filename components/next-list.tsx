import type { QueueTrack } from "../lib/spotify-responses";
import { TrackRow } from "./track-row";

interface NextListProps {
  tracks: QueueTrack[];
}

export function NextList({ tracks }: NextListProps) {
  return (
    <section aria-labelledby="next-tracks-heading" className="space-y-3">
      <h2 className="text-title text-ink" id="next-tracks-heading">
        Próximas
      </h2>
      {tracks.length === 0 ? (
        <p className="rounded-card bg-surface p-5 text-body text-ink">
          Nenhuma música na fila
        </p>
      ) : (
        <ul className="divide-y divide-hairline overflow-hidden rounded-card bg-surface">
          {tracks.map((track, index) => (
            <li
              className="flex min-h-16 items-center gap-2 px-3 py-2"
              key={`${track.id}-${index}`}
            >
              <span
                aria-hidden="true"
                className="w-5 shrink-0 text-meta text-ink-3 tabular-nums"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <TrackRow coverSize="mini" track={track} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

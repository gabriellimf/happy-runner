import type { QueueTrack } from "../lib/spotify-responses";
import { TrackRow } from "./track-row";

interface NextListProps {
  tracks: QueueTrack[];
}

export function NextList({ tracks }: NextListProps) {
  return (
    <section aria-labelledby="next-tracks-heading" className="space-y-2">
      <h2
        className="text-sm font-medium text-zinc-400"
        id="next-tracks-heading"
      >
        Próximas
      </h2>
      {tracks.length === 0 ? (
        <p className="text-sm text-zinc-400">Nenhuma música na fila</p>
      ) : (
        <ul className="space-y-2">
          {tracks.map((track, index) => (
            <li
              className="min-h-14 rounded-xl bg-zinc-900 p-2"
              key={`${track.id}-${index}`}
            >
              <TrackRow track={track} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

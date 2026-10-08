import type { Track } from "../lib/spotify-responses";
import type { CoverSize } from "./cover";
import { Cover } from "./cover";

export type TrackDisplay = Pick<Track, "artists" | "coverUrl" | "title">;

interface TrackRowProps {
  coverSize?: CoverSize;
  track: TrackDisplay;
}

export function TrackRow({ coverSize = "small", track }: TrackRowProps) {
  const isLarge = coverSize === "large";
  const columnsClass = isLarge
    ? "grid-cols-[6rem_minmax(0,1fr)]"
    : "grid-cols-[3rem_minmax(0,1fr)]";
  const titleClass = isLarge ? "line-clamp-2" : "truncate";

  return (
    <div className={`grid ${columnsClass} min-w-0 items-center gap-3`}>
      <Cover coverUrl={track.coverUrl} size={coverSize} />
      <span className="min-w-0">
        <span className={`block ${titleClass} text-base font-medium`}>
          {track.title}
        </span>
        <span className="block truncate text-sm text-zinc-400">
          {track.artists.join(", ")}
        </span>
      </span>
    </div>
  );
}

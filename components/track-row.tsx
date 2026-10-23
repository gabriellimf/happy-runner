import type { Track } from "../lib/spotify-responses";
import type { CoverSize } from "./cover";
import { Cover } from "./cover";

export type TrackDisplay = Pick<Track, "artists" | "coverUrl" | "title">;

interface TrackRowProps {
  coverSize?: CoverSize;
  track: TrackDisplay;
}

const COLUMN_CLASSES = {
  large: "grid-cols-[8rem_minmax(0,1fr)]",
  mini: "grid-cols-[3rem_minmax(0,1fr)]",
  small: "grid-cols-[3.5rem_minmax(0,1fr)]",
} as const;

export function TrackRow({ coverSize = "small", track }: TrackRowProps) {
  const isLarge = coverSize === "large";
  const titleClass = isLarge
    ? "line-clamp-2 text-hero text-ink"
    : "truncate text-body text-ink";

  return (
    <div className={`grid ${COLUMN_CLASSES[coverSize]} min-w-0 items-center gap-3`}>
      <Cover coverUrl={track.coverUrl} size={coverSize} />
      <span className="min-w-0">
        <span className={`block ${titleClass}`}>{track.title}</span>
        <span className="block truncate text-meta text-ink-2">
          {track.artists.join(", ")}
        </span>
      </span>
    </div>
  );
}

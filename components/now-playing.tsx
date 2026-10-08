import type { QueueTrack } from "../lib/spotify-responses";
import { TrackRow } from "./track-row";

interface NowPlayingProps {
  track: QueueTrack | null;
}

export function NowPlaying({ track }: NowPlayingProps) {
  return (
    <section aria-labelledby="now-playing-heading" className="space-y-2">
      <h2
        className="text-sm font-medium text-zinc-400"
        id="now-playing-heading"
      >
        Tocando agora
      </h2>
      {track ? (
        <div className="border-l-2 border-emerald-400 py-1 pl-3">
          <TrackRow coverSize="large" track={track} />
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-base font-medium">Nada tocando agora</p>
          <p className="text-sm text-zinc-400">
            Abra o Spotify no celular e toque uma música
          </p>
        </div>
      )}
    </section>
  );
}

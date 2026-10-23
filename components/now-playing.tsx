import type { QueueTrack } from "../lib/spotify-responses";
import { Cover } from "./cover";
import { TrackRow } from "./track-row";

interface NowPlayingProps {
  track: QueueTrack | null;
}

const HERO_GRADIENT = {
  background: "linear-gradient(155deg, var(--bleed), var(--bleed-2))",
} as const;

function Heading() {
  return (
    <h2 className="text-title text-ink-2" id="now-playing-heading">
      Tocando agora
    </h2>
  );
}

export function NowPlaying({ track }: NowPlayingProps) {
  return (
    <section aria-labelledby="now-playing-heading">
      {track ? (
        <div className="space-y-3 rounded-card p-5 shadow-hero" style={HERO_GRADIENT}>
          <Heading />
          <TrackRow coverSize="large" track={track} />
        </div>
      ) : (
        <div className="space-y-3 rounded-card bg-surface p-5 shadow-hero">
          <Heading />
          <div className="grid min-w-0 grid-cols-[8rem_minmax(0,1fr)] items-center gap-3">
            <Cover coverUrl={null} size="large" />
            <div className="min-w-0">
              <p className="text-title text-ink">Nada tocando agora</p>
              <p className="text-meta text-ink-2">
                Abra o Spotify no celular e toque uma música
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

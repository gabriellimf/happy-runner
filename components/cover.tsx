import { MusicNoteIcon } from "./icons";

export type CoverSize = "large" | "mini" | "small";

interface CoverProps {
  coverUrl: string | null;
  size: CoverSize;
}

const COVER_CLASSES = {
  large: "size-32 rounded-row shadow-cover",
  mini: "size-12 rounded-chip",
  small: "size-14 rounded-chip",
} as const;

const COVER_PIXELS = {
  large: 128,
  mini: 48,
  small: 56,
} as const;

function isHttpsUrl(value: string | null): value is string {
  if (value === null) {
    return false;
  }

  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

export function Cover({ coverUrl, size }: CoverProps) {
  const sizeClass = COVER_CLASSES[size];

  if (!isHttpsUrl(coverUrl)) {
    return (
      <div
        aria-hidden="true"
        className={`${sizeClass} flex shrink-0 items-center justify-center bg-zinc-800`}
      >
        {size === "large" ? (
          <MusicNoteIcon className="size-8 text-ink-3" />
        ) : null}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- Spotify artwork uses runtime HTTPS URLs without remote image configuration.
    <img
      alt=""
      className={`${sizeClass} shrink-0 object-cover motion-safe:animate-cover-in`}
      decoding="async"
      height={COVER_PIXELS[size]}
      key={coverUrl}
      loading="lazy"
      referrerPolicy="no-referrer"
      src={coverUrl}
      width={COVER_PIXELS[size]}
    />
  );
}

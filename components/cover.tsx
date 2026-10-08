export type CoverSize = "large" | "small";

interface CoverProps {
  coverUrl: string | null;
  size: CoverSize;
}

const COVER_CLASSES = {
  large: "size-24",
  small: "size-12",
} as const;

const COVER_PIXELS = {
  large: 96,
  small: 48,
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
        className={`${sizeClass} shrink-0 rounded-lg bg-zinc-800`}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- Spotify artwork uses runtime HTTPS URLs without remote image configuration.
    <img
      alt=""
      className={`${sizeClass} shrink-0 rounded-lg object-cover`}
      decoding="async"
      height={COVER_PIXELS[size]}
      loading="lazy"
      referrerPolicy="no-referrer"
      src={coverUrl}
      width={COVER_PIXELS[size]}
    />
  );
}

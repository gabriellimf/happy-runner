export interface Track {
  id: string;
  uri: string;
  title: string;
  artists: string[];
  coverUrl: string | null;
  durationMs: number;
}

export interface QueueTrack {
  id: string;
  title: string;
  artists: string[];
  coverUrl: string | null;
}

export interface QueueResponse {
  nowPlaying: QueueTrack | null;
  next: QueueTrack[];
}

// exact: the same Spotify track id is playing or queued.
// version: Jev judged it another version of a queued song.
export type InQueueKind = "exact" | "version";

export type InQueue = Record<string, InQueueKind>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseArtists(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const artists: string[] = [];

  for (const artist of value) {
    if (!isRecord(artist) || !isNonEmptyString(artist.name)) {
      return undefined;
    }

    artists.push(artist.name);
  }

  return artists;
}

function parseCoverUrl(album: unknown): string | null {
  if (!isRecord(album) || !Array.isArray(album.images)) {
    return null;
  }

  let fallbackUrl: string | null = null;

  for (const image of album.images) {
    if (!isRecord(image) || !isNonEmptyString(image.url)) {
      continue;
    }

    fallbackUrl ??= image.url;

    if (image.width === 300) {
      return image.url;
    }
  }

  return fallbackUrl;
}

function parseSearchTrack(value: unknown): Track | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { duration_ms: durationMs, id, name, uri, type } = value;
  const artists = parseArtists(value.artists);

  if (
    type !== "track" ||
    !isNonEmptyString(id) ||
    !isNonEmptyString(uri) ||
    !isNonEmptyString(name) ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    artists === undefined
  ) {
    return undefined;
  }

  return {
    id,
    uri,
    title: name,
    artists,
    coverUrl: parseCoverUrl(value.album),
    durationMs,
  };
}

function parseQueueTrack(value: unknown): QueueTrack | undefined {
  if (!isRecord(value) || value.type !== "track") {
    return undefined;
  }

  const { id, name } = value;
  const artists = parseArtists(value.artists);

  if (
    !isNonEmptyString(id) ||
    !isNonEmptyString(name) ||
    artists === undefined
  ) {
    return undefined;
  }

  return {
    id,
    title: name,
    artists,
    coverUrl: parseCoverUrl(value.album),
  };
}

export function parseSpotifySearchResults(value: unknown): Track[] {
  if (
    !isRecord(value) ||
    !isRecord(value.tracks) ||
    !Array.isArray(value.tracks.items)
  ) {
    return [];
  }

  const tracks: Track[] = [];

  for (const item of value.tracks.items) {
    const track = parseSearchTrack(item);

    if (track) {
      tracks.push(track);
    }
  }

  return tracks;
}

export function parseSpotifyQueue(value: unknown): QueueResponse {
  const emptyQueue: QueueResponse = { nowPlaying: null, next: [] };

  if (
    !isRecord(value) ||
    value.currently_playing === null ||
    value.currently_playing === undefined
  ) {
    return emptyQueue;
  }

  const next: QueueTrack[] = [];

  if (Array.isArray(value.queue)) {
    for (const item of value.queue) {
      const track = parseQueueTrack(item);

      if (track) {
        next.push(track);
      }
    }
  }

  return {
    nowPlaying: parseQueueTrack(value.currently_playing) ?? null,
    next,
  };
}

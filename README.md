# Happy Runner

A mobile web page where guests scan a QR code and request tracks for the owner's Spotify queue.
The owner authenticates once. Guests do not log in, and the site does not play audio.

## Owner setup

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Add `http://127.0.0.1:8888/callback` to the app's Redirect URIs.
3. Copy the Client ID and Client Secret to `.env.local`. Set the script's redirect URI to the exact same value:

   ```dotenv
   SPOTIFY_CLIENT_ID=your-client-id
   SPOTIFY_CLIENT_SECRET=your-client-secret
   SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
   SPOTIFY_REFRESH_TOKEN=
   ```

4. Run the one-time local authorization flow:

   ```sh
   node --env-file=.env.local scripts/get-refresh-token.ts
   ```

   Open the URL printed in the terminal and approve access with the owner account. Copy the refresh token printed after authorization to `SPOTIFY_REFRESH_TOKEN` in `.env.local`.
5. Add `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REFRESH_TOKEN` to the Vercel environment. Do not add the refresh token to client-side code.

The owner needs Spotify Premium for an app in development mode. Development mode supports up to 5 authenticated users, and each user must be on the app's allowlist.

## TypeSafe checks (optional)

Set `TYPESAFE_API_KEY` in `.env.local` and in the Vercel environment to turn on three server-side checks. Keep the key out of client-side code. The model is pinned to `jev-1.14.0` in `lib/typesafe.ts`.

Code rules block common playback commands before Spotify is called. For every other query, the server searches Spotify and reads the queue in parallel. Then one Jev request answers all questions below. They read the same state and run in parallel, so the checks add one round trip and not two. A query that Jev blocks still costs one Spotify search.

1. Intent gate. Jev blocks `command` at 0.5 confidence or more and `other` at 0.9 or more. A blocked query returns `{ items: [] }`, and Jev's other answers are ignored.
2. Track pick. Jev picks the track the guest wants from the Spotify results. It sets `autoAddId` only at 0.9 confidence or more.
3. Other version in the queue. One yes or no question per result asks if it is the same song as a track in the queue, in another version (remaster, live, remix, karaoke, cover). A probability of 0.8 or more sets `inQueue[id]` to `"version"`. This threshold was not tuned on real queues. Check it before you rely on it. Results that are already in the queue by id need no question.

Without the key, or when TypeSafe fails or times out (2 seconds, no retry), the checks are skipped. Enter then adds the first result, as before. Exact duplicates are still blocked, because code finds them, not Jev.

## Duplicates

- Exact: code compares the Spotify track id with the playing and queued tracks. `POST /api/queue` returns 409 `ALREADY_IN_QUEUE` and does not add the track. Search marks the track `"exact"`.
- Another version: only a hint. Search marks the track `"version"`. The suggestion shows a badge. Enter does not add it and shows a message. Tapping the suggestion adds it.
- If the queue read fails, the add and the search go on without duplicate checks.
- The queue can change between search and tap, so search hints can be out of date. Only the server check at add time is exact.
- Two guests who add the same song at the same moment can both pass. There is no database.
- Spotify's queue includes tracks from the owner's playlist, not only guest requests. A song that is soon to play from the playlist counts as already in the queue.
- Each search and each add makes one extra Spotify call.

## API

- `GET /api/search?q=<query>` accepts 4 to 100 characters and returns `{ items: Track[], autoAddId?: string | null, inQueue?: Record<string, "exact" | "version"> }`, where `Track` is `{ id, uri, title, artists: string[], coverUrl: string | null, durationMs }`. `autoAddId` is present only when TypeSafe judged the results. A string is the track that Enter adds. `null` means no confident match, so the UI asks the guest to pick a suggestion. When it is absent, Enter adds the first item. `inQueue` maps track ids to the kind of duplicate. It is present only when at least one result matches.
- `POST /api/queue` accepts `{ uri: "spotify:track:..." }` and returns `{ ok: true }`. It returns 409 when the track is playing or already queued.
- `GET /api/queue` returns `{ nowPlaying: QueueTrack | null, next: QueueTrack[] }`, where `QueueTrack` is `{ id, title, artists: string[], coverUrl: string | null }`. It sets `Cache-Control: no-store`.
- Errors use `{ error: { code, message } }`: `INVALID_INPUT` (400), `ALREADY_IN_QUEUE` (409), `NO_ACTIVE_DEVICE` (503), `RATE_LIMITED` (429), `UPSTREAM_ERROR` (502), or `INTERNAL_ERROR` (500).

## Development

Run the project gate:

```sh
npm run lint && npm run typecheck && npm test
```

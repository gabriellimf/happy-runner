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

## API

- `GET /api/search?q=<query>` accepts 4 to 100 characters and returns `{ items: Track[] }`, where `Track` is `{ id, uri, title, artists: string[], coverUrl: string | null, durationMs }`.
- `POST /api/queue` accepts `{ uri: "spotify:track:..." }` and returns `{ ok: true }`.
- `GET /api/queue` returns `{ nowPlaying: QueueTrack | null, next: QueueTrack[] }`, where `QueueTrack` is `{ id, title, artists: string[], coverUrl: string | null }`. It sets `Cache-Control: no-store`.
- Errors use `{ error: { code, message } }`: `INVALID_INPUT` (400), `NO_ACTIVE_DEVICE` (503), `RATE_LIMITED` (429), `UPSTREAM_ERROR` (502), or `INTERNAL_ERROR` (500).

## Development

Run the project gate:

```sh
npm run lint && npm run typecheck && npm test
```

# Happy Runner: spec

## Goal

A mobile web page. A guest scans a QR code, types a song name, and the song is added to the owner's Spotify queue. The owner runs with a Bluetooth speaker connected to the phone. The Spotify app on the owner's phone plays the audio.

## Decisions (settled)

- Spotify only. No YouTube, no YouTube Music.
- The site does not play audio. It only calls the Spotify Web API.
- Guests do not log in. Only the owner authenticates, once.
- Stack: Next.js (TypeScript), Tailwind, hosted on Vercel.
- UI language: Portuguese (BR). Search uses `market=BR`.
- Visual: dark theme, mobile-first, large input at the top, results with cover art.
- No per-user limit, no admin page, no database. The owner skips songs in the Spotify app.
- URL: default `*.vercel.app`. The QR code is a static PNG stored in the repository.

## Facts verified (Spotify docs, read on 2026-10-04)

- New apps start in development mode.
- The app owner must have Spotify Premium for a development mode app to work.
- Development mode has quota restrictions and a rate limit (30 s rolling window). The exact numbers are NOT observable in the docs read.
- Only users in the allowlist (max 5) can authenticate. The owner is the only authenticated user, so this is enough.
- Extended quota mode is for organizations only. Do not plan for it.

## Not verified. Test during implementation

1. Exact quota and rate limit of the development mode app.
2. Real response format of `GET /me/player/queue` (items from the owner's playlist or radio may be mixed with the added songs).
3. Behavior of "add to queue" when the Spotify app is in the background on the phone.
4. Details of the `add-to-queue` endpoint reference (page did not load).

## Architecture

```
Guest phone --> Next.js on Vercel (API routes) --> Spotify Web API
                         |
                refresh token in env var
                         |
              Owner phone: Spotify app (active device) --> Bluetooth speaker
```

### Auth

- One-time local script (`scripts/get-refresh-token.ts`) runs the Authorization Code flow.
- Scopes: `user-modify-playback-state`, `user-read-playback-state`.
- The refresh token is stored in the Vercel env var `SPOTIFY_REFRESH_TOKEN`.
- Other env vars: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`.
- The server exchanges the refresh token for an access token and caches it in memory until it expires.
- If the refresh token is revoked, the owner runs the script again.

### API routes (server side only)

| Route | Method | Spotify call | Notes |
|---|---|---|---|
| `/api/search?q=` | GET | `GET /v1/search?type=track&market=BR&limit=5` | Reject `q` shorter than 4 characters. Cache by normalized query in memory (short TTL). |
| `/api/queue` | POST | `POST /v1/me/player/queue?uri=` | Body: `{ uri }`. Maps Spotify errors to messages (see Errors). |
| `/api/queue` | GET | `GET /v1/me/player/queue` | Returns "now playing" plus next items. |

Never expose the access token or refresh token to the client.

## UI behavior

- One screen. Input at the top, auto-focus, large touch targets.
- Typing: debounce about 300 ms. Search starts at 4 characters or more. Show up to 5 suggestions with cover, title, and artist.
- Enter (or the add button) adds the first result. This is the main fast path.
- Tapping a suggestion adds that track.
- After a successful add: clear the input, show a short confirmation, refresh the queue.
- Below the input: "Tocando agora" and the next items. Poll `GET /api/queue` every about 5 s. Pause polling when the tab is hidden.
- Cancel the previous in-flight search when the user types again.

## Errors (guest-facing text in Portuguese)

| Case | Spotify signal | Message |
|---|---|---|
| No active device | 404 `NO_ACTIVE_DEVICE` | "Player offline, tente em instantes" |
| Rate limit or quota | 429 (honor `Retry-After`) | "Muita gente pedindo, tente de novo" |
| No search result | empty list | "Nenhuma música encontrada" |
| Other | 5xx or unknown | "Algo deu errado, tente de novo" |

Enter must keep working when suggestions fail.

## Out of scope (MVP)

- Per-person limits, duplicate blocking, explicit-content filter.
- Admin page, skip button, database, custom domain.
- YouTube or any other provider.

## Acceptance criteria

1. A guest on 4G opens the URL, types 4 or more characters, and sees suggestions.
2. Pressing Enter adds the first result to the owner's Spotify queue, and the song plays on the owner's phone.
3. The queue under the input shows the added song within about 5 s.
4. With the Spotify app closed, the guest sees the "Player offline" message.
5. No secret appears in the client bundle or network responses.
6. The page is usable at 360 px width, with no horizontal scroll.

## Setup checklist for the owner

1. Create an app in the Spotify Developer Dashboard. Set the redirect URI for the local script.
2. Run the token script. Copy the refresh token.
3. Set the three env vars on Vercel and deploy.
4. Generate the QR code PNG for the Vercel URL.
5. Before the run: open Spotify on the phone, start any song, connect the Bluetooth speaker.

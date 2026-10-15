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

## Facts verified (docs read 2026-10-04 and 2026-10-07; spike run 2026-10-07)

- New apps start in development mode.
- The app owner must have Spotify Premium for a development mode app to work.
- Development mode has quota restrictions and a rate limit (30 s rolling window). The exact numbers are NOT observable in the docs read.
- Only users in the allowlist (max 5) can authenticate. The owner is the only authenticated user, so this is enough.
- Extended quota mode is for organizations only. Do not plan for it.

### 1. Development-mode quota and rate limit

- Docs only (2026-10-07): Development-mode quota groups endpoints into shared buckets. Exceeding the quota returns HTTP 429 with reason `QUOTA_EXCEEDED`. The app-wide rate limit uses a rolling 30-second window. The numeric quota and rate limit are not stated in the docs read. [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), [Rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits).
- Probe `burst --yes` (2026-10-07): One account made 60 sequential `GET /v1/me/player/queue` calls in 21,808 ms. All returned 200. No 429 occurred; the probe stopped at its call cap. The recorded headers were `content-type`, `date`, and `server`. No `retry-after` or rate-limit header was recorded. The script records only allowlisted headers, so other headers were not observed. This does not establish the exact quota or rate limit.

### 2. User's queue response

- Docs only (2026-10-07): `GET /v1/me/player/queue` returns HTTP 200 with `currently_playing` and `queue`. Example queue items include track fields such as `type`, `uri`, and `name`. [Get the User's Queue](https://developer.spotify.com/documentation/web-api/reference/get-queue).
- Probe `queue` (2026-10-07): The two responses, recorded at 21:23:40 and 21:28:24 UTC, returned HTTP 200 with `currently_playing` and `queue`. `currently_playing` was a track. Each `queue` had 20 items. All items were tracks with `is_local: false` and the same 14 keys. No field marks an item as guest-added or shows its playback context. In the second sample, the two tracks added by the probe runs with notes `queue-mix-playlist-1` and `queue-mix-playlist-2` were in positions 1 and 2, in add order. The 20-item count is an observation from two samples, not a documented limit. The owner did not record the playback context type. Radio and autoplay were not tested (#6).

### 3. Add while the app is in the background or the screen is locked (partly verified)

- Probe `devices` (2026-10-07): The response had two devices. The `Computer` device was active and the `Speaker` device was inactive. The snapshot (21:23:40 UTC) listed a `Computer` (active) and a `Speaker` (inactive). It listed no phone device.
- Probe `add` with note `screen-locked` (2026-10-07): The owner reported that the audio was on the desktop Spotify app. The owner did not report the phone state in this run. The add returned HTTP 200, and the track appeared in the queue at 2 and 6 seconds. The owner reported that the track played after the current one. The 21:28:24 UTC queue sample showed it as `currently_playing`. The phone as the active device remains untested (#13).

### 4. Add Item to Playback Queue

- Docs only (2026-10-07): `POST /v1/me/player/queue` requires `uri`, which must identify a track or episode. `device_id` is optional; if omitted, Spotify targets the active device. The endpoint requires `user-modify-playback-state` and a Premium user. The docs specify HTTP 204 with no response body. The docs read did not describe a 404, `NO_ACTIVE_DEVICE`, or its error body. [Add Item to Playback Queue](https://developer.spotify.com/documentation/web-api/reference/add-to-queue).
- Probe `add` (2026-10-07): The owner's Premium account with `user-modify-playback-state` and `user-read-playback-state` returned HTTP 200 in all five calls. Each response body was a non-empty string of 27 characters. The body value is not recorded here. Recorded headers were only `date` and `server`; no `content-type` was recorded. Latency was 322 to 431 ms. Each added track appeared in the queue at both the 2-second and 6-second checks. It is not known whether the response body is valid JSON (#5).
- Probe `add` with note `app-closed` (2026-10-07): The owner closed Spotify on every device. The add returned HTTP 200, and the track appeared in both queue checks. The probe did not read devices immediately before the add, so the active-device state at that moment was not recorded. The 404 `NO_ACTIVE_DEVICE` response body was not observed (#13).

## Not verified. Still open after spike #3

1. The exact numeric development-mode quota and rate limit.
2. The phone as the active device while Spotify is in the background and the screen is locked (#13).
3. The 404 `NO_ACTIVE_DEVICE` error body (#13).
4. Whether radio or autoplay items mix with added songs (#6).
5. Whether the non-empty `POST /v1/me/player/queue` response body is valid JSON (#5).

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
| `/api/search?q=` | GET | `GET /v1/search?type=track&market=BR&limit=5` and `GET /v1/me/player/queue` | Reject `q` shorter than 4 characters. Cache the search by normalized query in memory (short TTL). The queue read is not cached. It marks results that are already in the queue (`inQueue`). |
| `/api/queue` | POST | `GET /v1/me/player/queue`, then `POST /v1/me/player/queue?uri=` | Body: `{ uri }`. Returns 409 `ALREADY_IN_QUEUE` when the track id is playing or queued. If the queue read fails, the add goes on. Maps Spotify errors to messages (see Errors). |
| `/api/queue` | GET | `GET /v1/me/player/queue` | Returns "now playing" plus next items. |

Never expose the access token or refresh token to the client.

## UI behavior

- One screen. Input at the top, auto-focus, large touch targets.
- Typing: debounce about 300 ms. Search starts at 4 characters or more. Show up to 5 suggestions with cover, title, and artist.
- Enter (or the add button) adds the first result. This is the main fast path.
- Tapping a suggestion adds that track.
- A suggestion that is already in the queue shows the badge "Já na fila". One that is another version of a queued song shows "Versão na fila". On Enter, a "Versão na fila" track is not added and a hint explains why. Tapping it adds it.
- After a successful add: clear the input, show a short confirmation, refresh the queue.
- Below the input: "Tocando agora" and the next items. Poll `GET /api/queue` every about 5 s. Pause polling when the tab is hidden.
- Cancel the previous in-flight search when the user types again.

## Errors (guest-facing text in Portuguese)

| Case | Spotify signal | Message |
|---|---|---|
| No active device | 404 `NO_ACTIVE_DEVICE` | "Player offline, tente em instantes" |
| Rate limit or quota | 429 (honor `Retry-After`) | "Muita gente pedindo, tente de novo" |
| No search result | empty list | "Nenhuma música encontrada" |
| Track already playing or queued | server check, 409 `ALREADY_IN_QUEUE` | "Essa música já está na fila" |
| Other | 5xx or unknown | "Algo deu errado, tente de novo" |

Note: Spike #3 did not reproduce the 404 `NO_ACTIVE_DEVICE` signal. `add` returned 200 with Spotify closed on every device. See #13.

Enter must keep working when suggestions fail.

## Out of scope (MVP)

- Per-person limits, explicit-content filter.
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

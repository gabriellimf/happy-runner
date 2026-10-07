# Issue #3 probe runbook

Run every command from the repository root. The script reads the Spotify
credentials from `.env.local`. It does not print them.

1. Baseline. Open Spotify on the phone, start a playlist, and keep the screen on.
   Run:

   ```sh
   node --env-file=.env.local scripts/spike-probe.ts devices
   node --env-file=.env.local scripts/spike-probe.ts queue
   ```

2. Add with the screen on. Keep Spotify open and playing. Run:

   ```sh
   node --env-file=.env.local scripts/spike-probe.ts add --query "<song>" --note screen-on
   ```

3. Add with the screen locked and Spotify in the background. Lock the phone,
   then run:

   ```sh
   node --env-file=.env.local scripts/spike-probe.ts add --query "<song>" --note screen-locked
   ```

   Unlock the phone after the probe. Record whether the song plays after the
   current one.

4. Check the queue mix. With a playlist playing, add two songs and save a queue
   sample:

   ```sh
   node --env-file=.env.local scripts/spike-probe.ts add --query "<first song>" --note queue-mix-playlist-1
   node --env-file=.env.local scripts/spike-probe.ts add --query "<second song>" --note queue-mix-playlist-2
   node --env-file=.env.local scripts/spike-probe.ts queue --save-sample
   ```

   Repeat these commands with radio or autoplay enabled if possible. Review
   `docs/samples/queue-response.json` before sharing it.

5. Check for no active device. Force-close Spotify on the phone and wait about
   one minute. Run:

   ```sh
   node --env-file=.env.local scripts/spike-probe.ts add --query "<song>" --note app-closed
   ```

6. Rate-limit probe. This step is optional. It sends up to 60 sequential queue
   requests for up to 30 seconds. A 429 response may lock the Spotify app for
   the `Retry-After` time. Run only if this risk is acceptable:

   ```sh
   node --env-file=.env.local scripts/spike-probe.ts burst --yes
   ```

Probe results are written under `spike-output/`. That directory is ignored by
Git. Do not share raw results before reviewing the redaction.

# YouTube live-stream enrichment

The home page shows a **Live Streams** card for the club's YouTube channel
(`@Wendovercclive`) with a "Now / Next" summary, mirroring the screen cards.
Frogbox match streams end up on this channel.

## How it works

1. **Build-time fetch** — `scripts/fetch_youtube_live.py` calls the YouTube
   Data API v3 (public, read-only) and writes
   `content/data/fetched/youtube_live.json`:
   - resolves the channel ID from the `handle` in the `youtube` entry of
     `content/config.json → homepage_cards`,
   - lists `live` and `upcoming` broadcasts, enriched with their scheduled
     start times (`videos.list` → `liveStreamingDetails`).
2. **Build** — `build.py` attaches that data to the YouTube card and embeds it
   in the home page.
3. **Render (client-side)** — the home page decides "Now / Next" relative to the
   viewer's clock:
   - **Now → Live** if the API reported a live stream at build, *or* a scheduled
     start has passed within a ~5-hour window (key-free intraday "Live" flip).
   - **Now → Off air** otherwise.
   - **Next** → the next future scheduled broadcast, with a friendly time.

The fetch never fails the build: if the key, channel, or feed is missing it logs
and exits cleanly, and the card falls back to "Off air".

## Setup (one-time)

The API key lives in *your own* Google Cloud project — it is **not** linked to
the YouTube channel and needs **no admin access** to it. Only public data is
read. No billing/subscription is required.

1. **console.cloud.google.com** → create a project (e.g. `wcc-slides`).
2. Enable the API: `console.cloud.google.com/apis/library/youtube.googleapis.com`
   → **Enable**.
3. Create the key: `console.cloud.google.com/apis/credentials` →
   **Create credentials → API key**.
4. (Recommended) Edit the key → **API restrictions → YouTube Data API v3**.
   Leave application restrictions as "None" (used server-side, not in a browser).
5. Store it:
   - **GitHub**: repo → Settings → Secrets and variables → Actions →
     `YOUTUBE_API_KEY`. The deploy workflow passes it to the fetch step.
   - **Local**: add `YOUTUBE_API_KEY=...` to `.env` (gitignored).

## Quota

YouTube Data API v3 gives **10,000 free units/day** (no billing needed). Each
build costs ~200 units (`channels.list` ≈ 1, two `search.list` ≈ 100 each, two
`videos.list` ≈ 1–2). Nightly build + pushes stay far under the limit; quota
resets daily (US Pacific). Hardcoding `channel_id` in `config.json` removes the
`channels.list` lookup if ever needed.

## Configuration

In `content/config.json → homepage_cards`:

```json
{ "type": "youtube", "title": "Live Streams", "url": "https://www.youtube.com/@Wendovercclive", "handle": "Wendovercclive" }
```

- `handle` — channel handle (without `@`); resolved to a channel ID at fetch time.
- `channel_id` — optional; set it to skip the handle lookup.

## Limitations

Only publicly visible broadcasts are returned. A purely ad-hoc live stream with
no scheduled start won't show as "Live" until the next build; scheduled
broadcasts are covered intraday by the client-side flip. For true real-time on
ad-hoc streams, a referrer-restricted browser key polling at runtime would be
needed (not currently implemented).

## Run it locally

```sh
python scripts/fetch_youtube_live.py   # writes content/data/fetched/youtube_live.json
python scripts/build.py
cd site && python -m http.server 8000  # open http://localhost:8000/
```

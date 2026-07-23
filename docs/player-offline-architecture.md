# Player Offline Architecture — preload & local-store, uniform across devices

> Status: **proposed design, not yet built.** Planning source of truth for
> rearchitecting the players to pre-download and locally store all slideshow assets
> before playback, under full app control, with **one code path on Pi, iPad and
> desktop**. Read `assets/js/player-core.js`, `templates/screen/player.html`,
> `templates/slides/video.html`, `docs/issue-video-cache.md` and
> `docs/raspberry-pi.md` alongside this.

## Problem

Incorporating video into slides surfaced three faults, all rooted in the same thing —
**we delegate caching to the browser's HTTP cache and rely on cache headers, with no
app-level control**:

1. **Repeated re-downloads consume the pavilion's restricted mobile data.** A large
   clip is re-fetched far more often than it should be.
2. **Poor playback when a clip hasn't downloaded in time** — a video slide reaches
   its slot before the file is buffered and shows a blank/stalled frame.
3. **No defined behaviour under connectivity loss.** The player has no visibility
   into what is stored and no policy for degraded networks.

### Two distinct root causes (this shapes the fix)

The re-download symptom is really two bugs:

- **Daily cold start.** The Pi's Chromium profile is `--user-data-dir=/tmp/chromium-kiosk`
  — on tmpfs, wiped on every nightly reboot (off 00:00, wake 09:00). Every morning
  starts with an empty cache.
- **Per-loop refetch** (the expensive one). Chromium's `SimpleCache` has a
  **per-entry size limit** (historically ~20–32 MB). An 80 MB clip in one cache
  entry may **never be stored**, so `--disk-cache-size=500MB` had no effect and
  every slideshow loop re-fetches.

The cure is to **stop using the HTTP cache for video at all**: the app downloads each
clip once, stores the whole file in the **Cache API**, and plays it back from local
bytes. This is not subject to the per-entry limit and is fully under app control.

## What already exists

- PWA scaffolding is in place but inert: `templates/manifest.webmanifest` and
  `templates/_pwa_head.html` (included by `screen/player.html`), icons from
  `build.py:build_pwa()`. **No service worker is registered anywhere** — and this
  design does not require one (see below).
- Videos are **content-addressed**: fingerprinted filenames on `videos.wendovercc.org`
  (R2 behind Cloudflare) with `Cache-Control: immutable` (`scripts/sync_videos.py`).
  A stored clip is never stale → **invalidation is a non-problem**; we only add new
  fingerprints and prune unreferenced ones.
- Site is static (GitHub Pages), rebuilt nightly + on push. The players consume
  `/screen/<loc>/`, `/slide/<slug>/`, `/slideshow/<slug>/data.json`,
  `/context_calendar.json`, `/locations.json`, `/assets/*`.
- The screen player creates **one same-origin iframe per slide**. Same-origin means a
  slide iframe can read the shared Cache Storage the player populated.

## Design goal

**Nothing plays until every asset it needs is downloaded and stored locally.** The
wall shows a branded *"Preparing slideshow…"* screen with progress, then cuts to a
fully-local, glitch-free rotation. Thereafter the app — not the HTTP cache — decides
when to refresh, and refreshes never interrupt playback or show half-loaded content.

**Simplicity is the constraint:** the *same* mechanism must run identically on the Pi
(Chromium), the bar iPad (Safari/WebKit) and any desktop/phone viewer. That rules out
anything with per-engine quirks.

---

## Core mechanism — fetch-to-Blob, play from an object URL

One idea makes the whole thing uniform: **the video element never touches the
network.** We download the whole clip, store it, and hand the element local bytes.

1. **Download.** The player `fetch()`es each clip to completion.
2. **Store.** It puts the response in the **Cache API** (`window.caches`, opened
   straight from the page — **no service worker needed**), keyed by the clip URL.
3. **Play.** When a video slide runs, it reads the stored response back as a `Blob`,
   creates `URL.createObjectURL(blob)`, and sets that as the `<video>` src.

Because the browser holds the *complete* file, it seeks locally — **no HTTP range
requests, no `206` negotiation, no streaming semantics.** That is exactly what
diverges between Chromium and WebKit when a service worker streams video from a cache,
so removing it removes the only cross-engine hazard. It also matches the loading-gate
model precisely: *download the whole thing, store it, then play.*

**No service worker anywhere in the core design.** `window.caches`, `fetch`, and
object URLs are all first-class on Chromium and WebKit alike. (A service worker
remains a *deferred, additive* option purely for offline of the small static shell —
see Deferred — but is not needed for the data or glitch fix.)

### Why Cache API rather than IndexedDB

Both store Blobs and both work on both engines; Cache API has the nicer ergonomics
(`cache.put(url, resp)` / `caches.match(url).then(r => r.blob())`) and a natural URL
key. IndexedDB is the fallback if the Cache API ever disappoints on iOS. The uniform
win comes from **object-URL playback**, not from which store holds the bytes.

---

## The loading gate

The centrepiece: a **hard preload gate**, page-driven, identical on every device.

### Flow

1. Player resolves the active slideshow (unchanged: `context_calendar.json` +
   `locations.json` → `slideshow/<slug>/data.json`).
2. It fetches the **precache manifest** for that slideshow (below): every clip URL,
   plus a `build_version`.
3. It shows the **loading screen** and, for each clip, `fetch()`es it and stores it in
   the Cache API — reporting progress (`done / total`, bytes) directly from the fetch
   sizes.
4. It creates the slide iframes **hidden** and waits for their `load` events (this
   warms the small same-origin shell assets — CSS/JS/fonts/crests — via the normal
   browser load path).
5. **Only when every clip is stored *and* every iframe has loaded** does it reveal the
   first slide and start rotation. A video slide reads its clip from the cache as a
   Blob and plays from an object URL, so playback is instant and never races the
   network.

### Loading screen

A branded view rendered by the screen player (navy/gold, Lato — the tokens in
`docs/design-conventions.md`), shown before any slide is revealed:

- Club logo, "Preparing slideshow" heading.
- A gold progress bar + `X / Y clips · N MB` readout.
- A soft status line that switches to *"Waiting for network…"* while fetches are
  failing, so a stalled prime is legible rather than a frozen bar.

### Failure policy (needs a decision — see Open decisions)

A pure "wait for **all** clips forever" gate risks a wall stuck on the loading screen
if one clip 404s or the link is down at boot. Recommended policy:

- **Shell + non-video slides are blocking** — they're small, same-origin, and the show
  will not start without them.
- **Video clips retry with backoff.** After a bounded number of attempts a failing
  clip's slide is **dropped from the rotation** (logged), so the show starts on time
  with whatever is stored rather than blocking indefinitely. A later refresh picks the
  clip up once the network recovers.

This keeps the spirit of "don't play until stored" (nothing half-loaded ever shows)
while guaranteeing the wall comes up.

### Precache manifest (build-time)

`build.py` emits, per slideshow, a `precache.json` next to `data.json`:

```jsonc
{
  "build_version": "2026-07-22T02:14:03Z",   // or short git sha
  "videos": ["https://videos.wendovercc.org/e5a318741ed0.mp4", …]
}
```

A build-time list (vs. runtime crawling) gives a deterministic denominator for the
progress bar and an exact prune set. The clip URLs are already known — they're the
`_video_src` values resolved in `build_video_slide()`.

---

## Cross-platform behaviour

The mechanism is intentionally the lowest-common-denominator, so behaviour is the same
everywhere:

| Target | fetch + Cache API + object-URL playback |
|---|---|
| **Pi 5 — Chromium** (the walls) | Full support, no caveats. Primary target. |
| **Bar iPad — Safari/WebKit** | Same code path. Plays from a resident Blob, so the WebKit range/`206` fragility never arises. |
| **Desktop / phone viewers** | Same code path on every evergreen browser. |

Two limits remain and they are **OS-level (iOS only), not API choices** — they'd apply
to Cache API or IndexedDB equally, and never affect the Chromium walls:

- **Per-origin storage quota.** Precaching several 80 MB clips can hit iOS's ceiling.
- **7-day eviction (ITP).** Safari wipes script-writable storage after 7 days without
  interaction with the site.

Mitigations, all already available:

- **Install the iPad player to the Home Screen** — the existing `manifest.webmanifest`
  makes it installable; Home-Screen PWAs are exempt from the 7-day wipe and get a
  larger quota.
- **Daily use resets** the eviction timer on an always-on display anyway.
- **Precache only what fits** per device — the walls carry the heavy reels; the iPad
  set can be scoped lighter if quota bites.

### Graceful degradation

Feature-detect `window.caches`, `fetch`, and object URLs. If any is missing, or the
prime times out, **fall back to today's behaviour** (direct network URL on the
`<video>`, HTTP cache) and skip the gate rather than hang. On the walls this path is
essentially never taken.

### Prerequisite: CORS on R2 — **DONE (2026-07-23)**

`fetch()`ing a clip for its bytes (and a progress-bar byte count) needs a readable,
non-opaque response. **CORS is enabled on the `videos.wendovercc.org` R2 bucket** with
the policy below — it covers the walls (and every viewer served from the site origin)
plus local dev. (A same-origin proxy is the fallback if that proves troublesome —
deferred; not needed.)

```jsonc
[
  {
    "AllowedOrigins": [
      "https://slides.wendovercc.org",   // walls + all site-origin viewers
      "http://localhost:8000"            // local `python3 -m http.server` testing
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length"], // so prime() can read the progress byte count
    "MaxAgeSeconds": 3600
  }
]
```

The player fetches with `credentials: 'omit'`, so an exact-origin (or `*`) match is
sufficient. Verify with
`curl -sI -H "Origin: https://slides.wendovercc.org" <clip-url> | grep -i access-control`.

### Object-URL hygiene

Create the object URL when a clip becomes active (optionally one ahead) and
`URL.revokeObjectURL()` when done, so many large Blobs aren't pinned at once.

---

## Pi prerequisite (not optional)

Cache Storage lives inside the Chromium profile, exactly like the HTTP cache. While
that profile is on `/tmp` it is wiped nightly and we re-prime every morning. **Move
`--user-data-dir` to the SD card** (`/home/pi/.chromium-kiosk`) so stored clips survive
reboots. Content is immutable + fingerprinted, so churn — and SD write wear — is
minimal. `docs/raspberry-pi.md` Step 5 changes with it.

---

## Intelligent refresh (replaces blind reload)

Today: `refresh_interval_seconds` → `location.reload()`, which re-fetches everything
and races the cache. Replace with app-controlled refresh, still page-driven:

1. Periodically fetch the small `precache.json` and compare `build_version`.
2. On change, **background-download** any new clips into the Cache API — playback
   continues off the stored set meanwhile.
3. **Swap at a cycle boundary** (the existing `shouldReloadNow` hook is the natural
   seam), then prune superseded cache entries and revoke their object URLs.

Updates never interrupt playback and never show half-loaded content — fully decoupled
from HTTP cache headers.

---

## Phasing

Ordered so each phase ships independently and de-risks the next.

| Phase | Scope | Ships |
|-------|-------|-------|
| **0** | Move Pi `--user-data-dir` to SD card; confirm R2 headers via `curl` from a Pi; enable **R2 CORS**. No app code. | Kills the daily cold start immediately; validates the cache hypothesis; unblocks the fetch route. **R2 CORS DONE (2026-07-23); Pi `--user-data-dir` move + Pi `curl` confirmation still pending.** |
| **1** | `build.py` emits `precache.json`; player fetch-to-Cache-API of all clips; video slides play from an object URL (fall back to network URL on miss). **Built 2026-07-23 (`scripts/build.py`, `assets/js/video-cache.js`, both players, `slides/video.html`); runtime-verified pending a browser test with CORS live.** | No re-downloads, no un-primed playback — the core fix. |
| **2** | The **loading gate** + branded progress screen; iframes loaded hidden; rotation starts only when all clips stored *and* iframes loaded; per-clip failure policy. **Built 2026-07-23. Shared module `assets/js/preload-gate.js` (`WccPreloadGate.run`, self-injecting styles) + `primeWithRetry` in `video-cache.js`; wired into BOTH players (`screen/player.html` = walls, `slideshow/player.html` = interactive iPad), same code path. Failure policy = recommended one (Open decision 1): non-video/shell blocking, video clips retry with backoff then their slide is dropped; never blanks the show; 120 s absolute cap. Preview + no-cache browsers keep the ungated path.** | The "Preparing slideshow" experience the walls show. |
| **3** | Version-stamped background download + cache swap at cycle boundary; prune superseded clips. **Built 2026-07-23. Shared `assets/js/refresh.js` (`WccRefresh.start`): polls `precache.json` (`cache:'no-store'`) at the refresh interval, and on a `build_version` change background-downloads the added clips, then arms a swap. `player-core.js` reload seam now calls `opts.onReload` (prune superseded clips via `WccVideoCache.evict`, then `location.reload()`) instead of a bare reload. Wired into both players' watch paths; PREVIEW keeps the blind countdown + ticker. Pruning is the old→new clip diff for the slideshow (won't touch other contexts' clips). Crucially the reload still fires on a schedule advance (not only on a rebuild): `alsoReloadIf` re-resolves the calendar against the wall clock and compares the shown-slide signature, so the wall follows context/phase/expiry transitions exactly as the old blind reload did — it just no longer reloads when nothing changed.** | App-controlled refresh; blind reload retired. |

### Deferred (non-blocking)

- **Service worker for the static shell** — additive offline-resilience for the
  small same-origin assets (HTML/CSS/JS/fonts/crests). Not needed for the data or
  glitch fix; only helps a fully-offline cold load. Video never goes near it.
- OS-level systemd prefetch → localhost as a Pi-only belt-and-braces net.
- Same-origin video proxy (if R2 CORS proves troublesome).
- Cache-hit / bytes-saved telemetry in the preview `#dbg` panel.
- **Suppress hidden-iframe playback during the gate.** Behind the Phase 2 loading
  screen the slide `<video>`s still auto-play, so on a *cold* cache they briefly
  fetch their network `<source>` in parallel with the prime — a one-time
  double-fetch on first boot only (a warm cache resolves object URLs and aborts the
  network preload, and Phase 0 SD persistence makes warm the normal case). Fix by
  holding the slides idle (`preload="none"` / paused) until the gate opens.

### Rejected

- **Service worker streaming video from a cache.** Requires synthesising `206`
  partial responses to satisfy WebKit's media loader — a per-engine code path and the
  exact source of Pi-vs-iPad divergence. The fetch-to-Blob route avoids it entirely.

---

## Open decisions

1. **Loading-gate failure policy** — block on *all* clips, or block on shell +
   non-video slides and drop failing video slides after bounded retries
   (recommended). Determines whether the wall can ever be stuck on "Preparing".
2. **Pi profile persistence** — move `--user-data-dir` to SD card (recommended;
   required for the savings; churn is tiny) vs keep nightly-fresh.
3. **iPad quota strategy** — same full precache as the walls (simplest; fine if it
   fits) vs a scoped-lighter set if iOS quota bites.

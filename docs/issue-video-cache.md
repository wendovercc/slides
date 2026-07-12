# Issue: Video slide re-downloads on every slideshow loop

## Symptom

The ~80 MB video clip (hosted on Cloudflare R2) is re-fetched from the network on every loop of the slideshow rather than being served from Chromium's disk cache. This is visible as continuous mobile data consumption on the pavilion router.

## Fixes already tried — neither resolved it

### 1. Increase Chromium disk cache size (commit `8a91079`)

Added `--disk-cache-size=524288000` to the Chromium launch flags in `~/.bash_profile`, raising the disk cache from the default 80 MB to 500 MB. The expectation was that the video would fit in cache between slideshow loops.

### 2. Immutable cache headers on R2 uploads (commit `0e02f6d`)

Set `Cache-Control: public, max-age=31536000, immutable` on all R2 video objects in `scripts/sync_videos.py`. Fingerprinted filenames make this safe.

## Likely root causes to investigate

**The cache location is `/tmp/`.**  
Chromium is launched with `--user-data-dir=/tmp/chromium-kiosk`. On Raspberry Pi OS, `/tmp` is commonly a `tmpfs` mount with a fixed size (often 50% of RAM, so ~2 GB on a 4 GB Pi 5 — large enough — but worth confirming with `df -h /tmp`). The cache within that dir is real but volatile: it is destroyed on every reboot, so the first loop after each 09:00 wake-up always downloads the video cold. That alone explains why the Pi counts network traffic daily even if intra-session caching works.

**Video range requests may not be cached.**  
Browsers fetch video via HTTP range requests (`Range: bytes=…`). Chromium's disk cache does support range request caching, but only if the server returns a proper `ETag` or `Last-Modified` alongside the `Content-Range` response. Check whether R2 returns these headers:

```
curl -I -H "Range: bytes=0-1048575" <video-url>
```

If the response is missing `ETag` / `Last-Modified`, or includes `Vary: *`, Chromium will not cache the range responses and will re-fetch every time.

**Cloudflare CDN layer may be overriding cache headers.**  
The `Cache-Control: immutable` is set on the R2 object, but if a Cloudflare CDN rule or Transform Rule sits in front and rewrites headers, the browser may receive different directives. Confirm the actual headers reaching the browser with the `curl -I` command above from a Pi SSH session.

**Per-item size limit in Chromium's disk cache.**  
Chromium's `SimpleCache` backend has a per-entry size limit (historically ~32 MB for the HTTP cache). An 80 MB video in a single cache entry may exceed this limit regardless of the total cache size. In that case, the disk cache never stores the video and every play is a fresh network fetch. This would explain why `--disk-cache-size` had no effect.

## Approaches to try next

1. **Confirm headers from the Pi** — SSH in and run:
   ```bash
   curl -I -H "Range: bytes=0-1048575" "$(cat ~/.kiosk_url | xargs curl -s | grep -o 'https://[^"]*\.mp4' | head -1)"
   ```
   (Or grab the video URL from the built slide HTML and curl it directly.)

2. **Move cache to persistent storage** — Replace `/tmp/chromium-kiosk` with a path on the SD card (e.g. `/home/pi/.chromium-kiosk`). This survives reboots, so the video only downloads once ever (until the fingerprint changes):
   ```bash
   # In ~/.bash_profile, change:
   --user-data-dir=/home/pi/.chromium-kiosk \
   ```
   Tradeoff: SD card write wear from cache churn. For a kiosk that reboots nightly this is probably acceptable.

3. **Pre-fetch the video to local disk** — A systemd oneshot service on boot could `curl` the video URL into a local file, and the slide HTML could point to `http://localhost:PORT/video.mp4` served by a tiny local HTTP server (or the kiosk-control server could serve it as a static route). This completely bypasses Chromium's HTTP cache and guarantees one download per content change.

4. **Serve via Service Worker** — Register a service worker in the screen player that intercepts video fetch requests and caches them in the Cache API. The Cache API is not subject to the `SimpleCache` per-entry limit and would survive across reloads. This requires changes to the screen player JS.

5. **Check Chromium's per-entry limit** — Launch Chromium with `--enable-logging --v=1` temporarily and check `~/.chromium-kiosk/chrome_debug.log` for cache miss/skip entries related to the video URL.

## Related files

- `~/.bash_profile` on each Pi — Chromium launch flags including `--disk-cache-size`
- `scripts/sync_videos.py` — sets `CacheControl` on R2 uploads
- `templates/slides/video.html` — `<video preload="auto">` element; `ended` event drives slideshow advance
- `docs/raspberry-pi.md` — Step 5 (kiosk startup) and Troubleshooting table

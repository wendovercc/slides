/* hls-cache.js — first-play caching for the live innings-reel HLS clips.
 *
 * The live-match reel plays Frogbox highlight clips as HLS (.m3u8 + .ts segments)
 * through hls.js. Unlike the R2 last-match clips (single MP4s primed up-front by
 * WccVideoCache + the preload gate), these are discovered at RUNTIME from the live
 * feed and can't be pre-primed — so without this they re-download every rotation,
 * burning the pavilion SIM. This caches each clip's playlist AND segments in the
 * Cache API on first play, keyed by URL, and serves them from local bytes forever
 * after. Frogbox segment URLs are stable + un-tokenised + CORS-open, so caching by
 * URL is safe (a cached clip replays with zero network).
 *
 * Separate store from WccVideoCache ('wcc-video-v1'): the R2 clips are pruned by a
 * build-time precache manifest, whereas these are ephemeral per-match-day clips
 * with no manifest — a distinct cache ('wcc-hls-v1') keeps the two lifecycles from
 * treading on each other, and lets this one self-bound by a simple entry cap.
 *
 * Usage (in the live-match slide, after hls.min.js):
 *   var opts = { enableWorker: true, lowLatencyMode: false };
 *   var L = window.WccHlsCache && WccHlsCache.loader();   // null if unsupported
 *   if (L) opts.loader = L;
 *   new Hls(opts);
 * Falls back to hls.js's default network loader wherever the Cache API is missing,
 * so nothing hangs and playback is unchanged — just uncached.
 */
(function () {
  var CACHE_NAME = 'wcc-hls-v1';
  // Soft FIFO cap on cached entries (playlists + segments + per-clip markers). A
  // trimmed highlight is ~1 playlist + ~5 segments + 1 marker ≈ 7 entries / ~8 MB,
  // so this holds roughly a match day's reels. Cache.keys() is insertion order, so
  // trimming the front drops the oldest first.
  var MAX_ENTRIES = 700;
  var FETCH_TIMEOUT_MS = 20000;   // per prefetch request

  var SUPPORTED =
    typeof window !== 'undefined' &&
    'caches' in window &&
    typeof window.fetch === 'function';

  function openCache() { return window.caches.open(CACHE_NAME); }

  // Canonical cache key for a URL: drop volatile query params. The highlight embed
  // URL carries a per-request `dt` timestamp + `utm_*` tracking that can vary
  // between feed polls, so keying by it verbatim would miss on replay. Stripping
  // them makes the SAME clip key identically every time — the loader and the
  // prefetcher agree, and a replay is a pure cache hit (zero network) even when the
  // feed hands us a freshly-stamped URL. Segment URLs carry no query → no-op there.
  function canonicalUrl(url) {
    try {
      var u = new URL(url, window.location.href);
      var keep = new URLSearchParams();
      u.searchParams.forEach(function (v, k) {
        if (k === 'dt' || k.indexOf('utm_') === 0) return;
        keep.append(k, v);
      });
      u.search = keep.toString() ? '?' + keep.toString() : '';
      u.hash = '';
      return u.href;
    } catch (e) { return url; }
  }

  // Cache key for a loader request: the canonical URL, plus a synthetic range suffix
  // ONLY for a genuine sub-range (positive end). hls.js requests whole segments as
  // an open-ended "bytes=0-" (rangeStart=0, no real end), which must key IDENTICALLY
  // to the prefetcher's whole-file store — otherwise a prefetched segment is never
  // hit and re-downloads on first play. A real byte-range (EXT-X-BYTERANGE / init
  // segment, rangeEnd>0) still gets a distinct key. (The Cache API strips the URL
  // fragment, so the range can't live in #.) Never fetched — the real network fetch
  // uses context.url with its Range header.
  function cacheKey(context) {
    var url = canonicalUrl(context.url);
    var re = context.rangeEnd;
    if (re == null || re <= 0) return url;
    var sep = url.indexOf('?') < 0 ? '?' : '&';
    return url + sep + '__wcchls_range=' + (context.rangeStart || 0) + '-' + re;
  }

  // Read a cached entry as the type hls.js asked for (string for playlists, an
  // ArrayBuffer for segments). Resolves null on any miss/error → caller falls back
  // to the network path.
  function readCache(key, wantBuffer) {
    if (!SUPPORTED) return Promise.resolve(null);
    return openCache().then(function (cache) {
      return cache.match(key).then(function (resp) {
        if (!resp) return null;
        return wantBuffer ? resp.arrayBuffer() : resp.text();
      });
    }).catch(function () { return null; });
  }

  // Synchronous copy of a fetched body, so caching it can't be corrupted by hls.js
  // transferring (detaching) the segment ArrayBuffer to its demux worker right after
  // onSuccess — our cache write is async, so without this copy it would read a
  // detached (empty) buffer and store nothing → every loop re-downloads. Strings
  // (playlists) aren't transferred, so they pass through as-is.
  function snapshot(data) {
    if (data instanceof ArrayBuffer) return data.slice(0);
    if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return data;
  }

  // Store a fetched body (string or ArrayBuffer) under its key, then trim the store
  // back under the cap. Never throws — a quota failure just leaves the clip uncached.
  function writeCache(key, data) {
    if (!SUPPORTED || data == null) return;
    openCache().then(function (cache) {
      return cache.put(key, new Response(data)).then(function () { return trim(cache); });
    }).catch(function () {});
  }

  function trim(cache) {
    return cache.keys().then(function (keys) {
      if (keys.length <= MAX_ENTRIES) return;
      var overflow = keys.slice(0, keys.length - MAX_ENTRIES);
      return Promise.all(overflow.map(function (req) { return cache.delete(req); }));
    }).catch(function () {});
  }

  // ---- proactive prefetch (download a whole clip before it's ever shown) ----
  // The loader above caches lazily as hls.js plays, so a clip's FIRST showing still
  // streams from network. prefetch() instead pulls a clip's playlist + every segment
  // into the cache off-screen and writes a completion marker listing what it stored.
  // The live-match slide gates a reel on this, so the user only ever sees cache-
  // backed (instant, offline) playback — never the first-play network stream.
  function markerKey(id) { return 'https://wcchls-marker/' + encodeURIComponent(id); }

  // Absolute segment URLs from a playlist body (non-tag, non-blank lines), resolved
  // against the playlist URL exactly as hls.js resolves them.
  function segmentUrls(text, playlistUrl) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line || line.charAt(0) === '#') return;
      try { out.push(new URL(line, playlistUrl).href); } catch (e) {}
    });
    return out;
  }

  function fetchOnce(url, asText) {
    if (!SUPPORTED) return Promise.resolve(null);
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT_MS) : null;
    return window.fetch(url, { mode: 'cors', credentials: 'omit', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) return null;
        return asText ? r.text() : r.arrayBuffer();
      })
      .catch(function () { if (timer) clearTimeout(timer); return null; });
  }
  function fetchRetry(url, asText, attempts) {
    attempts = attempts || 3;
    return fetchOnce(url, asText).then(function (body) {
      if (body != null || attempts <= 1) return body;
      return new Promise(function (res) { setTimeout(res, 800); }).then(function () { return fetchRetry(url, asText, attempts - 1); });
    });
  }

  // True iff a clip's marker exists AND every key it listed is still cached (a
  // segment could since have been evicted by the FIFO trim). Reload- + eviction-safe.
  function verifyReady(cache, mid) {
    return cache.match(markerKey(mid)).then(function (m) {
      if (!m) return false;
      return m.json().then(function (rec) {
        var keys = (rec && rec.keys) || [];
        if (!keys.length) return false;
        return Promise.all(keys.map(function (k) { return cache.match(k); }))
          .then(function (rs) { return rs.every(function (r) { return !!r; }); });
      }).catch(function () { return false; });
    }).catch(function () { return false; });
  }

  // Download + store a clip whole (playlist + all segments), SERIALLY (a stampede of
  // parallel fetches just fights itself on a thin link), then write the completion
  // marker. Resolves true only if everything stored; any failure resolves false (the
  // clip stays un-marked → not revealed → retried on a later feed). `id` keys the
  // marker so readiness is stable across the URL's changing `dt`. Idempotent: a clip
  // already fully cached resolves true without re-downloading.
  function prefetch(url, id) {
    if (!SUPPORTED || !url) return Promise.resolve(false);
    var mid = String(id != null ? id : canonicalUrl(url));
    return openCache().then(function (cache) {
      return verifyReady(cache, mid).then(function (ready) {
        if (ready) return true;
        return fetchRetry(url, true).then(function (text) {
          if (text == null) return false;
          var pKey = canonicalUrl(url);
          var keys = [pKey];
          return cache.put(pKey, new Response(text, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }))
            .then(function () {
              return segmentUrls(text, url).reduce(function (chain, segUrl) {
                return chain.then(function (okSoFar) {
                  if (!okSoFar) return false;
                  var sKey = canonicalUrl(segUrl);
                  return cache.match(sKey).then(function (hit) {
                    if (hit) { keys.push(sKey); return true; }
                    return fetchRetry(segUrl, false).then(function (buf) {
                      if (!buf || !buf.byteLength) return false;
                      return cache.put(sKey, new Response(buf)).then(function () { keys.push(sKey); return true; });
                    });
                  });
                });
              }, Promise.resolve(true));
            })
            .then(function (allOk) {
              if (!allOk) return false;
              return cache.put(markerKey(mid), new Response(JSON.stringify({ keys: keys }), { headers: { 'Content-Type': 'application/json' } }))
                .then(function () { return trim(cache); })
                .then(function () { return true; });
            });
        });
      });
    }).catch(function () { return false; });
  }

  // Is this clip fully cached right now? (Cheap gate check — never kicks a download.)
  function isReady(url, id) {
    if (!SUPPORTED) return Promise.resolve(false);
    var mid = String(id != null ? id : canonicalUrl(url));
    return openCache().then(function (cache) { return verifyReady(cache, mid); }).catch(function () { return false; });
  }

  // Build the hls.js loader class lazily — it extends the default loader, so hls.js
  // must be loaded first. Cached once. Returns null when unsupported (or no Hls),
  // so the caller leaves hls.js on its default network loader.
  var LoaderClass = null;
  function loader() {
    if (!SUPPORTED || typeof window.Hls === 'undefined') return null;
    if (LoaderClass) return LoaderClass;

    var Base = window.Hls.DefaultConfig.loader;

    // `class extends Base` works whether hls.js ships the loader as an ES5 function
    // (1.5.x) or a native ES6 class — unlike a prototype/Base.call() shim, which an
    // ES6-class base would reject. All target browsers support class syntax.
    LoaderClass = class WccCacheLoader extends Base {
      constructor(config) {
        super(config);
        this._cancelled = false;
      }
      abort() { this._cancelled = true; super.abort(); }
      destroy() { this._cancelled = true; super.destroy(); }

      load(context, config, callbacks) {
        var rt = context.responseType;
        var wantBuffer = rt === 'arraybuffer';
        // Only playlists (text) and segments (arraybuffer) are cached; anything else
        // hls.js may ask for (e.g. 'json' content-steering) goes straight to network.
        var cacheable = wantBuffer || rt === 'text' || rt === '' || rt == null;
        if (!cacheable) { super.load(context, config, callbacks); return; }

        var self = this;
        var key = cacheKey(context);
        var url = context.url;
        var origSuccess = callbacks.onSuccess;

        // Arrow callback so `super.load` stays lexically bound to this method.
        readCache(key, wantBuffer).then((cached) => {
          if (self._cancelled) return;
          var hit = wantBuffer ? (cached && cached.byteLength > 0)
                               : (typeof cached === 'string' && cached.length > 0);
          if (hit) {
            // Cache hit: hand the bytes straight back with a synthetic, well-formed
            // stats object (the timings the default loader would have produced,
            // collapsed to "instant"). No network touched.
            var now = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
            var stats = self.stats;
            var len = wantBuffer ? cached.byteLength : cached.length;
            stats.loading.start = stats.loading.first = stats.loading.end = now;
            stats.loaded = stats.total = len;
            stats.aborted = false;
            origSuccess({ url: url, data: cached }, stats, context, null);
            return;
          }
          // Miss: let the default loader fetch it, and tee the bytes into the cache
          // on success before passing the response through unchanged. Snapshot the
          // body SYNCHRONOUSLY here — origSuccess (next line) can hand the buffer to
          // hls.js, which transfers/detaches it before our async cache write reads it.
          callbacks.onSuccess = function (response, stats, ctx, networkDetails) {
            try { writeCache(key, snapshot(response.data)); } catch (e) {}
            origSuccess(response, stats, ctx, networkDetails);
          };
          super.load(context, config, callbacks);
        });
      }
    };
    return LoaderClass;
  }

  window.WccHlsCache = { supported: SUPPORTED, cacheName: CACHE_NAME, loader: loader, prefetch: prefetch, isReady: isReady };
})();

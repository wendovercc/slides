/* video-cache.js — app-controlled local store for slideshow video clips.
 *
 * The browser's HTTP cache can't be relied on for video: Chromium's SimpleCache
 * has a per-entry size limit an 80 MB clip blows past, so clips re-download every
 * loop and burn the pavilion's mobile data. This module takes video out of the
 * HTTP cache entirely — it fetches each clip once into the Cache API and plays it
 * back from local bytes via an object URL. No service worker: window.caches,
 * fetch and object URLs are all first-class on Chromium and WebKit alike, so this
 * is one code path on the Pi walls, the bar iPad and any desktop viewer.
 * See docs/player-offline-architecture.md.
 *
 * Two roles, same origin so they share one Cache Storage:
 *   - the player primes the whole precache set  → WccVideoCache.prime(urls, onProgress)
 *   - each video slide reads its clips back      → WccVideoCache.getObjectURL(url)
 *
 * Everything degrades to null / no-op when the APIs are missing or a clip isn't
 * stored yet, so callers fall back to the plain network URL and nothing hangs.
 */
(function () {
  var CACHE_NAME = 'wcc-video-v1';

  // Feature-detect the whole path up front. Cross-origin fetch of clip bytes also
  // needs CORS on the video host (a readable, non-opaque response) — without it the
  // fetch below rejects and we simply fall back to the network URL on the <source>.
  var SUPPORTED =
    typeof window !== 'undefined' &&
    'caches' in window &&
    typeof window.fetch === 'function' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function';

  function openCache() { return window.caches.open(CACHE_NAME); }

  /* Fetch every URL not already stored and put it in the Cache API, in order, so
   * the progress denominator is deterministic. Reports { done, total, bytes,
   * failed } after each clip. Never throws — a failed clip is counted and left for
   * a later retry (the slide falls back to its network URL meanwhile). */
  function prime(urls, onProgress) {
    urls = urls || [];
    if (!SUPPORTED || urls.length === 0) {
      if (onProgress) onProgress({ done: 0, total: urls.length, bytes: 0, failed: 0 });
      return Promise.resolve({ ok: !urls.length, stored: 0, failed: urls.length });
    }
    return openCache().then(function (cache) {
      var done = 0, bytes = 0, failed = 0, stored = 0;
      // Serial, not parallel: on the pavilion's thin link a stampede of 80 MB
      // fetches just fights itself. One clip at a time keeps progress legible.
      return urls.reduce(function (chain, url) {
        return chain.then(function () {
          return cache.match(url).then(function (hit) {
            if (hit) { bytes += contentLength(hit); stored++; return; }
            return fetch(url, { mode: 'cors', credentials: 'omit' }).then(function (resp) {
              if (!resp || !resp.ok) { failed++; return; }
              bytes += contentLength(resp);
              stored++;
              return cache.put(url, resp);
            });
          }).catch(function () { failed++; });
        }).then(function () {
          done++;
          if (onProgress) onProgress({ done: done, total: urls.length, bytes: bytes, failed: failed });
        });
      }, Promise.resolve()).then(function () {
        return { ok: failed === 0, stored: stored, failed: failed };
      });
    }).catch(function () {
      return { ok: false, stored: 0, failed: urls.length };
    });
  }

  function contentLength(resp) {
    var n = parseInt(resp.headers.get('content-length'), 10);
    return isNaN(n) ? 0 : n;
  }

  /* Read a stored clip back as a fresh object URL, or null if it isn't cached (or
   * the store is unusable, or the response is opaque → zero-length blob, which
   * means CORS wasn't honoured and the bytes aren't readable). Callers own the
   * returned URL and must revokeObjectURL() it when the clip is no longer on
   * screen — see the object-URL hygiene note in the design doc. */
  function getObjectURL(url) {
    if (!SUPPORTED || !url) return Promise.resolve(null);
    return openCache().then(function (cache) {
      return cache.match(url);
    }).then(function (resp) {
      if (!resp) return null;
      return resp.blob();
    }).then(function (blob) {
      if (!blob || !blob.size) return null;   // miss, or opaque/unreadable
      return URL.createObjectURL(blob);
    }).catch(function () { return null; });
  }

  window.WccVideoCache = {
    supported: SUPPORTED,
    cacheName: CACHE_NAME,
    prime: prime,
    getObjectURL: getObjectURL
  };
})();

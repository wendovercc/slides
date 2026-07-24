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
 *   - the player primes the precache set   → WccVideoCache.prime(...) / primeWithRetry(...)
 *   - each video slide reads its clips back → WccVideoCache.getObjectURL(url)
 *
 * Everything degrades to null / no-op when the APIs are missing or a clip isn't
 * stored yet, so callers fall back to the plain network URL and nothing hangs.
 */
(function () {
  var CACHE_NAME = 'wcc-video-v1';
  // Clips are downloaded in byte-range CHUNKs, not one long fetch: a large clip
  // streamed whole over a thin link gets its body reset mid-transfer, and Cache.put()
  // of that live stream then throws NetworkError — whereas small ranges behave like
  // the small clips that cache cleanly. We assemble the ranges into one Blob and store
  // that (from memory, decoupled from the live connection). FETCH_TIMEOUT_MS bounds
  // each CHUNK, so a stalled range aborts instead of wedging the prime.
  var CHUNK_BYTES = 8 * 1024 * 1024;
  var FETCH_TIMEOUT_MS = 20000;

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

  function contentLength(resp) {
    var n = parseInt(resp.headers.get('content-length'), 10);
    return isNaN(n) ? 0 : n;
  }

  // Total clip size from a 206's Content-Range ("bytes 0-8388607/12345678" → 12345678),
  // so we know the whole-clip size from the first chunk and can drive a byte-accurate
  // progress bar. 0 when absent/unparseable (the bar then just shows clip-count steps).
  function contentRangeTotal(resp) {
    var cr = resp.headers.get('content-range');
    var m = cr && /\/(\d+)\s*$/.exec(cr);
    return m ? parseInt(m[1], 10) : 0;
  }

  /* Store one clip if not already present. Resolves { ok, bytes } and never
   * rejects — a network/CORS/timeout failure is reported as { ok:false }. onBytes,
   * if given, is called as the clip streams in with (bytesSoFar, clipTotalOrNull) for
   * a smooth loading bar. */
  function storeOne(cache, url, onBytes) {
    return cache.match(url).then(function (hit) {
      if (hit) return { ok: true, bytes: contentLength(hit) };
      return downloadChunked(url, onBytes).then(function (blob) {
        if (!blob || !blob.size) return { ok: false, bytes: 0 };
        // Store the assembled bytes as a fresh in-memory Response, not a live network
        // stream — that decoupling is what makes Cache.put() reliable for big clips.
        var resp = new Response(blob, { headers: {
          'Content-Type': blob.type || 'video/mp4',
          'Content-Length': String(blob.size)
        } });
        return cache.put(url, resp)
          .then(function () { return { ok: true, bytes: blob.size }; })
          .catch(function () { return { ok: false, bytes: 0 }; });
      });
    }).catch(function () { return { ok: false, bytes: 0 }; });
  }

  // Partial-download progress kept ACROSS retries, keyed by url: the already-fetched
  // ranges, the next byte offset, and the clip's total size (from Content-Range). A
  // failed chunk leaves this in place so the retry resumes from where it stopped instead
  // of re-pulling the whole clip from byte 0 — the difference between eventually caching
  // an 80 MB clip and never finishing it on a flaky SIM. Cleared on full assembly (done()).
  var partial = {};

  // Read a response body incrementally so a big chunk reports byte progress as it
  // arrives (a smooth loading bar) instead of landing all at once. onProgress(bytesSoFar)
  // fires per stream read. Resolves { parts:[Uint8Array…], length }. Falls back to a
  // single arrayBuffer() read where streams aren't exposed. We still buffer the whole
  // (≤ CHUNK_BYTES) chunk before committing it, so download reliability is unchanged.
  function readBody(resp, onProgress) {
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      return resp.arrayBuffer().then(function (buf) {
        var u = new Uint8Array(buf);
        if (u.byteLength) onProgress(u.byteLength);
        return { parts: u.byteLength ? [u] : [], length: u.byteLength };
      });
    }
    var reader = resp.body.getReader();
    var acc = [], len = 0;
    return (function pump() {
      return reader.read().then(function (r) {
        if (r.done) return { parts: acc, length: len };
        acc.push(r.value); len += r.value.byteLength; onProgress(len);
        return pump();
      });
    })();
  }

  /* Download a clip in sequential byte-range chunks and assemble one Blob. Each range
   * is short-lived (so it can't be reset like a long whole-file transfer) and carries
   * its own abort timeout. Resolves the Blob, or null on any chunk failure — the caller
   * then reports { ok:false } and the prime's retry loop tries the clip again, resuming
   * from the saved offset. If the server ignores Range (200 = whole file at once) we
   * take that as the last chunk. onBytes(bytesSoFar, clipTotal) streams progress up. */
  function downloadChunked(url, onBytes) {
    onBytes = onBytes || function () {};
    // Resume from any progress a previous (failed) pass left behind. parts is shared by
    // reference with the saved record, so in-place pushes keep it current; only the
    // primitives (start, total) need writing back to prog.
    var prog = partial[url] || (partial[url] = { parts: [], start: 0, total: 0 });
    var parts = prog.parts;
    var start = prog.start;
    var clipTotal = prog.total;
    function done() { delete partial[url]; return new Blob(parts, { type: 'video/mp4' }); }
    function next() {
      var ctl = ('AbortController' in window) ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT_MS) : null;
      return fetch(url, {
        mode: 'cors', credentials: 'omit',
        signal: ctl ? ctl.signal : undefined,
        headers: { 'Range': 'bytes=' + start + '-' + (start + CHUNK_BYTES - 1) }
      }).then(function (resp) {
        if (timer) clearTimeout(timer);
        if (resp.status === 416) return done();               // range past EOF (size a CHUNK multiple)
        if (resp.status !== 206 && resp.status !== 200) return null;   // keep `partial` for the retry
        // 200 = server ignored Range and is sending the WHOLE file. If we'd resumed, the
        // saved ranges are for a request it won't honour — drop them so we don't splice a
        // partial onto a full body. (A server that always 200s just starts clean anyway.)
        if (resp.status === 200 && start > 0) { parts.length = 0; start = 0; prog.start = 0; }
        if (!clipTotal) {
          clipTotal = (resp.status === 206) ? contentRangeTotal(resp) : contentLength(resp);
          prog.total = clipTotal;
        }
        var base = start;                     // committed floor for this chunk's byte report
        onBytes(base, clipTotal);
        return readBody(resp, function (soFar) { onBytes(base + soFar, clipTotal); })
          .then(function (chunk) {
            // Commit the whole chunk atomically — the resume pointer only advances once
            // the full chunk is in hand, so a stream that fails mid-chunk re-fetches that
            // chunk cleanly (its streamed bytes were UI-only, never persisted to start).
            if (chunk.length) {
              for (var k = 0; k < chunk.parts.length; k++) parts.push(chunk.parts[k]);
              start += chunk.length; prog.start = start;
            }
            // 200 = whole file in one response; a short chunk is the last one; otherwise
            // keep pulling the next range.
            if (resp.status === 200 || chunk.length < CHUNK_BYTES) return done();
            return next();
          });
      }).catch(function () { if (timer) clearTimeout(timer); return null; });   // keep `partial` for the retry
    }
    return next();
  }

  /* One serial pass over urls. Serial, not parallel: on the pavilion's thin link a
   * stampede of 80 MB fetches just fights itself. Reports { done, total, bytes,
   * failed } after each clip. Never throws. */
  function prime(urls, onProgress) {
    urls = urls || [];
    onProgress = onProgress || function () {};
    if (!SUPPORTED || urls.length === 0) {
      onProgress({ done: 0, total: urls.length, bytes: 0, failed: 0 });
      return Promise.resolve({ ok: !urls.length, stored: [], failed: urls.slice() });
    }
    return openCache().then(function (cache) {
      var done = 0, bytes = 0, stored = [], failed = [];
      return urls.reduce(function (chain, url) {
        return chain.then(function () {
          return storeOne(cache, url).then(function (r) {
            if (r.ok) { stored.push(url); bytes += r.bytes; } else { failed.push(url); }
            done++;
            onProgress({ done: done, total: urls.length, bytes: bytes, failed: failed.length });
          });
        });
      }, Promise.resolve()).then(function () {
        return { ok: failed.length === 0, stored: stored, failed: failed };
      });
    }).catch(function () {
      return { ok: false, stored: [], failed: urls.slice() };
    });
  }

  /* The loading gate's primer: keep retrying the still-unstored subset with
   * exponential backoff up to `attempts` times, then give up on what's left so the
   * show can start on time (the failed slides get dropped — see the design doc's
   * failure policy). onProgress reports cumulative { done, total, bytes, waiting };
   * `waiting` is true during a post-failure backoff so the UI can say "Waiting for
   * network…". Resolves { stored:[urls], failed:[urls] }. Never throws. */
  function primeWithRetry(urls, opts) {
    urls = urls || [];
    opts = opts || {};
    var attempts = opts.attempts || 3;
    var baseDelay = opts.baseDelay != null ? opts.baseDelay : 1000;
    var onProgress = opts.onProgress || function () {};
    var total = urls.length;

    if (!SUPPORTED || total === 0) {
      onProgress({ done: 0, total: total, bytes: 0, waiting: false });
      return Promise.resolve({ stored: [], failed: urls.slice() });
    }

    return openCache().then(function (cache) {
      var storedBytes = {};          // url -> bytes; also the "stored" set
      var pending = urls.slice();
      var inflight = null;           // { url, received, total } for the clip downloading now

      // frac is the smooth fill for the loading bar: completed clips PLUS the in-flight
      // clip's byte fraction, so one big clip advances the bar as its chunks stream in
      // rather than the bar jumping only when the whole clip lands. bytes likewise adds
      // the in-flight partial so the MB readout ticks up with it. On a failed clip we
      // keep `inflight` (it resumes next attempt) so the bar holds instead of snapping back.
      function report(waiting) {
        var done = 0, bytes = 0, u;
        for (u in storedBytes) { done++; bytes += storedBytes[u]; }
        var infBytes = 0, infFrac = 0;
        if (inflight && !(inflight.url in storedBytes)) {
          infBytes = inflight.received || 0;
          if (inflight.total) infFrac = Math.min(1, infBytes / inflight.total);
        }
        var frac = total ? Math.min(1, (done + infFrac) / total) : 1;
        onProgress({ done: done, total: total, bytes: bytes + infBytes, waiting: !!waiting, frac: frac });
      }

      function onePass() {
        return pending.reduce(function (chain, url) {
          return chain.then(function () {
            return storeOne(cache, url, function (received, clipTotal) {
              inflight = { url: url, received: received, total: clipTotal || 0 };
              report(false);
            }).then(function (r) {
              if (r.ok) { storedBytes[url] = r.bytes; inflight = null; report(false); }
            });
          });
        }, Promise.resolve()).then(function () {
          pending = pending.filter(function (u) { return !(u in storedBytes); });
        });
      }

      function attempt(n) {
        return onePass().then(function () {
          if (pending.length === 0 || n >= attempts) {
            return { stored: Object.keys(storedBytes), failed: pending.slice() };
          }
          report(true);                                     // "Waiting for network…"
          var delay = baseDelay * Math.pow(2, n - 1);
          return new Promise(function (res) { setTimeout(res, delay); })
            .then(function () { return attempt(n + 1); });
        });
      }

      report(false);
      return attempt(1);
    }).catch(function () {
      return { stored: [], failed: urls.slice() };
    });
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

  /* Delete specific clips from the store — the superseded set on a content refresh
   * (see WccRefresh). Never throws. */
  function evict(urls) {
    if (!SUPPORTED || !urls || !urls.length) return Promise.resolve();
    return openCache().then(function (cache) {
      return Promise.all(urls.map(function (u) { return cache.delete(u); }));
    }).then(function () {}).catch(function () {});
  }

  window.WccVideoCache = {
    supported: SUPPORTED,
    cacheName: CACHE_NAME,
    prime: prime,
    primeWithRetry: primeWithRetry,
    getObjectURL: getObjectURL,
    evict: evict
  };
})();

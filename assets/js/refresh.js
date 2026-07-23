/* refresh.js — app-controlled slideshow refresh, shared by both players.
 *
 * Replaces the blind timer reload (refresh_interval → location.reload(), which
 * re-fetched everything and raced the cache). Instead: poll the small
 * precache.json, and only when its build_version changes, background-download the
 * new clips into the cache, then swap at a slideshow cycle boundary and prune the
 * superseded clips. Playback continues off the stored set throughout, and the
 * post-reload loading gate never races the network because the new clips are
 * already local. See docs/player-offline-architecture.md ("Intelligent refresh").
 *
 * WccRefresh.start({ url, version, videos, pollMs, alsoReloadIf })
 *   → { shouldReloadNow, onReload }   — pass straight into WccPlayer.start.
 *
 * `alsoReloadIf` is an optional predicate polled alongside build_version: the
 * screen player uses it to reload when the schedule advances (the resolved
 * context / shown-slide set changes) even without a rebuild — the blind reload
 * used to be what re-resolved context every interval, and that must be preserved.
 */
(function () {
  function index(list) {
    var m = {};
    (list || []).forEach(function (u) { m[u] = 1; });
    return m;
  }

  function start(opts) {
    opts = opts || {};
    var url = opts.url;
    var version = opts.version || null;         // build_version at page load
    var current = (opts.videos || []).slice();  // this slideshow's clip set at load
    var pollMs = opts.pollMs || 3600000;
    var alsoReloadIf = typeof opts.alsoReloadIf === 'function' ? opts.alsoReloadIf : function () { return false; };
    var pending = false;                         // a newer build is downloaded & ready
    var removed = [];                            // clips to prune at the swap

    function check() {
      if (pending || !url) return;               // already armed → wait for the swap
      // Schedule/context advance (or date rollover): reload without a content prewarm
      // — the post-reload gate primes whatever the new context needs.
      if (alsoReloadIf()) { pending = true; return; }
      fetch(url, { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (pc) {
          if (!pc || !pc.build_version || pc.build_version === version) return;
          var next = pc.videos || [];
          var curSet = index(current), nextSet = index(next);
          var added = next.filter(function (u) { return !curSet[u]; });
          var gone = current.filter(function (u) { return !nextSet[u]; });
          // Pre-download the added clips before arming the swap, so the post-reload
          // gate passes without a network race. Only commit once they're all stored
          // (or if there are none) — otherwise leave it for the next poll and keep
          // playing the current build. Data unchanged but no new clips still swaps,
          // to pick up fresh data.json.
          var prime = (window.WccVideoCache && WccVideoCache.supported)
            ? WccVideoCache.prime(added)
            : Promise.resolve({ failed: [] });
          prime.then(function (res) {
            if (res && res.failed && res.failed.length) return;
            version = pc.build_version;
            current = next;
            removed = gone;
            pending = true;
          });
        })
        .catch(function () {});
    }

    var timer = setInterval(check, pollMs);

    return {
      shouldReloadNow: function () { return pending; },
      onReload: function () {
        // Prune the superseded clips, then reload into the new build.
        var ev = (window.WccVideoCache && WccVideoCache.evict)
          ? WccVideoCache.evict(removed)
          : Promise.resolve();
        ev.then(function () { location.reload(); });
      },
      stop: function () { clearInterval(timer); }
    };
  }

  window.WccRefresh = { start: start };
})();

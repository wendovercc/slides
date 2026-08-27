/* player-core.js — shared slideshow engine for both players
 * (screen/player.html and slideshow/player.html).
 *
 * Modes (from URL):
 *   ?kiosk / default  — hands-free TV. Slides auto-rotate themselves; the player
 *                       advances whole slides after their derived duration.
 *                       No controls, no touch. Behaviour unchanged from before.
 *   ?interactive      — touch surface (the bar iPad / phones). The player owns a
 *                       single per-panel timer, drives carousel tabs over the
 *                       slide bridge, and renders an always-on control bar.
 *                       Input (identical in watch and the future record mode):
 *                         horizontal swipe / arrows = prev/next
 *                         tap / Space                = play/pause (+ centre flash)
 *                         Home/End = first/last, f = fullscreen.
 *                       The bar is placed relative to the letterboxed slide:
 *                       below it, to its right, or (near-16:9, no band) inside
 *                       the slide's top-right safe zone as a collapsible column.
 *
 * Usage:
 *   WccPlayer.start({
 *     items: [{ slug, duration, panel_duration, atoms, frame }], // ordered, frame = iframe el
 *     onShow: function(index) {}                            // optional (preview hook)
 *   });
 */
(function () {
  var SVG = {
    home: '<path d="M3 11l9-8 9 8" /><path d="M5 10v9h14v-9" />',
    prev: '<path d="M16 5v14l-9-7z" /><rect x="5" y="5" width="2" height="14" />',
    next: '<path d="M8 5v14l9-7z" /><rect x="17" y="5" width="2" height="14" />',
    play: '<path d="M7 5v14l12-7z" />',
    pause: '<rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" />',
    // Stroke-only corner brackets (rendered with fill:none via the .fs button class).
    expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" />',
    compress: '<path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" />',
    // Stroke-only "controls" grip for the collapse toggle (inside-placement only).
    grip: '<line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" />'
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + SVG[name] + '</svg>';
  }

  function injectStyles() {
    var css =
      // Interactive mode is touch/pointer-driven: keep the cursor visible
      // (overrides the kiosk `cursor:none` on both player and slide bases).
      // overscroll-behavior:none replaces what touch-action used to buy us — with the
      // tap surface now touch-action:auto, this is what keeps a drag from turning into
      // pull-to-refresh or a rubber-band overscroll instead of reaching the swiper.
      'html,body{cursor:auto!important;overscroll-behavior:none;}' +
      // touch-action:auto — deliberately, and it took two goes to get here. The slide
      // layout is zoom-invariant (all vw/vh), so a pinch magnifies without reflowing
      // anything: pinch is the one gesture worth keeping. `none` killed it outright.
      // `manipulation` (nominally pan + pinch-zoom) still killed it in a SAFARI TAB
      // while working in the installed PWA — WebKit routes standalone gestures through
      // a different recognizer that ignores element touch-action, and in the tab path
      // it has never honoured the pinch-zoom token, so any non-auto value takes pinch
      // down with it. `auto` is the only value that pinches in both.
      // The cost is that Safari's double-tap-zoom comes back; the JS tap handler below
      // swallows the second tap so it can't also double-toggle play/pause. Nothing is
      // scrollable at 1x (html,body are overflow:hidden + overscroll-behavior:none), so
      // a single-finger drag still reaches the swipe handler.
      '#wcc-tap{position:fixed;inset:0;z-index:50;cursor:default;touch-action:auto;}' +
      // Zoomed: no crossfade. The fade is what puts two full-size slide surfaces on
      // screen at once, which is the allocation the phone can't absorb at page scale
      // (see the pressure valve in start()). Instant swap instead, so exactly one
      // slide frame is ever visible while pinched in.
      'body.wcc-zoomed #slide-layer iframe{transition:none!important;}' +
      // Centre-screen play/pause feedback flashed on tap / Space. Above the tap
      // surface, below the bar; never intercepts input.
      '#wcc-fb{position:fixed;inset:0;z-index:55;display:flex;align-items:center;' +
      'justify-content:center;pointer-events:none;opacity:0;}' +
      '#wcc-fb svg{width:14vmax;height:14vmax;fill:rgba(255,255,255,0.92);stroke:none;' +
      'filter:drop-shadow(0 0.4vh 1.2vh rgba(0,0,0,0.55));}' +
      '#wcc-fb.anim{animation:wcc-fb-pop 0.5s ease-out;}' +
      '@keyframes wcc-fb-pop{0%{opacity:0;transform:scale(0.6);}' +
      '25%{opacity:1;}100%{opacity:0;transform:scale(1.25);}}' +
      // The control bar floats over the letterboxed slide; placeBar() positions it
      // each layout via a place-* class (see below). Targets are sized in vmax (the
      // longer viewport edge) so they stay the same physical size in portrait and
      // landscape. Base styling only here — geometry lives on the place-* classes.
      '#wcc-bar{position:fixed;z-index:60;display:flex;gap:0.6vmax;padding:0.7vmax 0.6vmax;' +
      'background:rgba(10,28,58,0.82);border:1px solid rgba(212,175,55,0.45);' +
      'border-radius:0.6vmax;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
      'box-shadow:0 0.6vh 2.4vh rgba(0,0,0,0.45);overflow:hidden;' +
      'transition:opacity 0.25s ease,transform 0.25s ease;}' +
      // Below the slide: horizontal row, bottom-anchored, centred on the viewport.
      // It fills the bottom letterbox band and may overhang up into the slide's
      // non-safe bottom strip (never past the safe zone — placeBar guarantees it).
      '#wcc-bar.place-below{flex-direction:row;left:50vw;bottom:0.6vmax;' +
      'transform:translateX(-50%);}' +
      // Right of the slide: vertical column, right-anchored, centred vertically.
      '#wcc-bar.place-right{flex-direction:column;right:0.6vmax;top:50vh;' +
      'transform:translateY(-50%);}' +
      // Inside the slide (near-16:9, no usable band): vertical column pinned to the
      // slide's top-right safe corner (top/right set inline from geometry) and
      // collapsible so it never permanently obstructs slide content.
      '#wcc-bar.place-inside{flex-direction:column;}' +
      '#wcc-bar.place-inside.collapsed{gap:0;}' +
      '#wcc-bar.place-inside.collapsed>*{display:none;}' +
      '#wcc-bar.place-inside.collapsed>button.collapse{display:flex;}' +
      // Collapse grip: hidden except in inside placement (the only case that hides).
      '#wcc-bar button.collapse{display:none;}' +
      '#wcc-bar.place-inside button.collapse{display:flex;}' +
      '#wcc-bar.place-inside button.collapse svg{fill:none;}' +
      '#wcc-bar button{width:4.7vmax;height:4.7vmax;border:none;border-radius:50%;background:transparent;' +
      'color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none;' +
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;}' +
      '#wcc-bar button:active{background:rgba(255,255,255,0.12);}' +
      '#wcc-bar button.primary{background:rgba(212,175,55,0.18);}' +
      '#wcc-bar button.primary:active{background:rgba(212,175,55,0.32);}' +
      '#wcc-bar svg{width:2.35vmax;height:2.35vmax;fill:#fff;stroke:#fff;stroke-width:2;' +
      'stroke-linejoin:round;stroke-linecap:round;}' +
      '#wcc-bar button.primary svg{fill:#d4af37;stroke:#d4af37;}' +
      // Fullscreen glyph is drawn as outlined corner brackets, not a filled shape.
      '#wcc-bar button.fs svg{fill:none;}' +
      // Countdown for the current panel/slide. Runs along the bar's long edge:
      // bottom strip when the bar is a row, left strip when it is a column.
      '#wcc-bar-progress{position:absolute;background:rgba(212,175,55,0.16);}' +
      '#wcc-bar.place-below #wcc-bar-progress{left:0;right:0;bottom:0;height:0.35vmax;}' +
      '#wcc-bar.place-right #wcc-bar-progress,#wcc-bar.place-inside #wcc-bar-progress{' +
      'top:0;bottom:0;right:0;width:0.35vmax;}' +
      '#wcc-bar-progress i{display:block;width:100%;height:100%;background:#d4af37;}' +
      '#wcc-bar.place-below #wcc-bar-progress i{transform-origin:left;transform:scaleX(0);}' +
      '#wcc-bar.place-right #wcc-bar-progress i,#wcc-bar.place-inside #wcc-bar-progress i{' +
      'transform-origin:top;transform:scaleY(0);}';
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* How many slides either side of the current one stay live documents; null = all
   * of them (no windowing). See the windowing block inside start() for why this
   * exists. Kiosk (the walls) is deliberately unwindowed: they have the memory and
   * the loading gate's whole promise is that every slide is warm before anything is
   * revealed. `?window=2` / `?window=off` force it either way for testing.
   * The players call this too — they must not give every iframe a src up front on a
   * windowed deck, or the boot peak is exactly the resident set we're avoiding. */
  function windowRadius(params) {
    var v = params.get('window');
    if (v === 'off' || v === 'none') return null;
    if (v != null && /^\d+$/.test(v)) return parseInt(v, 10);
    return params.has('interactive') ? 1 : null;
  }

  window.WccPlayer = {
    start: start,
    windowRadius: function () { return windowRadius(new URLSearchParams(location.search)); }
  };

  function start(opts) {
    var items = opts.items || [];
    var onShow = opts.onShow || function () {};
    if (items.length === 0) return;

    var params = new URLSearchParams(location.search);
    var interactive = params.has('interactive');

    var n = items.length;
    var current = 0;
    var counts = items.map(function () { return null; }); // panel count per item
    var panelIndex = 0;
    // Atom edges reported by the CURRENT slide (null = not heard from yet, fall back
    // to the panel arithmetic). A reel's atoms are finer than its panels — a card
    // hold is a stop inside a clip — so the slide, not the player, says whether a tap
    // still has somewhere to go before the slide boundary. See docs/narrated-decks.md.
    var edgeFirst = null, edgeLast = null;
    var slideHold = false;   // the current slide is frozen on a card, waiting for a tap
    // Interactive starts paused: the commentator drives timing. (Kiosk ignores this
    // flag entirely — it runs its own whole-slide rotation.) Forward arrival onto a
    // video slide flips this true so the clip plays; see arrive().
    var playing = !interactive;
    var timer = null;
    var shownAt = 0;
    var panelStart = 0;      // when the current panel countdown began (ms epoch)
    var panelMs = 0;         // the current panel countdown's full duration (ms)
    var pausedAt = 0;        // when the current pause began (ms epoch), 0 = not paused
    var progressFill = null; // control-bar countdown fill (interactive only)
    var progressAxis = 'x';  // fill grows along x (row bar) or y (column bar)
    var bar = null;          // control bar (interactive only)
    var mode = 'watch';      // session mode; 'record' (future) reuses the same gestures

    /* ---- live highlight news-flash (player-owned interrupt overlay) ----
     * A highlight clip arriving from the live engine interrupts the deck: pause the
     * current slide, dissolve in the full-bleed flash iframe, play the ~30s clip,
     * then dissolve out and carry on. It's NOT a slide in the rotation — the player
     * raises one dedicated overlay iframe above the stack. Timing (user's rule):
     * while playing, fire at the next slide boundary (clean cut; clips are already
     * minutes old so a few more seconds is free); while paused, fire immediately. */
    var flashItem = opts.flash || null;          // { frame } | null
    var flashQueue = [];
    var flashing = false;
    var flashCont = null;                          // what to do after the current flash
    var flashTimeout = null;
    var lastFlashAt = 0;
    var FLASH_MIN_GAP_MS = opts.flashMinGapMs || 45000;   // don't machine-gun flashes
    var FLASH_MAX_MS = opts.flashMaxMs || 65000;          // recover if the frame never reports done
    function flashWin() { return flashItem && flashItem.frame ? flashItem.frame.contentWindow : null; }

    /* ---- frame windowing: a MEMORY control, not a perf tweak -----------------
     * Every slide in the deck is a live iframe stacked at inset:0. `visibility:
     * hidden` (see the players' CSS) drops the compositor backing store for the
     * ones you can't see, but it does not reclaim the documents themselves — on a
     * 37-slide deck that's 37 parsed DOMs, style trees, JS heaps and decoded
     * images all resident in one WebContent process. On a phone that baseline sits
     * close to the jetsam ceiling, and pinch-zoom — which re-rasterises the visible
     * slide's wall-sized 1920x1080 layer at device scale x page scale SQUARED —
     * pushes it over: "A problem repeatedly occurred".
     *
     * So on small touch surfaces only current +/- winRadius stay live; the rest are
     * torn down. Teardown replaces the iframe with a fresh srcless clone, which is
     * the only way to be sure the document is really gone (navigating to about:blank
     * leaves a document behind and adds joint-session-history entries). That means
     * `items[i].frame` is re-pointed as the deck moves — nothing may cache a slide
     * frame element across a slide change. Read frames fresh (the live engine's
     * `frames:` callback already does).
     *
     * The cost is that a slide is a fresh document each time it comes round, so its
     * carousel/video state doesn't persist. Nothing depends on it: every arrival
     * already sends reset/goto-panel/restart-auto. */
    var winRadius = windowRadius(params);
    var pendingCmds = items.map(function () { return []; });
    var loaded = items.map(function () { return false; });
    var pruneTimer = null;
    var PRUNE_DELAY_MS = 1200;   // longer than the 0.8s crossfade: the outgoing frame is still fading

    function frameUrl(i) {
      var f = items[i].frame;
      return f.dataset.src || f.getAttribute('src') || '';
    }
    function frameIsLive(i) { return !!items[i].frame.getAttribute('src'); }
    function post(i, msg) {
      try { items[i].frame.contentWindow.postMessage(msg, '*'); } catch (e) {}
    }
    function markLoaded(i) {
      loaded[i] = true;
      var q = pendingCmds[i];
      pendingCmds[i] = [];
      q.forEach(function (m) { post(i, m); });
    }
    function watchLoad(i) {
      var f = items[i].frame;
      try {
        if (f.contentDocument && f.contentDocument.readyState === 'complete') { markLoaded(i); return; }
      } catch (e) {}
      f.addEventListener('load', function () { markLoaded(i); }, { once: true });
    }
    function loadFrame(i) {
      if (frameIsLive(i)) return;
      loaded[i] = false;
      items[i].frame.src = frameUrl(i);
      watchLoad(i);
    }
    function unloadFrame(i) {
      if (!frameIsLive(i)) return;
      var f = items[i].frame;
      var fresh = f.cloneNode(false);
      fresh.removeAttribute('src');
      fresh.classList.remove('active');
      fresh.dataset.src = frameUrl(i);
      f.parentNode.replaceChild(fresh, f);
      items[i].frame = fresh;
      loaded[i] = false;
      pendingCmds[i] = [];
      // counts[i] is a property of the SLIDE, not of this document instance — keep it,
      // so next()/prev() still know the panel count before the reload handshakes.
    }
    /* ---- pinch-zoom pressure valve ------------------------------------------
     * Zoom is where this actually falls over, and the reason is structural, not
     * per-slide. Measured on an iPhone XS: /slide/leaderboard-senior/ opened on
     * its own survives full zoom; the same slide inside a deck does not. The
     * difference is that WebKit TILES the main frame — only the visible tiles are
     * rasterised, so a standalone slide costs a screenful however far you zoom —
     * whereas a slide in a deck is an iframe, a separate render surface that is
     * not tiled that way, so it allocates its whole 1920x1080 layer at device
     * scale x page scale. One of those the phone survives; one of those plus two
     * more live documents it does not.
     *
     * So while the user is pinched in, collapse the window to the visible slide
     * alone and refuse to put a second full-size surface beside it. Everything
     * here reverses on pinch-out. */
    var zoomed = false;
    var ZOOM_IN = 1.05;
    var cancelGesture = function () {};   // set by buildControls (interactive only)
    function effRadius() { return winRadius === null ? null : (zoomed ? 0 : winRadius); }

    function onZoomChange() {
      // Interactive only. A wall is unwindowed and untouched, so the valve has
      // nothing to give there — and a desktop page-zoom on a kiosk preview must
      // never be able to clear the rotation timer and stall the deck.
      if (!interactive) return;
      var vv = window.visualViewport;
      var z = !!(vv && vv.scale > ZOOM_IN);
      if (z === zoomed) return;
      zoomed = z;
      // Kill the crossfade while zoomed: a fade holds the outgoing AND incoming
      // frame visible together, which is precisely the two-full-size-surfaces case
      // there is no headroom for. Without the transition the swap is instant and
      // only one frame is ever visible.
      if (document.body) document.body.classList.toggle('wcc-zoomed', zoomed);
      if (zoomed) {
        cancelGesture();
        clearTimer();          // don't auto-advance under the user while they're reading
      } else if (interactive && playing && !slideHold) {
        if (items[current].video) resumeVideoProgress(); else panelTimer();
      }
      if (winRadius === null) return;
      if (zoomed) {
        // Free the neighbours NOW rather than on the usual deferred prune — the
        // whole point is headroom at the moment the zoomed surface is allocated.
        if (pruneTimer) { clearTimeout(pruneTimer); pruneTimer = null; }
        for (var i = 0; i < n; i++) if (!inWindow(i, current)) unloadFrame(i);
      } else {
        reconcileWindow(current);   // pinch-out: warm the neighbours back up
      }
    }

    function inWindow(i, c) {
      var r = effRadius();
      if (r === null) return true;
      for (var d = -r; d <= r; d++) {
        if (((c + d) % n + n) % n === i) return true;
      }
      return false;
    }
    // Loads run now (the neighbours need the whole dwell to warm up); teardown is
    // deferred past the crossfade, and re-reads `current` when it fires so it never
    // tears down a frame the user has swiped back to. The timer is NOT restarted per
    // nav — a continuous swipe would keep pushing it back and let the resident set
    // grow, which is the thing this exists to stop. Pruning mid-swipe is safe: the
    // outgoing slide is current-1, still inside the window.
    function reconcileWindow(c) {
      if (winRadius === null) return;
      for (var i = 0; i < n; i++) if (inWindow(i, c)) loadFrame(i);
      if (pruneTimer) return;
      pruneTimer = setTimeout(function () {
        pruneTimer = null;
        for (var j = 0; j < n; j++) if (!inWindow(j, current)) unloadFrame(j);
      }, PRUNE_DELAY_MS);
    }

    function send(i, action, extra) {
      var msg = Object.assign({ type: 'wcc-cmd', action: action }, extra || {});
      // A frame still loading has no bridge listening yet, so hold its commands and
      // flush them in order once it does. Unwindowed decks are fully loaded before
      // anything is sent (the gate guarantees it), so this path never runs there.
      if (winRadius !== null && !loaded[i]) { pendingCmds[i].push(msg); return; }
      post(i, msg);
    }
    function activate(i) {
      if (i !== current) { edgeFirst = edgeLast = null; slideHold = false; }   // stale the moment we leave
      reconcileWindow(i);   // before .active — a cold frame needs its src first
      items.forEach(function (it, j) { it.frame.classList.toggle('active', j === i); });
      current = i;
      shownAt = Date.now();
      onShow(i);
    }
    function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }

    /* Queue a highlight for a news-flash. Deduped by clip id, capped so a flurry
     * can't build a backlog. Deferred download: a clip is prefetched whole into the
     * cache the moment it arrives and only becomes flashable once fully stored
     * (clip._ready) — so the flash (which shows a clip just ONCE) opens on local
     * bytes at the next slide boundary instead of streaming. Where the Cache API is
     * absent, a clip is ready immediately (the old streaming behaviour). Kiosk drains
     * at the next boundary; interactive drains as soon as a ready clip exists while
     * paused. */
    function flashCacheOn() { return !!(window.WccHlsCache && WccHlsCache.supported && WccHlsCache.prefetch); }
    function enqueueFlash(clip) {
      if (!flashItem || !clip || !clip.url || clip.id == null) return;
      if (flashQueue.some(function (c) { return c.id === clip.id; })) return;
      clip._ready = !flashCacheOn();          // no cache → stream immediately (as before)
      flashQueue.push(clip);
      while (flashQueue.length > 5) flashQueue.shift();
      if (flashCacheOn()) {
        // Start the download now; mark flashable once the whole clip is cached.
        WccHlsCache.prefetch(clip.url, clip.id).then(function (ok) {
          if (!ok) return;
          clip._ready = true;
          if (interactive && !playing) drainFlash();   // paused → fire as soon as ready
        });
      } else if (interactive && !playing) {
        drainFlash();
      }
    }
    // First queued clip that's finished downloading, or -1 — a not-yet-ready clip
    // never blocks a later ready one.
    function firstReadyFlash() {
      for (var i = 0; i < flashQueue.length; i++) if (flashQueue[i]._ready) return i;
      return -1;
    }
    function canFlashNow() {
      return !!flashItem && !flashing && firstReadyFlash() >= 0 &&
        (lastFlashAt === 0 || Date.now() - lastFlashAt >= FLASH_MIN_GAP_MS);
    }
    // Play the first READY queued flash if allowed; `cont` (optional) runs when it
    // ends, in place of the default resume. Returns true if a flash started.
    function drainFlash(cont) {
      if (!canFlashNow()) return false;
      playFlash(flashQueue.splice(firstReadyFlash(), 1)[0], cont);
      return true;
    }
    function playFlash(clip, cont) {
      flashing = true;
      flashCont = cont || null;
      clearTimer();                       // hold the rotation while the flash is up
      send(current, 'take-over');         // pause whatever the current slide is doing
      if (flashItem.frame) flashItem.frame.classList.add('flash-active');
      var w = flashWin();
      if (w) { try { w.postMessage(Object.assign({ type: 'wcc-flash' }, clip), '*'); } catch (e) {} }
      if (flashTimeout) clearTimeout(flashTimeout);
      flashTimeout = setTimeout(function () { onFlashDone('timeout'); }, FLASH_MAX_MS);
    }
    function onFlashDone() {
      if (!flashing) return;
      flashing = false;
      lastFlashAt = Date.now();
      if (flashTimeout) { clearTimeout(flashTimeout); flashTimeout = null; }
      if (flashItem && flashItem.frame) flashItem.frame.classList.remove('flash-active');
      try { var w = flashWin(); if (w) w.postMessage({ type: 'wcc-flash-stop' }, '*'); } catch (e) {}
      var cont = flashCont; flashCont = null;
      // Resume: run the boundary continuation (e.g. advance to the next slide) if the
      // flash fired at a boundary; otherwise re-anchor the slide we interrupted.
      if (cont) cont();
      else if (interactive) arrive(current, panelIndex, playing);
      else kioskShow(current);
    }

    /* Control-bar countdown. Mirrors the interactive per-panel timer: fills over
     * the dwell while playing, freezes where it is on pause, empties on nav. The
     * grow axis follows the bar orientation (x for a row, y for a column). All
     * no-ops until the bar exists, so kiosk (the wall) shows nothing. */
    function progressScale(v) { return (progressAxis === 'y' ? 'scaleY(' : 'scaleX(') + v + ')'; }
    function progressRun(ms) {
      if (!progressFill) return;
      progressFill.style.transition = 'none';
      progressFill.style.transform = progressScale(0);
      void progressFill.offsetWidth;                    // reflow → restart from empty
      progressFill.style.transition = 'transform ' + ms + 'ms linear';
      progressFill.style.transform = progressScale(1);
    }
    function progressReset() {
      if (!progressFill) return;
      progressFill.style.transition = 'none';
      progressFill.style.transform = progressScale(0);
    }
    function progressFreeze() {
      if (!progressFill) return;
      var t = getComputedStyle(progressFill).transform; // matrix at current width
      progressFill.style.transition = 'none';
      progressFill.style.transform = (t && t !== 'none') ? t : progressScale(0);
    }
    // Re-drive the fill after a placement change so it uses the new axis. Only the
    // playing case matters (rearm for the panel's remaining time); a paused fill is
    // left frozen — a rare rotate-while-paused may nudge it, which self-heals on
    // the next nav.
    function progressRelayout() {
      if (!progressFill || !playing) return;
      var remaining = panelMs - (Date.now() - panelStart);
      if (remaining > 0) progressRun(remaining); else progressReset();
    }

    /* ---- kiosk: whole-slide rotation, slides auto-rotate their own panels ----
     * Every slide's iframe loads at startup and begins auto-rotating its panels
     * immediately. So when a multi-panel slide finally comes on screen its panels
     * are mid-cycle. Tell the outgoing slide to stop and the incoming one to
     * rotate afresh from panel 0, so each slide's rotation is anchored to when it
     * actually becomes visible. */
    function kioskAdvance() {
      var next = (current + 1) % n;
      if (next === 0 && opts.shouldReloadNow && opts.shouldReloadNow()) { if (opts.onReload) opts.onReload(); else location.reload(); return; }
      kioskShow(next);
    }
    function kioskShow(i) {
      if (i !== current) send(current, 'take-over'); // stop the slide we're leaving
      activate(i);
      send(i, 'restart-auto');                       // rotate from panel 0, aligned to now
      clearTimer();
      timer = setTimeout(function () {
        // A slide boundary is the clean moment to run a queued news-flash; when it
        // ends, carry on to the next slide (kioskAdvance). No flash → advance now.
        if (flashQueue.length && drainFlash(kioskAdvance)) return;
        kioskAdvance();
      }, (items[i].duration || 20) * 1000);
    }
    function kioskGo(delta) { kioskShow((current + delta + n) % n); }

    /* ---- interactive: player owns the per-panel timer ---- */
    // Drive the countdown fill over `ms` and remember the window (for resize relayout).
    function startProgress(ms) {
      panelStart = Date.now();
      panelMs = ms;
      progressRun(ms);
    }
    // Arm the slide-advance timer over `ms`: step to the next panel, or advance the
    // slide after the last. Shared by panelTimer and the video-resume path.
    function armAdvanceTimer(ms) {
      clearTimer();
      timer = setTimeout(function () {
        var count = counts[current] || 1;
        if (panelIndex < count - 1) {
          send(current, 'next-panel');   // echo updates panelIndex
          panelTimer(panelIndex + 1);    // re-arm for the next panel (restarts the fill)
        } else {
          fwdSlide();
        }
      }, ms);
    }
    // How long the current slide holds ONE step. `atoms` is the per-atom pacing list
    // the compositor renders from, so reading it here is what keeps the wall and the
    // video saying the same thing when a deck carries a per-step dwell (the deck
    // builder can now set one panel of a carousel to a different number).
    //
    // `panel_duration` stays the fallback for the two cases that have no per-atom
    // answer: a live-match slide publishes no atoms (its panels are whatever the feed
    // produced), and a video reel's atoms are its clips while its panel_duration is
    // the whole-reel + 30s backstop — clip timing comes from wcc-panel, not from here.
    //
    // Takes the panel explicitly because panelIndex only catches up on the slide's
    // echo, and every caller that has just sent next-panel/prev-panel is re-arming
    // for the panel it asked for, not the one still showing.
    function atomMs(panel) {
      var e = items[current] || {};
      if (!e.video && e.atoms) {
        var a = e.atoms[panel == null ? panelIndex : panel];
        if (a && a.duration > 0) return a.duration * 1000;
      }
      return (e.panel_duration || 20) * 1000;
    }
    function panelTimer(panel) {
      var ms = atomMs(panel);
      // A video reel drives its own clips; its panel_duration is a long backstop
      // (whole reel + 30s), so filling the bar over that would creep across the
      // entire reel. Leave the bar to the per-clip driver (the wcc-panel handler)
      // and keep this timer only as the slide-advance backstop.
      if (items[current].video) progressReset(); else startProgress(ms);
      armAdvanceTimer(ms);
    }
    // Resume a video slide's per-clip countdown after a pause: continue the frozen
    // bar over the clip's REMAINING time. panelTimer would blank it (progressReset),
    // and a merely-resumed clip emits no fresh wcc-panel to re-arm it — so the bar
    // would vanish. Non-video slides keep panelTimer's fresh-full-panel behaviour.
    function resumeVideoProgress() {
      armAdvanceTimer(atomMs());
      if (!progressFill) return;
      if (pausedAt) { panelStart += (Date.now() - pausedAt); pausedAt = 0; }
      var remaining = panelMs - (Date.now() - panelStart);
      if (remaining > 0) {
        // Continue from wherever progressFreeze left the fill, to full, over the rest.
        progressFill.style.transition = 'transform ' + remaining + 'ms linear';
        progressFill.style.transform = progressScale(1);
      } else {
        progressReset();
      }
    }
    function applyState(panel) {
      var i = current;
      send(i, 'take-over');
      // Back-nav asks for the incoming slide's last panel; honour it whether
      // playing or paused (previously the playing path always reset to panel 0,
      // so stepping back into a multi-clip reel jumped to the first clip).
      var last = panel === 'last' && counts[i] != null ? counts[i] - 1 : null;
      if (playing) {
        // Clear the slide's paused flag first: only `resume` (in slide-bridge)
        // unsets body.paused, and video.html keeps a clip paused while it's set. A
        // slide shown paused earlier (e.g. the deck starts paused) would otherwise
        // stay frozen on arrival here even though we're now playing — reset/goto-panel
        // change the panel but don't lift the pause.
        send(i, 'resume');
        if (last != null) { panelIndex = last; send(i, 'goto-panel', { index: last }); }
        else { panelIndex = 0; send(i, 'reset'); }
        panelTimer();
      } else {
        send(i, 'pause');
        progressReset();
        var idx = panel === 'last' ? (counts[i] != null ? counts[i] - 1 : 9999) : (panel || 0);
        // Set panelIndex synchronously (the playing branch above already does).
        // Otherwise it stays at the OUTGOING slide's panel until the incoming
        // slide's wcc-panel echo lands — and a fast prev()/next() in that window
        // reads the stale index and misfires (e.g. back after crossing a slide
        // boundary sends prev-panel to the new slide instead of stepping back).
        // The echo still arrives and confirms/corrects (e.g. the real last index
        // when counts were unknown → 9999).
        panelIndex = idx;
        send(i, 'goto-panel', { index: idx });
      }
    }
    function interShow(i, panel) { activate(i); applyState(panel); }
    // Every arrival sets the transport state before applying it, so the incoming
    // slide is handed the right play/pause commands. Forward onto a video slide
    // auto-plays (and, since a finished reel posts wcc-done → fwdSlide, the run
    // carries on through consecutive video slides); forward onto a non-video — and
    // every backward/jump move — stops (pauses) so the user regains manual control.
    function arrive(i, panel, play) { playing = play; updatePlayBtn(); interShow(i, panel); }
    function fwdSlide() { var i = (current + 1) % n; arrive(i, 0, !!items[i].video); }
    function backSlide() { arrive((current - 1 + n) % n, 'last', false); }
    function goFirst() { arrive(0, 0, false); }
    function goLast() { arrive(n - 1, 0, false); }

    function setPlaying(p) {
      playing = p;
      updatePlayBtn();
      if (p) {
        send(current, 'resume');
        // A card hold outlives the pause: the slide stays frozen until a forward tap
        // releases it, so arming the slide-advance backstop here would eventually
        // carry the deck off a card nobody has finished talking over.
        if (slideHold) return;
        // Video slides own a per-clip countdown; resume continues it rather than
        // resetting (panelTimer would blank the bar). Others get a fresh panel.
        if (items[current].video) resumeVideoProgress(); else panelTimer();
      } else {
        clearTimer(); send(current, 'pause'); progressFreeze(); pausedAt = Date.now(); drainFlash();
      }
    }
    // Manual nav preserves the play/pause state (so a paused wall stays paused
    // when you step across slides, including between slide-set members). When
    // playing, the per-panel timer restarts; when paused, applyState re-pauses
    // the incoming slide.
    // Slides that predate atom edges send neither field; leaving the flags null keeps
    // the panel arithmetic in charge for them.
    function setEdges(d) {
      if (typeof d.first === 'boolean') edgeFirst = d.first;
      if (typeof d.last === 'boolean') edgeLast = d.last;
    }
    function atLastAtom() {
      return edgeLast !== null ? edgeLast : panelIndex >= (counts[current] || 1) - 1;
    }
    function atFirstAtom() {
      return edgeFirst !== null ? edgeFirst : panelIndex <= 0;
    }
    function next() {
      clearTimer();
      if (!atLastAtom()) {
        send(current, 'next-panel');
        if (playing) panelTimer(panelIndex + 1); else progressReset();
      } else {
        fwdSlide();
      }
    }
    function prev() {
      clearTimer();
      if (!atFirstAtom()) {
        send(current, 'prev-panel');
        if (playing) panelTimer(panelIndex - 1); else progressReset();
      } else {
        backSlide();
      }
    }

    /* ---- bar placement: below the slide, right of it, or inside its top-right
     * safe corner. The players letterbox a 16:9 slide (width:min(100vw,177.78vh),
     * height:min(56.25vw,100vh)) so the black band falls on exactly one axis. The
     * controls may overhang that band into the slide's outer 5% non-safe strip;
     * they only fall inside (collapsible) when neither band+strip can hold them. ---- */
    function setPlaceClass(p) {
      bar.classList.remove('place-below', 'place-right', 'place-inside');
      bar.classList.add('place-' + p);
    }
    function placeBar() {
      if (!bar) return;
      var wasInside = bar.classList.contains('place-inside'); // capture before measuring
      // Reset inline positioning first: below/right are anchored purely by their
      // place-* class, and any inline top/right left over from a previous `inside`
      // placement would otherwise stretch the bar and corrupt the fit measurement
      // below (so it could never switch back out into a newly-opened letterbox).
      bar.style.top = bar.style.right = bar.style.left = bar.style.bottom = bar.style.transform = '';
      var iw = window.innerWidth, ih = window.innerHeight;
      var slideW = Math.min(iw, ih * 16 / 9), slideH = Math.min(ih, iw * 9 / 16);
      var bandBelow = (ih - slideH) / 2, bandRight = (iw - slideW) / 2; // per-side bands
      var safeY = 0.05 * slideH, safeX = 0.05 * slideW;                 // slide's non-safe strip
      var edge = 0.006 * Math.max(iw, ih);   // the 0.6vmax gap the bar sits off the viewport edge
      var aspect = iw / ih, EPS = 0.02, place;
      // Measure the bar in the orientation we're testing (row for below, column for
      // right), since its footprint differs. The bar sits `edge` off the outer
      // viewport edge, which pushes its inner edge that much further in — so the
      // budget is band + non-safe strip − edge, keeping the inner edge from crossing
      // into the slide's safe zone.
      if (aspect < 16 / 9 - EPS) {          // taller viewport → top/bottom bands
        setPlaceClass('below');
        place = bar.getBoundingClientRect().height <= bandBelow + safeY - edge ? 'below' : 'inside';
      } else if (aspect > 16 / 9 + EPS) {   // wider viewport → left/right bands
        setPlaceClass('right');
        place = bar.getBoundingClientRect().width <= bandRight + safeX - edge ? 'right' : 'inside';
      } else {                              // ~16:9 → no usable band
        place = 'inside';
      }
      setPlaceClass(place);
      // Inside is pinned inline to the viewport's top-right corner (below/right are
      // positioned entirely by their class). The far corner clears most slide content
      // — titles/hero sit top-left or centre — and, collapsed to its grip by default,
      // a column here is the least intrusive option when no band can hold the bar.
      if (place === 'inside') {
        bar.style.top = edge + 'px';
        bar.style.right = edge + 'px';
      }
      progressAxis = place === 'below' ? 'x' : 'y';
      // Collapse belongs to inside only — the one placement that overlaps the slide.
      // It starts collapsed to its grip (clearing content) and only the grip toggles
      // it; there's no auto-hide. Entering inside afresh collapses; staying inside
      // across a resize preserves whatever the user last set. Elsewhere: always open.
      if (place === 'inside') { if (!wasInside) bar.classList.add('collapsed'); }
      else { bar.classList.remove('collapsed'); }
      progressRelayout();
    }
    var placeRaf = null;
    function schedulePlace() {
      if (placeRaf) return;
      placeRaf = requestAnimationFrame(function () { placeRaf = null; placeBar(); });
    }

    /* ---- collapse: inside placement only. The grip toggles the column open/shut;
     * there's no auto-hide (it holds whatever the user last set). A no-op in
     * below/right, where the bar is always fully visible. ---- */
    function toggleCollapse() { if (bar) bar.classList.toggle('collapsed'); }

    /* Gestures (identical in watch and the future record mode): a tap toggles
     * play/pause with centre-screen feedback; a horizontal swipe steps slides. */
    function onTap() {
      setPlaying(!playing);
      flashFeedback(playing ? 'play' : 'pause');
    }
    function onSwipe(dir) { (dir === 'next' ? next : prev)(); }

    /* Centre-screen play/pause feedback. Shows the resulting transport state. */
    var fb = null;
    function flashFeedback(name) {
      if (!fb) return;
      fb.innerHTML = icon(name);
      fb.classList.remove('anim');
      void fb.offsetWidth;
      fb.classList.add('anim');
    }

    /* Fullscreen. The API is absent on iPhone Safari (video-only there), so the
     * button is only added when supported; this stays a safe no-op regardless. */
    function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement; }
    function toggleFullscreen() {
      var el = document.documentElement;
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      try { if (!fsElement()) { if (req) req.call(el); } else if (exit) exit.call(document); } catch (e) {}
    }

    /* ---- control bar ---- */
    var playBtn = null;
    var fsBtn = null;
    function updatePlayBtn() {
      if (playBtn) playBtn.innerHTML = icon(playing ? 'pause' : 'play');
    }
    function updateFsBtn() {
      if (fsBtn) fsBtn.innerHTML = icon(fsElement() ? 'compress' : 'expand');
    }
    function button(name, cls, handler) {
      var b = document.createElement('button');
      if (cls) b.className = cls;
      b.innerHTML = icon(name);
      b.addEventListener('click', function (e) { e.stopPropagation(); handler(); });
      return b;
    }
    function buildControls() {
      injectStyles();

      // Full-surface gesture layer. A horizontal swipe steps slides; a clean tap
      // toggles play/pause. Movement + time thresholds keep a tap and a swipe from
      // firing each other (a drag never counts as a tap, and vice versa).
      var tap = document.createElement('div');
      tap.id = 'wcc-tap';
      var TAP_SLOP = 10, TAP_MAX_MS = 500, SWIPE_MIN = 45, DBLTAP_MS = 300;
      var gp = null, lastTapAt = 0;
      // While the user is pinched in, the browser owns the surface: a drag pans the
      // magnified view and a second finger keeps pinching. Our tap/swipe nav stands
      // down for the duration so the two gesture sets never fight, and resumes the
      // moment they pinch back out to a fitted view. `zoomed` is now owned by
      // start() (the windowing valve reads it too); this just drops any gesture in
      // flight when a pinch begins.
      cancelGesture = function () { gp = null; };
      tap.addEventListener('pointerdown', function (e) {
        gp = zoomed ? null : { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
      });
      tap.addEventListener('pointerup', function (e) {
        if (!gp || e.pointerId !== gp.id) return;
        var dx = e.clientX - gp.x, dy = e.clientY - gp.y, dt = Date.now() - gp.t;
        gp = null;
        if (zoomed) return;
        var adx = Math.abs(dx), ady = Math.abs(dy);
        if (adx > SWIPE_MIN && adx > ady * 1.5) { onSwipe(dx < 0 ? 'next' : 'prev'); return; }
        if (adx < TAP_SLOP && ady < TAP_SLOP && dt < TAP_MAX_MS) {
          // Double-tap guard. touch-action:auto is the only value that pinches in a
          // Safari tab (see injectStyles), but it also restores double-tap-to-zoom.
          // Swallow the second tap so a zoom gesture doesn't ALSO toggle play/pause
          // twice. We can't preventDefault the zoom itself without touch-action, and
          // wouldn't want to — the whole point is to let the user zoom. Deliberately
          // not deferring the first tap by the double-tap window: that would put
          // ~300ms of lag on every play/pause, which is worse than the rare case of a
          // double-tap-to-zoom leaving playback toggled once.
          var now = Date.now();
          if (now - lastTapAt < DBLTAP_MS) { lastTapAt = 0; return; }
          lastTapAt = now;
          onTap();
        }
      });
      tap.addEventListener('pointercancel', function () { gp = null; });
      document.body.appendChild(tap);

      fb = document.createElement('div');
      fb.id = 'wcc-fb';
      document.body.appendChild(fb);

      bar = document.createElement('div');
      bar.id = 'wcc-bar';
      // Collapse grip: first child so it sits at the column's top; visible only in
      // inside placement, and the sole control left when collapsed.
      bar.appendChild(button('grip', 'collapse', toggleCollapse));
      bar.appendChild(button('home', '', function () { location.href = '/'; }));
      bar.appendChild(button('prev', '', prev));
      playBtn = button('pause', 'primary', function () { setPlaying(!playing); });
      bar.appendChild(playBtn);
      bar.appendChild(button('next', '', next));
      var docEl = document.documentElement;
      if (docEl.requestFullscreen || docEl.webkitRequestFullscreen) {
        fsBtn = button('expand', 'fs', function () { toggleFullscreen(); });
        bar.appendChild(fsBtn);
        document.addEventListener('fullscreenchange', updateFsBtn);
        document.addEventListener('webkitfullscreenchange', updateFsBtn);
      }
      var prog = document.createElement('div');
      prog.id = 'wcc-bar-progress';
      progressFill = document.createElement('i');
      prog.appendChild(progressFill);
      bar.appendChild(prog);
      document.body.appendChild(bar);

      updatePlayBtn();
      placeBar();
      window.addEventListener('resize', schedulePlace);
      window.addEventListener('orientationchange', schedulePlace);
    }

    /* ---- bridge messages from slides ---- */
    window.addEventListener('message', function (e) {
      var d = e.data; if (!d) return;
      // The flash overlay isn't in `items`; handle its done signal before the idx gate.
      if (d.type === 'wcc-flash-done' && flashWin() && e.source === flashWin()) { onFlashDone(); return; }
      var idx = items.findIndex(function (it) { return it.frame.contentWindow === e.source; });
      if (idx < 0) return;

      // wcc-done: video ended naturally — advance slide (works in both kiosk and interactive)
      if (d.type === 'wcc-done' && idx === current) {
        if (interactive) {
          if (playing) fwdSlide(); // paused → hold last frame until user acts
        } else {
          clearTimer();
          if (flashQueue.length && drainFlash(kioskAdvance)) return;
          kioskAdvance();
        }
        return;
      }

      if (!interactive) {
        // Kiosk handshake re-apply: slides no longer self-start when embedded, so if a
        // slide's bridge registered only after our restart-auto was sent (the ungated
        // path starts the player before iframes finish loading), re-drive the current
        // one now that it's listening. The gated walls don't need this — iframes are
        // fully loaded before kioskShow runs — but it's a cheap belt-and-braces.
        if (d.type === 'wcc-slide' && idx === current && Date.now() - shownAt < 2000) send(current, 'restart-auto');
        return;
      }
      if (d.type === 'wcc-slide') {
        var first = counts[idx] == null;
        counts[idx] = d.panels;
        if (idx === current) setEdges(d);
        // Re-apply state on the current slide's handshake (covers the load race
        // where our first commands arrived before the bridge was listening).
        if (idx === current && first && Date.now() - shownAt < 2000) applyState(playing ? 0 : panelIndex);
      } else if (d.type === 'wcc-panel' && idx === current) {
        panelIndex = d.panel;
        setEdges(d);
        if (!items[current].video) return;
        // A card hold: the reel has frozen on a pad's last frame and is waiting for a
        // tap, so nothing may run underneath it — not the countdown fill, and not the
        // slide-advance backstop, which would otherwise carry the deck off the card
        // mid-sentence. Releasing the hold re-arms both over what is left of the clip.
        slideHold = !!d.hold;
        if (d.hold) { clearTimer(); progressFreeze(); return; }
        if (!playing) return;
        if (d.hold === false) armAdvanceTimer(atomMs());
        // Restart the countdown for the clip now playing, so the bar tracks the
        // current clip rather than the whole reel. Only while playing — a paused reel
        // leaves the bar reset until it resumes.
        if (d.dur > 0) startProgress(d.dur * 1000);
      }
    });

    /* ---- keyboard ---- */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { if (interactive) { next(); } else kioskGo(1); return; }
      if (e.key === 'ArrowLeft')  { if (interactive) { prev(); } else kioskGo(-1); return; }
      if (!interactive) return;
      if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); onTap(); }
      else if (e.key === 'Home') { e.preventDefault(); goFirst(); }
      else if (e.key === 'End')  { e.preventDefault(); goLast(); }
      else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); }
    });

    // Expose the flash entry point for the live engine (running in this same frame).
    window.WccPlayer.flash = enqueueFlash;

    /* ---- go ---- */
    // Seed the load state from whatever the player template already started. The
    // first activate() pulls the rest of the opening window in.
    items.forEach(function (it, i) { if (frameIsLive(i)) watchLoad(i); });

    // Watch pinch-zoom in both modes: a wall never fires this (no touch, scale
    // stays 1), so it costs the kiosk nothing but the listener.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onZoomChange);
      onZoomChange();
    }

    if (interactive) {
      buildControls();
      // Learn every slide's panel count up front. On the gated path the iframes
      // finish loading (and post their wcc-slide handshake) before start() attaches
      // the listener above, so those first handshakes are missed and `counts` would
      // stay null — which breaks next()'s `panelIndex < counts-1` test (it collapses
      // to `< 0`, so next always leaves the slide) while prev() still steps clips.
      // Ping now that we're listening; the bridge answers with a fresh wcc-slide.
      // On a windowed deck most of these queue until their frame is pulled in — by
      // which time the bridge's own load-time wcc-slide has already filled `counts`,
      // so the flushed ping is a harmless second answer.
      items.forEach(function (it, i) { send(i, 'ping'); });
      // Start paused so the commentator drives timing — but if the deck opens on a
      // video slide, play it (there's no preceding non-video to advance from, and a
      // frozen first frame reads as a stuck/blank screen). Playing it also kicks off
      // the run, which stops at the first non-video slide.
      arrive(0, 0, !!items[0].video);
    } else {
      kioskShow(0);
    }
  }
})();

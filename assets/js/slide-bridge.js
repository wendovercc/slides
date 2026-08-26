/* slide-bridge.js — runs inside every slide iframe.
 *
 * Lets the parent player coordinate multi-tab (carousel) slides:
 *  - announces the slide's panel count to the parent,
 *  - echoes the active panel whenever it changes,
 *  - accepts navigation/pause commands from the parent.
 *
 * Non-carousel slides need no extra JS — they default to a single panel.
 * Carousel slides register a controller via WccSlide.register({...}).
 *
 * Two independent concepts, deliberately kept apart:
 *  - the slide's own auto-rotate (on by default; the player calls `take-over`
 *    to stop it in interactive mode so the player owns a single timer),
 *  - the visual *paused* state (`body.paused`), set only on an explicit user
 *    pause, which freezes the active tab's gold underline to full width.
 */
(function () {
  var ctrl = null;     // optional carousel controller
  var count = 1;       // panel count (1 for plain slides)
  var current = 0;     // active panel index

  function post(type, extra) {
    try {
      parent.postMessage(Object.assign({ type: type, panel: current, panels: count }, extra || {}), '*');
    } catch (e) { /* not embedded — ignore */ }
  }

  window.WccSlide = {
    // Carousel controller: { count, show(i), startAuto(), pauseAuto(), restartCurrent() }
    register: function (c) {
      ctrl = c;
      count = c.count || 1;
      current = 0;
      post('wcc-slide');
    },
    // Called by the controller after it changes panel. `extra` (optional) rides
    // along on the wcc-panel message — video reels pass the current clip's duration
    // so the player's countdown can track the clip, not the whole reel.
    notifyPanel: function (i, extra) {
      current = i;
      post('wcc-panel', extra);
    }
  };

  function setPaused(p) {
    document.body.classList.toggle('paused', p);
  }

  function show(i) {
    if (!ctrl) return;
    i = Math.max(0, Math.min(count - 1, i));
    ctrl.show(i); // controller updates `current` via notifyPanel
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'wcc-cmd') return;
    switch (d.action) {
      case 'take-over':                       // player assumes timing
        if (ctrl) ctrl.pauseAuto();
        break;
      case 'pause':                           // user paused: freeze underline
        setPaused(true);
        if (ctrl) ctrl.pauseAuto();
        break;
      case 'resume':                          // user resumed: re-animate current
        setPaused(false);
        if (ctrl) ctrl.restartCurrent();
        break;
      case 'restart-auto':                    // kiosk: slide just became visible —
        if (ctrl) { setPaused(false); ctrl.show(0); ctrl.startAuto(); } // rotate afresh from panel 0
        break;
      case 'next-panel': show(current + 1); break;
      case 'prev-panel': show(current - 1); break;
      case 'goto-panel': show(typeof d.index === 'number' ? d.index : current); break;
      case 'reset':      show(0); break;
      case 'ping':       post('wcc-slide'); break; // parent (re)requests count
      // Runtime clip list for a reel: an injected deck carries clips the build has
      // never seen, so the player pushes them in on load and the slide rebuilds
      // around them (re-registering, which re-announces the panel count above).
      // Routed here rather than listened for in video.html so slides keep exactly
      // one message surface. See docs/narrated-decks.md.
      case 'set-clips':
        if (window.WccReel && WccReel.setClips) WccReel.setClips(d.videos || []);
        break;
    }
  });

  // Announce on load too: covers plain slides (no controller) and re-announces
  // in case the parent attached its listener after the controller registered.
  window.addEventListener('load', function () { post('wcc-slide'); });

  /* Presentation context.
   *
   * A slide renders for the wall by default. `?ctx=archive` switches it to
   * self-contained wording — the mode scripts/compose.py renders every still and
   * overlay in, because a published video is watched with none of the wall's
   * context around it ("Last Match" is only true on the wall; the fixture's date
   * and venue are only implied by the screen it is playing on).
   *
   * Deliberately one flag at one place rather than a second set of pages: the
   * video and the wall stay the same slide in two modes, so they cannot drift.
   * Two mechanisms, both opt-in per element:
   *   - `data-archive="…"` swaps that element's text,
   *   - `body.ctx-archive` lets CSS reveal archive-only blocks.
   */
  function applyContext() {
    var ctx = null;
    try { ctx = new URLSearchParams(location.search).get('ctx'); } catch (e) { /* older engine */ }
    if (ctx !== 'archive') return;
    document.body.classList.add('ctx-archive');
    var swap = document.querySelectorAll('[data-archive]');
    for (var i = 0; i < swap.length; i++) {
      swap[i].textContent = swap[i].getAttribute('data-archive');
    }
  }

  // video.html loads this in <head>, so <body> may not exist yet.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyContext);
  } else {
    applyContext();
  }
})();

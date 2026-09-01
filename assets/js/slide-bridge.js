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
  var count = 1;       // panel count the CONTROLLER has (1 for plain slides)
  var current = 0;     // active panel index, as the controller numbers them
  var sel = null;      // panel subset: kept controller indices, ascending; null = all

  /* Panel subsets.
   *
   * A deck entry may carry only some of its slide's panels (`set-panels`, sent by
   * the player from the entry's `panels` list). The controller still has all of
   * them — it is the same document either way — so this file is the one place that
   * knows the difference, and it presents an ORDINAL space to everything outside:
   * `panels` is the reduced count, the reported `panel` is an ordinal, and a
   * `goto-panel` index is an ordinal. `show()` maps ordinal → controller index on
   * the way in, `toOrd()` maps back on the way out, and `edge()` falls out correct
   * because it is written in terms of both.
   *
   * Doing it here rather than in player-core.js keeps the authority phase 5 handed
   * to the slide: the player asks for "the next atom" and the slide answers what
   * that is. One implementation covers every carousel template.
   */
  function nPanels() { return sel ? sel.length : count; }

  function toRaw(i) {
    if (!sel) return i;
    return sel[i] === undefined ? sel[sel.length - 1] : sel[i];
  }

  function toOrd(raw) {
    if (!sel) return raw;
    var i = sel.indexOf(raw);
    if (i >= 0) return i;
    // The controller landed on a panel this entry dropped — its own auto-rotate,
    // or a step it owns. Report the nearest kept panel at or before it, so the
    // ordinal is always in range and `edge()` never reads `last` off a panel the
    // deck does not contain.
    for (var k = sel.length - 1; k >= 0; k--) if (sel[k] < raw) return k;
    return 0;
  }

  // Drop anything out of range or duplicated, and sort: the subset is authored in
  // a browser and arrives before the controller registers, so it can name panels
  // this slide turned out not to have (a team slide's panels depend on the data).
  // An empty result means "no usable subset", which is a whole slide, not a blank.
  function clampSel() {
    if (!sel) return;
    var keep = [];
    for (var i = 0; i < sel.length; i++) {
      var v = sel[i];
      if (typeof v === 'number' && v >= 0 && v < count && keep.indexOf(v) < 0) keep.push(v);
    }
    keep.sort(function (a, b) { return a - b; });
    sel = keep.length ? keep : null;
  }

  /* Where this slide's own navigation sits within itself, for the player's
   * next()/prev(). Panels are the default atom, but a reel's atoms are finer than
   * its panels — a card hold is a stop *inside* a clip — so a controller may answer
   * for itself. `last` false means a forward tap has somewhere to go in here;
   * `last` true means it must cross to the next slide. */
  function edge() {
    if (ctrl && ctrl.edge) { try { return ctrl.edge(); } catch (e) { /* fall through */ } }
    var o = toOrd(current);
    return { first: o === 0, last: o === nPanels() - 1 };
  }

  /* Does this slide want the player's gesture layer stood down while it is
   * showing? Only a slide that offers the viewer something to actually press —
   * `<body data-taps>` — which in practice means a link that is live on the
   * interactive surface and absent on the wall. Announced on every message so a
   * player that reloads a windowed frame re-learns it with no extra handshake.
   * Read lazily: the bridge may post before <body> exists (video.html loads it
   * in <head>). */
  function wantsTaps() {
    return !!(document.body && document.body.hasAttribute('data-taps'));
  }

  function post(type, extra) {
    try {
      parent.postMessage(Object.assign(
        { type: type, panel: toOrd(current), panels: nPanels(), taps: wantsTaps() },
        edge(), extra || {}), '*');
    } catch (e) { /* not embedded — ignore */ }
  }

  /* A controller that can enumerate its own atoms answers with them on the
   * handshake. Only a reel does, and only because the build cannot: during the
   * editor's sitting its clips are a live curation nothing has built, so the
   * published `_atoms` are stale or empty and the slide is the sole authority.
   * Everything else is enumerated at build time and needs no runtime answer.
   * Same principle as `edge()` — the slide answers for itself. */
  function ownAtoms() {
    if (!ctrl || !ctrl.atoms) return null;
    try { return ctrl.atoms(); } catch (e) { return null; }
  }

  window.WccSlide = {
    // Capability flag: this bridge understands atom-level navigation (`edge`/`step`
    // on a controller, first/last on every message). A slide template may deploy
    // hours before this file does — GH Pages caches HTML for 10 minutes and /assets
    // for 4 — so a reel must check this before it starts holding on cards, or an old
    // bridge would drop the step that releases the hold and wedge the reel.
    atoms: true,
    // Carousel controller: { count, show(i), startAuto(), pauseAuto(), restartCurrent(),
    //                        edge()?, step(delta)? }
    register: function (c) {
      ctrl = c;
      count = c.count || 1;
      current = 0;
      // A subset can arrive before the controller does (the player posts it on
      // frame load), and only now is the real panel count known.
      clampSel();
      if (sel && sel[0] !== 0) ctrl.show(sel[0]);
      post('wcc-slide', { atoms: ownAtoms() });
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

  // `i` is an ordinal within this entry's panels, not a controller index — see
  // "Panel subsets" above. With no subset the two are the same number.
  function show(i) {
    if (!ctrl) return;
    i = Math.max(0, Math.min(nPanels() - 1, i));
    ctrl.show(toRaw(i)); // controller updates `current` via notifyPanel
  }

  // One step of the player's nav. A controller with finer atoms than panels handles
  // it itself (a reel releases a card hold rather than skipping the clip); everyone
  // else steps a panel.
  function step(d) {
    if (ctrl && ctrl.step) { ctrl.step(d); return; }
    show(toOrd(current) + d);
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
        if (ctrl) {
          setPaused(false);
          show(0);                            // rotate afresh from the first kept panel
          // A subset implies player-owned timing. The template's own rotation walks
          // every panel it *has*, with no notion of the entry's selection, so
          // starting it would show panels this deck removed. The slide holds its
          // first kept panel instead and the player's timer moves the deck on.
          if (!sel) ctrl.startAuto();
        }
        break;
      case 'next-panel': step(1); break;
      case 'prev-panel': step(-1); break;
      case 'goto-panel': show(typeof d.index === 'number' ? d.index : current); break;
      case 'reset':      show(0); break;
      case 'ping':       post('wcc-slide', { atoms: ownAtoms() }); break; // parent (re)requests count
      // The playhead, on request. A narration freeze is stamped with media time
      // within the clip, and only the slide knows it. Answered as its own message
      // rather than on the panel echo: `wcc-panel` re-arms the player's clocks, and
      // a probe must not.
      case 'ping-time':
        if (ctrl && ctrl.time) {
          try { parent.postMessage({ type: 'wcc-time', panel: toOrd(current), t: ctrl.time() }, '*'); }
          catch (e) {}
        }
        break;
      // Park on one atom: a panel, and for a reel which segment of the clip. The
      // slide answers because a clip's segments are its own business — the player
      // knows panels. Anything else treats it as a plain panel move.
      case 'goto-atom':
        if (window.WccReel && WccReel.gotoAtom) WccReel.gotoAtom(d.panel, d.card || null, d.at);
        else show(typeof d.panel === 'number' ? d.panel : current);
        break;
      // Hold a clip's last frame at its end rather than rolling on, for a hosted
      // review whose boundaries come from the take. A slide with no reel ignores it.
      case 'set-hold-end':
        if (window.WccReel && WccReel.setHoldEnd) WccReel.setHoldEnd(!!d.hold);
        break;
      // Clip audio on or off, for record mode. A slide with no media ignores it.
      case 'set-mute':
        if (window.WccReel && WccReel.setMute) WccReel.setMute(!!d.muted);
        break;
      // Runtime clip list for a reel: an injected deck carries clips the build has
      // never seen, so the player pushes them in on load and the slide rebuilds
      // around them (re-registering, which re-announces the panel count above).
      // Routed here rather than listened for in video.html so slides keep exactly
      // one message surface. See docs/narrated-decks.md.
      case 'set-clips':
        if (window.WccReel && WccReel.setClips) WccReel.setClips(d.videos || []);
        break;
      // Panel subset for this deck entry: the editor kept only some of the slide's
      // panels. Routed here beside `set-clips` for the same reason — one message
      // surface per slide — and applied generically, so every carousel template
      // gets it without knowing it exists.
      case 'set-panels':
        // Reels are excluded by design: their atoms are finer than their panels (a
        // card hold is a stop *inside* a clip), so a clip subset is `set-clips`,
        // which already exists and carries the trims with it. Applying both would
        // give two disagreeing notions of what clip 3 is.
        if (window.WccReel) break;
        sel = Array.isArray(d.panels) ? d.panels.slice() : null;
        clampSel();
        if (ctrl) {
          // The subset changed under the slide; land on a panel that still exists.
          // pauseAuto for the same reason restart-auto refuses to start it.
          ctrl.pauseAuto();
          show(0);
        }
        post('wcc-slide');
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

  /* Swipe, reported to the player — BOTH axes.
   *
   * The player owns navigation, so this only *reports*: the slide says "a thumb
   * went sideways across me" and player-core decides what that means (its own
   * next()/prev() — the same atom move the control bar makes).
   *
   * Why it lives in the slide rather than in the player, where every other
   * gesture does: the portrait column (portrait.js) has no gesture layer over the
   * slide, deliberately. The landscape player covers every slide with `#wcc-tap`
   * and reads swipes off that, but a fixed full-viewport overlay swallows the
   * scroll of a column that scrolls, and an overlay confined to the band would
   * swallow the slide's own links and — being a non-`auto` touch-action — WebKit's
   * pinch-zoom with it (see the touch-action note in player-core). Leaving the
   * slide exposed is what makes links, taps and pinch work there for free; the
   * cost is that a swipe over it has to be noticed here.
   *
   * So this is inert wherever the player has its own layer: in landscape and in
   * record mode `#wcc-tap` is above the iframe and these events never arrive.
   * No flag is needed to tell the two apart — the geometry already does.
   *
   * VERTICAL is reported too, and it has to be: the portrait column stopped being
   * a scroller (portrait.js), so a vertical drag on a band no longer chains into a
   * parent that scrolls — there is no longer one. The band is an iframe, so this is
   * the only place that drag can be noticed at all. The player routes the two axes
   * differently, which is the pairing the design doc names: VERTICAL is the step
   * axis (leave this slide), HORIZONTAL is the axis inside a step (next()/prev(),
   * the atom move — so a reel steps clip by clip while a vertical swipe leaves the
   * reel entirely).
   *
   * Thresholds are FRACTIONS of the viewport, never px: a slide lays out in a
   * fixed 1920x1080 box scaled into the band, so its clientX is in design px and
   * 45 of them is about 9 real ones on a phone.
   */
  function bindSwipe() {
    var start = null, fired = false;
    var MAX_MS = 700;        // longer than this is a drag, not a swipe (X only)
    var SLOP = 0.10;         // of viewport WIDTH — sideways travel to count
    var EDGE = 0.05;         // of viewport width — dead strip at each side
    var DOMINANCE = 1.5;     // how much more one axis than the other

    /* Vertical wants a much bigger fraction than horizontal, and the reason is the
     * design box rather than taste. A band is fitted to the screen's WIDTH, so a
     * fraction of 1920 design px is the same fraction of the screen — 0.10 across
     * is 0.10 across. Height does not work that way: the band is 1080 design px
     * tall but only `screenWidth x 9/16` real px, so 0.10 of it is about 0.056 of
     * the screen's width and a fifth of what the same gesture needs on the matte
     * beside the band. 0.25 lands a band drag on the same real distance as
     * `armMatte`'s 8%-of-the-deck, so one gesture feels like one gesture wherever
     * the thumb happens to be. */
    var V_SLOP = 0.25;       // of viewport HEIGHT — see above

    function post(msg) {
      try { parent.postMessage(msg, '*'); } catch (err) { /* not embedded */ }
    }

    document.addEventListener('touchstart', function (e) {
      start = null; fired = false;
      if (e.touches.length !== 1) return;
      var t = e.touches[0], w = window.innerWidth || 1920;
      // iOS Safari's left-edge swipe is browser-back and cannot be prevented. We
      // can at least decline to ALSO navigate the deck, so one gesture does one
      // thing. The right edge is dead for symmetry (forward, in the same idiom).
      if (t.clientX < w * EDGE || t.clientX > w * (1 - EDGE)) return;
      start = { x: t.clientX, y: t.clientY, at: Date.now() };
    }, { passive: true });

    /* VERTICAL fires HERE, mid-drag, and horizontal deliberately does not.
     *
     * Vertical is the step axis, and every other route to it — `armMatte` on the
     * matte, `armCommit` past the end of a fragment — acts the moment the threshold
     * is crossed. Leaving the band on the touchend path made it the odd one out
     * twice over: a deliberate slow drag on a photograph exceeded MAX_MS and was
     * discarded, and even a quick one did nothing until the thumb lifted. The band
     * is most of what a reader touches, so the surface felt dead exactly where they
     * were aiming.
     *
     * Horizontal stays a flick decided at touchend. It is the atom move, it is
     * shared with the landscape player, and firing it mid-drag would let a diagonal
     * that was on its way to becoming a vertical drag change a clip first. */
    document.addEventListener('touchmove', function (e) {
      if (!start || fired || e.touches.length !== 1) return;
      var t = e.touches[0], h = window.innerHeight || 1080;
      var dx = t.clientX - start.x, dy = t.clientY - start.y;
      var ax = Math.abs(dx), ay = Math.abs(dy);
      if (ay < h * V_SLOP || ay < ax * DOMINANCE) return;
      fired = true;
      post({ type: 'wcc-swipe', axis: 'y', dir: dy < 0 ? 'next' : 'prev' });
    }, { passive: true });

    document.addEventListener('touchend', function (e) {
      var s = start; start = null;
      // Already answered as a vertical drag: the gesture is spent.
      if (!s || fired || Date.now() - s.at > MAX_MS) return;
      var t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      var w = window.innerWidth || 1920;
      var dx = t.clientX - s.x, dy = t.clientY - s.y;
      // One axis or the other, never both: the dominance test is what stops a lazy
      // diagonal from counting as whichever axis it happened to travel furthest on.
      if (Math.abs(dx) < w * SLOP || Math.abs(dx) < Math.abs(dy) * DOMINANCE) return;
      post({ type: 'wcc-swipe', axis: 'x', dir: dx < 0 ? 'next' : 'prev' });
    }, { passive: true });

    document.addEventListener('touchcancel', function () { start = null; });
  }

  /* Surface.
   *
   * A slide renders for the wall by default. `?interactive=1` says it is embedded
   * in a player the viewer can touch — the bar iPad, or a phone following a link
   * we sent a prospective hirer. That distinction is not cosmetic: a QR code is
   * the only way to hand a URL to someone standing in front of a television, and
   * it is useless on the device already in their hand, which can simply be tapped.
   *
   * `body.interactive` lets CSS pick between the two, so one slide serves both
   * surfaces and they cannot drift apart. Same reasoning as ctx above, and the
   * flag arrives the same way — on the iframe URL (see FRAME_Q in player.html),
   * because a windowed deck reloads its frames as it moves and a URL survives
   * that with no handshake.
   *
   * Anything the class reveals must be inert on the wall: a link is not tappable
   * there, so it may never be the only route to the information.
   */
  function applySurface() {
    var interactive = false;
    try {
      interactive = new URLSearchParams(location.search).get('interactive') === '1';
    } catch (e) { /* older engine */ }
    document.body.classList.add(interactive ? 'interactive' : 'wall');
    if (interactive) showCursor();
  }

  /* Every slide sets `cursor: none` (the wall has no pointer and a stray arrow
   * parked on a television is the giveaway that it is a browser). That is wrong
   * the moment a person is pointing at it.
   *
   * It used to be masked rather than handled: the player's full-surface gesture
   * layer sat over every slide with `cursor: default`, so what you saw was the
   * LAYER's cursor, never the slide's. The player even claims to override the
   * slide bases — it cannot, being a different document. As soon as a slide asks
   * that layer to stand down (`data-taps`, so its links can be clicked) the
   * slide's own rule showed through and the pointer vanished over exactly the
   * slides you most need to point at.
   *
   * Injected rather than written into each template's `*` rule so one fix covers
   * both bases and every standalone template. `*` is specificity 0,0,0, so any
   * element that names its own cursor (`.link { cursor: pointer }`) still wins. */
  function showCursor() {
    var st = document.createElement('style');
    st.textContent = '*{cursor:auto}';
    document.head.appendChild(st);
  }

  function applyFlags() {
    applyContext();
    applySurface();
    bindSwipe();
  }

  // video.html loads this in <head>, so <body> may not exist yet.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyFlags);
  } else {
    applyFlags();
  }
})();

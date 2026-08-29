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

  function post(type, extra) {
    try {
      parent.postMessage(Object.assign(
        { type: type, panel: toOrd(current), panels: nPanels() }, edge(), extra || {}), '*');
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

  // video.html loads this in <head>, so <body> may not exist yet.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyContext);
  } else {
    applyContext();
  }
})();

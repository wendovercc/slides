/* portrait.js — the phone surface, in its letterbox-fallback form.
 *
 * docs/portrait-decks.md, phase 0. A deck opened in portrait on a phone becomes a
 * COLUMN of full-height steps that snap, instead of a 16:9 rectangle floating in
 * the middle of the screen. Vertical is forward.
 *
 * This is the fallback rendering the doc calls "the one case iframes earn their
 * place": a template with no portrait layout shows its existing 16:9 self in a
 * band, and that genuinely is another document. It is also the EASY iframe — a
 * band's height is exactly `width x 9/16`, known before it loads, so a step's
 * geometry never depends on measuring what is inside it. Every deck we already
 * build gets a phone surface from this one file, and per-template portrait
 * fragments (phase 1 onward) replace bands one template at a time.
 *
 * What this file is NOT: a second player. It owns geometry and the input that is
 * geometric (scroll, and a tap on the matte). Transport, panel timers, atom
 * pacing, holds, video, windowing and the reload all stay in player-core.js,
 * which drives this through the `stage` seam — see `opts.stage` there. The two
 * surfaces must never become two ideas of what a deck is.
 *
 * ---- what a step is ----
 * A step is what /deck gives one row to, and that is not a new rule — it is
 * `childrenOf()` in deck.js: a package counts its members, a carousel its panels,
 * and a reel counts as one however many clips it holds.
 *
 * Not the wall's TAB STRIP, which is coarser — a match package's strip reads
 * "1st Innings" over three steps (highlights, batting, bowling). The strip groups
 * steps into phases, so `step` and `phase` are different words on purpose.
 *
 *   carousel slide  → one step per panel   (fantasy-league: 4, team-1st-xi: 6)
 *   video reel      → ONE step, all clips  (a 20-clip innings is not 20 screens)
 *   everything else → one step
 *
 * So the column is a flat list of steps and scrolling always means the same thing:
 * forward, by one step. Getting this wrong is what made a phone visitor's `teams`
 * deck a single screen that would not scroll, with five of its six panels behind a
 * timer. A reel stays one step deliberately: its clips are an authored sequence
 * with their own time, and the doc rejects the vertical-feed reading of them.
 *
 * Within a slide the band is STICKY, so panels change under a pinned slide and
 * only crossing into another slide moves it. That is the whole mechanism: one
 * scroller, uniform step heights, and a table mapping scroll position to
 * (slide, panel).
 *
 * ---- orientation ----
 * The surface is decided at boot (WccPlayer.surface) and upgrades one way, live,
 * on a rotation into portrait (WccPlayer.setStage). It does not switch back — see
 * the note in templates/player.html.
 */
(function () {
  var styled = false;

  function injectCss() {
    if (styled) return;
    styled = true;
    var css =
      // The wall's 16:9 stage has nothing to do here. Its live chrome (ticker,
      // strip, flash) is a property of a wall on a match day and the template
      // withholds it in portrait, so this hides an empty box.
      'body.wcc-portrait #stage{display:none;}' +

      /* The deck: one scroller, `position:fixed` because the player's html/body are
         overflow:hidden (they letterbox a stage; nothing there ever scrolled).
         Snap is `mandatory` and safe HERE — the case the doc rejects it for is a
         step taller than the viewport, which strands a reader mid-section, and
         every step in this column is exactly one screen by construction. Vertical
         overscroll-behavior:contain keeps the bounce at the end of the deck from
         becoming the browser's pull-to-refresh. */
      '#wcc-pdeck{position:fixed;inset:0;z-index:5;overflow-y:auto;overflow-x:hidden;' +
      'scroll-snap-type:y mandatory;overscroll-behavior-y:contain;' +
      '-webkit-overflow-scrolling:touch;background:var(--matte,#08152c);}' +

      /* A slide occupies as many steps as it has panels. Its height is not stated
         here — it is the sum of its children: the sticky band's one step plus a
         mark for each step after it. */
      '.pslide{position:relative;}' +

      /* One empty full-screen block per step AFTER the first, which the sticky band
         above occupies. Between them they decide the slide's height (steps x one
         screen) and carry the snap points — plain in-flow boxes, the case
         scroll-snap handles most predictably.

         `--pstep-h` is one scrollport in px, measured in JS, NOT `100dvh`: the
         current step is read as `scrollTop / stepHeight`, and iOS resolves a fixed
         element's box and `dvh` against different viewports while the browser
         chrome collapses — enough drift to round to the wrong step. */
      '.pmark{height:var(--pstep-h,100dvh);scroll-snap-align:start;}' +

      /* The band, pinned across its slide's run of steps.
         A sticky box travels by (containing-block height − its own margin-box
         height), and that is the SAME quantity as what it contributes to the flow —
         so the two cannot both be zero, and the band must occupy its step. Height
         one step gives travel of (steps − 1) screens, which is exactly right: pinned
         while its own panels change, released as its last step scrolls past.
         An earlier version made this zero-height to keep it out of the flow, which
         bought a travel of `steps` screens instead: every band stayed pinned one step
         too long, so the slide seen scrolling away at a transition was the one two
         back. Nothing here may be zero-height. */
      '.psticky{position:sticky;top:0;height:var(--pstep-h,100dvh);z-index:1;' +
      'display:flex;align-items:center;justify-content:center;}' +
      /* Which leaves the first step with no in-flow snap target of its own — the
         marks below start one step in. A zero-height box at the slide's top edge is
         one, and adds nothing to the height. (Deliberately not `scroll-snap-align`
         on the sticky box itself: its snap area would travel with the stickiness and
         could hold the scroller against it.) */
      '.psnap{height:0;scroll-snap-align:start;}' +

      /* The band. Full-bleed width in portrait; capped by height so that a rotated
         phone (or an iPad) gets a band that fits rather than one that overflows. */
      '.pband{position:relative;width:min(100%, calc(var(--pstep-h,100dvh) * 16 / 9));' +
      'aspect-ratio:16/9;overflow:hidden;background:#000;}' +

      /* The slide, laid out at the wall's fixed 1920x1080 design box and scaled
         into the band by --pfit. This is the one place the design box survives in
         portrait, and it survives for the same reason it exists on the wall: slide
         type is sized in vw, and a slide given a phone-sized viewport resolves
         those to a handful of CSS px where WebKit stops honouring them and the
         last rows of a scorecard fall out the bottom. Scoped to the band — nothing
         else in portrait is laid out this way.
         visibility/opacity are stated because the wall's stack hides every
         inactive frame; here every live frame is on screen in its own step and
         only the windowing (player-core) decides which exist at all. */
      '.pband>iframe{position:absolute;top:0;left:0;width:1920px;height:1080px;' +
      'border:0;transform-origin:top left;transform:scale(var(--pfit,1));' +
      'visibility:visible;opacity:1;}' +

      /* Progress rail — where you are in the DECK, counted in steps (the control
         bar's gold fill is the countdown within one step, which is a different
         question). Sits in the matte just under the band, so it never covers slide
         content. */
      '#wcc-prail{position:fixed;left:50%;transform:translateX(-50%);z-index:58;' +
      'top:calc(50% + var(--pband-h,0px) / 2 + 2.4vmax);' +
      'width:32vw;height:0.3vmax;border-radius:0.3vmax;' +
      'background:rgba(255,255,255,0.18);overflow:hidden;pointer-events:none;}' +
      '#wcc-prail i{display:block;width:100%;height:100%;background:#d4af37;' +
      'transform-origin:left;transform:scaleX(0);transition:transform 0.35s ease;}' +
      /* No matte to sit in — a 16:9-or-wider viewport, which is what a portrait deck
         becomes when the phone is turned (the surface does not switch back; see the
         orientation note at the top). The rail goes flush to the bottom edge as a
         full-width hairline rather than floating over the slide. */
      'body.wcc-pflush #wcc-prail{top:auto;bottom:0;left:0;width:100%;' +
      'transform:none;border-radius:0;}' +

      /* Share. The deck's distribution model IS being forwarded, and until now it
         had no forward button. Top matte, and top-LEFT deliberately: the control
         bar takes the bottom band in portrait and the top-RIGHT corner when it has
         no band to sit in (placeBar's `inside`), which is where a rotated phone
         puts it. Left is the corner neither placement ever claims. */
      '#wcc-pshare{position:fixed;z-index:58;top:calc(var(--sa-t,0px) + 1.4vmax);' +
      'left:calc(var(--sa-l,0px) + 1.4vmax);width:4.7vmax;height:4.7vmax;' +
      'border:1px solid rgba(212,175,55,0.45);border-radius:50%;' +
      'background:rgba(10,28,58,0.82);color:#fff;cursor:pointer;display:flex;' +
      'align-items:center;justify-content:center;padding:0;' +
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;}' +
      '#wcc-pshare:active{background:rgba(212,175,55,0.32);}' +
      '#wcc-pshare svg{width:2.2vmax;height:2.2vmax;fill:none;stroke:#fff;' +
      'stroke-width:2;stroke-linejoin:round;stroke-linecap:round;}';
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  var SHARE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" />' +
    '<circle cx="18" cy="19" r="3" /><line x1="8.6" y1="10.5" x2="15.4" y2="6.5" />' +
    '<line x1="8.6" y1="13.5" x2="15.4" y2="17.5" /></svg>';

  /* How many steps a slide is worth. THE definition, and deliberately the same one
   * `childrenOf()` applies in deck.js — a row there is a step here, so a deck the
   * editor built as "4 steps" scrolls as four. A reel is one however many clips it
   * holds, which is why `video` is tested before `atoms`. Verified against every
   * slide of every built deck; if this and childrenOf ever disagree, they are both
   * wrong, because they are answering the same question. */
  function stepsFor(s) {
    if (!s || s.video) return 1;
    return s.atoms > 1 ? s.atoms : 1;
  }

  /* Build the column. Called by the player template BEFORE it creates the slide
   * iframes, so each frame is appended straight into its own band — an iframe moved
   * after the fact reloads — and called again by WccPlayer.setStage when a deck
   * already running in landscape swaps onto this stage, where re-homing the frames
   * is exactly what it costs.
   *
   * `opts.slides` is [{ atoms, video }] in play order.
   *
   * Returns { host(i), keep(indices), stage }.
   */
  function create(opts) {
    opts = opts || {};
    var list = opts.slides || [];
    injectCss();
    document.body.classList.add('wcc-portrait');

    var deck = document.createElement('div');
    deck.id = 'wcc-pdeck';
    var bands = [];       // one band per SLIDE — the iframe's home
    var slideEls = [];    // its .pslide wrapper
    var pos = [];         // the step table: pos[k] = { slide, panel }
    var first = [];       // first[slide] = index of its first step

    /* The step table, derived from the slide list. Kept apart from the DOM below
     * because it is the only thing `keep()` may safely recompute: a band holds a
     * live iframe, and re-creating one — or merely moving it — reloads the slide. */
    function retable() {
      pos = []; first = [];
      for (var i = 0; i < list.length; i++) {
        first.push(pos.length);
        var steps = stepsFor(list[i]);
        for (var p = 0; p < steps; p++) pos.push({ slide: i, panel: p });
      }
    }

    function build() {
      deck.innerHTML = '';
      bands = []; slideEls = [];
      retable();
      for (var i = 0; i < list.length; i++) {
        var steps = stepsFor(list[i]);
        var el = document.createElement('div');
        el.className = 'pslide';
        el.dataset.slide = String(i);
        // Zero-height snap target for the slide's first step (see .psnap).
        var snap = document.createElement('div');
        snap.className = 'psnap';
        el.appendChild(snap);
        // The band, one step tall and sticky across the rest.
        var sticky = document.createElement('div');
        sticky.className = 'psticky';
        var band = document.createElement('div');
        band.className = 'pband';
        sticky.appendChild(band);
        el.appendChild(sticky);
        // A mark per REMAINING step: the sticky band is the first one's height.
        for (var m = 1; m < steps; m++) {
          var mark = document.createElement('div');
          mark.className = 'pmark';
          el.appendChild(mark);
        }
        deck.appendChild(el);
        bands.push(band);
        slideEls.push(el);
      }
    }
    build();
    document.body.appendChild(deck);

    var api = null;                 // the transport, handed over by attach()
    var rail = null;
    var atSlide = 0, atPanel = 0;   // where the PLAYER says it is

    /* ---- geometry ---- */
    function stepH() { return deck.clientHeight || 1; }
    function fit() {
      var h = deck.clientHeight;
      if (!h) return;
      var root = document.documentElement.style;
      // One scrollport in px, so a step's height and `deck.clientHeight` are the
      // same number by construction — see .pmark.
      root.setProperty('--pstep-h', h + 'px');
      if (!bands.length) return;
      var w = bands[0].clientWidth;
      if (!w) return;
      root.setProperty('--pfit', w / 1920);
      var bh = w * 9 / 16;
      root.setProperty('--pband-h', bh + 'px');
      // How much matte a step has left over, which is what decides whether the
      // chrome has anywhere of its own to stand. A phone turned landscape leaves
      // none: the band grows until it is the step.
      var vmax = Math.max(window.innerWidth, window.innerHeight) / 100;
      document.body.classList.toggle('wcc-pflush', (h - bh) / 2 < 3.6 * vmax);
    }
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);

    function indexAt() {
      return Math.max(0, Math.min(pos.length - 1,
                                  Math.round(deck.scrollTop / stepH())));
    }

    /* ---- reaching a step ----------------------------------------------------
     * Two directions, one position. The player calls show()/showAtom() when the
     * transport moves (a bar press, a panel timer running out, the deck opening);
     * the scroll listener calls back into the player when the reader moves.
     * `pending` is what keeps those from echoing: a smooth scroll we started fires
     * the same events a thumb does, and reporting the steps it passes through would
     * re-arrive on every one between here and there. */
    var pending = -1;
    var pendingTimer = null;
    var settleTimer = null;

    function clearPending() {
      pending = -1;
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    }

    function scrollToPos(k) {
      drawRail(k);
      var top = k * stepH();
      // Already there (the common case when the reader scrolled us here): don't arm
      // `pending`, or the next genuine settle would be swallowed as ours.
      if (Math.abs(deck.scrollTop - top) < 2) { clearPending(); return; }
      pending = k;
      if (pendingTimer) clearTimeout(pendingTimer);
      // Backstop: a smooth scroll that never settles (interrupted by a thumb, or a
      // browser that drops the animation) must not leave scroll reporting disabled
      // for the rest of the session.
      pendingTimer = setTimeout(clearPending, 1200);
      try { deck.scrollTo({ top: top, behavior: 'smooth' }); }
      catch (e) { deck.scrollTop = top; }   // older engine: no options object
    }

    // The player arrived at a slide. Its panel is not settled yet (applyState runs
    // next and answers with showAtom), so this goes to the slide's FIRST step.
    function show(i) {
      if (first[i] == null) return;
      atSlide = i; atPanel = 0;
      scrollToPos(first[i]);
    }

    // The player is on a definite panel — an arrival settling, a bar press, a timer,
    // or the slide's own echo. This is what keeps the column in step with the
    // transport when the viewer drives from the control bar rather than by scrolling.
    function showAtom(i, p) {
      if (first[i] == null) return;
      atSlide = i;
      atPanel = Math.max(0, Math.min(stepsFor(list[i]) - 1, p || 0));
      scrollToPos(first[i] + atPanel);
    }

    function settle() {
      var k = indexAt();
      if (pending >= 0) {
        var t = pending;
        clearPending();
        if (k === t) return;    // our own scroll, arrived — nothing to report
      }
      var p = pos[k];
      if (!p || !api) return;
      if (p.slide !== atSlide) {
        // Crossing into another slide. It opens at ITS first step, which is also
        // where a fling that lands mid-slide settles — the doc's forgiving commit.
        // The alternative, replaying panel steps into a slide that is still being
        // reset, is a race for no gain.
        api.goTo(p.slide);
        return;
      }
      var delta = p.panel - atPanel;
      if (!delta) return;
      // Step within the slide. `next`/`prev` are the transport's own atom moves, so
      // a scrolled panel change is the same event as a pressed one — holds, reel
      // cards and the countdown all behave identically either way.
      var stepFn = delta > 0 ? api.next : api.prev;
      for (var z = Math.abs(delta); z > 0; z--) stepFn();
    }

    deck.addEventListener('scroll', function () {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, 110);
    }, { passive: true });

    /* ---- input --------------------------------------------------------------
     * No gesture overlay (see the guard in player-core's buildControls): the band
     * is an iframe, so a tap on the SLIDE stays in the slide — which is how a
     * slide's own links keep working with no tap-through machinery at all — and
     * only a tap on the matte reaches here. That tap toggles play/pause, the same
     * as a tap anywhere does on the wall's surface.
     *
     * Vertical drags are left entirely to the scroller. Horizontal swipe is NOT
     * bound: the step axis is vertical here, and iOS Safari's left-edge swipe is
     * browser-back — a horizontal gesture that navigated would carry a reader out
     * of a link we sent them. */
    var gp = null, lastTapAt = 0;
    var TAP_SLOP = 10, TAP_MAX_MS = 500, DBLTAP_MS = 300;
    deck.addEventListener('pointerdown', function (e) {
      gp = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
    });
    deck.addEventListener('pointerup', function (e) {
      if (!gp || e.pointerId !== gp.id) return;
      var dx = Math.abs(e.clientX - gp.x), dy = Math.abs(e.clientY - gp.y);
      var dt = Date.now() - gp.t;
      gp = null;
      if (dx > TAP_SLOP || dy > TAP_SLOP || dt > TAP_MAX_MS) return;
      // Swallow the second tap of a double-tap: touch-action stays `auto` here for
      // the same reason it does on the wall's tap layer (it is the only value that
      // pinches in a Safari tab), which brings double-tap-to-zoom back with it.
      var now = Date.now();
      if (now - lastTapAt < DBLTAP_MS) { lastTapAt = 0; return; }
      lastTapAt = now;
      if (api) api.toggle();
    });
    deck.addEventListener('pointercancel', function () { gp = null; });

    /* ---- chrome -------------------------------------------------------------
     * Two things only, both earned by any deck: where you are, and a way to pass it
     * on. Everything else the doc lists (sticky titles, a contents sheet) is earned
     * per deck and none of the decks that exist today earn it. */
    function drawRail(k) {
      if (!rail || pos.length < 2) return;
      rail.style.transform = 'scaleX(' + ((k + 1) / pos.length) + ')';
    }

    function buildChrome() {
      if (pos.length > 1) {
        var r = document.createElement('div');
        r.id = 'wcc-prail';
        rail = document.createElement('i');
        r.appendChild(rail);
        document.body.appendChild(r);
        drawRail(indexAt());
      }
      // Share, where the browser has it. The URL is the canonical one the link
      // preview was baked against (og:url), not location.href — which may carry the
      // ?deck= / ?k= query that got us here and is nobody else's business.
      if (!navigator.share) return;
      var og = document.querySelector('meta[property="og:url"]');
      var url = (og && og.content) || location.origin + location.pathname;
      var b = document.createElement('button');
      b.id = 'wcc-pshare';
      b.type = 'button';
      b.setAttribute('aria-label', 'Share');
      b.innerHTML = SHARE_ICON;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        try { navigator.share({ title: document.title, url: url }).catch(function () {}); }
        catch (err) { /* user cancelled, or share refused — nothing to recover */ }
      });
      document.body.appendChild(b);
    }

    return {
      host: function (i) { return bands[i]; },
      /* Drop the slides that didn't make it into the played deck.
       *
       * The column is built before the loading gate runs, because the frames have to
       * be created inside it; the gate can then drop a video slide whose clips failed
       * to store, and the player is started on what's left. Without this the column
       * and the item list would disagree about what slide 4 is. Takes the ORIGINAL
       * indices that survived, in order.
       *
       * PRUNES, and must: by the time this is called every surviving band already
       * holds its slide's iframe, and an iframe reloads if its ancestor is recreated
       * OR merely moved. So the surviving `.pslide` elements are left exactly where
       * they are and only the dropped ones are removed; the step table is recomputed
       * from the shortened list. Rebuilding the column here — which an earlier
       * version did, unconditionally, since this runs whether or not anything was
       * dropped — detached every frame and left a deck of black bands. */
      keep: function (indices) {
        var wanted = {};
        for (var k = 0; k < indices.length; k++) wanted[indices[k]] = true;
        var keptList = [], keptBands = [], keptEls = [];
        for (var i = 0; i < list.length; i++) {
          if (wanted[i]) {
            keptList.push(list[i]); keptBands.push(bands[i]); keptEls.push(slideEls[i]);
            slideEls[i].dataset.slide = String(keptEls.length - 1);
          } else if (slideEls[i] && slideEls[i].parentNode) {
            slideEls[i].parentNode.removeChild(slideEls[i]);
          }
        }
        list = keptList; bands = keptBands; slideEls = keptEls;
        retable();
        fit();
      },
      stage: {
        // The player's gesture layer stands down; this file takes the tap.
        ownsInput: true,
        show: show,
        showAtom: showAtom,
        attach: function (transport) { api = transport; buildChrome(); },
        // Where frame i belongs. Read at boot by the template, which creates the
        // frames straight into their bands, and again by WccPlayer.setStage when a
        // deck already running in landscape swaps onto this stage — there it is what
        // re-homes the frames, at the cost of reloading the live ones.
        host: function (i) { return bands[i]; }
      }
    };
  }

  window.WccPortrait = { create: create };
})();

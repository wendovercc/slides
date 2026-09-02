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
 *                       Input (identical in watch and record mode):
 *                         horizontal swipe / arrows = prev/next
 *                         tap / Space                = play/pause (+ centre flash)
 *                         Home/End = first/last, f = fullscreen.
 *   ?record           — interactive mode with a narration recorder attached: a HUD
 *                       strip, a continuous audio take, and cue/freeze timestamps
 *                       stamped as the narrator plays. One subtraction (prev is
 *                       disabled — a take plus a jump backwards is incoherent) and
 *                       nothing else changes, so a tap does here exactly what it
 *                       does on the bar iPad. See docs/narrated-decks.md.
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
    grip: '<line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" />',
    // Stroke-only three-node share glyph (fill:none via the .share button class):
    // filled, the circles and their connecting lines become three dots and a smear.
    share: '<circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" />' +
           '<circle cx="18" cy="19" r="3" /><line x1="8.6" y1="10.5" x2="15.4" y2="6.5" />' +
           '<line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />'
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
      '#wcc-bar{position:fixed;z-index:60;display:flex;' +
      'gap:max(6px,0.6vmax);padding:max(7px,0.7vmax) max(6px,0.6vmax);' +
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
      /* DOCKED: the portrait column's own placement, and the only one that is not a
         float. The bar spans the bottom edge as a toolbar and the stage shortens its
         scroller by exactly this height (see `chrome` in portrait.js), so nothing
         ever scrolls behind it — which is the difference between a phone app and a
         slideshow with a widget on top of it. The other three placements can float
         because they sit in a letterbox band, over nothing; a portrait deck is
         full-bleed and has no band to give away.
         Opaque, square, and no blur: it is an edge of the interface rather than a
         pane over the content, and a backdrop filter over content that is no longer
         behind it is a compositing layer bought for nothing. The bottom padding
         carries the safe-area inset, so the buttons clear the home indicator and the
         bar's own colour fills the strip under it. */
      '#wcc-bar.place-portrait{flex-direction:row;justify-content:center;' +
      'left:0;right:0;bottom:0;border-radius:0;border:none;' +
      'border-top:1px solid rgba(212,175,55,0.28);background:#08152c;' +
      'backdrop-filter:none;-webkit-backdrop-filter:none;box-shadow:none;' +
      'transform:none;padding:max(7px,0.7vmax) max(6px,0.6vmax) ' +
      'calc(max(7px,0.7vmax) + var(--sa-b,0px));}' +
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
      /* ONE SIZE SCALE, AND IT APPLIES IN EVERY PLACEMENT. `vmax` is the right unit
         for a control read across a room — it holds its apparent size as the wall
         changes — and it is the wrong one on its own for a control pressed with a
         thumb, where 44pt is 44pt on every phone whatever the screen measures. So
         both: `vmax` above the floor, the floor below it.
         The floor used to be on `place-portrait` alone, which quietly made the SAME
         PHONE fail when it was turned. `4.7vmax` resolves against the LONGER edge,
         so on a 390x844 iPhone it is ~40px held either way — under the floor in
         portrait (where Safari's own toolbar sits directly beneath, and a missed
         press hits that instead) and equally under it in landscape, where the bar
         lands in `inside` placement and nothing was catching it at all.
         The gap and the padding are floored with it, or the buttons grow and the
         bar closes up around them. The glyph is floored too but at a gentler ratio:
         it is drawn INSIDE the target, and a 48px circle wants a ~22px glyph. */
      '#wcc-bar button{width:max(48px,4.7vmax);height:max(48px,4.7vmax);' +
      'border:none;border-radius:50%;background:transparent;' +
      'color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none;' +
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;}' +
      '#wcc-bar button:active{background:rgba(255,255,255,0.12);}' +
      '#wcc-bar button.primary{background:rgba(212,175,55,0.18);}' +
      '#wcc-bar button.primary:active{background:rgba(212,175,55,0.32);}' +
      '#wcc-bar svg{width:max(22px,2.35vmax);height:max(22px,2.35vmax);' +
      'fill:#fff;stroke:#fff;stroke-width:2;stroke-linejoin:round;stroke-linecap:round;}' +
      '#wcc-bar button.primary svg{fill:#d4af37;stroke:#d4af37;}' +
      // Outlined glyphs: corner brackets, the grip, and the share nodes are all
      // drawn rather than filled — filled, share becomes three dots and a smear.
      '#wcc-bar button.fs svg,#wcc-bar button.share svg{fill:none;}' +
      /* ---- THE TWO DECK INSTRUMENTS ----------------------------------------
         Two gold hairlines, and ONE rule for where they go on every surface and in
         every orientation:

             TOP edge    = where you are in the DECK, counted in atoms.
             BOTTOM edge = time left on the atom you are ON.

         Welded to the viewport, not to the control bar and not to the letterbox.
         The countdown used to be a child of `#wcc-bar`, which meant it moved every
         time the bar's placement changed — the bar's BOTTOM edge in `below`, a
         vertical strip on its side in `right`/`inside`, the dock's TOP edge in
         portrait — and it had to grow along a different axis in each. Same
         instrument, four positions and two axes, so a reader who learned it in one
         orientation had to learn it again in the other. Welding it to the screen
         costs nothing and deletes the axis entirely: the fill is always `scaleX`,
         which is why there is no `progressAxis` here any more.

         The one thing the rule yields to is CHROME THAT DOCKS AGAINST AN EDGE — the
         portrait toolbar, and the live ticker and its matte strip. A line under the
         dock is invisible and half of it is under the home indicator; a line across
         the ticker is a gold hairline drawn over the ticker's own gold. So the lines
         bound the READING AREA: the viewport, less anything actually sitting on an
         edge. A letterbox band is not chrome — it is nothing — so the lines ignore
         it and run to the glass. `layoutInstruments()` measures the insets.

         Distinguished by FORM as well as position, because both are gold (the
         brand's sole accent): the position rail is SEGMENTED — one tick per atom,
         filled up to where you are — and the countdown is a continuous sweep. Ticks
         answer "how many", which is the question a first screen raises; a sweep
         answers "how long", which is the question a playing deck raises. Long decks
         lose the ticks (see `TICK_MAX`): eighty-nine of them is a dotted line, not
         a count. */
      '#wcc-prog-top,#wcc-prog-bot{position:fixed;z-index:59;pointer-events:none;' +
      'box-sizing:border-box;height:max(3px,0.4vmax);overflow:hidden;}' +
      // Position: one flex tick per atom, hairline gaps, unfilled ticks in neutral.
      '#wcc-prog-top{top:var(--sa-t,0px);left:0;right:0;display:flex;gap:2px;padding:0 2px;}' +
      '#wcc-prog-top i{display:block;flex:1 1 0;height:100%;' +
      'background:rgba(255,255,255,0.18);transition:background 0.3s ease;}' +
      '#wcc-prog-top i.on{background:#d4af37;}' +
      // The continuous fallback: one child, scaled, on a track of its own.
      '#wcc-prog-top.cont{gap:0;padding:0;background:rgba(255,255,255,0.14);}' +
      '#wcc-prog-top.cont i{background:#d4af37;transition:transform 0.35s ease;' +
      'transform-origin:left;transform:scaleX(0);}' +
      /* Countdown: HIDDEN WHILE PAUSED. It is a time instrument, and paused there is
         no time passing — welded to the bar an empty track read as part of the bar,
         but alone on the screen's bottom edge it is a conspicuous gold line that
         never means anything to the many readers who never press play. The position
         rail above stays up always: where you are is true either way. */
      '#wcc-prog-bot{bottom:0;left:0;right:0;background:rgba(212,175,55,0.16);' +
      'opacity:0;transition:opacity 0.3s ease;}' +
      '#wcc-prog-bot.on{opacity:1;}' +
      '#wcc-prog-bot i{display:block;width:100%;height:100%;background:#d4af37;' +
      'transform-origin:left;transform:scaleX(0);}';
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
  function windowRadius(params, surf) {
    var v = params.get('window');
    if (v === 'off' || v === 'none') return null;
    if (v != null && /^\d+$/.test(v)) return parseInt(v, 10);
    /* Windowed whenever the SURFACE is interactive, not merely when the URL says so.
     * The URL test used to stand in for "a phone", and two decks slipped through it:
     * a standalone deck (the pavilion — interactive by its own claim, with no query
     * string, which is the whole point of the link we send) and now a portrait one,
     * where a 38-slide deck would otherwise hold 38 live documents on exactly the
     * device the windowing exists to protect (project_ios_pwa_crash). `surf` is
     * optional so an older caller keeps the old test. */
    if (surf) return surf.interactive ? 1 : null;
    return (params.has('interactive') || params.has('record')) ? 1 : null;
  }

  /* The surface rule, in ONE place.
   *
   * Two callers need it and they must never disagree: start() below, to decide
   * whether to build controls, and the player TEMPLATE, which has to stamp
   * `?interactive=1` onto every slide iframe *before* start() is called (a slide
   * reads it from its own URL — see applySurface in slide-bridge.js). When the
   * template kept its own copy of the rule, a deck could be interactive while its
   * slides still rendered their wall variant: controls you could press, over a QR
   * code meant for someone standing at a television.
   *
   * `deckStandalone` is the deck's own claim (content/slideshows/<slug>.json). The
   * caller is responsible for withholding it on a wall — see player.html, where
   * screen mode passes false, because the surface beats the deck's idea of itself. */
  function surface(deckStandalone, kioskDefault) {
    var p = null;
    try { p = new URLSearchParams(location.search); } catch (e) { /* older engine */ }
    function has(k) { return !!p && p.has(k); }
    var standalone = has('standalone') || !!deckStandalone;
    /* Is a person driving this?
     *
     * THE ROUTE DECIDES, AND THE URL OVERRIDES. `kioskDefault` is the route's own
     * answer, baked by the template that built the page: /screen/<loc>/ is a wall
     * (hands-free), /slideshow/<slug>/ is a page someone opened (theirs to steer).
     * Each keeps one escape hatch — `?interactive` on a screen, which is how the
     * home page offers a visitor the deck a pavilion television is showing, and
     * `?kiosk` on a deck, which previews the wall's surface from a desk.
     *
     * Baking the default rather than requiring a flag is what makes this safe to
     * change: a wall's URL lives in a file on the Pi (`~/.kiosk_url`, see
     * docs/raspberry-pi.md) and is not ours to update, so the bare screen URL every
     * wall already holds has to keep meaning what it has always meant.
     *
     * What this replaced: `?interactive` as the sole positive signal, with
     * `standalone` and then the portrait surface each having to CONFER interactive
     * so that a URL we hand to a person didn't need a query string to be the right
     * experience. That reasoning is now the default itself, so both special cases
     * are gone — `standalone` is back to meaning only what it says (see below), and
     * portrait is back to being a choice about geometry. */
    // `?preview` (the 50%-scale debug view) sides with the wall whatever route it is
    // on: it exists to watch a deck rotate hands-free beside its slide list, and it
    // has always needed `?interactive` on top to be steerable. Keeping it that way
    // means the route default cannot quietly change what the debug view shows.
    var handsFreeByDefault = !!kioskDefault || has('preview');
    var interactive = has('record') ||
      (handsFreeByDefault ? has('interactive') : !has('kiosk'));
    return {
      standalone: standalone,
      interactive: interactive,
      /* The phone surface (docs/portrait-decks.md). A deck held in a hand and read
       * end to end down the screen, rather than a 16:9 rectangle floating in the
       * middle of a portrait one. Every deck the build emits gets it — a template
       * with no portrait layout shows its 16:9 self in a letterboxed band.
       *
       * NEVER ON THE WALL, and it needs no rule of its own to say so: a wall is
       * hands-free by route, so `interactive` already excludes it — including a
       * panel mounted the tall way round, which an aspect test would not have.
       *
       * Record is excluded EXPLICITLY: `?record` sets interactive above, so without
       * this a narrator holding a phone would record a take against the portrait
       * surface. A take is authored once, in landscape. `?hosted` (the /narrate
       * preview pane) and `?preview` (the debug view) drive a deck themselves and
       * own their own geometry; `?kiosk` stays the escape hatch for previewing the
       * wall's surface from a phone.
       *
       * Read at boot AND re-evaluated on rotation: the surface follows the shape of
       * the screen in both directions, so a phone turned sideways gets the landscape
       * presentation back (WccPlayer.setStage, and the watcher in player.html). */
      portrait: interactive && !has('record') && !has('hosted') && !has('preview') &&
        window.innerWidth < window.innerHeight
    };
  }

  window.WccPlayer = {
    start: start,
    surface: surface,
    // Callers pass what surface() takes, for the same reason it takes them: the
    // answer depends on the surface, and the surface is not knowable from the URL
    // alone — the route carries the default.
    windowRadius: function (deckStandalone, kioskDefault) {
      return windowRadius(new URLSearchParams(location.search),
                          surface(deckStandalone, kioskDefault));
    }
  };

  function start(opts) {
    var items = opts.items || [];
    var onShow = opts.onShow || function () {};
    if (items.length === 0) return;

    var params = new URLSearchParams(location.search);
    // Record mode IS interactive mode — same nav, same timers, same hold points —
    // plus a recorder and a HUD. Anything that branches on `record` below is either
    // the recorder itself or the one subtraction (prev).
    var record = params.has('record');
    // `?hosted` — the player is embedded in an editor tool that drives it (today
    // /narrate, which plays a deck back against a take). It gets the same atom
    // tracking record mode uses, reports every atom boundary to its parent, and
    // accepts `goto-atom` / `play` / `pause` from it. Nothing else changes: review
    // has to show what was recorded, so it must be the same nav.
    var hosted = params.has('hosted');
    var track = record || hosted;   // atom identity is being followed
    // `opts.kioskDefault` is the route's own answer to "is a person driving this",
    // baked by the template that built the page. See surface().
    var surf = surface(opts.standalone, opts.kioskDefault);
    var interactive = record || surf.interactive;
    /* The stage — where a slide goes when it becomes the current one.
     *
     * Default (null) is the wall's: every frame stacked at inset:0 and crossfaded
     * by an `active` class. The portrait surface passes an adapter (portrait.js)
     * that instead scrolls a column of full-height steps. That is the ONLY
     * difference between the two surfaces: transport, panel timers, atom pacing,
     * windowing, holds, video and the reload all stay in here, driving one deck.
     * Anything that has to know about geometry belongs on this seam, not in a
     * second player. */
    var stage = opts.stage || null;
    /* The default stage's host — where a frame goes when there is no stage object:
     * the crossfade stack's container (`#slide-layer`). Named by the template rather
     * than looked up here, because the two players' markup is the template's to own
     * and this file has never known an element id. Only `setStage` reads it; the
     * boot path puts the frames there itself.
     * `newFrame(i)` is the same story for building one — url, permissions policy and
     * the deck entry's own clip/panel push all belong to the template that knows the
     * deck. Both are optional: without them a deck simply cannot swap back to the
     * stack, which is exactly what this file did before the swap was two-way. */
    var slideHost = opts.slideHost || null;
    var newFrame = opts.newFrame || null;
    /* Standalone — this deck is the whole of what the viewer was sent, not a page
     * within a site they are browsing. It says one thing and no longer implies a
     * second: a deck page is now interactive by route (see surface), so the flag is
     * about what the deck IS, not about who is driving it.
     *
     * It changes the home button: back to the deck's first slide rather than a
     * navigation to `/`. For someone who followed a link to the pavilion showcase,
     * `/` is a club statistics site they never asked for and cannot return from
     * except with the back button, so the one control that looks like "start
     * again" would be the one that loses their place entirely. The Home KEY has
     * always meant first-slide (see keydown); this makes the button agree with it.
     *
     * Set by the deck (`standalone: true` in content/slideshows/<slug>.json) or
     * forced with `?standalone`. */
    var standalone = surf.standalone;

    var n = items.length;
    var current = 0;
    /* Panel count per item, answered by the slide itself over the bridge. A
     * FRAMELESS item (see below) has no bridge, so it is seeded from the atom list
     * the deck was built with — the same list the wall's slide would have reported.
     * Null still means "not heard from yet" everywhere else. */
    var counts = items.map(function (it) {
      return it.frame ? null : ((it.atoms && it.atoms.length) || 1);
    });
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
    var bar = null;          // control bar (interactive only)

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
    var winRadius = windowRadius(params, surf);
    var pendingCmds = items.map(function () { return []; });
    /* A frameless item counts as loaded from the start. Nothing will ever load, so
     * the alternative is `send` queueing every command it is ever given into a
     * pendingCmds list that is never flushed — a slow leak, and a queue that would
     * fire at a document if one ever appeared. `post` drops them instead. */
    var loaded = items.map(function (it) { return !it.frame; });
    var pruneTimer = null;
    var PRUNE_DELAY_MS = 1200;   // longer than the 0.8s crossfade: the outgoing frame is still fading

    /* ---- frameless items -----------------------------------------------------
     * An item may have NO frame. That is the portrait surface's fragment step
     * (docs/portrait-decks.md phase 1): the stage renders the slide as real DOM in
     * the player's own document, so there is no iframe to create, load, post to or
     * tear down — which is the whole memory argument for fragments.
     *
     * Everything below therefore treats a null frame as an item with nothing to
     * talk to: no url, never live, commands dropped. It is NOT a special case in the
     * transport — a frameless item still has its atoms, its duration and its place
     * in the deck, and every timer, hold and nav move works on it unchanged. */
    function frameUrl(i) {
      var f = items[i].frame;
      if (!f) return '';
      return f.dataset.src || f.getAttribute('src') || '';
    }
    function frameIsLive(i) {
      var f = items[i].frame;
      return !!(f && f.getAttribute('src'));
    }
    function post(i, msg) {
      if (!items[i].frame) return;
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
      if (!f) return;
      try {
        if (f.contentDocument && f.contentDocument.readyState === 'complete') { markLoaded(i); return; }
      } catch (e) {}
      f.addEventListener('load', function () { markLoaded(i); }, { once: true });
    }
    function loadFrame(i) {
      if (!items[i].frame || frameIsLive(i)) return;
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
    /* Tap-through.
     *
     * `#wcc-tap` is a full-surface gesture layer above the slide stack, so by
     * default NOTHING inside a slide can be touched — which is right, because a
     * slide is a picture, not a page. A slide that offers the viewer a real link
     * (the showcase deck's hire and credits cards) is the exception: it announces
     * `taps` on its handshake and we stand the gesture layer down while it is the
     * current slide.
     *
     * The cost is swipe and tap-to-pause on that slide alone; the control bar sits
     * above the gesture layer (z-index 60) and keeps working, so navigation is
     * never lost. Kiosk never reaches this — there is no tap layer on a wall, and
     * a link there would be unpressable anyway, which is why such a slide must
     * also carry a QR code rather than relying on the link. */
    var tapEl = null;
    var tapThrough = {};
    function applyTapThrough() {
      if (tapEl) tapEl.style.pointerEvents = tapThrough[current] ? 'none' : '';
      /* The portrait column has no tap layer to stand down; it has the opposite
       * problem. Its bands are transparent to hit-testing so the column can read
       * every gesture in its own document, and a slide with live links is the
       * exception that gets its events back. Same flag, opposite direction. */
      if (stage && stage.taps) stage.taps(current, !!tapThrough[current]);
    }
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
      /* A stage that owns input has its own gestures to stand down — `cancelGesture`
       * only reaches the landscape tap layer. Without this the portrait surface went
       * on navigating while the reader was pinched in: a one-finger pan over a
       * magnified scorecard stepped the deck out from under them, and a tap toggled
       * playback. The two halves that were already shared (the timer stops, the
       * window collapses to the visible slide) are below. */
      if (stage && stage.zoom) stage.zoom(zoomed);
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
      // Reveal it. On the wall that is a crossfade between stacked frames; on the
      // portrait surface the frames are already all on screen in a scroller and
      // revealing means scrolling to the right one. `current` is still the
      // outgoing index here, which is what a stage needs to know which way it is
      // travelling.
      if (stage) stage.show(i, current);
      else items.forEach(function (it, j) { if (it.frame) it.frame.classList.toggle('active', j === i); });
      current = i;
      shownAt = Date.now();
      applyTapThrough();
      railUpdate();
      onShow(i);
    }
    /* Tell the stage which STEP the transport is on. `activate` reveals the slide;
     * this refines it to the panel, which is the finer position the portrait column
     * scrolls to (a carousel is one step per panel there — the same rule /deck gives
     * one row to). Called wherever panelIndex settles: the arrival, and the slide's
     * own echo. A stage with no step axis (the wall's crossfade stack) has no
     * showAtom and this is a no-op. */
    function stageAtom() {
      if (stage && stage.showAtom) stage.showAtom(current, panelIndex);
      railUpdate();
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

    /* The bottom instrument: time left on the current atom. Mirrors the interactive
     * per-panel timer — fills over the dwell while playing, freezes where it is on
     * pause, empties on nav. Always `scaleX`: the line is welded to the viewport's
     * bottom edge and no longer rotates with the control bar (see injectStyles).
     * All no-ops until the instruments exist, so kiosk (the wall) shows nothing. */
    function progressScale(v) { return 'scaleX(' + v + ')'; }
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

    /* ---- the two deck instruments -----------------------------------------
     * Built once, owned by the player, and welded to the reading area's top and
     * bottom edges on BOTH surfaces — see the long note in injectStyles for the
     * rule and why the countdown stopped being a child of the control bar.
     *
     * Interactive only, and gated exactly as the bar is (`!record && !hosted`).
     * The wall has never had a countdown and does not grow one here; record mode
     * carries its own in the HUD, and a second one would compete with it.
     */
    var railTicks = [], progTop = null, progBot = null;
    var railFirst = [], railTotal = 0;

    /* Above this many atoms the rail stops counting and goes back to a fill: the
     * ticks have to be wide enough to read as separate marks, and `teams` is 89
     * positions. Sized off the narrowest phone we care about (390px), where 24
     * ticks are ~14px each. Shared with the portrait column by construction now
     * that there is only one rail. */
    var TICK_MAX = 24;

    /* How many atoms a slide contributes to the rail. Deliberately the BUILD's atom
     * list rather than `counts` (what the slide reported over the bridge): the rail
     * is a map of the deck and must have its full length on the first frame, before
     * any slide has answered. A reel counts as one — its clips are finer than the
     * deck's grain and would swamp the count — which is the same rule the portrait
     * column's step table uses, so the two surfaces measure the same thing. */
    function railSteps(i) {
      var it = items[i] || {};
      if (it.video) return 1;
      var a = (it.atoms && it.atoms.length) || 1;
      return a > 1 ? a : 1;
    }
    function railTable() {
      railFirst = []; railTotal = 0;
      for (var i = 0; i < n; i++) { railFirst.push(railTotal); railTotal += railSteps(i); }
    }
    function railUpdate() {
      if (!progTop || !railTotal) return;
      var k = (railFirst[current] || 0) +
              Math.min(panelIndex || 0, railSteps(current) - 1);
      if (progTop.classList.contains('cont')) {
        if (railTicks[0]) railTicks[0].style.transform = 'scaleX(' + ((k + 1) / railTotal) + ')';
        return;
      }
      for (var t = 0; t < railTicks.length; t++) railTicks[t].classList.toggle('on', t <= k);
    }

    /* The countdown appears with playback and goes with it. */
    function progressVisible() {
      if (progBot) progBot.classList.toggle('on', !!playing);
    }

    /* Where the reading area's edges actually are. The viewport, less any chrome
     * that DOCKS against an edge:
     *   - the portrait toolbar, which owns the bottom edge outright;
     *   - the live ticker (bottom) and matte strip (left), which sit in the L a
     *     retracting slide layer uncovers — measured off `#stage` the same way the
     *     record chrome is, and for the same reason (`#stage` is transformed, so it
     *     is a stacking context and these are positioned, not parented).
     * A letterbox band is NOT chrome. It is nothing, and the lines run over it to
     * the glass — which is the whole point of welding them to the viewport. */
    function layoutInstruments() {
      if (!progTop) return;
      var b = 0, l = 0;
      if (stage && stage.barDock && bar) {
        b = bar.getBoundingClientRect().height;
      } else if (document.body.classList.contains('live-chrome')) {
        var el = stageEl(), r = el && el.getBoundingClientRect();
        if (r && r.height) {
          b = Math.max(0, window.innerHeight - r.bottom) + r.height * BAND;
          l = Math.max(0, r.left) + r.width * BAND;
        }
      }
      progTop.style.left = progBot.style.left = l + 'px';
      progTop.style.right = progBot.style.right = '0px';
      progBot.style.bottom = b + 'px';
    }

    function buildInstruments() {
      progTop = document.createElement('div');
      progTop.id = 'wcc-prog-top';
      progTop.setAttribute('aria-hidden', 'true');
      railTable();
      railTicks = [];
      if (railTotal > 1 && railTotal <= TICK_MAX) {
        for (var t = 0; t < railTotal; t++) {
          var i2 = document.createElement('i');
          railTicks.push(i2);
          progTop.appendChild(i2);
        }
      } else {
        progTop.classList.add('cont');
        var f = document.createElement('i');
        railTicks.push(f);
        progTop.appendChild(f);
      }
      // A one-atom deck has no position to report; the track would be a solid line
      // saying nothing. The countdown still applies.
      if (railTotal > 1) document.body.appendChild(progTop);

      progBot = document.createElement('div');
      progBot.id = 'wcc-prog-bot';
      progBot.setAttribute('aria-hidden', 'true');
      progressFill = document.createElement('i');
      progBot.appendChild(progressFill);
      document.body.appendChild(progBot);

      // The live chrome arrives and leaves at runtime (a match starts, a match
      // ends), and it changes where the bottom edge is. `body.live-chrome` is the
      // page's own signal for it, so watch that rather than adding a second one.
      if (window.MutationObserver) {
        new MutationObserver(layoutInstruments).observe(document.body,
          { attributes: true, attributeFilter: ['class'] });
      }
      railUpdate();
      progressVisible();
      layoutInstruments();
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
      // Hosted: every boundary comes from the take. A deck that also advanced itself
      // on its own durations would drift off the commentary between cues and then
      // snap back at the next one, which reads as the preview being broken.
      if (hosted) return;
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
      // A slide arrival is an atom boundary like any other; recSync is where every
      // route into a new atom converges (a no-op unless a take or a review is
      // following it).
      clipPhase = track && items[i].video && planPreAt(i, panelIndex) ? 'pre' : null;
      stageAtom();
      recSync();
    }
    function interShow(i, panel) { activate(i); applyState(panel); }
    // Every arrival sets the transport state before applying it, so the incoming
    // slide is handed the right play/pause commands. Forward onto a video slide
    // auto-plays (and, since a finished reel posts wcc-done → fwdSlide, the run
    // carries on through consecutive video slides); forward onto a non-video — and
    // every backward/jump move — stops (pauses) so the user regains manual control.
    function arrive(i, panel, play) { playing = play; updatePlayBtn(); interShow(i, panel); }
    function fwdSlide() {
      var i = (current + 1) % n;
      // A playing deck keeps playing across the boundary. This used to read
      // `!!items[i].video`, which stopped the deck on arrival at any static slide —
      // so a slideshow left to run advanced exactly once and then sat there. The
      // intent behind it was narrower: a *paused* deck that reaches the end of a
      // video clip should stay paused rather than be started by the clip running
      // out. Carrying `playing` across says that, and only that.
      //
      // Arriving at a video slide still starts it even from paused: stepping
      // forward onto a reel is a request to watch the reel.
      //
      // Record mode keeps running if — and only if — the narrator has explicitly
      // handed the deck over (AUTO), which is why it reads `autoRun` here and not
      // `playing`. "A short introduction, then let it play on the deck's own
      // durations" is a one-slide gesture otherwise, since it would drop back to
      // manual at every boundary. `autoRun` is what separates that from merely
      // playing because a clip happens to be rolling: a reel reaching its end must
      // NOT quietly start auto-cueing the static slides after it.
      arrive(i, 0, (record ? rec.autoRun : playing) || !!items[i].video);
    }
    function backSlide() { arrive((current - 1 + n) % n, 'last', false); }
    function goFirst() { arrive(0, 0, false); }
    function goLast() { arrive(n - 1, 0, false); }

    function setPlaying(p) {
      playing = p;
      // Handing the deck over is something the narrator does on a static beat; taking
      // it back is any freeze, anywhere. See fwdSlide.
      if (record) rec.autoRun = p ? !(items[current] || {}).video : false;
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
      progressVisible();
      // A pause inside a media beat is a freeze, not a cue: it holds what is already
      // on screen. Captured here rather than in the tap handler so the bar's own
      // play/pause button records one too.
      if (record) { if (p) freezeEnd(); else freezeStart(); hudDraw(); }
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
      // Backwards is disabled during a take. A continuous take plus a jump backwards
      // is incoherent — the audio keeps running while the video rewinds — and the
      // whole timeline invariant rests on the take being continuous. "I fluffed that
      // one" is a review-time re-record, which costs the narrator nothing.
      if (record && rec.state === 'recording') return;
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
      bar.classList.remove('place-below', 'place-right', 'place-inside', 'place-portrait');
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
      /* A STAGE MAY OWN THE PLACEMENT. The three placements below all answer the same
       * question — which letterbox band can hold the bar — and a portrait deck has no
       * band to answer it with: the slide fills the width of its step. So the portrait
       * column asks for the dock instead, and is told how tall it came out, because it
       * shortens its own scroller by that much rather than letting the bar float over
       * the reading. This is the placement the design doc said portrait would need
       * "rather than a fourth guess from that function". */
      if (stage && stage.barDock) {
        setPlaceClass('portrait');
        bar.classList.remove('collapsed');   // the dock is never in the way, so never hides
        if (stage.chrome) stage.chrome(bar.getBoundingClientRect().height);
        layoutInstruments();
        return;
      }
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
      // — titles/hero sit top-left or centre — so a column here is the least
      // intrusive option when no band can hold the bar.
      if (place === 'inside') {
        bar.style.top = edge + 'px';
        bar.style.right = edge + 'px';
      }
      // Collapse belongs to inside only — the one placement that overlaps the slide.
      // It starts OPEN, and only the grip toggles it; there's no auto-hide.
      //
      // Open by default is a discoverability call, and it beats the tidier look.
      // Collapsed, the bar is a single grip glyph in a corner, which does not say
      // "you are holding a slideshow you can step through" — a first-time viewer
      // following a link we sent them reads a static picture and never finds the
      // controls. That viewer is now the common case, not the bar iPad. Anyone who
      // wants the picture clean can still collapse it, and that choice survives a
      // resize (below).
      //
      // Entering inside afresh opens; staying inside across a resize preserves
      // whatever the user last set. Elsewhere: always open.
      if (place === 'inside') { if (!wasInside) bar.classList.remove('collapsed'); }
      else { bar.classList.remove('collapsed'); }
      layoutInstruments();
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
    function reglyph(b, name) {
      if (!b) return;
      b.innerHTML = icon(name);
      if (LABEL[name]) b.setAttribute('aria-label', LABEL[name]);
    }
    function updatePlayBtn() { reglyph(playBtn, playing ? 'pause' : 'play'); }
    function updateFsBtn() { reglyph(fsBtn, fsElement() ? 'compress' : 'expand'); }
    /* Every control is a glyph, so the accessible name has to be said out loud —
     * `icon()` renders an `aria-hidden` <svg> and nothing else, which left the bar
     * as a row of unnamed buttons to anything not looking at it. */
    var LABEL = {
      home: 'Home', prev: 'Previous', next: 'Next', play: 'Play', pause: 'Pause',
      expand: 'Full screen', compress: 'Exit full screen', grip: 'Show or hide controls',
      share: 'Share'
    };
    function button(name, cls, handler) {
      var b = document.createElement('button');
      b.type = 'button';
      if (cls) b.className = cls;
      if (LABEL[name]) b.setAttribute('aria-label', LABEL[name]);
      b.innerHTML = icon(name);
      b.addEventListener('click', function (e) { e.stopPropagation(); handler(); });
      return b;
    }
    function buildControls() {
      injectStyles();
      // In record mode the control bar is not built at all. It floats OVER the slide,
      // and putting the narrator's instruments beside the deck rather than on top of
      // it is the whole point of the record chrome — which carries the transport and
      // the countdown instead (see buildHud). Everything below guards on `bar`
      // already, because placeBar has always been able to run before it exists.

      // Full-surface gesture layer. A horizontal swipe steps slides; a clean tap
      // toggles play/pause. Movement + time thresholds keep a tap and a swipe from
      // firing each other (a drag never counts as a tap, and vice versa).
      var tap = document.createElement('div');
      tap.id = 'wcc-tap';
      tapEl = tap;
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
      // A hosted player has one driver, and it is the page around it. The gesture
      // layer and the bar are a second one: a stray tap in /narrate's preview would
      // roll the deck out from under the take with nothing to put it back. (Record
      // mode keeps the gestures — a tap there is the freeze.)
      // A stage that owns input gets no gesture layer. `#wcc-tap` is a fixed
      // full-viewport overlay, and a fixed overlay over a scroller swallows the
      // scroll: the touch lands on an element whose nearest scrollable ancestor is
      // the (unscrollable) body, so the portrait deck would simply not move. The
      // portrait stage takes the tap itself, off its own scroller.
      if (!hosted && !(stage && stage.ownsInput)) document.body.appendChild(tap);

      fb = document.createElement('div');
      fb.id = 'wcc-fb';
      document.body.appendChild(fb);

      if (record || hosted) return;
      bar = document.createElement('div');
      bar.id = 'wcc-bar';
      // Collapse grip: first child so it sits at the column's top; visible only in
      // inside placement, and the sole control left when collapsed.
      bar.appendChild(button('grip', 'collapse', toggleCollapse));
      // Everything but the transport comes off the bar while recording: it is a
      // performance surface, and home/prev/fullscreen are all ways to wreck a take.
      if (!record) {
        bar.appendChild(button('home', '',
          standalone ? goFirst : function () { location.href = '/'; }));
        bar.appendChild(button('prev', '', prev));
      }
      playBtn = button('pause', 'primary', function () { setPlaying(!playing); });
      bar.appendChild(playBtn);
      bar.appendChild(button('next', '', next));
      /* SHARE, where the browser has it — and on BOTH surfaces. It was the portrait
       * stage's button, which meant the deck whose entire distribution model is
       * being forwarded lost its forward button when the phone was turned: `detach()`
       * took it away on rotation. The button is about the deck, not about the shape
       * of the screen, so it belongs to the bar like every other control.
       * The URL is the canonical one the link preview was baked against (og:url),
       * not `location.href` — which may carry the ?deck= / ?k= query that got us
       * here and is nobody else's business. */
      if (!record && navigator.share) {
        var og = document.querySelector('meta[property="og:url"]');
        var shareUrl = (og && og.content) || location.origin + location.pathname;
        bar.appendChild(button('share', 'share', function () {
          try { navigator.share({ title: document.title, url: shareUrl }).catch(function () {}); }
          catch (err) { /* cancelled, or share refused — nothing to recover */ }
        }));
      }
      var docEl = document.documentElement;
      if (!record && (docEl.requestFullscreen || docEl.webkitRequestFullscreen)) {
        fsBtn = button('expand', 'fs', function () { toggleFullscreen(); });
        bar.appendChild(fsBtn);
        document.addEventListener('fullscreenchange', updateFsBtn);
        document.addEventListener('webkitfullscreenchange', updateFsBtn);
      }
      document.body.appendChild(bar);
      // The countdown and the position rail are NOT children of the bar — they are
      // welded to the reading area's edges. Built after it because the dock's
      // measured height is one of the insets.
      buildInstruments();

      updatePlayBtn();
      placeBar();
      window.addEventListener('resize', schedulePlace);
      window.addEventListener('orientationchange', schedulePlace);
    }

    /* ---- record mode ------------------------------------------------------
     * Phase 7 of docs/narrated-decks.md. Record mode is interactive mode with a
     * recorder attached and one subtraction (prev), NOT a second player: a tap does
     * here exactly what it does on the bar iPad, and hold points cannot diverge.
     *
     * What it produces is a *take* — one continuous audio master plus the cue and
     * freeze timestamps marked on it as the narrator plays. Slicing, review and
     * export all happen afterwards in /narrate; nothing here edits anything.
     *
     * Three states, in order: rehearse (HUD up, mic off), arm (permission, level
     * check, 3-2-1), record. Rehearse is not a nicety — a 29-clip reel is a lot of
     * surprise, and a pass to learn what is coming costs nothing.
     */
    var rec = {
      state: 'rehearse',        // rehearse | arming | recording | stopping | done
      session: null,            // the take-store session record
      recorder: null,
      stream: null,
      audio: null,              // AudioContext + analyser, for the level meter
      seq: 0,
      t0: 0,                    // performance.now() of take time zero
      clock: null,
      plan: [],                 // flattened atoms: the beat list, known up front
      pos: -1,                  // index in plan of the atom on screen
      pending: null,            // { at, start } — a freeze in progress
      refined: {},              // item index → its atoms came from the slide itself
      clipAudio: false,         // speakers bleed into the mic; off by default
      autoRun: false,           // the narrator handed the deck its own durations
      foot: null, strip: null, els: {}
    };
    var TIMESLICE_MS = 1000;

    /* The beat list. Every atom of every slide, in deck order, which is what makes
     * "beat 14 of 61" sayable before a single one has been played. `_atoms` is the
     * build's own enumeration (slide_atoms), so the HUD, the compositor and the
     * deck builder are all reading one list.
     *
     * A reel is the exception, and deliberately so: during the sitting its clips are
     * the editor's live curation, which no build has seen, so its published atoms
     * are stale or empty. The slide itself knows — it holds the clips and their card
     * windows — and answers with its own list on the bridge handshake, which
     * `refineAtoms` swaps in. Deriving it here instead would be a second copy of
     * slide_atoms in JS, which this design has refused twice already.
     */
    function buildPlan() {
      rec.plan = [];
      items.forEach(function (it, i) {
        (it.atoms || []).forEach(function (a) {
          rec.plan.push({ i: i, slug: it.slug, panel: a.panel || 0, card: a.card || null,
                          label: a.label || null, phase: a.phase || null,
                          duration: a.duration || 0, info: a.info || null });
        });
      });
    }
    function refineAtoms(i, atoms) {
      if (!track || !atoms || !atoms.length) return;
      var old = (items[i].atoms || [])[0] || {};
      items[i].atoms = atoms.map(function (a) {
        // The runtime knows its clips, not the slide's place in the wall's header
        // hierarchy, so the build's phase rides along unchanged.
        return Object.assign({ phase: old.phase || null }, a);
      });
      rec.refined[i] = true;
      buildPlan();
      buildSpine();
      recSync();
      hudDraw();
    }
    /* Does the plan say this panel opens on a pre card? That is what makes the pad
     * the *start* of the pre-card beat rather than a nameless run-up to the freeze:
     * the atom is entered when the footage is, and the hold only ends it. */
    function planPreAt(i, panel) {
      for (var k = 0; k < rec.plan.length; k++) {
        var p = rec.plan[k];
        if (p.i === i && p.panel === panel) return p.card === 'pre';
      }
      return false;
    }
    function findPlan(i, panel, card) {
      // Forward from where we are, because a deck plays forward and two atoms can
      // share an identity only across a repeat of the same slide.
      for (var k = Math.max(0, rec.pos); k < rec.plan.length; k++) {
        var p = rec.plan[k];
        if (p.i === i && p.panel === panel && (p.card || null) === (card || null)) return k;
      }
      for (var j = 0; j < rec.plan.length; j++) {
        var q = rec.plan[j];
        if (q.i === i && q.panel === panel && (q.card || null) === (card || null)) return j;
      }
      return -1;
    }

    function takeTime() { return rec.t0 ? (performance.now() - rec.t0) / 1000 : 0; }

    /* The atom on screen, as the timeline addresses it. `clipPhase` is the card
     * qualifier: a reel's atoms are finer than its panels, so a clip is up to three
     * beats and only the slide knows which one is running (phase 5's `hold` echo). */
    var clipPhase = null;
    var mediaTime = null;      // last playhead the current slide reported, for freezes
    function currentAtom() {
      var it = items[current] || {};
      return { slide: it.slug, panel: panelIndex, card: clipPhase };
    }
    function sameAtom(a, b) {
      return a && b && a.slide === b.slide && a.panel === b.panel && (a.card || null) === (b.card || null);
    }

    /* One place decides that the deck has moved on, so every route into a new atom —
     * a manual cue, a clip auto-cueing at its end, a card hold releasing — stamps
     * the take identically. Called after anything that can change what is on screen. */
    var lastAtom = null;
    function recSync() {
      if (!record) return;
      var a = currentAtom();
      var moved = !sameAtom(a, lastAtom);
      if (moved) {
        lastAtom = a;
        rec.pos = findPlan(current, a.panel, a.card);
        if (rec.state === 'recording') stampCue(a);
      }
      if (moved) hudDraw();
      if (moved && hosted) {
        try { parent.postMessage({ type: 'wcc-player-atom', atom: a, plan: rec.pos }, '*'); } catch (e) {}
      }
    }
    function stampCue(a) {
      var s = rec.session;
      if (!s) return;
      s.cues.push({ t: +takeTime().toFixed(3), atom: a });
      // Written synchronously, every cue: an IndexedDB write in flight when the tab
      // dies is a lost cue, and the cue log is what makes the audio addressable.
      if (!WccTakeStore.save(s)) hudError('cue log is full — stop and export now');
    }

    /* A pause inside a media beat is a FREEZE, not a cue: it holds what is already
     * on screen rather than changing it. Static beats have nothing to freeze, so a
     * pause there is captured as nothing at all. `at` is media time within the clip,
     * which only the slide knows — hence the round trip. */
    function freezeStart() {
      if (rec.state !== 'recording' || !items[current] || !items[current].video) return;
      mediaTime = null;
      send(current, 'ping-time');
      rec.pending = { beat: rec.session.cues.length - 1, start: takeTime() };
    }
    function freezeEnd() {
      var p = rec.pending;
      rec.pending = null;
      if (!p || rec.state !== 'recording') return;
      var hold = +(takeTime() - p.start).toFixed(3);
      if (hold < 0.25) return;      // a tap through a pause, not a held frame
      rec.session.freezes.push({ beat: p.beat, at: mediaTime == null ? null : +mediaTime.toFixed(3),
                                 hold: hold });
      WccTakeStore.save(rec.session);
    }

    /* ---- HUD ---------------------------------------------------------------
     * The record chrome is the LIVE CHROME'S L, borrowed. On a match day the slide
     * layer retracts toward the top-right and a ticker footer + matte strip appear in
     * the band it uncovers; a take does exactly the same thing, so the narrator's
     * instruments sit BESIDE the deck rather than over it. Nothing of the slide is
     * covered, which for a performance surface is the whole point — and it costs one
     * shared CSS rule (`body.record-chrome`, next to `body.live-chrome` in
     * player.html), because the retraction was already a property of the stage.
     *
     *   ┌──────┬───────────────────────────┐
     *   │strip │      the deck, 92%        │   strip: state · level · beat count
     *   │      │                           │   foot:  REC · clock · beat · NEXT ▸
     *   ├──────┴───────────────────────────┤          + transport, arm, clip audio
     *   │ foot                             │
     *   └──────────────────────────────────┘
     *
     * Two details worth knowing:
     *
     * - **It is positioned, not parented.** The obvious thing is to append the chrome
     *   to `#stage` as the ticker and strip are — but `#stage` is `transform`ed to
     *   centre it, which makes it a stacking context, and `#wcc-tap` (the full-screen
     *   gesture layer, z-index 50) then paints above everything inside it. The chrome
     *   has buttons; they have to be reachable. So it is fixed and measured off the
     *   stage's rect instead, re-measured on every resize like `placeBar`.
     * - **Everything is sized in `--fit` units** (`--u`), the same scale the slide
     *   layer is drawn at, so the chrome and the deck are one design at any size.
     */
    var BAND = 0.08;      // mirrors --live-band; read from the page below
    function stageEl() { return document.getElementById('stage'); }

    function hudStyles() {
      try {
        var v = parseFloat(getComputedStyle(document.documentElement)
                           .getPropertyValue('--live-band'));
        if (v > 0 && v < 0.5) BAND = v;
      } catch (e) {}
      var css =
        // One scale for the whole chrome: --fit is stage width / 1920, i.e. exactly
        // what the slide layer is scaled by, so 30 here is 30 wall pixels.
        '#wcc-rec-foot,#wcc-rec-strip{--u:calc(var(--fit,1) * 1px);position:fixed;z-index:70;' +
        'font-family:Lato,-apple-system,Arial,sans-serif;color:#fff;pointer-events:none;}' +
        '#wcc-rec-foot *,#wcc-rec-strip *{pointer-events:auto;}' +
        // Foot: the bottom band. Transparent — the stage matte is already behind it,
        // the same way the ticker sits on it.
        '#wcc-rec-foot{display:flex;align-items:stretch;gap:calc(22 * var(--u));' +
        'padding-right:calc(24 * var(--u));border-top:1px solid rgba(212,175,55,0.35);}' +
        // The gold flag in the bottom-left corner — the live ticker's tile, and the
        // header for the whole L. Its width is the band, set from the measured stage
        // in placeChrome, so the strip stands exactly on top of it and the footer's
        // gold rule runs off its left edge: one continuous L, as on a match day.
        '#wcc-rec-foot .flag{flex:none;display:flex;flex-direction:column;' +
        'align-items:center;justify-content:center;gap:calc(2 * var(--u));' +
        'padding:0 calc(6 * var(--u));background:#d4af37;color:#0f2346;overflow:hidden;' +
        'font-weight:900;text-transform:uppercase;text-align:center;line-height:1.05;}' +
        '#wcc-rec-foot .flag .lbl{font-size:calc(22 * var(--u));letter-spacing:.08em;}' +
        // The dot rides INLINE at the head of the label, as the ticker's does, so it
        // never strands itself beside a block.
        '#wcc-rec-foot .flag i{display:none;width:calc(13 * var(--u));height:calc(13 * var(--u));' +
        'margin-right:calc(7 * var(--u));border-radius:50%;background:#b3261e;' +
        'vertical-align:0.04em;}' +
        '#wcc-rec-foot.on .flag i{display:inline-block;animation:wcc-rec-pulse 1.8s infinite;}' +
        '@keyframes wcc-rec-pulse{0%{box-shadow:0 0 0 0 rgba(179,38,30,0.6);}' +
        '70%{box-shadow:0 0 0 calc(10 * var(--u)) rgba(179,38,30,0);}' +
        '100%{box-shadow:0 0 0 0 rgba(179,38,30,0);}}' +
        // The take clock is the flag's subtitle, where the ticker puts the division.
        '#wcc-rec-foot .flag .clock{font-size:calc(20 * var(--u));font-weight:700;' +
        'letter-spacing:.04em;font-variant-numeric:tabular-nums;color:rgba(15,35,70,0.75);}' +
        '#wcc-rec-foot .txt{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;' +
        'justify-content:center;gap:calc(3 * var(--u));}' +
        '#wcc-rec-foot .r1{display:flex;align-items:center;gap:calc(14 * var(--u));min-width:0;}' +
        // Reserved height, so the prompt beneath it never moves when an instruction
        // comes and goes — which it does at every clip boundary.
        '#wcc-rec-foot .beat{font-size:calc(22 * var(--u));color:#b4c8e4;white-space:nowrap;' +
        'overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-height:calc(27 * var(--u));}' +
        // A hold is the one state the narrator has to act on, so it reads as an
        // instruction at the head of the line rather than as a label somewhere else.
        '#wcc-rec-foot .beat em{font-style:normal;font-weight:900;color:#d4af37;' +
        'letter-spacing:.06em;}' +
        '#wcc-rec-foot .err{font-size:calc(20 * var(--u));color:#f0a0a0;flex:none;}' +
        // The next-up prompt is the highest-value element on the screen: for a clip
        // its curated narrative, for a card the resolved figures the narrator has to
        // say aloud, for a static slide its title. It gets the big line.
        '#wcc-rec-foot .next{font-size:calc(34 * var(--u));font-weight:700;white-space:nowrap;' +
        'overflow:hidden;text-overflow:ellipsis;line-height:1.15;}' +
        '#wcc-rec-foot .next span{color:#d4af37;font-weight:900;font-size:calc(20 * var(--u));' +
        'margin-right:calc(12 * var(--u));}' +
        '#wcc-rec-foot .next i{color:#b4c8e4;font-style:normal;font-weight:400;' +
        'font-size:calc(24 * var(--u));margin-left:calc(12 * var(--u));}' +
        // The meter comes off the strip and into the footer, beside the transport it
        // belongs with. It is small but it is never off screen, which is all it has to
        // be — a take that turns out silent or clipped is the worst outcome here.
        '#wcc-rec-foot .meter{flex:none;width:calc(120 * var(--u));height:calc(12 * var(--u));' +
        'background:rgba(255,255,255,0.12);border-radius:calc(6 * var(--u));overflow:hidden;}' +
        '#wcc-rec-foot .meter i{display:block;width:0;height:100%;background:#5ec27a;' +
        'transition:width 80ms linear;}' +
        '#wcc-rec-foot.clipped .meter i{background:#e2453c;}' +
        '#wcc-rec-foot .acts{display:flex;align-items:center;gap:calc(10 * var(--u));flex:none;}' +
        '#wcc-rec-foot button{font:inherit;font-size:calc(20 * var(--u));font-weight:700;' +
        'padding:calc(8 * var(--u)) calc(16 * var(--u));border-radius:calc(7 * var(--u));' +
        'border:1px solid rgba(212,175,55,0.7);background:transparent;color:#d4af37;' +
        'cursor:pointer;display:flex;align-items:center;gap:calc(6 * var(--u));}' +
        '#wcc-rec-foot button.primary{background:#d4af37;color:#0a1c3a;}' +
        '#wcc-rec-foot button.on{background:rgba(212,175,55,0.22);color:#fff;}' +
        '#wcc-rec-foot button svg{width:calc(24 * var(--u));height:calc(24 * var(--u));' +
        'fill:currentColor;stroke:currentColor;stroke-width:2;stroke-linejoin:round;}' +
        // The clip countdown runs along the seam between the deck and the chrome,
        // which is where the eye already is.
        '#wcc-rec-progress{position:absolute;left:0;right:0;top:0;height:calc(4 * var(--u));' +
        'background:rgba(212,175,55,0.16);overflow:hidden;}' +
        '#wcc-rec-progress i{display:block;width:100%;height:100%;background:#d4af37;' +
        'transform-origin:left;transform:scaleX(0);}' +
        // Strip: the left band. State at the top, the level meter down the middle —
        // a take that turns out silent or clipped after twenty minutes is the worst
        // outcome this feature has, so the meter is never off screen — beat at the foot.
        // The strip is the DECK'S SPINE: one tile per slide, top to bottom, each
        // filling with gold as its atoms are played — the vertical twin of the
        // countdown along the footer's top edge. A reel is one tile however many
        // clips it holds, which is the whole reason it is readable: 29 clips are one
        // thing you narrate, not 29 things to find yourself in.
        // One padding everywhere: the gap between tiles is also the strip's inset and
        // the tiles' own, so the column reads as an even stack rather than a boxed list.
        '#wcc-rec-strip{--u:calc(var(--fit,1) * 1px);--pad:calc(4 * var(--u));' +
        'display:flex;flex-direction:column;padding:var(--pad);gap:var(--pad);' +
        'border-right:1px solid rgba(212,175,55,0.2);}' +
        '#wcc-rec-strip .tile{position:relative;flex:1 1 0;min-height:0;overflow:hidden;' +
        'display:flex;flex-direction:column;justify-content:center;text-align:center;' +
        'padding:var(--pad);border-radius:calc(5 * var(--u));' +
        'background:rgba(255,255,255,0.06);}' +
        // A set boundary is a bigger gap, not a second colour: gold is the only accent
        // this design has, and it is already spoken for by progress.
        '#wcc-rec-strip .tile.set{margin-top:calc(12 * var(--u));}' +
        '#wcc-rec-strip .tile .fill{position:absolute;left:0;top:0;bottom:0;width:0;' +
        'background:rgba(212,175,55,0.20);transition:width 0.25s linear;}' +
        '#wcc-rec-strip .tile.now{background:rgba(255,255,255,0.10);' +
        'box-shadow:inset 0 0 0 1px rgba(212,175,55,0.65);}' +
        '#wcc-rec-strip .tile.now .fill{background:rgba(212,175,55,0.42);}' +
        '#wcc-rec-strip .tile>span{position:relative;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;}' +
        // Both caption lines are one voice — same size, same weight, white — because
        // "1st Innings / Highlights" is one name in two levels, not a label and a
        // heading. Only the gold clip count reads as a different kind of thing.
        '#wcc-rec-strip .tile .l1,#wcc-rec-strip .tile .l2{font-size:calc(19 * var(--u));' +
        'font-weight:700;color:#fff;}' +
        '#wcc-rec-strip .tile:not(.now) .l1,#wcc-rec-strip .tile:not(.now) .l2{' +
        'color:rgba(255,255,255,0.72);}' +
        // Set off from the name above it: the count is a different kind of thing, so
        // it gets the same gap the tiles get from each other.
        '#wcc-rec-strip .tile .n{font-size:calc(14 * var(--u));font-weight:700;color:#d4af37;' +
        'margin-top:var(--pad);}' +
        // A long deck runs out of room for words long before it runs out of tiles, so
        // past a point the spine is bars only. Still the same answer to "where am I".
        '#wcc-rec-strip.dense .tile>span{display:none;}' +
        '#wcc-rec-strip.dense .tile{flex-basis:auto;}' +
        // The 3-2-1: over the stage, unmissable, and gone before the deck starts.
        '#wcc-count{position:fixed;inset:0;z-index:80;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(8,21,44,0.72);color:#d4af37;' +
        'font:900 22vmax/1 Lato,Arial,sans-serif;}';
      var s = document.createElement('style');
      s.textContent = css;
      document.head.appendChild(s);
    }

    /* Lay the chrome over the L the retracted slide layer uncovers. Measured off the
     * stage rather than the viewport, because the stage is the composition — on a
     * non-16:9 screen it is letterboxed, and chrome anchored to the window would
     * float away from the deck it belongs to. */
    function placeChrome() {
      if (!rec.foot) return;
      var st = stageEl();
      // No stage means this is not one of the two players (nothing ships that way
      // today) — fall back to the viewport so the chrome is still on screen.
      var r = st ? st.getBoundingClientRect()
                 : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight,
                     bottom: window.innerHeight };
      if (!r.width) return;
      var bw = Math.round(r.width * BAND), bh = Math.round(r.height * BAND);
      var css = function (el, o) { Object.keys(o).forEach(function (k) { el.style[k] = o[k] + 'px'; }); };
      css(rec.foot, { left: r.left, top: r.bottom - bh, width: r.width, height: bh });
      css(rec.strip, { left: r.left, top: r.top, width: bw, height: r.height - bh });
      // The flag is exactly the band wide, so the strip stands on it squarely.
      if (rec.els.flag) rec.els.flag.style.width = bw + 'px';
    }

    /* The spine's tiles: one per slide, in deck order, each owning a contiguous run
     * of the plan. Built from the plan rather than from `items`, so a slide that
     * contributes no atoms (a live slide, an unfilled reel) contributes no tile —
     * there is nothing to be part-way through. */
    function spineRuns() {
      var runs = [], last = null;
      rec.plan.forEach(function (p, k) {
        if (!last || last.i !== p.i) { last = { i: p.i, from: k, count: 0 }; runs.push(last); }
        last.count++;
      });
      return runs;
    }
    /* A tile's two lines, from the slide's own header hierarchy (`slide_title`), so
     * the spine reads in the same words as the wall's header and the deck builder's
     * rows. The leaf names the slide ("Highlights", "Batting", "Pre-match"); above it
     * sits the phase, which is what groups an innings together. */
    function tileName(i) {
      var it = items[i] || {};
      var lvl = (it.title || it.slug || '').split(' · ');
      var leaf = lvl[lvl.length - 1] || it.slug;
      var phase = ((it.atoms || [])[0] || {}).phase || null;
      var above = (phase && phase !== leaf) ? phase : (lvl.length > 1 ? lvl[lvl.length - 2] : '');
      return { l1: above, l2: leaf };
    }

    function buildSpine() {
      if (!rec.strip) return;
      rec.strip.innerHTML = '';
      rec.runs = spineRuns();
      // Words need room. Past about a dozen tiles there isn't any, so the spine drops
      // to bars — which still answers "where am I in the deck", the question it exists
      // to answer.
      rec.strip.classList.toggle('dense', rec.runs.length > 12);
      rec.tiles = rec.runs.map(function (run, k) {
        var t = document.createElement('div');
        t.className = 'tile';
        var prev = rec.runs[k - 1];
        if (prev && (items[run.i].group || items[run.i].slug) !== (items[prev.i].group || items[prev.i].slug)) {
          t.className += ' set';
        }
        var fill = document.createElement('div'); fill.className = 'fill';
        t.appendChild(fill);
        var nm = tileName(run.i);
        if (nm.l1) t.appendChild(mk('span', 'l1', nm.l1));
        t.appendChild(mk('span', 'l2', nm.l2));
        // A reel's clips stack into this one tile, so it says how many are in there.
        // Clips, not atoms: a clip carrying both cards is three beats but one ball,
        // and "18 clips" is what the editor curated and what the narrator sees.
        if (items[run.i].video) {
          var panels = {}, holds = 0;
          for (var q = run.from; q < run.from + run.count; q++) {
            panels[rec.plan[q].panel] = 1;
            // Every card atom is a hold: the pad plays out and the reel freezes on its
            // last frame until a tap. That is the number of times the narrator has to
            // do something inside this tile, which is worth knowing before arriving at
            // it — and it is silent when there are none, because most reels have none.
            if (rec.plan[q].card) holds++;
          }
          t.appendChild(mk('span', 'n', Object.keys(panels).length + ' clips'
            + (holds ? ' · ' + holds + (holds === 1 ? ' hold' : ' holds') : '')));
        }
        rec.strip.appendChild(t);
        return { el: t, fill: fill, run: run };
      });
      spineDraw();
    }
    function mk(tag, cls, text) {
      var n = document.createElement(tag);
      n.className = cls;
      n.textContent = text;
      return n;
    }
    /* Gold fills each tile as its atoms are played — the same language as the clip
     * countdown along the footer's top edge, turned through ninety degrees. */
    function spineDraw() {
      (rec.tiles || []).forEach(function (t) {
        var done = rec.pos >= t.run.from + t.run.count;
        var now = rec.pos >= t.run.from && !done;
        var pct = done ? 100
                : now ? ((rec.pos - t.run.from + 1) / t.run.count) * 100
                : 0;
        t.fill.style.width = pct.toFixed(1) + '%';
        t.el.classList.toggle('now', now);
      });
    }

    function fmtClock(sec) {
      var t = Math.max(0, Math.floor(sec));
      return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
    }
    /* What the prompt calls the beat that is coming.
     *
     * Clip labels are ordinal-prefixed (`4. Four through cover`) so that two similar
     * balls stay apart in a LIST — the deck builder's rows, /narrate's beat table. A
     * prompt is not a list: it shows one thing at a time and the narrator is about to
     * read it aloud, where a leading number is something to trip over. So the ordinal
     * is dropped here and kept in the data.
     *
     * A card beat is named for what it IS — a flashcard, `/curate`'s own word for it —
     * and not for the ball it sits against. Two reasons: the ball's narrative is the
     * next beat's prompt anyway, so carrying it here says it twice; and pre versus post
     * is a fact about the timeline rather than about the performance. What the narrator
     * needs off this line is "a card is coming, and these are its figures", which is
     * the figures' own job.
     */
    function promptName(p) {
      if (!p) return '—';
      if (p.card) return 'Flashcard';
      var name = (p.label || p.phase || p.slug).replace(/^\d+\.\s+/, '');
      // A clip's ball narrative stands on its own — the tile above it already says
      // which innings' reel this is, and a wicket does not need a heading.
      if ((items[p.i] || {}).video) return name;
      // Everything else is prompted in the SAME two parts as its tile in the spine
      // ("2nd Innings · Bowling"), because a leaf on its own is not a name: thirteen
      // slides in this build are called "Leaderboards" and every innings has a
      // "Bowling". Where the atom is finer than the slide — a carousel panel — the
      // slide is the heading and the panel is the leaf ("Fantasy League · Top
      // Managers"). Both come from tileName, so the strip and the prompt cannot
      // drift into two different names for one thing.
      var nm = tileName(p.i);
      if (name === nm.l2) return nm.l1 ? nm.l1 + ' · ' + nm.l2 : nm.l2;
      return nm.l2 + ' · ' + name;
    }
    function cardFigures(p) {
      var c = p && p.info;
      if (!c) return '';
      var bits = [c.name, c.headline, c.sublabel].filter(Boolean);
      (c.stats || []).forEach(function (s) { bits.push(s.v + ' ' + s.l); });
      return bits.join(' · ');
    }

    function hudError(msg) { if (rec.els.err) rec.els.err.textContent = msg || ''; }

    /* What ends this beat — and therefore what the narrator's next input is for.
     *
     * The rule is one line: **an atom that waits for you says so; one that ends itself
     * says nothing.** A clip rolling to its own end needs no instruction (the countdown
     * along the top edge is already saying it); everything that will sit there until it
     * is touched does, because the deck looks identical either way.
     *
     * Two of the three are exceptional and read gold. The third — a static slide, which
     * is simply the resting state of every panel in the deck — is muted, or a 40-beat
     * sitting would spend most of itself shouting an instruction the narrator learned
     * in the first ten seconds.
     */
    /* The line names WHO IS DRIVING this beat, and what your next input does about
     * it. Every state advertises its own key, which is why there is no separate
     * rehearsal key-map: the deck teaches itself as you play it, in the take as much
     * as before it.
     *
     * Two vocabularies, deliberately, because two different things stop:
     *
     *   - a clip is footage, and what stops is the PICTURE — ROLLING / FROZEN, and
     *     the stop is recorded as a `freezes[]` entry on the beat. "Freeze", not
     *     "pause": the take never stops, so pause would name the wrong thing, and
     *     freeze is already the model's own word.
     *   - a static beat has no picture to stop; what stops is the CLOCK — AUTO /
     *     MANUAL, an agency question, and nothing is recorded either way.
     */
    function instruction() {
      var it = items[current] || {};
      if (slideHold) return 'HOLD · → to advance';
      if (it.video) {
        return playing ? 'ROLLING · Space to freeze' : 'FROZEN · Space to roll on';
      }
      // MANUAL carries the discovery of AUTO, since a narrator who never finds it
      // has to cue a slideshow they meant to hand over to.
      return playing ? 'AUTO · Space to take over'
                     : 'MANUAL · → to advance · Space runs the deck';
    }

    function hudDraw() {
      if (!rec.foot) return;
      var e = rec.els;
      var nxt = rec.pos >= 0 ? rec.plan[rec.pos + 1] : rec.plan[0];
      // The top line is the INSTRUCTION and nothing else. There is no caption for the
      // current atom because there is no question about it: it is on screen, filling
      // the frame, with its own caption and its own card. The spine says where in the
      // deck it sits. What the deck cannot say is what your next input does, so that
      // is the only thing here — and it is the gold, because it is an instruction.
      e.beat.innerHTML = '<em>' + instruction() + '</em>';
      // The next atom is the one thing the deck itself cannot show, so it gets the
      // size — and the card figures, which are prep. On screen they are already on
      // the card, at wall scale.
      e.next.innerHTML = nxt
        ? '<span>NEXT</span>' + promptName(nxt)
          + (cardFigures(nxt) ? '<i>' + cardFigures(nxt) + '</i>' : '')
        : '<span>NEXT</span><i>end of deck</i>';
      // Two words while rehearsing, because the clock's slot is free and the tile can
      // hold them — and because REHEARSE alone says what you are doing without ever
      // saying what to. A TAKE, the thing this is a rehearsal for and the word the
      // rest of the design uses for it. `Rec` stays one word: it has the clock under
      // it, and a state you are already in needs less naming than one you are about
      // to leave.
      e.state.textContent = rec.state === 'rehearse' ? 'Rehearse take'
        : rec.state === 'arming' ? 'Arming'
        : rec.state === 'recording' ? 'Rec' : 'Stopped';
      // The clock is the TAKE's clock — "the take is the artefact; its clock is the one
      // true time" — so before a take there is no time to show, and a 0:00 sitting
      // under REHEARSE is a number that means nothing. It appears with the first
      // recorded chunk, which is also the moment it starts being true.
      e.clock.style.display = rec.t0 ? '' : 'none';
      rec.foot.classList.toggle('on', rec.state === 'recording');
      spineDraw();
    }

    function buildHud() {
      hudStyles();
      // The same retraction the live chrome uses — one rule, shared, in player.html.
      document.body.classList.add('record-chrome');

      var foot = document.createElement('div');
      foot.id = 'wcc-rec-foot';
      var prog = document.createElement('div');
      prog.id = 'wcc-rec-progress';
      progressFill = document.createElement('i');
      prog.appendChild(progressFill);
      foot.appendChild(prog);

      // The gold tile, in the corner where the live ticker's flag sits: the take's
      // state and its clock, and the header the strip above it doesn't need to repeat.
      var flag = document.createElement('div'); flag.className = 'flag';
      var lbl = document.createElement('div'); lbl.className = 'lbl';
      var dot = document.createElement('i');
      var state = document.createElement('span');
      lbl.appendChild(dot); lbl.appendChild(state);
      var clock = document.createElement('div'); clock.className = 'clock'; clock.textContent = '0:00';
      flag.appendChild(lbl); flag.appendChild(clock);
      foot.appendChild(flag);

      var txt = document.createElement('div'); txt.className = 'txt';
      var r1 = document.createElement('div'); r1.className = 'r1';
      var beat = document.createElement('span'); beat.className = 'beat';
      var err = document.createElement('span'); err.className = 'err';
      [beat, err].forEach(function (x) { r1.appendChild(x); });
      var next = document.createElement('div'); next.className = 'next';
      txt.appendChild(r1); txt.appendChild(next);
      foot.appendChild(txt);

      // The transport lives here in record mode: the floating control bar is a
      // surface over the slide, which is the one thing this layout is getting rid of.
      var meter = document.createElement('div'); meter.className = 'meter';
      var fill = document.createElement('i'); meter.appendChild(fill);
      foot.appendChild(meter);

      var acts = document.createElement('div'); acts.className = 'acts';
      playBtn = button('pause', '', function () { setPlaying(!playing); });
      acts.appendChild(playBtn);
      acts.appendChild(button('next', '', next2));
      var audBtn = document.createElement('button'); audBtn.textContent = 'Clip audio';
      var armBtn = document.createElement('button'); armBtn.className = 'primary'; armBtn.textContent = 'Arm ▸';
      acts.appendChild(audBtn); acts.appendChild(armBtn);
      foot.appendChild(acts);

      var strip = document.createElement('div');
      strip.id = 'wcc-rec-strip';

      document.body.appendChild(foot);
      document.body.appendChild(strip);
      rec.foot = foot; rec.strip = strip;
      rec.els = { flag: flag, dot: dot, clock: clock, state: state, beat: beat, next: next,
                  meter: fill, arm: armBtn, aud: audBtn, err: err };
      armBtn.addEventListener('click', function () {
        if (rec.state === 'rehearse') arm();
        else if (rec.state === 'recording') stopTake();
      });
      audBtn.addEventListener('click', function () { setClipAudio(!rec.clipAudio); });
      setClipAudio(false);
      buildSpine();
      placeChrome();
      window.addEventListener('resize', placeChrome);
      window.addEventListener('orientationchange', placeChrome);
      updatePlayBtn();
      hudDraw();
    }
    // `next` is the prompt element inside buildHud, so the nav function needs naming
    // out of its way.
    function next2() { next(); }

    /* Clip audio is muted while recording: speakers bleed into the mic, and the
     * render mixes the R2 audio itself under loudnorm/duck, so hearing it live buys
     * only timing feel. The toggle is for anyone wearing headphones. */
    function setClipAudio(on) {
      rec.clipAudio = !!on;
      if (rec.els.aud) rec.els.aud.classList.toggle('on', rec.clipAudio);
      items.forEach(function (it, i) { send(i, 'set-mute', { muted: !rec.clipAudio }); });
    }

    /* ---- arming and the take ---------------------------------------------- */
    function meterLoop() {
      if (!rec.audio) return;
      var buf = rec.audio.buf;
      rec.audio.analyser.getByteTimeDomainData(buf);
      var peak = 0, sum = 0;
      for (var i = 0; i < buf.length; i++) {
        var v = (buf[i] - 128) / 128;
        sum += v * v;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
      var rms = Math.sqrt(sum / buf.length);
      if (rec.els.meter) rec.els.meter.style.height = Math.min(100, rms * 260).toFixed(1) + '%';
      if (rec.foot) rec.foot.classList.toggle('clipped', peak > 0.98);
      requestAnimationFrame(meterLoop);
    }

    function arm() {
      if (rec.state !== 'rehearse') return;
      rec.state = 'arming';
      hudError('');
      hudDraw();
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      }).then(function (stream) {
        rec.stream = stream;
        var Ctx = window.AudioContext || window.webkitAudioContext;
        var ctx = new Ctx();
        var an = ctx.createAnalyser();
        an.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(an);
        rec.audio = { ctx: ctx, analyser: an, buf: new Uint8Array(an.fftSize) };
        meterLoop();
        countIn(3);
      }).catch(function (e) {
        rec.state = 'rehearse';
        hudError('no microphone: ' + (e && e.name ? e.name : 'blocked'));
        hudDraw();
      });
    }

    function countIn(n) {
      var el = document.getElementById('wcc-count');
      if (!el) { el = document.createElement('div'); el.id = 'wcc-count'; document.body.appendChild(el); }
      el.textContent = n > 0 ? String(n) : '';
      if (n <= 0) { el.remove(); startTake(); return; }
      setTimeout(function () { countIn(n - 1); }, 900);
    }

    /* The recorder's mime type is whatever the browser will actually give us:
     * Chrome records WebM/Opus, Safari MP4/AAC. The take carries its own extension
     * into the export rather than the pipeline assuming one. */
    function pickMime() {
      var want = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      for (var i = 0; i < want.length; i++) {
        try { if (MediaRecorder.isTypeSupported(want[i])) return want[i]; } catch (e) {}
      }
      return '';
    }

    function startTake() {
      var mime = pickMime();
      var deck = opts.deck || null;
      var s = WccTakeStore.create({
        title: (deck && deck.title) || document.title,
        deckKey: opts.deckKey || null,
        mime: mime,
        ext: mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm',
        build_version: (deck && deck.build_version) || null,
        source_match: (deck && deck.source_match) || null,
        // The beat list, as played. /narrate names its rows from this rather than
        // re-deriving atoms from the deck: the reel's atoms are the sitting's live
        // curation, and the take is the only thing that knows what was actually in
        // front of the narrator.
        plan: rec.plan
      });
      rec.session = s;
      // The deck as played, stored where decks are stored — /narrate exports it
      // beside the timeline, and the whole point of a frozen deck is that the
      // render is shot against what the narrator actually saw.
      if (deck && !WccTakeStore.putDeck(s.id, deck)) {
        hudError('deck too large to store — the take will still record');
      }
      try {
        rec.recorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
      } catch (e) {
        rec.state = 'rehearse';
        hudError('cannot record: ' + e);
        return;
      }
      rec.recorder.ondataavailable = function (ev) {
        if (!ev.data || !ev.data.size) return;
        if (!rec.t0) {
          // MediaRecorder.start() does not begin capturing when it returns, so a cue
          // stamped off performance.now() from that moment sits tens of ms out. The
          // first chunk covers roughly one timeslice, so its ARRIVAL minus that
          // timeslice is the closest thing to audio t=0 the API offers. /narrate
          // carries a ±500ms global nudge for whatever the browser actually did.
          rec.t0 = Math.min(performance.now() - TIMESLICE_MS, rec.armedAt || Infinity);
          if (!isFinite(rec.t0)) rec.t0 = performance.now();
          beginDeck();
        }
        WccTakeStore.appendChunk(rec.session.id, rec.seq++, ev.data).catch(function (e) {
          hudError('audio store failed — stop and check /narrate');
        });
      };
      rec.armedAt = performance.now();
      rec.recorder.start(TIMESLICE_MS);
      rec.state = 'recording';
      rec.els.arm.textContent = 'Stop ■';
      rec.els.arm.classList.remove('primary');
      rec.clock = setInterval(function () {
        rec.els.clock.textContent = fmtClock(takeTime());
        if (rec.pending) hudDraw();
      }, 250);
      hudDraw();
    }

    /* The take starts before the first atom does, so there is lead-in silence to
     * trim against — and the first cue is stamped by the deck arriving, not by the
     * recorder starting. */
    function beginDeck() {
      lastAtom = null;
      clipPhase = null;
      arrive(0, 0, !!items[0].video);
      recSync();
    }

    function stopTake() {
      if (rec.state !== 'recording') return;
      rec.state = 'stopping';
      freezeEnd();
      setPlaying(false);
      if (rec.clock) { clearInterval(rec.clock); rec.clock = null; }
      var s = rec.session;
      // Re-stamp the plan: a windowed deck refines a reel's atoms as its frame loads,
      // so the list is only complete once the deck has been played through.
      s.plan = rec.plan;
      s.duration = +takeTime().toFixed(3);
      s.stopped = true;
      WccTakeStore.save(s);
      var done = function () {
        try { rec.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        location.href = '/narrate/?take=' + encodeURIComponent(s.id);
      };
      try {
        rec.recorder.onstop = function () { setTimeout(done, 150); };
        rec.recorder.stop();
      } catch (e) { done(); }
    }

    function startRecord() {
      buildPlan();
      buildHud();
      // GH Pages caches this HTML for 10 minutes and /assets for 4 hours, so a page
      // can pair fresh JS with an HTML document that predates the take store's
      // script tag. Say so before the narrator has performed anything, rather than
      // failing at the end of a twenty-minute take.
      if (!window.WccTakeStore) {
        hudError('reload this page — the take store has not loaded (stale cache)');
        rec.els.arm.disabled = true;
      }
      // Rehearsal is the deck exactly as the iPad plays it, with the HUD up: the
      // whole value of a rehearsal is seeing the next-up prompts in place.
      recSync();
    }

    /* Drive the player from the page hosting it (`?hosted`). /narrate plays a deck
     * back beat by beat against the take, and it must reach a beat the same way the
     * narrator did rather than by a second addressing scheme — so this is the
     * player's own nav, called from outside. A card atom is reached through the
     * slide (`goto-atom` on the bridge), because a clip's segments are the slide's
     * business, not the player's. */
    function gotoAtom(a, at) {
      if (!a) return;
      var i = -1;
      for (var k = 0; k < items.length; k++) if (items[k].slug === a.slide) { i = k; break; }
      if (i < 0) return;
      var panel = a.panel || 0;
      arrive(i, panel, false);              // paused: review positions, it doesn't play
      clipPhase = a.card || null;
      // `at` rides through untouched: how far into a clip's footage to park is the
      // slide's arithmetic, not the player's.
      send(i, 'goto-atom', { panel: panel, card: a.card || null, at: at || 0 });
      recSync();
    }

    /* ---- bridge messages from slides ---- */
    window.addEventListener('message', function (e) {
      var d = e.data; if (!d) return;
      if (d.type === 'wcc-player' && hosted) {
        if (d.action === 'goto-atom') gotoAtom(d.atom, d.at);
        else if (d.action === 'play') setPlaying(true);
        else if (d.action === 'pause') setPlaying(false);
        return;
      }
      // The flash overlay isn't in `items`; handle its done signal before the idx gate.
      if (d.type === 'wcc-flash-done' && flashWin() && e.source === flashWin()) { onFlashDone(); return; }
      var idx = items.findIndex(function (it) { return it.frame && it.frame.contentWindow === e.source; });
      if (idx < 0) return;

      /* A thumb went sideways across the current slide (slide-bridge reports it;
       * only the portrait column leaves a slide exposed to touch, so this is that
       * surface's horizontal gesture arriving by a different route).
       *
       * It means exactly what a sideways swipe means on the landscape player:
       * next()/prev(), the atom move — so a reel steps clip by clip and a carousel
       * panel by panel, and the two surfaces agree about what a swipe does.
       *
       * The pairing that gives portrait is worth naming: VERTICAL is the step axis
       * and HORIZONTAL is the axis inside a step. On a 20-clip reel — one step, by
       * the /deck rule — scrolling down leaves the reel entirely, which nothing
       * could do before, while swiping steps through its clips.
       *
       * Ignored where the player has another driver (hosted) or another gesture
       * layer (landscape's #wcc-tap, which means these never arrive), and while
       * pinched in, where a sideways drag is the viewer panning a magnified slide.
       */
      if (d.type === 'wcc-swipe' && idx === current) {
        if (!interactive || hosted || zoomed) return;
        /* VERTICAL is nobody's, here. It belongs to a step's own scroller, and a
         * slide reporting out of an iframe is a BAND — which has no scroller. The
         * landscape stack has no vertical axis either. Reported so it can be
         * recognised in order to be ignored (and so the doc's permissive variant of
         * the rule would be a change here rather than in the bridge). */
        if (d.axis === 'y') return;
        /* HORIZONTAL is the step axis on a stage that has steps — the portrait
         * surface, whose bands are transparent to touch, so this only arrives from a
         * slide that kept its pointer events by declaring `data-taps`. Everywhere
         * else it is the atom move, which is what it has always meant on the
         * landscape player. */
        if (stage && stage.step) { stage.step(d.dir === 'next' ? 1 : -1); return; }
        if (d.dir === 'next') next(); else prev();
        return;
      }

      // wcc-done: video ended naturally — advance slide (works in both kiosk and interactive)
      if (d.type === 'wcc-done' && idx === current) {
        // Hosted: the take decides when a beat ends, so a slide running out of its
        // own footage is not a reason to move. It holds where it stopped.
        if (hosted) return;
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
      // The playhead a slide reports on request. Only a freeze wants it — `at` on a
      // freeze is media time within the clip, which the player has no way to know.
      if (d.type === 'wcc-time' && idx === current) { mediaTime = d.t; return; }
      if (d.type === 'wcc-slide') {
        var first = counts[idx] == null;
        counts[idx] = d.panels;
        tapThrough[idx] = !!d.taps;
        if (idx === current) applyTapThrough();
        if (idx === current) setEdges(d);
        if (track && d.atoms) {
          // A reel answers with its own atom list, which during the sitting is the
          // editor's live curation rather than anything the build has seen. It also
          // re-announces after `set-clips`, so the plan follows the curation.
          refineAtoms(idx, d.atoms);
        }
        if (record) send(idx, 'set-mute', { muted: !rec.clipAudio });
        if (hosted) send(idx, 'set-hold-end', { hold: true });
        // Re-apply state on the current slide's handshake (covers the load race
        // where our first commands arrived before the bridge was listening).
        if (idx === current && first && Date.now() - shownAt < 2000) applyState(playing ? 0 : panelIndex);
      } else if (d.type === 'wcc-panel' && idx === current) {
        var movedPanel = panelIndex !== d.panel;
        panelIndex = d.panel;
        setEdges(d);
        // The slide is the authority on which panel it is showing, so this is where
        // the column re-aligns — including for a panel the PLAYER's timer stepped,
        // which no other path reports.
        if (movedPanel) stageAtom();
        if (track && movedPanel) {
          clipPhase = items[current].video && planPreAt(current, panelIndex) ? 'pre' : null;
          recSync();
        }
        if (!items[current].video) return;
        // A card hold: the reel has frozen on a pad's last frame and is waiting for a
        // tap, so nothing may run underneath it — not the countdown fill, and not the
        // slide-advance backstop, which would otherwise carry the deck off the card
        // mid-sentence. Releasing the hold re-arms both over what is left of the clip.
        slideHold = !!d.hold;
        // Which atom of the clip is running. The plan already put us on the pre card
        // when the pad started (applyState); the echo is what ends it and what names
        // a post card, since only the slide knows a card is up.
        if (track) {
          if (d.hold) clipPhase = d.card || clipPhase || 'pre';
          else if (d.hold === false) clipPhase = null;
          recSync();
          // A hold is a change of instruction without being a change of atom — the
          // pre card was entered when its pad started — so it redraws on its own.
          hudDraw();
        }
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
      if (hosted) return;              // same rule as the bar: one driver
      // PageDown rides along with the right arrow for free, which makes a Bluetooth
      // page-turner pedal work — worth having when you are standing at a mic rather
      // than sitting at a screen.
      if (e.key === 'PageDown' && interactive) { e.preventDefault(); next(); return; }
      if (e.key === 'Escape' && record) { e.preventDefault(); stopTake(); return; }
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

    /* The news-flash overlay, handed over after the fact. It is a property of the
     * LANDSCAPE stage — a full-bleed 16:9 takeover raised over a 16:9 stage — so a
     * deck that opened in portrait has none, and gets one if the phone is turned
     * (see ensureLiveChrome in player.html). Boot still passes it through `start`. */
    window.WccPlayer.setFlashFrame = function (f) {
      flashItem = f ? { frame: f } : null;
    };

    /* Hand a stage the transport it drives.
     *
     * `fwd` and `back` are THE verbs for crossing a slide boundary, and a stage must
     * use them rather than `goTo` for a step that lands on the next or previous
     * slide. They are what the control bar crosses on, and they carry the meaning a
     * jump does not:
     *
     *   fwd  — keeps `playing` across the boundary AND starts a reel, because
     *          stepping forward onto one is a request to watch it
     *   back — lands on the previous slide's LAST atom, and pauses, because someone
     *          going backwards is looking for what they just left
     *
     * `goTo` is the viewer reaching a slide *by name* — a contents sheet, an index —
     * and is deliberately none of that: slide's first atom, `playing` carried, no
     * media started. Using it for a step is what made a swipe and a bar press
     * disagree about reels, about which atom you land on going back, and about
     * whether the deck is still playing (docs/portrait-decks.md, "Drift"). */
    function attachStage(s) {
      if (!s || !s.attach) return;
      s.attach({
        goTo: function (i) { if (i !== current) arrive(i, 0, playing); },
        fwd: fwdSlide,
        back: backSlide,
        toggle: onTap,
        next: next,
        prev: prev
      });
    }

    /* Change stage mid-session — a phone turned, arriving on the other surface.
     *
     * BOTH WAYS. The deck keeps playing: same player, same items, same place, same
     * controls. What moves is where the frames live, and that is the one real cost —
     * an iframe reloads when it is moved in the DOM, so the slide on screen (and its
     * <=2 windowed neighbours) comes back fresh and a clip loses its position.
     * Everything the boot decision used to fan out into — the control bar, the
     * windowing, the slides' own interactive variant — is in place on both stages
     * now that a deck page is interactive by route, which is what makes this a swap
     * rather than the page reload it replaced.
     *
     * `null` is the DEFAULT stage: the wall's crossfade stack, every frame at
     * inset:0 in `opts.slideHost` and revealed by an `active` class. It is a stage
     * like any other here even though it is not an object — the only thing this
     * needs from a stage is where a frame goes, and for the stack that is one
     * element for all of them.
     *
     * Three things have to be undone or redone in the right order, and each is
     * somebody's property:
     *   - FRAMES. A stage that renders a slide itself (a portrait fragment) wants
     *     no frame; the stack wants one for every slide, so a frameless item gets
     *     its document back from `opts.newFrame`. Done first, so the outgoing stage
     *     is empty by the time it is dismantled.
     *   - THE OUTGOING STAGE'S OWN CHROME — its column, its share button. Only it
     *     knows what it built, so it is asked to `detach()`. The two progress
     *     instruments are the player's and stay put across the swap; only their
     *     insets change, which `schedulePlace()` below re-measures.
     *   - THE GESTURE LAYER, which is the player's and follows the stage: a stage
     *     that owns input has none, and one that does not gets it back.
     */
    window.WccPlayer.setStage = function (s) {
      s = s || null;
      if (s === stage) return;
      // Going home needs to know where home is. An older template that does not
      // pass `slideHost` can still be upgraded onto a stage (that was the one-way
      // swap), but cannot be brought back to a stack it never named — so decline,
      // and leave the deck exactly as it is rather than half-moved.
      if (!s && !slideHost) return;
      var prev = stage;
      stage = s;
      function hostFor(i) { return s && s.host ? s.host(i) : slideHost; }
      for (var i = 0; i < n; i++) {
        var host = hostFor(i);
        var f = items[i].frame;
        /* The new stage renders this slide itself (a portrait fragment), so its
         * document is not merely in the wrong place — it should not exist. Tear it
         * down through the usual path, which is the only reliable reclaim, and then
         * drop the frame so nothing reloads it: `reconcileWindow` would otherwise
         * bring back an invisible document behind the fragment on the next move. */
        if (!host) {
          if (!f) continue;
          unloadFrame(i);
          if (items[i].frame.parentNode) items[i].frame.parentNode.removeChild(items[i].frame);
          items[i].frame = null;
          loaded[i] = true;      // nothing left to load — see the seed above
          pendingCmds[i] = [];   // and nothing left to send them to
          continue;
        }
        /* ...and the reverse: this stage shows slides as documents, so an item that
         * had none needs one back. Cold — `dataset.src` and no `src` — because the
         * arrival below reconciles the window and loads exactly what belongs in it.
         * Giving it a src here would load a document the reader may be nowhere
         * near, on the surface the windowing exists to protect. */
        if (!f) {
          if (!newFrame) continue;
          f = items[i].frame = newFrame(i);
          loaded[i] = false;
          pendingCmds[i] = [];
          host.appendChild(f);
          continue;
        }
        if (f.parentNode === host) continue;
        host.appendChild(f);        // moves it, which reloads it
        // Re-arm the load bookkeeping: whatever was queued belonged to a document
        // that no longer exists, and the bridge will handshake again.
        if (frameIsLive(i)) { loaded[i] = false; pendingCmds[i] = []; watchLoad(i); }
      }
      // The stage that is leaving takes its own chrome with it.
      if (prev && prev.detach) prev.detach();
      // A stage that owns input gets no gesture layer — `#wcc-tap` is a fixed
      // full-viewport overlay and would swallow the scroll of a stage that scrolls.
      // The stack does not scroll, so the layer comes back with it.
      if (s && s.ownsInput) {
        if (tapEl && tapEl.parentNode) tapEl.parentNode.removeChild(tapEl);
      } else if (tapEl && !tapEl.parentNode && !hosted) {
        document.body.appendChild(tapEl);
      }
      attachStage(s);
      // A stage arriving mid-session inherits the zoom state rather than assuming
      // the reader is pinched out: rotating while zoomed in is rare, and a surface
      // that guessed would navigate under them once.
      if (s && s.zoom) s.zoom(zoomed);
      schedulePlace();                // the bar's letterbox bands just changed shape
      // Arrive where we already are: the current frame has just reloaded and needs
      // its panel state back, and the new stage needs to reveal it.
      arrive(current, panelIndex || 0, playing);
    };

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
      attachStage(stage);
      if (record) startRecord();
      else if (hosted) {
        buildPlan();
        recSync();
        try { parent.postMessage({ type: 'wcc-player-ready' }, '*'); } catch (e) {}
      }
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

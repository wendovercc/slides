/* portrait.js — the phone surface.
 *
 * docs/portrait-decks.md, phases 0 and 1. A deck opened in portrait on a phone
 * becomes a COLUMN of full-height steps that snap, instead of a 16:9 rectangle
 * floating in the middle of the screen. Vertical is forward.
 *
 * A step is rendered one of two ways, and the difference is one line of authoring
 * (whether the slide's template has a portrait fragment):
 *
 *   FRAGMENT (phase 1) — the slide's own portrait layout, fetched from
 *     /slide/<slug>/portrait.html and inserted as REAL DOM in this document. No
 *     design box, no --fit: it fills the step, sizes itself from the portrait scale
 *     in assets/css/portrait.css, and SCROLLS if it is longer than a screen. That
 *     is the phone rendering proper.
 *
 *   BAND (phase 0) — the fallback for a template that has no portrait layout yet:
 *     its existing 16:9 self, in a letterbox band. The doc's "one case iframes earn
 *     their place", and the EASY iframe — a band's height is exactly `width x 9/16`,
 *     known before it loads, so a step's geometry never depends on measuring what is
 *     inside it.
 *
 * Taking the band first is what made this incremental: every deck we build already
 * has a phone surface, and a portrait fragment upgrades ONE STEP of it rather than
 * being the precondition for a deck having the surface at all. Nothing is
 * all-or-nothing and no deck waits for its last template.
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
 * UNIFORM HEIGHTS SURVIVE FRAGMENTS, and that is the load-bearing decision: a
 * fragment step is one scrollport in the column and scrolls INSIDE itself, so
 * `scrollTop / stepHeight` still names the step and mandatory snap stays safe (the
 * trap the doc rejects it for is a step taller than the viewport, which this is not
 * — the interior is). What it costs is one gesture, because a scroller that
 * contains its overscroll can never chain out of itself: see armCommit.
 *
 * ---- orientation ----
 * The surface follows the shape of the screen, at boot and on every rotation, IN
 * BOTH DIRECTIONS (WccPlayer.surface, WccPlayer.setStage, and the watcher in
 * templates/player.html). Turn the phone sideways and the deck goes back to the
 * landscape presentation — a 16:9 slide with the controls in the right-hand band —
 * because that is the better use of a landscape screen and it is what the deck is
 * authored for. A column is what a PORTRAIT screen wants, not a preference the
 * viewer expressed.
 *
 * So this stage has to be able to take itself apart: everything it built is torn
 * down in `detach()`, which player-core calls on the way out. Column, rail, share
 * button, body class, the custom properties and the listeners — if it is not in
 * there, it survives a rotation and lands on the wrong surface.
 */
(function () {
  var styled = false;

  /* The shared portrait stylesheet — every FRAGMENT's styling, scoped per template
   * (assets/css/portrait.css). Fetched here rather than linked from the player's
   * <head> so a wall and a landscape deck never pay for it: it is a property of this
   * surface, and this file only runs when the surface is built.
   *
   * Versioned off this script's own URL, so the pair can never skew: /assets is
   * served with a long max-age and the build stamps `?v=` onto every asset URL, so
   * asking for the stylesheet at the same version as the JS that wants it is the
   * whole of the cache discipline (project_asset_cache_skew). */
  var SELF = (function () {
    var el = document.currentScript;
    return (el && el.src) || '';
  })();

  function linkCss() {
    if (document.getElementById('wcc-pcss')) return;
    var q = SELF.indexOf('?');
    var l = document.createElement('link');
    l.id = 'wcc-pcss';
    l.rel = 'stylesheet';
    l.href = '/assets/css/portrait.css' + (q >= 0 ? SELF.slice(q) : '');
    document.head.appendChild(l);
  }

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
      /* `bottom` is the DOCK, not 0: the control bar is a toolbar along the bottom
         edge in portrait (placeBar's `portrait` placement), and the scroller stops
         where it starts — so a step is the space above the bar and nothing ever
         scrolls behind it. `--pdock-h` is set from the bar's measured height the
         moment it is placed; until then it is 0 and the column is full height,
         which is what a deck with no controls (there is none today) would get. */
      '#wcc-pdeck{position:fixed;top:0;left:0;right:0;bottom:var(--pdock-h,0px);' +
      'z-index:5;overflow-y:auto;overflow-x:hidden;' +
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
      /* `--pshift` biases the band UP off centre, and it is an affordance rather
         than a taste: a step whose composition is symmetric reads as a finished
         screen, so a deck of centred bands gives a first-time reader nothing that
         says the column continues. Deeper matte below than above is the oldest cue
         there is for "there is more this way". Uniform across every step — a bias
         that switched off on the last one would make the bands jump. */
      '.psticky{position:sticky;top:0;height:var(--pstep-h,100dvh);z-index:1;' +
      'box-sizing:border-box;padding-bottom:var(--pshift,0px);' +
      'display:flex;align-items:center;justify-content:center;}' +
      /* Which leaves the first step with no in-flow snap target of its own — the
         marks below start one step in. A zero-height box at the slide's top edge is
         one, and adds nothing to the height. (Deliberately not `scroll-snap-align`
         on the sticky box itself: its snap area would travel with the stickiness and
         could hold the scroller against it.) */
      '.psnap{height:0;scroll-snap-align:start;}' +

      /* The band. Full-bleed width in portrait; capped by height so that a rotated
         phone (or an iPad) gets a band that fits rather than one that overflows. */
      /* The height cap subtracts `--pshift` for the same reason the padding adds it:
         the band has to fit the space that is left, or a rotated phone (or an iPad,
         where height rather than width is the binding constraint) overflows its
         step by exactly the bias. This formula and `fit()`'s `--pfit` are the same
         arithmetic and must stay that way. */
      '.pband{position:relative;' +
      'width:min(100%, calc((var(--pstep-h,100dvh) - var(--pshift,0px)) * 16 / 9));' +
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

      /* A step that is a portrait FRAGMENT (phase 1): our own DOM rather than a
         letterboxed document, so it is full-bleed and it SCROLLS. One scrollport
         tall in the column's flow like every other step — the interior is what may
         be longer — which is what keeps `scrollTop / stepHeight` reading the right
         step and keeps mandatory snap safe. Interior scrolling is entirely native;
         `overscroll-behavior: contain` gives the bounce at the end for free and
         stops the pull becoming the browser's. The one thing written by hand is the
         commit gesture (see armCommit). */
      '.pstep{height:var(--pstep-h,100dvh);scroll-snap-align:start;overflow-y:auto;' +
      'overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;' +
      'scrollbar-width:none;}' +
      '.pstep::-webkit-scrollbar{display:none;}' +
      /* The fragment sizes itself off the step, so the step has to have a definite
         inner height for `min-height:100%` to resolve against. */
      '.pstep>.pfrag{min-height:100%;}' +

      /* Progress rail — where you are in the DECK, counted in steps. A full-width
         hairline on the top edge, inside the safe area.
         Deliberately the opposite edge from the dock: the bar carries its own gold
         fill along its top, and that is the countdown within ONE step. Two gold
         hairlines a few pixels apart, measuring different things, would read as one
         confused instrument.
         It used to float in the matte under the band, which was fine while every
         step WAS a band; a fragment step is full-bleed, so that position is now the
         middle of somebody's reading. The top edge is the one line no surface
         claims — the share button sits below it and the control bar takes the
         bottom (placeBar's `below`, pinned to the viewport).

         SEGMENTED by default: one tick per step, filled up to where you are. A
         continuous fill answers "how far through", which a reader who does not yet
         know the deck HAS a length cannot use; ticks answer "how many", which is
         the question a first screen actually raises. It costs no viewport — it is
         the same hairline, cut. Long decks fall back to the continuous fill (see
         `TICK_MAX`): eighty-nine ticks on a phone is a dotted line, not a count. */
      '#wcc-prail{position:fixed;top:var(--sa-t,0px);left:0;z-index:58;' +
      'box-sizing:border-box;width:100%;height:max(3px,0.4vmax);' +
      'display:flex;gap:2px;padding:0 2px;overflow:hidden;pointer-events:none;}' +
      '#wcc-prail i{display:block;flex:1 1 0;height:100%;' +
      'background:rgba(255,255,255,0.18);transition:background 0.3s ease;}' +
      '#wcc-prail i.on{background:#d4af37;}' +
      // The continuous fallback: one child, scaled, on a track of its own.
      '#wcc-prail.cont{gap:0;padding:0;background:rgba(255,255,255,0.14);}' +
      '#wcc-prail.cont i{background:#d4af37;transition:transform 0.35s ease;' +
      'transform-origin:left;transform:scaleX(0);}' +

      /* The nudge. Motion is the only thing that reliably says "this scrolls" — a
         static hint says "there is more page", which is a different sentence and
         not the one a reader needs. So: a chevron that bobs, in the matte above the
         dock, shown once per page and then not again (`cueDone`). It
         teaches the gesture and gets out of the way; a cue that came back every
         time would be an instruction repeated to someone who has already obeyed it.
         Never takes a tap: it is a sign, not a control, and swallowing a scroll
         that starts on it would undo the whole point. */
      /* A BADGE, not a bare glyph. A chevron drawn straight onto the step has to
         survive whatever is behind it, and on a fragment card that is the card's own
         white text — where a white stroke with a shadow under it reads as a piece of
         the content that has come loose. The ring is what separates chrome from
         content, and it is deliberately the treatment the share button already had
         when it floated (navy ground, gold hairline, white glyph), so the reader has
         seen this vocabulary before and it says "control" without being one.
         Solid ground rather than a blur: it is over content for a few seconds and a
         backdrop filter is a compositing layer bought for that. */
      '#wcc-pcue{position:fixed;left:50%;z-index:57;pointer-events:none;' +
      'bottom:calc(var(--pdock-h,0px) + 2.2vmax);transform:translateX(-50%);' +
      'opacity:0;transition:opacity 0.6s ease;}' +
      '#wcc-pcue.on{opacity:1;}' +
      /* The positioner keeps `translateX`, the badge takes `translateY`: one element
         cannot hold a centring transform and an animated one at the same time — the
         keyframe would overwrite the centring and shunt the cue half its width right. */
      '#wcc-pcue i{display:flex;align-items:center;justify-content:center;' +
      'width:max(40px,4.7vmax);height:max(40px,4.7vmax);border-radius:50%;' +
      'background:rgba(10,28,58,0.9);border:1px solid rgba(212,175,55,0.45);' +
      'box-shadow:0 0.4vh 1.4vh rgba(0,0,0,0.5);' +
      'animation:wcc-pcue-bob 1.9s ease-in-out infinite;}' +
      '#wcc-pcue svg{display:block;width:2.3vmax;height:2.3vmax;fill:none;' +
      'stroke:#fff;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;}' +
      /* Travel only. An opacity pulse on a bordered badge reads as a flicker, where
         on a bare glyph it was half of what made it look alive. */
      '@keyframes wcc-pcue-bob{0%,100%{transform:translateY(-0.55vmax);}' +
      '50%{transform:translateY(0.55vmax);}}' +

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
      /* In the dock it is one of the bar's own controls, so it drops the float and
         takes their geometry. Sized off `#wcc-bar button` rather than restated, and
         only the things that differ (no border, transparent ground) are said here. */
      '#wcc-bar>#wcc-pshare{position:static;top:auto;left:auto;border:none;' +
      'background:transparent;flex:none;}' +
      '#wcc-bar>#wcc-pshare:active{background:rgba(255,255,255,0.12);}' +
      /* Pinned rather than left to cascade order: `#wcc-bar svg` (injected later, by
         player-core) fills its glyphs, and this one is drawn as outlined circles and
         connecting lines — filled, it becomes three dots and a smear. Outline puts it
         in the same family as the fullscreen and grip glyphs, which are also fill:none. */
      '#wcc-bar>#wcc-pshare svg{fill:none;}' +
      '#wcc-pshare svg{width:2.2vmax;height:2.2vmax;fill:none;stroke:#fff;' +
      'stroke-width:2;stroke-linejoin:round;stroke-linecap:round;}';
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* Above this many steps the rail stops counting and goes back to a fill: the
   * ticks have to be wide enough to read as separate marks, and `teams` is 89
   * positions. Sized off the narrowest phone we care about (390px), where 24 ticks
   * are ~14px each. */
  var TICK_MAX = 24;

  /* The badge is the outer <i>, and it is what bobs — the chevron sits still inside
   * it. A glyph moving within a fixed ring reads as a loose part; the whole control
   * moving reads as a nudge. */
  var CUE_ICON = '<i><svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<polyline points="6 9 12 15 18 9" /></svg></i>';

  /* Shown once per PAGE, and this module scope is exactly the right lifetime for
   * that — it outlives any one stage, so a rotation (which tears this stage down
   * and builds another) does not re-teach a gesture the reader has already used,
   * which was the whole requirement.
   *
   * It was `sessionStorage` first, and that was wrong in both directions. A session
   * is the TAB: the flag survived every reload, so the cue showed once ever and
   * then never again — invisible in testing and, for a real reader, absent from the
   * arrival it exists for if they had opened any deck earlier. And it was reaching
   * for storage (with a private-mode try/catch) to remember something that only
   * needs to be true for as long as the document does. A reload is a reader
   * arriving; showing them the cue again is correct. */
  var cueShown = false;

  /* The strip above the rail — the notch/status bar in a Safari TAB, and the
   * browser toolbar with it — is not ours to paint, but its tint is: iOS Safari
   * colours both from `<meta name="theme-color">`, and re-reads it live. The site
   * declares `#0f2346` in `_pwa_head.html`, which is the brand navy the home page
   * and the installed app's chrome are built on; against a portrait deck it lands
   * as a lighter band sitting directly on top of the gold rail, reading as a piece
   * of the page that has the wrong colour rather than as browser furniture.
   *
   * So the portrait stage takes it to the matte for as long as it is on screen, and
   * hands it back in `detach()` — a stage property like the dock and the rail, not
   * a change to the site's declared colour. The bottom toolbar gets the same tint,
   * which is a second gain: it stops being a separate shade under our dock.
   *
   * Set on the existing tag rather than an added one: Safari honours the FIRST
   * theme-color it finds, so an appended tag would be ignored. */
  var themeMeta = null, themeWas = null;
  function themeColor(to) {
    if (!themeMeta) themeMeta = document.querySelector('meta[name="theme-color"]');
    if (!themeMeta) return;
    if (to == null) {
      if (themeWas != null) { themeMeta.setAttribute('content', themeWas); themeWas = null; }
      return;
    }
    if (themeWas == null) themeWas = themeMeta.getAttribute('content') || '';
    themeMeta.setAttribute('content', to);
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

  /* Does this slide have a real portrait layout, or does it letterbox?
   *
   * `s.portrait` is the URL of the slide's published fragment (build.py writes one
   * per slide whose template has a portrait rendering; the deck's data.json carries
   * the flag). Everything else falls back to the band, which is the whole point of
   * having taken phase 0 first — a template gets a portrait layout when it gets
   * one, and no deck waits for its last template.
   *
   * The single-step condition is a PHASE-1 LIMIT, not a rule: a fragment is one
   * scrolling step here, so a slide the column gives several steps to (a carousel,
   * one step per panel) keeps its band until fragments learn to carry an addressable
   * step per atom. Both showcase cards — the two this phase exists for — are one
   * atom, and the templates that are not (scorecard, fantasy-league) are phases 3
   * and 4 anyway. Stated as a condition rather than left implicit because the
   * failure it prevents is silent: a multi-panel fragment would swallow every panel
   * after the first. */
  function fragUrl(s) {
    return (s && s.portrait && stepsFor(s) === 1) ? s.portrait : null;
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
    linkCss();
    document.body.classList.add('wcc-portrait');
    /* Read off the document rather than hard-coded, so the browser furniture and
       the column's own ground can never drift apart — they are the same token. */
    themeColor((getComputedStyle(document.documentElement)
                .getPropertyValue('--matte') || '').trim() || '#08152c');

    var deck = document.createElement('div');
    deck.id = 'wcc-pdeck';
    var bands = [];       // one band per LETTERBOXED slide — the iframe's home (else null)
    var steps = [];       // one scroller per FRAGMENT slide (else null)
    var fetched = [];     // fragment requested for this slide already
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
      bands = []; steps = []; fetched = []; slideEls = [];
      retable();
      for (var i = 0; i < list.length; i++) {
        var nsteps = stepsFor(list[i]);
        var el = document.createElement('div');
        el.className = 'pslide';
        el.dataset.slide = String(i);
        bands[i] = steps[i] = null;
        fetched[i] = false;
        slideEls[i] = el;
        /* A slide with a portrait fragment is not a band at all: its step is a
           scroller holding our own markup, full-bleed, sized by the portrait scale
           rather than the wall's design box. It needs neither the sticky mechanism
           (a fragment slide is one step) nor the zero-height snap target (an in-flow
           step carries its own snap alignment). The markup itself arrives later —
           see warm() — and nothing about the column's geometry waits for it, because
           a step is one scrollport whatever is inside it. */
        if (fragUrl(list[i])) {
          var step = document.createElement('div');
          step.className = 'pstep';
          el.appendChild(step);
          deck.appendChild(el);
          steps[i] = step;
          armCommit(step, el);
          continue;
        }
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
        for (var m = 1; m < nsteps; m++) {
          var mark = document.createElement('div');
          mark.className = 'pmark';
          el.appendChild(mark);
        }
        deck.appendChild(el);
        bands[i] = band;
      }
    }
    build();
    document.body.appendChild(deck);
    warm(0);   // the opening card, and its neighbours, before anything is shown

    var api = null;                 // the transport, handed over by attach()
    var rail = null;                // the fill inside the rail (continuous mode)
    var ticks = null;               // one <i> per step (segmented mode), or null
    var cue = null;                 // the scroll nudge, once per session
    var cueTimer = null;
    var chromeEls = [];             // everything this stage added outside the column
    /* Detached — the phone was turned and another stage has the deck now. Anything
     * that can still fire after that has to check it: a settle timer armed by the
     * reader's last scroll would otherwise land on a column that is no longer in the
     * document, read `scrollTop` off a detached node as 0, conclude the reader is on
     * step 0 and NAVIGATE THE DECK THERE — a rotation that quietly jumps you back to
     * the first slide. */
    var dead = false;
    var atSlide = 0, atPanel = 0;   // where the PLAYER says it is

    /* ---- geometry ---- */
    function stepH() { return deck.clientHeight || 1; }
    var lastH = 0;          // the step height the current scroll position is in
    // When the column last moved, and how long after that it counts as still moving.
    // Declared here rather than with the scroll machinery below because fit() runs
    // before that block does.
    var lastScrollAt = 0;
    var SCROLL_IDLE_MS = 300;

    function fit() {
      if (dead) return;
      var h = deck.clientHeight;
      if (!h) return;
      var root = document.documentElement.style;
      // One scrollport in px, so a step's height and `deck.clientHeight` are the
      // same number by construction — see .pmark.
      root.setProperty('--pstep-h', h + 'px');
      /* How far off centre a band sits (see .psticky). A fraction of the step so it
         holds its proportion on every screen, and capped so a landscape phone —
         where the band already fills most of the step — is not shoved into its own
         bottom edge. */
      var shift = Math.round(Math.min(h * 0.07, Math.max(0, (h - deck.clientWidth * 9 / 16) / 3)));
      root.setProperty('--pshift', shift + 'px');
      // The band's width, derived rather than measured off a band: a deck may now
      // have none in it at all (both of the pavilion's cards are fragments), and this
      // is the same width the CSS gives one — full bleed, capped by height so a
      // rotated phone gets a band that fits rather than one that overflows. The
      // `- shift` is the bias above; this and .pband's width must agree exactly.
      var w = Math.min(deck.clientWidth, (h - shift) * 16 / 9);
      if (w) root.setProperty('--pfit', w / 1920);

      /* EVERY STEP JUST CHANGED HEIGHT, AND `scrollTop` DID NOT.
       *
       * The step under the reader is `scrollTop / stepHeight`, so re-writing the
       * height silently re-points that ratio at a different step — and the browser's
       * mandatory snap then slides the column to it, which fires a scroll, which
       * `settle` reports to the transport as a navigation. Rotating a phone while on
       * photo 1 advanced the deck a slide, and it was not the stage swap doing it:
       * the resize handler had already moved the column before the swap's debounce
       * elapsed. (390->844 is a 2.5x change in step height; scrollTop 844 stops
       * meaning "step 1" and starts meaning "step 3".)
       *
       * So re-anchor on the step the PLAYER says we are on, which is the authority
       * here — geometry is what just became unreliable. Marked `pending` so the
       * scroll it causes is recognised as ours and reported to nobody. */
      if (h !== lastH) {
        var was = lastH;
        lastH = h;
        // Not while the reader is scrolling. iOS resizes the viewport when its own
        // chrome collapses, which happens DURING a scroll — and yanking a moving
        // column to a step boundary is worse than letting the scroll finish and
        // settle honestly wherever it lands. A rotation, the case this is for, is
        // never mid-scroll.
        if (was && Date.now() - lastScrollAt > SCROLL_IDLE_MS) {
          // The custom property above only takes effect at the next layout, and
          // `scrollTop` is meaningless until it does.
          void deck.scrollHeight;
          var k = (first[atSlide] != null) ? first[atSlide] + atPanel : indexAt();
          pending = k;
          if (pendingTimer) clearTimeout(pendingTimer);
          pendingTimer = setTimeout(clearPending, 1200);
          deck.scrollTop = k * h;
        }
      }
    }
    fit();
    // Named, because `detach` has to take them off again: a rotation away from this
    // surface leaves the closure alive in two listeners that would go on writing
    // --pstep-h and --pfit at a stage that no longer exists.
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);

    /* ---- fragments -----------------------------------------------------------
     * The portrait markup for a slide, fetched from the file the build published
     * beside the slide's own document and inserted as real DOM. No iframe: that is
     * the memory win (an off-screen step is not a render surface, which is what the
     * iOS jetsam work was about) and it is why one shared, scoped stylesheet has to
     * carry every template — see assets/css/portrait.css.
     *
     * Fetched near the reader rather than all at once. A three-step deck would not
     * care; a 38-step match package would be 38 requests at boot on a phone, and the
     * player already has a windowing discipline for exactly this. Nothing about the
     * column's geometry waits on the response: a step is one scrollport whether or
     * not its content has landed.
     *
     * A failed fetch leaves the step empty and RETRIABLE — `fetched` is only latched
     * on success — so a reader who scrolls back after regaining signal gets the card.
     */
    var FRAG_RADIUS = 2;

    function ensureFrag(i) {
      if (fetched[i] || !steps[i]) return;
      var url = fragUrl(list[i]);
      if (!url) return;
      fetched[i] = true;
      var el = steps[i];
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      }).then(function (html) {
        // `keep()` may have dropped this slide while the request was in flight.
        if (el.parentNode) el.innerHTML = html;
      }).catch(function () {
        // Re-derived rather than closed over: `keep()` may have renumbered the
        // column while this was in flight, and `i` would then unlatch another
        // slide's fragment.
        var j = steps.indexOf(el);
        if (j >= 0) fetched[j] = false;
      });
    }

    // Warm the fragments around a slide. Called at boot and on every settle.
    function warm(i) {
      for (var d = -FRAG_RADIUS; d <= FRAG_RADIUS; d++) {
        var j = i + d;
        if (j >= 0 && j < list.length) ensureFrag(j);
      }
    }

    /* ---- the commit gesture --------------------------------------------------
     * The one piece of scrolling this file writes by hand, and it is owed entirely
     * to fragment steps: a band step is one screen, so the column's own snap does
     * all of it. A fragment step is its own scroller with `overscroll-behavior:
     * contain`, which deliberately refuses to chain — that is what gives the bounce
     * at the end, and it is also what means a thumb can never leave the step on its
     * own. So: scroll to the end, feel the bounce, and a further pull commits to the
     * next step, which arrives at its top.
     *
     * The anchor is re-taken on every move while the scroller is in its middle, so
     * the pull is measured from the moment the content ran out — not from the start
     * of a long flick, which would commit the instant a fast scroll reached the end.
     * A step whose content fits the screen is at both ends at once, and then this
     * reads as a plain swipe to the next step, which is right.
     *
     * That re-anchoring is necessary and was not sufficient: see the arming rule
     * below, which is what makes the commit a SEPARATE gesture from the scroll that
     * reached the end.
     */
    function armCommit(el, slideEl) {
      var y0 = 0, fired = false, wheel = 0, wheelAt = 0;
      // Which ends the CURRENT gesture began at. See the arming rule below.
      var fromTop = false, fromBottom = false, wheelArmed = 0;
      function scrolls() { return el.scrollHeight > el.clientHeight + 2; }
      /* Two thresholds, one rule. Past the end of a step that HAS an interior, the
       * commit should take a deliberate second pull — the reader has just been
       * scrolling, and a light one is how you nudge the last line into view. A step
       * whose content fits the screen was never scrolling at all, so the same
       * gesture is just a swipe to the next step and should feel like one. */
      function threshold() { return el.clientHeight * (scrolls() ? 0.18 : 0.06); }
      function ends() {
        return {
          top: el.scrollTop <= 2,
          bottom: el.scrollTop >= el.scrollHeight - el.clientHeight - 2
        };
      }
      // Which step this is, read at gesture time: `keep()` renumbers the column.
      function at() { return first[Number(slideEl.dataset.slide)]; }

      /* THE ARMING RULE, and the thing that makes the commit a second gesture
       * rather than the tail of the first: a drag can only commit past an end it
       * was ALREADY at when the finger went down.
       *
       * Without it, one continuous pull that runs a step's interior out and keeps
       * going commits on the spot — you reach for the last two lines of a card and
       * the deck takes you to the next step. The anchor re-taken mid-scroll below
       * limits how much of that pull counts, but it cannot stop it: past the end
       * there is nothing left to re-anchor on, so the remainder of the same drag
       * accumulates straight through the threshold.
       *
       * So the end of the content ends the gesture. You scroll down, the step
       * bounces and holds; lift, pull again, and THAT one crosses. Which is the
       * doc's forgiving commit read strictly — "a further strong swipe" is a
       * further swipe, not a longer one.
       *
       * A step whose content fits the screen starts at both ends at once, so it is
       * armed both ways from the first touch and stays a plain swipe. */
      el.addEventListener('touchstart', function (e) {
        y0 = e.touches[0].clientY;
        fired = false;
        var e0 = ends();
        fromTop = e0.top;
        fromBottom = e0.bottom;
      }, { passive: true });
      el.addEventListener('touchmove', function (e) {
        // A pinch is two fingers moving apart, which reads as a large vertical drag
        // on whichever one is first. Zoom is the reader's, not a navigation.
        if (fired || e.touches.length > 1) return;
        var y = e.touches[0].clientY, dy = y - y0, end = ends();
        if (!end.top && !end.bottom) { y0 = y; return; }
        if (dy < -threshold() && end.bottom && fromBottom) { fired = true; commitTo(at() + 1); }
        else if (dy > threshold() && end.top && fromTop) { fired = true; commitTo(at() - 1); }
      }, { passive: true });

      /* A trackpad or a mouse wheel in a narrow desktop window. Same rule, but the
       * gesture has no touchstart to anchor on, so the deltas are accumulated and
       * expire — otherwise two unrelated flicks a minute apart would add up. A gap
       * of 400ms is what stands in for lifting a finger, and it is where the arming
       * above is applied: a stream that BEGAN mid-content cannot commit however far
       * it runs, exactly as a drag cannot. */
      el.addEventListener('wheel', function (e) {
        var end = ends();
        var now = Date.now();
        if (now - wheelAt > 400) {
          wheel = 0;
          wheelArmed = (end.top ? 1 : 0) | (end.bottom ? 2 : 0);
        }
        wheelAt = now;
        var want = e.deltaY > 0 ? 2 : 1;          // down needs the bottom, up the top
        if (!(wheelArmed & want)) { wheel = 0; return; }
        if ((e.deltaY > 0 && end.bottom) || (e.deltaY < 0 && end.top)) wheel += e.deltaY;
        else wheel = 0;
        if (Math.abs(wheel) > threshold()) {
          wheel = 0;
          commitTo(at() + (e.deltaY > 0 ? 1 : -1));
        }
      }, { passive: true });
    }

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
      /* Smooth for a move to a neighbouring step — that is the transport stepping,
       * and the glide is what says "the next one, just below". Far moves CUT: the
       * home button from slide nine, or a column built fresh at the top by a
       * rotation and immediately asked for the slide the reader was already on,
       * would otherwise fly through every intervening screen. */
      var far = Math.abs(deck.scrollTop - top) > 1.6 * stepH();
      pending = k;
      if (pendingTimer) clearTimeout(pendingTimer);
      // Backstop: a smooth scroll that never settles (interrupted by a thumb, or a
      // browser that drops the animation) must not leave scroll reporting disabled
      // for the rest of the session.
      pendingTimer = setTimeout(clearPending, 1200);
      if (far) { deck.scrollTop = top; return; }
      try { deck.scrollTo({ top: top, behavior: 'smooth' }); }
      catch (e) { deck.scrollTop = top; }   // older engine: no options object
    }

    /* A step the READER moved us to, by pulling past the end of a fragment step's
     * own scroller (armCommit). Deliberately not scrollToPos: that arms `pending`,
     * which exists to keep the player's own scrolls from echoing back at it — and
     * this scroll must be reported, or the transport would stay on the slide the
     * reader has just left. Everything else about it is the same move. */
    function commitTo(k) {
      if (k < 0 || k >= pos.length) return;   // the ends of the deck: nothing to commit to
      clearPending();
      drawRail(k);
      // Place the destination's interior BEFORE the scroll rather than leaving it to
      // the arrival below: `settle` runs ~110ms after the column stops moving, so a
      // backward commit would otherwise show the top of the card and then jump it to
      // the bottom under the reader's eyes.
      var p = pos[k];
      if (p) { warm(p.slide); placeAt(p.slide, k < indexAt()); }
      var top = k * stepH();
      try { deck.scrollTo({ top: top, behavior: 'smooth' }); }
      catch (e) { deck.scrollTop = top; }
    }

    /* Put a fragment step's interior where an arrival should find it. Forward, that
     * is its top — the doc's forgiving commit: you never see the tail of one step
     * sharing a screen with the head of the next. BACKWARD, it is its bottom, which
     * is not a special case so much as the same rule read the other way: someone
     * scrolling back up is continuing to read, and landing them at the top of the
     * previous card would skip everything they were reaching for. `from` is the
     * outgoing slide, which player-core passes for exactly this. */
    /* Which way the transport travelled to reach slide i. The player passes only the
     * outgoing index, and the deck WRAPS — advancing off the last slide arrives at
     * the first, which is a forward move with `from > i`. So direction is the shorter
     * way round the ring, not a comparison of two indices. */
    function goingBack(i, from) {
      if (typeof from !== 'number' || from === i || !list.length) return false;
      var fwd = ((i - from) % list.length + list.length) % list.length;
      return fwd * 2 > list.length;
    }

    function placeAt(i, back) {
      var el = steps[i];
      if (!el) return;
      el.scrollTop = back ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
    }

    // The player arrived at a slide. Its panel is not settled yet (applyState runs
    // next and answers with showAtom), so this goes to the slide's FIRST step.
    function show(i, from) {
      if (first[i] == null) return;
      atSlide = i; atPanel = 0;
      placeAt(i, goingBack(i, from));
      warm(i);
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
      if (dead) return;
      var k = indexAt();
      if (pending >= 0) {
        var t = pending;
        clearPending();
        if (k === t) return;    // our own scroll, arrived — nothing to report
      }
      var p = pos[k];
      if (!p || !api) return;
      warm(p.slide);
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
      /* Only the READER'S scrolling counts as the column being in motion. `pending`
       * marks a movement we started, and ours must not read as activity: iOS fires
       * `resize` more than once through a rotation, and the second one would find
       * the timestamp our own re-anchor had just written, conclude a scroll was in
       * progress, and decline to re-anchor — leaving the column pointing at a step
       * the reader is not on, which is the bug this all exists to prevent. */
      if (pending < 0) lastScrollAt = Date.now();
      /* Track the rail with the column rather than with the transport. The rail was
         only ever redrawn from scrollToPos/commitTo, so a reader dragging through
         band steps saw it move on the 110ms settle behind them. A continuous fill
         creeping late is invisible; a tick lighting late is a beat out of time with
         the thumb, and the tick is the whole point of segmenting it. */
      drawRail(indexAt());
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
     * A FRAGMENT step is this document, so its taps do reach here, links and all —
     * hence the one exemption below. The result is the same rule on both kinds of
     * step: press something pressable and it acts; tap anywhere else and the deck
     * pauses or resumes.
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
      /* A fragment step is real DOM in this document, so its links and buttons are
       * reachable by this listener on their way up. Pressing one is not a request to
       * pause the deck. (Band steps need no equivalent: an iframe's own links never
       * surface here, which is the tap-through the phase-0 note describes.) */
      if (e.target && e.target.closest && e.target.closest('a,button')) return;
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
      /* Any move off the first step is the reader having found the gesture, so the
         nudge has done its job. Hooked HERE rather than on a scroll listener
         because every path that changes the step — a thumb settling, a commit, a
         bar press, a panel timer — passes through this one function. */
      if (k > 0) cueDone();
      if (pos.length < 2) return;
      if (ticks) {
        for (var i = 0; i < ticks.length; i++) {
          ticks[i].classList.toggle('on', i <= k);
        }
        return;
      }
      if (rail) rail.style.transform = 'scaleX(' + ((k + 1) / pos.length) + ')';
    }

    /* The nudge is over: fade it out and remember, for this page, that it was shown
     * (see `cueShown`). Idempotent — every step change calls it. */
    function cueDone() {
      if (cueTimer) { clearTimeout(cueTimer); cueTimer = null; }
      if (!cue) return;
      cueShown = true;
      var el = cue;
      cue = null;
      el.classList.remove('on');
      // Removed rather than left faded: it is fixed over the column for the rest of
      // the deck, and an invisible box running a keyframe animation forever is a
      // compositing layer bought for nothing on the device with least to spare.
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
        var at = chromeEls.indexOf(el);
        if (at >= 0) chromeEls.splice(at, 1);
      }, 700);
    }

    function buildCue() {
      // Nothing to scroll to, or the reader has already been told once.
      if (pos.length < 2 || cueShown) return;
      var c = document.createElement('div');
      c.id = 'wcc-pcue';
      c.setAttribute('aria-hidden', 'true');
      c.innerHTML = CUE_ICON;
      document.body.appendChild(c);
      cue = c;
      chromeEls.push(c);
      // Late enough that it is not competing with the first card painting, and gone
      // on its own if the reader simply sits there: a hint that never leaves stops
      // being a hint.
      cueTimer = setTimeout(function () {
        cueTimer = null;
        if (cue === c) {
          c.classList.add('on');
          cueTimer = setTimeout(cueDone, 9000);
        }
      }, 1400);
    }

    function buildChrome() {
      if (pos.length > 1) {
        var r = document.createElement('div');
        r.id = 'wcc-prail';
        // Segmented while the count still reads; a fill beyond that. See TICK_MAX.
        if (pos.length <= TICK_MAX) {
          ticks = [];
          for (var t = 0; t < pos.length; t++) {
            var seg = document.createElement('i');
            r.appendChild(seg);
            ticks.push(seg);
          }
        } else {
          r.className = 'cont';
          rail = document.createElement('i');
          r.appendChild(rail);
        }
        document.body.appendChild(r);
        chromeEls.push(r);
        drawRail(indexAt());
      }
      buildCue();
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
      /* Into the DOCK, beside the transport, where a phone app puts it — and where it
       * costs no content. It floated in the top-left corner while the bar was a pill
       * over a letterboxed slide, which is a corner a full-bleed portrait layout
       * wants back. The bar is built before the stage is attached (buildControls, then
       * attachStage), so it is there; the float stays as the fallback for the case it
       * is not — a hosted or record surface, neither of which is this one. */
      var into = document.getElementById('wcc-bar') || document.body;
      into.appendChild(b);
      // Tracked for `detach`: it lives in the player's bar, which OUTLIVES this
      // stage. Left behind, a rotation to landscape would keep a portrait control
      // in the landscape bar.
      chromeEls.push(b);
    }

    return {
      /* Where slide i's iframe goes — or NULL, which means it has none: the step is
       * a portrait fragment and this file renders it. The player template creates no
       * frame for a null host, which is what makes a fragment step cost no document
       * at all. Every caller must handle it. */
      host: function (i) { return bands[i] || null; },
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
        var keptList = [], keptBands = [], keptSteps = [], keptFetched = [], keptEls = [];
        for (var i = 0; i < list.length; i++) {
          if (wanted[i]) {
            keptList.push(list[i]); keptBands.push(bands[i]); keptSteps.push(steps[i]);
            keptFetched.push(fetched[i]); keptEls.push(slideEls[i]);
            // Read back by armCommit to find the step it is on, so it must be
            // renumbered here with everything else.
            slideEls[i].dataset.slide = String(keptEls.length - 1);
          } else if (slideEls[i] && slideEls[i].parentNode) {
            slideEls[i].parentNode.removeChild(slideEls[i]);
          }
        }
        list = keptList; bands = keptBands; steps = keptSteps;
        fetched = keptFetched; slideEls = keptEls;
        retable();
        fit();
        warm(0);
      },
      stage: {
        /* Take this stage apart. Called by player-core when another stage replaces
         * it — a phone turned landscape, which goes back to the 16:9 presentation.
         * By the time this runs the frames have already been moved out of the column
         * (see setStage), so removing it takes nothing with it.
         *
         * The two custom properties go too. They are on the document element and
         * mean nothing to any other surface, but `--pdock-h` in particular is read
         * by nothing else and would sit there describing a bar that is no longer
         * docked. */
        detach: function () {
          dead = true;
          if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
          if (cueTimer) { clearTimeout(cueTimer); cueTimer = null; }
          clearPending();
          window.removeEventListener('resize', fit);
          window.removeEventListener('orientationchange', fit);
          if (deck.parentNode) deck.parentNode.removeChild(deck);
          for (var k = 0; k < chromeEls.length; k++) {
            if (chromeEls[k].parentNode) chromeEls[k].parentNode.removeChild(chromeEls[k]);
          }
          chromeEls = [];
          rail = null;
          ticks = null;
          cue = null;
          document.body.classList.remove('wcc-portrait');
          themeColor(null);   // the site's declared colour is the landscape one
          var root = document.documentElement.style;
          root.removeProperty('--pdock-h');
          root.removeProperty('--pstep-h');
          root.removeProperty('--pshift');
          root.removeProperty('--pfit');
        },
        // The player's gesture layer stands down; this file takes the tap.
        ownsInput: true,
        /* Dock the control bar to the bottom edge instead of floating it in a
         * letterbox band — there is no band here (see placeBar). */
        barDock: true,
        /* ...and the bar reports back how tall it came out, because this stage pays
         * for it: the scroller ends where the dock begins, so a step is the space
         * above the bar and content never scrolls behind it. Re-measured on every
         * placement, which is what keeps it right across a rotation and a safe-area
         * change. `fit()` then re-derives the step height from the same box the
         * scrolling is read out of, so the two can never disagree. */
        chrome: function (h) {
          document.documentElement.style.setProperty('--pdock-h', (h || 0) + 'px');
          fit();
        },
        show: show,
        showAtom: showAtom,
        attach: function (transport) { api = transport; buildChrome(); },
        // Where frame i belongs, or null if this stage renders the slide itself
        // (a portrait fragment — see host() above). Read at boot by the template,
        // which creates the frames straight into their bands, and again by
        // WccPlayer.setStage when a deck already running in landscape swaps onto this
        // stage — there it is what re-homes the frames, at the cost of reloading the
        // live ones, and a null answer is what tells it to tear one down instead.
        host: function (i) { return bands[i] || null; }
      }
    };
  }

  window.WccPortrait = { create: create };
})();

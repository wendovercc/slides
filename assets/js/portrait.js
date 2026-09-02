/* portrait.js — the phone surface.
 *
 * docs/portrait-decks.md, phases 0 and 1. A deck opened in portrait on a phone
 * becomes a RUN of full-screen steps paged sideways, instead of a 16:9 rectangle
 * floating in the middle of the screen.
 *
 * ONE AXIS NAVIGATES, THE OTHER READS. Horizontal is the whole of the deck's
 * forward motion — steps, panels, photographs. Vertical belongs to the interior of
 * a step and to nothing else.
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
 * So the deck is a flat list of steps and a sideways swipe always means the same
 * thing: forward, by one step. Getting this wrong is what made a phone visitor's `teams`
 * deck a single screen that would not scroll, with five of its six panels behind a
 * timer. A reel stays one step deliberately: its clips are an authored sequence
 * with their own time, and the doc rejects the vertical-feed reading of them.
 *
 * ---- the column does not scroll ----
 * THE TRANSPORT IS THE ONLY AUTHORITY FOR WHERE THE DECK IS. `atSlide`/`atPanel`
 * are what the player says; a transform on the track renders them; nothing is ever
 * read back out of the DOM to decide position.
 *
 * It was the other way round first — the deck was one tall scroller with
 * `scroll-snap-type: y mandatory` and its position DERIVED as
 * `scrollTop / stepHeight`. Three agents then wrote that number: the transport
 * (every advance was performed by writing scrollTop), the reader's thumb, and the
 * browser, which has its own opinion about where a mandatory-snap container rests.
 * And the denominator was `deck.clientHeight`, which iOS changes on its own when
 * Safari's chrome collapses — so the deck's idea of where it was could change with
 * nobody touching anything. `pending`, `settle`, the settle timer, the 1200ms
 * backstop and the resize re-anchor were five patches on that one premise, and on
 * an iPhone the control bar still could not move the column: the rail advanced and
 * the deck sat still.
 *
 * So the seam between steps is a transform and the position is a number we own.
 * Native scrolling stays exactly where it earns its keep — INSIDE a fragment step,
 * which is its own scroller with momentum, rubber-band and `overscroll-behavior:
 * contain`. It costs nothing now: a scroller that contains its overscroll can
 * never chain out of itself, and it is no longer supposed to.
 *
 * ---- one verb, two routes ----
 * A step change is always `stepBy(±1)`, which asks the PLAYER to move — the same
 * call the control bar makes, so a swipe and a bar press are one event:
 *
 *   the column → armDeck, a horizontal drag anywhere on it: matte, band AND
 *                fragment alike, because a band's iframe is `pointer-events:none`
 *                so the touch reaches this document instead of dying in another one
 *   a `data-taps` slide → keeps its pointer events, so it reports its own swipes
 *                through slide-bridge (`wcc-swipe`) as it always did
 *
 * There was a third — `armCommit`, a fragment step's overscroll commit — and the
 * axis swap deleted it outright. See the note where it used to be.
 *
 * A slide with several panels is ONE row whose content changes under a stationary
 * frame, which is what the sticky band used to buy with a travel calculation and
 * now falls out of doing nothing.
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
 * down in `detach()`, which player-core calls on the way out. Column, share button,
 * body class, the custom properties and the listeners — if it is not in there, it
 * survives a rotation and lands on the wrong surface.
 *
 * The two progress instruments are deliberately NOT in that list: they belong to
 * the player, sit on both surfaces, and a rotation is not supposed to interrupt
 * them. They read the deck's position off the transport either way.
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

      /* THE DECK IS NOT A SCROLLER, and that is the whole architecture.
         It was one: ten full-height steps with `scroll-snap-type: y mandatory`, and
         the column's position DERIVED as `scrollTop / stepHeight`. Three agents
         then wrote that one number — the transport (every advance was performed by
         writing scrollTop), the reader's thumb, and the browser, which has its own
         opinion about where a mandatory-snap container comes to rest and acts on
         it. Worse, the derivation's denominator is `deck.clientHeight`, which iOS
         changes on its own when Safari's chrome collapses: the deck's idea of where
         it was could change with nobody touching anything. `pending`, `settle`, the
         1200ms backstop, the idle guard and the re-anchor were five patches on one
         wrong premise, and on an iPhone the control bar still could not move the
         column at all — the rail advanced and the deck sat still.

         So: the TRANSPORT is the only authority, and the column merely renders it.
         One slide per row in a track, translated to the current one. Nothing reads
         a scroll position to decide where the deck is, which makes an iOS resize
         pure layout and a bar press correct by construction.
         `bottom` is the DOCK (placeBar's `portrait` placement): a step is the space
         above the bar, and `--pdock-h` is the height the bar measured itself at. */
      '#wcc-pdeck{position:fixed;top:0;left:0;right:0;bottom:var(--pdock-h,0px);' +
      'z-index:5;overflow:hidden;background:var(--matte,#08152c);}' +

      /* The track: one row per SLIDE, moved by transform. Per slide and not per
         step, because a slide with several panels is one band whose CONTENT changes
         under a stationary frame — which is what the sticky band used to buy with a
         travel calculation, and now falls out of doing nothing. */
      /* The track TRAVELS SIDEWAYS. Height is the number iOS rewrites on its own
         when Safari's chrome collapses — the reason `--pstep-h` has to be measured
         rather than left as `100dvh`, and the reason a scroll-derived position could
         drift with nobody touching anything. Width it does not touch. So putting the
         deck's travel on X is "One authority" applied one level down: the number the
         position is made of is one the platform cannot change behind us.
         `max-content` so the row is as wide as its slides rather than as wide as the
         deck it overflows. */
      '#wcc-ptrack{position:absolute;top:0;left:0;display:flex;width:max-content;' +
      'transition:transform 0.34s cubic-bezier(0.22,0.61,0.36,1);}' +
      /* Honour a reader who has asked the OS for less motion: the step still
         changes, it just arrives rather than travels. */
      '@media (prefers-reduced-motion:reduce){#wcc-ptrack{transition:none;}}' +

      /* One row of the track. Exactly one step tall whatever is inside it, so the
         track's arithmetic stays `slide index x step height` and cannot drift.
         `--pstep-h` is measured in JS, NOT `100dvh`: iOS resolves a fixed element's
         box and `dvh` against different viewports while the browser chrome
         collapses, and the row has to match the box the deck actually occupies. */
      '.pslide{position:relative;flex:0 0 auto;width:var(--pstep-w,100vw);' +
      'height:var(--pstep-h,100dvh);overflow:hidden;}' +

      /* A band slide centres its band, and now simply centres it. The old up-bias
         (`--pshift`) said "the column continues BELOW", which was the affordance a
         vertical deck needed and is a lie on a horizontal one. What says "there is
         more" here is the rail, the cue, and the fact that the deck moves sideways
         under a thumb. */
      '.pslide.band{box-sizing:border-box;' +
      'display:flex;align-items:center;justify-content:center;}' +

      /* The band. Full-bleed width in portrait; capped by height so that a rotated
         phone (or an iPad) gets a band that fits rather than one that overflows. */
      /* Capped by height so an iPad (where height, not width, is the binding
         constraint) gets a band that fits rather than one that overflows its step.
         This formula and `fit()`'s `--pfit` are the same arithmetic and must stay
         that way. */
      '.pband{position:relative;' +
      'width:min(100%, calc(var(--pstep-h,100dvh) * 16 / 9));' +
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
      /* AND IT DOES NOT TAKE THE TOUCH. A band is an iframe, so a thumb landing on
         it is inside another document and the column never learns the gesture
         happened — the slide has to notice and post it out, which is a long chain
         for the part of the screen a reader is most likely to touch, and it is not
         the chain the matte and the fragment steps use. Making the band
         transparent to hit-testing puts every gesture in ONE place (`armDeck`),
         whichever surface the thumb lands on, and brings the wheel with it: a
         trackpad over a photograph reaches the deck now, where before it went into
         the iframe and died, since slide-bridge reports touch only.

         What it gives up is the slide's own links, and today that costs nothing:
         `data-taps` is declared by `showcase-card` alone, which always renders as a
         portrait FRAGMENT rather than a band. `stage.taps()` hands the events back
         for any slide that does declare them, so the exception exists before it is
         needed rather than after. */
      '.pband>iframe{position:absolute;top:0;left:0;width:1920px;height:1080px;' +
      'border:0;transform-origin:top left;transform:scale(var(--pfit,1));' +
      'visibility:visible;opacity:1;pointer-events:none;}' +

      /* A step that is a portrait FRAGMENT (phase 1): our own DOM rather than a
         letterboxed document, so it is full-bleed and it SCROLLS.
         THIS is where native scrolling earns its place and keeps it — momentum,
         rubber-band, scrollbars and accessibility, inside one step. What the
         rewrite above removed was the DECK-level scroller, never this one: the seam
         between steps became a transform, the interior stayed native.
         `overscroll-behavior: contain` gives the bounce at the end for free and
         stops the pull becoming the browser's. It also means a thumb can never leave
         the step on its own — which used to need a commit gesture and now needs
         nothing, because leaving a step is horizontal. */
      '.pstep{position:absolute;top:0;left:0;right:0;bottom:0;overflow-y:auto;' +
      'overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;' +
      'scrollbar-width:none;}' +
      '.pstep::-webkit-scrollbar{display:none;}' +
      /* The fragment sizes itself off the step, so the step has to have a definite
         inner height for `min-height:100%` to resolve against. */
      '.pstep>.pfrag{min-height:100%;}' +

      /* The progress rail USED to live here, and it does not any more: it is one of
         the player's two deck instruments now (`#wcc-prog-top` in player-core), so
         landscape has one too and both surfaces count the same atoms in the same
         place. Nothing portrait-specific was lost in the move — the rail was always
         welded to the viewport's top edge, which is exactly the rule the shared
         version generalises. The dock's only remaining business with them is the
         height it reports through `stage.chrome`, which is the inset the countdown
         sits above. */

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
      /* Sits at the RIGHT edge, vertically centred in the space above the dock —
         on the axis it is teaching and pointing the way the deck moves. It used to
         bob at the bottom centre, which was the right place for a gesture that went
         up and is a wrong instruction now. */
      '#wcc-pcue{position:fixed;z-index:57;pointer-events:none;' +
      'right:calc(var(--sa-r,0px) + 1.6vmax);' +
      'top:calc((100% - var(--pdock-h,0px)) / 2);transform:translateY(-50%);' +
      'opacity:0;transition:opacity 0.6s ease;}' +
      '#wcc-pcue.on{opacity:1;}' +
      /* The positioner keeps `translateY`, the badge takes `translateX`: one element
         cannot hold a centring transform and an animated one at the same time — the
         keyframe would overwrite the centring and shunt the cue half its height down. */
      '#wcc-pcue i{display:flex;align-items:center;justify-content:center;' +
      'width:max(40px,4.7vmax);height:max(40px,4.7vmax);border-radius:50%;' +
      'background:rgba(10,28,58,0.9);border:1px solid rgba(212,175,55,0.45);' +
      'box-shadow:0 0.4vh 1.4vh rgba(0,0,0,0.5);' +
      'animation:wcc-pcue-bob 1.9s ease-in-out infinite;}' +
      '#wcc-pcue svg{display:block;width:2.3vmax;height:2.3vmax;fill:none;' +
      'stroke:#fff;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;}' +
      /* Travel only. An opacity pulse on a bordered badge reads as a flicker, where
         on a bare glyph it was half of what made it look alive. */
      '@keyframes wcc-pcue-bob{0%,100%{transform:translateX(0.55vmax);}' +
      /* Share USED to be built here too, floating in the top-left matte and then
         moving into the dock. It is one of the player's bar controls now, for the
         same reason the rail is one of its instruments: it is about the deck, not
         about the shape of the screen, and as a stage's property `detach()` took it
         away every time the phone was turned. */
      '50%{transform:translateX(-0.55vmax);}}';
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* OFF for now, and the code is kept rather than deleted because the gap it was
   * built for is still real — nothing else advertises that the deck moves sideways.
   * What is wrong is the badge, not the idea. The ring was chosen (see the CSS) to
   * borrow the floating share button's vocabulary — navy ground, gold hairline,
   * white glyph — so a reader would already have read it as "control". Share then
   * moved into the dock and dropped its border, which left the cue as the only
   * ringed circle on screen AND the only one that is not pressable: it now teaches
   * "button" first and "swipe" second, which is the opposite of its job.
   * Turn this back on with a treatment that cannot be mistaken for a target — the
   * likely answer is no badge at all, and a peeling edge of the next step instead.
   * Everything below (build, once-per-page flag, teardown) stays wired; this is the
   * only gate. */
  var CUE_ENABLED = false;

  /* The badge is the outer <i>, and it is what bobs — the chevron sits still inside
   * it. A glyph moving within a fixed ring reads as a loose part; the whole control
   * moving reads as a nudge. */
  var CUE_ICON = '<i><svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<polyline points="9 6 15 12 9 18" /></svg></i>';

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
    // Everything the column shows lives in the track; the deck is just the window
    // it is moved behind. Separating them is what lets the transform be the ONLY
    // expression of position — the deck's own box never moves.
    var track = document.createElement('div');
    track.id = 'wcc-ptrack';
    deck.appendChild(track);
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
      track.innerHTML = '';
      bands = []; steps = []; fetched = []; slideEls = [];
      retable();
      for (var i = 0; i < list.length; i++) {
        var el = document.createElement('div');
        el.className = 'pslide';
        el.dataset.slide = String(i);
        bands[i] = steps[i] = null;
        fetched[i] = false;
        slideEls[i] = el;
        /* A slide with a portrait fragment is not a band at all: its step is a
           scroller holding our own markup, full-bleed, sized by the portrait scale
           rather than the wall's design box. The markup itself arrives later — see
           warm() — and nothing about the column's geometry waits for it, because a
           row is one step tall whatever is inside it. */
        if (fragUrl(list[i])) {
          var step = document.createElement('div');
          step.className = 'pstep';
          el.appendChild(step);
          track.appendChild(el);
          steps[i] = step;
          continue;
        }
        /* A BAND slide is one row whatever its panel count. The sticky box, the
           per-step marks and the zero-height snap target are all gone with the
           deck's scroller: they existed to give a multi-panel slide a run of snap
           points to scroll THROUGH while its band stayed pinned. With the track
           driven by the transport, a panel change simply does not move the track,
           which is the same result and no arithmetic. */
        var band = document.createElement('div');
        band.className = 'pband';
        el.className = 'pslide band';
        el.appendChild(band);
        track.appendChild(el);
        bands[i] = band;
      }
    }
    build();
    document.body.appendChild(deck);
    warm(0);   // the opening card, and its neighbours, before anything is shown

    var api = null;                 // the transport, handed over by attach()
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
    var histOn = false;             // we are holding the back-sentinel (see histSync)
    /* The reader is pinched in, and the surface is theirs until they pinch out.
     * Owned by player-core (`onZoomChange`, which is the single arbiter and also
     * stops the timer and collapses the window) and pushed here through
     * `stage.zoom`, rather than read off visualViewport a second time — two
     * readings of one condition is how the surfaces drift. */
    var zoomed = false;

    /* ---- geometry ----
     * `stepW` is the travel: one step is exactly the deck's width, and width is the
     * dimension iOS does not rewrite when Safari's chrome collapses. Height is
     * layout only now. */
    function stepW() { return deck.clientWidth || 1; }

    /* Layout only, now. It writes the three custom properties the CSS is built on
     * and re-lands the track on the current slide at the new height — and that is
     * ALL, because nothing derives the deck's position from geometry any more.
     *
     * What used to be here was the re-anchor: `scrollTop` did not change when the
     * step height did, so `scrollTop / stepHeight` silently re-pointed at a
     * different step and mandatory snap slid the column to it, which fired a
     * scroll, which `settle` reported to the transport as a navigation — rotating a
     * phone on photo 1 advanced the deck a slide. It needed `pending` to hide its
     * own scroll, an idle guard so it never fired mid-drag, and a 1200ms backstop.
     * All of it existed to defend a derived position. There is no derived position
     * now: a resize is a resize. */
    function fit() {
      if (dead) return;
      var h = deck.clientHeight, dw = deck.clientWidth;
      if (!h || !dw) return;
      var root = document.documentElement.style;
      // One step is exactly the deck's box, so a row's size and the distance the
      // track travels per slide are the same numbers by construction.
      root.setProperty('--pstep-w', dw + 'px');
      root.setProperty('--pstep-h', h + 'px');
      // The band's width, derived rather than measured off a band: a deck may have
      // none in it at all (both of the pavilion's cards are fragments), and this is
      // the same width the CSS gives one — full bleed, capped by height so an iPad
      // gets a band that fits rather than one that overflows. This and `.pband`'s
      // width must agree exactly.
      var w = Math.min(dw, h * 16 / 9);
      if (w) root.setProperty('--pfit', w / 1920);
      // The rows just changed size, so the track's offset for the same slide has
      // changed with them. No animation: this is a relayout, not a move.
      place(false);
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

    /* ---- the commit gesture: DELETED --------------------------------------
     * There was ~90 lines here, and it is worth a paragraph saying why there is not
     * any more. A fragment step is its own scroller with `overscroll-behavior:
     * contain`, so a thumb could never leave it by scrolling — and while VERTICAL was
     * the step axis, it had to be able to. That bought: an arming rule (a drag can
     * only commit past an end it was already at when the finger went down), an anchor
     * re-taken on every move through the middle, two thresholds depending on whether
     * the step had an interior at all, and a wheel accumulator with its own expiry.
     * Every one of them existed to tell "the reader is scrolling" apart from "the
     * reader is leaving", on one axis.
     *
     * Splitting the axes removes the question. Vertical is the scroller's and only
     * the scroller's; leaving a step is horizontal, which is not a scroll on any
     * step, so it goes through `armDeck` like every other drag. See docs/
     * portrait-decks.md, "One axis navigates".
     */

    /* ---- position ------------------------------------------------------------
     * ONE authority: the transport. `atSlide`/`atPanel` are what the player says,
     * `place()` renders them, and nothing reads anything back. That is the whole of
     * the navigation model on this surface, and it replaced a scroll-derived
     * position that needed `pending`, `settle`, a 110ms settle timer, a 1200ms
     * backstop and a re-anchor to keep two authorities agreeing — see the note on
     * `#wcc-pdeck` in the stylesheet for why that could not be made to work.
     *
     * The track moves by SLIDE, not by step: a slide with several panels is one
     * band whose content changes under a stationary frame, so a panel move renders
     * as no movement at all. That is the same thing the sticky band used to
     * achieve, minus the arithmetic.
     */
    function place(animate) {
      var x = atSlide * stepW();
      if (!animate) {
        track.style.transition = 'none';
        track.style.transform = 'translate3d(' + (-x) + 'px,0,0)';
        // Flush, so the transition coming back on cannot animate the jump we just
        // made. Reading a layout property is what forces the style to be applied.
        void track.offsetWidth;
        track.style.transition = '';
        return;
      }
      track.style.transform = 'translate3d(' + (-x) + 'px,0,0)';
    }

    /* Which step of the deck we are on — for the rail, and as the origin of a
     * gesture move. DERIVED FROM THE TRANSPORT, never from geometry. */
    function stepIndex() {
      return (first[atSlide] != null) ? first[atSlide] + atPanel : 0;
    }

    /* Which way the transport travelled to reach slide i. The player passes only the
     * outgoing index, and the deck WRAPS — advancing off the last slide arrives at
     * the first, which is a forward move with `from > i`. So direction is the shorter
     * way round the ring, not a comparison of two indices. */
    function goingBack(i, from) {
      if (typeof from !== 'number' || from === i || !list.length) return false;
      var fwd = ((i - from) % list.length + list.length) % list.length;
      return fwd * 2 > list.length;
    }

    /* Put a fragment step's interior where an arrival should find it. Forward, that
     * is its top — the doc's forgiving commit: you never see the tail of one step
     * sharing a screen with the head of the next. BACKWARD, it is its bottom, which
     * is not a special case so much as the same rule read the other way: someone
     * going back is continuing to read, and landing them at the top of the previous
     * card would skip everything they were reaching for. */
    function placeAt(i, back) {
      var el = steps[i];
      if (!el) return;
      el.scrollTop = back ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
    }

    // The player arrived at a slide. Its panel is not settled yet (applyState runs
    // next and answers with showAtom), so this goes to the slide's FIRST step.
    function show(i, from) {
      if (first[i] == null) return;
      var d = Math.abs(i - atSlide);
      atSlide = i; atPanel = 0;
      placeAt(i, goingBack(i, from));
      warm(i);
      onStep(stepIndex());
      /* Travel for a neighbour, CUT for anything further. The glide is what says
         "the next one, just below"; sliding it across nine rows because the deck
         wrapped from the last slide to the first — or because a rotation restored a
         position — would be a journey through slides nobody asked to see. Not moved
         at all: leave the transform alone rather than re-writing it, which would
         cost a forced reflow on every panel change. */
      if (d) place(d === 1);
    }

    // The player is on a definite panel — an arrival settling, a bar press, a timer,
    // or the slide's own echo. Within one slide there is nothing for the column to
    // do: the band is already on screen and its panels change inside it. (The
    // player's own rail advances from `stageAtom`, which calls this.)
    function showAtom(i, p) {
      if (first[i] == null) return;
      var d = Math.abs(i - atSlide);
      atSlide = i;
      atPanel = Math.max(0, Math.min(stepsFor(list[i]) - 1, p || 0));
      onStep(stepIndex());
      if (d) place(d === 1);
    }

    /* ---- moving by one step --------------------------------------------------
     * The gesture's only verb, and it asks the TRANSPORT to move rather than moving
     * the column itself — so a swipe and a bar press are the same event, and the
     * column updates the same way from both. There is no second nav model here to
     * keep in sync with the first.
     *
     * A step is an entry in `pos`, so this crosses to the next slide when the
     * current one has no panel left. Which is what makes a reel behave the way the
     * doc asks: a reel is ONE step whatever its clip count, so a vertical swipe
     * leaves it entirely while a horizontal one steps through its clips.
     *
     * Deliberately does NOT wrap. The control bar may take you off the end of the
     * deck round to the front; a swipe is a scroll gesture and a scroll stops. */
    function stepBy(d) {
      if (!api) return;
      var k = stepIndex() + d;
      if (k < 0 || k >= pos.length) return;
      var t = pos[k];
      if (!t) return;
      /* Crossing a slide: the SAME verbs the control bar crosses on, so a swipe and
         a bar press cannot disagree. `goTo` used to be here, and it is the wrong
         verb for a step — it lands on the first atom, carries `playing` and starts
         nothing, so swiping onto a reel parked it and swiping back skipped to the
         top of a slide the reader was returning to the bottom of.
         Neither can wrap from here: the guard above has already established that
         step `k` exists, so `t.slide` is the immediate neighbour either way. */
      if (t.slide !== atSlide) { (d > 0 ? api.fwd : api.back)(); return; }
      var n = t.panel - atPanel;
      var f = n > 0 ? api.next : api.prev;
      for (var z = Math.abs(n); z > 0; z--) f();
    }

    /* ---- gestures on the column ----------------------------------------------
     * ONE handler, one axis, every kind of step — because the band no longer
     * swallows touches (see `.pband>iframe`). Whether the thumb lands on a
     * photograph, on the matte beside it, on a reel or on a fragment card, the event
     * arrives here.
     *
     *   HORIZONTAL → stepBy(±1). The whole of the deck's forward motion.
     *   VERTICAL   → nothing. It belongs to the step's own scroller, and a band has
     *                no scroller, so on a band it is deliberately dead.
     *
     * That second line is the axis swap, and it is why this file got shorter rather
     * than longer. While vertical navigated it also had to scroll, which is what
     * `armCommit` (deleted above) existed to disambiguate. One job per axis needs no
     * disambiguation at all.
     *
     * Gestures inside a `.pstep` are NOT declined any more. They used to be, because
     * that scroller had its own commit gesture to run first; now a horizontal drag
     * over a fragment is not a scroll by any reading, so it belongs here like every
     * other one. The listeners stay passive and never preventDefault, so a vertical
     * drag scrolls the fragment natively while this watches it not be horizontal.
     *
     * Thresholds are fractions of the DECK, which is this document and therefore in
     * real px — unlike slide-bridge, which measures inside a 1920x1080 design box
     * and has to correct for the difference.
     */
    function armDeck() {
      var y0 = 0, x0 = 0, live = false, fired = false;
      var EDGE = 0.05;        // of width — iOS's back-swipe strip, left to iOS
      var DOM = 1.3;          // how much more one axis than the other

      deck.addEventListener('touchstart', function (e) {
        live = false; fired = false;
        // Pinched in: a one-finger drag is the reader panning a magnified slide, not
        // a step. Same rule the landscape tap layer applies.
        if (zoomed || e.touches.length !== 1) return;
        var t = e.touches[0], w = deck.clientWidth || 1;
        /* iOS Safari's left-edge swipe is browser-back and cannot be prevented while
           `touch-action` stays `auto` — which it must, or pinch-zoom goes with it. So
           we decline the outer strip and one gesture does one thing.
           This matters more than it did: the edge is now on the NAV axis. The other
           two answers are in the doc — only the left edge is back (so `next` never
           collides), and the history sentinel below makes a back press MEAN prev. */
        if (t.clientX < w * EDGE || t.clientX > w * (1 - EDGE)) return;
        y0 = t.clientY; x0 = t.clientX;
        live = true;
      }, { passive: true });
      deck.addEventListener('touchmove', function (e) {
        if (!live || fired || e.touches.length > 1) return;
        var dy = e.touches[0].clientY - y0, dx = e.touches[0].clientX - x0;
        var ay = Math.abs(dy), ax = Math.abs(dx);
        // The dominance test is what stops a lazy diagonal — someone scrolling a
        // card with a slight sideways drift — from stepping the deck out from under
        // what they are reading.
        if (ax > deck.clientWidth * 0.12 && ax > ay * DOM) {
          fired = true;
          stepBy(dx < 0 ? 1 : -1);
        }
      }, { passive: true });
      deck.addEventListener('touchcancel', function () { live = false; });

      /* A trackpad or a wheel in a narrow desktop window. Accumulated and expired,
       * because a wheel has no touchstart to anchor on — two unrelated flicks a
       * minute apart must not add up.
       *
       * ONE STREAM IS ONE STEP. A trackpad flick is not one event, it is a hundred
       * of them over a second or more of momentum, so an accumulator that merely
       * resets after firing crosses the threshold again immediately and walks the
       * deck several slides on a single gesture. `locked` is the equivalent of
       * lifting a finger: nothing more moves until the stream actually stops. Which
       * is also what the touch path does — `fired` there, released at touchstart.
       *
       * THE ONE PLACE STRICTNESS IS RELAXED, deliberately. Over a band or the matte
       * a wheel steps whichever way it is pointed: a desktop reader in a narrow
       * window scrolls vertically out of habit, and there is nothing else for a wheel
       * to do there. Inside a fragment step the rule is exact again — vertical is the
       * scroller's, horizontal steps — because there a vertical wheel has a real job.
       */
      var acc = 0, at = 0, locked = false;
      var GAP_MS = 250;   // no wheel event for this long = the gesture ended
      deck.addEventListener('wheel', function (e) {
        if (zoomed) return;    // ctrl+wheel is a desktop pinch; the view is theirs
        var inStep = !!(e.target && e.target.closest && e.target.closest('.pstep'));
        var ax = Math.abs(e.deltaX), ay = Math.abs(e.deltaY);
        if (inStep && ay >= ax) return;          // the fragment's own scroll
        var d = inStep ? e.deltaX : (ax > ay ? e.deltaX : e.deltaY);
        var now = Date.now();
        if (now - at > GAP_MS) { acc = 0; locked = false; }
        at = now;
        if (locked) return;
        acc += d;
        if (Math.abs(acc) > deck.clientWidth * 0.08) {
          locked = true;
          var dir = acc > 0 ? 1 : -1;
          acc = 0;
          stepBy(dir);
        }
      }, { passive: true });
    }
    armDeck();


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
      // Not while zoomed — see armDeck. A tap that lands mid-pinch is part of the
      // zoom gesture, and toggling the transport under it is the deck moving when
      // the reader asked the picture to.
      gp = zoomed ? null : { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
    });
    deck.addEventListener('pointerup', function (e) {
      if (!gp || e.pointerId !== gp.id || zoomed) return;
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
    /* Every path that changes the step — a thumb settling, a bar press, a panel
       timer — passes through here. It drew the rail until the rail became the
       player's; what is left is the two things that were always riding along with
       it, and they are the reason this is still one function rather than two calls
       at six sites. The player's own rail is driven from the transport (`stageAtom`),
       not from here, because landscape has no step axis to hang it off. */
    function onStep(k) {
      // Any move off the first step is the reader having found the gesture, so the
      // nudge has done its job.
      if (k > 0) cueDone();
      histSync(k);
    }

    /* ---- back means previous step --------------------------------------------
     * The third answer to the edge swipe, and the one that stops us fighting the
     * platform. iOS Safari's left-edge swipe is browser-back and cannot be
     * prevented; now that horizontal is the step axis, that is a gesture pointing at
     * the deck's own `prev`. So give it one: while the reader is off the first step
     * the deck holds a single history entry, and a back press spends it on a step
     * rather than on the page.
     *
     * ONE sentinel, replaced rather than accumulated. A deck of thirty steps must
     * not cost thirty presses to escape — the entry is re-pushed after each back, so
     * back walks the deck and back from the FIRST step leaves, which is what a
     * reader means by it.
     *
     * The URL is `location.href`: the entry exists to be popped, not to address
     * anything, and a deck's canonical URL is what every link already sent points at.
     *
     * The one loose end, accepted rather than engineered away: a reader who returns
     * to step 0 by SWIPING leaves the sentinel behind (we cannot drop a history entry
     * without navigating, and calling `history.back()` ourselves would race a real
     * one). Their next back press is then absorbed doing nothing, and the one after
     * leaves. A rotation is the same story — `detach` takes the listener off and the
     * entry outlives it. One dead press in a corner, against a self-pop that could
     * navigate a reader off the page if anything else ever pushes an entry.
     */
    function histSync(k) {
      if (dead || k <= 0 || histOn) return;
      histOn = true;
      try { history.pushState({ wccp: 1 }, '', location.href); } catch (e) { /* no-op */ }
    }
    function onPop() {
      if (dead) return;
      histOn = false;              // the browser has spent it either way
      if (stepIndex() <= 0) return;
      stepBy(-1);
      histSync(stepIndex());       // still off the first step: hold another
    }
    window.addEventListener('popstate', onPop);

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
      if (!CUE_ENABLED || pos.length < 2 || cueShown) return;
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

    /* What is left of the stage's own chrome: the cue, and nothing else. The rail
       and the share button both moved to the player — see the notes where each used
       to be built. */
    function buildChrome() {
      onStep(stepIndex());
      buildCue();
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
            // Not read by anything since armCommit went; kept because a column of
            // anonymous divs is unreadable in the inspector, and renumbered here so
            // it never lies about which slide it is.
            slideEls[i].dataset.slide = String(keptEls.length - 1);
          } else if (slideEls[i] && slideEls[i].parentNode) {
            slideEls[i].parentNode.removeChild(slideEls[i]);
          }
        }
        list = keptList; bands = keptBands; steps = keptSteps;
        fetched = keptFetched; slideEls = keptEls;
        // The player is restarted on the shortened deck, so the column goes back to
        // the top with it — and `atSlide` must not be left pointing past the end.
        if (atSlide >= list.length) atSlide = 0;
        atPanel = 0;
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
          if (cueTimer) { clearTimeout(cueTimer); cueTimer = null; }
          window.removeEventListener('popstate', onPop);
          window.removeEventListener('resize', fit);
          window.removeEventListener('orientationchange', fit);
          if (deck.parentNode) deck.parentNode.removeChild(deck);
          for (var k = 0; k < chromeEls.length; k++) {
            if (chromeEls[k].parentNode) chromeEls[k].parentNode.removeChild(chromeEls[k]);
          }
          chromeEls = [];
          cue = null;
          document.body.classList.remove('wcc-portrait');
          themeColor(null);   // the site's declared colour is the landscape one
          var root = document.documentElement.style;
          root.removeProperty('--pdock-h');
          root.removeProperty('--pstep-w');
          root.removeProperty('--pstep-h');
          root.removeProperty('--pfit');
        },
        // The player's gesture layer stands down; this file takes the tap.
        ownsInput: true,
        /* ...which means this file also has to be told when to stand ITS gestures
         * down. `onZoomChange` in player-core owns the condition; a stage that owns
         * input gets it pushed here, because `cancelGesture` only reaches the
         * landscape tap layer. */
        zoom: function (on) {
          zoomed = !!on;
          // Any drag or tap in flight belongs to the pinch now.
          gp = null;
        },
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
        /* Hand the touches back to a slide that has live links in it (`data-taps`).
         * Bands are transparent to hit-testing by default so the column can read
         * every gesture itself; a slide the reader is meant to be able to press has
         * to be an exception, and then it reports its own swipes through
         * slide-bridge as it always did. Called by player-core's applyTapThrough on
         * arrival and again when the slide's handshake answers. */
        taps: function (i, on) {
          var b = bands[i], f = b && b.firstChild;
          if (f && f.tagName === 'IFRAME') f.style.pointerEvents = on ? 'auto' : '';
        },
        /* A horizontal swipe that happened INSIDE a slide's iframe, forwarded by
         * player-core from slide-bridge. Every other surface reaches `stepBy`
         * directly, because a band's iframe is transparent to touch; a slide that
         * declared `data-taps` kept its pointer events and so has to report its own.
         * Same verb either way, so both routes are one gesture. */
        step: stepBy,
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

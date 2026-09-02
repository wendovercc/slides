# Portrait Decks — the phone surface

> Status: **the letterbox fallback is built and shipped, and the first portrait
> fragments with it.** Every deck has a phone surface — a column of full-height
> steps that snap — and a step is now rendered one of two ways: a real portrait
> layout where its template has one (`templates/portrait/<template>.html`,
>
> published per slide, fetched and inserted as DOM), or its 16:9 self in a band
> where it does not. `showcase-card` is the first template with a fragment, which
> makes the pavilion deck's opening and closing cards a real phone layout with
> eight letterboxed photographs between them. The model below is settled through
> three worked examples; the open questions at the end are genuinely open.
>
> **The column stopped being a scroller** after testing on a real iPhone — see
> "One authority", which is the correction to read first if you are coming back to
> this. The transport owns the deck's position and a transform renders it; native
> scrolling stays inside a step, where it belongs. Phase 0's mandatory-snap
> decision and the "hand-built transform step-stack" rejection are both reversed
> there, with the reasoning.
>
> **The axes have been swapped, and it is the largest simplification in the
> surface's history** — HORIZONTAL now navigates and VERTICAL only reads. See "The
> grammar" and "One axis navigates". The old rule made vertical do both jobs, which
> was forced while the deck was a scroller and was merely inherited after it stopped
> being one; splitting them deletes `armCommit` outright, withdraws the media strip
> unbuilt, and puts the deck's travel on the one dimension iOS does not rewrite.
>
> **What a reader actually gets on each surface has been audited** — see "Drift
> between the surfaces". Four transport differences turn out to be one leak (the
> column crosses a slide boundary through the wrong verb), pinch-zoom suspends
> navigation on one surface only, and share and the position rail are on the phone
> when they belong to the deck.
>
> **The build order was deliberately inverted** — see "Phase 0" under Phasing.
> The doc originally deferred the fallback as speculative and started with the
> pavilion's fragments; taking the fallback first gave every deck we already build
> a phone surface for one file, and made portrait a property of the surface rather
> than something a deck opts into template by template.
>
> Read alongside `assets/js/portrait.js` (the built surface) and: `assets/js/player-core.js` (`surface`, `placeBar`, the windowing
> valve), `templates/player.html` (`fitLayer`), `assets/js/slide-bridge.js`,
> `templates/slides/photo.html`, `showcase-card.html`, `video.html`,
> `scripts/build.py` (`slide_title_parts`, `slide_atoms`, `_resolve_deck`,
> `_write_deck_data`, `build_match_packages`). Vocabulary from
> `docs/narrated-decks.md`; type/colour rules from `docs/design-conventions.md`.

---

## Why

Two things we already build want a phone audience and have none:

- **The pavilion showcase** (`content/slideshows/seabrook-pavilion.json`) exists
  *only* to be handed to someone as a link — the first thing here that is
  distributed rather than hung. It currently arrives on a phone as a 16:9
  rectangle floating in the middle of a portrait screen.
- **Match highlights**, silent reels and photo sets, are the club's most
  forwardable content and have no shareable form at all.

This is a second **surface** for decks that already exist, in the shape the
`?interactive` work established in `5b9268e`: one deck, more than one way to be
looked at. The wall is not to be solved twice, and **must not change**.

---

## The grammar

Two rules cover every deck, and they are one idea:

> 1. **One axis navigates, the other reads.** HORIZONTAL is the whole of the
>    deck's forward motion — steps, panels, photographs. VERTICAL is the interior
>    of a step and nothing else.
> 2. **A step is a phase**, which already exists in the data.

Everything below is consequence.

**This reverses the doc's first grammar**, which made vertical the step axis and
left horizontal for media inside a step. That was right while the deck was one tall
scroller — vertical had to be both axes because there was only one — and it was
inherited rather than re-argued when the deck stopped being a scroller and became a
transformed track ("One authority"). Splitting the jobs is what that change was
always pointing at. The reasoning, and the cost, are under "One axis navigates" and
in the reversal note in "Rejected, with reasons".

### 1. One axis navigates, the other reads

The wall paginates because it has no second axis: the only way it can show Batting
*then* Bowling is over time. The phone has scroll, so a step stacks them — and the
DECK still paginates, because a deck is a sequence of authored screens and always
was. What changed is only which direction that pagination runs.

- A step is **its own scroll container**, and vertical is entirely its. Native
  momentum, rubber-band, accessibility, and `overscroll-behavior: contain` so a
  pull at the end bounces rather than becoming the browser's. **There is no commit
  gesture**: a thumb never leaves a step by scrolling, because scrolling is not how
  you leave a step.
- **Horizontal is the transport being asked to move** — the same call the ◀ ▶ on
  the control bar make. One verb, three ways to reach it, and no second nav model.
- **Vertical never navigates.** Strictly: a band step has no interior, so a
  vertical drag on a letterboxed photograph does nothing at all. That is the price
  of one meaning per axis, and the band is the transitional rendering anyway. (The
  permissive variant — *scroll if there is something to scroll, advance if there is
  not* — is unambiguous too, since the ambiguity only exists where an interior
  exists. Held in reserve if a dead-feeling band tests badly.)

**What this deletes**, and it is the reason to do it at all:

> The **forgiving commit** and everything holding it up — the arming rule, the
> anchor re-taken mid-scroll, two thresholds, a separate wheel accumulator with its
> own expiry. All of it was the cost of one axis doing two jobs. `armCommit` was the
> most delicate code on this surface and it is now no code at all.

And a second, quieter win: the track travels by the deck's WIDTH. Height is the
number iOS changes on its own when Safari's chrome collapses — the reason
`--pstep-h` has to be measured in JS rather than left as `100dvh`, and the reason a
scroll-derived position could drift with nobody touching anything. Putting the
deck's travel on the axis the platform does not rewrite is "One authority" applied
one level down.

**Steps may be much longer than a screen, and that is a feature.** The wall lists
`top_rows: 12` fantasy players because that is what reads at ten feet. The phone
can list 25 and be *better*. See "The phone wants more content".

*Why not `scroll-snap`:* it was never the interior that wanted snapping, it was the
seam — and the seam is not a scroll. See "One authority" for why deriving the
deck's position from a scroll position could not be made to work.

**The edge-swipe objection, which is what kept horizontal off the step axis until
now.** iOS Safari's left-edge swipe is browser-back, unpreventable while
`touch-action` stays `auto` (and it must, or pinch-zoom goes with it —
`project_touch_pinch_zoom`). Three answers, in order of how much they carry:

1. **Only the left edge is back.** The right edge is forward, and a freshly-opened
   link has no forward entry. The gesture that carries a deck — *next* — never
   collides. Only *previous* does.
2. **The outer strip is already declined.** `armDeck` ignores gestures starting in
   the outer 5% either side, so one gesture does one thing. Swipes from mid-screen,
   which is nearly all of them, are ours.
3. **And then stop fighting it: back IS previous.** The deck keeps a single history
   entry while it is off its first step, so the edge swipe means "previous step" and
   the platform does our job instead of undoing it. One sentinel, replaced rather
   than accumulated — back walks the deck backwards, and back from the first step
   leaves. This is the machinery "Back closes overlays" already asks for, and it did
   not exist when the objection was written.

The residual unknown is not iOS Safari but the in-app browsers a forwarded link
actually opens in — WhatsApp's especially. A device test, not an argument.

### 2. Media is steps, not a strip

**This is the rule the axis swap withdrew**, and withdrawing it is most of what
made the swap attractive rather than merely tidy.

The original rule said photo sets and video reels are a horizontal axis *inside* a
step — a strip — because a run of them as steps meant a vertical feed, and the
vertical-feed idiom (Reels, TikTok) works only for independent full-screen
*portrait* video. Ours are 16:9 bands with Frogbox graphics baked into the frame
and our own overlays positioned as percentages of it (`--reel-narr-bottom:
9.83%`, the reel tag, the `pre`/`post` cards): they cannot be cropped to portrait.

That reasoning was about **vertical**, and it survives intact — as an argument
against a vertical feed, which is not on offer any more. Horizontally paged
full-bleed photographs are not a feed at all. They are a photo album, which is the
native idiom for exactly this content and the reading the strip was trying to
reconstruct inside a step.

So:

> **A photo set is a run of steps.** The eight pavilion photographs are eight
> steps, swiped sideways. No strip, no collapse rule, no second addressing scheme
> inside a step.

> **A reel is still ONE step**, whatever its clip count — the `/deck` rule,
> unchanged. Horizontal leaves the reel; clip-by-clip nav lives *inside* the phase-2
> player overlay, where there is a real transport and an indicator for how many
> clips there are. That is strictly better than the strip it replaces, which walked
> twenty clips with nothing on screen to say so.

What this deletes: the media strip, its driven mode, the "one step, N atoms" case
in play-mode anchor traversal, and grouping rule 2 below. The timing is the
argument — none of it is built, and it would have been expensive to withdraw once
it was.

**Video and photos still differ in one respect — whether a poster frame gates
them:**

| | Gate (interactive) | Why |
|---|---|---|
| **Video reel** | Poster frame → tap → player | A clip costs bandwidth and 30s of commitment; a poster is a fair ask. |
| **Photo set** | None | Already loaded, instant, costs nothing to look at. Gating it puts a tap in front of the only thing the deck exists to show. |

**The gate is an interactive-mode affordance only.** In play mode (below) the
driver confers focus, so there is nothing for a gate to resolve: the reel plays
*inline in its band*. Same principle in both directions — a poster exists because
free browsing has no focus, and disappears when something else supplies it. Media
therefore needs **a driven mode and a user mode from the start**.

A photograph gets no fullscreen, and that is forced by the platform:

> **We cannot give photographs landscape the way we can give video landscape.**
> iPhone Safari's *video* fullscreen is native and rotates the device itself —
> which is why `toggleFullscreen` already guards for the element Fullscreen API
> being absent on iPhone ("video-only there"). There is no equivalent for an
> image: `requestFullscreen` on a div does nothing on iPhone, and
> `screen.orientation.lock()` is unsupported in Safari. A photo "fullscreen" on an
> iPhone is a fixed-position black overlay, still portrait, showing the 16:9
> photograph at the same width it had in the flow.

So for photos the tap buys the user nothing but a tap. A "view larger" control
stays available for devices where it does help; it is an upgrade, not a gate.

**Cropping rule:** crop-to-fill works for people and action; **wide interiors stay
wide**. The pavilion is squarely the second — cropping a room shot to 9:19.5 throws
away the subject. Where crop-to-fill *is* wanted, `photo.html` needs an optional
`focus` field on the slide JSON driving `object-position`, so a shot doesn't
centre-crop onto a table leg.

### 3. A step is a phase

`slide_title_parts` already resolves each slide to its header hierarchy —
`["Last Match", "1st XI", "1st Innings", "Batting"]` — and `_atoms[].phase`
already carries the phase. It is what names the wall's tab strip. **Group
consecutive atoms by phase and the phone's stepping falls out with no new
authoring.**

Verified against the real build (`site/slideshow/last-match-1st-xi/data.json`:
9 slides, 37 atoms, reels of 10 and 20 clips):

| Phase | Wall | Phone step |
|---|---|---|
| *(intro)* | 1 slide | **Last Match** — header, league, both sides' form, toss |
| 1st Innings | reel (10 clips) + batting + bowling | **1st Innings** — poster, batting, bowling |
| 2nd Innings | reel (20 clips) + batting + bowling | **2nd Innings** |
| Result | 1 slide | **Result** |
| League | 1 slide | **League** |

Fantasy League's four tabs *are* four phases → four steps (Team of the Week, Top
Players, Top Managers, Teams).

**Grouping is ONE rule now**: group consecutive atoms by phase. The second rule —
collapse a run of media atoms into one strip — went with the axis swap (see rule 2
above), and its going is a simplification rather than a loss: a run of photographs
is a run of steps, which is what a sideways deck already is.

The pavilion's slides carry no phase, so it is **ten steps: Title · eight
photographs · Credit** — swiped through as an album. In the match package the
phase rule does all the work, and a reel stays one step by the `/deck` rule rather
than by a collapse.

**The invariant that replaces "step = atom":**

> **Every atom appears exactly once, in order.** The phone paginates coarser and
> the wall's atoms become sections inside a step.

This is what keeps the narration seam alive (below) and stops the phone becoming a
second nav model that has to be kept in sync with the first.

---

## One authority

> **The transport knows where the deck is. The column renders that, and nothing is
> ever read back out of the DOM to decide position.**

This replaced the phase-0 model and is the most important correction in the
document. The original column was one tall scroller — a row per step,
`scroll-snap-type: y mandatory` — with its position *derived* as
`scrollTop / stepHeight`. That put **three agents on one number**:

1. the **transport**, which performed every advance by writing `scrollTop`;
2. the reader's **thumb**;
3. the **browser**, which has its own opinion about where a mandatory-snap
   container comes to rest, and acts on it.

And the denominator, `deck.clientHeight`, is a number **iOS changes on its own**
when Safari's chrome collapses — so the deck's idea of where it was could change
with nobody touching anything.

Every one of these was a patch on that premise: `pending` (to stop the transport's
own scroll echoing back as a navigation), `settle` on a 110ms timer, a 1200ms
backstop for a smooth scroll that never arrived, an idle guard so a re-anchor never
fired mid-drag, and the re-anchor itself. They were not five bugs. They were one
wrong idea, five times.

It failed anyway. On an iPhone in a Safari tab, pressing Next advanced the rail and
left the column where it was — four times, and then a jump to the last step.
Nothing reproduced in a desktop emulator, because none of the three agents behaves
the same there.

**So the seam between steps became a transform and the position became a number we
own.** What that changes:

- `place()` writes `translate3d` on a track from `atSlide`. That is the entire
  rendering of position.
- **A step change is always `stepBy(±1)`**, which asks the *player* to move —
  literally the call the control bar makes. A swipe and a bar press are one event,
  and there is no second nav model to keep in sync with the first.
- `fit()` is layout only. An iOS resize is a resize.
- `indexAt`, `scrollToPos`, `commitTo`, `settle`, `pending` and the re-anchor are
  **gone**, not repaired.

**Native scrolling stays exactly where it earns its keep — inside a step.** A
fragment step is still its own `overflow-y: auto` scroller with momentum,
rubber-band and `overscroll-behavior: contain`. The rewrite removed the *deck*
scroller; it never touched the interior one, which is the thing the "no hand-built
step-stack" rejection was actually protecting.

### Two routes into one verb

A step change reaches `stepBy` from two places, because there are two kinds of
surface a thumb can land on and a drag on each must mean the same thing:

| Where the thumb is | How it arrives |
|---|---|
| Anywhere on the column — **matte, band or fragment** | `armDeck`, a horizontal drag on the column itself |
| A band that declares `data-taps` | `slide-bridge.js` posts `wcc-swipe` |

**There used to be three**, and the third was `armCommit` — a fragment step's
overscroll commit, which existed only because vertical was both the interior axis
and the step axis. With the axes split it is gone entirely: a horizontal drag over
a fragment is not a scroll, so it reaches `armDeck` like every other drag, and a
vertical one is the scroller's and nothing else's.

**Bands are transparent to hit-testing** (`pointer-events: none` on the iframe),
which is what put every gesture in one handler. A band is another document, so a
thumb landing on it was invisible to the column and the slide had to notice and
post the gesture out — a long chain, for the part of the screen a reader is most
likely to touch, and not the chain the matte and fragment steps use. It did not
work on a phone. Transparency also brings the **wheel**: a trackpad over a
photograph reaches the deck now, where before it went into the iframe and died,
since `slide-bridge` reports touch only.

What it gives up is the slide's own links, and today that costs nothing —
`data-taps` is declared by `showcase-card` alone, which always renders as a
fragment rather than a band. `stage.taps()` hands the events back to any slide that
does declare them, driven by the same `tapThrough` flag `applyTapThrough` already
maintained for the landscape tap layer, in the opposite direction. So the exception
exists before it is needed rather than after.

This revises phase 0's "no tap layer, and tap-through comes free". Tap-through was
free, but it was not free of *the gesture* — leaving the slide exposed to touch
meant leaving the column blind to it.

**`armDeck` fires mid-drag, on `touchmove`; `slide-bridge` stays a touchend
flick.** The difference is which document is measuring: the column knows the drag
is horizontal as soon as one axis dominates, where a slide reporting out has to be
sure the gesture finished as the thing it looked like.

**A threshold in design px is not a threshold on screen.** This applies to
`slide-bridge` and not to `armDeck`, which measures the deck and is therefore
already in real px. A band is fitted to the screen's *width*, so a fraction of 1920
design px is that same fraction of the screen — which is the nav axis, and the easy
case. Height is not: the band is 1080 design px tall but only `screenWidth × 9/16`
real px, so the same fraction is about 2.5× less travel. That correction (`V_SLOP`)
now guards a reported axis nothing acts on, and stays only because a vertical drag
must still be *recognised* as vertical in order to be ignored.

**One wheel stream is one step.** A trackpad flick is a hundred events over a
second or more of momentum, so an accumulator that only resets after firing crosses
its threshold again immediately and walks the deck several slides on one gesture.
The wheel path latches until the stream actually stops (250ms of silence), which is
the equivalent of lifting a finger.

A wheel is the one input where strictness is relaxed, and deliberately: **on the
column, a wheel steps whichever way it is pointed.** A desktop reader in a narrow
window scrolls vertically out of habit and there is nothing else for a wheel to do
over a band. Inside a fragment step the rule is exact again — vertical scrolls the
interior natively, horizontal steps — because there a vertical wheel has a real job.

### What it cost

Momentum-flicking through several steps at once, and the native scrollbar on the
deck. Neither is wanted: a step change is a deliberate, one-at-a-time act, and the
segmented progress rail is a better position indicator than a scrollbar on a deck
of ten. The scrollbar inside a step is a separate thing and still there.

---

## No iframes (except one case)

The wall renders each slide as an iframe for four reasons: a slide is a standalone
document; CSS/JS isolation across ~20 templates that all reuse `.panel`, `.table`,
`.row` and set `window.WCC_CAROUSEL`; `/screen/<loc>/` resolves its deck at runtime
so the build cannot inline it; and teardown-by-clone is a blunt, reliable reclaim.

Only isolation and memory are about rendering, and both change in portrait:

- **Memory.** The iOS jetsam (`project_ios_pwa_crash`) was caused by each iframe
  rasterising a *fixed 1920×1080 design box* at device scale, squared by pinch
  zoom — regardless of on-screen size. Portrait drops the fixed box (below). Drop
  the iframe too and an off-screen step is just DOM in a scroller: not rasterised,
  no per-section compositing surface, and `content-visibility: auto` makes it
  explicit. **The two decisions reinforce each other.**
- **Isolation** becomes a build problem, which is where we have most control: one
  portrait stylesheet, each step's rules scoped under a template class the build
  emits systematically.

**So the build writes real HTML for portrait: one `<section>` per step, native
scrolling inside each.** Text stays shared because both renderings come from the
same `slide` dict through the same build; layout is the thing that should differ.
Where that markup is *published* is the next section.

### The one case iframes earn their place

**The letterbox fallback.** A template with no portrait layout can show its
existing 16:9 self in a band, and that genuinely is another document. It is the
*easy* iframe: a 16:9 band's height is exactly `width × 9/16`, known before it
loads, so it composes into the scroller with no height measurement and no
placeholder guessing. Window those (and `<video>` elements) by proximity to the
viewport; leave plain sections alone.

**This turned out to be phase-0 work, not deferred work** — see "Phasing". Taking
it first inverts the opt-in: portrait is a property of the *surface*, every deck
has it, and a portrait fragment is an upgrade to one step rather than the
precondition for a deck offering the surface at all. Nothing is all-or-nothing,
and no deck has to wait for its last template.

### Where the portrait document lives

**The canonical artefact is a per-slide portrait fragment, not a per-deck page.**

The obvious move is to inline a deck's portrait sections into its own page. That
breaks the moment a deck is assembled at *runtime* — which `/deck` does, and which
play mode requires (below). The build cannot inline a document for a deck that does
not exist yet.

So the build publishes each slide's portrait markup as an independently addressable
fragment, and the portrait runner assembles a deck from them client-side. Any deck —
authored, auto, or built in `/deck` five seconds ago — is then a first-class
portrait experience rather than a wall of letterboxed bands.

CSS isolation still holds: **one shared portrait stylesheet** covering every
template, each template's rules scoped under a class the build emits. That is
required for fetched fragments and is the same discipline inlining would have
needed anyway.

Inlining survives as an **optimisation** for the decks we share — the pavilion,
the match packages — giving first paint with no round trip, and keeping the OG
tags and canonical URL on one URL that every link already sent still points at.
Rotation stays a class swap: no reload, no lost video position.

Cost is page weight (a 38-step match deck's markup, inline). Measured before phase
3; the fragment path is the fallback if it is bad.

---

## No fixed design box in portrait

This reverses the obvious carry-over, and the reasoning matters because the wall's
rule is load-bearing.

The wall lays every slide out in a fixed 1920×1080 box and scales it by `--fit`
(`fitLayer()`, `templates/player.html`). Slides size their type in `vw`; on a small
viewport those resolve to a handful of CSS px, where WebKit stops honouring them
(text autosizing, minimum-font-size, whole-px line-box rounding), text renders
taller than the `vh` rows budgeted for it, and a full scorecard falls out the
bottom.

**The wall wants resolution independence. The phone wants physical-size
constancy.** A 1080p and a 4K panel must show an identical composition; a phone
must show type a hand-held reader can read, and 16px is 16px on every phone.

The geometry rules it out anyway: a 1080×1920 box is 1.78:1, a modern iPhone
viewport about 2.17:1 — fitting by width leaves ~18% of screen height empty, on an
experience whose premise is full-bleed. Portrait aspects also spread from 0.46 (tall
phone) to 0.75 (iPad portrait), a 1.6× range in height-per-width. No single box
fits them.

**In portrait the content fills the step. No design box, no `--fit`** (except
inside the fallback band, where both survive, scoped to it).

That is safe because the WebKit trap is a consequence of `vw` type resolving tiny,
and portrait type will not be `vw`. Portrait wants a **floored fluid scale**:

```css
.portrait {
  --u:      clamp(3.4px, 1vw, 6px);   /* one knob for the whole scale */
  --t-hero: calc(9   * var(--u));
  --t-lg:   calc(6   * var(--u));
  --t-md:   calc(4.4 * var(--u));
  --t-sm:   calc(3.4 * var(--u));
}
```

**This is a scoped exception to "no `px` anywhere in a slide"** and needs writing
into `docs/design-conventions.md` when it lands. That rule guards against *browser
zoom on a panel whose resolution we do not control* — the CSS viewport shrinks,
in-flow `px` shoves its siblings, and error accumulates down a table until the last
rows walk off. Neither condition holds here: phone pinch is *visual* zoom, which
does not change the layout viewport (`project_touch_pinch_zoom`), and portrait
layouts are not accumulating table rows. **The wall rule stands unchanged outside
portrait.**

Residual risk is overflow on a short step (iPad portrait). The discipline: a
portrait layout is a flex column with **one flexible hero** and **intrinsic text
blocks** — the hero absorbs slack, the words never reflow into overflow. Text that
cannot fit the shortest plausible step is split into two steps, which costs
nothing.

---

## The surface rule

One rule, one place — extending `WccPlayer.surface()`, which already owns this and
was made sole owner in `5b9268e` for exactly this class of bug:

```
portrait = interactive && !record && deckHasPortrait && (innerWidth / innerHeight) < 1
```

- **Never on the wall.** `/screen/<loc>/` withholds `standalone` today and must
  withhold `portrait` the same way.
- **Record mode is excluded explicitly**, not by implication. `?record` *sets*
  `interactive` in `surface()` today, so without this a narrator holding a phone
  would record against the portrait surface. A take is authored once, in
  landscape.
- **Kiosk unaffected** — it is not interactive.
- **Rotation swaps in place**, keeping position, and in BOTH directions — see the
  swap note under Phase 0. The portrait tree is built once (inlined or fetched)
  and *kept*; rotation toggles which tree is shown. Not a reload, and not a
  rebuild — a played clip keeps its position. (Today the column's letterbox bands
  still cost a reload of the frames on screen, because a moved iframe reloads;
  fragments are what redeem the rest of the promise.)
- **An open overlay suspends re-evaluation.** This is a freeze on the *rule*, not
  a term in it: if someone rotates while inside the video player they must not be
  flipped into the 16:9 player, but they have not stopped being on the portrait
  surface either. Putting `!overlayOpen` in the predicate would say the opposite
  and swap them out the moment an overlay opened.

### Back closes overlays

iOS Safari's left-edge swipe is browser-back, and a full-bleed horizontal carousel
sits on top of it. **Every overlay — video player, view-larger, contents sheet —
pushes a history entry so back dismisses it** rather than leaving the deck. `armDeck` also declines a gesture starting in the outer 5%, so
one edge swipe does one thing.

**And the deck itself keeps one entry**, so back means *previous step* while the
reader is off the first one. That is the third answer to the edge-swipe problem
under rule 1: an edge swipe that would once have carried a reader out of a
forwarded link now walks the deck backwards, and only leaves from the first step.
One sentinel, replaced rather than accumulated — a deck of thirty steps must not
cost thirty presses to escape.

---

## Chrome

Deliberately almost none. The content is the interface — and **chrome is earned
per deck, not built up front**. A three-step deck does not need a contents sheet,
and a one-screen step does not need a sticky title. Build each when a deck makes
it necessary.

- **No persistent tab strip**, ever. It costs viewport on every step to serve a
  jump most viewers will not make, and only helps *within* one slide — a 30-step
  match deck wants an index just as much and would not get one.
- ~~**A thin progress rail**~~ — built, and **not portrait chrome at all in the
  end**: it is the player's one deck instrument, on both surfaces, and it carries
  the atom countdown in its current tick. See "Chrome — mostly fixed" under the
  drift audit.
- ~~**Share**~~ — built, and likewise a player control rather than a portrait one.
  `navigator.share()` with the canonical URL the `_og.html` preview was baked
  against.
- **Sticky step title.** Earned once a step runs several screens (1st Innings is a
  poster, eleven batting rows and six bowling rows). `position: sticky`, one line.
  *(Phase 3.)* The pavilion's steps are one screen each and a title bar over the
  photographs is chrome on the one thing we said to leave uninterrupted.
- **A contents sheet.** One small control opens an overlay listing every step, tap
  to jump, dismiss. Zero standing viewport cost. Absurd for three steps; earns
  itself at the match package's five long ones. *(Phase 3.)*

`placeBar()`'s three placements (`below`/`right`/`inside`) all answer one question —
which letterbox band can hold the bar — and a portrait deck has no band to answer it
with. **So portrait has a fourth placement, `portrait`, and it is a DOCK rather than
a float** (built): a full-width toolbar along the bottom edge, opaque and square,
with the safe-area inset inside its own padding.

The part that matters is not how it looks but what it costs: **the column shortens
its scroller by the bar's measured height**, so a step is the space *above* the dock
and nothing ever scrolls behind it. The other three placements can float because
they sit over a letterbox band — over nothing. A full-bleed portrait layout has no
such space to give away, and content sliding under a translucent widget is the
difference between a phone app and a slideshow with something on top of it.

That makes it a two-way seam, which is why it is on the stage rather than in
`placeBar`'s aspect arithmetic: the stage asks for the dock (`barDock`), and the bar
reports its height back (`stage.chrome(h)`), re-measured on every placement so a
rotation or a safe-area change stays right. The column shortens its scroller by it,
and nothing else needs it: the deck instrument is a single rail on the TOP edge, so
the dock has no line to get in the way of.

The share button moved into the dock with it — beside the transport, where a phone
app puts it, and where it costs no content. It floated in the top-left corner while
the bar was a pill over a letterboxed slide; that is a corner a full-bleed layout
wants back. It is built by `buildControls` rather than by this stage, so landscape
has it too and a rotation cannot take it away.

### What the matte says — *proposed, not built*

A band step has two mattes, above the letterbox and below it, and today both say
nothing. That is worth fixing before it is worth defending: dead navy immediately
above and below shrunken content reads as *unfinished* rather than as *deliberate
letterboxing*, and the reader has no way to tell which it is.

The proposal is **a rotate mark and the words "Try rotating" in the matte below
the band.** The case for it is the mirror of the one the surface rule already
makes in the other direction — *a landscape screen showing a portrait column is a
screen showing the wrong thing, and a rotation is the clearest instruction a phone
can give about the shape it now is.* A band step is that sentence reversed: a
slide authored for 16:9, shrunk to a postage stamp, on a screen that could show it
properly if it were turned. It is the one true thing that space has to say.

It can only be said because rotation **swaps in place and keeps position, both
ways** (see "The surface rule"). A mark that offered a bigger view and then cost
the reader their place in the deck would be worse than silence.

Four decisions come with it.

- **This is the matte's DEFAULT content, not a cue.** Every band step shows it,
  for as long as the step is a band. The once-per-page discipline belongs to
  motion, which teaches a gesture and then owes the reader nothing further; a
  standing label states an option that is still true on step five, where a reader
  who has just decided they want a closer look has no other way to learn that one
  exists. Nothing about it animates, and that is what keeps it from nagging.
- **No badge, no ring, no plate.** The scroll nudge is off precisely because its
  ringed disc taught "button" before it taught "swipe" (`CUE_ENABLED`, and the
  comment above it). The asymmetry that rescues the rotate mark is that the cue
  floated over a fragment's own content and needed a ground to survive it — the
  matte mark never does. The matte *is* the ground. Glyph and word, drawn straight
  on, at low contrast, taking no pointer events and never eating the matte tap
  that toggles transport.
- **The label earns itself even though the rest of the chrome is glyph-only.** A
  circular-arrow rotate glyph is genuinely confusable with reload. Alone it is
  ambiguous; with the word it is not.
- **"Try rotating", not "Rotate".** Orientation lock is the real risk here: a
  meaningful share of phone readers have it on, it cannot be feature-detected, and
  an instruction the device will not obey is the worst thing chrome can do. An
  offer that goes unaccepted is still an offer; an imperative that fails is a bug.
  The wording carries the whole mitigation, so it is not a stylistic choice.

**Below the band is the default, not a reservation.** This is what the fallback
presentation says when nothing better is available for that step. A particular
step is free to spend either matte on something worth more — a caption under a
photograph is the obvious one, and is content where this is chrome.

**And it is explicitly temporary.** This is chrome that advertises a limitation,
and every portrait fragment built deletes one more place it can appear. A band
that says "Try rotating" is a band admitting it does not have a phone layout yet,
which makes it a bridge to phase 1's remaining work and not a substitute for it.

---

## Tables, cards, and more content

### Cards or table?

Do not card-ify mechanically.

> **Cards** when the reader scans a ranked list by one value and the name
> dominates — Top Players, Top Managers.
> **Table** when the reader compares rows across several columns — the league
> table, where the comparison *between* rows is the entire point and cards destroy
> it. On a 390px phone: Pos, Team, P, Pts, with the rest dropped or expand-on-tap.

The batting scorecard is the middle case: eleven rows of name / dismissal / R / B /
4s / 6s, where the dismissal is prose wanting its own line and the numbers want
columns. Probably a hybrid — name and dismissal above, the numeric row beneath,
ruled — a card that keeps its numbers aligned. Belongs in
`docs/design-conventions.md` once settled.

### The phone wants *more* content

This is the one place "share the text content" is not free. If the phone lists 25
fantasy players and the wall lists 12, **the build must emit the longer list and
the wall must take the top of it** — in a way that cannot alter what the wall
renders. Affects every table template that has an authored row cap (`top_rows`,
leaderboard `rows`, honours). Decide the mechanism once and apply it uniformly.

---

## Play mode

**The portrait surface must be drivable, not only browsable** — the same
distinction `?interactive` draws today. A portrait deck has to be able to *play*:
advance on its own, from `/deck`, with a narration take over the top. This is a
phase-1 structural requirement even though the transport ships later, because it is
cheap to build in and expensive to retrofit.

### An atom is a scroll anchor

This is the piece that makes play mode work, and it is the phone's counterpart to
the wall's "atom is a beat":

> **Every atom is an addressable position**, carrying a stable id matching its
> identity in `_atoms` (`data-atom="<slug>#<panel>"`). Playing a deck is a
> sequence of *(position, dwell)*. Browsing it is reaching the same positions by
> hand.

A position is reached one of two ways — **a step change, or a vertical scroll
within a step** — and that is now the whole of it. The strip index is gone with the
strip: the pavilion's eight photographs are eight steps, so play mode steps to
each. What remains is that a long fragment step has several anchors inside it and
play must scroll between them, so "anchor = the next step" is as wrong as
"anchor = scrollIntoView" would have been.

Both modes traverse one structure. Nothing about play mode is a second document,
a second ordering, or a second addressing scheme — which is exactly what the
"every atom appears once, in order" invariant was protecting.

### What playing looks like

- **Within a step**, play *auto-scrolls* between anchors rather than cutting. A
  step can be three or four screens, so a cut would be disorienting where the
  manual behaviour is a scroll. Same motion, different driver.
- **At a seam**, it snaps — identical to the manual commit, so the two modes read
  as one experience.
- **Media plays inline**, ungated, per the rule above.
- **Scroll-to-anchor must be interruptible and snappable.** An animation has
  duration; if the next cue arrives before it settles, the runner jumps. Never let
  the animation own the clock.

### Narration over a played deck

The user-driven case is the hard one and stays out of scope. The **played** case is
the easy one, and it is what is wanted first:

> A continuous take plus cue timestamps drives a played portrait deck directly —
> the audio is the clock and the cues fire the advances. **No segmentation is
> needed.** This corrects an earlier assumption here: per-atom audio segments are
> required only to serve a viewer moving at *their own* pace, which a played deck
> by definition is not.

The payoff of the invariant, stated plainly:

> **A take recorded on the landscape surface plays over the portrait surface
> unchanged**, because both address the same atoms in the same order.

Record mode itself stays landscape and untouched — a take is authored once, and a
narrator's surface is not the thing being futureproofed here.

Narrated decks still get the composed MP4 and YouTube for posterity, which remains
right today: match highlights suffer content drift and we have no content-freeze
feature (`docs/narrated-decks.md` — the render *is* the freeze).

**Nothing in the portrait work should drop an atom, reorder atoms, or introduce a
section that is not one.**

---

## Drift between the surfaces

What a reader actually experiences differently on the two surfaces of the *same*
deck — read off the built code rather than off this document. Most of it is
design and stays; the list exists so the part that is not design can be told
apart from the part that is.

The rule the audit applies:

> **The surfaces are allowed to differ in GEOMETRY. Anywhere they differ in what
> a control MEANS, one of them is wrong.**

*Status: the divergent verbs, the pinch-zoom guard, share, deck position and the
bar's geometry are fixed; the keyboard gap, the deck-end difference and live chrome
are open. Each is marked below.*

### Divergent verbs — ~~unintended~~ *fixed*

Four of these were one leak, not four decisions. The column crossed a slide
boundary through `api.goTo` — `arrive(i, 0, playing)`, the verb for *reaching a
slide by name* — where the control bar crossed through `fwdSlide` / `backSlide`.

**The stage is handed `fwd` and `back` now, and uses them.** `goTo` stays on the
transport for what it is actually for: a contents sheet or an index, where the
reader names a slide rather than steps to one. Neither can wrap from `stepBy`,
because by the time it crosses it has already established that the next step
exists, so the neighbour is the immediate one either way.

What that fixed, in the order the table lists it: stepping forward onto a reel
starts it (`fwd` carries `playing || video`), and stepping back lands on the
previous slide's last atom and pauses (`back` passes `'last'`).

| | Landscape | Portrait | |
|---|---|---|---|
| **End of the deck** | ▶ wraps to the first slide (`fwdSlide`) | `stepBy` refuses to wrap | **Left standing, deliberately.** A swipe is a gesture and gestures stop; a button press is a command and continues. Now that both live on the same axis it is the one difference a reader could meet, so it is stated rather than fixed: if it reads wrong on a device, the change is to stop the deck wrapping on the interactive surface at all, which touches landscape and is not a portrait decision |
| ~~**Forward onto a reel**~~ | arrives `playing \|\| video` — stepping onto a reel is a request to watch it, even from paused | ~~arrives `playing` — the reel parks~~ | **Fixed.** Both cross on `fwd` |
| ~~**Back across a slide**~~ | the previous slide's LAST atom, paused | ~~its FIRST atom, still playing~~ | **Fixed.** Both cross on `back`, which also restores the point of `placeAt(i, back)`: a returning reader lands at the bottom of the previous step AND on the atom they left |
| **Keyboard** | arrows are the atom move | the same | **Narrowed by the axis swap, not fixed.** Arrows now agree with the bar's ◀ ▶ on the axis a swipe uses, and step and atom are the same thing on every slide except a reel — where the arrows walk clips and a swipe leaves. That is the interim reading until the reel gets its player overlay, and it is defensible; it is listed because a narrow desktop window gets the column, where it is the only input a reader has |

Wheel is the reverse case and is harmless: the column steps on a trackpad flick
and the landscape stack ignores the wheel entirely.

### Pinch-zoom — ~~unintended~~ *fixed*

Landscape stands its gestures down completely while the viewer is pinched in —
`zoomed` guards both the tap layer and the bridge's swipes. None of the column's
input paths consulted it, so on a zoomed portrait deck a one-finger pan navigated
and a tap toggled playback: the reader could not examine a scorecard without moving
it. The shared halves of the response (the timer stops, the window collapses to the
visible slide) were already right on both surfaces; only the gesture suspension was
landscape-only.

**`onZoomChange` stays the single arbiter and now pushes the state to the stage**
(`stage.zoom`), because `cancelGesture` only ever reached the landscape tap layer.
Deliberately pushed rather than read off `visualViewport` a second time — two
readings of one condition is how the surfaces drifted in the first place. A stage
arriving mid-session is seeded with it too, so a rotation while zoomed does not
navigate once on the way in.

### Chrome — ~~design, mostly~~ *mostly fixed*

The audit said share and deck position were "not a property of geometry" and
should be promoted rather than defended. Doing that turned out to settle a fifth
thing nobody had listed: **once an instrument belongs to the deck rather than to
the stage, it stops having a placement problem at all.** Share, the rail and the
countdown were all built by whichever surface happened to be up; all three are the
player's now, and the two that draw a line have one rule between them.

> **ONE rail on the top edge of the reading area. One tick per atom, and the
> tick you are ON fills over its dwell.** Both surfaces, both orientations,
> whatever the control bar is doing.

- ~~**Share exists only in portrait**~~ — **fixed.** It is a bar control now
  (`buildControls`), built wherever `navigator.share` exists, and a rotation cannot
  take it away because `detach()` no longer owns it.
- ~~**Deck position exists only in portrait**~~ — **fixed.** The rail is
  `#wcc-prog-top`, on both surfaces, counting the same table: one tick per atom
  with a reel as one, which is the rule the portrait step table already used, so
  the two surfaces measure the same deck. Segmented up to `TICK_MAX` (24), a
  continuous fill beyond it.
- **The countdown stopped travelling with the bar, and then stopped being a
  separate instrument at all.** It was a child of `#wcc-bar`, which put it on the
  bar's bottom edge in `below`, on its side as a vertical strip in `right`/`inside`,
  and on the dock's top edge in portrait — one instrument, four positions, two grow
  axes. Welding it to the viewport's bottom edge fixed that and deleted the axis
  (`progressAxis`, `progressRelayout` and the `scaleY` variants all went; the fill
  is always `scaleX`). **Then it was folded into the rail**, because the two facts
  are really one fact: "time left" only ever means "time left *on this step, of
  these steps*", and a sweep anchored to its own tick says both in one shape. It is
  also the stories idiom, which every phone reader already knows — worth a great
  deal for someone opening a forwarded link cold.
  - **Three tick states.** Behind you: filled, dimmed. Ahead: empty track. **Here:
    filled at full strength — sweeping while playing, solid while paused.** Solid
    rather than empty because the common case for a forwarded deck is a reader who
    never presses play, and an empty "here" reads as the one place you have *not*
    got to. Dimming the ticks behind is what keeps "here" legible once it is solid.
  - **A reel steps its tick by clip, not by time.** A reel is one tick by
    construction (`railSteps`), but its countdown runs per *clip* — so a time sweep
    would fill and empty the same tick 29 times and read as broken. `railClip()`
    walks it by clip index instead, which is also the only honest measure available:
    a reel's `panel_duration` is a padded advance backstop (whole reel + 30s), not
    its length.
  - **The countdown is lost above `TICK_MAX`, deliberately.** Past 24 atoms the rail
    is one continuous fill and there is no tick to sweep. A deck that long opened on
    a phone is being browsed, not waited on; the ones that really are played end to
    end (`teams` at 89, the match package at 38) are wall decks, and the wall has no
    bar and no instrument at all.
  - **The rail yields to chrome, not to the letterbox.** A letterbox band is not
    chrome — it is nothing — so the rail runs over it to the glass. The one thing it
    insets for is the live matte strip, measured off `#stage` × `--live-band` the
    same way the record chrome measures itself, and re-measured when
    `body.live-chrome` changes. Folding the countdown into the rail retired the
    bottom inset entirely, so `layoutInstruments()` is now a single left edge.
- **The scroll cue** is portrait-only and correctly so — it teaches a gesture that
  exists on one surface. **Currently OFF** (`CUE_ENABLED = false`), and the code is
  kept: what was wrong is the badge, not the idea. The ring was chosen to borrow the
  floating share button's vocabulary so it would read as "control" — then share
  moved into the dock and dropped its border, leaving the cue as the only ringed
  circle on screen and the only one that is not pressable. It taught "button" before
  it taught "swipe". Revisit with a treatment that cannot be mistaken for a target;
  the likely answer is no badge at all and a peeling edge of the next step instead.
- **The bar** carries the same controls both ways, and now at the same SIZE both
  ways. The 44pt floor was on `place-portrait` alone, which quietly made the same
  phone fail when it was turned: `4.7vmax` resolves against the longer edge, so it
  is ~40px on a 390×844 iPhone held *either* way — floored in portrait, unfloored
  in landscape, where the bar lands in `inside` placement and nothing caught it.
  The floor is on `#wcc-bar button` now, with the gap, the padding and the glyph
  floored alongside it so the bar does not close up around bigger targets.
  Landscape still floats the bar and can collapse it to a grip in `inside`; the
  dock never collapses and shortens the content instead. That difference IS
  geometry, and stays.

  **And the floor now bends, once.** Flooring every target made the bar longer than
  the axis it grows along in the case the floor was meant to help: a phone held
  sideways is ~390px of viewport height less browser chrome, against a seven-button
  `inside` column wanting 48px each plus gaps. Overrun, the last targets are off the
  screen — a 44pt button you cannot reach is worth less than a 36pt one you can. So
  the bar carries a shrink factor `--bs` that every dimension of it is a multiple of
  (target, gap, padding, glyph), and `fitBar(axis, available)` sets it to
  `available / extent` when the line is too long, floored at `0.6`. Because the bar
  is linear in `--bs`, one measurement finds the fit. It applies in **every**
  placement, dock included — the same rule both ways up, which is the whole point.
  `placeBar` fits along the grow axis *before* asking the band whether the bar fits
  across it, so a bar shrunk to clear a short viewport can earn a `right` float it
  would have been denied at full size, rather than being pushed onto the slide.

  The fit measures the **content**, not the box, and the dock is why: it spans the
  bottom edge (`left:0;right:0`), so its rect is the viewport width whatever is
  inside it — the buttons overflowed past the ends and were cut off by
  `overflow:hidden` while the test read a perfect fit. `barExtent` sums the visible
  children, the gaps between them and the bar's own padding, which is the length the
  line actually wants in a stretched placement and a content-sized one alike. On a
  narrow phone that is the difference between a working fit and a bar that silently
  loses its last button. The dock's budget is the viewport width less the horizontal
  safe-area insets; the floats already stand `edge` off both sides.
- **The controls had no accessible names.** Six glyph buttons, `icon()` renders an
  `aria-hidden` `<svg>` and nothing else, no `aria-label` anywhere in
  `player-core.js`. Labelled now, and play/pause and fullscreen relabel when they
  reglyph.
- **Live chrome is landscape-only** (`ensureLiveChrome`) — the largest gap in the
  list. On a match day a phone held portrait shows no ticker and no live strip at
  all; turned sideways, both appear. The band they live in is a property of the
  16:9 stage, so this is structural rather than an oversight, but it means the
  live feature currently has no phone surface. Sized and scheduled with the live
  work, not here.

  **Half-closed: the *control* now exists, the portrait *form* does not.** The bar
  carries a live button (`WccPlayer.setLiveToggle`, `syncLiveToggle` in
  `player.html`), because the wall's automatic latch is not a neutral default in a
  hand — its stickiness was written so an *unattended* screen would not reflow on an
  innings break, and taking `--live-band` of someone's slide for a ticker they did
  not ask for is that rule making a decision on their behalf. So the latch became
  the default and the press became the override, pinned for the session and never
  persisted. The button is withdrawn in portrait rather than shown doing nothing,
  and it is offered only once the feed has content, so it is not a dead control on
  the six days a week with no cricket on it — which matters on the bar the
  ~390px note below is about, since this makes it eight buttons.

  **What is left is the shape**, and the sketch to argue with is that portrait's
  live chrome should not be a band at all but an **overlay sheet** the same button
  raises over the column — ticker full-width above the dock, strip tiles above
  that — so nothing is permanently carved out of a step and `stage.chrome(h)` never
  has to negotiate with it. Note the strip is already a vertical tile column and so
  suits portrait better than it suits landscape; the ticker is the awkward one.
  Still live work, still not a portrait decision to take alone.

### Content (design, with one leak)

- **Fragment against band** is the intended split and is currently stark: in the
  pavilion deck the two cards are a phone layout and the eight photographs are
  postage stamps in a tall matte. That is phase 1's remaining work, not drift.
- **The `showcase-card` fragment silently drops `cta`**, at slide and section
  level, which the landscape template renders. The pavilion does not use it, so
  it is latent — but it is the failure mode a fragment has by construction, since
  a fragment is a *re-layout* that can quietly omit a field rather than a
  restyling that cannot. **A portrait fragment must account for every field its
  landscape template renders**, deliberately dropping what it drops (the QR is the
  worked example, and landscape-interactive already hides that behind links, so
  the two agree). Worth a build-time check once there are more than two fragments.
- **In-slide interactivity inverts.** Landscape blocks touch inside a slide unless
  it declares `data-taps`; portrait blocks bands identically, but a fragment is
  live DOM in the player's own document, so every link and button in it is always
  pressable. `showcase-card` agrees by luck — it declares taps. Any later fragment
  gets interactivity its landscape twin does not have.
- **A multi-panel slide cannot be a fragment yet** (`fragUrl` requires a
  single-step slide), so scorecards and carousels letterbox even once their
  template has a portrait layout. Stated in phase 1; repeated here because it is a
  reader-visible limit, not only an implementation one.

### Already one thing, and to be kept that way

Transport, panel timers, holds, atom pacing, video, windowing, and tap-to-toggle
with its centre-screen feedback are one implementation driven through the stage
seam. That is the part of the design working as intended: **the surfaces differ in
geometry and in nothing else by intent** — which is the sentence the divergent
verbs above break, and the reason they are worth fixing rather than documenting.

---

## What changes

**`scripts/build.py`** — *struck through = built.*
- Group a deck's atoms into phase-steps; ~~publish per-slide portrait fragments~~,
  and inline them into shareable deck pages as an optimisation.
- ~~Portrait fragments per template~~ (a Jinja template under `templates/portrait/`
  fed the same `slide` dict; `_portrait` rides in `slide_meta` into every deck's
  `data.json`), every atom carrying its anchor id.
- ~~Media collapse~~ — WITHDRAWN with the axis swap: a photo run is a run of
  steps and a reel is one step by the `/deck` rule, so there is nothing to collapse.
  A reel still wants its poster (phase 2).
- The longer-list mechanism for capped tables (phase 3).
- Optional `focus` on photo slides (phase 3 — wide interiors do not crop).
- Sponsors closing step (below, phase 4).

**`assets/js/player-core.js` + `assets/js/portrait.js`** — the split is settled
(open question 3). *Struck through = built in phase 0.*
- ~~`surface()` gains `portrait`~~; the overlay exception; ~~rotation swap in
  place~~ (not for bands — see phase 0).
- ~~A `portrait` placement for `placeBar`~~ — the dock, plus the `barDock` /
  `stage.chrome(h)` seam it reports its height back through, and ~~frameless items~~
  (an item whose stage renders it, so it has no iframe to load, post to or tear
  down).
- ~~Per-step scrollers~~ (owed to scrolling fragment steps, not to bands). The
  overscroll commit gesture that went with them is **deleted, not amended**: with
  horizontal as the step axis a scroller has no navigating to do. See "One axis
  navigates".
- ~~Assemble a deck from fragments~~ (any runtime deck, including `/deck`'s) — the
  column fetches each fragment near the reader, so any deck resolved at runtime is
  first-class without the build knowing it exists.
- The driven path: anchor traversal, auto-scroll, interruptible scroll-to-anchor.
- The reel poster → player overlay, with a driven mode alongside its user mode.
  (The media strip is withdrawn — see rule 2.)
- ~~Progress rail and share~~; the history sentinel that makes back mean previous
  step; history-backed overlays and the contents sheet when a deck earns them.
- ~~Windowing for fallback iframes~~ (`windowRadius` now follows the surface) and
  `<video>` only.

**`templates/`** — portrait fragments for ~~`showcase-card`~~, `photo` first; then
`video`, `sponsors`, `match-intro`, `scorecard`, `match-result`, `match-league`,
`fantasy-league`. Everything else takes the fallback until it doesn't.

**`docs/design-conventions.md`** — ~~portrait token scale, the scoped `px`
exception~~ (both written in), cards-vs-table, crop-to-fill.

**`assets/js/slide-bridge.js`** — reports swipes on both axes (`axis: 'x' | 'y'`).
Only `x` is acted on now (it is the step axis); `y` stays reported so a vertical
drag can be recognised in order to be ignored, and so the permissive variant of
rule 1 is a routing change rather than a bridge change. Inert on the wall and in
record mode, where `#wcc-tap` sits above the iframe and these events never
arrive.

**Not changed:** the wall. No `vw` layout, no base template, no `--fit` behaviour,
no `/screen/` path. No new URLs; no second catalogue; no extra precache entries.

### The sponsors closing step

Sponsors live in the wall chrome (`_base.html`'s footer strip, `_base-sidebar.html`'s
rail) and portrait has no room for either. Making them the closing step is right,
and it is reuse — there is already a `sponsors` template and slide.

> A portrait deck appends the sponsors step when its slides carry sponsor chrome; a
> deck of chrome-free templates (`photo`, `showcase-card`, `image`) does not.

Defaulted from the templates in the deck, overridable per slideshow. **The pavilion
deck must not get one** — local business logos in a document sent to a prospective
hirer read as a different document interrupting theirs, which is the reasoning in
`5b9268e` and still holds.

---

## Phasing

**Phase 0 — the letterbox fallback.** *(built)*

Taken first, ahead of the phase 1 below, because it is the whole of the surface
for every deck at once: `assets/js/portrait.js` plus a `stage` seam in
`player-core.js`. What it decided, which the rest now builds on:

- **The surface rule lives in `WccPlayer.surface()`**, as designed, built on
  `interactive` — which the same work redefined. **The route now decides whether a
  person is driving, and the URL overrides it**: `/screen/<loc>/` is hands-free,
  `/slideshow/<slug>/` is steerable, with `?interactive` and `?kiosk` as the two
  escape hatches. That removed the reason portrait had to *confer* interactive,
  and with it the older special case where `standalone` did the same — a URL we
  hand to a person no longer needs a query string to be the right experience,
  because none of them do. `standalone` is back to meaning only what it says.
  Baking the default into the template rather than the URL is what made this safe:
  a wall's URL lives in a file on the Pi (`~/.kiosk_url`) and is not ours to
  change, so the bare screen URL every wall already holds still means the wall.
  `?preview` sides with the wall on either route, as it always has.
- **The stage seam is the only difference between the two surfaces.** Transport,
  panel timers, atom pacing, holds, video, windowing and the reload all stay in
  `player-core.js`; the stage owns geometry and geometric input. A scroll to a
  step goes through `arrive()` exactly as a bar press does, so both directions
  reach a slide the same way and there is no second nav model.
- ~~**`scroll-snap-type: y mandatory` is right for a fallback step**~~ —
  **SUPERSEDED, and it was the phase's one real mistake.** The reasoning here was
  that the trap is a step *taller than the viewport* and a fallback step is one
  screen by construction, which is true and beside the point. The problem with
  snap was never stranding; it was that it makes the browser a third writer of a
  scroll position the transport is also writing.

  Everything this bullet went on to describe — *"if the step height changes, the
  column must be re-anchored on the step the PLAYER says it is on"*, the `pending`
  marking so the re-anchor is reported to nobody, the two conditions on when it may
  fire — was a correct patch on a broken premise. The tell is in its own wording:
  **"geometry is the thing that just became unreliable, so the transport's position
  is the authority."** That sentence is right, and the conclusion should have been
  to stop deriving position from geometry at all rather than to reconcile the two
  after the fact.

  It did not hold. On an iPhone the control bar could not move the column: the rail
  advanced and the deck sat still. See "One authority" for the model that replaced
  it, and for what the symptom was worth — a rotation on photo 1 no longer advances
  a slide either, because there is nothing left to re-anchor.
- **Windowing follows the surface, not the URL** (`windowRadius(params, surf)`).
  The old `?interactive` test silently missed a standalone deck — the pavilion,
  whose whole point is a link with no query string — and would have missed every
  portrait deck, on exactly the device the windowing exists to protect.
- **A step is what `/deck` gives one row to**, and that rule already existed:
  `childrenOf()` in `deck.js` — a package counts its members, a carousel its
  panels, and a reel counts as one however many clips it holds. The column applies
  the same derivation (`stepsFor` in `portrait.js`), verified to agree with
  `childrenOf` on every slide of every built deck, so a deck the editor sees as
  "4 steps" scrolls as four. **Step is one structural concept across the builder
  and the phone.**

  *Not* the wall's tab strip, which is coarser: a match package's strip reads
  `1st Innings` over what are three steps (highlights, batting, bowling). The
  strip groups steps into phases — which is the grouping the portrait *fragments*
  will want, and is why `step` and `phase` stay separate words here.

  So a carousel slide is one step per panel and its band is `position: sticky`
  across them: panels change under a pinned slide, and only crossing into another
  slide moves it. A reel is ONE step whatever its clip count — the doc's rejection
  of the vertical-feed reading, enforced here.

  Getting this wrong is what the first cut did, and it mattered more than it
  looked: `teams`, `leaderboards`, `honours`, `fantasy-league` and every `team-*`
  and `leaderboard-*` deck are SINGLE-slide decks, so a step-per-slide column gave
  a phone visitor one screen that would not scroll with five of its six panels
  behind a timer. Step-per-step turns `teams` into 89 positions and
  `fantasy-league` into 4, while `last-match-1st-xi` stays at 9 because its reels
  are one step each.

  Phase grouping remains a property of the portrait *fragments*, which collapse a
  run of atoms into one scrolling step. Both readings satisfy "every atom appears
  exactly once, in order".
- **The surface follows the shape of the screen, live, in both directions.**
  Decided at boot from the aspect and re-decided whenever it crosses 1: a deck
  opened in landscape and turned portrait moves onto the column, and a deck on the
  column turned landscape goes back to the 16:9 presentation with the controls in
  the right-hand band — no page reload either way, same player, same items, same
  slide, same controls (`WccPlayer.setStage`). What the route change above bought
  is exactly this: a deck page is interactive on both stages, so the swap no
  longer has to reconstitute the control bar, the windowing and the slides' own
  interactive variant, which is what forced a reload in the first draft.

  **Two-way is a correction.** The first cut ratcheted one way, arguing that the
  column reads acceptably in landscape (the band grows to fill the viewport) so
  going back would spend a viewer's clip position to fix nothing, and that a
  surface which only ratchets cannot thrash at the boundary. What that misses is
  that a deck is *authored* for 16:9 — a landscape screen showing a portrait
  column is a screen showing the wrong thing, and a rotation is the clearest
  instruction a phone can give about the shape it now is. The column is what a
  portrait screen wants, not a preference the viewer expressed. Thrash is handled
  by debouncing the crossing (400ms), which is what it was always for.

  Going back makes the swap symmetrical, and symmetry is what the seam had been
  missing. Three things move, and each is somebody's property: **frames** (a stage
  that renders a slide itself wants none, the stack wants one for every slide — so
  a frameless item gets its document back from `opts.newFrame`, cold, and the
  arrival's own windowing decides whether to load it); **the outgoing stage's
  chrome**, which only it knows about, so it is asked to `detach()` — column, rail,
  share button, body class, custom properties, listeners; and **the gesture
  layer**, which is the player's and follows the stage. The stack is a stage here
  too, even though it is not an object: the only thing the seam needs is where a
  frame goes, and for the stack that is one element (`opts.slideHost`) for all of
  them.

  The residual cost is one iframe: a frame moved in the DOM reloads its document,
  so the slide on screen and its two windowed neighbours come back fresh and a
  clip loses its position. That has not changed; what has is that it can be paid
  twice. It is also the closest this form of the surface gets to "rotation swaps
  in place, no reload" — the rest of that promise is owed to the portrait
  fragments, where a step is our own DOM and nothing reloads at all.

  **How long the wrong surface is on screen**, which is a separate question from
  whether the swap works, and was the first thing anyone noticed. Three windows,
  and only two of them are ours:

  1. *The debounce.* A rotation and a dragged window are not the same event, and
     treating them as one is what made the swap feel slow. A drag fires a stream of
     resizes and must be debounced or the deck swaps — and reloads its frames — at
     every step across the boundary. A rotation is ONE discrete instruction,
     already committed to by the person holding the phone. So `orientationchange`
     opens a short window (1.2s) in which any resize is acted on immediately, with a
     150ms backstop in case none arrives; the 400ms debounce survives for the drag
     it was written for. The surface now changes about a frame after the viewport
     settles rather than 400ms after it.
  2. *The flip itself.* Unavoidable: iOS updates `innerWidth`/`innerHeight` **after**
     `orientationchange` fires, not with it, so there is always a moment where the
     old surface is laid out in the new shape. It cannot be removed, only covered.
  3. *The reload.* A frame moved in the DOM reloads its document, so the slide on
     screen comes back blank and paints again. Structural, and the reason it gets
     cheaper as templates gain portrait fragments: a fragment is our own DOM and its
     markup comes back from cache, where an iframe boots a document.

  (2) and (3) are covered by **the veil** — a plain matte sheet raised over
  everything from the moment `orientationchange` fires until shortly after the swap.
  It turns "the wrong thing, then a white flash" into a beat of the background the
  deck already sits on, which is what a rotation looks like in any app. It comes
  down on a short fixed timer rather than on the frames' load events: it is covering
  a repaint, and a deck must never be able to sit behind a sheet waiting for a
  document that is slow or never arrives.

  One consequence worth naming: **the live chrome is a property of the landscape
  stage**, so a deck that opens in portrait builds none of it and builds it if the
  phone is turned (`ensureLiveChrome`, and `WccPlayer.setFlashFrame` for the
  overlay the player raises). The ticker and strip live in a band a retracting
  16:9 slide layer uncovers, and the column has no such band.
- **No tap layer, and tap-through comes free** — *half revised; see "One
  authority". The tap layer is still absent, but bands are now
  `pointer-events: none`, because tap-through cost the column the GESTURE.* The player's `#wcc-tap` is a
  fixed full-viewport overlay, which over a scroller swallows the scroll. Without
  it a tap on the slide stays in the slide — so a slide's own links work with no
  `data-taps` machinery — and a tap on the matte toggles transport. An overlay
  confined to the band would have cost the links *and*, being a non-`auto`
  touch-action, WebKit's pinch-zoom with it.
- ~~**Two axes, and the second one earns its place.**~~ — **SUPERSEDED by the axis
  swap.** Phase 0 made VERTICAL the step axis and HORIZONTAL the atom move inside a
  step, and defended the pairing on a reel: swipe down to leave it, sideways to walk
  its clips. What that reading cost is set out under "One axis navigates" — one axis
  doing two jobs, and `armCommit` to disambiguate it. **Horizontal is the step axis
  now, and vertical only reads.** The reel keeps the good half of the pairing: it is
  still one step, and its clips are walked inside its player rather than on the
  deck's axis.

  Reported by `slide-bridge.js` rather than read off a gesture layer, since
  portrait deliberately has none (above). No flag distinguishes the surfaces —
  in landscape and record mode `#wcc-tap` sits above the iframe and these events
  never arrive, so the geometry does it. **Both axes are reported now**: with the
  deck no longer a scroller there is no parent for a band's vertical drag to chain
  into, so the slide is the only place it can be seen at all. Thresholds are fractions of the viewport,
  never px: a slide lays out in the fixed 1920x1080 box, where 45px is about 9
  real ones. A gesture starting in the edge strip is declined so that iOS's
  unpreventable edge-back-swipe does one thing rather than two.

  The note that used to close this bullet — "this does not contradict the rejection
  of horizontal-as-step-axis below" — is void: that rejection is itself reversed.
- **No live chrome.** The ticker and strip live in the L a retracting 16:9 slide
  layer uncovers, and there is no such band here.
- **Chrome is the progress rail and share**, and nothing else, as designed.

Deliberately *not* done here, and still open below: portrait fragments and their
token scale, phase grouping, overlays, longer lists.

~~**Untested on a device, and it matters:** whether a *vertical* drag starting on
the band scrolls the column.~~ **Settled, and then made moot.** Chaining from the
band's iframe to the parent scroller did work on iOS — and then the parent scroller
was removed, so a band's vertical drag is reported explicitly by `slide-bridge.js`
as `axis: 'y'` instead. The feared fix (an overlay confined to the band, costing
the slide's own links and pinch-zoom) was never needed in either world.

**Phase 1 — the first portrait fragments, targeting the pavilion.** *(partly built:
the cards are done, the photographs are not)*

Built:
- ~~The portrait token scale and the shared portrait stylesheet~~ —
  `assets/css/portrait.css`, one file, every rule scoped under `.pfrag-<template>`.
  That scoping is not tidiness: a fragment is real DOM in the *player's* document,
  alongside every other fragment, and the slide templates it is derived from all
  reuse `.panel`, `.row`, `.title`. The `px`-floored scale is written into
  `docs/design-conventions.md` as the one scoped exception to the zoom rule.
- ~~Per-slide fragments as the canonical artefact + client-side assembly~~ —
  `build.py` writes `/slide/<slug>/portrait.html` for any slide whose template has
  one and flags `_portrait` through `slide_meta` into every deck's `data.json`; the
  column fetches them near the reader (radius 2) and inserts them as DOM. No
  iframe, so an off-screen step is not a render surface. *Inlining into the
  pavilion page is NOT done* — it is the optimisation the doc always said it was
  (first paint with no round trip), and the canonical path had to come first.
- ~~Per-step scrollers~~ — a fragment step is one scrollport in the column and
  scrolls *inside* itself, with `overscroll-behavior: contain` so a pull at the end
  bounces rather than becoming the browser's. The overscroll COMMIT gesture that
  shared this bullet is gone: it was the cost of vertical doing two jobs, and the
  axis swap removed the second one. A thumb still cannot leave a step by scrolling
  — it is no longer supposed to.
- ~~A portrait fragment for `showcase-card`~~ — the pavilion's opening title card
  and its closing hire/credit card. Two things differ from the wall's interactive
  variant, both by design: **no QR code** (a QR passes a URL to someone standing in
  front of a television; this reader is holding the phone it exists to reach, so
  the links are unconditional), and the brand lockup is centred at the top rather
  than in the corner the share button floats in.
- ~~Chrome: progress rail and share~~ (phase 0), **re-placed around the dock.** Both
  the rail and the bar used to float over a letterboxed slide, where floating costs
  nothing; a fragment step is full-bleed, and over full-bleed content a float is
  something to read around. So: the control bar is now the `portrait` DOCK described
  under Chrome above (the column ends where it begins), the share button moved into
  it, and the **rail moved to the top edge** — the opposite edge deliberately, since
  the bar carries its own gold fill along its top and that is the countdown within
  one step. Two gold hairlines a few pixels apart, measuring different things, read
  as one confused instrument. Fragments therefore reserve nothing for chrome:
  `--pf-top` / `--pf-bottom` are the card's own margin from the edges of its step.
- **A frameless item**, in `player-core`. A fragment step has no iframe, so its
  item has no frame: no url, never live, commands dropped, counted as loaded, and
  its panel count seeded from the atoms the deck was built with instead of a bridge
  handshake. It is not a special case in the transport — every timer, hold and nav
  move works on it unchanged — and `setStage` tears an existing frame down when a
  rotation hands a slide to a stage that renders it itself.

Still open in this phase:
- **The axis swap** — horizontal as the step axis (see "One axis navigates"), which
  deletes `armCommit`, turns the track's travel onto X, and makes the history
  sentinel the answer to the edge swipe.
- Portrait fragment for `photo`. **Until it lands the pavilion's photographs are
  eight letterboxed steps** — which is the phase-0 behaviour, is exactly the point
  of having taken the fallback first, and is now also the right STRUCTURE: eight
  steps is what the swap says they should be, so only their rendering is missing.
- Inlining the fragments into the pavilion's own page (first paint).

A limit worth knowing, enforced in `fragUrl`: **a fragment serves a single-step
slide only.** A slide the column gives several steps to (a carousel, one per panel)
keeps its band until fragments carry an addressable step per atom. Both showcase
cards are one atom; the multi-panel templates are phases 3 and 4 anyway. Stated as
a condition rather than left implicit because the failure it prevents is silent — a
multi-panel fragment would swallow every panel after the first.

Structural, and **not deferrable** even though the transport ships in phase 5 —
these cost little now and are a rewrite later:
- Per-slide fragments as the canonical artefact, so a runtime deck is first-class.
- Atom positions with stable ids, addressable as a step or as a scroll offset
  within one.

**Explicitly not in phase 1** — all deferred as speculative until a deck needs
them: any overlay at all (the pavilion needs no "view larger", since on an iPhone it
opens the photograph at the width it already had); the sticky title; the contents
sheet; the `focus` crop field, which wide interiors do not use. The history
machinery is no longer on this list: the axis swap gives it a job before any overlay
does.

Ship criterion: **the Seabrook Pavilion deck is a first-class phone experience end
to end — a title card, eight photographs and a credit card, swiped through — and no
other deck or the wall has regressed.** Decks without portrait fragments keep today's behaviour untouched.

**Phase 2 — the reel, and the letterbox fallback.** Poster frame → full-screen
player running the whole innings reel in order with narrative captions, card
overlays and the existing clip-by-clip nav; close returns to scroll position (and
brings the first overlay, so history/back lands here). Native video fullscreen
handles landscape. Inline driven playback for play mode. The letterbox fallback
arrived in phase 0 instead, which is why nothing here is all-or-nothing.

**Phase 3 — the match package.** `match-intro`, `scorecard`, `match-result`,
`match-league` portrait fragments; the cards-vs-table rules; the longer-list
mechanism.

**Phase 4 — `fantasy-league`**, `sponsors` closing step, and the remaining data
templates.

**Phase 5 — play mode.** The transport itself: anchor traversal on a clock,
auto-scroll between anchors, `/deck` playing a portrait experience, and a
continuous narration take driving it by cue points. The structure it needs lands
in phase 1; this is the driver on top.

---

## Open questions

1. **Does the Last Match opening step lead with the result?** The wall package is
   built deliberately *spoiler-safe* (the build's own word) with Result at 8 of 9.
   On a phone that is unenforceable — there is a contents sheet and a scrollbar —
   and the first screen is also the WhatsApp preview. Most people opening "last
   match" want the score immediately and the innings as *how it happened*. A change
   of authorial intent, not a technical one. **Unresolved — James's call.**
2. **Does the match intro split** into Last Match / Pre-match (two steps), or stay
   one scrolling step? Try one first; allow an explicit override.
3. ~~**Where does the portrait JS live**~~ — **settled: a separate
   `assets/js/portrait.js`**, with `surface()` staying the single arbiter in
   `player-core`, which is where the lean already was. The seam turned out to be
   narrower than expected: a `stage` object with `show(i)` and `attach(transport)`.
   Everything geometric is on one side of it and everything about *playing a deck*
   on the other, which is the line the fragments should keep to as well.
4. **Does `/deck` need to know?** An editor building for a phone audience might
   want to see which steps have a real portrait layout and which will letterbox.
   Later nicety, but a reason for `slides.json` to carry a per-template `portrait`
   flag.
5. **The longer-list mechanism** for capped tables — extra rows emitted and hidden
   on the wall, or a second capped list in the payload? Must be provably
   wall-neutral.
6. **Page-weight ceiling.** Inlining portrait markup into the deck page is fine for
   3 steps and untested for 38. Measure on the match package before phase 3 and
   fall back to fragment-fetching if it is bad.
7. **Portrait dwell times.** The wall's atom dwell comes from `panel_duration`. A
   portrait atom's dwell must also cover *scrolling to it*, and a batting card with
   25 rows on a phone plausibly wants longer than the 12-row wall version. Is
   portrait dwell the wall's dwell, derived from content height, or authored
   separately? Affects play mode and the narration timeline, not phase 1.
8. **Tap semantics in play mode.** On the wall a tap toggles transport. In portrait
   interactive a tap opens media. A driven portrait deck needs one rule for both —
   probably transport wins while playing, since driven media is ungated and has
   nothing to open.

---

## Rejected, with reasons

Recorded so they are not relitigated from scratch.

- **CSS `scroll-snap` for the whole deck** — `mandatory` strands readers in
  taller-than-viewport sections; `proximity` runs through the seam; neither gives
  bounce-then-commit. **And a second reason, found on a phone and worth more than
  the first:** snap makes the browser a third agent writing a scroll position the
  transport is also writing. See "One authority".
- ~~**A hand-built transform step-stack**~~ — **this rejection was wrong, and is
  reversed.** Its stated reason was that a step-stack "reproduces in JS what
  per-step native scrollers give free". That is true of the *interior* of a step,
  which is why the interior is still a native scroller and always will be — but it
  was never true of the seam BETWEEN steps, which gives nothing free and costs a
  derived position that three agents fight over. The deck is a transformed track
  now; only the deck. See "One authority" for what it fixed.
- **Deriving the deck's position from `scrollTop`** — the actual mistake behind
  both of the above. A position the platform can change without being asked (iOS
  resizes the viewport when its chrome collapses) cannot be the authority for where
  a deck is.
- **Fixed 1080×1920 design box scaled by `--fit`** — leaves ~18% of a modern phone
  screen empty, and portrait aspects span too wide a range for any one box.
- **Step = atom** — a step stacks what the wall had to paginate, so a scorecard's
  batting and bowling are one step and not two. Thirty clips would have been thirty
  steps; a reel is one, by the `/deck` rule.
- **Thirty clips as a vertical feed** — works for independent full-screen portrait
  video; ours are uncroppable 16:9 with baked graphics inside an authored sequence.
  Still rejected, and note what it does NOT reject: the objection is to the feed, not
  to sideways paging. A reel remains one step whose clips are walked inside its
  player.
- ~~**A photo set as a run of steps**~~ — **reversed.** It was rejected as the
  vertical-feed reading of a photo run, and became right the moment the deck paged
  sideways: eight full-bleed photographs swiped left is a photo album, which is the
  idiom the media strip was reconstructing inside a step at the cost of a second
  addressing scheme. See rule 2.
- **A media strip inside one step** — one step holding N media atoms needs its own
  index, its own driven mode and its own case in play-mode anchor traversal, to
  produce the gesture the deck already performs. Withdrawn unbuilt with the axis
  swap.
- **Tap-to-play gating the photographs** — on iPhone the "fullscreen" it opens is
  the same width as the photograph already had, so the tap buys nothing.
- **Photo set as a scroll of thumbnails** — destroys the authored order and the
  full-frame reading of each photograph; turns a showcase into a property listing.
- ~~**Horizontal swipe as the step axis**~~ — **reversed; it is the step axis
  now.** The stated reason was iOS Safari's edge back-swipe carrying a reader out of
  a forwarded link, which is real and is answered three ways under rule 1: only the
  LEFT edge is back (so *next* never collides), `armDeck` already declines the outer
  5%, and a history sentinel makes back MEAN previous step. The third answer did not
  exist when the rejection was written — "Back closes overlays" was still speculative
  phase-3 work. What actually decided it was not the mitigation but the cost of the
  alternative: vertical doing both jobs bought `armCommit`, the arming rule and two
  thresholds, and put the deck's travel on the one dimension iOS rewrites on its own.
- **Persistent tab strip in portrait** — standing viewport cost for a jump most
  viewers will not make, and it does not generalise past one slide. Contents sheet
  instead.
- **A `/p/` URL for the portrait document** — breaks links already sent, loses the
  OG tags' canonical URL, and makes rotation a reload. Kept in reserve for the
  page-weight question above.

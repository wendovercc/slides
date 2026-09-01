# Portrait Decks — the phone surface

> Status: **the letterbox fallback is built and shipped, and the first portrait
> fragments with it.** Every deck has a phone surface — a column of full-height
> steps that snap — and a step is now rendered one of two ways: a real portrait
> layout where its template has one (`templates/portrait/<template>.html`,
> published per slide, fetched and inserted as DOM), or its 16:9 self in a band
> where it does not. `showcase-card` is the first template with a fragment, which
> makes the pavilion deck's opening and closing cards a real phone layout with
> eight letterboxed photographs between them. The model below is settled through
> three worked examples; the open questions at the end are genuinely open.
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

Three rules cover every deck:

> 1. **Vertical is always forward.** A step scrolls if it has an interior; the
>    seam between steps always snaps.
> 2. **Media swipes sideways.** Photo sets and video reels are a horizontal axis
>    inside a step, never a run of steps.
> 3. **A step is a phase**, which already exists in the data.

Everything below is consequence.

### 1. Scroll within, snap between

The wall paginates because it has no vertical axis: the only way it can show
Batting *then* Bowling is over time. The phone has scroll, so it stacks them.

- A step is **its own scroll container**. Interior scrolling is entirely native —
  momentum, rubber-band, scrollbars, accessibility — and `overscroll-behavior:
  contain` gives the bounce at the end for free.
- **Forgiving commit** (decided): you scroll to the bottom of a step, it bounces,
  and a further strong swipe up snaps to the next step, which settles at its top.
  You never see the tail of one step sharing a screen with the head of the next.
- The only thing we write is that commit gesture. Everything else is the platform.

**Steps may be much longer than a screen, and that is a feature.** The wall lists
`top_rows: 12` fantasy players because that is what reads at ten feet. The phone
can list 25 and be *better*. See "The phone wants more content".

*Why not `scroll-snap`:* `mandatory` snap on sections taller than the viewport is
trappy — it can strand a reader mid-section. `proximity` lets the scroll run
smoothly *through* the seam, which is the thing we are avoiding. Neither gives the
bounce-then-commit feel. Per-step scrollers plus one gesture does.

### 2. Media is a sideways axis

A reel of thirty clips is **not** thirty steps. The vertical-feed idiom (Reels,
TikTok) works because each item is an independent full-screen *portrait* video.
Ours are 16:9 bands with Frogbox graphics baked into the frame and our own
overlays positioned as percentages of it (`--reel-narr-bottom: 9.83%`, the reel
tag, the `pre`/`post` cards) — they cannot be cropped to portrait, and a reel is an
authored sequence with its own running order and its own time. That is what a
player is for.

The same applies to a photo set: eight wide interior shots are one browsable thing,
not eight screens.

**Video and photos differ in one respect only — whether a poster frame gates them:**

| | Gate (interactive) | Why |
|---|---|---|
| **Video reel** | Poster frame → tap → native player | A clip costs bandwidth and 30s of commitment; a poster is a fair ask. And inside a *scrolling* step nothing has focus, so autoplay is meaningless. |
| **Photo set** | None — swipe in place | Already loaded, instant, costs nothing to look at. Gating it puts a tap in front of the only thing the deck exists to show. |

**The gate is an interactive-mode affordance only.** In play mode (below) the
driver confers focus, so there is nothing for a gate to resolve: the reel plays
*inline in its band* and the photo strip advances sideways on its own. Same
principle applied in both directions — a poster exists because free scrolling has
no focus, and disappears when something else supplies it. Every media component
therefore needs **a driven mode and a user mode from the start**; this is designed
in, not bolted on.

This asymmetry is forced by the platform, not chosen:

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

**Grouping is two rules, applied in order**, and the pavilion needs both:

1. **Group consecutive atoms by phase.**
2. **Collapse a consecutive run of media atoms into one strip** — a photo run, or
   a reel's clips.

The pavilion's slides carry no phase, so rule 1 leaves ten steps; rule 2 collapses
the eight photographs into one strip, giving **three steps: Title · Photographs ·
Credit**. In the match package rule 1 does the work and rule 2 turns each innings'
clips into its poster.

**The invariant that replaces "step = atom":**

> **Every atom appears exactly once, in order.** The phone paginates coarser and
> the wall's atoms become sections inside a step.

This is what keeps the narration seam alive (below) and stops the phone becoming a
second nav model that has to be kept in sync with the first.

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
pushes a history entry so back dismisses it** rather than leaving the deck. Insetting
the in-flow media strip slightly from the screen edges also keeps a stray edge-swipe
out of it.

This is also why horizontal is **not** the step axis: an edge swipe would carry a
reader out of a forwarded link entirely.

---

## Chrome

Deliberately almost none. The content is the interface — and **chrome is earned
per deck, not built up front**. A three-step deck does not need a contents sheet,
and a one-screen step does not need a sticky title. Build each when a deck makes
it necessary.

- **No persistent tab strip**, ever. It costs viewport on every step to serve a
  jump most viewers will not make, and only helps *within* one slide — a 30-step
  match deck wants an index just as much and would not get one.
- **A thin progress rail** — where you are in the deck. *(Phase 1: earned by any
  deck.)*
- **Share.** A deck whose distribution model is being forwarded currently has no
  forward button. `navigator.share()` with the canonical URL `_og.html` already
  bakes. Small, and it changes what the feature is for. *(Phase 1 — the pavilion
  is exactly the deck this exists for.)*
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
rotation or a safe-area change stays right. The share button moved into the dock
with it — beside the transport, where a phone app puts it, and where it costs no
content. It floated in the top-left corner while the bar was a pill over a
letterboxed slide; that is a corner a full-bleed layout wants back.

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

A position is reached on whichever axis its step uses — **vertical scroll for a
section, strip index for a media atom**. That matters: the pavilion's eight
photographs are eight atoms inside *one* step, so play mode advances the strip
sideways there and scrolls elsewhere. An implementation that assumes "anchor =
scrollIntoView" will silently skip every photograph and every clip.

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

## What changes

**`scripts/build.py`** — *struck through = built.*
- Group a deck's atoms into phase-steps; ~~publish per-slide portrait fragments~~,
  and inline them into shareable deck pages as an optimisation.
- ~~Portrait fragments per template~~ (a Jinja template under `templates/portrait/`
  fed the same `slide` dict; `_portrait` rides in `slide_meta` into every deck's
  `data.json`), every atom carrying its anchor id.
- Media collapse: consecutive photo slides → one strip; a reel → one poster.
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
- ~~Per-step scrollers + the overscroll commit gesture~~ (owed to scrolling
  fragment steps, not to bands).
- ~~Assemble a deck from fragments~~ (any runtime deck, including `/deck`'s) — the
  column fetches each fragment near the reader, so any deck resolved at runtime is
  first-class without the build knowing it exists.
- The driven path: anchor traversal, auto-scroll, interruptible scroll-to-anchor.
- Media strip (horizontal swipe) and the reel poster → player overlay, each with
  a driven mode alongside its user mode.
- ~~Progress rail and share~~; history-backed overlays and the contents sheet
  when a deck earns them.
- ~~Windowing for fallback iframes~~ (`windowRadius` now follows the surface) and
  `<video>` only.

**`templates/`** — portrait fragments for ~~`showcase-card`~~, `photo` first; then
`video`, `sponsors`, `match-intro`, `scorecard`, `match-result`, `match-league`,
`fantasy-league`. Everything else takes the fallback until it doesn't.

**`docs/design-conventions.md`** — ~~portrait token scale, the scoped `px`
exception~~ (both written in), cards-vs-table, crop-to-fill.

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
- **`scroll-snap-type: y mandatory` is right for a fallback step** and does not
  contradict the rejection above: the trap is a step *taller than the viewport*,
  and a fallback step is one screen by construction. The bounce-then-commit
  gesture is owed to the scrolling steps that portrait fragments bring, not to
  this. A step is `height: 100%` of the scrollport rather than `100dvh`, so
  `scrollTop / stepHeight` cannot round to the wrong step while iOS's chrome
  collapses.

  **The corollary bit us and is worth stating as a rule: if the step height
  changes, the column must be re-anchored on the step the PLAYER says it is on.**
  `scrollTop` does not change when the height does, so the ratio silently
  re-points at a different step; mandatory snap then slides the column to it,
  which fires a scroll, which `settle` reports to the transport as a navigation.
  Rotating a phone on photo 1 advanced the deck a slide — and not in the stage
  swap, which had not run yet: the resize handler had already moved the column
  (390→844 is a 2.5× change in step height, so `scrollTop` 844 stops meaning
  "step 1" and starts meaning "step 3"). Geometry is the thing that just became
  unreliable, so the transport's position is the authority, and the re-anchoring
  scroll is marked `pending` so it is reported to nobody. Two conditions on it:
  never while the READER is scrolling (iOS resizes when its own chrome collapses,
  mid-scroll, and yanking a moving column is worse than letting it settle
  honestly), and our own scrolls do not count as the reader scrolling — iOS fires
  `resize` more than once through a rotation, and the second one would otherwise
  see our own re-anchor as activity and decline.
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
- **No tap layer, and tap-through comes free.** The player's `#wcc-tap` is a
  fixed full-viewport overlay, which over a scroller swallows the scroll. Without
  it a tap on the slide stays in the slide — so a slide's own links work with no
  `data-taps` machinery — and a tap on the matte toggles transport. An overlay
  confined to the band would have cost the links *and*, being a non-`auto`
  touch-action, WebKit's pinch-zoom with it.
- **Two axes, and the second one earns its place.** VERTICAL is the step axis;
  HORIZONTAL is the axis *inside* a step, and means what it means on the landscape
  player — `next()`/`prev()`, the atom move. The pairing pays off on a reel, which
  is one step by the `/deck` rule: scrolling down leaves the reel entirely, which
  nothing could do before, while swiping steps through its clips.

  Reported by `slide-bridge.js` rather than read off a gesture layer, since
  portrait deliberately has none (above). No flag distinguishes the surfaces —
  in landscape and record mode `#wcc-tap` sits above the iframe and these events
  never arrive, so the geometry does it. Thresholds are fractions of the viewport,
  never px: a slide lays out in the fixed 1920x1080 box, where 45px is about 9
  real ones. A gesture starting in the edge strip is declined so that iOS's
  unpreventable edge-back-swipe does one thing rather than two.

  This does **not** contradict the rejection of horizontal-as-step-axis below: the
  step axis is still vertical, and a swipe that reaches the end of a slide's atoms
  crosses to the next slide exactly as the control bar does.
- **No live chrome.** The ticker and strip live in the L a retracting 16:9 slide
  layer uncovers, and there is no such band here.
- **Chrome is the progress rail and share**, and nothing else, as designed.

Deliberately *not* done here, and still open below: portrait fragments and their
token scale, phase grouping, the media strip, overlays, longer lists.

**Untested on a device, and it matters:** whether a *vertical* drag starting on
the band scrolls the column. The band is an iframe, so that depends on touch
scroll chaining from a non-scrollable child document to the parent scroller.
Modern iOS should do it, but if it does not, dragging on the slide feels dead and
only the matte scrolls — which would also undermine the swipe work above, since
that assumes the slide stays exposed to touch. Check this first on a phone. The
fix, if needed, is an overlay confined to the band, and it is not free: it costs
the slide's own links and, at any non-`auto` touch-action, pinch-zoom.

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
- ~~Per-step scrollers and the overscroll commit gesture~~ — a fragment step is one
  scrollport in the column and scrolls *inside* itself, which is what lets uniform
  step heights (and therefore `scrollTop / stepHeight`, and therefore mandatory
  snap) survive contact with a step that is three screens long. The gesture is owed
  entirely to `overscroll-behavior: contain`: it gives the bounce for free and, by
  the same token, means a thumb can never leave the step on its own.
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
- Portrait fragment for `photo`, and the media strip (horizontal swipe, inset from
  the screen edges) that collapses the eight photographs into one. **Until that
  lands the pavilion's photographs are eight letterboxed steps**, which is the
  phase-0 behaviour and is exactly the point of having taken the fallback first.
- Inlining the fragments into the pavilion's own page (first paint).
- A driven mode alongside the user mode on the photo strip.

A limit worth knowing, enforced in `fragUrl`: **a fragment serves a single-step
slide only.** A slide the column gives several steps to (a carousel, one per panel)
keeps its band until fragments carry an addressable step per atom. Both showcase
cards are one atom; the multi-panel templates are phases 3 and 4 anyway. Stated as
a condition rather than left implicit because the failure it prevents is silent — a
multi-panel fragment would swallow every panel after the first.

Structural, and **not deferrable** even though the transport ships in phase 5 —
these cost little now and are a rewrite later:
- Per-slide fragments as the canonical artefact, so a runtime deck is first-class.
- Atom positions with stable ids, addressable on *both* axes.
- A driven mode alongside the user mode on the photo strip.

**Explicitly not in phase 1** — all deferred as speculative until a deck needs
them: any overlay at all (so no history/back machinery either — the pavilion needs no "view larger", since on an
iPhone it opens the photograph at the width it already had); the sticky title; the
contents sheet; the `focus` crop field, which wide interiors do not use.

Ship criterion: **the Seabrook Pavilion deck is a first-class phone experience end
to end — Title · Photographs · Credit — and no other deck or the wall has
regressed.** Decks without portrait fragments keep today's behaviour untouched.

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
  bounce-then-commit.
- **A hand-built transform step-stack** (the first draft's mechanism) — reproduces
  in JS what per-step native scrollers give free, and was only proposed because
  iframes made native scrolling hard. Dropping iframes removed the reason.
- **Fixed 1080×1920 design box scaled by `--fit`** — leaves ~18% of a modern phone
  screen empty, and portrait aspects span too wide a range for any one box.
- **Step = atom** — the phone has a vertical axis and should stack what the wall
  had to paginate. Thirty clips would have been thirty steps.
- **Thirty clips as a vertical feed** — works for independent full-screen portrait
  video; ours are uncroppable 16:9 with baked graphics inside an authored
  sequence.
- **Tap-to-play gating the photographs** — on iPhone the "fullscreen" it opens is
  the same width as the in-flow strip, so the tap buys nothing.
- **Photo set as a scroll of thumbnails** — destroys the authored order and the
  full-frame reading of each photograph; turns a showcase into a property listing.
- **Horizontal swipe as the step axis** — collides with iOS Safari's edge
  back-swipe, which would carry a reader out of a forwarded link.
- **Persistent tab strip in portrait** — standing viewport cost for a jump most
  viewers will not make, and it does not generalise past one slide. Contents sheet
  instead.
- **A `/p/` URL for the portrait document** — breaks links already sent, loses the
  OG tags' canonical URL, and makes rotation a reload. Kept in reserve for the
  page-weight question above.

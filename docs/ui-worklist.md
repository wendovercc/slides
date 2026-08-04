# UI Consolidation Worklist

Running list from the design/consistency pass. Nothing here is settled — this is
the inventory we build the conventions from. Once a convention lands it moves to
`design-conventions.md` and the item is struck off here.

Status key: **[ ]** open · **[x]** done · **[?]** needs a decision · **[~]** side
note / later redesign, not this pass.

---

## A. Zoom invariance

The rule we're testing against: changing browser zoom on a slide should produce
**zero** visible change. A slide is zoom-invariant when every value that
contributes to *layout* is viewport-relative (`vw`/`vh`) or font-relative (`em`
on a `vw`-sized element).

### The single root cause

Every drift observed so far is a **`px` value that contributes to layout height**
inside a `vh`-based flex/grid stack. Under zoom the CSS viewport shrinks, so `vw`
and `vh` boxes hold their apparent size while `px` boxes grow — and any `px` that
occupies box-model space shoves its siblings.

This splits the `px` in the codebase cleanly in two:

| | Contributes to layout? | Verdict |
|---|---|---|
| `border` (in-flow), `height` on a spacer/rule, `padding` | **Yes** — moves siblings | Must convert |
| `border-radius`, `text-shadow`, `box-shadow`, `outline` | No — paints inside an existing box | Also converted (A6 decision) |

Both are now converted: the rule is a flat **no px in slides**.

### Done — converted 2026-08-04

The whole A section below was fixed in one pass: token scale added to
`_base.html` / `_base-sidebar.html` (and copied into the standalone `video.html`
/ `image.html`), then every `px` in `templates/slides/` converted. Verified:
`grep -rE '[0-9.]+px' site/slides` returns **nothing** — the built output has no
absolute units at all. Rule is now written up in `design-conventions.md`.

- **[x] A1 — Panel-tab accent underlines pushed content vertically.**
  `height: 2px` → `var(--rule)`, in all six copies (`_set_header_styles`,
  `honours`, `fantasy-league`, `leaderboard`, `team`, `live-match`).
  The six-way duplication itself is still open — see D1.

- **[x] A2 — Table row borders pushed content.** All `1px solid` →
  `var(--hair) solid`. This was the worst offender because the error
  accumulated down each table.

- **[x] A3 — Last-match top-right location badge drifted down.**
  Cause confirmed and fixed: the `1px` border on `.set-meta .home-pill` /
  `.away-pill` grew the `.meta-row` height and pushed `.loc-badge` down the
  flex column.

- **[x] A5 — `image.html` absolute typography.** `font-size: 3rem` →
  `var(--t-lg)`. Also brought on-brand while there: `--bg` token instead of raw
  hex, Lato instead of Arial. Still standalone (it has no footer/sidebar
  chrome), but now carries a matching token block.

- **[x] A6 — Cosmetic px.** Decision (2026-08-04): **convert everything, no
  exception** — a flat "no px" rule is easier to hold than a sanctioned carve-out.
  All radii → `--radius` / `--radius-sm`; the 10 identical title shadows →
  `--title-shadow`.
  *Note:* radii were consolidated from four values (2/3/4/5px) to two tokens, so
  `today.html`'s badge (was 5px) and `league-positions`' crest bits (were 2px)
  shift very slightly. Intentional — worth a glance.

### Still open

- **[ ] A4 — Last-match-result: gap between score and result/points badge grows.**
  Was suspected to be the same in-flow-border family, so the A2/A3 conversion may
  well have fixed it. **Needs a re-check at zoom before closing**; if it still
  drifts, walk the stack from the crest down.

- **[x] A7 — Live strip: content pushed down by the div at the top when zoomed.**
  Fixed 2026-08-04, but by a different route than expected. The whole chain is
  clean — the strip's CSS, the ticker's, and the stage geometry in
  `slideshow/player.html` (`min(100vw, 177.78vh)`, strip/ticker sized as `%` of
  it) are all viewport-relative, and the built `site/live-strip/index.html`
  contains no `px` at all. So no unit was at fault.

  The cause is **wrap quantisation**. The strip is ~8% of stage width (~154px at
  1080p) and `.head-div` carries a long division name, so the caption wraps. The
  wrap point depends on glyph advance widths, which round to different subpixel
  values at each zoom level — so the caption flips between 2 and 3 lines, and
  `.head` was content-height, so every tile below it shunted down.

  Fix: `.head` is now fixed `height: 6vh` with `overflow: hidden`, its content
  centred, and `.head-div` clamped to 2 lines. The tiles' origin no longer
  depends on how the caption wraps.

  **Generalises:** viewport units alone don't guarantee invariance. Any
  *content-height* box holding text that can wrap is a latent drift source. Give
  fixed height to boxes whose job is to position what follows them.

---

## B. Layout & density

- **[x] B1 / B2 — Team slide, Form & Schedule panels: wasted vertical space.**
  Done 2026-08-04, one fix for both. Three 16vh tiles + gaps used 50vh of a
  ~65vh panel, so ~15vh sat dead at the bottom and the tile content was sized
  for a box far tighter than it needed to be.
  - Tile height `16vh` → **`19vh`** (`.strip` and `.fix-strip` kept in step —
    the two tabs cycle, so their tiles must agree). Sized against the *Form*
    tab, which is the constrained one: it spends a row on the form-summary
    badges that Schedule doesn't. ~59vh of ~65vh used, with the remainder left
    as deliberate slack — `line-height: normal` isn't computable exactly and an
    overflowing stack clips its third tile.
  - Typography moved up a rung throughout, which is the half of B1 that
    "fonts are too small" was really about. Meta rows, result/location pills,
    form labels, the opposition designation and the performer breakdown all
    went `--t-xs` → `--t-sm`; the innings score lines and the performer
    name+figure lines went `--t-sm` → **`--t-ms`**. Discipline icons and form
    badges grew `1.4vw`/`1.6vw` → `1.7vw`/`1.9vw` to stay level with them.
  - `--t-ms: 1.5vw` is a **new token**, filling a real gap in the scale: the
    step from `--t-md` (2vw) to `--t-sm` (1.2vw) was much bigger than any other,
    so content that shouldn't be a headline but also shouldn't be a caption had
    nowhere to sit. Added to both bases and `video.html`'s copy; purely
    additive, no existing usage changed.

  **Second pass, same day** — the tile height cleared the bottom but the
  right-hand column was still under-sized. Confirmed both stacks cap at **two**
  performers (Form via `_select_match_highlights(sc, max_hl=2)`, build.py:1307;
  Schedule via the fixed `top_bat` + `top_bowl` pair), so the column's height
  budget is knowable rather than open-ended:
  - The **result/points pill** (Form) and the **opposition form block**
    (Schedule) moved out of the right column into the right-hand end of the
    left tile's meta row, after a `flex: 1` spacer. Both are short and need no
    row of their own; `.result-row` and `.fix-form-row` are gone.
  - That leaves the right column holding only the two performers, so they took
    the space: `.hl-line` `--t-ms` → **`--t-md`** (level with the opposition
    name opposite), icons `1.7vw` → `2.2vw`, `.hl-detail` `--t-sm` →
    `--t-ms`. Column is now `justify-content: center` with a `1vh` gap, so a
    one-performer tile doesn't sit lopsided.
  - Guards added, because the meta row now positions a fixed-height tile's
    entire contents: pills/badges `flex-shrink: 0`, badge group
    `flex-wrap: nowrap`, and the date takes the ellipsis. The badge group also
    needed `opacity: 1` and `letter-spacing: 0` re-asserted against the
    meta row's inherited dimming and tracking.
  - Form tiles with no performers now render `No performer data` rather than a
    bare bordered column (the `.strip-empty` class existed but was unreachable).

- **[x] B3 — Team slide, Batting panel: reclaim the header row.** Done
  2026-08-04. The separate `.section-head` row is gone from the four stacked
  tables (Top batting / Top bowling); the section title now sits in the table's
  own `.col-headers` row, spanning the rank + name columns
  (`grid-column: 1 / 3`), and the low-value "Name" heading is dropped. The
  qualifier note ("min N innings") rides inline after the title.
  Two details worth knowing:
  - `.col-headers` switched from `opacity: 0.55` to
    `color: rgba(255,255,255,0.55)` — opacity compounds, so a child title could
    never be brighter than its row. Colour lets it.
  - `.section-head` is retained for the **empty** branch only, so a table with
    no data still names itself above `.empty-mini`.

- **[x] B4 / B5 — Wickets & bowling-average grids unbunched.** Done
  2026-08-04, one fix in both files. Widths now vary by content the way
  `.runs-grid` does, instead of three equal narrow columns jammed at the right
  edge:
  - wickets (Overs · Best · Wkts) → `2.5vw 1fr 5.5vw 6vw 5.5vw` — `Best` is
    widest, it holds a `5-27` figure.
  - bowling average (Overs · Wkts · Avg) → `2.5vw 1fr 5.5vw 5vw 5.5vw`.

  Applied to `.bowl-wkts-cols` / `.bowl-avg-cols` (`team.html`) and
  `.wkts-grid` / `.bowlavg-grid` (`leaderboard.html`), which stay
  character-identical — see the D-section note about sharing them.

- **[x] B6 / B7 — Last-match innings panels: club name + score paired, table
  pulled up.** Done 2026-08-04.
  - `.scoreline` dropped `justify-content: space-between` — the club and its
    score are one phrase ("Wendover CC 184-7"), not two facts to park at
    opposite ends of a 73vw column. Now a left-aligned pair with a `1vw` gap.
  - With the headline naming the batting side, the batting table's `Batting`
    column heading was pure repetition: dropped (two empty grid placeholders
    keep the 7-column template intact), and `.scoreline`'s bottom margin cut
    `1.4vh` → `0.5vh` so the table tucks up under the score.
  - Applied to **both** `scorecard.html` and `live-match.html`, which carry a
    deliberately identical scoreline (its comment says as much) — the live
    slide builds its header in JS, so the heading came out of the template
    string there.

- **[ ] B8 — Video clips, top-left card: font size too small.**
  Should increase, but there isn't much room — may need the card's own layout
  reworked rather than a straight scale-up.

---

## C. Side notes — deferred redesigns

Recorded so they aren't lost; **not** in scope for the consistency pass.

- **[~] C1 — League standings slide has never been restyled.**
  Fonts are too small throughout (`td` at `--t-sm`, sub-labels at `--t-xs` /
  `--t-xxs`, `league-positions.html:29,31,62`). Needs a proper redesign, not a
  tweak.

- **[~] C2 — League table slides need a consistency revisit.**
  Should pick up recent changes made elsewhere — e.g. the small team name after
  the club name, as done in the last-match league panel.
  *Partly addressed 2026-08-04:* `.team-desig` went `--t-xs` → `--t-sm` in the
  two slides that already have it (`team.html`'s League panel and
  `match-league.html`), matching the tile stacks' `.opp-sub` — same idea, so
  same size. Row heights are unchanged: the `--t-md` row text still sets the
  line box. What's still open here is the standalone `league-table.html` /
  `league-positions.html`, which don't split the club and team name at all.

- **[~] C3 — Interactive control position clashes with the live strip.**
  When the control sits on the right of the slide and the live strip is showing,
  it obstructs the strip. Revisit the positioning.

- **[x] C4 — Live ticker at full height, covering all slide content.**
  **Fixed 2026-08-04 by migrating `screen/player.html` to the L-frame chrome
  model** (option (a) — decision: the two players must work the same way).

  Cause was the divergence: `live-ticker.html` had been reworked for the band
  model (`.ticker-bar` is `position: absolute; inset: 0` with a solid `--matte`
  fill — it paints whatever iframe it is given), but the screen player still
  handed it a full-stage iframe at `z-index: 30`. So the matte covered the slide.

  The screen player now mirrors the slideshow player exactly:

  - `#stage` (16:9, letterboxed, `--matte` background) wrapping a `#slide-layer`
    that scales to `1 - var(--live-band)` under `body.live-chrome`.
  - `iframe.ticker` in the bottom band, `iframe.strip` up the right, both at
    `z-index: 1` (below the slide layer, so they're hidden at `scale(1)` and
    revealed only when it retracts); `iframe.flash` at `z-index: 40` above all.
  - The sticky live-chrome latch (`onLiveState`, 12-minute hide debounce) with
    `WccLive.start({ …, onState: onLiveState })`.
  - Slide iframes append to `#slide-layer`, chrome to `#stage`;
    `applyDebugScale()` now scales `#stage` rather than each iframe.

  Verified: chrome rules present in both players at matching counts, built
  page's JS passes `node --check`, strip iframe wired.
  **Behaviour change to sanity-check on the wall:** off match days the slide
  layer stays `scale(1)` and playback is unchanged, but the ticker is no longer
  an always-on overlay — it only appears once the chrome latches.

  This also brings the live strip to the wall screens for the first time
  (Tring Road, Kimble, Witchell, Monks Risborough).

- **[~] C5 — Live strip header shows no division name.**
  Only the gold "Friendly" (`head-xi`) renders. Not a layout bug: for friendly
  fixtures `build.py:2229` sets `"name": None`, so `header()` emits no
  `.head-div` at all — a friendly has no division to name. The strip you're
  looking at is the 2 Aug build (last Sunday's friendly).
  Two things to decide: (a) whether a friendly should caption something else in
  that slot (opposition? "Friendly XI"?); (b) `.head` is now a fixed `6vh` sized
  for the XI label *plus* two lines of division, so in friendly mode it leaves
  noticeable empty space under the single short line. Consider a shorter head in
  friendly mode, or accept the constant height for tile-position stability.

---

## D. DRY opportunities spotted along the way

Only worth doing where consolidation clearly beats abstraction.

- **[x] D1 — Panel-tab underline rule duplicated six times.** Hoisted
  2026-08-04. `.panel-nav`, `.panel-tab`, `.panel-tab.active::after` and the
  `panel-progress` keyframes now live once in each base, next to the existing
  `body.paused` freeze and the progress-fill override that were already there.
  The six copies shrank to their genuine differences:
  - `fantasy-league`, `team` — nav `gap`/`margin-top` (+ `flex-wrap`, since its
    tab count is data-driven and can reach five).
  - `honours`, `leaderboard`, `set-nav` — the same, plus
    `letter-spacing: 0.05em` and `white-space: nowrap`, which is what four long
    labels need. The base holds `0.08em`, matching the col-headers convention.
  - `live-match` was the odd one out and stays that way: it drives its
    underline through an explicit `.u` child element (JS re-points it as the
    match's tab set changes) rather than the pseudo-element, so it now switches
    the inherited `::after` off with `content: none` to leave one mechanism in
    charge. Its tab *typography* does come from the base.

  The match-set sequence strip picks all this up for free because it already
  renders as `.panel-nav.set-nav` — worth keeping in mind if a new
  tabbed surface appears.
- **[x] D2 — Title `text-shadow` duplicated on 10 slides** → `--title-shadow`.
- **[ ] D3 — Table row/header borders re-declared per slide.** Thickness is now
  a token, but `.row` / `.col-headers` are still redefined in each table slide.
  Candidate to hoist into the bases alongside D1.
- **[ ] D4** — `.bowl-wkts-cols`/`.bowl-avg-cols` (team) and
  `.wkts-grid`/`.bowlavg-grid` (leaderboard) are character-identical and were
  re-widened in lockstep for B4/B5, each carrying a comment telling the next
  person to keep the other in step. That's a smell — candidate for one shared
  grid template, though `design-conventions.md` currently says grid templates
  are per-slide.

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

- **[ ] B1 — Team slide, Form panel: wasted vertical space.**
  Doesn't fill the panel height; fonts are too small in places. Room to scale up.
  (Tile stack is fixed `16vh` per `design-conventions.md` — revisiting this may
  mean revisiting that number, or letting tile height derive from panel height.)

- **[ ] B2 — Team slide, Schedule panel: as B1.**

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

- **[ ] B6 — Last-match innings panels: pair the club name and score.**
  Move the batting club name and their score next to each other, left-aligned.

- **[ ] B7 — Last-match batting innings panels: vertically tight.**
  Depends on B6. Drop the 'Batting' column header and shift the table up closer
  to the now left-aligned club name + score.

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

- **[ ] D1 — Panel-tab underline rule duplicated six times.** Now uniformly
  `var(--rule)`, but the whole `::after` block is still copy-pasted across
  `_set_header_styles`, `honours`, `fantasy-league`, `leaderboard`, `team` and
  `live-match`. Strong candidate to hoist into the bases.
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

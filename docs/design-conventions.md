# Slide Design Conventions

Conventions for the 10-foot TV UI. Reference implementations live in
`templates/slides/honours.html` and `templates/slides/fantasy-league.html`
— consult those when in doubt; this doc summarises the patterns they share.

## Layouts

Slides extend one of two bases (both define design tokens, safe zones, and club
branding):

- `_base.html` — footer layout. Default. Content fills the screen; logo and
  sponsor strip sit along the bottom.
- `_base-sidebar.html` — sidebar layout. Content is narrower (~73vw effective);
  a fixed sidebar on the right hosts the club logo and vertical sponsor stack.

Use the sidebar layout for data-dense slides (tables, leaderboards, honours,
carousels) where the extra branding presence is welcome and a narrower content
column is acceptable.

## Design tokens

Defined in both bases. Always use these — never hard-code typography, colour, or
spacing.

```css
--safe-x: 5vw;  --safe-y: 5vh;          /* outer safe zone */
--footer-h: 8vh; --sidebar-w: 20vw;     /* layout chrome */
--t-xl: 4vw;    /* hero numerals */
--t-lg: 2.8vw;  /* slide titles */
--t-md: 2vw;    /* row text in tables */
--t-sm: 1.2vw;
--t-xs: 0.9vw;  /* column headers */
--t-xxs: 0.7vw;

--hair: 0.1vh;        /* ~1px — table rules, dividers, pill borders */
--rule: 0.2vh;        /* ~2px — tab underlines, value-bar left edge */
--radius-sm: 0.25vh;  /* ~3px — small inline tags */
--radius: 0.4vh;      /* ~4px — badges, pills, tiles, sponsor logo */
--title-shadow: 0 0.28vh 0.55vh rgba(0,0,0,0.4);
```

## Zoom invariance

**Rule: no `px` anywhere in a slide.** Changing browser zoom on a slide must
produce zero visible change. This is not a nicety — it's how we know a slide
holds its layout on a panel whose resolution we don't control.

Under zoom the CSS viewport shrinks, so `vw`/`vh` boxes keep their apparent size
while `px` boxes grow against them. Two things then go wrong:

- **In-flow `px` shoves its siblings.** A `border`, a `height` on a rule, or `px`
  padding occupies box-model space, so it pushes everything after it. In a table
  this *accumulates* — every row adds its own error and the last rows walk off
  the panel. This was the cause of every drift found in the 2026-08 audit: tab
  underlines, table row borders, and the last-match location badge (pushed down
  by the 1px border on the home/away pill above it).
- **Cosmetic `px` visibly thickens.** `border-radius`, `text-shadow` and
  `box-shadow` don't move anything, but they still coarsen — the sponsor logo's
  corners are the giveaway.

Use the tokens above rather than a raw `px`, and prefer extending a token to
inventing a local one:

| Instead of | Use |
|---|---|
| `border: 1px solid …` | `border: var(--hair) solid …` |
| `border: 2px solid …`, `height: 2px` | `var(--rule)` |
| `width: 1px` (vertical divider), `height: 1px` | `var(--hair)` |
| `border-radius: 4px` / `5px` | `var(--radius)` |
| `border-radius: 2px` / `3px` | `var(--radius-sm)` |
| `text-shadow: 0 3px 6px rgba(0,0,0,0.4)` | `var(--title-shadow)` |

Hairline tokens are `vh` in **both** axes — a divider should read the same
thickness whether it runs across or down, and the wall is fixed 16:9 so `vh` and
`vw` stay in proportion. Values are calibrated at 1080p (`1vh` = 10.8px) and
scale up on a 4K wall, which is the point.

**Not violations** — don't "fix" these:

- `em`, which resolves against the element's own `--t-*` font-size and so scales
  with the viewport. Correct for `letter-spacing` and inline spacers
  (`.hs-star`, `.col-score-gap`).
- `0px` — zero is zero.
- Percentages, `vmin`/`vmax`, `aspect-ratio`, unitless `line-height`.

Templates that don't extend a base (`video.html`, `image.html`) carry their own
copy of the token block — keep it in step with `_base.html` when tokens change.

### Viewport units are necessary, not sufficient

A surface can be 100% `vw`/`vh` and still drift. Text wrapping is decided by
glyph advance widths, which round to different subpixel values at each zoom
level — so a narrow column's caption can flip between two and three lines as
zoom changes. If that caption sits in a **content-height** box, everything below
it shunts. This is what moved the live strip's tiles (`live-strip.html`, `.head`)
even though nothing in the chain used `px`.

**Give a fixed height to any box whose job is to position what follows it** —
headers, captions, meta rows above a table or tile stack. Centre the content
inside it, `overflow: hidden`, and clamp multi-line text:

```css
.head { height: 6vh; overflow: hidden;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center; }
.head-div { display: -webkit-box; -webkit-line-clamp: 2;
            -webkit-box-orient: vertical; overflow: hidden; }
```

This is the same reasoning as the fixed-height tile stack (see "Tile stacks"):
let surplus space fall at the end rather than letting content decide geometry.

To check: `grep -rE '[0-9.]+px' templates/slides` should return only comments.
Stricter still, against the build output, `grep -rE '[0-9.]+px' site/slide`
should return only the token block's `~2px`-style comments and `0px`.

## Brand colour & type

Defined in both bases from the WCC brand kit (navy + gold). Use the semantic
tokens, not raw hex.

```css
--navy-1: #0f2346; --navy-2: #0a1c3a;   /* background gradient */
--gold:   #d4af37;                       /* the single decorative accent */
--light-blue: #b4c8e4;                   /* secondary / label text */
--bg:     linear-gradient(165deg, var(--navy-1), var(--navy-2));
--text:   #fff;        /* primary text */
--muted:  var(--light-blue);   /* secondary labels — prefer over opacity-white */
--accent: var(--gold);         /* rules, headline metric, active tab underline */
```

- **Gold is the only decorative accent — use it sparingly.** `--accent` reads
  well on navy at any size (gold is light, navy dark), so the limit is aesthetic,
  not contrast: reserve it for the headline metric column (`.pts`), the
  active-tab underline, slide subtitles, and rules so it stays a highlight rather
  than flooding the slide. Body text stays white; muted/secondary copy uses
  `--muted` (light blue) or opacity.
- **Result colours stay semantic.** `--accent-win/loss/amber/draw` (green/red/
  amber/blue) signal match outcomes, not brand — leave them as-is.
- **Value-bars are neutral**, not gold: a white-alpha gradient with a
  `rgba(255,255,255,0.45)` left edge. Gold is reserved for the points figure so
  bar and headline accent don't compete.
- **Type is Lato** (self-hosted woff2 under `assets/fonts/`, `@font-face` in both
  bases — offline-safe for the kiosk). Weights shipped: 400, 700, 900, 400i.
  Lato is Google's standard cut, so there is **no Semibold (600)** — use 700.
  Inherit the body font; only set `font-family: 'Lato', Arial, sans-serif`
  locally if you must re-assert it over an old override.

## Carousel slides (tabbed panels)

Sidebar slides that show more than one table cycle through panels on a fixed
timer.

- Wrap panels in `<div class="panels">`; each panel is `<div class="panel">`
  with the first carrying `panel-active`.
- Above the panels, a `<nav class="panel-nav">` lists tabs as
  `<span class="panel-tab">`. The active tab carries `active` and renders an
  animated underline that fills over `--panel-duration` seconds.
- Bottom margin between tabs and the panel content comes from
  `_base-sidebar.html` (`.panel-nav { margin-bottom: 2.8vh }`). Don't redeclare
  this locally — slides may set `margin-top` and `gap`, but leave
  `margin-bottom` alone for consistency.
- Each panel is shown for `panel_duration` seconds — the same dwell a
  single-panel slide gets — so reading pace is constant regardless of how many
  panels a slide has. The slide's total on-screen time is *derived*:
  `panel_duration × panel count`. It does **not** compute a per-panel slice from
  a total — that arithmetic lives in the build (see "Panel duration" below).
- Rotation is handled by the shared **`assets/js/carousel.js`**, not a bespoke
  inline script. Each carousel sets its config and loads the module (markup is
  the standard `.panel-nav`/`.panel-tab` + panel selector):

  ```html
  <script>window.WCC_CAROUSEL = { panelDuration: {{ slide.panel_duration }}, panelSelector: '.panel' };</script>
  <script src="/assets/js/carousel.js"></script>
  ```

  `panelSelector` is `.panel` (fantasy-league, team) or `.half` (honours,
  leaderboard). `carousel.js` drives the rotation timer and the
  `--panel-duration` underline, and registers a controller with the slide
  bridge. Left alone (standalone/kiosk) it auto-rotates, wrapping.
- The build must know a carousel's panel count to derive its total. Fixed-panel
  templates are listed in `FIXED_PANEL_COUNTS` (`scripts/build.py`); the
  data-driven `team` template publishes `slide["_panels"]` instead. A carousel
  with zero panels (no data this build) is skipped entirely.

### Player coordination (slide bridge)

Every slide loads **`assets/js/slide-bridge.js`** (from both bases). It reports
the slide's panel count to the parent player and accepts navigation/pause
commands, so the player can step through tabs and cross slide boundaries as one
sequence (see the player section below / `player-core.js`).

- Plain (single-panel) slides need no extra JS — the bridge defaults to one
  panel. Carousels register their controller from `carousel.js`.
- Navigation authority lives in the **player**, not the slide. Carousels no
  longer bind arrow keys themselves; arrow keys are handled by the player.
- The visual *paused* state is `body.paused`, which freezes the active tab's
  gold underline at full width (rule lives in both bases). It is set only on an
  explicit user pause in interactive mode — never in TV/kiosk playback.

### Panel duration

`panel_duration` is the only timing knob. It is the per-panel dwell, and for a
single-panel slide it *is* the slide's duration.

- The global default lives in `config.json` (`default_panel_duration`). Any slide
  may override it with a `panel_duration` field in its own
  `content/slides/*.json`.
- It is **slide-level only** — never a slideshow-entry or per-show value. A slide
  is rendered once, standalone (the rotation timing is baked into its HTML), so
  its panel timing can't vary between the slideshows that embed it.
- The build derives each slide's total `duration` (`panel_duration × panel
  count`) and writes it into the slideshow `data.json`; the players only ever
  read that total. Do not author a `duration` anywhere in content — it is always
  computed.

## Tables

The shared component class names below appear in every carousel slide. Reuse
them — don't invent panel-specific synonyms.

| Class | Role |
|---|---|
| `.table` | flex column wrapper inside a panel |
| `.col-headers` | header row — `var(--t-xs)`, uppercase, opacity 0.55, border-bottom |
| `.row` | data row — `var(--t-md)`, border-bottom; zebra striping via `:nth-child(even)` |
| `.name` | flexible name cell with overflow/ellipsis; hosts the optional value-bar |
| `.pos` | rank/position number — opacity 0.45, right-aligned |
| `.val` | numeric value column — right-aligned, tabular-nums, opacity 0.7 |
| `.pts` | headline points column — right-aligned, tabular-nums, bold, accent `#a8d5a2` |
| `.stat` | breakdown stat column (bat/bowl/field etc.) — right-aligned, tabular-nums |

Grid templates are per-slide (e.g. `.totw-grid`, `.top-grid`, `.league-grid`).
Column widths vary; typography and alignment do not.

### Table titles live in the header row

Where a panel stacks more than one table (`team.html` — Top batting, Top
bowling), don't spend a separate row on the section title. Put it in the
table's own `.col-headers`, spanning the rank and name columns, and drop the
"Name" heading — it's low-value next to a title that already says what the
table ranks:

```html
<div class="bat-runs-cols col-headers">
    <span class="section-title">Most runs</span>   <!-- grid-column: 1 / 3 -->
    <span class="col-num">Inns</span>
    …
```

Give the header row its dimming with `color: rgba(255,255,255,0.55)`, **not**
`opacity` — opacity compounds, so an opacity-dimmed row can never hold a
brighter title. Any qualifier ("min 5 innings") rides inline after the title.
Keep a plain title row for the *empty* branch, so a table with no data still
names itself.

### Right-hand numeric columns: vary the width

Three equal narrow columns at the right edge read as one bunched block. Size
each numeric column to its content instead — a `Best` column holding `5-27`
earns more width than a `Wkts` column holding `12` — the way `.runs-grid` and
`.wkts-grid` (`leaderboard.html`) do.

### Flexible vs fixed name columns

Prefer `1fr` for the name column. Fixed name widths leave dead space on the
right and don't adapt as other columns evolve. The right-aligned columns will
appear pinned to the slide's right edge — this is the desired effect.

## Value-bars behind names

For ranked tables, a horizontal bar behind the player/team name encodes the
headline metric (usually points, scaled to the panel's leader).

- Driven by an inline `style="--bar: NN%"` on `.name`. The bar is rendered by
  `.name::before` using a green gradient and a 2px left-edge accent.
- Always points-driven, never value-driven (value-bars compete confusingly with
  a points column).
- Suppress zebra striping in panels that show bars — bars already provide the
  row rhythm. Override with a panel-specific
  `.{grid}.row:nth-child(even) { background: transparent }` rule.
- Use the `.name.no-bar` modifier where a cell should keep ellipsis behaviour
  but no bar (e.g. secondary columns like "manager name").

## Numeric formatting

- Money: column header carries the unit (e.g. `Value (£m)`); cell values render
  as `0.0` with one decimal place (e.g. `8.0`, `5.5`). No `£` or `m` in the
  cells.
- All numeric columns use `font-variant-numeric: tabular-nums` so digits align.
- Right-align numeric columns (`text-align: right`). Give them enough width
  that the right-alignment is visually obvious — values flush against the
  column edge read as if they were left-aligned.

## Empty states

- For stat cells that would be blank (zero contribution), render a dim middle
  dot `·` at opacity 0.2 rather than empty space. Helps the eye scan column
  positions.
- For whole panels with no data, render `<div class="empty">No X data yet</div>`
  at `var(--t-sm)` and opacity 0.4.

## Tile stacks

For non-tabular per-row content inside a carousel panel (e.g. a panel showing
three recent results, or three upcoming fixtures), use a **tile stack**:
fixed-height tiles that pack from the top of the panel, with any leftover
space falling below the last tile. Reference implementation:
`templates/slides/team.html` (Form and Schedule tabs).

- Container: `display: flex; flex-direction: column; gap: 1vh` inside the
  panel (no `flex: 1` on the children).
- Each tile: `height: 16vh; flex-shrink: 0; overflow: hidden; padding: 0.7vh 1vw;
  background: rgba(255,255,255,0.04); border-radius: 4px`.
  - The background tint matches the zebra-stripe shade used in tables, so a
    tile reads as "one row of a non-tabular table".
  - `flex-shrink: 0` and a fixed `vh` height — relying on `flex: 1` to share
    the panel evenly does **not** reliably produce equal tiles when content
    is heterogeneous; fixed height avoids the surprises and lets surplus
    space fall below the stack.
- The first row inside the tile is a **meta row** with col-headers
  typography (`var(--t-xs)`, uppercase, `letter-spacing: 0.08em`). Plain
  `<span>` children render at opacity 0.55; badges (`.home-pill`,
  `.away-pill`, `.result-pill`, `.badge-*`) render at full opacity so they
  remain the row's focal points.
- Below the meta row, the headline content line (opposition / event name)
  uses `var(--t-md)` bold with `line-height: 1.1`. Supporting lines use
  `var(--t-xs)` / `var(--t-xxs)` at opacity 0.55–0.7.
- Tiles must not grow with content. If a tile would otherwise exceed
  16vh, reduce typography or supporting content rather than expanding —
  the carousel relies on consistent tile heights so the third tile is
  always fully visible.

## Reference implementations

When introducing a new slide that follows these conventions, copy from one of
these and adapt:

- `templates/slides/honours.html` — four-panel carousel, sidebar layout,
  honours tables (batting scores and bowling figures).
- `templates/slides/leaderboard.html` — four-panel carousel, sidebar layout,
  combined season leaderboards (runs, batting average, wickets, bowling
  average) with per-panel grid templates and an honours-style yellow subtitle.
- `templates/slides/fantasy-league.html` — three-panel carousel, mixed
  rendering (tables with and without bars, single- and split-name columns).
- `templates/slides/team.html` — five-panel carousel with tabs hidden when
  their data is empty; reference for the tile-stack pattern (Form,
  Schedule).
- `templates/slides/match-intro.html` · `scorecard.html` · `match-result.html`
  — the generated match-package cards (plain single-panel, footer layout).
  Reference for hero matchup layout, full-XI scorecard tables, and the
  result-summary scoreline + star-performer cards. Generated per team by
  `build_match_packages` (build.py) as the `last-match-{team}` slide set.
- The "tale of the tape" matchup (crest / form / season performers each side,
  over a toss·division·h2h footer) lives in the shared `_tape.html` macro +
  `_tape_styles.html`, both rendered under the `_set_header.html` header. The
  last-match **intro** (in-set, with the sequence strip) and the standalone
  **next-match** preview (`next-match.html`, populated by `build_next_match`)
  both use it — reuse this partial rather than re-authoring the layout.

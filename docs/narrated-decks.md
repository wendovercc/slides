# Narrated Decks — Deck Builder, Narration & Video Export

> Status: **phases 1–6 built (including the 6c consistency pass); 7 (record mode) designed, not built.**
> Planning source of truth for the deck builder, the narration recorder and the compositor — including **silent** decks, which
> render to video with no editor sitting at all. Supersedes the "Feature 2 — Highlights
> video" half of `docs/match-highlights.md`. Read `assets/js/player-core.js`,
> `assets/js/slide-bridge.js` and `scripts/build.py` (`_resolve_deck`, `_write_deck_data`,
> `build_video_slide`) alongside this.

## Reframe

The earlier design treated commentary as a bolt-on to the match-highlights reel, with its
own beat-addressing scheme (`intro` / `clip:<id>` / `card:<clip>/<pre|post><n>`). That was
re-inventing things the player already has.

Narration is not a highlights feature. It is a property of **any deck**: an editor plays a
deck interactively, talks over it, and the result renders to video. The match-highlights
video then isn't a feature at all — it's the compositor pointed at the last-match deck.

Four artefacts, all data, each independently useful:

| Artefact | Shape | Produced by |
|---|---|---|
| **Deck** | `{title, slides:[…]}` — *exists today* | the build, or the deck builder |
| **Timeline** | ordered atoms + durations; audio optional | derived from a deck, **or** recorded |
| **Narration** | one continuous take + cue/freeze timestamps | an editor sitting |
| **Composite** | MP4 | the compositor, from a timeline |

The **timeline** is what the compositor consumes, and narration is only one of two ways to
produce one — the other is to derive it from the deck's own durations, which needs no
editor and no audio at all. See "Silent decks".

---

## What already exists

Worth stating, because most of this design is assembly rather than construction:

- **A deck is pure data, resolved at runtime.** `_write_deck_data` (`build.py`) writes
  `/slideshow/<slug>/data.json`; the player fetches it (`player.html`). Nothing is baked
  into HTML — one shell serves every deck via `?deck=<slug>`.
- **Every slide is a standalone page** at `/slide/<slug>/`, loaded as an iframe. A deck is
  an ordered list of slide URLs plus durations.
- **Interactive nav exists.** `?interactive` gives manual `next()`/`prev()`, pause, arrow
  keys and a control bar; the player owns the timer and starts paused.
- **Panels are the sub-slide axis.** `slide-bridge.js` announces a panel count and echoes
  panel changes; the player tracks `panelIndex` and `counts[]`.
- **Video clips are already panels.** `templates/slides/video.html` registers the reel as
  a carousel with `count` = number of clips and `show: showVideo(i)`. So `next()` already
  steps clip-by-clip inside a reel, with no special-casing.
- **Content freezing exists, and is not what we use.** `load_pinned_matches` (`build.py`)
  pins a completed match to a stable set slug backed by a committed immutable
  `content/data/matches/{id}.package.json` snapshot — but only the scorecard, not the
  derived stats around it. The render is the freeze instead; see "Wall context vs render
  context".

---

## The atom

**The atom is `(slide, panel)` — whatever `next()`/`prev()` distinguishes as a boundary**,
plus a card qualifier (below). This is uniform across carousels, scorecards and reels.

| Thing | Is | Notes |
|---|---|---|
| Video clip | one atom | a panel of the reel slide |
| Innings reel | a contiguous run of atoms | one slide |
| Slide set (match package) | a contiguous run of slides | expanded by `_resolve_deck` |
| Card | an atom *qualifier* | `(slide, panel, "pre"\|"post")` |

A card is not a panel — `emit_reel` attaches it as a timed overlay `window:[a,b]` **inside**
a clip's playback. It is addressed as a qualifier on the clip atom. v1 caps one card per
side per clip, so `pre`/`post` is a sufficient identity.

*Deferred:* panel-subset deck entries (a deck containing a single panel of a slide). It's
expressible — `{slug, panels:[2]}` with the player restricting `counts[]` — but not v1.

### Naming the levels — **built**

The editor tools address atoms, so an atom the editor cannot *name* is one they cannot
manage: "retake Fantasy League · Top Managers" has to be sayable. Four levels, of which
only two had names in the data before this:

| Level | Is | Example |
|---|---|---|
| **Deck** | the show | — |
| **Group** | the collapsible unit an editor manages | `Last Match · 1st XI`, `Fantasy League` |
| **Phase** | one entry on a tab strip | `1st Innings`, `Team of the Week` |
| **Atom** | `(slide, panel)` — the narratable leaf | `Batting`, `Top Managers`, one clip |

**A group is a match package *or* a multi-panel slide**, and the distinction is invisible
to an editor: both render a `.panel-tab` strip on the wall, one via `_set_header.html` and
one via `_panel_nav.html`. Under the hood they stay different — a slide is a document, with
its own data payload, precache entry, expiry and `_recency` — and that split is right: see
"Panel subsets" for why neither collapsing nor exploding it is affordable.

**A phase is not one-to-one with an atom.** `Highlights`, `Batting` and `Bowling` are three
atoms under the single phase `1st Innings` — `with_strip` is called three times with that
label. For a multi-panel slide the two coincide, because its tabs *are* its atoms. That is
one model in which two levels sometimes collapse, not two models.

**`step` is retired as a concept.** `_set_steps`/`_set_step` were a second name for the
phase list and an index into it; they are now `_set_phases`/`_set_phase`. `step` survives
only as a verb (`step(delta)` in `slide-bridge.js`), where it means a movement.

**Every atom carries `phase` and `label`, both optional**, attached by `_named_atom` and
omitted when there is nothing to say (a 30-clip reel would otherwise write two nulls
thirty times). `label` is what the editor leads with; `phase` groups. Both are read off
`slide_title_parts`, which is `slide_title` split into its levels — so an atom's name and
the wall's own header are the same strings by construction and cannot drift.

**Panel labels are data, not literals.** They were hard-coded `<span class="panel-tab">`
text in `fantasy-league`, `leaderboard`, `honours` and a `tab_labels` map in `team`, which
is why nothing outside the rendered page knew a panel's name. They now live in
`FIXED_PANEL_LABELS` / `TEAM_PANEL_LABELS` (`build.py`), reach the template through the
shared `panel_nav` macro, and reach the tooling through `_atoms[].label` — one list, both
consumers. `FIXED_PANEL_LABELS` doubles as the panel *count*, so the two can no longer
disagree.

A reel's clip atoms are named from the ball narrative the curation already carries
(`1. OUT! G Jackson gets M Moss`), ordinal-prefixed so two similar balls stay distinct.

**The catalogue stays grouped; only the deck expands.** `/deck`'s discover pane lists one
row per group and never opens it — "what do I put here" is answered by the group, and a
search result offering to add a single panel of a slide is the additive UI that "Panel
subsets" already rejected. Expansion belongs in the deck pane, where the editor is
managing something they have already chosen.

This is also what keeps `slides.json` thin. A collapsed row needs a title and a count,
both already published; it never needs atom *names*, so the catalogue does not have to
carry a second copy of them and the "one definition per slide entry" rule in
`write_slide_catalogue` survives intact. The names travel the way they already do — in the
slide's own auto-deck `data.json`, fetched when the editor actually inserts it.

*Verified across the whole build:* 1069 atoms, none unnamed; every tab strip renders the
same labels it did as literals; `timeline.py` on `last-match-1st-xi` still gives 37 beats /
460s, unchanged.

---

## Hold points — **built (phase 5)**

Making a card addressable means `next()` must be able to stop on it.

> **Pacing rule: atoms with intrinsic duration auto-cue; atoms without hold for a manual
> cue.**

- A **video clip** has a duration fixed by its trim. The narrator cannot lengthen or
  shorten it, so there is nothing to control: it plays and cues itself at the end.
  Consecutive clips therefore *flow* — a boundary-fours montage does not become twenty
  manual taps.
- A **card** and a **static slide/panel** have no intrinsic duration. They hold, and the
  narrator's advance sets the dwell.

This matches what the player already does: `wcc-done` advances video slides in interactive
mode while playing. Holds appear exactly where the editor deliberately placed a card, and
nowhere else.

A clip carrying both cards is three atoms:
**pre-card (holds) → action (rolls, auto-cues into the post window) → post-card (holds)**.
The action is never interrupted mid-flight, so a wicket cannot be cut in half by a
mistimed tap.

**Hold points are interactive-wide, not record-only.** Record mode is interactive mode with
a recorder attached; the two must not diverge in what a tap does. **Kiosk is unaffected** —
it has no `next()`/`prev()`, so cards continue to overlay rolling footage on the wall
exactly as they do today.

### How it is wired

The reel's atoms are finer than its panels, and a panel is a clip everywhere else — in
`_atoms`, in `goto-panel`, in `compose.py`'s still addressing. So none of that moved.
What was added is one question the player asks the slide instead of answering itself:

- **`first` / `last` ride on every bridge message** (`slide-bridge.js`). The default is the
  panel arithmetic the player used to do inline; a controller may override it with `edge()`.
  The reel answers `last: false` while it is holding on a *pre* card of the final clip,
  because that hold is still an atom of this slide — and `true` once the action is rolling,
  so the tap that leaves a post-card hold crosses to the next slide through the player's own
  `fwdSlide` rather than waiting for a `wcc-done` that a paused deck would never act on.
- **`next-panel`/`prev-panel` route through a controller `step(delta)`** if it has one. The
  reel spends a forward step on releasing a pre-card hold; everything else is a clip step,
  exactly as before. Backwards is always a clip step — replaying a moment mid-clip is
  deferred.
- **`hold: true` on the echo stops the player's clocks.** A hold clears the slide-advance
  backstop and freezes the countdown fill; releasing it re-arms both over what is *left* of
  the clip, which the reel reports as the echo's `dur`. Without this the reel's
  `panel_duration` backstop (whole reel + 30s) would eventually carry the deck off a card
  mid-sentence, and the pause/resume and pinch-out paths would each re-arm it behind the
  hold's back.
- **The freeze frame is seeked, not just paused.** `timeupdate` fires a few times a second,
  so pausing where the tick lands would stop an arbitrary fraction of a second *into* the
  action the pre card exists to precede. Both clip sources gained `seek(t)`, and the hold
  lands the playhead exactly on the pad's end. `updateCard` then early-returns while
  holding, so a late tick can't retract the card the hold just dressed.

Two things a hold must not be mistaken for: the **stall watchdog** treats it like a pause
(no playback progress for 15s is otherwise a dead clip to be skipped), and `restartCurrent`
— the bridge's un-pause — refuses to resume a held clip, so a hold outlives the user's
pause and is released only by a forward tap.

**Enabling it: `?holds` on the slide iframe URL**, set by the player only in interactive
mode. It rides on the URL rather than over the bridge for the same reason `?ctx` does — a
windowed deck re-loads its frames as it moves, and a URL survives that with no handshake.
It is deliberately *not* on the debug panel's open-slide links: a slide opened on its own
has nothing to release a hold with. The reel also checks `WccSlide.atoms` before it holds
at all, because this template can deploy up to four hours before `/assets` does (GH Pages
caches HTML for 10 minutes and `/assets` for 4), and an old bridge would drop the step that
releases the hold.

### What the video does under a card

Clip bounds are already widened: a `pre` card's window is exactly the lead-in pad
`[0, action_start−start]`, a `post` card's the lead-out pad `[action_end−start, end−start]`.
That pad footage exists specifically to give the card motion to sit over.

**Play the pad through at natural speed under the card, then freeze on its last frame until
the narrator advances.** This yields the best available hold frames:

- **pre-card** — lead-in plays (bowler walking back, field settling), then holds on the
  frame immediately before the action: the bowler at the point of delivery. Spoiler-safe,
  since the pre-card already suppresses the outcome badge.
- **post-card** — footage from action-end plays (the celebration, the reaction), then holds
  on the last frame of the clip.

Rejected: freezing on arrival (wastes the pad, dead frame under a card designed for motion);
looping the pad (a 4s segment under 20s of commentary reads as a stutter).

### Pausing inside a clip

The narrator can also pause mid-clip to talk over a frozen frame. This already works in
interactive mode — the bar's pause calls through to `pauseAuto`, which pauses the `<video>`
element — so record mode only has to **capture** it.

A pause is *not* a cue. The distinction matters:

- a **cue** changes *what* is on screen (advance to the next atom),
- a **freeze** holds *what is already* on screen (pause within an atom).

Freezes only apply to media-bearing atoms; pausing a static beat is a no-op. A card hold is
not modelled as a freeze — it is the natural end of the pad, terminated by a cue.

---

## Silent decks

A deck can be rendered to video with **no commentary at all**, and this is not a recording
with the microphone switched off — it needs no editor sitting whatsoever. Every duration a
silent render needs is already computed at build time, so `compose <deck>` can walk the deck,
enumerate its atoms and write the timeline itself.

| Atom | Duration comes from |
|---|---|
| Static slide / panel | `panel_duration` (`default_panel_duration`, currently 20s) |
| Video clip | the clip's own `_video_duration`, set by `build_video_slide` |
| Card | its registry `dwell` in `content/config.json` `card_types` (4s / 5s) |

**Do not use a reel's `panel_duration` for clip atoms.** `build_video_slide` sets it to
`total_dur + 30` as an explicit safety net (`wcc-done` fires first), so a timeline built from
it would render every clip as 30 seconds of nothing.

The card case falls out for free: with nobody to advance, a card atom's duration is its
`dwell`, which *is* its pad. The freeze is zero-length, the card overlays the pad exactly as
designed, and **the silent render is precisely what the wall shows**. No special-casing.

The audio-is-master rule below simply doesn't engage — durations are exact rather than
dictated by a take, so nothing truncates or holds.

**This is why the compositor should be built first.** Silent composition depends only on a
deck: not on record mode, not on the deck builder, not on a zip. The whole ffmpeg pipeline —
stills, clip segments, card alpha overlays, `xfade` — can be built and validated against an
existing last-match deck before any editor tooling exists. Narration then becomes "durations
come from cues instead of defaults, plus an audio track".

### Enumerating atoms at build time — **built (phase 1)**

Both producers need each slide's atom count, and the build already knows it (`_panels`,
`FIXED_PANEL_COUNTS`, clip count) — but `data.json` published only `duration` and
`panel_duration`, so a consumer had to infer the count by division. Each slide now
publishes an explicit atom list instead. It serves the derived timeline, the compositor and
the deck builder, and it lets record mode stop depending on the runtime `wcc-slide`
handshake for counts — which `player-core.js` already carries a startup `ping` workaround
for, because `counts` staying null collapses `next()`'s `panelIndex < counts-1` test.

`slide_atoms` (`build.py`) computes it and every `slide_meta` writer carries it through, so
it lands in `data.json` as `slide._atoms`:

```jsonc
// static slide: one atom per panel
[ { "panel": 0, "duration": 20 }, { "panel": 1, "duration": 20 } ]

// reel: one atom per clip, split at its card windows, each carrying its media segment
[ { "panel": 6, "duration": 4.0, "card": "pre",
    "media": { "src": "https://videos…/c1f1.mp4", "in": 0.0, "out": 4.0 } },
  { "panel": 6, "duration": 5.002,
    "media": { "src": "https://videos…/c1f1.mp4", "in": 4.0, "out": 9.002 } } ]
```

Two decisions worth recording:

- **A card atom's duration is its window length, not its registry `dwell`.** They're the
  same number in the normal case — the pad *is* the dwell — but a curation override changes
  the pad without changing the registry, and the window is what the wall actually plays.
  So a silent render stays frame-for-frame what the screens show. A zero-width window
  (no pad) yields no card atom, because the wall shows no card either.
- **Clip atoms carry `media` ranges rather than leaving the compositor to re-derive them.**
  The pad footage under a card and the action between the pads are different segments of one
  R2 file, and the split point is only known here.

`_atoms` is absent on live-match slides: their panels are whatever the feed has produced by
render time, so the build cannot enumerate them. Consumers treat a missing list as
"unknown" rather than "none". `data.json` also now carries the deck's `build_version`.

---

## The timeline invariant

*(Recorded timelines only — a derived timeline has exact durations and needs none of this.)*

Narration is recorded as **one continuous take**, with cue and freeze timestamps marked on
it as the narrator plays the deck. Per-beat audio segments are then *derived* by slicing the
take at the cues.

> **The audio is the master. Video adapts to it: truncate if the beat is short, hold the
> last frame if it is long.**

This single rule covers every case — a card held longer than its pad, a card cut short by an
early advance, a re-recorded segment that changed length. Nothing downstream can desync from
the take.

Consequences worth knowing:

- **The compositor needs the take plus the timestamps, not per-beat files.** Segments exist
  so a fragment can be re-recorded.
- **After any re-record, the segment list becomes authoritative** and the timeline re-flows
  from that point. Cue times are retained as provenance, not as the source of truth.
- **Overrun is fine and expected.** If the narrator is still mid-sentence at a cue, the
  words land in the next segment, which is correct — the take is continuous.
- **A cue landing mid-word** is the one thing to design for: the review step needs a
  boundary nudge (drag a cue by a few hundred ms).

### Timeline file

One document for both producers. `duration` is authoritative in both cases; in a recorded
timeline it equals the beat's segment length, with `cue` retained as provenance.

The derived half is built: `scripts/timeline.py <deck-slug>` flattens a built deck's atom
lists into this document (`source: "derived"`, `clip_audio` defaulting to `keep`). A clip
beat carries the `media` segment from its atom; a static beat carries none.

```jsonc
{
  "deck": "last-match-1st-xi-2026-08-22",   // the frozen deck document
  "build_version": "2026-08-23T02:14:07Z",
  "source": "recorded",                     // derived | recorded
  "clip_audio": "duck",                     // keep | duck | mute
  "take": "take.webm",                      // recorded only: continuous master
  "beats": [
    // derived, or a recorded beat with no commentary over it
    { "atom": { "slide": "last-match-1st-xi-intro", "panel": 0 },
      "duration": 20.0 },

    { "atom": { "slide": "last-match-1st-xi-innings-1-reel", "panel": 3, "card": "pre" },
      "duration": 12.4, "cue": 12.4, "audio": "b02.webm" },

    { "atom": { "slide": "last-match-1st-xi-innings-1-reel", "panel": 3 },
      "duration": 7.4, "cue": 19.8, "audio": "b03.webm",
      "freezes": [ { "at": 2.1, "hold": 5.6 } ] }
  ]
}
```

`cue` = the beat's start on the take. `freezes[].at` is **media time within the clip**,
`hold` the wall-clock seconds the narrator held it. Audio is optional per beat, so a
partially-narrated deck needs no special handling — a beat without it falls back to its
derived duration.

---

## The deck builder — `/deck`, **built (phase 6b)**

An editor-facing tool that produces a **frozen, literal deck** — the same
`{title, slides:[…]}` shape the player already consumes, so its output is directly
playable *and* directly renderable.

**It is not only a narration prerequisite.** An assembled deck plus the phase-2
compositor is a complete product on its own: the editor exports `deck.json`, the
publisher runs `timeline.py --data deck.json` into `compose --timeline`, and a
customised highlights video comes out with nobody narrating anything. That path is why
the builder now comes *before* record mode — see Phasing.

**Starting from an existing slideshow and customising is the common case**, and the
motivating example is a small one: dropping player-profile slides between the pre-match
slide and the first innings reel. Today that is a *publisher* capability (edit
`content/slideshows/*.json`, rebuild) and there is no way to do it with website-only
access, let alone inside one sitting.

### What the build already gives it

Three things that turn out to exist already, which is most of the reason this is small:

- **`data.json` is already the resolved snapshot.** `_resolve_deck` has applied set
  expansion, `_skip`, expiry and supersession before writing it. So the builder fetches a
  deck's `data.json`, presents a literal list of slides, and lets the editor delete,
  reorder and add. Output carries no set references, no `show_when`, no expiry rules —
  nothing left to re-resolve.
- **Every slide already has its own auto-deck *document*.** `build_slideshows` writes
  `/slideshow/<slide-slug>/data.json` for every non-authored slide (and every set). So
  "add a slide this deck doesn't contain" is a fetch of that slide's own deck, and it
  arrives with `_atoms`, `duration` and `panel_duration` already computed. The builder
  never re-derives a slide entry, and no second copy of `slide_atoms` appears in JS.
  Note *document*, not page: only authored decks and sets get an `index.html`, and a
  single-slide auto-deck is addressed as `/slideshow/?deck=<slug>` on the bare shell.
- **`timeline.py` already takes a deck *document*, not a slug** (`--data`). An exported
  deck therefore renders through the existing pipeline unchanged.

What was missing is only an **index**: `slide_meta` knows every slug, but nothing
published the list, so a builder had nothing to browse.

#### The slide catalogue — **built (phase 6a)**

`write_slide_catalogue` (`build.py`) publishes `site/slides.json` at the end of
`build_slideshows`: one thin entry per slide — slug, title, template, atom count,
durations, set membership, and the `active` / `expires` / `empty` / `live` flags —
plus the set registry, so a whole match package is insertable as a unit and the builder
can tell when an insertion has split one. 243 slides and 19 sets on a current build.

Three decisions worth recording:

- **The entry is thin on purpose.** It carries enough to list, group, filter and warn
  on, and no more. When the editor actually inserts a slide, the full entry comes from
  that slide's own auto-deck (`/slideshow/<slug>/data.json`), so **a slide entry has one
  definition rather than two** and no JS port of `slide_atoms` ever appears. Every
  catalogued slide has such a deck: the auto-deck loop skips only authored deck slugs —
  whose deck contains that same slide anyway — and set slugs, which are not slides.
- **`atoms: null` means *unknown*, not none.** Only the live-match slide has it, for the
  same reason it has no `_atoms`: its panels are whatever the feed produced by render
  time. It is the one catalogue entry that cannot be narrated or composited.
- **`_title` and `_template` ride in `slide_meta`**, added by all four writers
  (`build_slides`, the match-package `emit`, `emit_reel`, `build_live_matches`), because
  `slide_meta` is the only thing `build_slideshows` has when it writes the index.
  `slide_title` composes a label for the generated members that have no `title` of their
  own, from the set strip's own step names — "1st XI — Innings 1". They flow on into each
  deck entry in `data.json`, which is a small bonus rather than the point: an
  editor-built deck's rows can name themselves from the deck document alone.

### The screen

Two columns in the `/curate` idiom — same editor, same machine, same dense navy chrome —
but split **deck + discover down the left, a wide preview down the right**.

```
┌──────────────────────────┬────────────────────────────────────┐
│ DECK        12 slides·6:40│  Innings 1 — highlights  · slug    │
│ ⠿ [video] Innings 1  10a  │ ┌────────────────────────────────┐ │
│ ⠿ [team ] Pre-match   4a  │ │                                │ │
│ ───────── caret ───────── │ │        preview (16:9)          │ │
│ ⠿ [honours] Leaderboards  │ └────────────────────────────────┘ │
├──────────────────────────┤  DECK CHECK                        │
│ [search…] All Shows Sets  │  Last Match · 1st XI is split — …  │
│  SLIDESHOWS               │                                    │
│  [show] Match Highlights +│                                    │
│  MATCH PACKAGES           │                                    │
│  [set ] Last Match · 1st +│                                    │
└──────────────────────────┴────────────────────────────────────┘
```

**Left top: the deck.** One row per slide — name, atom count and duration, an editable
dwell, and the row buttons. The **slug is deliberately not on the row**: the preview
header names it, and one line per row is what keeps a 30-slide deck scannable.

- **Drag to reorder**, with ▲▼ on every row as the reliable fallback — dense tool, cheap
  buttons, and no keyboard trap.
- **An insertion caret sits between rows** and is the target of every add. Click a gap to
  move it, then hit `+` on a result.
- **Set members carry a coloured stripe** down the left edge, so a contiguous run reads as
  one block and a split is visible before the deck check explains it.
- **Duration is editable on static slides only.** For a silent render, dwell is the *only*
  pacing control the editor has, so it belongs here; a reel's duration comes from its
  trims and is read-only. The box writes `_atoms[].duration` — the group row's writes
  every atom of the slide (how `slide_atoms` computed them), a child row's writes one.
  See "Per-step duration on a carousel".

**Left bottom: discover.** One search box and one flat result list over **all three**
sources in `slides.json` — slideshows, match packages, single slides — because "what do I
put here" is one question, not three. A kind filter (All / Shows / Packages / Slides)
narrows it; results already in the deck say so.

- **Click a result to preview it. `+` adds it.** Previewing before committing is the point
  of the pane, and it costs nothing: the preview is assembled from fetched entries and the
  draft is never touched.
- **Adding a slideshow inserts its slides**, which is why there is no separate "load"
  step at all — see below.

**Each pane owns its own action, top-right, and both hide when they would do nothing.**
`Play ↗` on the deck pane opens the whole draft in a tab; `Open ↗` on the preview pane
opens whatever is being previewed. Same shape, same `↗`, same rule — a button that does
nothing is worse than no button, which is also why there is no "Narrate →" yet.

**Stacked, not tabbed.** The caret lives in the deck list, and hiding it behind a tab
while you choose what to put in it means not seeing where the thing will land.

**Right: preview above, deck check below.** The preview takes the remaining width (`1fr`
against a `340–420px` left column), with a **wall / archive toggle** on `?ctx` — archive
wording is what the video will say, and what the narrator will read. Its actions sit in the
same row: `Open ↗` for anything, and `Curate ↗` when the previewed slide is a reel, which
is the flip side of the curate/assemble loop. The check panel moves
here because a 16:9 box in a wide column leaves usable space beneath it, and the left
column needs its height for two panes.

**No thumbnail grid.** Both ways of getting one are worse than one big preview pane:
build-time stills mean a headless-Chrome pass over every slide every night, and live
mini-iframes mean dozens of simultaneous slide documents — the exact allocation that
produced the iOS WebContent OOM.

### Naming: a slide's own header hierarchy

**A slide is named by the headings it renders, dot-joined** — `slide_title` in
`build.py`:

```
Last Match · 1st XI · 1st Innings · Batting
Team Focus · U13 Spitfires
Leaderboards · 1st XI League · 2026
```

This replaced a template badge (`scorecard`, `video`, `team`) sitting next to a bare
`title`, and the badge turned out to be load-bearing in a way that made the whole scheme
wrong: **only 127 of 242 slides had a distinct title.** Thirteen are called
"Leaderboards"; every team name appears five times over (team, schedule, next-match,
league table, latest result); and inside a match package, the batting and bowling cards of
an innings were *identical* — "1st XI — 1st Innings" twice. The badge was carrying the
identity, which is not a badge's job, and it exposed an implementation word to an editor
who has no reason to know what a Jinja template is.

Four levels, each skipped when absent:

1–2. **Heading and subheading**, whatever the slide puts in its header. Set members,
next-match, the standalone result and the live slide already carry an explicit
`_set_title` / `_set_subtitle` pair; `team` and `schedule` gained `_heading` /
`_subheading`; the rest use `title` plus whichever subtitle field their template shows
(for `league-table` that is the division, which is the half that separates the 1st and
2nd XI tables — both are titled with the league).
3. **Phase** — the sequence strip's own step name (`_set_steps[_set_step]`), or a reel's
innings label, which is the step it sits in.
4. **Leaf** — what the slide is *within* that phase: a scorecard's `_mode`, or a reel's
Highlights. This is the level that separates batting from bowling.

**All 242 slides are now distinct.** Three decisions behind it:

- **The two hard-coded headings moved into the slide data**, and `team.html` /
  `schedule.html` / `next-match.html` now render `_heading` / `_subheading` /
  `_set_title`. Reading a literal out of a template into a parallel Python table would
  have been a third hand-mirrored duplication of exactly the kind this design keeps
  complaining about. Rendered output is byte-identical.
- **`_mode` is scoped to the scorecard.** `build_schedule` uses the same key for a
  display mode, so an unscoped read named a schedule slide
  "U13 Spitfires · Fixtures & Training · **Team**".
- **A prose subtitle is dropped** (over 48 chars, or containing a full stop). A few
  authored slides carry a sentence there — "Interested in joining the club? We have
  options for everyone." — which fills the row without identifying anything. Those are
  hand-written one-offs whose title already separates them.

Badges are now **structural, not technical**: a search result is badged `slide`, `set` or
`show`, which is what tells you how much a `+` will add — something a name cannot say.
Deck rows carry no badge, because everything in a deck is a slide and it would be one word
repeated down the column. A live slide keeps a coloured dot, that being a warning (it can
be neither narrated nor rendered) rather than a category.

### One mechanism for adding and starting-from

A slideshow is just another search result, so **"start from Match Highlights and
customise" is "insert it into an empty deck"**. There is no load step, no separate
starting-point picker, and one code path instead of two.

That is what frees the header dropdown to mean **drafts and nothing else**: it lists the
decks in this browser and switching it switches deck. Deck *identity* — new, rename,
duplicate, delete — sits behind one `⋯` menu next to it, while **Import / Export keep
`/curate`'s header-right placement**: they are the hand-off to the publisher rather than
housekeeping, and the two tools should not put the same job in two different places.
A draft *is* a deck (`deck-store.js`), so the list is `WccDeckStore.list()` with the `__`
tooling keys filtered out, and no separate draft concept exists.

### The deck check

Non-blocking and stated rather than enforced, because each of these is sometimes what the
editor meant:

| Warning | Why |
|---|---|
| **This splits the *Last Match* set** | Set membership is baked at build time: `set-nav.js` drives a step strip rendered *into* each member. Insert a slide mid-set and the next member still shows "3 of 5" for a sequence that no longer runs. Cosmetic, member slides only — worth saying, not worth making the strip deck-aware until it bites. |
| **Live-match slide** | No `_atoms` (panels are feed-driven), so it can be neither narrated nor rendered. The one warning that is nearly an error. |
| **Empty / expired / inactive slide** | `_empty` is built-but-no-data-this-build; the deck rules that would normally drop it were resolved away. |
| **Reel has no resolved clips** | Expected during the sitting — R2 sync happens on the publisher's rebuild. "Renders after the rebuild", not "broken". |
| **Deck is older than the site** | `build_version` drift, the same guard the compositor applies. |

### Drafts, storage and the hand-offs

**A draft *is* a deck, so `deck-store.js` is the draft store.** `WccDeckStore.list()` is
the deck library the picker shows, `Play deck ▸` plays the draft key directly instead of
copying it anywhere, and `?deck=local:<key>` needs no second concept — one storage
convention on this origin, as phase 4 intended. The preview pane borrows the same store
under a reserved `__preview` key, filtered out of the picker.

**A deck's storage key is an opaque system ID, never shown.** It was minted from the title
at first save, which goes stale the instant the editor renames the deck — and re-keying on
rename means a write, a delete and a re-point of `wcc-deck-last` for a string nobody should
be looking at. The title is the name; the key is only ever compared, never parsed, so
existing title-derived keys keep working. The status line and the export filename both come
from the title instead. `put()` already returns false on quota (a 29-clip reel plus
atoms is not small), and the builder must surface that as a real error rather than a
silent non-save.

**There is no save indicator, deliberately.** Every mutation writes synchronously, so a
"Saved" badge would be permanently lit and would therefore say nothing; the deck list
redrawing is the feedback that an edit landed. The one status slot in the header carries
problems only — a failed write, an unreadable import, a missing `slides.json`.

Two hand-offs join the sitting:

- **From `/curate`** — *designed, not built.* A reel row resolves its clips from the
  curation the editor is working on, live. See "Clips reach a deck by reference, not by
  copy" below: it needs no attach action and takes no snapshot.
- **To record mode** — "Narrate →" opens `/slideshow/?deck=local:<key>&record&ctx=archive`.
  This settles where narration starts: **the front door is `/deck`**, so record mode never
  needs a deck picker of its own.

**Export** is `deck.json`: the literal deck plus `build_version` and `source: "builder"`.

### The publisher's half — **built**

There is **no import step**: the publisher never opens `/deck`, and the file is the whole
hand-off. `compose.py --deck-file` renders it in one command, because `timeline.py` takes
a deck *document* and an exported deck is one — same call, no second code path.

```
Editor     /deck → Export deck.json → sends the file
Publisher  python scripts/build.py                                # a current site/
           python scripts/compose.py --deck-file 1st-xi.deck.json -o 1st-xi.mp4
           upload to YouTube by hand
```

`compose.py` serves `site/` itself on an ephemeral localhost port and drives headless
Chrome against it, so there is no server to start. The output name comes from the file
stem (`<name>.deck.json` → `<name>`), because a deck is titled by a person and
"1st XI highlights (custom).mp4" is not a filename.

`warn_build_drift` prints a line when the deck's `build_version` differs from the one in
`site/slides.json` — the same guard the deck check gives the editor, now where the render
actually happens. It warns rather than refuses: the site rebuilds nightly and league
panels are *meant* to be fresh at publication, so a mismatch is normal. What it is really
watching for is the dangerous case — **the team has played again, and the rolling match
slugs now name a different match.**

Two constraints the workflow inherits rather than introduces: the render must happen
inside the match's window (see "Wall context vs render context"), and a reel only has
footage once the publisher's rebuild has synced its clips to R2, since CI deliberately
does not run `sync_videos.py`.

### What shipped, and what it cost

`templates/deck/index.html` + `assets/js/deck.js`, published by `build_deck_builder`.
**The build step is one template render**: the page reads `/slides.json` for the catalogue
and `/slideshow/<slug>/data.json` for each entry it inserts, so nothing is baked in and a
slide entry keeps exactly one definition.

The design above is what got built, with three adjustments:

- **`slides.json` gained a `decks` list** — the authored slideshows, collected in the loop
  that writes them. "Start from an existing slideshow and customise" is the common case,
  and the catalogue indexed slides and sets but not the decks an editor actually starts
  from. Auto-decks stay out: they are one slide or one set, both already listed.
- **No "Narrate →" button yet.** Record mode is phase 7, and a dead button is worse than
  no button. `Preview deck ▸` opens `?deck=local:<key>&interactive&ctx=…` in a tab, which
  is the same hand-off with a different destination.
- **The layout was reworked once it was in front of a person**: deck and discover stacked
  down the left, preview widened to `1fr` down the right, the slug off every row, and the
  three source lists (slideshows / packages / slides) collapsed into one search. The load
  step went with it — see "One mechanism" above.
- **Preview plays an injected deck**, which was not the original plan and is
  the more interesting of the two. Pointing the pane at `/slideshow/<slug>/` fails twice
  over: 242 of the 273 deck directories have no `index.html` at all (only authored decks
  and sets get a page), and a *built* deck runs the hard loading gate — previewing a
  29-clip reel would prime the whole reel into the cache before showing a frame. An
  injected deck skips the gate, the precache fetch, the version poll and the live feed,
  which is exactly what an editor preview wants. It reuses the phase-4 seam rather than
  adding a preview path — and it is what makes previewing a search result *before* adding
  it free, since the preview deck is assembled from fetched entries without touching the
  draft.
- **The start index (`&start=<n>`) was not built.** Preview opens at the top of the deck;
  per-slide preview covers the "look at this one" case, which is what the pane is for.
  Deferred rather than dropped.

**Verified end to end, not just built.** Across the whole current build: all 243 catalogued
slides resolve to an auto-deck entry carrying `_atoms`, all 19 sets match their members
exactly, and every static slide holds the uniform-dwell shape the duration editor rewrites
(`duration == panel_duration × atoms`). The split detector raises nothing on any of the 31
built decks and does fire on the motivating case — a slide inserted between the pre-match
slide and innings 1. And the export renders: that same customised deck through
`timeline.py --data` gives 41 beats / 540s against the unmodified deck's 37 / 460s (the
inserted slide's 4 panels × 20s), and dropping its dwell to 10s in the builder takes it to
500s. **That is the silent custom-deck video working**, with no narrator and no record
mode.

### Panel subsets — **built**

*Researched and built 2026-08-27.* The research below stands; what follows is what
landed and where it differed.

- **`set-panels` in `slide-bridge.js`, routed exactly as `set-clips`.** The bridge now
  presents an **ordinal space** to everything outside it: `panels` is the reduced count,
  the reported `panel` is an ordinal, and a `goto-panel` index is an ordinal. `show()`
  maps ordinal → controller index on the way in, `toOrd()` maps back on the way out, and
  `edge()` falls out correct because it is written in terms of both. One implementation,
  every carousel template, no template changes at all.
- **The research said "filtered but keep their original panel numbers". That was wrong**
  — it would have left the bridge and the compositor in different numbering. `_atoms` are
  filtered **and renumbered to ordinals** (`_apply_panel_subset` in `build.py`), which is
  what makes the claim underneath it true: `compose.py` and `timeline.py` needed no change,
  verified end to end. The original panel numbers stay recoverable from the entry's own
  `panels` list.
- **A subset implies player-owned timing.** The wrinkle the research missed: a template's
  own auto-rotate walks every panel it *has*, with no notion of the entry's selection, so
  `restart-auto` would show panels the deck removed. `set-panels` calls `pauseAuto`, and
  `restart-auto` refuses to start it while a subset is set — the slide holds its first
  kept panel and the player's timer moves the deck on. Subset decks are narrated or
  composited, both already `take-over`, so nothing loses behaviour it had.
- **Reels refuse it**, as designed: their atoms are finer than their panels, and a clip
  subset is `set-clips`. The build refuses too, rather than only the browser.
- **A subset that is empty, out of range, or the whole slide drops the `panels` key** —
  the entry means "this slide", and a redundant list is one more thing to disagree later.
  It is also clamped in the bridge, because a subset arrives before the controller
  registers and a `team` slide's panel count depends on that build's data.
- **Set members cannot inherit `panels`** from a set-level entry: it names panels of one
  slide.

*Verified:* the bridge driven under stubs through subset-after-register,
subset-before-register, out-of-range, cleared, kiosk `restart-auto` (both branches) and
the reel refusal; `_apply_panel_subset` over all six cases; and a subset deck end to end
through `timeline.py` — Fantasy League 4 atoms / 80s → 2 atoms / 40s, beats addressing
panels 0 and 1. `last-match-1st-xi` still derives 37 beats / 460s.

### Grouping in `/deck` — **built**

A **group** is one row. A package and a multi-panel slide render through one code path,
because they are one creature to an editor:

```
▾ Last Match · 1st XI          9 steps · 7:40
      Pre-match
      1st Innings · Highlights
      1st Innings · Batting
      …
▾ Fantasy League               2 of 4 steps · 0:40
    ✗ Team of the Week
      Top Players
    ✗ Top Managers
      Teams
```

- **Groups are derived on every render, never stored** (`groups()` — a maximal
  contiguous run sharing a set, or a lone entry). The deck document stays the flat slide
  list the player consumes, so a deck arriving from anywhere — an authored slideshow, an
  older draft, an export — groups itself with no migration.
- **Child names are the title minus the group's**, which is a prefix of it by
  construction because `slide_title_parts` builds both from the same levels. No second
  naming scheme.
- **A reel is one child**, however many clips it holds: it is one entry on the wall's
  strip, and its clips belong to `/curate`.
- **Turning a step off is one operation to the editor and two underneath** — dropping a
  deck entry for a package member, `panels` for a carousel panel. Hiding that is what the
  grouping is for. `_atoms_all` keeps the full list on a subsetted entry so the toggle is
  reversible; turning everything back on drops both keys, matching the build.
- **Steps are the one unit both kinds are measured in**, in the deck and in the
  catalogue: a package counts members, a carousel counts panels, a reel counts as one.
  `Last Match · 1st XI — 9 steps · 7:40` and `Fantasy League — 4 steps · 1:20`.
- **The catalogue no longer lists package members separately** — the package row stands
  for them, and its step count says how much `+` adds. 273 rows became 161.
- **Badges no longer separate a package from a slide.** Only a whole slideshow keeps one.

#### `+` means "make this whole"

A slug appears **at most once** in a deck, so `+` never inserts a second copy. What it
does instead depends on what the draft already holds:

| State | `+` |
|---|---|
| Not in the deck | inserts at the caret |
| Package with members deleted | puts them back, in the set's own order, **where the group already is** |
| Slide with panels switched off | clears the subset |
| Slideshow, partly present | inserts only the slugs the draft does not hold, at the caret |
| Whole | disabled |

This replaced a per-instance group id, which was the first answer to "what happens when
you add the same package twice". Not allowing it twice is simpler and removes three bugs
at once: two adjacent packages merging into one 18-child group, two rows of the same slide
sharing a `groupKey` (so expanding one expanded both), and a false "split" warning on two
separated but intact packages.

- **Restoring never relocates the group.** "Put Result back" must not move the whole
  package to the caret.
- **Existing entries are reused, not refetched**, so an edited dwell survives a restore —
  only the missing members arrive fresh. A member the set no longer lists is kept at the
  end of the run rather than dropped: it is still the editor's content.
- **Restore is total.** It brings back every missing member *and* clears panel subsets
  inside them. `+` is the coarse "I cut too much"; the per-step toggles are the fine
  control.
- **Only a package counts subsets against wholeness.** A slideshow's `+` adds slides and
  nothing else, so a member's switched-off panel must not mark it incomplete — that would
  leave a live button with nothing to do.
- **The catalogue row says which state it is in**: `in deck` when whole, `7 of 9 steps ·
  in deck` when partial (gold, with a live `+`), its normal meta when absent.
- `slides.json` decks now publish `members`, because a slideshow row has to know its own
  slugs to tell whether the draft already holds them.

*A consequence, for the record:* a deck can no longer show the same slide twice — a title
card at the start and the end is no longer expressible from this page. The "appears more
than once" deck check stays, since a deck loaded from elsewhere can still have them.

#### Consistency pass

Four places the two creatures still read differently, all closed:

- **The deck summary counts steps**, not slides — the same unit as the group rows and
  the catalogue, so the total adds up to what is written down the list. A package of 9
  and a carousel of 4 make "13 steps", and switching two panels off makes it 11.
- **Packages and slides share one catalogue heading and one filter chip.** `kind` stays
  split underneath — it is what `entriesFor` and `restoreSet` dispatch on — but nothing
  above it does (`kindOf` collapses the pair). Rows sort by title, so a package sits
  beside the slides it reads like. Chips are All / Shows / Slides.
- **Every step previews**, panels included. A panel has no page of its own — `/slide/<slug>/`
  always opens at panel 0 and `&start=` was never built — but the preview pane injects a
  deck, so a **one-panel deck is the preview**. `set-panels` does the rest: the mechanism
  built for subsetting a deck entry turns out to be exactly the mechanism for previewing
  one step of it, with no new player capability. Verified: a one-panel preview deck
  derives 1 beat / 20s through `timeline.py`.

  *One bug this shook out, and a second one the fix for it caused.* The preview frame
  only reloads when its `src` string changes, and `previewUrl` keyed the cache-buster
  on the **slug** — enough while a slide had one previewable thing in it, so two steps
  of the same slide produced an identical URL and the frame sat on the first one.
  Bumping the nonce on every `inject()` fixed that and re-navigated the frame on every
  click, including re-previewing what was already showing. **The nonce now bumps only
  when the injected document actually differs**, compared as JSON (which `put`
  serialises anyway): distinct steps reload, re-clicking the same thing does not. A
  cache-buster has to track the *content* — both failures were it tracking something
  else, first the name, then the click.

### The blank first clip — a reveal race in `video.html`

Intermittent, cache-sensitive, and it long predates the grouping work; the deck builder
only made it easy to hit. Worth writing down because almost every plausible reading of
it is wrong.

**Symptom.** The reel's overlay renders, the controls work, the clip counter is right —
and the video area shows the slide background. Always fine with the browser cache
disabled.

**Cause.** `mp4Source.show` captures its element *before* an `await`:

```js
var v = videoEls[i];
ensurePlayable(v, function () {      // async: cache read
    if (current !== i) return;       // checks the clip INDEX only
    crossfadeTo(v, prev);            // ...and `v` may now be detached
```

If `useClips()` runs `mount()` during that read, the elements are rebuilt. The re-show
reveals the *new* element correctly — and then the stale callback fires, passes the
index guard (`current` is still this clip), bumps `showToken` so the good reveal goes
stale, and puts `.active` on an element that is no longer in the document. Which
callback lands last depends on cache warmth, so it never reproduced with the cache off.

**Fix.** Guard on identity, not just index: `if (current !== i || videoEls[i] !== v)`.

**How it was found, because the route matters.** Six hypotheses were instrumented one at
a time — a dropped `reset`, three separate silence paths, the missing loading gate for
injected decks in `player-core`'s `send()` (a real latent gap, but not this; reverted),
and `readyState === 0` guards that should read `< HAVE_CURRENT_DATA` (a real fix, kept,
also not this). All of them assumed *loading*, because "blank video" reads as "media
didn't load".

An unconditional probe reported `ready=4 size=1920x1080 err=none` on the **failing** run.
The media was always fine; the bug was lifecycle, not loading. That one line was
available before any of the six.

Even then, counters were identical across a working and a failing run
(`show=2 xfade=2 reveal=4 revealed=1 stale=3`). What settled it was giving every
`<video>` a uid: `revealUid=1` against `uid=11` said the reveal had succeeded on a
first-generation element while a second generation was on screen. **When counting says
two runs are identical, the difference is in the objects, not the sequence — reach for
identity next, not another counter.**

**Kept from the hunt** (resilience, not scaffolding): `SRC.state()` in stall warnings;
`SRC.kick()`, one reload before the watchdog gives up; `armStall` moved into
`showVideo`, so a show that never completes is still watched — it had been installed
only on the path where the clip came up fine; a bounded non-finite-time check, so a
source that never produces a time is no longer forgiven forever; `dataless()`; and the
`HAVE_FRAME` constant behind the four `readyState` guards. The probe, the counters and
the uid tagging are removed.

- **The template is searchable but not badged.** It names a *category* for the repeated
  generic slides (`cta` 4, `announcement` 3, `schedule` 28) and the slide's own identity
  for the one-offs (`fantasy-league`, `sponsors`, `today`, `image` — one each), so it is
  worth searching and not worth showing; a badge meaningful on some rows and redundant on
  others is worse than none. Decisively, **a package has no template** — Last Match spans
  five — so badging by it would reintroduce the split at the visual level immediately
  after removing it. A package matches on any member's template, which is the only way it
  could. `"cta"` → 4 rows, `"scorecard"` → the 15 packages that contain one.

**Rejected: zero duration as a second way to remove a step.** It conflates "how long"
with "whether", it is lossy (the dwell is gone, so restoring means retyping, which is
exactly what the `✗`/`＋` toggle was built to avoid), and a zero-length beat is a
degenerate render and a flash on the wall. `setDur` clamps at 1s and should keep doing so.

### Per-step duration on a carousel — **built**

*Landed before phase 7: record mode addresses atoms, so the pacing model had to be
settled first — the same reason the naming and the grouping went first.*

A package's members each carried their own `panel_duration`, so per-step dwell already
worked there; a carousel had one number for all four panels — and, because the box only
ever appeared on a *solo* group row, a carousel had no box at all. That was the last
inconsistency between the two creatures in `/deck`, and closing it is mostly deletion.

**The render half needed nothing.** `_atoms[].duration` was already per-atom and
`timeline.py` already read pacing from there, so a deck with per-panel dwells composited
correctly before any of this. Confirmed again on a hand-mixed Fantasy League: 5 / 45 / 20
/ 9 in, four beats of 5 / 45 / 20 / 9 out.

**The player half was the work, and it is a simplification.** `panelTimer()` and
`resumeVideoProgress()` armed from `items[current].panel_duration` — one number reused for
every panel of a slide — while `_atoms` was supposed to be the single source of pacing
truth. There is now one `atomMs(panel)` behind every `armAdvanceTimer` call, reading the
atom list `player.html` hands the player as `items[].atoms`.

- **The panel has to be passed in, not read off `panelIndex`.** `panelIndex` only catches
  up when the slide echoes `wcc-panel`, and every caller that has just sent
  `next-panel`/`prev-panel` is re-arming for the panel it *asked for* — so `panelTimer`
  takes the panel and the three stepping call sites pass `panelIndex ± 1`. Arming from
  the panel still on screen would have paced every step one behind.
- **Reels and live slides keep `panel_duration`**, which is why the fallback stays rather
  than becoming a migration. A reel's clip timing comes from `wcc-panel` and its
  `panel_duration` is the whole-reel + 30s backstop; a live slide publishes no atoms at
  all, its panels being whatever the feed produced.
- **Kiosk is untouched.** It paces whole slides off `duration` and lets the slide rotate
  its own panels, so per-step dwell is an interactive/render property. Built decks are
  uniform anyway, and narrated decks never play on the wall.

**`panel_duration` is dropped when the steps disagree** (`syncDur`, the one place both
derived numbers are recomputed after any dwell edit). Absent means "pace from the atoms"
to the player and the compositor alike, whereas a stale number would quietly out-vote them
on any slide whose atoms went missing. The duration editor's old shape —
`duration == panel_duration × atoms` — therefore no longer holds, and the box reads blank
on a mixed slide, which is the honest answer to "seconds per panel"; typing one in makes
them agree again. `duration` stays the sum, so the deck summary and the group rows keep
adding up.

**Both lists take the edit.** A subsetted entry holds `_atoms` (kept, renumbered) and
`_atoms_all` (the slide's own numbering), and the kept one is a *copy* — so `setAtomDur`
addresses by the slide's own panel number and writes through to both. A switched-off step
is editable too, and keeps that dwell when it comes back, for the same reason
`_atoms_all` exists at all.

**Where the box went.** Onto the child rows for both kinds; a group of several steps has
none, only its total in the meta column. A solo group keeps its box, because it is its own
single step.

**One column means one thing: how long this step runs.** It was two — an editable box, and
a duration in the meta column beside it — which is why a one-panel package member read
`20s` next to a box holding `20`, seven times down Last Match. The column is now editable
where the editor owns the number and read-only where it is derived, so every duration in
the deck lines up under every other:

```
▸ Last Match · 1st XI             9 steps         7:40   ← collapsed: still a duration
▾ Fantasy League                  2 of 4 steps      40
      Team of the Week            off                20
      Top Players                                    20
      Top Managers                off                20
      Teams                                          20
▾ Last Match · 1st XI             9 steps         6:34
      Pre-match                                      20
      1st Innings · Highlights    4 clips          1:14   ← curating: both gold
      1st Innings · Batting                          20
      2nd Innings · Highlights    18 clips         3:00
      Result                                         20
```

- **The meta column says what is *inside*** — `9 steps`, `10 clips` — which is the half of
  the old reel meta the duration column can't carry. It is blank on a step that is nothing
  but its dwell, and says `off` on a step switched out.
- **A group's total is in the column too**, read-only. The first shape had it left in the
  meta on the grounds that "a group is not a step" — but with every group collapsed, which
  is how the list is read, that leaves the column empty on every visible row. A group does
  have a duration; it just isn't typed.
- **Read-only is not disabled.** Group totals, reel totals and a live slide's duration
  render as `.dur-static`, not a greyed-out input: the number is real, it just isn't set
  here. `.dur-gap` is gone — every row now has an answer.
- **The column is only a column if it lines up.** Group and child rows are separate
  grids, and their meta/duration/button tracks were `auto` — which aligns only while the
  text either side happens to be the same width, so a group's `9 steps` against a child's
  blank meta pushed the durations apart. The three right-hand tracks are now fixed
  (`--meta-w`/`--dur-w`/`--btns-w`) and shared by both; `1fr` on the title absorbs the
  differing indents, which anchors all three to the same right edge. The meta is
  right-aligned to pair with the duration, both are 11.5px on either row kind, and a
  child's single `✕` is pushed right to sit under the group's.
- **A collapsed group adds up its members' *live* durations** (`entryDur`), not the
  build's. Putting the number in a column of its own is what made the old behaviour
  untenable: a package holding a reel the editor is curating would have gone on quoting
  `7:40` while the row beneath it said `1:14`. Gold propagates with it.
- **The one place two durations still coexist** is a child with panels of its own, where
  the box is seconds-per-panel and the total is a second number, so that row keeps
  `4 steps · 1:20` in the meta. Every set member in the current build is either one panel
  or a reel, so it is a shape the content does not currently produce.

**Zero is still not a removal** — see the rejection above; the `Math.max(1, …)` clamp
holds on both paths.

*Verified* by driving `setDur`/`setAtomDur`/`setPanels`/`durBox` against the real
`fantasy-league` deck under a stub DOM: a per-step edit updates one atom and drops
`panel_duration`; subsetting to two panels carries the edited dwells across the
renumbering; editing a kept panel by its own number reaches both lists; editing a
switched-off one survives the restore (`99 / 45 / 20 / 7` back, no `_atoms_all`, no
`panels`); a uniform `setDur` brings `panel_duration` back; `0` clamps to 1. `atomMs`
was exercised directly over carousel / reel / live / atom-less entries — 5000 / 45000 /
20000 / 9000 ms per panel, and `panel_duration` for the other three.

**One behaviour changed earlier, recorded here: insertion points sit between groups, not
between slides.** That follows from the group being the unit an editor moves. The "package
is split" warning therefore becomes a state this page cannot produce — it still fires for
a deck that arrives split from elsewhere, which is the case it was written for.

*The grouping work was verified* by driving the module's own `groups`/`childrenOf`/
`setPanels`/`moveGroup`/`candidates` against the real catalogue and real built decks under
a stub DOM: 47-slide deck → 28 groups; package + carousel grouping and child naming as
above; subset toggles reversible and idempotent; group move keeps a package contiguous;
`removeGroup` takes all 9 members; 0 package members in the catalogue; and a subsetted
deck exported from the builder derives 3 beats / 60s through `timeline.py`.

#### The original research

A slide with several panels (Fantasy League has four)
goes into a deck whole. Being able to take only some of it is the deferred
"panel-subset deck entry" from The atom, and the assessment came out lopsided: three of
the four pieces are small or free, and the fourth is a job worth doing on its own merits.

**The UI is subtractive, not additive.** The editor adds the *whole slide*, then turns off
the atoms they don't want, rather than picking atoms out of a catalogue. That keeps a deck
entry always "a slide" rather than a fragment someone had to assemble, makes the default
correct with no decision taken, and moots the ordering question below — you can only
remove, so a subset can never become a permutation.

| Piece | Cost |
|---|---|
| `compose.py` / `timeline.py` | **None.** Verified. |
| `set-panels` in `slide-bridge.js` + pass-through in `player-core.js` | one focused change |
| Build: filter `_atoms`, record `panels: []` on the entry | small |
| **Panel labels into `_atoms`** | the bulk of it |
| `/deck`: atom toggles on an expanded deck row | moderate |

- **The render path is already free.** `compose.py` addresses a still by `atom["panel"]`,
  posting the player's own `goto-panel`, and `timeline.py` walks `_atoms`. So an entry
  whose `_atoms` are *filtered but keep their original panel numbers* renders correctly
  with no change to either file.
- **The player change belongs in the bridge, not the player.** `slide-bridge.js` has one
  choke point — `register(c)` sets `ctrl`/`count`, `show()` clamps to `count`, `edge()`
  compares against `count - 1`. A `set-panels` command routed exactly as `set-clips`
  already is can wrap any registered controller generically: reduced count, ordinal→panel
  mapping inside `show`, and `edge()` falls out correct. One implementation covers every
  carousel template.
  Doing it in `player-core.js` instead would mean the player overriding `first`/`last` on
  every echo — re-asserting the authority phase 5 deliberately handed to the slide.
  Reels need none of this: their atoms are finer than panels and a clip subset is
  `set-clips`, which exists. `set-panels` should refuse to apply to them.
- **The real cost is that atoms have no names.** `_atoms` is `{panel, duration}`, and the
  labels are hard-coded `<span class="panel-tab">Top Players</span>` literals in
  `fantasy-league`, `leaderboard` and `honours`, plus a `tab_labels` map keyed off
  `slide._panels` in `team.html`. Publishing them means the same excavation
  `_heading`/`_subheading` needed: declare in `build.py`, render from data, emit as
  `_atoms[].label`.

**Do the labels first, and separately.** They pay for themselves without any of the rest:
a panel label is exactly the fourth level of the header hierarchy — the slot that gives a
scorecard its `· Batting`. Today every Fantasy League panel is nameless in the tooling.
With labels, `Fantasy League · Top Managers` becomes expressible in the deck builder, in a
compositor beat label, and in record mode's next-up prompt. It is also the only part that
touches wall-facing templates, so landing it alone derisks the rest.

### Freezing, in three layers

| Layer | Status |
|---|---|
| **Composition** (which slides, in what order) | **Solved automatically.** Skipped and expired slides crystallise the moment the editor builds the deck, because `data.json` is post-resolution. |
| **Content** (what a slide *says*) | **Not frozen — rendered inside the window.** See below. |
| **Assets** (fonts, CSS, clip files) | Accepted gap. |

**Match decks are rendered inside their window, not frozen.**
`/slide/last-match-1st-xi-intro/` is a *rolling* slug — next week it renders a different
match — and `content/data/fetched/` is gitignored, so you **cannot** reproduce last week's
deck by rebuilding at an old commit. Pinning was the answer and is no longer: it froze
only the scorecard package, leaving stats and league panels to drift. The render is the
freeze, and it has to happen before the team plays again. See "Wall context vs render
context" above.

Narration inherits the same window: a take is only compositable while its deck still
resolves to the match it was recorded over.

For decks containing league tables or leaderboards, content drifts nightly regardless.
Stamp `build_version` into the deck and have the compositor warn when the live site has
moved past it. Don't build snapshotting beyond that.

---

## The one-sitting constraint

The editor must curate clips **and** narrate in a single browser sitting, with no build in
between. Narrating requires a deck reflecting curation that hasn't been built yet.

**Resolution: pre-resolve everything the build knows, keep the sitting client-side.**

### Pre-resolved card catalogue — **built (phase 3)**

The only genuinely build-dependent content is **card figures**, and the subject space is
bounded and knowable on Night 1: two card types × the players in the two XIs. So the
overnight build walks the cross-product and emits `site/curate/cards/{pc_id}.json`; the
editor looks up rather than resolving.

This is not polish — narration makes it load-bearing, because the narrator speaks what is on
screen:

1. **Silent drops.** `resolve_cards` drops any card whose subject won't resolve (a debut
   batsman gives `inns≤0` after the pre-match subtract). The editor picks it, narrates over
   it, exports — and the build drops it. The video then has commentary over footage with no
   card, requiring a re-do across both people.
2. **Speaking the numbers.** The narrator has to say the figures aloud, or the card is
   redundant.
3. **Editorial judgement.** A card reading *41 runs at 8.2* is worse than no card.
4. **Name-match errors.** `_name_key` matches on `(surname, first initial)`; two players
   sharing that, or an opposition name spelled differently, resolves to the wrong person or
   drops. Visible at pick time instead of at render time.

It also lets the picker grey out cards that won't resolve, and — importantly — keeps the
resolvers in Python. There is already one hand-mirrored duplication
(`_resolve_new_batsman` ↔ `team_preview_performers`) carrying a keep-in-sync comment; a
JS port would be a second.

**Shape and keying.** `ball_events.resolve_card(type, player, …)` is the subject-addressed
entry point next to the clip-addressed `resolve_cards`, which now goes through it — so the
picker and the reel cannot resolve differently. `_card_catalogue` (`build.py`) walks it
across every card type × every name the picker can offer (the club roster, plus any
off-roster name the scorecard carries — an opposition batter is a legitimate dismissal
subject) and writes the exact content the reel will render:

```jsonc
{ "pc_match_id": "7298980", "team": "1st-xi", "available": true,
  "cards": { "new_batsman":       { "pandit|a": { "name": "Anshuman Pandit", … } },
             "dismissal_summary": { "godden|h": { "name": "Harry Godden", "headline": "8", … } } },
  "ambiguous": ["dwight|a", "kapoor|p", …] }
```

Three decisions worth recording:

- **Keyed by `(surname, first initial)`, not the picked name** (`catalogue_key`, mirrored by
  `catalogueKey` in `curate.js`). It is the key the resolvers already match on, so one entry
  serves a card picked as "S Methari" and one picked as "Solomon Methari".
- **`ambiguous` names the wrong-person risk directly.** The resolvers take the *first* row
  whose key matches, so two players sharing a key resolve to whichever comes first. Computed
  **within** a candidate source and never across them — the roster's "Solomon Methari" and
  the scorecard's "S Methari" share a key precisely because they are the same person. The
  club roster really does carry six such collisions (Alexander/Ava Dwight,
  Paavni/Parv/Puneet Kapoor, …), so this is not a theoretical guard.
- **`available` distinguishes "unresolvable" from "unknown".** A match that has rolled out
  of `fixtures.json` has no scorecard and no team, so *nothing* resolves; the picker must
  fall back to offering everything rather than greying out the whole roster.

The picker (`curate.js`) then greys a subject with no entry, prints the resolved line under
each card row — name, headline, sublabel and every stat, i.e. the figures the narrator has to
say aloud — and flags an ambiguous key next to the name it resolved to.

### Session deck — **built (phase 4)**

With the catalogue in place, the sitting needs only: built deck data (Night 1), clip list
and trims (in the browser), card content (pre-resolved), clip playback (YouTube embed). So
the player gains the ability to accept an **injected** deck object alongside `?deck=<slug>`,
and `video.html` the ability to take its clip list at runtime rather than only from the
baked-in blob. Both are also exactly what the deck builder needs. No UI: this is the seam
phases 6 (`/deck`) and 7 (record mode) hang their tooling on.

**`?deck=local:<key>` plays a deck out of the browser.** `assets/js/deck-store.js` is the
handover — `WccDeckStore.put/get/remove/list` over `localStorage["wcc-deck:<key>"]`. Chosen
over a postMessage handshake because the player is a separate document (a tab or an iframe)
and cannot be handed a JS object; because a stored deck survives the reloads a preview
session is made of; and because `/curate` already persists drafts this way, so the origin
keeps one storage convention rather than two.

`resolveDeck` reads the store instead of fetching, and everything after that line is
identical — same document shape, same player, same windowing and nav. An injected deck is
flagged `injected`, which turns off the three things that only make sense with a build
behind them: the `precache.json` fetch, the version-poll refresh, and the loading gate (its
clips may not be in R2 at all yet, so there is nothing to prime and nothing to wait for).

**And the live feed, added in 6b (`LIVE_FEED_ON`).** The live *feature* is gated on
`LIVE_ON` — build flag plus a provisioned device — but the live *feed* is a property of
the wall, not of a deck document. A browser-held deck is an editor artefact: a preview
pane, or a narration sitting. Left alone it started a worker poller per preview iframe and
wrapped the ticker / strip / flash chrome around the very slide the editor was trying to
look at; and a render is of a fixed deck, so day-bound chrome has no business in it.

`LIVE_FEED_ON` is deliberately narrower than `LIVE_ON`: a live-aware slide the editor
deliberately put in a deck is still **shown**, rendering the static pre-match content it
carries before any feed arrives. Suppressing the feed is not the same as dropping slides.
The walls are untouched — the screen player has no `local:` decks, so its `LIVE_FEED_ON`
is `LIVE_ON` verbatim.

**A slide entry may carry `videos`.** The player posts it into that slide's iframe as a
`set-clips` command on every frame load (a windowed deck re-loads frames as it moves);
`slide-bridge.js` routes it to `WccReel.setClips`, so slides keep exactly one message
surface. The slide keeps its identity — tag, cards, layout — and only the footage under it
changes. `setClips` re-registers with the bridge, so the new panel count reaches the player
through the handshake that already exists rather than a second path.

### The reel has to exist before it has clips — **built**

The sitting assumed the reel slide is there to curate into. It wasn't.

`ball_events.select()` filters on `contexts["match"]["include"]`, which comes from the
**committed** curation overlay. On Night 1 there is no overlay, so no clips are selected,
so `emit_reel` returned `None` — and `last-match-<team>-innings-N-reel` did not exist at
all. No page, no `slide_meta`, no auto-deck. Which means, on the one day the whole
one-sitting design is *for*: no row in `/deck` to attach clips to, nothing for the preview
iframe to load, and nothing for `compose.py` to shoot the overlay layer from.

**An innings with no playable clips now builds the slide anyway** — page, `slide_meta`,
auto-deck — flagged `_empty`, and `emit_reel` returns the slug only when there is
something to play, so it is **not added to the set**. The wall is unchanged in both
directions: an empty reel is never a set member, and a filled one is a member exactly as
before.

This costs one unreferenced page per innings and buys the sitting a real slide to inject
`set-clips` into. The publisher's Day-2 rebuild then fills the *same slug* with R2 clips,
and because a narrated timeline addresses `(slide, panel)`, the recording made over the
empty-but-injected reel composites against the rebuilt one with no re-addressing.

Two details worth knowing:

- **`innings_idx >= len(innings_ids_chrono)` still returns early.** A match with no
  Frogbox ball-event metadata at all has no stream behind it, so there is nothing to
  curate and no reel to offer — that is a different condition from "not curated yet", and
  it stays a hard no.
- **An empty reel's atom list is `[]`, not absent**, which is the honest answer (no atoms
  yet, as opposed to the live slide's unknowable ones). The deck check tests for clips
  *before* it tests for atoms, so the row reads "has no clips yet" rather than the alarming
  "no atom list — it cannot be rendered". During the sitting this is the expected state,
  not a fault.

### Clips reach a deck by reference, not by copy

The obvious hand-off is: `/curate` hands `/deck` a clip list, `/deck` stores it on the
reel entry. **That is wrong twice over**, and the second reason is the serious one.

**It doesn't match how the sitting actually goes.** `/curate` has no preview of the clips
*as a reel*, so `/deck` is the bench where an editor finds out the assembly doesn't work —
and what they do then is flip back, add a card, lengthen a clip to leave room to talk over
it, flip forward. That is a loop, not a hand-off, and a copy makes every turn of it a
manual re-attach.

**And an exported copy silently loses an innings.** Measured, not reasoned: a deck whose
reel carries the sitting's clips (YouTube `url`/`start`/`end`, and `_atoms: []` because the
unfilled reel had none yet) derives **27 beats / 20 media** where the built deck gives
37 / 30. The whole first-innings reel vanishes, with no error, because a clip list is not
an atom list — only `build_video_slide` and `slide_atoms` turn one into the other, and they
run in the build.

The line was already drawn in "Freezing, in three layers": a deck freezes **composition**,
not **content**. A reel's clips are content. So:

- **During the sitting, a reel row resolves its clips live** from the curation draft on
  each render. Flip back, change something, flip forward — it is already there. No attach
  action, no snapshot, no staleness, and no UI to build.
- **The export carries no clip list at all.** `deck.json` names the reel slide; the
  publisher's rebuild — which lands the curation overlay, syncs R2 and runs
  `build_video_slide` — is the authority on what is in it. The `pc_match_id` and innings
  ride along as provenance so the publisher can check they landed the matching curation.

#### How it works — **built**

Three pieces, each staying where its inputs already are:

- **`/curate` publishes the assembled clip list**, per innings, to
  `localStorage["wcc-reel:<pc_id>:<innings>"]` — the exact shape a video slide's
  `videos` takes. Written from `persistDraft` (which already fires on every edit) and
  on match load, so the two tabs need no ordering between them and no button. The
  derivation mirrors `ball_events.select()` plus `emit_reel`'s card windows, alongside
  the `effPre`/`effPost` mirror of `merge()` that was already there.
- **`_clips` on the reel entry** — `{url, start, end, src}` for everything actually in
  R2. `(url, start, end)` *is* a clip's identity: it is what `clip_ids.fingerprint`
  hashes to name the object.
- **`/deck` resolves on every render.** A reel row takes the published list and attaches
  `src` per clip wherever `_clips` has an exact match (within 0.001s — `/curate` computes
  these bounds in JS floats). The row then reports *those* clips, so adding a ball makes
  it read 11, and the deck check says the reel is on live curation.
- **Coming back to the tab is the redraw.** `focus` + `visibilitychange` re-render, which
  is when flipping forward shows the edit without touching anything. The rows come free
  with the render; the **preview frame does not** — it booted once off an injected deck
  and its URL says nothing about the clips inside, so it is re-injected and reloaded
  (via a nonce in the URL) *only when the resolved clips actually changed*. An
  unconditional reload would restart the reel under an editor who just came back to
  watch it.

  This is also what makes **discarding** a draft visible. A discard is not an edit: it
  reverts `/curate` to the committed curation and republishes the reels from that (in
  `discardDraft`, which bypasses the `cleanup → persistDraft` path everything else uses
  and so had to be wired up separately). Without it, the deck went on playing clips from
  a draft that no longer existed.

**If any clip has no exact match, the whole reel falls back to the stream.** One source
per reel is an invariant `video.html` rests on — it picks from clip 0, and `mp4Source`
builds a `<video>` per clip from `_video_src` — so a mixed list would not play at all.
Per-clip mixing is the refinement if preview latency ever justifies the surgery.

Verified against the real 1st XI match: `select()` and `_clips` agree on **10/10** and
**18/18** clips for the two innings, so an unamended reel resolves entirely to R2 and only
an actual edit triggers the stream. The symptom of the two derivations drifting apart would
be the opposite — every clip streaming despite being in R2 — which is worth knowing because
it degrades quietly rather than breaking.

**`_pc_id` and `_innings` are on the reel's `slide_meta` — built.** `emit_reel` stamps
which curation and which innings a reel is made of, which is what lets `/deck` get from a
reel row back to its curation at all. It is also the join live resolution will use.

**The loop is signposted in both directions.** `/curate` carries a `Deck builder ↗`
button opening `/deck/?match=<pc_id>`, and `/deck` finds that match's package via the
`pc_id` now published on each set in `slides.json` (which works for a pinned set too,
whose slug says nothing about the team).

**`?match=` is idempotent, which is the requirement that shapes it.** The sitting is a
loop, so the button gets pressed repeatedly and must not mint a deck each time. A deck
opened this way is stamped `source_match`, and a later visit re-opens the same draft
rather than duplicating it. The parameter is then consumed with `replaceState`, so a
reload does not drag the editor back off whatever they since switched to. `source_match`
survives into the export as provenance the publisher can check the landed curation
against.

**And back the other way — `Curate ↗`.** A previewed reel shows a
`Curate ↗` action next to `Open ↗`, opening `/curate/?match=<pc_id>` in a tab. `/curate`
takes that parameter and opens straight on the match instead of the first in the list (an
unknown id falls through to the default, which is what the picker would have shown anyway).
The button is present exactly when `_pc_id` is — which is the same thing as "this slide is
a reel", so it needs no separate test and appears on nothing else.

**The loop is free before narration and costly after it.** A recorded timeline enumerates
the atoms it was recorded against, so re-curating after a take moves the panels underneath
it. The sitting's order is therefore **curate → assemble → narrate → export**, and
`/narrate` (phase 7) should detect a curation change since recording and say so.

**Fixed alongside this:** `derive_timeline` treated an empty `_atoms` as nothing to say. An
empty list is not a missing one — the slide *was* enumerated and the answer was "nothing" —
so it now warns and drops the slide explicitly. That silent drop was the only thing standing
between a wrong export and a wrong video.

### Two clip sources, one reel

The sitting curates clips hours before anything is trimmed and synced to R2, so an injected
deck's clips are `(url, start, end)` segments of the Frogbox stream, not files. `video.html`
therefore resolves a clip **source** — chosen from the first clip, since a reel is one or
the other and never a mix:

| Source | Clip is | Time is | Used by |
|---|---|---|---|
| `mp4Source` | one `<video>` per clip, file already trimmed | `currentTime` | the wall, and the compositor |
| `ytSource` | one IFrame-API player seeking each segment | `getCurrentTime() − clip.start` | editor preview only |

Both expose the same handful of methods (`mount`/`show`/`pause`/`resume`/`time`/`teardown`),
so everything above them — stepping, captions, card windows, the stall watchdog, the
`wcc-done` signal, the panel report — is written once and never branches. Card windows are
clip-relative in both, which is why the YouTube source subtracts the segment start.

`ytSource` is preview-only by design, and the design depends on it: the wall must play
offline, and the compositor records **black** from an embed (see the compositor section).

**Three bugs this shook out, all worth keeping in mind.** **Permissions Policy is
delegated one hop at a time**, and the preview is two hops: `/deck` → player → slide. The
`allow` attribute is needed on *both* the preview iframe and every slide iframe the player
creates (`f.allow`), or the innermost frame — the one actually holding the `<video>` and
the YouTube embed — gets no autoplay. On the wall the player is top-level and inherits it,
so this is invisible there; the symptom is media that runs perfectly in its own tab and
unreliably when embedded, which reads as flakiness rather than as a permission. And
`ensurePlayable` awaited `WccVideoCache.getObjectURL` with **no rejection handler**: an
aborted cache read (a re-navigated frame, a superseded request) left its callback
uncalled, so `show()` never completed and the clip silently never appeared until the stall
watchdog reaped it. That one is not preview-specific — it could strand a clip on the wall.

**And the one that was actually causing it — twice, once per source.** Clip 0 of a reel
would sit for 15s and then be skipped by the stall watchdog, while every later clip played
fine. Both sources had the same bug in different clothes: *the first clip is asked to show
before anything has prepared it.*

- **`ytSource`** constructed its player with no `videoId` and then called `loadVideoById`
  inside `onReady`. Loading into a player that has only just come up reliably produces
  YouTube's "An error has occurred. Please try again later." Fixed by constructing the
  player **on** its first clip, leaving nothing to load at ready time.
- **`mp4Source`** creates elements `preload='none'`, so an untouched clip holds no media
  data and no fetch is running — and the show then waits for data nothing asked for
  (a painted frame when playing, a `seeked` when paused; `currentTime = 0` on
  `readyState === 0` never completes either). Fixed by **raising `preload` and then**
  calling `load()` on a genuine cache miss.

**That order is the whole fix on the mp4 side, and it is easy to get wrong** — the first
attempt called `load()` alone and changed nothing. `load()` runs resource *selection*;
buffering is still governed by `preload`, so `load()` on a `preload='none'` element fetches
nothing. It is raised on the one element being shown, and only on a miss, so the wall —
which plays cached bytes — still spends no network on this path.

Both need a **cache miss** to bite, which the wall never has, being gated on a full prime.
That is why neither ever appeared until decks started playing clips the build had not
primed — which is to say, until the sitting arrived.

**And beneath both of those, the actual race.** A slide embedded in a player deliberately
does not auto-start: it waits to be activated (`if (window.parent === window) showVideo(0)`).
So the boot order is the player's opening `reset` → `show(0)` → the element starts loading;
then the frame's `load` event fires → `set-clips` → `useClips(injected, false)` → `mount()`
**removes every element**, aborting that load — `NS_BINDING_ABORTED` — and then nothing
re-shows, because `showVideo` only runs standalone. The reel sits with fresh elements and
nothing shown, `SRC.time()` never advances, and 15s later the watchdog skips clip 0 and
plays clip 1 perfectly.

It presented as flakiness because it is a race: `set-clips` and the opening `reset` arrive
in whichever order the network allows, and a warm cache flips it — hence "fails, fails,
then succeeds on the third open". `useClips` now re-shows the current clip after a runtime
swap, guarded on whether the slide was ever activated, so an off-screen frame in a windowed
deck still stays idle.

Third, the preview frame must be revealed *before* it is navigated, or the player boots
against a `display:none` 0×0 stage and lays itself out to nothing.

**Seek latency, and why it is a phase-7 problem only.** Stepping clips through the embed is
slower than playing files. It does not matter in the `/deck` preview; it matters when a
narrator is rehearsing or recording against it. Four things to know, in the order they are
worth reaching for:

- **R2-backed clips ARE pre-cached, even in a sitting — built.** The player used to skip
  priming entirely for an injected deck, on the grounds that its clips might not be in R2
  at all. True of the gate, wrong about the cache: the clips that *are* files should not be
  fetched cold, one at a time, as the narrator reaches them. `injectedClipSrcs` collects
  the resolved `_video_src`s and primes them in the background — never gating, so a clip
  that fails to prime still plays from the network. An entry's explicit `videos` list wins
  over its `_videos`, because an amended reel's `_videos` still names what the last *build*
  resolved, and priming that would download a reel the preview will not play.
  The wall is untouched: prime everything, hard gate, and drop any slide whose clips did
  not store rather than open on a clip that cannot play.
- **The YouTube-sourced ones cannot be.** `video-cache.js` works because R2 clips are our
  own MP4s fetched over HTTP into the Cache API. A YouTube embed is a third-party document
  streaming inside its own origin: there is nothing to intercept or store.
- **Stepping is a seek, not a reload — built.** Every clip in a reel is a segment of the
  **same** broadcast, so `ytSource` now loads once and seeks thereafter. Segment end moved
  from YouTube's `endSeconds` (which only applies to a load) to the existing poll.
  This also fixed a *correctness* bug, not just latency: the player was constructed with
  **no `videoId`**, and `loadVideoById` was then called inside `onReady` — which reliably
  produced YouTube's "An error has occurred. Please try again later." on the **first clip
  of every reel** while every later clip played fine. The player is now constructed on the
  first clip, so there is nothing to load at ready time, only a seek. An `onError` handler
  treats a refused clip exactly as the stall watchdog does — like a finished one — rather
  than letting it wedge the reel for 15s.
- **Then warm ahead** — an A/B pair of players, cueing the next clip while the current
  plays — if seeking alone is not enough.
- **The workflow beats all of it.** If the narrator is also the publisher, syncing R2
  before narrating removes the embed from the loop entirely; and per-clip source mixing
  would mean only genuinely new clips ever stream.

**None of this can corrupt the artefact**, which is why it stays a comfort problem: cues are
timestamps against the take, and a clip beat's duration comes from its trim in both
preview and render.
It loads the IFrame API on demand and styles itself from JS, so a wall slide carries no
third-party script and the stylesheet no rules for something it never renders.

The mp4 path was moved into its source verbatim — `crossfadeTo`, `ensurePlayable`,
`reapObjUrls` are character-identical — because it is what the screens run.

**Exercising it** (there is no UI until phase 6b). In the browser console on the site:

```js
WccDeckStore.put('draft', { title: 'Draft', slides: [
  { slug: 'last-match-1st-xi-intro', duration: 20, panel_duration: 20 },
  { slug: 'last-match-1st-xi-innings-2-reel', duration: 60, panel_duration: 60,
    videos: [ { url: 'https://www.youtube.com/watch?v=…', start: 3120, end: 3132,
                body: 'Godden takes the catch', cards: [] } ] },
]});
location = '/slideshow/?deck=local:draft&interactive&ctx=archive';
```

**On preview/render divergence:** the narrator previews clips via the YouTube embed; the
compositor renders from R2. This does not accumulate drift, because each clip beat's
duration comes from its *trim* in both cases, not from preview timing. Freeze `at` values
are media-time within a clip, identical across both sources given a correct
`offset_adjustment`.

**Fallback if divergence ever bites:** build-in-the-loop — the export dispatches the
GitHub workflow (`deploy.yml` already has `workflow_dispatch`) and the editor narrates the
real deck a few minutes later. Costs: CI does not currently run
`fetch_videos.py`/`sync_videos.py` (R2 sync is deliberately publisher-local with
reference-counted retention), so it needs new credentials, real bandwidth, and puts a
reconcile step behind a web button.

---

## Record mode & `/narrate` — **proposed**

Narration is **two surfaces**, and conflating them is the main trap:

| Surface | Is | Where |
|---|---|---|
| **Record** | the deck, near-fullscreen, minimal HUD | `player-core.js` mode #3: `/slideshow/?deck=local:<key>&record` |
| **Review** | beat table, waveform, boundary nudge, re-record, export | `/narrate`, a `/curate`-idiom page that *hosts* the player in an iframe |

Record mode goes *into* the player, as a mode alongside kiosk and interactive, sharing
`next`/`prev`/`arrive`/`applyState` — so a tap does exactly what it does on the bar iPad
and hold points cannot diverge. The review workbench is emphatically not in there.

Entry is from `/deck`, which already holds the deck; `/narrate` is purely post-take.

### The session

```
/deck     assemble  →  Narrate →
/slideshow?record   Rehearse → Arm → Record
/narrate            Review → Export narration.zip
```

**Rehearse is not a nicety.** The narrator needs one pass to learn what is coming — a
2nd-innings reel is 29 clips, which is a lot of surprise. It costs nothing: interactive
mode with the HUD up and the mic off.

**Arm** is mic permission, a level check and a 3-2-1. The take starts before the first
atom does, so there is lead-in silence to trim against.

### The HUD

The deck must dominate, so this is a strip in the letterbox band `placeBar` already
measures — not a panel.

- **REC dot + take clock.** The take is the artefact; its clock is the one true time.
- **Beat position** — `beat 14/61 · innings 1 reel · clip 3 · pre-card`. From `_atoms`, so
  it is known up front and does not wait on the runtime `wcc-slide` handshake.
- **A "next up" prompt** — the highest-value element on the screen. For a clip, its
  curated narrative; for a card, **the resolved figures from the catalogue**, because the
  narrator has to say them aloud (that is what makes phase 3 load-bearing); for a static
  slide, its title.
- **What the current atom is doing** — for a clip, a thin remaining-time bar, so the
  narrator can see the auto-cue coming; for a hold, a `HOLD — → to advance` state. The
  existing `#wcc-bar-progress` fill is the first, and `hold: true` already freezes it.
- **A live level meter**, with a clip warning. A take that turns out silent or clipped
  after twenty minutes is the worst outcome the feature has.

Everything else — prev, home, fullscreen — comes off the bar while recording. It is a
performance surface.

### Input map — interactive's, unchanged

**Record mode keeps interactive's bindings.** The right arrow cues; tap and Space stay
play/pause, exactly as they do on the bar iPad.

| Input | Does |
|---|---|
| **→** (and PageDown) | **Cue** — advance an atom, stamp the timestamp |
| tap / **Space** | pause — captured as a `freezes[]` entry on the current beat |
| **←** | nothing (see below) |
| **Esc** | stop the take |

The argument for remapping was real and is worth recording, because it will come back the
first time somebody records a long reel: cue is the *constant* action and pause is the
rare one, so on target size alone cue deserves the tap surface. It lost on cost of change
— **this is a keybinding, revisitable after one real sitting**, whereas divergence between
record and interactive is the kind of thing that quietly becomes permanent. Two upsides
fall out of keeping them the same: pause needs no new capture path (it is already the
`pauseAuto` call the freeze model wants), and nothing about `?record` has to be re-learned
by someone who has used the iPad.

PageDown rides along with → for free and makes a Bluetooth page-turner pedal work, which
matters when you are standing at a mic rather than sitting at a screen.

**Backwards is disabled during a take.** A continuous take plus a jump backwards is
incoherent — the audio keeps running while the video rewinds. "I fluffed that one" becomes
a review-time re-record, which costs the narrator nothing (keep talking; fix it later) and
keeps the timeline monotonic. The alternative — scrap-last-beat-and-back-up, truncating
the take at the last cue — is buildable but makes the take non-continuous, and the whole
invariant rests on it being continuous.

So `?record` adds a HUD, a recorder and one *subtraction* (`prev`). Hold points (phase 5)
are untouched.

### Crash safety

Losing a twenty-minute take to a reload is a re-do across a whole sitting, so this shapes
the UX rather than just the plumbing:

- `MediaRecorder` with a ~1s **timeslice**, each chunk appended to **IndexedDB** as it
  arrives.
- Every cue and freeze timestamp written to localStorage as it happens.
- `/narrate` offers **"recover unfinished take"** on load.

The point is that a crash lands the editor in Review with everything up to the crash,
rather than at zero.

### Audio

- **Clip audio is muted while recording, with a toggle.** Speakers bleed into the mic, and
  the render mixes the R2 audio itself under `loudnorm`/`duck`, so hearing it live buys
  only timing feel. The toggle is there for anyone wearing headphones.
- **Take-to-video alignment.** `MediaRecorder.start()` does not begin capturing when it
  returns, so cues stamped off `performance.now()` sit tens of ms out. Derive t=0 from an
  `AudioContext` timestamp taken at first-chunk arrival — and, belt and braces, put a
  **global offset nudge in Review** (one slider, ±500 ms, applied to every cue). Cheap,
  and it covers whatever the browser actually does.
- Frame quantisation (`frame_align`, ±17 ms) is comfortably inside this.

### Review & re-record

A table over a waveform of the take, one row per beat:

```
#   atom            duration   [▸]  [waveform slice]  [◂ nudge ▸]  [re-record]  notes
```

- **Nudge** drags a cue boundary a few hundred ms either way — the mid-word case. It
  reflows only the two adjacent beats.
- **Re-record** plays that beat's video from its start (holding the last frame if the
  narrator runs long) while capturing a replacement segment. On save that beat's
  `duration` becomes the segment length and **the segment list is authoritative from there
  on**; the UI badges re-recorded rows and says the timeline reflowed.
- **Flags raised without being asked**: a beat with no audio at all, a beat where the take
  still has energy at the cue boundary (mid-word), a clip beat whose commentary overruns
  badly.
- **"Play from beat N"** drives the hosted player with the take laid over it — the closest
  thing to a render without spending minutes on `compose.py`.

### Export

```
narration.zip
  deck.json          the frozen deck, as played
  timeline.json      source:"recorded" — durations, cues, freezes, audio refs
  take.webm          the continuous master
  segments/b14.webm  re-records only
```

Publisher side is phase 8: `compose.py --timeline timeline.json`. `/narrate` warns at
export time if the site's `build_version` has moved past the deck's — the drift guard,
surfaced where the editor can still act on it.

### Settled, and what would reopen it

- **The prompter carries existing content only** — curated clip narrative, resolved card
  figures, slide title. Authored per-beat script notes were rejected for v1: they need a
  beat-level editing surface in `/deck`, and the content the narrator must speak is
  already resolved and on hand. Reopen if rehearsals show people writing notes elsewhere.
- **Rehearse is its own state**, HUD up and mic off, rather than deferring to
  `?interactive&ctx=archive`. The whole value of a rehearsal is seeing the next-up prompts
  in place, and plain interactive mode has no HUD to show them in.
- **Keybindings are provisional** by explicit decision — see the input map above.

---

## Roles & workflow

| Role | Does | Access |
|---|---|---|
| **Editor** | Curates clips and cards (`/curate`), assembles the deck (`/deck`), narrates it (`/narrate`). Exports `deck.json`, or a narration zip. | Website only. No repo. |
| **Publisher** | Lands the zip: syncs media to R2, commits, builds, runs the compositor **while the match is still the team's last**, uploads to YouTube. | Local scripts + repo. |

| When | What |
|---|---|
| Day 1 | Match played; Frogbox live stream on YouTube. |
| Evening 1 | Captains finish scorecards on Play Cricket. |
| Night 1 | Overnight build: package without clips, but fetches Frogbox ball-event metadata **and emits the card catalogue**. |
| Day 2 | Editor curates, assembles the deck, and (optionally) narrates it. Exports `deck.json` alone for a silent render, or the narration zip. |
| Day 2 | Publisher lands it; rebuild adds clips + cards to the wall package; compositor produces the MP4. |

Narrated decks are **not** played on the wall. That keeps narration from outliving its deck,
and leaves the wall showing the live last-match set exactly as it does today.

---

## Wall context vs render context — **built**

A match slide says things that are true *on the wall* and false the moment the same
frames are a standalone video. "Last Match" is the obvious one; the fixture's date and
venue are the quiet ones — on the wall they sit in the header of the slide the reel came
out of, and on YouTube there is no such surrounding.

**This is a property of the sitting, not of the content**, so it is a render-time flag
rather than a second copy of the slide:

- Every slide honours `?ctx=archive` (`slide-bridge.js`): elements carrying
  `data-archive="…"` swap their text, and `body.ctx-archive` lets CSS reveal
  archive-only blocks. Two mechanisms, both opt-in per element.
- `compose.py` opens **every** still and overlay with it — `--ctx`, defaulting to
  `archive`; `--ctx wall` reproduces the on-screen wording. It is part of the still /
  overlay cache key, since the same slug now renders differently per context.
- **The player forwards it to its slide iframes**, so
  `/slideshow/<deck>/?interactive&ctx=archive` previews exactly what the render will
  say — the whole deck, steppable, before spending minutes on a compose. Nothing reads
  `ctx` in the player itself; it only passes it down (and onto the debug panel's
  open-slide links). The wall never sets it.

What changes today: the set heading (`Last Match` → `Match Highlights`, from
`_set_title_archive`), and a date / Home-Away / ground strip on the reel tag. The strip
grows `.reel-panel` **downward** so `.reel-tag-square` keeps the `--reel-tag-size`
calibrated to the Frogbox bug. Match dates also gained the year everywhere in a match
package — the package *is* the club record — while forward-looking schedule and
next-match dates keep the short form.

The point of one flag at one call site is that the video and the wall stay the same
slide in two modes. A second set of pages would drift.

### This replaces pinning, and accepts a hard window

The MP4 is the immutable artefact; the wall only ever shows the last match. So a match
deck is rendered from its **rolling** slug (`last-match-1st-xi-*`) while it is still that
team's last match, and published.

That is a strictly better freeze than a pin. `load_pinned_matches` only ever froze the
*scorecard package*: the intro's player stats and the league panel still resolve from
whatever the build fetched that night, so a pinned set drifts in exactly the places you
would most want held. A render freezes the pixels. And fresh-at-render is the right
semantics anyway — league position and form in a video published two days after the match
should be the values as at publication.

The cost is **no backlog**: miss the window and the match falls out of `fixtures.json`
with no snapshot behind it. Accepted — there is little appetite for an older match. If it
ever becomes a problem, the answer is to make pinning's point-in-time stats reliable, not
to keep both mechanisms half-working.

Pins are therefore **unused rather than removed** (`content/slideshows/video-test.json`
still references one). Retire them as their own change once a few videos have gone out
this way; the snapshots are cheap and R2 retention refcounts point at them.

---

## The compositor — **built (phase 2)**

`scripts/compose.py`. Deterministic assembly from separate assets — **not** a screen
recording:

1. Headless Chrome screenshots each static atom (`/slide/<slug>/` at the right panel) → PNG.
   The panel is selected by posting the player's own `wcc-cmd` messages (`take-over`, then
   `goto-panel`), so there is no second way to address a panel. A slide opened on its own at
   a 1920×1080 viewport is already the wall's frame — `--fit` is a player concern.
2. The reel's **overlay layer** screenshot **with a transparent background** → PNG with alpha.
3. ffmpeg assembles: stills held for their beat duration; clip segments trimmed from the
   **R2 files** (never the YouTube embed — an embed captures black); `tpad=stop_mode=clone`
   for card holds and mid-clip freezes; the overlay PNG `overlay`-ed across the beat;
   `xfade` transitions; the take laid on the timeline → MP4.

Each beat is encoded to one segment on a single profile (1920×1080, 30fps, h264 + **PCM**
audio in `.mov`), so beats within a slide join with the concat demuxer at `-c copy`, and only
the slide-level joins re-encode. AAC is encoded exactly once, in the final master pass.
Segments, stills and overlays are cached in the work directory and reused, which makes a
re-render after a tweak cheap.

### Two ways a render drifts out of sync

Both were live bugs, both found by measuring the first full render against its timeline, and
both accumulate silently across a long reel — the 2nd-innings reel is 29 clips, so anything
that slips per clip is a second or more by the end.

- **AAC priming, once per segment.** Every AAC stream starts with priming samples the
  decoder discards. Concatenating N of them with `-c copy` therefore loses that much audio N
  times: the reel stamped 157.348s of audio but decoded to **155.947s**, so each clip's sound
  landed ~48ms early and the audio ran steadily ahead of the picture. Intermediate segments
  carry PCM instead; there is no priming to lose, and the single AAC encode at the end has
  nothing to accumulate against.
- **Frame quantisation, once per beat.** Video is snapped to whole frames whatever duration
  is asked for; audio is not. A 6.016s beat produced 6.000s of video against 6.016s of audio.
  `frame_align()` rounds every beat to the frame grid before anything is cut to it — at 30fps
  and 48kHz a frame is exactly 1600 samples, so a frame-aligned beat is sample-aligned too
  and both streams land together.

Worth knowing for phase 7: **a recorded timeline's durations will be quantised the same
way**, so a cue lands on the nearest frame (±17ms). That is well inside the boundary-nudge
tolerance the review step needs anyway.

Ruled out while diagnosing: the R2 clips themselves are clean — both streams start at 0.000
and decoded audio matches its stamped duration — and the curation bounds play no part, so
neither the fetch nor the trim needs defending against this.

Every render now ends with `check_sync()`, which **decodes** the audio rather than trusting
the container's stamp, and warns when the two streams are more than a frame and a half
apart. That distinction is the whole point: the reel that ran 1.4s out still stamped exactly
the right duration in its header.

The alpha-overlay step is what resolves the stale "solid full-frame cards" premise in
`docs/match-highlights.md`: cards are overlays over padded footage, and compositing them
that way keeps the render frame-perfect, GPU-free and reproducible, with one card HTML
component feeding both the wall and the video.

### The overlay layer is the whole layer, not just the card

Step 2 shoots the reel's *entire* overlay — top-left tag, per-clip caption and any open card
— rather than the card alone, via a `window.WccReel.frame(panel, at)` hook in
`templates/slides/video.html`. Two reasons, one discovered in the build:

- **The tag is load-bearing.** It conceals the Frogbox HIGHLIGHTS/QR watermark burned into
  the top-left of every clip. A render that drops it shows the artefact for the whole video.
- **A card is not independent of the caption.** A `pre` card blanks the ball's narrative so
  it can't spoil the outcome. Shooting the layer as a unit means that rule lives in one
  place — the slide — instead of being re-derived by the compositor.

The hook drives the real components and pauses playback first (a standalone page auto-starts
clip 0, and a running `timeupdate` would fight the setup).

### Crossfades go between slides, not between clips

`--fade` (default 0.5s) applies at **slide** boundaries only. Panel and clip steps inside a
slide are hard cuts, which is what the wall does — a montage of boundary fours dissolving
into each other reads as mush. Parts shorter than the fade degrade to a cut rather than
crossfading a two-second clip into nothing.

### Clip audio

**The R2 clips carry real audio** — verified, not assumed. `sync_videos.py` and
`fetch_videos.py` both fetch `bestvideo[height<=720]+bestaudio` and encode `-c:a aac
-b:a 128k`; `ffprobe` on a live clip shows a stereo 48 kHz AAC track, and it is content
rather than digital silence. So `clip_audio: keep` is a genuine option, and it is the right
default for a **silent** render: bat-on-ball and crowd noise carry a highlights reel far
better than actual silence.

**But it needs normalising.** Measured across five clips, mean levels spread over 14 dB
(−28.7 to −42.7) and peaks over 18 dB (0.0 to −18.0). Straight `keep` would drift between
inaudible and loud from clip to clip. Normalise per clip in the compositor with `loudnorm`
(EBU R128) to a consistent target; that belongs in the render rather than in the fetch, so
the R2 files stay a faithful source. It also makes `duck` meaningful in the narrated case —
ducking a normalised bed under commentary at a known gain, rather than an unpredictable one.

Built: `loudnorm=I=-16:TP=-1.5:LRA=11` per clip beat. A full match render of clips
measuring −28.7 to −42.7 lands at **−16.6 LUFS integrated, −1.7 dBFS true peak**. Single-pass
`loudnorm` is loose on true peak on its own, and a crossfade briefly sums two beds, so a
final `alimiter` pass caps the master; it copies the video stream, so it costs nothing but
an audio re-encode. With no narration to duck under, `duck` is simply a quieter bed (−12 dB).

**Trap:** `alimiter`'s `level` option defaults to *on*, which normalises the signal **up** to
the limit — it is a maximiser, not a ceiling. Left at the default it took the render from
−16.5 to −12.9 LUFS and pushed its true peak to +0.4 dBFS, the exact opposite of the
intent. `level=disabled` is required, with the ceiling at 0.7 to leave room for AAC
inter-sample overshoot.

A third pitfall sits next to these: **`loudnorm` re-stamps its output PTS** (it runs a
lookahead), which pushed `apad`'s padding past the `-t` cut and left every normalised beat
84ms short of its video. `asetpts=N/SR/TB` after `loudnorm` is load-bearing, not tidying.

Two caveats: one sampled clip peaked at exactly 0.0 dB, which usually indicates clipping
upstream that `loudnorm` cannot undo; and whole-clip levels say nothing about whether the
*interesting* moment (bat contact, the appeal, the celebration) is audible from a fixed
camera off the square. Both are listening tests, not measurements — worth doing on a wicket
clip before committing to `keep`.

---

## Phasing

| Phase | Scope | Ships |
|---|---|---|
| **1** ✅ | Build-time atom list (`slide_atoms`); derived timeline generator (`scripts/timeline.py`). | Pure build work, no UI. |
| **2** ✅ | Silent compositor (`scripts/compose.py`): stills, clip segments, overlay layer, `loudnorm`, `xfade`. | **An MP4 of any existing deck, with no editor tooling at all.** |
| **3** ✅ | Pre-resolved card catalogue (`_card_catalogue`, `resolve_card`). | Real figures in the `/curate` picker; unresolvable cards greyed out. |
| **4** ✅ | Runtime deck injection (`deck-store.js`, `?deck=local:<key>`); `video.html` runtime clip list + YouTube clip source. | The editor-tooling keystone — serves narration preview and the deck builder. |
| **5** ✅ | Card hold points in interactive mode (`edge`/`step`/`hold` over the bridge, `?holds`). | Consistent nav; prerequisite for narrating cards. |
| **6a** ✅ | Slide catalogue: `site/slides.json` over `slide_meta` (`write_slide_catalogue`, `slide_title`). | The index the builder browses. |
| **6b** ✅ | Deck builder UI (`/deck`): assemble, reorder, insert, preview, export `deck.json`. | **A silent MP4 of a *customised* deck** — no narrator involved. |
| **6c** ✅ | Deck-builder consistency: naming, grouping, panel subsets, per-step duration. | The two creatures — package and carousel — edit alike; pacing is per atom, wall and render. |
| **7** | Record mode + `/narrate`: continuous take, cues, freezes, slicing, re-record, export. | A narrated deck. |
| **8** | Narrated composite + publisher `publish` flow. | The commentated MP4. |

2 needs 1; 6 needs 4; 7 needs 4, 5 and 6, and wants 3 to be worth doing; 8 needs 2 and 7.

**The deck builder was moved in front of record mode**, having originally been phase 7.
Two reasons, both found while planning the record-mode UX:

- **It ships on its own.** An assembled deck plus the phase-2 compositor is a complete
  feature — customised silent highlights, with nobody narrating — and it is the natural
  answer to a week when the narrator is unavailable. Nothing in it depends on record mode.
- **It removes an invented entry point.** Without it, the only way to reach a deck worth
  narrating is a built slug or a `WccDeckStore.put` typed into the console, so record mode
  would have had to grow a deck picker it has no business owning. With `/deck` in front,
  narration starts from a deck that already exists.

Phases 1–2 still deliver a publishable video before any editor-facing machinery exists,
which is why they came first: the whole render pipeline was built and debugged against a
real deck.

**Implementation stance:** record mode goes *into* `player-core.js` as a mode alongside
kiosk and interactive, sharing `next`/`prev`/`arrive`/`applyState` — not a wrapper poking at
it from outside. That file drives the wall, so the regression risk is real, but a second nav
implementation would inevitably diverge from the one the wall uses. Unified and slightly
risky beats bolted-on and forked.

---

## Deferred

- Panel-subset deck entries — researched, shape known, UI is subtractive. See "Panel
  subsets" under the deck builder.
- Panel labels in `_atoms` (a prerequisite of the above, but independently useful).
- A start index for the player (`&start=<n>`), so the deck builder's preview can open
  part-way through a deck.
- Scrubbing backwards mid-clip (replaying a moment) during narration.
- YouTube upload automation — manual via YouTube Studio for now.
- Frame-accurate clip rendering (a seek-per-frame renderer), if quality ever demands it.
  It changes neither the editor tool, the data model, nor the card layer.
- Persistence for editor-built decks beyond the browser (localStorage + `deck.json` export
  in v1).
- Making the `set-nav` step strip deck-aware, so inserting a slide mid-set renumbers it.
  Baked at build time today; a split set shows a stale step count on its members. Cosmetic,
  and the builder warns instead.
- Backwards navigation during a recording take (`prev` is disabled under `?record`).

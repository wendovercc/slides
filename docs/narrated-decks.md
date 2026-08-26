# Narrated Decks — Deck Builder, Narration & Video Export

> Status: **agreed design, not yet built.** Planning source of truth for the deck
> builder, the narration recorder and the compositor — including **silent** decks, which
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

---

## Hold points

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

## The deck builder

An editor-facing tool that produces a **frozen, literal deck** — the same
`{title, slides:[…]}` shape the player already consumes, so its output is directly playable.

**Starting from an existing slideshow and customising is the common case, and it is nearly
free:** `data.json` is *already* the resolved snapshot. `_resolve_deck` has applied set
expansion, `_skip`, expiry and supersession before writing it. So the builder fetches a
deck's `data.json`, presents a literal list of slides, and lets the editor delete, reorder
and add. Output carries no set references, no `show_when`, no expiry rules — nothing left to
re-resolve.

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
phases 6 and 7 hang their tooling on.

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

**A slide entry may carry `videos`.** The player posts it into that slide's iframe as a
`set-clips` command on every frame load (a windowed deck re-loads frames as it moves);
`slide-bridge.js` routes it to `WccReel.setClips`, so slides keep exactly one message
surface. The slide keeps its identity — tag, cards, layout — and only the footage under it
changes. `setClips` re-registers with the bridge, so the new panel count reaches the player
through the handshake that already exists rather than a second path.

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
It loads the IFrame API on demand and styles itself from JS, so a wall slide carries no
third-party script and the stylesheet no rules for something it never renders.

The mp4 path was moved into its source verbatim — `crossfadeTo`, `ensurePlayable`,
`reapObjUrls` are character-identical — because it is what the screens run.

**Exercising it** (there is no UI until phase 7). In the browser console on the site:

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

## Roles & workflow

| Role | Does | Access |
|---|---|---|
| **Editor** | Builds the deck, curates clips, picks cards, narrates. Exports one zip. | Website only. No repo. |
| **Publisher** | Lands the zip: syncs media to R2, commits, builds, runs the compositor **while the match is still the team's last**, uploads to YouTube. | Local scripts + repo. |

| When | What |
|---|---|
| Day 1 | Match played; Frogbox live stream on YouTube. |
| Evening 1 | Captains finish scorecards on Play Cricket. |
| Night 1 | Overnight build: package without clips, but fetches Frogbox ball-event metadata **and emits the card catalogue**. |
| Day 2 | Editor builds the deck, curates, narrates, exports the zip. |
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

Worth knowing for phase 8: **a recorded timeline's durations will be quantised the same
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
| **5** | Card hold points in interactive mode. | Consistent nav; prerequisite for narrating cards. |
| **6** | Record mode: continuous take, cues, freezes, slicing, re-record, export. | A narrated deck. |
| **7** | Deck builder UI. | Editor-authored decks, frozen at build time. |
| **8** | Narrated composite + publisher `publish` flow. | The commentated MP4. |

2 needs 1; 6 needs 4 and 5, and wants 3 to be worth doing; 7 needs 4; 8 needs 2 and 6.
Phases 1–2 deliver a publishable video on their own, which is why they come first: the
entire render pipeline gets built and debugged against a real deck before any of the
editor-facing machinery exists.

**Implementation stance:** record mode goes *into* `player-core.js` as a mode alongside
kiosk and interactive, sharing `next`/`prev`/`arrive`/`applyState` — not a wrapper poking at
it from outside. That file drives the wall, so the regression risk is real, but a second nav
implementation would inevitably diverge from the one the wall uses. Unified and slightly
risky beats bolted-on and forked.

---

## Deferred

- Panel-subset deck entries.
- Scrubbing backwards mid-clip (replaying a moment) during narration.
- YouTube upload automation — manual via YouTube Studio for now.
- Frame-accurate clip rendering (a seek-per-frame renderer), if quality ever demands it.
  It changes neither the editor tool, the data model, nor the card layer.
- Persistence for editor-built decks beyond the browser (localStorage + zip export in v1).

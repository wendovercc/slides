# Match Highlights — Flashcards

> Status: **built.** Planning source of truth for the flashcard layer that extends the
> ball-events curation workflow. Read `scripts/ball_events.py` and
> `docs/design-conventions.md` alongside this.
>
> **The video-export half of this document has moved.** Narration generalised from "a
> highlights feature" to "a property of any deck", so it now lives in
> `docs/narrated-decks.md` — which is the source of truth for the deck builder, the
> narration recorder, the compositor and the phasing. This document covers cards only.

## Problem

The curation workflow (`/curate` → `{pc_id}.curation.json` → R2 sync → build) turns
Frogbox clips into on-wall reels, but the reels show raw action with a caption. We want
data-driven graphic cards around a clip: a new batsman's season record, a fifty
celebration ("first for the club"), a dismissed batsman's innings breakdown. Much of
that content isn't typed by the editor — it's resolved from data.

Cards extend the two primitives already in place: the **curation overlay** (minimal
diffs keyed by clip id) and **`ball_events.select()`** (newest-first, per-innings,
capped). They add *intent* to the overlay, resolved at build.

Roles, the day-by-day workflow and the one-sitting constraint are described in
`docs/narrated-decks.md`, since they're shared with narration.

---

## Feature 1 — Flashcards

### Model

Cards are **overlays over padded live footage** — a graphic that extends the reel-tag
square downward while the footage keeps running underneath. They are *not* solid
full-frame stills; an earlier draft of this document said so and was wrong.

The clip's bounds are widened to carry them: `start`/`end` are the tight **action**, and
the clip actually played is the action widened by per-card **pads**, so a `pre` card has
lead-in footage to sit over and a `post` card lead-out footage. Card windows are
clip-relative and computed in `emit_reel`.

The editor picks a card **type** from a registry and supplies only the params known at
curation time (e.g. which player). The content is **resolved at build** from existing
data, exactly as slides are.

In interactive mode a card is a **hold point** — `next()` stops on it. See
`docs/narrated-decks.md` ("Hold points") for the pacing rule and for what the video does
underneath a held card.

### Overlay schema

The curation overlay gains a `cards` array per clip, alongside `players`/`tags`:

```jsonc
"3452112": {
  "start": 15144, "end": 15149, "match": { "include": true },
  "cards": [
    { "at": "pre",  "type": "new_batsman", "player": "Harry Godden" },
    { "at": "post", "type": "milestone",   "player": "Harry Godden", "value": 50 }
  ]
}
```

- `at` — `pre` / `post`, relative to the clip in the sequence.
- `type` — a key into the **card registry** (below).
- `player` / `value` / … — editor-supplied params; everything else is data-resolved.
- *(A `style` field is reserved for alternative card treatments; v1 renders one style.)*

### Card registry

Each `type` = a template (following `docs/design-conventions.md` — navy/gold, `--t-*`
tokens) + a resolver that pulls from existing data. First set:

| `type` | Content | Source |
|--------|---------|--------|
| `new_batsman` | Season runs/avg, career total, profile facts | `player_stats.json`, profile |
| `milestone` | "Fifty"/"Hundred" + "first for the club" flag | scorecard + historical lookup |
| `dismissal_summary` | Balls, 4s/6s, strike rate | scorecard |

No point-in-time (running-score-at-this-ball) computation is needed — every card is an
aggregate or historical lookup, resolved by the overnight build.

`ball_events.resolve_cards(merged, clip)` turns each card ref into rendered content — a
direct parallel to how `select()` turns clips into `{url, start, end, body}`. The same
card HTML component feeds both the on-wall reel and the offline screenshot (one source
of truth).

### Curation UI

`renderEditor()` in `assets/js/curate.js` gains a **Cards** section per clip, split into
**Before the action** / **After the action** lists. Each has a `＋ Add card` picker;
choosing a type reveals its param inputs (e.g. the roster dropdown, reusing
`addPlayerControl`'s squad/other grouping). On the Day-2 timeline the data is already
built, so previews show real figures.

---

## Off-fixture matches (President's Day, pre-season, festivals)

An intra-club game is scored and streamed like any other, but it is **invisible to the
normal path** — twice over, and for the same reason: its sides are ad-hoc Play-Cricket
teams belonging to no team's fixture list.

1. **It never reaches `/curate`.** `discover_recent_match_ids()` reads
   `fixtures.json → recent_matches`, which is keyed by the teams in `content/teams.json`.
   Fetch it by hand instead — everything downstream then works untouched:

   ```sh
   python scripts/fetch_ball_events.py --match-id <pc_id>
   ```

   Once its `{id}.curation.json` is committed, `curated_match_ids()` re-pulls it on every
   build and the match stays in `/curate` for good. Its `squad` is empty (no scorecard in
   `fixtures.json`), so the role-tag picker falls back to the club roster, and the card
   catalogue is empty — clips, trims and tags are unaffected.

2. **It has no deck to land in.** There is no `last-match-<team>` package for a side that
   isn't a team. Pin it: write the snapshot, then add it to
   `content/pinned-matches.json` with a `team_name` (the ad-hoc side has no `teams.json`
   entry to take a name from).

   ```sh
   python scripts/make_match_package.py --match-id <pc_id> --our-team-id <pc_team_id> \
       --ground "Witchell Ground" --competition "President's Day" \
       --opposition-crest /assets/images/wcc-logo.png
   ```

   `--our-team-id` picks which side the package speaks as; the other is "opposition"
   throughout, which is how every slide in the set is written. Both sides being us, the
   opposition crest is our own.

**A club scorer often doesn't close these matches.** Play-Cricket then reports
`result: "M"` / "Match In Progress" however complete the scorecard, and `result: None`
means `nothing_to_report` — the set is built but stands down. Finalising it on
Play-Cricket is the real fix; until then `--result` / `--result-description` correct it
in the snapshot, which is the right place: committed, hand-curated, and preferred over
the feed. Regenerate after Play-Cricket is fixed and drop the overrides.

**Naming.** Both sides are "Wendover", so a club name alone separates nothing — and
carrying it as well spends width on the half that is identical on both sides. The
designation therefore *replaces* the club wherever a side is named: the innings
headlines, the toss line, the two result columns, the intro tape and the reel tag (whose
two-level club/XI split collapses to one line). Throughout, the match reads "Hurricanes"
v "Spitfires".

## Narration & video export — moved

The narration recorder, the deck builder, the compositor and the phasing now live in
`docs/narrated-decks.md`. The design there supersedes the version this document used to
carry, in three ways worth knowing if you remember the old text:

- **Beats are addressed as `(slide, panel)`** — the coordinates the player already uses —
  not by bespoke `intro` / `clip:<id>` / `card:<clip>/<pre|post><n>` refs. A video clip
  *is* a panel (`video.html` registers the reel as a carousel of clips), so `next()`
  already steps clip-by-clip. A card is a qualifier on a clip atom.
- **Cards composite as alpha overlays**, not solid full-frame stills: the card is
  screenshot with a transparent background and `overlay`-ed onto the R2 clip over its
  window. The old "solid cards remove the only hard part" reasoning no longer applies —
  and didn't match what was actually built.
- **Audio is one continuous take with cue timestamps**, sliced afterwards, rather than
  per-beat recordings with a `dwell` each. Video adapts to the audio, so `fit` is gone.

### Still true, and still prerequisites

- The overnight build must fetch Frogbox **ball-event metadata** so Day-2 curation has a
  clip list; card data comes from the built scorecard/stats.
- The final render must use **R2 files**, not the YouTube embed (an embed captures black).

### Deferred (non-blocking)

- Corner / lower-third card styling as a distinct option (`style` field).
- YouTube upload automation (manual upload via YouTube Studio for now).
- Frame-accurate clip rendering.

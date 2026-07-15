# Match Highlights — Cards & Video Export Design

> Status: **agreed design, not yet built.** Planning source of truth for the two
> features that extend the ball-events curation workflow. Read
> `scripts/ball_events.py` and `docs/design-conventions.md` alongside this.

## Problem

The curation workflow (`/curate` → `{pc_id}.curation.json` → R2 sync → build) turns
Frogbox clips into on-wall reels, but two things are missing:

1. **Flashcards** — the reels show raw action with a caption. We want data-driven
   graphic cards around a clip: a new batsman's season/career record, a fifty
   celebration ("first for the club"), a dismissed batsman's innings breakdown.
   Much of that content isn't typed by the editor — it's resolved from data.
2. **A published highlights video** — a single MP4 of the whole last-match package
   with **spoken commentary**, for YouTube. (Commentary is for the video only, not
   the wall.)

Both extend the two primitives already in place: the **curation overlay** (minimal
diffs keyed by clip id) and **`ball_events.select()`** (newest-first, per-innings,
pinned, capped). Cards add *intent* to the overlay resolved at build; the video adds
a new *consumer* of the resolved package.

---

## Roles

Two people, usually different:

| Role | Does | Access |
|------|------|--------|
| **Editor** | Picks clips, writes narrative, chooses cards, records per-beat audio commentary — all in one browser sitting. Exports one zip. | Website only. No repo. |
| **Publisher** | Lands the zip: syncs media to R2, commits, triggers the build, runs the compositor, uploads the MP4 to YouTube. | Local scripts + repo. |

The editor completes curation **and** commentary without a publisher step in between.
The handoff is a single zip.

---

## Timeline

| When | What |
|------|------|
| **Day 1** | Match played; Frogbox live stream on YouTube. |
| **Evening 1** | Captains finish their scorecards on Play Cricket. |
| **Night 1** | Overnight build produces the last-match package **without** video clips. Must still fetch Frogbox **ball-event metadata** (so Day-2 curation has a clip list) and resolve card data (from the just-built scorecard/stats). |
| **Day 2** | Editor curates + commentates on the website (clips previewed via the **YouTube stream**), exports the zip to the publisher. |
| **Day 2** | Publisher lands the zip; the rebuild adds clips + cards to the wall package and the compositor produces the highlights MP4 → YouTube. |

Because card data derives from Play Cricket (built Night 1), by Day 2 the editor sees
**real figures**, not placeholders.

---

## Feature 1 — Flashcards

### Model

Cards are **solid, full-frame beats** inserted before/after a clip. No blur-behind, no
video showing through. (A corner/lower-third overlay style is a deferred, additive
extension — an alpha overlay over sharp video — but is **not** in v1.)

The editor picks a card **type** from a registry and supplies only the params known at
curation time (e.g. which player). The content is **resolved at build** from existing
data, exactly as slides are.

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
- *(A `style` field is reserved for the future corner overlay; v1 renders solid
  full-frame only.)*

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

## Feature 2 — Highlights video

### Editor: narration

In the same sitting, a **narration mode** in the curate tool plays the assembled package
in order (clips via the YouTube stream, cards as real HTML, slides). The editor:

- advances **static beats** manually (captures a `dwell`),
- sets `fit` on **clip beats** (only matters when commentary outruns a clip's trim),
- records **per-beat mic audio** (audio-only `MediaRecorder`) — any single beat can be
  re-recorded without disturbing the rest.

Output is a `{pc_id}.narration.json` timeline plus the audio files:

```jsonc
{
  "clip_audio": "duck",
  "beats": [
    { "ref": "intro",              "audio": "a01.webm", "dwell": 6.2 },
    { "ref": "clip:3452112",       "audio": "a02.webm", "fit": "freeze" },
    { "ref": "card:3452112/post0", "audio": "a03.webm", "dwell": 4.0 },
    { "ref": "result",             "audio": "a09.webm", "dwell": 8.0 }
  ]
}
```

`ref` ids: `intro` / `scorecard` / `clip:<id>` / `card:<clip>/<pre|post><n>` / `result`.
`dwell` for static beats; `fit` (`freeze` = hold last frame / `roll` = let footage run)
for clip beats.

The whole export — `curation.json` + `narration.json` + audio — is a single zip.

### Publisher: deterministic composite (not screen recording)

The finished video is **assembled with ffmpeg from separate assets**, not captured from
a live playback:

1. Headless Chrome screenshots each slide and each solid card → PNG stills.
2. ffmpeg assembles the timeline: stills held for their `dwell`, R2 clips trimmed to
   `start`/`end`, `xfade` transitions, commentary audio placed on the timeline, clip
   audio ducked under a known gain → MP4.

Because every card is a **solid full-frame** still, nothing is composited *over* playing
video — no blur filter, no footage-dependent overlay. The result is frame-perfect,
reproducible, and runs without a GPU. The one hard requirement: the render plays **R2
clip files, not the YouTube embed** (an embed captures black; an R2 `<video>` composites
cleanly).

Trade-off vs. screen-recording the HTML playback: more code (a real compositor mapping
the narration timeline to an ffmpeg filtergraph, plus the HTML→still renderer), but no
generational quality loss, no dropped-frame risk, and deterministic re-renders. Solid
cards are what remove the only hard part of this route.

> **Deferred upgrade path:** if quality ever needs it, clip beats can move to a
> frame-accurate seek-per-frame renderer without changing the editor tool, the data
> model, or the card layer.

---

## Phasing

| Phase | Scope | Ships |
|-------|-------|-------|
| **A** | Card component + registry + resolvers; `/curate` Cards UI; `build.py` slots card beats into the on-wall reels. | Cards on the wall, independent of the video feature. |
| **B** | Editor narration mode: plays the package, captures `dwell`/`fit`, records per-beat audio, exports the zip. | The editor's one-sitting workflow. |
| **C** | Publisher `publish {pc_id} bundle.zip`: sync media to R2, commit, build, run the compositor, upload MP4. | The published highlights video. |

Order is **A → B → C**: A stands alone, B needs A's cards to narrate, C needs A+B's
timeline and audio to composite.

### Prerequisites

- The overnight build must fetch Frogbox **ball-event metadata** so Day-2 curation has a
  clip list; card data comes from the built scorecard/stats.
- The final render must use **R2 files**, not the YouTube embed.

### Deferred (non-blocking)

- Corner / lower-third overlay cards (additive alpha overlay over sharp video).
- YouTube upload automation (manual upload via YouTube Studio for now).
- Frame-accurate clip rendering.

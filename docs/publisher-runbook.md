# Publisher runbook — turning an editor's sitting into an MP4

> Who this is for: the person with the repo, the `.env` and the R2 credentials. The editor
> has a browser and nothing else. Design behind it: `docs/narrated-decks.md`.

The editor sends **one or two files**:

| File | From | Always? |
|---|---|---|
| `<name>.deck.json` | `/deck` → ⋯ → Export | yes |
| `<pc_match_id>.curation.json` | `/curate` → Export | **only if they curated clips or cards** — and this is the one that gets forgotten |

The deck names slides; it carries **no clip list**. A reel's contents come from the
curation overlay, through a build. That is deliberate — a clip list is not an atom list,
and only `build_video_slide`/`slide_atoms` turn one into the other. See "Clips reach a
deck by reference, not by copy" in `docs/narrated-decks.md`.

**So the steps below are a dependency chain, not a checklist.** Each one produces what the
next reads.

---

## The run

```bash
# 0. Fresh repo state
git pull

# 1. Land the curation  (skip only if the editor curated nothing)
cp ~/Downloads/7298980.curation.json content/data/matches/
git add content/data/matches/7298980.curation.json

# 2. Fetch everything the build needs  (content/data/fetched/ is gitignored,
#    so a machine that has not built recently has none of it)
python3 scripts/fetch_all.py

# 3. Sync the clips to R2 and update the manifest
python3 scripts/sync_videos.py

# 4. Build the site the render is shot against
python3 scripts/build.py

# 5. Render
python3 scripts/compose.py --deck-file ~/Downloads/1st-xi.deck.json -o 1st-xi.mp4

# 6. Publish assets — title, description, chapters, thumbnail
#    (match decks only, by slug — see below)
python3 scripts/publish_meta.py last-match-1st-xi
```

Then commit the curation and the manifest (`content/data/video_manifest.json`) so the
wall gets the same clips the video has, and upload the MP4 to YouTube by hand.

### Why that order

- **1 before 3.** `sync_videos.py` is curation-driven: it reads the *committed* overlay in
  `content/data/matches/` to decide which clips exist. An unlanded curation means the
  clips are not in the referenced set — so the sync would not just skip uploading them, it
  would **prune** any already in R2.
- **2 before 3.** The sync refuses to run when a curated match has no fetched ball-events
  file, for the same pruning reason. It names the fix: `fetch_ball_events.py --match-id <id>`.
- **3 before 4.** `build_video_slide` looks each clip up in `video_manifest.json` by
  fingerprint; without the sync the reel has no R2 sources.
- **4 before 5.** `compose.py` shoots static slides from the built `site/` in headless
  Chrome, and takes each reel's clips from the same build.
- **4 before 6.** The chapter timestamps come from the deck's derived timeline, so they
  are the ones the compositor actually rendered rather than an estimate.

### `fetch_all.py`

Runs every fetch the nightly workflow runs, in the same order.

```bash
python3 scripts/fetch_all.py                       # everything (what you want)
python3 scripts/fetch_all.py -n                    # print the plan
python3 scripts/fetch_all.py --list                # what each one is for
python3 scripts/fetch_all.py --only ball_events --match-id 7298980
python3 scripts/fetch_all.py --skip cs365_training --keep-going
python3 scripts/fetch_all.py --check-ci            # still in step with the workflow?
```

**CI keeps its eight discrete steps** rather than calling this script, so a failed fetch
names itself in the Actions UI instead of hiding inside a wrapper. The cost is that the
order is written down twice, so `--check-ci` compares the two and fails on any drift —
whether a fetch is added, dropped or reordered. Worth running after touching either file.

Two orderings inside it are load-bearing: `ball_events` and `league_fixtures` both read
`fixtures.json`, so they follow `fetch_fixtures`. Credentials come from `.env`, which each
fetch loads itself.

**Not included, deliberately:** `fetch_videos.py` and `sync_videos.py`. R2 sync is
publisher-local and reference-counted; CI never does it.

### Step 6: the upload assets

`publish_meta.py` writes everything the YouTube upload form wants into
`build/publish/<deck>/`:

| File | What |
|---|---|
| `title.txt` | Spoiler-free — fixture and date, no score, no winner. Degrades in steps under YouTube's 100 characters rather than being cut mid-word; the fixture is never sacrificed. |
| `description.txt` | Summary, chapters, result, top performers. |
| `thumbnail.png` | 1280×720. Needs Playwright; `--no-thumbnail` skips it. |
| `publish.json` | The same fields machine-readable, plus playlist, tags, category and recording date. |

It prints the title with its character count and the chapter count. **Fewer than three
chapters and YouTube won't show any** — it says so if that happens.

**Upload stays manual, deliberately.** `YOUTUBE_API_KEY` is an API key, which can only
authenticate read calls; `videos.insert` needs OAuth with the `youtube.upload` scope. More
decisively, uploads from an API project created after 28 July 2020 are locked to private
until a compliance audit, so an automated upload would produce a video nobody can watch.
`publish.json` is shaped so the API call can be added later without redoing any of it.

**It takes a deck *slug*, not a deck file** — `python3 scripts/publish_meta.py
last-match-1st-xi`. It derives the team from the slug (`^last-match-(.+)$`), the match from
`fixtures.json`, and the chapters from the built deck under `site/slideshow/<slug>/`. So a
**custom deck exported from `/deck` has no publish assets today**: write the title and
description by hand, or render the equivalent match slug alongside it and crib from that.
Extending it to deck files — and letting the editor author a title and description in
`/deck` — is phase 8; see "Publish assets" in `docs/narrated-decks.md`.

---

## What stops you getting it wrong

Three guards, each aborting or warning before the expensive part rather than after:

**A reel with no clips aborts the render.** This is the forgotten-curation failure, and
without a guard it produces a complete, plausible MP4 that is missing an innings:

```
  ⚠ Video slide(s) with no clips in this build:
      last-match-1st-xi-innings-1-reel  (match 7298980, innings 3950548)

    Land the editor's curation and rebuild, then re-run:
      cp <from-editor>/7298980.curation.json content/data/matches/
      python3 scripts/sync_videos.py && python3 scripts/build.py

  Aborting: this would render a video with an innings missing.
  Pass --allow-empty-reels if that is what you want.
```

**A curated match with no fetched events aborts the sync** (`sync_videos.py`), naming the
fetch to run. Override: `--allow-missing-fetch`, for a curation whose match has no stream.

**A deck older than the site warns** (`warn_build_drift`). Normal — the site rebuilds
nightly and league panels are *meant* to be current. What it is really watching for is the
dangerous case: **the team has played again**, so `last-match-*` slugs now name a different
match. There is no snapshot behind them; the render is the only freeze. If that has
happened, the deck cannot be rendered — see "Freezing, in three layers".

---

## What the render takes from where

Worth knowing, because it is the thing that surprises people:

| Part of the deck | Comes from |
|---|---|
| Which slides, in what order | the `deck.json` — frozen when the editor exported |
| A static slide's dwell, and any panels switched off | the `deck.json` — the editor's edits |
| What a static slide *says* | the site built at step 4 — shot live in headless Chrome |
| A reel's clips, trims, cards and durations | the site built at step 4 — refreshed out of the deck file |

That last row is `refresh_video_slides` in `timeline.py`. The editor assembles the deck
while their curation is still a draft in their browser, so the reel they exported is
usually **empty**; the render must read the reel the publisher's build produced, not the
one the editor exported. It is scoped to video slides because a reel's timing is the one
thing `/deck` will not let an editor edit — its duration cell is read-only and
`set-panels` refuses to subset it — so refreshing cannot lose an editor's decision.

---

## Checks worth making before uploading

- **Length.** `compose.py` prints the beat count and total; compare with what the editor
  saw in `/deck` (the deck summary reads `N steps · M:SS`).
- **Both innings present.** The guard above covers "no clips at all", not "fewer clips than
  the editor curated" — that would mean the landed curation is older than theirs.
- **The context flag.** `--ctx archive` is the default and is what makes slides say
  archive-appropriate wording instead of "Last Match". `--ctx wall` renders wall wording.
- **Audio.** `check_sync()` runs on every render and decodes the audio rather than trusting
  the header; it fails loudly on drift.
- **Chapters.** `publish_meta.py` prints how many it produced. Under three and YouTube
  shows none, which is worth knowing before you paste the description rather than after.

---

## Editor-side reminders worth passing on

- Export **both** files if they touched `/curate` at all.
- Export the deck **after** finishing curation. The deck itself carries no clips, so this
  does not matter for the reel — but the deck check's clip counts and the preview will be
  confusing otherwise.
- A narrated deck (phase 7) adds a third artefact and a zip; this runbook covers the
  silent render only.

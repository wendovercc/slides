# Live Match Presentation — Design

> Status: **agreed design direction, not yet built.** Planning source of truth for
> putting live in-progress match info on the pavilion wall. Companion to
> `docs/match-highlights.md` (the post-match reels/cards it borrows from) and the
> `project_live_slide_feeds` memory (feed sources, auth, field maps). Read
> `scripts/probe_live.py` (the live feed probe, incl. `--clips`) and
> `scripts/fetch_ball_events.py` (RV auth/fetch helpers) alongside.

## Goal

Show live match information on the wall while games are in progress:

- **Scores** for every match in progress (status, breaks, at-crease batters, last
  wicket, target/required rate).
- **Near-live highlight replays** — when a match is being streamed, a just-happened
  wicket clip interrupts the slideshow and plays.

Two presentation surfaces are wanted, and they are **two renderers over one
engine**, not two separate features.

## Data foundation (see the `project_live_slide_feeds` memory for the detail)

- **Source = Results Vault / Interact Sport** — the same backend that powers
  play-cricket.com's own live scorecard, and it carries **every PCS-scored match**
  (streamed or not, seniors + juniors). Poll `GET api.resultsvault.co.uk/rv/130000/matches/{rv_id}/?apiid=1003&strmflg=3`;
  map PC id → RV id via `mappings/4/12/{pc_id}/`. Polled REST/JSON, no push.
- **CORS-open** (`Access-Control-Allow-Origin: *`) and the `X-IAS-API-REQUEST`
  token self-mints from a **public** secret (already in Frogbox's own bundle) —
  so the kiosk browser can poll RV **directly, no backend**.
- **Highlight clips** = `matchStreams[0].MatchStreamHighlights`; each `embed_url`
  is a pre-trimmed ~30 s **`frogbox.tv` HLS `.m3u8`**, also CORS-open → playable
  directly with hls.js. **Streamed matches only.**
- Change cursor for the score poll = `scores_updated`; new-clip detection = a clip
  id not seen before (this is exactly what `probe_live.py --clips` does).

## Architecture — one engine, two renderers

### Live controller (lives in the player frame, `player-core.js`)

One controller, **not** per-slide, because only the player can pause the slideshow
and draw chrome across slides, and we want a single poll loop.

- **Poll loop** — port the `probe_live.py` logic to JS: mint the token client-side,
  poll RV on a timer (~15–30 s). This is a deliberate departure from the site's
  "no runtime fetch" principle, justified because it's a **public, CORS-open feed
  and ships no WCC secret**. A serverless proxy that polls and serves our own JSON
  is the clean fallback if Frogbox ever rotates the secret or closes CORS.
- **Live state = single source of truth** (`{ matches, clipsSeen, queue }`). Slides
  never poll; the live slide is a **dumb renderer** fed this state over the existing
  `slide-bridge` postMessage channel. Keeps the static/build-time model intact
  (player orchestrates, slides render).
- **Interrupt queue + HLS takeover** (the shared hard part): pause the auto-advance
  timer → take over with an hls.js player on the clip `.m3u8` → play ~30 s → resume
  where it left off. This is a **new video path**: the offline player caches R2
  MP4s; live clips are **ephemeral, single-play HLS** and must NOT go through the
  R2 cache. Chromium on the Pi can't play HLS natively → add hls.js.

Both presentations consume this state and share the identical interrupt. ~80% of
the work is done once, here.

### Interrupt policy (the lever that sets the feel)

Auto-pausing for every boundary is maddening in a busy innings. Gate the takeover
by event type:

- **Wickets → full takeover** (the real "stop and watch" moment).
- **Sixes → optional takeover** (decision needed).
- **Fours / others → never interrupt**; they feed the *ambient* surfaces (ticker
  "recent" list / over-break reel).

Queue rules (in the engine, inherited by both surfaces): **dedup by clip id**, drop
anything **older than ~2–3 min** (no stale replays after a loop), **cap the
backlog**, and with concurrent matches **attribute each clip to its match** and
enforce a minimum gap so two matches don't fight over the screen.

## Presentation A — full live slide (cards + reel)

- A **conditional slide** (`show_when` = "there are live matches"), rendered from
  the engine's state via `slide-bridge`. **One card per in-progress match**:
  teams/crests, live score, status/break, batters at the crease, last wicket,
  target / required rate. Two-up for the common Saturday 1st + 2nd XI case;
  carousel if ever more.
- **Over-break reel** — at an over boundary, instead of interrupting per clip, batch
  that over's clips into a short **reel** in the card's video region. Reuse the
  existing `video.html` reel component, sourced live from `MatchStreamHighlights`.
  Caveat: RV cloud has no clean "over ended" event — infer it from overs advancing
  or `over_no` resetting → treat as a **v2 refinement** on top of the v1 per-wicket
  interrupt.

## Presentation B — ticker / widget overlay

- **Player-owned chrome**, not a slide — drawn above the slide iframes so it
  persists across the rotation. Compact score(s), rotating if multiple matches.
- Placement (e.g. "under the sponsors on the sidebar") **couples to the layout
  variant** (sidebar / footer / fullbleed, per the TV design system). The player
  injects it into the sidebar region when that variant is active, with a safe-zone
  fallback for fullbleed slides that have no sidebar.
- **Open decision:** omnipresent on every slide, or player-suppressed on slides
  where it would collide (e.g. other video slides)?
- Same interrupt engine for the clip takeover — the ticker is the ambient state, the
  clip is the takeover.

### Who decides it is up — the wall and the hand differ

The chrome grows itself on first live content and holds for a 12-minute quiet
debounce (`onLiveState` in `templates/player.html`). That stickiness is a property
of an **unattended** screen: nobody is standing at a wall to ask, and a television
that reflows at every innings break is worse than one that never does.

**In a hand the reasoning inverts.** The reader is there, and taking `--live-band`
of their slide for a ticker they did not ask for is a rule written for a wall making
a decision on their behalf. So on an interactive surface the latch is only the
**default**, and the control bar carries a live button that overrides it
(`WccPlayer.setLiveToggle` — the player learns nothing about live; it offers a
button and reports the press). Three rules hold it together:

- **A press pins for the session** (`_livePinned`). The latch keeps running and
  stops steering.
- **Never persisted.** A stale "live: off" carried into a match day by localStorage
  is a worse failure than pressing a button twice — the reader could not tell the
  feature from a broken one. The daily reload is the reset.
- **The button appears only once the feed has content**, so it is not a dead control
  on the six days a week with no cricket on it, and it is withdrawn in portrait,
  where the chrome it toggles does not exist (see `docs/portrait-decks.md`).

**The wall is protected structurally, not by a flag**: kiosk, record and hosted
players never build a control bar, so they can never be pinned and keep the
automatic behaviour above untouched. `setLiveToggle` is a no-op without one.

## Presentation C — the live strip (left band)

The vertical partner of the ticker footer: the same player-owned chrome, showing
**where the day is leaving the league table** rather than the score of any one ball.

- **One equal tile per team**, in current league position order. Channels: fill
  **colour** = result lean (the points green/red, never washed out), fill **height**
  = certainty, bat/bowl glyph = live role, clock = decided but not yet published,
  muted dot = match on but the feed is silent, dimmed tile = no match today, ghost
  arrow = a *pending* move the table hasn't taken yet.
- A match with no ladder behind it (friendly, cup, junior) collapses to a **two-tile
  view** that reads top-to-bottom as the match itself: the side that batted first,
  the **target** they set (appearing the moment that innings closes), the side
  chasing it, then full-size **chase stat tiles** — runs left / balls left /
  required rate / wickets left.
- Those chase stats **outlive the match**. Once it's decided the same numbers say
  how it finished (what was still needed, with how many wickets and balls left)
  under a **FINAL** caption, with the tiles a touch quieter. The caption carries the
  meaning: muting alone would read as stale data rather than a settled result. The
  required rate is the one live-only stat — there's nothing left to require it over.
- **Baked vs live:** the build bakes only *context* (today's matches, their
  divisions, the day's fixtures in them — `build_live_strip`). Every channel above
  is derived at runtime in `templates/live-strip.html` from the two feeds the player
  broadcasts: `wcc-live` (our matches, ball-by-ball, keyed by `pc_id`) and
  `wcc-league` (the division's other matches, coarse, keyed by `match_id`).
- **Which match is on show:** the ticker announces its current segment as
  `wcc-featured`, the engine relays it, and the strip ladders that match's division —
  so the two chrome surfaces never sit on different games. Standalone, or before the
  ticker speaks, the strip cycles the matches that have something live.
- **Win probability** drives the fill height, the ghost arrows and the reorder. It
  comes from a chase model: DLS-style par, then a logistic on runs-vs-par whose
  spread closes as resources run out — so an early chase sits near 50/50 and settles
  on its own. The resource table is an **approximation** of the Standard Edition,
  good to a few points; fine for a fill height, not for deciding anything. First
  innings gets a role glyph and no lean — there's nothing honest to say yet.

### How the ladder moves

Three orders, each doing a different job:

- **Display** — where tiles actually sit. League order, with a swap applied only
  when **both** teams involved are final (settled, or not playing at all). An
  unfinished match is a barrier: nothing may jump a team whose result is still
  unknown. So the ladder moves **once, when it's earned**, rather than moving on one
  result and moving back an hour later when another lands.
- **Baseline** — every unfinished match priced at its neutral expectation.
- **Projected** — the same, priced at what's actually happening out there.

The **ghost arrow is baseline → projected**, so it means *"how today is going versus
what was expected of it"* — not *"who has a fixture"*. At the first ball the two
orders are identical and the strip is arrow-free; arrows appear only as matches
diverge, and grow with certainty. Arrows carry the number of places (`▲3`), bare for
a single place. A settled team shows no arrow: it has nothing pending, and its tile
has already moved. Committed moves FLIP-animate — the movement is the information,
so a jump-cut would waste it.

**A loss is not zero points.** TVCL pays the beaten side batting and bowling bonuses
— a team bowled out for 150 that took 6 wickets still banks 8 — so an unfinished
match is worth `p × 22 + (1−p) × ~7`, and even a near-certain defeat has value. Once
a match is decided the estimate is replaced by the real figure from `tvclPoints()`.
The strip carries a **port** of that function (the division's other matches arrive on
the lean PC feed with no points attached); `live-worker/src/rv.mjs` is the authority
and holds the unit tests — keep the two in step.

**The double-count trap.** The ladder overlays today's points onto a league table
baked at build time. If a build runs *after* a result publishes, that match is in the
table **and** gets its points added again — the tile jumps twice. `fetch_play_cricket`
now stamps each table with `fetched_at`, and the build sets `table_counts_today` when
the snapshot may already include the day's results; the strip then shows the league's
own order and no arrows rather than a wrong ladder. Non-TVCL divisions likewise never
reorder — a result we can't price leaves that team non-final, i.e. a barrier.
- **Innings allotment** is inferred from how the first innings closed (neither bowled
  out nor declared, stopped on a whole over), never from a `max_overs` field. Unknown
  allotment → the chase model falls back to a wickets-only read with a low certainty
  ceiling, and the panel drops "balls left".

### Testing it without a live match

There is no cricket most days and none at all out of season, so the strip has a
simulator that drives the **shipping** render path — not a parallel mock — by
fabricating the two feeds in the Worker's normalised shapes:

```
WCC_TODAY=2026-08-08 WCC_LIVE_ENABLED=1 python3 scripts/build.py   # a league Saturday
open http://localhost:8000/live-strip/?sim=league                  # or ?sim=friendly
```

One tick = one over, so a full round of the division plays out in about three
minutes, passing through every tile state (roles, a chase turning either way, a
decided-but-unpublished result, a silent feed, a team with no match). The build must
have baked views for the chosen day, hence `WCC_TODAY`. See
`assets/js/live-strip-sim.js`.

## Player-profile enrichment (a third opportunity)

When the live feed shows a **new batter at the crease** (a dismissal opens a gap and
a new not-out name appears) or a **new bowler starting a spell** (the current bowler
changes between polls), that's a natural cue to surface that player's **profile
card** — photo, role, season stats, the jokey Q&A — as an ambient card on the live
slide or a brief mini-takeover.

- **Detection** is free from data we already poll: diff the at-crease batters /
  current bowler between polls (both derivable from `MatchTeams[].Innings[].PlayerPerfs`).
- **Depends on the player-profiles feature**, which is **unbuilt** — see the
  `project_player_profiles` memory and the `player-{slug}` set sketch in the
  `project_ball_events_plan` memory. For our players we have the profile; for
  opposition we'd fall back to name + role only.
- Spoiler-free and additive — a clean third enrichment beyond scores and clips.

## Cross-cutting truths

- **Streamed vs not degrades cleanly.** Scores exist for *every* PCS match, so the
  ticker and the live slide's cards work **on non-streamed days** (e.g. Saturday
  league games). Highlight clips / interrupts / profile-on-clip only exist when a
  Frogbox stream is running. Both surfaces must render gracefully with **zero clips**.
- **No spoiler problem** (unlike the last-match reels): during a live match the score
  and the just-happened wicket are *wanted* — drop the spoiler-ordering machinery.
- **SIM / connectivity:** polling + live HLS costs data; if the link drops, the whole
  live layer should silently vanish back to the normal slideshow (ties into the
  offline player model in `docs/player-offline-architecture.md`).

## Build order

1. **Shared engine** — client-side RV poll + live state + interrupt/HLS takeover.
   Nothing renders yet; verify with a synthetic clip event.
2. **Ticker** — highest value-per-effort, always-on, delivers *scores* even on
   non-streamed days. Ship first.
3. **Full live slide** — match cards, then the over-break reel as a v2.

**Open decisions before building:** (a) which events take over the screen
(wickets-only, or wickets + sixes?); (b) ticker omnipresent vs player-suppressed on
certain slides. Both are cheap to change but set the engine's contract.

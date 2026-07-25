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

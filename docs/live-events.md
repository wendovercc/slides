# Live Events — the v2 model

> Status: **substrate built, chrome not yet converted.** The event store, the
> extractors, the interest model and the scheduler ship in
> `assets/js/live-events.js` and run on every poll; the inspector slide
> (`templates/slides/live-events.html`) renders them. The ticker, the context tile
> and the strip still render *current state* and are untouched — converting them is
> the next step. Companion to `docs/live-presentation.md` (the v1 surfaces this
> replaces the innards of) and `docs/match-highlights.md` (the clips it absorbs).

## Why

The v1 live chrome renders **current state**. The ticker cycles whatever the latest
poll says the score is, on a fixed nine-second timer; the strip paints where the
league table stands. That is the wrong unit for a screen someone glances at across
a room. What a glance wants is **what just happened**.

So the feed stops being the thing we render and becomes the thing we
**differentiate**. The chrome becomes a scheduler over a stream of events.

Three consequences fall straight out of the change, and they are the point of it:

- **A fixed cycle is gone.** Nine seconds was spent equally on "Wendover 4/0" and
  on a hundred. Dwell now comes from the event.
- **"Nothing" becomes sayable.** When no event is worth a screen the chrome
  collapses, instead of looping stale scorelines at an empty afternoon.
- **The news flash stops being a separate feature.** An event that carries footage
  *is shown by playing the footage* — the slideshow gives way, the clip runs, and
  the ticker beside it describes that same event rather than drifting on its own
  timer. "Show this event" is one verb whose shape depends on what the event has.

**So the L-frame survives a takeover.** Under v1 a clip was a full-bleed interruption
and the chrome was in its way, so the flash covered the whole stage. Under v2 the clip
and the L are two parts of one presentation of one event: the footage shows what
happened, and the L says whose match it was, what the score is and what it did to the
table. Covering the context in order to show the picture threw away the half that
explains it. The flash now takes the **slide's** retracted box instead of the stage, so
the ticker and strip stay beside it — still 16:9, because that box is a uniform scale of
a 16:9 stage (`body.live-chrome iframe.flash` in `templates/player.html`).

## The event record

```
id            stable, deterministic; the dedupe key
type          one of the table below
match         { key, ours, pc_id, match_id, team, opponent, division, title }
happened_at   [from, to] — when it happened out on the field
received_at   when THIS client learned of it
shown_at      when the chrome last showed it; null = never   (+ shown_count)
interest      0..n, fixed at extraction: how much this deserves a screen
payload       { headline, detail, … } — what it takes to render
clip          { id, url, event, duration } or null
dwell         ms, derived from the payload or the clip
```

### The three timestamps

The distinction between them is the whole design.

- **`happened_at` is a range, because a poll only brackets it.** The event happened
  somewhere between the scorer's previous sync and this one. RV stamps each match
  with `scores_updated` — the scorer's own cursor — so the bracket is the scorer's,
  not our poll timer's: tighter, and still right when a poll is late. With no cursor
  on either side the event is **unbracketed** (`from` null), and the inspector says
  "unknown" rather than showing a plausible-looking number.
- **`received_at` is always known**, and is not redundant. A device that joins late
  holds events it has never shown, which is a different thing from an event it
  showed an hour ago.
- **`shown_at` is what stops the surface repeating itself** — and what lets it repeat
  deliberately when there is nothing newer.

**Freshness decays from when the event happened, not from when we heard about it.**
The two differ exactly where it matters: footage of a wicket from twenty overs ago
arrives now, and announcing it as the latest news is a lie the room can see out of
the window.

**But backdating is bounded** (`MAX_BACKDATE`, 15 min). `scores_updated` comes from
the scorer, and a scorer who stopped syncing an hour ago still yields a healthy poll
— the trap `rv.mjs` already warns about for the today board's status column. Taken
literally, every event from such a feed is born an hour old, scores zero, and the
chrome collapses on a match day while we have in fact just learned all of it. The
bound is longer than the newsy TTLs (an old six is stale either way, so footage
cannot pose as breaking news) and shorter than a result's, so a result we hear late
still gets the screen it deserves:

| event | happened | received | freshness | shown |
|---|---|---|---|---|
| `match_finished` | 60m ago | just now | 0.44 | yes — lagging scorer, real news to us |
| `match_finished` | 60m ago | 60m ago | 0.00 | no — genuinely old |
| `six` | 60m ago | just now | 0.00 | no — late footage is not news |
| `wicket` | 2m ago | just now | 0.36 | yes |

## The type table

`base` is interest before context. `ttl` is how long it stays news. `repeat` is how
long before an already-shown event may be shown again (null = never).

| type | base | ttl | repeat | source |
|---|---|---|---|---|
| `hundred` | 92 | 15m | 7m | batter's runs crossing 100 |
| `five_for` | 90 | 15m | 7m | bowler's wickets crossing 5 |
| `match_finished` | 88 | 45m | 5m | `complete` false→true, and `final` false→true |
| `abandoned` | 84 | 45m | 10m | result text matching abandon/no result/wash |
| `innings_closed` | 74 | 15m | 5m | a new innings appears — **this is when a target exists** |
| `wicket` | 70 | 5m | 3m | `wickets` moving, described by `last_wicket` |
| `fifty` | 64 | 8m | 5m | batter's runs crossing 50 |
| `ladder_shift` | 60 | 15m | 7m | **announced by the strip** (see below) |
| `rain_break` | 56 | 30m | 10m | `break_desc` matching rain/weather/wet/shower |
| `six` | 52 | 4m | 3m | batter's `sixes` counter moving |
| `probability_shift` | 48 | 7m | 5m | chase model's `p` moving ≥ 0.15 between polls |
| `toss` | 40 | 30m | never | `toss` appearing |
| `four_clip` | 36 | 4m | never | `fours` moving — earns a screen mainly with footage |
| `innings_update` | 22 | 7m | never | every 5th over |
| `ball_clip` | 20 | 3m | never | a clip nothing else claims |
| `score_update` | 12 | 3m | never | every whole over, our matches only |

The last two rows are **the floor, and they are not pretending to be news**: they
are what keeps a screen truthful when nothing has happened for ten overs. Their
interest is low enough that any real event outranks them.

### Supersession — a stale snapshot is wrong, not merely old

`score_update` and `innings_update` describe **current state**, so a newer one does not
merely outrank its predecessor, it makes it **false**. "Chalfont 9/0 (2 ov)" is not old
news once 17/0 lands; it is a wrong score, and a surface showing it is lying to the room
whatever its freshness works out to. Adding one of these retires every earlier one of
the same type for the same match: `superseded` events score **0** and can never be
picked, and they are the first thing evicted when the store fills, being owed nothing.

**Incidents never supersede**, and the distinction matters: a wicket is still a true
account of a wicket an hour later, and a second wicket does not unmake the first. Only
snapshots retire — exactly the set the table above already calls the floor.

**A dwell protects an event, not a falsehood.** The hold exists so a clip is not cut off
mid-wicket by a six landing elsewhere; but if what is on screen has since been
superseded, holding it keeps a wrong score up on purpose, so a superseded pick loses the
screen at once rather than serving out its dwell.

**Time and data must land together.** Announcing a clock step before the poll it belongs
to had the scheduler decide against a store that did not yet hold that poll's events — so
it picked the previous over's score, started its dwell, and was then holding a score the
next instant made obsolete. The simulator advances the clock quietly
(`WccClock.advance(ms, quiet)`) and lets the ingest broadcast the end state once.

### Interest, and why context cannot promote

```
interest = base
         × 0.55  if it is not our match      (OTHER_CLUB_FACTOR)
         + 12    if it carries footage       (CLIP_BONUS)
         + 18 × tension                      (how tight the match is, from the chase model)
         × magnitude                          (how big a swing / how many places)
         clamped to base × 1.25
```

**The clamp is load-bearing.** Left off, a tense wicket with a replay attached
scored 92 — level with a hundred and above a finished match — so a routine
dismissal with footage outranked the best individual performance of the season. The
type table is the claim about what matters; context orders events *within* a tier,
it does not rewrite the tiers.

`tension` is `1 − |2p − 1|` from the chase model: 1 on a knife edge, 0 once decided
in all but name. A first innings has no honest answer and reads as middling (0.35).

## The scheduler

One question, asked every tick: **what should be on screen?**

```
score = interest × freshness × novelty

freshness  1 while new, → 0 across the type's ttl, squared so the tail is shallow
novelty    1 if never shown; 0 inside the repeat window; 0.45^shown_count after it
```

- **Below `SHOW_FLOOR` (8), nothing is shown and the chrome collapses.** The floor is
  what makes an empty afternoon read as empty instead of as a loop.
- **An event holds the screen for its whole dwell.** Re-deciding every tick would cut
  a clip off mid-wicket because a six landed elsewhere.
- The inspector renders the **whole ranking**, not just the winner — a ranking you
  cannot see is a ranking you cannot tune.
- **The showing event reports the numbers it won with**, not current ones. Being shown
  sets `shown_at`, which drops novelty to zero, so the live figures for the current pick
  are always `N=0, score=0` — making the one row you most want to understand the one row
  that tells you nothing. `tick` captures the winning `{score, freshness, novelty}`
  before it marks the event, returns them as `picked`, and `rankedForDisplay` substitutes
  them into that row. The substitution re-sorts, or the row sinks to the bottom on its
  post-mark zero and falls out of the capped list the engine ships. The row carries
  `at_pick` for a consumer that cares; the inspector does not annotate it, because the
  highlighted row already *is* the marker — "picked" and "showing the values it was
  picked on" are the same fact.

  The inspector prints these through a `factor()` helper rather than trimming the leading
  zero off `toFixed(2)`: that shortcut turned **1.00 into ".00"**, exactly what 0.00
  rendered as, so the two ends of the scale meant opposite things and printed the same.
  `1` and `0` now say so plainly and fractions keep the short `.85` form.

### Dwell

Two regimes, and the event's own content picks which:

- **Footage runs for as long as the footage runs** — clip duration + 2.5s, a beat
  either side.
- **Text runs for as long as it takes to read** — 55ms/char, clamped to 4–14s.
- **…with per-type floors.** Reading time is the wrong measure for a short sentence
  that matters: "Wendover won by 3 wickets" is read in two seconds and deserves to
  sit there anyway. `match_finished` and `hundred` floor at 9s, a wicket at 6s.

## The clock

Every time-dependent judgement reads **`assets/js/live-clock.js`**, never `Date.now()`
directly: the engine's ingest and broadcast, the store's freshness and novelty, and the
simulator's `scores_updated` and clip timings. That single indirection is what lets the
clock be frozen and stepped by hand.

**Production is untouched.** Left alone the module is `Date.now` with one function call
in front of it; `manual` is only ever turned on by the simulator, nothing in the
shipping chrome can reach it, and `advance`/`set` are no-ops on a real clock. A
consumer that loads without the module falls back to `Date.now()`, so it is never a
hard dependency (see the asset-cache-skew note).

Freezing keeps the instant it was frozen *at* rather than resetting to zero, so the
day so far stays as old as it really is and ages remain meaningful. A time jump fires
`onChange`, which makes the engine rebroadcast at once — waiting up to a tick to
reflect a keypress reads as a broken control.

The module exposes `advanced()` (stable, safe to display) and `skew()` (the distance to
the wall clock, which drifts by the second and is for diagnosis only, never for a
surface).

## Where events come from

```
                 ┌──────────────── live-engine.js (one loop, player frame) ───────┐
  RV / Worker ──▶│ poll ─▶ hold previous snapshot ─▶ extractLive ──┐               │
  PC  / Worker ──▶│ poll ─▶ hold previous snapshot ─▶ extractLeague ┤─▶ store ─▶ tick│──▶ wcc-events
  the strip ─────▶│ addLadderMove ─────────────────────────────────┘               │
                 └───────────────────────────────────────────────────────────────┘
```

- **`extractLive`** diffs two `wcc-live` polls — the rich RV feed, so wickets with
  names, per-batter milestones, bowling figures, breaks, results, clips.
- **`extractLeague`** diffs two `wcc-league` polls — deliberately thin, because
  PC-API is thin: a result, an innings closing, a coarse scoreline. A chrome that
  only looks right on the rich feed breaks on five of the six matches it shows.
- **`prev` null yields no change events.** Everything in the first poll of a session
  already happened before we were watching, and announcing a morning's wickets at
  once is the bug that guards against. Standing *facts* (the toss, a result already
  posted) are still emitted — those are states, not changes.
- **A later start is not a first sighting.** A match beginning at three o'clock has
  been in the feed since breakfast as a fixture with no toss, so its toss arrives on
  an ordinary poll; it is detected as `toss` appearing, not by the `!prev` branch.

### Clips join events; they are not events

A clip is footage **of** something, so it joins the event it shows — matched on
kind and player within the match — and only stands alone when nothing claims it.

**The join must reach back past the current poll.** Footage lags the scorecard: the
wicket is in the feed a poll or two before the clip of it is. Searching only this
poll's batch finds nothing and emits a second, duplicate wicket, which is exactly
what happened before `cfg.recent` existed.

An event the chrome has **already shown** is not amended in place — the footage is
new information the room has not seen, so it goes on to earn its own screen rather
than being folded into a line already read out.

### `ladder_shift` is announced, not derived

The strip owns the ladder: it has the baked league table, the baseline/projected
orders and the `tvclPoints` port. Re-deriving all that in the extractor would be a
second copy of the thing `docs/live-presentation.md` already warns about. So the
strip calls `WccLive.handle.addLadderMove(move)` when a move commits, and the store
takes it like any other event.

**That wiring does not exist yet.** The simulator stands in for it, which is enough
to design the scheduling against — what matters is that a ladder move *competes*
with a wicket for the screen, not where the number came from.

## Testing it: the match-day simulator

There is no live cricket most days and none at all out of season, so
`assets/js/live-sim.js` is the whole day in a few minutes.

```
python3 scripts/build.py
cd site && python3 -m http.server 8000
open 'http://localhost:8000/slideshow/live/?sim=matchday'
```

**It arrives with time held** and the first poll already on screen (the engine polls
once on start, so there is a toss to look at). Nothing moves again until you ask it to
— which is the state you want on arrival, rather than a running day you have to catch.
Add **`&play`** to start it running instead, for simply watching an afternoon go by.

**Data arriving and time passing are separate controls**, because they are separate
questions and every judgement the model makes — freshness decaying, a repeat window
reopening, a dwell running out — is a function of the second. Holding the clock is
what makes the algorithm legible: a ranking sits still long enough to read, a dwell
stops expiring under you, and ten minutes of ageing is two keypresses rather than ten
minutes.

| key | |
|---|---|
| **data** | |
| `n` | one poll forward, carrying the time it took (+15s) |
| `N` | one poll at the **same instant** as the last — no time passes |
| `a` | autoplay on/off (starts on) |
| `[` `]` | slower / faster (4s → 0.5s per poll) |
| **time** | |
| `k` | hold / release the clock (holds the whole screen; **held at boot**) |
| `.` / `>` | push a held clock on 30s / 5m, with **no new data** |
| `,` | pull it back 30s, to re-watch a decision |
| | |
| `r` | restart the day |
| `h` | hide/show the clock HUD |

**These avoid every key `player-core.js` binds** — Space, `←`, `→`, Home, End,
PageDown, Escape and `f`/`F` (fullscreen). Both keydown listeners sit on the same
document and both fire, so a shared key makes one press do two unrelated things: `f`
held time *and* went fullscreen, and Space and `→` stepped a poll *as well as* driving
the deck. The deck's transport is now left alone — Space still plays/pauses it, `→`
still moves it on. Check the two lists against each other before adding a key.

`n` carries time with it by default, and that default matters: on a real afternoon
data does not arrive with zero elapsed time, and if it did, every event in the store
would share one timestamp and every `happened_at` bracket would be zero wide — the
model would look like it worked when it had nothing to work on. `N` is the deliberate
exception, for looking at how simultaneous arrivals rank.

### Holding time holds the whole screen

A hold that only stopped the scheduler's clock would be a lie about most of what is
moving, so `f` stops all of it:

- **The deck stops advancing** (`WccPlayer.setPlaying(false)`), so it cannot walk off
  the thing you were reading. The previous play state is remembered — releasing must
  not start a deck that was already paused.
- **The ticker's segment cycle and the strip's view cycle stop.** Those are the
  surfaces' own timers and owe nothing to the feed, so they would otherwise keep
  rotating through a "held" screen. The engine broadcasts `wcc-clock`; each surface
  clears its interval and sets a `clock-held` class that pauses CSS animations too —
  the pulsing live dot included.
- **Autoplay stops**, since its whole premise is that time passes on its own.

**Nothing on a held screen may show a moving number.** The distance between a frozen
clock and the wall clock grows a second every second, so it is never displayed; what
the HUD and the inspector's **time held** badge show is `advanced()` — how much time
has been *stepped by hand* since the hold — which changes only on a keypress. The
inspector shows the badge whenever the clock is not real, because otherwise every age
and score on it would look like a live afternoon that had quietly stopped making
sense.

It drives the **shipping** path, not a parallel mock: a deterministic ball-by-ball
simulation becomes the exact feed shapes the Worker emits (`rv.mjs` for ours,
`pc.mjs` for the league's), handed to the real engine through its `transport` seam.
The engine polls, holds, differentiates, schedules and broadcasts — all shipping
code. `transport` also stands in for the access gate, because there is no Worker to
authorise against, and `manual` hands the clock over so a key press steps the day.

**No build inputs needed** — it invents the day, so it works in December on a repo
with an empty `live-config.json`. But if the build baked a real day it **adopts its
identities** (pc_ids, team names, opposition, division, home/away) and simulates
those, because the `live-match-{team}` slides are each bound to a baked `pc_id`:

```
WCC_TODAY=2026-08-08 WCC_LIVE_ENABLED=1 python3 scripts/build.py
```

One poll = one over. One run passes through every state worth seeing: a toss, a
first innings, a target set, a chase turning both ways, fifties, a **hundred** and a
**five-for** (guaranteed by `beats`, which bias the dice and the overs rather than
writing figures into the card), clips arriving late, a rain break that actually
stops play, an abandonment in the division, a match nobody is scoring, a
decided-but-unconfirmed result and a confirmed one.

The numbers are meant to be believable — about 5.5 an over, a dozen-odd fours, a
couple of sixes, nobody bowling more than a fifth of the innings. An early version
produced 500-run innings, which makes every milestone and every chase calculation
nonsense.

## The inspector slide

`live-events`, in the Match Day deck (`content/slideshows/live.json`), right after
the two senior live-match slides. It renders the `wcc-events` broadcast: the
scheduler's pick at the top (with **why** it won and its dwell), then every event
newest-first with all three timestamps, interest, freshness, novelty and score. Rows
below the floor are dimmed — those are events the chrome will not show. Superseded rows
are struck through; the current pick is highlighted, and shows the numbers it won with.

Nothing is baked into it, so it is honestly empty on a day with no cricket.

### Next: the showing block becomes a preview of the L-frame

**This is the next piece of work.** The "showing" block currently says *which* event won.
It should also say **what each of the three surfaces would do with it** — the ticker's
text, the strip's panel (which one, and its contents), the gold tile's context line —
rendered from the split described below.

The point is to get the decomposition right **before** moving the production chrome onto
v2. With it, the per-type panel mapping stops being a thing to reason about and becomes a
thing to look at: hold the clock, step a whole simulated day, and read off what the
L-frame would have said for a toss, a four, a rain break and a ladder shift in turn.
Getting that wrong in the inspector costs a keypress; getting it wrong in the chrome
costs a match day.

## Splitting a showing event across the three surfaces

> James's design direction, recorded 2026-09-24. **Not built** — this is the shape the
> chrome conversion should take, and it supersedes the working assumption in open
> question 2 below.

The L-frame is **one presentation of one event**, not three renderers that happen to be
on at the same time. When the scheduler picks an event, its parts are distributed by
*kind of information*, and each surface always does the same job:

| surface | carries |
|---|---|
| **Ticker** — the bottom bar | the **text**: the event description |
| **Strip** — the side bar | the **match score / chase position** |
| **Gold tile** — bottom left | the **context**: the Wendover team, or the league/division |

Worked through for a `ladder_shift`, which is the case that shows why the split is by
kind and not by surface:

- **ticker** — the description: *"Wendover CC up 2 places to 4th"*
- **strip** — the league ladder position
- **gold tile** — the league/division

So the strip is not a second scoreboard with its own opinion; it shows *this* event's
match. The tile names *whose* it is. The ticker says what happened. **The three parts of
the L-frame work in tandem to best describe the event being presented** — that is the
whole rule, and everything below follows from it.

### The strip has panels, and the event type picks one

A chase position and a league ladder **never share the band**. The strip shows one panel
at a time, and which one is a property of the **event type**:

| showing | strip shows |
|---|---|
| a four, a six, a wicket | the match score / chase position |
| a ladder shift | the league ladder |

**This is an open set, not a pair.** The real question a panel answers is *what best
completes this event*, and for some events the answer is neither of the two that exist
today — because the score is not interesting, or does not yet exist at all:

- **At the toss there is no score.** A chase panel reading 0/0 off nought overs is worse
  than useless. **Previous match form** — how the two sides have been going — is the
  thing that actually frames a toss, and the data is already baked (`form` in
  `player_stats_this_season.json`, five results a team, already on the tale of the tape
  and the next-match slide).
- **A new batter or a new bowler** (open question 5) wants that player's profile, not a
  scoreline; the event is about a person.

So the panel set will grow, and the type table is where each type says which one it
wants. Designing it as a binary now would be designing in the thing that has to be
undone first.

**The grey area, deliberately unsettled:** for a *league* match there are event types
that could reasonably go more than one way — a toss, a rain break, a five-over innings
update. The ladder may be the more useful thing to have up during those, with the score
carried by the ticker's text instead. That is a per-type choice to be made by looking at
it, not reasoned out in advance, and the inspector plus the simulator are how to look at
it.

Two consequences worth stating now:

- **The panel is a per-type property**, so it most likely belongs in the type table
  alongside `base` / `ttl` / `repeat` rather than in the strip's own code — one place
  where "what does the whole L-frame do for this kind of event" is answered, and one
  place to add a panel to when a new kind of event wants one.
- **Availability overrides the request.** A friendly, a cup tie or a junior game has no
  league table, so a type asking for the ladder falls back to the chase position; a team
  with no form recorded falls back likewise. The strip already behaves this way for the
  ladder, which is where the two-tile chase view came from. Every panel needs its
  fallback stated, not just its trigger.

**Two things already point this way**, which is part of why the split is the natural
one:

- the gold tile is *already* context-only — team name with the division as its subtitle
  (`.tick-live` in `templates/live-ticker.html`), fed from `live-config.json`;
- the strip *already* renders a chase position rather than a ladder for a match with no
  league behind it — the two-tile friendly view with its runs / balls / wickets / required
  rate tiles. That is the beginning of "score and chase position live in the strip",
  built for a different reason.

What this changes when the conversion happens: the ticker loses `buildSegments` and its
nine-second cycle and renders whatever the scheduler hands it; the strip keeps its tile
grammar but takes **which match it is showing** from the event rather than from its own
cycle (the `wcc-featured` relay already does exactly this, so the mechanism exists); and
the tile keeps doing what it does, driven by the event's `match` rather than by the
ticker's current segment.

**But not yet.** The order of work is: put this decomposition in the inspector's showing
block first (see above), settle the per-type panel mapping against a stepped simulated
day, and only then move the production chrome onto it.

## Open questions

1. **Which events take over the screen.** Footage currently means takeover. Every
   wicket clip pausing the slideshow may be too much; `six` + `wicket` only, or a
   minimum gap between takeovers, are both one constant away.
2. **Which strip panel each event type asks for, and what the panel set is.** *The
   frame is settled* (see above): the strip takes its subject from the showing event and
   shows exactly one panel. Open is the mapping in the middle — a four clearly wants the
   score and a ladder shift the ladder, but a toss, a rain break or a five-over update on
   a league match could sensibly show either — and the set itself, which is not just
   those two: a toss wants **recent form**, a new batter wants a **player profile**.
   Also open: what the strip does for an event with no match behind it at all.
3. **The weights are a starting position**, deliberately spread so the *ordering
   between tiers* is the claim rather than any exact number. The inspector exists to
   argue with them.
4. **`score_update` volume.** Every whole over of every match of ours is the floor
   keeping the chrome alive; 200-odd in a day is a lot of store for events almost
   none of which will be shown. Capping or collapsing them per match is untested.
5. **Player profiles on a new batter / new bowler** (see `docs/live-presentation.md`
   and the `project_player_profiles` memory) are two more event types waiting on an
   unbuilt feature.

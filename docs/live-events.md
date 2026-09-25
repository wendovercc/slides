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
day so far stays as old as it really is and ages remain meaningful. The simulator then
parks it on **today's date at the day's opening time**, so the whole fiction shares one
time base and nothing comparing the held clock with the real one sees a date months out.
A time jump fires
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

**It arrives paused** at the start of the day with the first poll already on screen
(the engine polls once on start, so there is a toss to look at). Nothing moves again
until you ask it to — which is the state you want on arrival, rather than a running day
you have to catch. Add **`&play`** to start it running, or **`&at=16:20`** to begin part
way through the afternoon.

### One axis, and it is the day's own clock

**Sim time — milliseconds since the day began — is the only state the controls move.**
Which over each match is in, how old an event is, when the feed last spoke and what the
scheduler thinks "now" is are all functions of it, so there is one thing to move and
"paused" has one meaning: nothing is moving, the deck included.

| key | |
|---|---|
| `k` | play / pause (**paused at boot**) |
| `c` | straight to **the next change on screen**, at full speed |
| `[` `]` | slower / faster (×15, ×60, ×240 real time) |
| `.` or `n` | one poll on (15s while play is on, 30 either side of it) |
| `>` | five minutes on |
| `o` | to the next over anywhere in play |
| `e` | to the next incident — the markers on the bar |
| `b` | a minute **back**, which restarts the day there |
| | |
| `r` | restart the day |
| `h` | hide/show the HUD |

`c` goes to the moment the scheduler next changes its mind about what to **show**, and it
is the one to watch the chrome against. It is a different question from `e`, which goes to
the next thing that *happens*, and the two come apart constantly: a wicket arriving
mid-dwell waits its turn, a dwell expiring with nothing new promotes something from ten
minutes ago, and a superseded pick loses the screen with no new event at all. None of it
can be worked out in advance — it depends on the store's state at the instant it is asked
— so the day is **run** until it happens.

Run, not played: a poll at a time still, because the store is built out of the differences
between them, but as fast as the promises resolve rather than at the day's watching rate.
A seek lands in **5–7ms** even when it crosses half an hour of cricket; at ×60 the same
thing took a second and a half of staring. Capped at an hour of quiet so a dead stretch
cannot silently run to the end of the day, and cancelled by any other key. The HUD's
**chrome:** line names the current pick, so a stop says what it stopped on.

It also stops on the chrome **collapsing**: between events the dwell expires with nothing
above `SHOW_FLOOR` and the answer is honestly empty, which is a change worth seeing rather
than one to skip. Expect two stops per event, one either side. Plain play now stops at the
end of the day rather than running on into an empty evening.

**`b`, not `,`.** The comma is already prev-slide on the hardware this is driven from — it
is not in `player-core.js`, it arrives from outside the page — so the two fought exactly
as `f` and Space once did on the keys player-core *does* own. Worth remembering that the
key list to check against is not only this repo's. If `.` ever turns out to be next-slide
on the same hardware, `n` is already the alias for it.

The bar under the HUD is the whole afternoon, with a marker per incident — a toss, an
innings break, rain on and off, a hundred, a five-for, a result decided, a result
confirmed, a ladder move; each tooltip says which and when. **Click it to skip ahead.**
The markers are derivable because the day is pre-rolled: the cricket is known before a
ball of it is shown, which is also what makes `e` possible.

**These avoid every key `player-core.js` binds** — Space, `←`, `→`, Home, End, PageDown,
Escape and `f`/`F` (fullscreen). Both keydown listeners sit on the same document and both
fire, so a shared key makes one press do two unrelated things: `f` once held time *and*
went fullscreen, and Space and `→` stepped a poll *as well as* driving the deck. The
deck's transport is left alone — Space still plays/pauses it, `→` still moves it on.
Check the two lists against each other before adding a key.

### There was a second axis, and why there no longer is

Data arriving and time passing used to be separate controls, because a poll was **one
over** while the model was told that poll had taken **fifteen seconds** — sixteen times
out. Out it had to be: a poll that aged the day by four minutes would have expired a
wicket's three-minute repeat window before the next one arrived, and every dwell and ttl
would have looked broken. But two clocks on one screen is one clock too many to reason
about, and the discrepancy was the reason there were two.

So the compression is gone. An over takes four minutes of sim time and **each feed is
polled at its real cadence** — sixteen polls to an over on ours, a twentieth of that on
the league's (below) — most of them returning a scorecard that has not changed. That is
what an afternoon actually looks like, and the unchanged-poll diff is a path the
one-poll-per-over simulation never took. A whole day is ~1,700 polls of our own feed,
which is a couple of minutes of watching at ×240 and milliseconds when skipped.

### Our matches are polled far more often than the division's

**In manual mode the engine schedules nothing** — `schedule` and the league timer both
bail — so the simulator is the only thing that decides the ratio between the two feeds,
and a chrome tuned against a division that moved as briskly as our own matches would be
tuned against a fiction. It therefore asks the engine's own question of the same feed
(`intervalFor`) rather than assuming a rate:

| feed | cadence | why |
|---|---|---|
| ours | `FAST` 15s while anything is in play | what the Worker is polled at on a match day |
| ours | `SLOW` 30s otherwise | before the first ball, and while a result is decided but unconfirmed, so a scorer's correction is still caught |
| ours | `IDLE` 120s | an empty feed |
| the division | `LEAGUE_MS` 300s, on its own timer, all day | matches the Worker's `LEAGUE_TTL` |

Over a full simulated day that is ~1,700 polls of ours against ~96 of the league's, and
exactly **20:1 while play is on**. The cadence steps down again at the last result, which
is a transition the flat-rate version never produced at all.

Two things this got wrong first time, both worth not repeating: keying the league off a
poll **counter** (`polls % 20`) is right only at the fast cadence and silently becomes 20
minutes during a coarse skip, so both feeds are on sim-time timers instead; and a flat 15s
all day polls the empty ends of the afternoon twice as fast as the wall ever does. The HUD
shows both counts (`poll 194 ours / 13 league`) so the ratio is visible rather than
assumed.

### Why there is no stepping back

The engine holds the previous poll to diff against and the store only ever accumulates,
so the day can be run **on** but not rewound — a rewind would have to rebuild both. A
reload rebuilds both for nothing, so `b` and a click behind the playhead reload with
`&at=`, which runs the day up to that point for real and leaves a store that honestly
holds the afternoon so far.

A long skip still delivers every poll in between, in order, because the diff chain is
what makes the store mean anything — but on a coarser spacing, and with the clip flash
disarmed so it does not fire fifty video takeovers on its way past. `detectClips` reads
`WccPlayer.flash` fresh every poll, so borrowing it is enough and the shipping engine
needs no flag. It is given back a *turn* later rather than at the end of the loop,
because the engine detects clips inside its poll's own promise chain, which settles after
the synchronous skip has returned.

### Pausing stops the whole screen

A pause that only stopped the scheduler's clock would be a lie about most of what is
moving, so it stops all of it:

- **The deck stops advancing** (`WccPlayer.setPlaying(false)`), so it cannot walk off
  the thing you were reading. The previous play state is remembered — resuming must not
  start a deck that was already paused.
- **The ticker's segment cycle and the strip's view cycle stop.** Those are the
  surfaces' own timers and owe nothing to the feed, so they would otherwise keep
  rotating through a stopped screen. The engine broadcasts `wcc-clock`; each surface
  clears its interval and sets a `clock-held` class that pauses CSS animations too —
  the pulsing live dot included.

**"Held" is not the same question as "manual".** The clock is manual for the whole
simulated run now, so `isManual()` can no longer tell a stopped day from a running one —
reading it would freeze the ticker's cycle for the entire afternoon. The simulator
therefore tells the clock its play state (`WccClock.running`), and the engine asks
`WccClock.isHeld()`, which is manual *and* not moving. Both are inert in production,
where the clock is never manual; the engine falls back to `isManual()` for an older
`live-clock.js` served from cache (see the asset-cache-skew note).

**Nothing on a stopped screen may show a moving number.** The distance between a held
clock and the wall clock grows a second every second, so it is never displayed; what the
HUD and the inspector's **time held** badge show is `advanced()` — how much time has been
stepped through by hand — which changes only when you move the day. The inspector shows
the badge whenever the clock is not real, because otherwise every age and score on it
would look like a live afternoon that had quietly stopped making sense.

It drives the **shipping** path, not a parallel mock: a deterministic ball-by-ball
simulation becomes the exact feed shapes the Worker emits (`rv.mjs` for ours,
`pc.mjs` for the league's), handed to the real engine through its `transport` seam.
The engine polls, holds, differentiates, schedules and broadcasts — all shipping
code. `transport` also stands in for the access gate, because there is no Worker to
authorise against, and `manual` hands the clock over so the day's own time is the only
clock on the page.

**No build inputs needed** — it invents the day, so it works in December on a repo
with an empty `live-config.json`. But if the build baked a real day it **adopts its
identities** and simulates those, from both configs:

- `/live-config.json` → our matches' pc_ids, team names, opposition, division,
  home/away, because the `live-match-{team}` slides are each bound to a baked `pc_id`.
- `/live-league.json` → the division's match ids, clubs, competition, team ids and real
  start times, because **every surface that shows other clubs' matches pairs a card to a
  baked fixture by `match_id`** — the strip's ladder tiles via `cardFor`
  (`leagueById[fx.match_id]`) and the today board via `LEAGUE_SCORES[o.match_id]`. An
  invented id lights up neither: the cards arrive, match no row, and are dropped without
  a word. This is the single most confusing thing about testing those two surfaces.

```
WCC_TODAY=2026-08-08 WCC_LIVE_ENABLED=1 python3 scripts/build.py
```

Both adoptions keep the simulation's own shape — the beats, the staggering, the
abandonment, the silent match — and only re-label it.

### Simulating a league match day

The division needs one thing our own matches do not: **a baked fixture list**, because the
today board's other-games rows and the ladder's other tiles are baked and the feed only
decorates them. `live-league.json` and `ev.league.others` both come from
`content/data/fetched/league_today.json`, and `_load_league_today` discards that file
outright if its `date` is not the build's date — so a stale file is the same as no file.
Out of season there are no league fixtures to fetch at all, which would leave those two
surfaces untestable for six months of the year.

So the build can **invent the division too** — `WCC_SIM_LEAGUE=1`:

```
WCC_TODAY=2026-10-04 WCC_SIM_LEAGUE=1 WCC_LIVE_ENABLED=1 python3 scripts/build.py
cd site && python3 -m http.server 8000
open 'http://localhost:8000/slideshow/live/?sim=matchday'
```

```
  league_today: SIMULATED — 2 invented match(es) across 1 division(s) [WCC_SIM_LEAGUE]
  live-league.json — 2 other-league match(es) today
[sim] adopted 2 baked league match(es): Chesham CC v Gerrards Cross CC #990291700, …
```

`_sim_league_today` needs no PC-API call and no season, because every division we play in
has a **committed** `league_table_<comp>.json` — a list of the clubs in it with their real
team ids. It pairs the other sides off the table in order and invents only who plays whom
and when. Ids are stamped in a `99xxxxxxx` range so an invented fixture can never be taken
for a real PC match id in a log line or a cache, and the whole thing is deterministic, so a
rebuild does not reshuffle the division under a test. It is a drop-in for the real file, so
`others` bakes with positions, point-differences and swing flags exactly as it would in
August, and the simulator then adopts those ids from `live-league.json`.

`WCC_TODAY` still has to be a day **we** have a league match on, since the whole scope is
"the divisions Wendover is playing in today" — `_sim_league_today` reads the competition
off our own fixtures. `2026-10-04` works in the committed data; so does `2026-11-01`.

Two things to expect, neither a fault:

- **The board's times may not match the sim's clock.** It shows the baked fixture time,
  and the only in-season division in the committed data starts at 10:15, which is before
  the simulated day opens at 12:30. `startAtTime` notices a start outside the window and
  keeps the template's instead, so the cricket runs in the afternoon while the board says
  morning. Harmless; the ids are what the surfaces pair on.
- **A real fetch is still the honest test** for the fixture list itself
  (`scripts/fetch_league_fixtures.py`, needs `PLAY_CRICKET_API_TOKEN` +
  `PLAY_CRICKET_SITE_ID`, honours `WCC_TODAY`). `WCC_SIM_LEAGUE` is for exercising the two
  surfaces, not for checking that discovery works.

Without either, the simulator still runs the division on the lean feed — the event stream,
the inspector and the ticker key off the feed alone — but those two baked surfaces have
nothing for a score to attach to, which looks exactly like a broken feed and is not.

The simulated division also **leaves out the sides already playing us**: with two Wendover
teams out in one division, a naive pairing off the table put both of our opponents into a
second game as well, which is not a day anyone could have. Excluded by team id where the
table row has one, since a club can have two sides in a division and only one of them is
playing us.

#### A caveat about the example day: TWO Wendover teams in ONE division

`2026-10-04` is an unusual fixture list — Women's Softball **Hawks (10:15)** and **Kites
(11:45)**, both in competition `142917` — and **the today board does not handle that well
today.** `attach_league_context` hangs a `league` block off *each* match event, so the
division's other games are baked under both cards and the board lists them twice, while the
one game in that division a viewer would most want alongside the Hawks — the Kites' — is
absent from both, because our own club is excluded from "other games" by definition:

```
Women's Softball Hawks → others: ['990291700']
Women's Softball Kites → others: ['990291700']
```

**Noted for the production today-board revisit, not fixed here** — it is a pre-existing
board issue, nothing to do with the simulator, and it would be the wrong thing to patch
from inside a test harness. Worth knowing while testing on this date, though: a duplicated
other-games list is the board, not the feed.

One run passes through every state worth seeing: a toss, a
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

#### NOTED, NOT BUILT: the toss and the INNINGS START are both events we want

Two early events are missing, and they are missing for different reasons. Neither is built
— the production feed is deliberately untouched for now — but the second is much the
cheaper and has the stronger claim.

**1. An innings starting is a real change to the league ladder, not just a good moment for
it.** The strip's bat/bowl glyph is derived from the *last* innings in the card
(`live-strip.html:321`):

```js
if (!inns.length) return { idle: 'nodata' };
var cur = inns[inns.length - 1];
var batting = inningsSide(card, cur) === side;
var out = { role: batting ? 'bat' : 'bowl' };
```

So an innings appearing repaints the ladder twice over:

- **the first innings** — the two tiles go from *no glyph at all* (`idle: 'nodata'`) to a
  bat and a ball. The match visibly comes alive in the standings.
- **the second innings** — both glyphs swap, *and* the tiles gain a lean and a certainty
  where the first innings gave them `certainty = 0` ("a role, no lean"), because a chase
  now exists to have an opinion about. The fill changes, not just the corner.

That makes it the clearest case yet for the ladder as a panel: the event *is* a ladder
repaint, so showing the ladder is not a curatorial choice about what best completes the
event — it is showing the thing that just changed.

**It needs no new feed field and no Worker change.** Both extractors already see it and
both say nothing:

- `extractLive` has the seam and discards it — `var pinn = matchInnings(pi, inn, ii);
  if (!pinn) return;` (`live-events.js:401`). An innings with no previous counterpart is
  skipped, and that is precisely the signal.
- `extractLeague` already detects a new innings appearing, as `mi.length > pi.length &&
  pi.length` — note the `&& pi.length`, which deliberately excludes the *first* innings
  from being read as a closure.

**The sharp point: for a limited-overs match, the first innings closing and the second
innings starting are the same instant.** `innings_closed` already fires there, and fires
*because* the new innings appeared. So an `innings_start` event would duplicate it on the
second innings and is genuinely novel only on the **first** — which is to say, the event
worth adding is *the match has started*. What is distinct about the second innings is not
the event but the panel: the chase becomes real, and the existing `innings_closed` can
carry that.

**2. The toss**, which is the one blocked on the feed. For our own matches it already
exists. For the division it does not, at two silent layers: `pc.mjs normaliseMatch()` does
not carry a toss field into the league card, and `extractLeague` has no toss branch. The
data is there — `match_detail.json`, the same endpoint the league feed already calls,
carries `toss_won_by_team_id` and a ready-made `toss` sentence, and `fetch_fixtures.py`
(~line 359) reads both for our matches today.

**Its open question is timeliness, not availability.** PC-API's live-score is coarse and
patchy for other clubs (see the league-wide-today work), and it is not known whether `toss`
populates at toss time or only when the scorer submits — possibly after the match. A toss
arriving at seven in the evening would be treated as news, since a standing fact appearing
on an ordinary poll is detected as the field appearing and `MAX_BACKDATE` clamps its age to
fifteen minutes regardless. `scripts/probe_live.py` against a couple of other clubs'
fixture ids mid-afternoon would settle it. The innings-start route sidesteps the question
entirely, which is another reason to reach for it first.

**And it wants a different panel from the innings start.** At the toss there is no score
and no innings, so the ladder is the honest answer for a league match and previous-match
form for ours (above). At the first innings start there is a ladder that has just changed.
Two nearby events, two different panels — a useful pair to settle the per-type panel
mapping against, and both of them reachable in the simulator with `c`.

One weighting note for whenever this is built: a league toss clears the floor comfortably
— interest is `round(40 × 0.55) = 22` against a `SHOW_FLOOR` of 8 — so six divisions' worth
of tosses and first innings would genuinely compete for the screen around one o'clock
rather than being quietly dropped. Where a `match_started` sits relative to `toss` (40) and
`innings_closed` (74) is a decision to take at the inspector, not in advance.

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

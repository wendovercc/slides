# Live Events — the v2 model

> Status: **built, and the chrome runs on it.** The event store, the extractors, the
> interest model and the scheduler ship in `assets/js/live-events.js`; the ticker
> (`templates/live-ticker.html`), the gold tile and the strip (`templates/live-strip.html`)
> all render the scheduler's pick, and the player's chrome latch follows it. The
> inspector slide (`templates/slides/live-events.html`) renders the working.
>
> **What is not finished is the writing.** Only `toss` and `match_started` have had
> their text and their panel written *for* the L-frame; every other type renders on the
> generic default and is waiting its turn — see [Open questions](#open-questions).
>
> Companion to `docs/live-presentation.md` (the v1 surfaces this replaced the innards
> of) and `docs/match-highlights.md` (the clips it absorbs).

## Why

The v1 live chrome renders **current state**. The ticker cycles whatever the latest
poll says the score is, on a fixed nine-second timer; the strip paints where the
league table stands. That is the wrong unit for a screen someone glances at across
a room. What a glance wants is **what just happened**.

So the feed stops being the thing we render and becomes the thing we
**differentiate**. The chrome becomes a scheduler over a stream of events.

Three consequences fall straight out of the change, and they are the point of it:

- **A fixed cycle is gone.** Nine seconds was spent equally on "Wendover 4/0" and
  on a hundred. How long something stays up is now a consequence of how much it is
  worth — there is no duration to set (see [How long a pick stays up](#how-long-a-pick-stays-up)).
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
dwell         ms — the MINIMUM it will be up for, not how long it lasts
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

`base` is interest before context. `ttl` is how long it stays news — and therefore,
since nothing else holds it there, roughly how long it can hold the band. `repeat` is
how long after it *leaves* the screen before it may come back (null = never).
`fade` is what each showing costs it (default 0.45). `panel` is what the strip shows
while it is up.

| type | base | ttl | repeat | panel | source |
|---|---|---|---|---|---|
| `hundred` | 92 | 15m | 7m | profile | batter's runs crossing 100 |
| `five_for` | 90 | 15m | 7m | profile | bowler's wickets crossing 5 |
| `match_finished` | 88 | 45m | 5m | ladder | `complete` false→true, and `final` false→true |
| `abandoned` | 84 | 45m | 10m | ladder | result text matching abandon/no result/wash |
| `innings_closed` | 74 | 15m | 5m | score | a new innings appears — **this is when a target exists** |
| `wicket` | 70 | 5m | 3m | score | `wickets` moving, described by `last_wicket` |
| `fifty` | 64 | 8m | 5m | profile | batter's runs crossing 50 |
| `ladder_shift` | 60 | 15m | 7m | ladder | **announced by the strip** (see below) |
| `rain_break` | 56 | 30m | 10m | score | `break_desc` matching rain/weather/wet/shower |
| `six` | 52 | 4m | 3m | score | batter's `sixes` counter moving |
| `probability_shift` | 48 | 7m | 5m | score | chase model's `p` moving ≥ 0.15 between polls |
| `match_started` | 44 | 15m | 90s *(fade 0.7)* | ladder | a division match's `phase` → `live` |
| `toss` | 40 | 30m | 90s *(fade 0.7)* | form | `toss` appearing |
| `four_clip` | 36 | 4m | never | score | `fours` moving — earns a screen mainly with footage |
| `innings_update` | 22 | 7m | never | score | every 5th over |
| `ball_clip` | 20 | 3m | never | score | a clip nothing else claims |
| `score_update` | 12 | 3m | never | score | every whole over, our matches only |

The last two rows are **the floor, and they are not pretending to be news**: they
are what keeps a screen truthful when nothing has happened for ten overs. Their
interest is low enough that any real event outranks them.

**`match_started` is the one type that exists because a surface changed.** A division
match going live turns its square on the match-day board over to "In play" and puts a
mark on both its tiles in the ladder, and the stream used to say nothing about either.
Its panel is the ladder, and not as a curatorial choice — the event *is* a ladder
repaint, so the strip is showing the thing that just changed. It is detected as a
transition, below the `!prev` branch, and guarded on `!complete`: a card that arrives
late and jumps straight to a result must not announce a start an hour after the fact.

### Retirement — a stale snapshot is wrong, not merely old

Some events do not merely outrank their predecessors, they make them **false**.
"Chalfont 9/0 (2 ov)" is not old news once 17/0 lands; it is a wrong score, and a
surface showing it is lying to the room whatever its freshness works out to. A retired
event scores **0**, can never be picked, is the first thing evicted when the store
fills, and **loses the band at once** if it is the one on screen.

**It is not only a type retiring its own kind.** This began as "a score update
supersedes the previous score update", which is true but far too narrow: once we are
reporting a score for a match, that match's "In play" and its toss have both stopped
being news about it — the screen has visibly moved on from the state they describe. So
each type names what it retires **within the same match** (`RETIRES` in
`live-events.js`), and a type retiring its own kind is just the commonest row:

| a new… | retires, in that match |
|---|---|
| `match_started` | `toss` |
| `score_update`, `innings_update` | `toss`, `match_started`, and both snapshot types |
| `innings_closed` | `toss`, `match_started`, and both snapshot types |
| `match_finished`, `abandoned` | all of the above, plus `probability_shift` |

**Incidents are never retired**, and the distinction matters: a wicket is still a true
account of a wicket an hour later, a second wicket does not unmake the first, and a
result does not unmake either. Only descriptions of a state the match has since left
are in the table.

**Retirement is not the same as novelty zero, and the two must stay apart.** They both
end in a score of nothing, but novelty is about what the *room* has seen and recovers,
while retirement is about what is *true* and does not. Three behaviours need to tell
them apart: novelty is deliberately exempt for the event on screen (that exemption is
what lets a pick hold its place), so a retired incumbent expressed as novelty would
never hand over; eviction ranks retired ahead of merely-shown; and the inspector
strikes retired rows through while merely dimming low-scoring ones, because "no longer
true" and "not interesting enough" are different things to be told.

**Time and data must land together.** Announcing a clock step before the poll it belongs
to had the scheduler decide against a store that did not yet hold that poll's events — so
it picked the previous over's score and was then holding a score the next instant made
obsolete. The simulator advances the clock quietly (`WccClock.advance(ms, quiet)`) and
lets the ingest broadcast the end state once.

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
novelty    1 if never shown, or if it is the event currently on screen;
           0 inside the repeat window after it left; then fade^shown_count
```

- **Below `SHOW_FLOOR` (8), nothing is shown and the chrome collapses.** The floor is
  what makes an empty afternoon read as empty instead of as a loop.
- **An event holds the band because it is still the best thing above the floor** — not
  for a duration of its own. See below; this is the change that made the model simple.
- The inspector renders the **whole ranking**, not just the winner — a ranking you
  cannot see is a ranking you cannot tune. Every row's numbers are live, the showing
  one included, so watching a pick fall towards the floor is watching the decision
  that will hand the band on.

  The inspector prints factors through a `factor()` helper rather than trimming the
  leading zero off `toFixed(2)`: that shortcut turned **1.00 into ".00"**, exactly what
  0.00 rendered as, so the two ends of the scale meant opposite things and printed the
  same. `1` and `0` now say so plainly and fractions keep the short `.85` form.

### How long a pick stays up

**Mostly this is not a duration at all.** An event is put up because it is the best
thing above the floor and it stays up until either its own freshness decays it below
the floor or something outscores it. There is no separate number to tune, which is the
point: how long a wicket sits there is a consequence of what a wicket is *worth* and
how long it stays news, and both of those are already in the type table. Wanting a
score to hold for three minutes is therefore a statement about its `base` and its
`ttl`, made in the one place all the other such statements are made.

This replaced an explicit per-event `dwell` — reading time at 55ms/char with per-type
floors — which existed for a reason that has gone. **Picking an event used to stamp
`shown_at` and zero its novelty**, so without a hold it would have lost the screen on
the very next tick. `shown_at` is now stamped when an event **leaves**, so the repeat
window measures time *off* the screen, which is what "how long before it may be shown
again" always meant.

Three things still override the raw score, and each is there for a stated reason.

**Footage runs to its end.** A clip is not a caption that can be swapped mid-sentence:
the slideshow has given way to it, and cutting it off mid-wicket because a six landed
elsewhere is worse than being a few seconds late to the six. Clip length plus a beat
either side.

**Nothing may appear for an instant** (`MIN_SHOW_MS`, 10s). Decisions are taken
whenever the clock moves, and the two feeds ingest on different cadences, so without a
floor on how briefly something can be up the band would blink.

**The incumbent gives ground the longer it holds** (`SHARE_MS`, 18s — its standing
halves every 18 seconds of *screen* time). This one is not obvious and was found by
measuring. Under a plain "highest score holds" rule **the freshest event squats**:
everything waiting is by definition older and so less fresh, which means it can never
outscore the incumbent and only gets the band when the incumbent falls through the
floor. A division's eight matches all starting at one o'clock would announce the last
of them and then sit on it for seven minutes. The discount applies **only when
comparing against the alternatives, never against the floor** — so a queue of
comparable events takes turns, while an event with no rival keeps the band until it
genuinely stops being worth one. Measured, eight starts now get three passes each over
about six and a half minutes.

And one thing cuts a pick short: **retirement**. A hold protects an event, never a
falsehood.

### Why it is asked every tick, not on every poll

Tempting, and wrong: the store's *membership* only changes when a poll ingests, but
the *scores* do not. Freshness decays continuously, so the answer can change with no
new data at all — the pick can fall below the floor, two events with different ttls
can swap as they decay at different rates, and a repeat window expiring can make
something eligible again. Deciding only on ingest leaves an event on screen after it
has stopped being worth one, for as long as a poll interval: fifteen seconds in play,
thirty while a result settles, two minutes on an idle feed.

**It cannot flap**, which is what made a poll-cadence gate look necessary. An event
that loses the band is stamped `shown_at` there and then, which drops its novelty to
zero for its whole repeat window — so whatever displaced it cannot be displaced
straight back by it. `MIN_SHOW_MS` covers the rest.

### Repetition, and why `fade` is per type

`fade` is what each showing costs an event's standing: 0.45 by default, so "shown
once, now worth under half". Right for news, which is diminished by having been said.

**Some types are not diminished that fast.** Around one o'clock a division's matches
all start and a club's XIs all toss, and there is very little else on; going round
them twice more is better than collapsing. At 0.45 that is arithmetically impossible
however the other dials are set — a third pass needs `interest × 0.45² ≥ 8`, i.e. an
interest of 40, i.e. a base above `innings_closed` for a match that has merely begun.
The decay is the binding constraint, not `base` and not `ttl`, so it is the one that
has to be a per-type property. `toss` and `match_started` fade at 0.7.

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
  PC-API is thin: a match going live, a result, an innings closing, a coarse
  scoreline. A chrome that only looks right on the rich feed breaks on five of the
  six matches it shows.
- **Both are given the baked configs**, because the cards alone cannot name things.
  `cfg.byId` is `live-config.json` keyed by `pc_id` — our team name, the opposition,
  the division, the start time. `cfg.leagueById` is `live-league.json` keyed by
  `match_id` — the division's clubs, competition and **ground**, none of which the
  lean PC card carries. The engine was already fetching that file for its match ids
  and discarding the rest.
- **`prev` null yields no change events.** Everything in the first poll of a session
  already happened before we were watching, and announcing a morning's wickets at
  once is the bug that guards against. Standing *facts* (the toss, a result already
  posted) are still emitted — those are states, not changes.
- **A later start is not a first sighting.** A match beginning at three o'clock has
  been in the feed since breakfast as a fixture with no toss, so its toss arrives on
  an ordinary poll; it is detected as `toss` appearing, not by the `!prev` branch.
  `match_started` sits below that branch for the same reason in reverse: a match
  already live when we first poll started before we were watching, and announcing a
  one o'clock start at four is exactly what the rule exists to prevent.

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

## Splitting a showing event across the surfaces

> James's design direction, 2026-09-24; **built 2026-09-27** (`b26d181`).

The L-frame is **one presentation of one event**, not three renderers that happen to
be on at the same time. When the scheduler picks an event, its parts are distributed
by *kind of information*, and each surface always does the same job:

| surface | carries |
|---|---|
| **Gold tile** — bottom left | the **type**: what kind of thing just happened |
| **Ticker** — the bottom bar | the **text**: the event description |
| **Strip** — the side bar | **one panel**, chosen by the type — over a **footer** naming whose match it is |
| **Flash** — the slide's box | the **footage**, when the event has any |

Read out of the corner it is one sentence either way: along the bottom, `WICKET` →
"Harrington bowled Duff 62"; up the side, `WICKET` → the chase it just dented, over
"1st XI · TVCL Div 6C".

### The tile carries the type, and that is a change from v1

It used to name the match — the featured XI over its division — and stood in as the
header for the whole chrome, the strip above it having none of its own. That was the
wrong occupant for the slot twice over.

**The content never fit.** `is-long` existed only because "U11 Incredibles" over
"TVCL Div 6C" has to shrink to survive 8vw, so the brightest block on the screen was
shrinking its type to say the least urgent of the three things. The type is a short
closed vocabulary — TOSS, WICKET, SIX, RESULT, RAIN — which fits on one line at full
size.

**And it answered the wrong question.** At ten feet the gold is read first, so it
should say *what happened*, not *whose*. With v1's nine-second cycle gone, the tile
flipping is also the cheapest available signal that the screen **changed** rather than
drifted.

It sharpens when the match-day board is the slide underneath: the board already shows
the team, the division and all three scores in far more detail than 8vw can carry, so
a tile repeating that is dead space — while the one thing the board cannot say is
*which of those matches just moved*.

### Whose match it is moved to the strip's footer

The strip takes back the header the tile was standing in for — but at the **bottom**,
in the band directly above the tile. James's call, and the reasons are structural:

- at the top of a full-height column it sits the better part of a screen away from the
  tile and the bar it belongs with, and reads as a separate object;
- at the bottom the attribution lands on **both** reading paths out of the corner,
  rather than stranded at the far end of one;
- it puts the naming block at the terminus of the gold spine, where the L actually
  joins;
- and the panel's *moving* edge becomes its top — furthest from where the eye is.

Fixed height and `flex-shrink: 0` like `.panel-cap`, so ten league tiles lose a little
height rather than the footer being squeezed. Our match names the XI over the
division; somebody else's names the division alone, because which two clubs is
answered by the panel's own marked tiles and two club names have never fitted 8vw.
Fed by a baked `name_short` — the same `_competition_short` written for this exact
band when the flag was carrying it.

### The strip has panels, and the event type picks one

A chase position and a league ladder **never share the band**. The strip shows one
panel at a time, named by the type in the table above. The set today:

| panel | shows | state |
|---|---|---|
| `score` | the two sides, batting first on top, plus target and chase tiles | built |
| `ladder` | the division ordered by position, this match's sides marked | built |
| `form` | how the two sides have been going — five results each | **unbuilt** |
| `profile` | the player an event is about | **unbuilt** |
| `none` | the footer alone | — |

**Availability overrides the request, through a fallback chain.** A friendly has no
league table, a division match has no baked form, and player profiles do not exist, so
each panel is a *preference* with a chain behind it, walked until something can
actually be drawn. That is also how the grey areas resolve themselves without a
special case: a toss asks for `form`, form is only baked for our own teams, so a
league toss lands on the ladder — which is what it wanted anyway.

**The strip supplies the availability**, because only it knows whether it has a baked
division for this match or a card with innings in it. `panelFor(type, avail)` in
`live-events.js` walks the chain; `PANELS` holds the chains.

`panel: 'none'` is deliberately **not** a collapse: the L is still describing
something, and pulling the column out from under the tile would break the frame
mid-sentence.

### What the conversion deleted

Worth recording, because each was load-bearing under v1:

- the ticker's `buildSegments`, its nine-second cycle, and its `live-config.json`
  fetch — `showing.match` carries the team and division already;
- the strip's twenty-second view cycle;
- the **`wcc-featured` relay** (ticker → the engine as hub → strip), which existed so
  the two surfaces could not drift onto different games on their own cadences. They
  read the same broadcast now, so they cannot.

## The two event types written for the frame

Everything else renders on the generic default — headline, muted detail, the type's
panel — and is waiting its turn.

### `toss`

> "Denham elected to bat. Wendover will take to the field from 13:00."

**The tile carries the noun, so the sentence must not.** RV's ready-made `toss.text`
is "Denham CC won the toss and elected to bat", which with `TOSS` beside it says toss
twice and spends the front of the line getting to the only part that is news.

**The second sentence is the other side's half of the same fact.** A toss decides what
*both* teams are about to do, and saying only the winner's choice leaves the reader to
work out the consequence — which is the part that says what they are about to watch.
Electing to bat sends the other side to the **field**; electing to bowl sends them to
the **crease**.

**Both clubs come from `live-config`, not from the toss object** — `our_club`,
`opposition` and `time`, selected between by `is_wendover`. That names the two sides
in one consistent style, and sidesteps matching `winner_club` against the card's
home/away, which is the name-join trap `live-strip.html` warns about at length. Club
names are shortened by `dropCC()`, a port of build.py's `drop_cc`, so a club is named
on the L exactly as the match-day board names it a few centimetres away.

Every part degrades: no config → the winner's choice alone; no start time → the
sentence without it; no `is_wendover` → no second sentence; no decision → RV's own
phrasing.

### `match_started`

> "High Wycombe are hosting Maidenhead & Bray at London Road."

"Hosting" rather than "v", because home and away is the only thing worth knowing about
a fixture nobody has bowled a ball in, and it reads as news where a fixture line reads
as a listing.

**The ground needed a seam that was almost already there.** The PC card is
deliberately thin — no clubs, no ground — but the engine was *already fetching*
`/live-league.json` for its match ids and throwing the rest away. It now keeps the
rows and passes them to the extractor as `cfg.leagueById`, the same way `cfgById`
enriches our own matches from `live-config`. The simulator hands its copy over as
`leagueRows`, since supplying ids skips that fetch. The ground is dropped when it
merely repeats the home club, and the whole clause when there is none.

## The toss moves three surfaces at once

One shared answer — **`WccChase.battingFirst(card, ourSide)`** — because the strip and
the match-day board must not disagree about who is in. It prefers `innings[0]` when
there is one (the feed delivers innings in batting order) and reads the **toss**
before that.

**No name matching and no team id**, neither of which the toss carries: `is_wendover`
says whether we won it and `decision` says what the winner chose, and we bat first
exactly when those two agree. `ourSide` maps that onto the home/away axis every other
surface binds on.

- **The strip's ladder** gains bat and ball glyphs *before a ball is bowled*. Until
  now the role came only from the last innings in the card, so between the toss and
  the first ball both tiles sat blank — the same state as a feed saying nothing —
  while the feed in fact knew exactly who was about to bat.
- **The match-day board** reorders its zones so the side batting first is on top. That
  path used to `return` early with the comment "batting order is not known until an
  innings is", true only while nothing read the toss.

**The trap there was the form.** Crest, club and designation were already
runtime-placed from `data-us-*`/`data-them-*`, but the form is *baked markup*
belonging to whichever zone the build put it in — so a naive swap gives you one club's
crest over the other's five results. `placeSides()` captures it once per tile in build
order and deals it back out.

## The strip and the board must agree about freshness

The strip never loaded `live-status.js`, so `assess()` had **no freshness input at
all** — there was no path by which age could reach it. Two consequences, and the
second was a real disagreement rather than a resolution gap:

- **The silent dot meant nothing.** It appeared for anything unscored, so a game yet
  to start looked identical to one in play with an unscored card.
- **Stale scores were laddered.** The board withdraws a division score at 30 minutes
  (`↻ 40m`); the strip showed a lean, a fill, *and* fed a stale win probability into
  the ghost arrows and the projected order — still forecasting the table from a score
  the board had already decided not to trust.

Both now follow the board's own rule, reached the same way `paintSquare` reaches it
(`observe` / `band` / `closed`, against the feed's own `generated_at`). Three idle
states matching the board's three classes:

| state | board says | ladder shows |
|---|---|---|
| not in the feed at all | *(silent)* | no mark |
| pre — not started | `Awaiting` | no mark |
| live, nobody scoring | `In play` | **• dot** |
| live, scored | `In play` | bat/bowl glyph |
| live, scored, stale | `↻ 40m` | **• dot** (withdrawn) |
| no feed | `No feed` | no mark |
| complete | `Result` | fill (lean) |

Withdrawing to the dot settles the ladder for free: with no `p` on the row,
`expectedPoints` falls back to neutral and `if (r.final || r.idle) return` skips the
ghost, so nothing rides a score we have just said we do not trust.

**Only for other clubs.** The board keeps *our* score up and reports its age beside
it, because our feed carries the scorer's own cursor and a five-minute band; with-
drawing ours on the ladder would be the strip overruling the board. A **closed**
innings is exempt from all of it — nothing can change it, so there is nothing to be
stale about.

## Putting the chrome away

The player's latch used to key off `liveHasContent(feed)` — does the feed hold a match
that is live, at a break, or complete. That is a v1 question with one answer all
evening, because `complete` never goes back to false: once the last game finished the
band could never retract, so an empty L sat on the wall until the daily reload. The
surfaces inside it cleared correctly; the frame around them did not.

It now latches on **`showing`**. Nothing to show, nothing to make room for.

**Still sticky, and it has to be.** Between events the answer is legitimately "no" for
tens of seconds, and growing the slide layer back and forth across those gaps would
reflow the wall. Up is immediate; down waits out a quiet spell. Measured, collapsed
gaps during ordinary play run to about 30 seconds, so the spell is **two minutes** —
it bridges every gap in play and puts the band away a couple of minutes after the
cricket actually stops. (It was twelve, which also worked but held an empty L for a
quarter of an hour after the last result.)

**Measured on `WccClock`, not with a `setTimeout`.** A timeout is real time, and the
simulator runs an afternoon in a couple of minutes — so a twelve-minute timer would
never fire in a session and the retraction could not be looked at at all. The engine
rebroadcasts every second regardless of mode, so the quiet spell is a subtraction
against the scheduler's clock: it advances with the simulated day and stops dead while
the clock is held.

An engine too old to broadcast `wcc-events` falls back to the v1 answer, so an
asset-cache skew degrades to the old behaviour rather than to a chrome that never
appears.

One consequence worth knowing: on a fresh load mid-innings the chrome stays down until
the first event, which can be up to an over. That is the doctrine working as written —
nothing has happened since we started watching — but it is a visible change from v1.

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
the next thing that *happens*, and the two come apart constantly: a wicket arriving inside
the minimum show time waits its turn, an incumbent giving ground promotes something from
ten minutes ago, and a retired pick loses the screen with no new event at all. None of it
can be worked out in advance — it depends on the store's state at the instant it is asked
— so the day is **run** until it happens.

Run, not played: a poll at a time still, because the store is built out of the differences
between them, but as fast as the promises resolve rather than at the day's watching rate.
A seek lands in **5–7ms** even when it crosses half an hour of cricket; at ×60 the same
thing took a second and a half of staring. Capped at an hour of quiet so a dead stretch
cannot silently run to the end of the day, and cancelled by any other key. The HUD's
**chrome:** line names the current pick, so a stop says what it stopped on.

It also stops on the chrome **collapsing**: when nothing is above `SHOW_FLOOR` the answer
is honestly empty, which is a change worth seeing rather than one to skip. Plain play stops
at the end of the day rather than running on into an empty evening. (Collapses are much
rarer than they were before the floor types held properly — on a three-match day with a
division behind it the band is occupied about 92% of the time.)

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
wicket's three-minute repeat window before the next one arrived, and every ttl would have
looked broken. But two clocks on one screen is one clock too many to reason
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
- **CSS animations stop.** The ticker's segment cycle and the strip's view cycle went
  with the conversion — what is on the band is the scheduler's pick now, and a second
  timer beside it would only drift — so what is left to stop is what CSS is animating
  on its own: the pulsing live dot, the ladder's FLIP transitions. The engine
  broadcasts `wcc-clock` and each surface sets a `clock-held` class.
- **The chrome's own retraction stops**, because its quiet spell is measured on the
  same clock (see [Putting the chrome away](#putting-the-chrome-away)).

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

### Simulating our own match day — `WCC_SIM_MATCHES=1`

The **match-day board is baked**: `match_day_layout()` decides every tile's column, span
and row at build time and the feed only ever sets text behind a `data-f` hook. So out of
season, when there is no fixture within months of today, the board has nothing to draw and
the simulator's afternoon has nowhere to land — the same trap `WCC_SIM_LEAGUE` was written
to get out of on the division's side, and for the same six months of the year.

```
WCC_SIM_MATCHES=1 WCC_SIM_LEAGUE=1 WCC_LIVE_ENABLED=1 python3 scripts/build.py
cd site && python3 -m http.server 8000
open 'http://localhost:8000/slideshow/live/?sim=matchday&at=16:30'
```

```
  fixtures: SIMULATED — 3 invented Wendover match(es) today [WCC_SIM_MATCHES]
  league_today: SIMULATED — 8 invented match(es) across 3 division(s) [WCC_SIM_LEAGUE]
  live-config.json — 3 pollable match(es) today, poll window 2026-09-26T12:30 → …
```

`_sim_fixtures_today` invents **three** matches — the shape the layout is hardest at, three
tiles of two columns — from `teams.json`'s `play_cricket_league_id` and the first other side
in that division's **committed** `league_table_<comp>.json`. The clubs, team ids and
competitions are therefore real; only who plays whom and when is fiction. Ids sit in the
`99xxxxxxx` range, as the league sim's do. It is merged into `all_fixtures` at the three
places the build loads it, so `todays_events`, `attach_league_context`, `match_day_layout`
and `live-config.json` all need to know nothing about it.

**A real fixture today wins outright** — the override prints `ignored` and stands down
rather than doubling up a live match day. Pair it with `WCC_SIM_LEAGUE=1`, which reads the
competition off these invented fixtures and fills the division tiles beneath them.

#### What the simulated day now covers

Only ONE of our three matches is scored properly from first over to confirmed result. The
other two, and three of the division's five, are the afternoons a board gets wrong:

| Match | Scenario | What it exercises |
|---|---|---|
| 1st XI (streamed) | rain break 15:00, scorer offline 16:20–16:50, result unconfirmed 25 min | `Break` / `Rain delay`, `↻ 30m` mid-chase, decided-but-unpublished |
| 2nd XI | `noFinish` — last over scored, then the tablet is shut | a card never completed: the age climbs all evening, no verdict ever posts |
| Sunday XI | `notScored` — never scored at all | `Score book` (a noun, on purpose: the state says no live score is coming, not that the game is over — and not that anything is broken at our end), and the pre-match panel standing all day |
| division | rain, then abandoned | the `Abandoned` verdict on a square |
| division | `coarseEvery: 9` — synced in lumps | a square walking fresh → aged (`↻ 14m`) → stale (score withdrawn) → fresh |
| division | `silent` + `resultOnly` — kept in the book | `In play` on the rule with both clubs still named, then a result at the close |
| division | `noFeed` — the per-match fetch failed | `No feed` on a square |

The freshness bands themselves live in `assets/js/live-status.js` (ours: 5 min of scorer
silence; theirs: 10 min aged, 30 min stale, observed rather than reported because the PC
feed carries no scorer cursor at all). Both boards read them, so the today board and the
match-day board cannot give a different account of the same match.

Two things the simulator is deliberate about here:

- **A card that stands still is not "in play".** `stillScoring()` excludes the never-scored,
  the unfinished, the book-kept and the unreadable, so the HUD's count and `c` (jump to the
  next change) don't offer moments that never arrive.
- **The stall freezes the CARD, not the cricket.** When the scorer comes back the score
  jumps several overs at once, which is what actually happens and what a board must survive.

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
scheduler's pick at the top (with **why** it won), then every event newest-first with
all three timestamps, interest, freshness, novelty and score. Rows below the floor are
dimmed — those are events the chrome will not show. Retired rows are struck through;
the current pick is highlighted.

**Every row's numbers are live, the showing one included.** It used to substitute the
figures the pick had *won* with, because being picked stamped `shown_at` and zeroed
its novelty — making the one row you most wanted to understand the one row that told
you nothing. Novelty no longer touches the event on screen, so the live figures are
both honest and the interesting thing to watch: a pick decaying towards `floor` is the
handover about to happen.

The band prints a **minimum** rather than a hold, because there is no longer a hold to
print: for a clip that is the length of the footage (the one thing here that really is
a duration), otherwise the floor on how briefly anything may appear.

Nothing is baked into it, so it is honestly empty on a day with no cricket.

> An earlier plan had the showing block become a preview of the L-frame decomposition,
> so the panel mapping could be settled before the chrome moved. James called that off
> in favour of converting the chrome directly and walking the event types one at a
> time against the real surfaces — which is what happened.

## Open questions

**1. The remaining event types have not been written for the L-frame.** Only `toss`
and `match_started` have had their text and their panel thought about; `wicket`,
`six`, `four_clip`, `innings_closed`, `match_finished`, `abandoned`, `rain_break`,
`probability_shift`, `hundred`/`fifty`/`five_for`, `ladder_shift` and `score_update`
all render on the generic default. Walking them **one at a time** against the
simulator is the way this has gone and the way it should continue.

**2. Some type labels are written for a table, not for an 8vw block.** The tile
renders `TYPES[].label`, so `match_finished` puts "MATCH FINISHED" in the corner where
"RESULT" belongs. Probably wants a separate tile label per type.

**3. `score_update` for another club can never be shown**: `round(12 × 0.55) = 7`
against a `SHOW_FLOOR` of 8. A division's coarse scoreline is excluded by arithmetic
rather than by a decision. Ours holds about 33 seconds uncontested.

**4. The live dot has lost its meaning.** It pulsed for "this match is in play"; beside
a type label it is decoration, and it is wrong beside `RESULT`.

**5. `No feed` has no mark of its own on a tile**, so a failed fetch now looks like a
game not yet started — the honest half of a bad choice, since the alternative was to
keep asserting a game was in play. The `aged` band (10–30 min) has nowhere to live
either: the board shows the score with a `↻ 14m` chip and a tile has no chip. Both
would be answered by a third mark in the bottom-left slot — a hollow dot to the filled
one.

**6. Which events take over the screen.** Footage currently means takeover. Every
wicket clip pausing the slideshow may be too much; `six` + `wicket` only, or a minimum
gap between takeovers, are both one constant away.

**7. The weights are still a starting position**, and now they do more work than they
did: with `dwell` gone, `base` and `ttl` together decide how long something holds the
band as well as whether it gets it. The inspector exists to argue with them.

**8. Occupancy on a one-match day.** Measured over thirty minutes of ordinary play:
92% with three of ours plus a division, 77% with a single match and gaps up to two
minutes. Time-sharing buys variety at some cost in occupancy — `SHARE_MS` is the dial
— and a single-fixture Sunday is the case to look at before calling it settled.

**9. `ladder_shift` still has no real source.** The strip owns the ladder and is meant
to call `WccLive.handle.addLadderMove(move)` when a move commits; that wiring does not
exist and the simulator stands in. What matters for the model is that a ladder move
*competes* with a wicket for the screen, not where the number came from.

**10. The `form` and `profile` panels are unbuilt**, so both always fall through their
chains. `form` is the smaller job — the data is baked (`form` in
`player_stats_this_season.json` for ours, `opposition_form` on the fixture for
today's opponent, five results each) but is not carried into the strip's views, and
**no form exists for a division club we do not play**, so it can only ever be an
our-match panel. `profile` waits on the unbuilt player-profiles feature (see
`docs/live-presentation.md` and the `project_player_profiles` memory).

**11. A league `toss` does not exist.** `pc.mjs normaliseMatch()` carries no toss
field and `extractLeague` has no toss branch, so `toss` is an our-matches-only event
today. The data is there — `match_detail.json` carries `toss_won_by_team_id` and a
ready-made sentence — and **the open question is timeliness, not availability**: it is
not known whether `toss` populates at toss time or only on scorer submission, possibly
after the match. A late one would read as news, since `MAX_BACKDATE` clamps its age to
fifteen minutes. `scripts/probe_live.py` against a couple of other clubs' fixture ids
mid-afternoon would settle it.

**12. `score_update` volume.** Every whole over of every match of ours is the floor
keeping the chrome alive; 200-odd in a day is a lot of store for events almost none of
which will be shown. Capping or collapsing them per match is untested.

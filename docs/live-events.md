# Live Events — the v2 model

> Status: **built, and the chrome runs on it.** The event store, the extractors, the
> interest model and the scheduler ship in `assets/js/live-events.js`; the ticker
> (`templates/live-ticker.html`), the gold tile and the strip (`templates/live-strip.html`)
> all render the scheduler's pick, and the player's chrome latch follows it. The
> inspector slide (`templates/slides/live-events.html`) renders the working.
>
> **What is not finished is the writing.** `toss`, `match_started`, `score_update`,
> `wicket` and the individual family (`fifty`, `hundred`, `five_for`, `new_batsman`,
> `spell_started`, `spell_ended`) have had their text and their panel written *for* the
> L-frame; the match-state types and the two swings still render on the generic
> default and are waiting their turn — see [Open questions](#open-questions).
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
payload       { parts, headline, who, … } — ONE list of parts, plus its flat form
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
— the trap `rv.mjs` already warns about for a board's status column. Taken
literally, every event from such a feed is born an hour old, scores zero, and the
chrome collapses on a match day while we have in fact just learned all of it. The
bound is longer than the newsy TTLs (an old six is stale either way, so footage
cannot pose as breaking news) and shorter than a result's, so a result we hear late
still gets the screen it deserves:

| event | happened | received | freshness | shown |
|---|---|---|---|---|
| `match_finished` | 60m ago | just now | 0.44 | yes — lagging scorer, real news to us |
| `match_finished` | 60m ago | 60m ago | 0.00 | no — genuinely old |
| `wicket` | 60m ago | just now | 0.00 | no — a backfilled collapse is not news |
| `wicket` | 2m ago | just now | 0.36 | yes |

## The type table

`base` is interest before context. `ttl` is how long it stays news — and therefore,
since nothing else holds it there, roughly how long it can hold the band. `repeat` is
how long after it *leaves* the screen before it may come back (null = never).
`fade` is what each showing costs it (default 0.45). `panel` is what the strip shows
while it is up.

| type | base | ttl | repeat | panel | source |
|---|---|---|---|---|---|
| `hat_trick` | 94 | 15m | 7m | profile | 3 balls and 3 wickets in one bowler's suffix |
| `hundred` | 92 | 15m | 7m | profile | batter's runs crossing 100 |
| `five_for` | 90 | 15m | 7m | profile | bowler's wickets crossing 5 |
| `match_finished` | 88 | 45m | 5m | ladder | `complete` false→true, and `final` false→true |
| `abandoned` | 84 | 45m | 10m | ladder | result text matching abandon/no result/wash |
| `innings_closed` | 74 | 15m | 5m | ladder | a new innings appears, **or an innings break begins** (a side that bats its overs out is not all out, so the break is the card's only word for it). Never with a score line in the same poll, which would retire it unseen |
| `on_a_hat_trick` | 76 | 2m | never | profile | 2 balls and 2 wickets — **retracted, not merely aged** |
| `approaching` | 46 | 5m | never | profile | a batter entering the last 10 before 50 or 100 |
| `collapse` | 72 | 12m | 5m | score | 3 wickets inside 6 overs |
| `wicket` | 70 | 5m | 3m | score | **one per dismissal** — the batter rows, not `last_wicket` |
| `fifty` | 64 | 8m | 5m | profile | batter's runs crossing 50 |
| `stand` | 64 | 10m | 5m | score | the stand (total less last `fow`) passing 50, 100, 150… (`magnitude` by mark) |
| `last_pair` | 54 | 8m | never | score | nine down with two men at the crease |
| `ladder_shift` | 60 | 15m | 7m | ladder | **announced by the strip** (see below) |
| `rain_break` | 56 | 30m | 10m | score | `break_desc` matching rain/weather/wet/shower |
| `wicket_maiden` | 56 | 7m | 4m | profile | 6 of his balls for 0 runs with a wicket in them |
| `charge` | 52 | 6m | 4m | score | 3 overs well above the innings' own rate |
| `squeeze` | 50 | 8m | 5m | score | 5 overs well below it |
| `maiden_run` | 50 | 8m | 5m | profile | 3 or 4 consecutive maidens by one bowler |
| `team_total` | 50 | 8m | 5m | score | the total passing 100, 200, 300… (`magnitude` by mark) |
| `probability_shift` | 48 | 7m | 5m | score | chase model's `p` moving ≥ 0.15 between polls |
| `stream_started` | 46 | 20m | 5m *(fade 0.7)* | score | a stream marker appearing on the card |
| `match_started` | 44 | 15m | 90s *(fade 0.7)* | ladder | a division match's `phase` → `live` |
| `spell_ended` | 40 | 8m | never | profile | a bowler's over count standing still for two overs |
| `toss` | 40 | 30m | 90s *(fade 0.7)* | form | `toss` appearing |
| `new_batsman` | 36 | 5m | never | profile | a batter's first ball faced, once a wicket has fallen |
| `spell_started` | 30 | 5m | never | profile | a bowler bowling after a gap of two overs, or his first |
| `match_break` | 26 | 10m | never | score | `break_desc` appearing that is *not* the weather |
| `score_update` | 12 | 9m | never | score | every whole over (ours), every changed scoreline (division) |
| `replay` | — | 10m | never | score | every clip row with footage; **never ranked** (`band: false`), played by the player's replay queue |

*(2026-10-01: `ball_clip` is gone. A clip row no longer raises a band event; it is a
`replay`. See [Replays](#replays--footage-is-rotation-content-and-the-store-decides-what-is-still-worth-it).)*

The `score_update` row is **the floor, and it is not pretending to be news**: it is
what keeps a screen truthful when nothing has happened for ten overs. Its interest is
low enough that any real event outranks it.

### One event per thing that happened — and where that stops

**Every wicket is its own event**, so a poll that brings three of them queues three
and the band shows them in turn. This used to be one event with `(+2 more this over)`
hung off it, which was wrong twice over: it is not an *over*, it is the gap between
two polls — under a scorer syncing in lumps that is twenty minutes and can span half
an innings — and it threw away two dismissals in order to describe a third.

The card carries a **row per batter** (RV's `PlayerPerfs`), so a dismissal is "this
name had not been given out last time and has been now", which holds however many
polls were missed. Each event states the score that wicket left, from that batter's
own fall-of-wicket figure. Only the **latest** wicket takes the card's current
scoreline *and its over number*: the over is the one thing a fall figure does not
carry, and for the newest wicket the card's reading is a few balls old at most, while
an earlier one would be borrowing an over that belongs to a later ball. A feed whose
rows cannot be reconciled with the wicket count falls back to one event for the batch.

**The dismissal clause is scorecard notation**: `b`, `ct`, `lbw`, `st`, `ro`, `c&b`
for the dismissals anyone meets in a season, words for the rare ones, and no "for" —
a scorecard writes `B Duff b Vane 0` and that is the notation a reader has already
seen on the board and in the app. The abbreviations are what paid for naming the
bowler's club.

**The bowler's club is possessive, never `by`.** In cricket's grammar `by` attaches to
the *fielder*: "ct 17 by W Vane" says W Vane took the catch when he bowled it, and
catches are most dismissals. The em-dash clause attributes the wicket without claiming
how it was taken. A club already plural takes the bare apostrophe — `Great Missenden
Pelicans’ K Samaradiwakara`. The word "bowler" is dropped to pay for the club and the
figures carry that meaning anyway; it comes back only when the side cannot be resolved,
since a bare name after a dash would be anybody.

Measured against the real fixture list, with the ticker clipping near 88 characters:
typical 65, a catch 68, and the worst club we play (`Buckland & Aston Clinton`) 85 —
where the previous, club-less wording was 73.

**Only the latest wicket quotes the bowler's figures.** `inn.bowling` is his running
total at *this poll*, not at the ball that got this batter, so a backfilled wicket
reading "W Vane 3–9" beside a correctly historical "9/1" contradicts itself. The truth
is not inferable either: his wicket count at that point is derivable from the batch,
but his runs are not — the card gives a running total and never says when the runs
went. So a backfilled wicket names the bowler and stops. Same rule the scoreline
follows.

**An innings' first poll is not a blank**, and this was a real silence. `matchInnings`
has nothing to pair a brand-new innings with, and "no previous innings, so skip the
lot" threw away everything that had happened in it — on our own matches, the whole of
the first over. A wicket in over one simply never existed, and the first thing the band
said about the match was "Wendover 10/1 (2 ov)", announcing a wicket it had never
reported.

**A match being new is a different thing from an innings being new**, and only the
first is a reason for silence. A match we have never polled is handled far above by the
`!prev` branch, which is what stops a device joining at four o'clock reciting the
afternoon. Inside the innings loop we have been watching, so an innings appearing is
news that happened on our watch: it is diffed against an **empty innings**, as though
we had seen it start at 0/0.

With one guard. A scorer can publish an innings late and hand us a card already deep
into it, and enumerating a collapse the room never saw is a recital, not news. Past
`NEW_INNINGS_MAX_WICKETS` (3) it stays quiet and lets the next over's score line speak.
Only wickets and the score line are at stake either way: the boundary and milestone
rules already require a batter seen in the previous card, so they cannot fire off an
empty one.

**Sequencing needed no new machinery.** Same-match events with equal interest and
equal freshness are exactly what the incumbent's time-share discount already handles
— it is how a division's eight tosses take turns. Wickets are incidents, so they never
retire each other, and pushing them in fall order makes the ranking's tie-break
(insertion order, since same-poll events share a `received_at`) show them in the order
they fell. Measured: three wickets get about ten seconds each — `MIN_SHOW_MS`, since
equal scores mean the incumbent yields as soon as it is allowed to — and the last one
then keeps the band.

### The people in the match

Three of the types are about a **person** rather than a score, and until this pass
none of them had been written: a milestone rendered as a row of a scorecard, and the
two things that happen to a bowling attack had no type at all.

**The shape is the shape a score already has**, which is the point. A score reads
club → figure → what qualifies it; an individual event reads person → figure → what
qualifies it, with the batting side and its total at the end:

```
FIFTY      J Harrington 54      · from 44 balls, 7 fours and a six · Wendover 104/2
HUNDRED    J Harrington 102     · from 85 balls, 13 fours and two sixes · Wendover 186/3
FIVE WKTS  W Vane 5–21          · 9 overs, two maidens             · Chenies & Latimer 74/5
BATTER IN  T Denham to the crease · with J Harrington on 54        · Wendover 78/5
CHANGE     T Duff into the attack ·                                · Chenies & Latimer 29/2
SPELL      T Duff 2–9           · three overs, a maiden            · Chenies & Latimer 29/2
```

The old milestone line was `J Harrington 54 (44) · Fifty for Wendover CC`, which said
FIFTY a second time under a tile already shouting it, wrote the club with a `CC` the
rest of the wall drops, and spent its one clause on the fact the reader already had.

**The tail always names the side that is BATTING**, whether the person is batting or
bowling — so `W Vane 5–21 · Chenies & Latimer 74/5` is the side he is running through
and `J Harrington 54 · Wendover 104/2` is his own. One rule, met twice, rather than
two rules to work out each time. It earns its length twice over: it says **whose
player this is**, which the strip's `1st XI` footer cannot (both sides' players come
off the same feed, so a bare name reads as one of ours), and it says what state the
innings is in, which is the *why now*. No overs and no gold in it — the strip carries
the overs a few centimetres up, and the one gold figure on a line should be the news.

**Whose player it is also decides how much is said, and what it is worth.** The middle
clause is the lean: ours gets the shape of the innings (the balls *and* the
boundaries, the overs *and* the maidens), theirs gets the bare figure. It is also the
clause that ellipsises first when a line is long, so the extra detail is spent where
it can afford to be lost. And the club test goes through to `interest`, where a
player who is not ours takes the ordinary `OTHER_CLUB_FACTOR` — their hundred still
outranks our fifty, our fifty outranks theirs. `extra.ours` on the event record is
what carries this: almost every event takes its side from the match, but an event
about a **person** belongs to that person's club, and on our own feed both sides
arrive through the same diff. Unresolvable is taken as *not ours*: the lean is a
courtesy, and claiming a player on a guess is the one way it could be wrong in public.

**A `profile` panel is what all three ask for**, and all three fall through to the
match score today — the player set is unbuilt (see `project_player_profiles`).
`T Denham to the crease` is precisely the moment that set exists for, so the
preference is recorded now and lands the day it is built.

### A team total passing a hundred — the one type whose figure is already on the strip

```
Wendover 200 up  ·  W Fairhead 94*, T Denham 32
High Wycombe 100 up
```

This is the weakest case on the wall and it is built knowing that. The strip shows
`203/4` in gold, larger and better set, so the headline figure is a duplication of the
surface next to it. What justifies the type at all is that **the crossing is a moment and
a scoreboard only ever shows a state**: the strip can never say they have *just* gone
past two hundred.

**The clause is the reason it is allowed to exist.** It names the men who built the
total, which nothing on the wall does. The lean is the usual one — ours get the top two
scores, theirs the top one — and **the star is doing real work**: a top score still
growing and one that is finished are different facts about the innings, for one
character.

**On the division's feed there is no clause**, because that card carries no batters. That
line says nothing the strip is not already showing, and it goes out anyway on the
strength of the crossing alone. It is the thinnest thing the band says, and the magnitude
below is what keeps it near the floor.

**Every hundred and nothing smaller.** Fifty is an ordinary passage of a league innings
and 150 is a number nobody celebrates; the round hundreds are the ones a ground reacts
to.

#### The mark is the magnitude

One type covers every mark, with `magnitude` doing the ordering — the `wicket_maiden`
pattern. The numbers are chosen against what they have to land on:

| mark | magnitude | interest (ours) | lands |
|---|---|---|---|
| 100 | 0.25 | 40 | a shade under `match_started` (44) |
| 200 | 0.55 | 63 | at the tier cap, just under `fifty` (64) |
| 300+ | 0.85–1.0 | 63 | capped — a total cannot climb past a fifty |

The cap is the right shape rather than a limitation: **a total is the side's afternoon
where a fifty is one man's.**

The first cut was `(mark/100 - 1) * 0.35`, which gave a first hundred a magnitude of
**zero** — the bottom of the multiplier and an interest of 20, barely clear of the floor.
A formula that starts at nothing prices the commonest case as the least interesting thing
on the wall.

#### Three guards, and each is a case that would have lied

- **`watched` / `plast`.** A crossing is a transition, so an innings we are seeing for
  the first time crossed all of its marks before we were looking. On our feed the flag is
  captured *before* the empty-innings synthesis replaces the answer; on the division's it
  is the previous card having the innings at all.
- **The innings count must match.** `plast` is the previous card's *last* innings, which
  is a different innings once the second has begun — a chase at 105 compared against a
  first innings of 80 would announce a hundred nobody watched arrive.
- **A chase stops short of the target.** The mark that takes a chasing side past the
  first innings is not a milestone, it is the match, and `match_finished` has it.
  Announcing "200 up" in the same breath as a result would be the band talking over
  itself with the duller of the two.

**Not gated on a whole over,** unlike the floor and the passage family. It is the
crossing that is the news and the ball it happened on is the one the ground cheered, so a
poll mid-over says it then rather than waiting for the over to end.

**A bigger mark retires a smaller one** — "200 up" is a wrong number once they are past
three hundred. Scoped per match as always, which here is exactly right: both sides'
totals in one match are the same running story and the older one is the stale half.

### Maidens, and why the probe turned out not to be needed

```
T Duff 2-14  ·  D Cole                        ·  Denham 20/4
T Duff 3-15  ·  three in a row, and a wicket  ·  Denham 45/6
```

This was on the list as "probe `bowling[].maidens` on a live Saturday first" — the field
is real in the raw RV card, but whether it populates *during* play is unverified, and
building on a field that might be empty all afternoon is how you ship something that
silently never fires.

**It is not needed.** A maiden is six legal deliveries of his for no runs, and his runs
and balls are the two counters the band already quotes as his figures. Deriving it from
those is the better answer even if the column does work: one fewer number that could
disagree with the ones on screen.

**His ball count is always a multiple of six at an over boundary**, because a bowler
bowls whole overs — so a suffix of exactly six of his deliveries *is* the over he has
just finished, with no alignment guesswork. Wides are invisible to the ball count and
counted in the runs, which is exactly right: an over with a wide and nothing else is not
a maiden, and this says so.

**A run of them is the same test at 12, 18 and 24 balls.** No counter to keep, and the
same refusal to guess when the window cannot be landed. Four overs is as far back as
`hist` reaches, and four consecutive maidens is already a passage nobody in the ground
will forget.

**And unlike the hat-trick, it works at either cadence.** At one poll an over his delta
is six balls outright; at fifteen seconds the deltas are a ball each and sum to six at
the boundary. Only a straddled poll — balls five to eight — cannot land, and it says
nothing. So this family *can* be walked in the simulator, and was verified at both
cadences on the bench.

**It must be the poll he finished the over on.** `balls % 6 === 0` is a standing state,
not a transition: while the other end bowls, his count sits on the boundary and the test
answers yes on every poll of the next four minutes. The store's id de-duplication hid
this — the event carries his ball count, so thirty repeats collapsed into one — but an
extractor emitting a maiden thirty times is wrong on its own terms. `db > 0` is the
transition.

#### Two events, ranked, and no event for an ordinary maiden

- **`wicket_maiden` (56)** — six for nothing with a man out, the best over a bowler
  bowls short of a hat-trick. Below the `wicket` itself on purpose: the dismissal has
  already had its line at 70, and what this adds is that the over around it was
  flawless. **`magnitude` carries one wicket against two**, which is why it is one type
  and not two — a double-wicket maiden lands in the wicket's own tier.
- **`maiden_run` (50)** — the squeeze told through one bowler, and priced level with it
  for that reason. **Three is the threshold**: one maiden is an ordinary over in league
  cricket and two is a spell going well, but three consecutive overs for nothing is the
  fielding side taking the game over.
- **A lone wicketless maiden is not an event**, which is the right answer in a league
  where most bowlers manage one.

**Ranked, not both.** A wicket maiden that completes three in a row is one over and gets
one line — the run is the bigger half of it, so its clause carries the wicket too.

**A longer run retires a shorter one**: "three in a row" is a wrong number once it is
four, the same reasoning a century stand retires its fifty. **Known scope limitation:**
`RETIRES` is per *match*, so a second bowler's run of maidens would retire the first
bowler's, which is not false, only earlier. It needs two bowlers with three consecutive
maidens each inside one ttl to happen at all, and the alternative is a per-person
retirement scope that nothing else wants.

#### What this did to `spell_ended`

Its "two maidens" clause read the feed's `maidens` column — the one field here whose live
population is unverified — so the clause either worked or silently never appeared, and
from this repo we could not tell which. It now counts the maidens we have **proved** him
to bowl in that spell (`dm` on the spell record, incremented where each maiden is
detected). The count is taken onto a new spell's `start` *before* the over just bowled is
added, so a maiden that is itself the first over of a spell belongs to the spell it was
bowled in. It degrades the way everything else here does: overs bowled before we were
watching are not in it.

**That leaves nothing in this file depending on `maidens`**, and the probe item with it.

### A hat-trick, which the feed does not carry and we can still prove

```
W Vane 3-11  ·  D Cole, E Shaw and F Nash  ·  Denham 26/5
W Vane 2-11  ·  on a hat-trick             ·  Denham 20/4
```

There is no ball-by-ball data on either feed, so this looked impossible and is not. A
hat-trick is **three wickets in three consecutive deliveries by one bowler**, and the
card carries that bowler's running balls and wickets. So keep his poll deltas as a short
list (`hist` on the spell map) and accumulate backwards:

> **If a run of consecutive polls sums to three balls and three wickets, every delivery
> in that run took a wicket — so they were consecutive, necessarily.**

`suffixOf` stops as soon as it has enough balls, which is what lets the caller insist on
landing *exactly* on the window it asked for. Three balls and three wickets is a
hat-trick. **Six balls and three wickets is three wickets in an over and says nothing
about which three deliveries they came off, so it is refused** — that refusal is the
honesty in the whole mechanism, and it is the difference between this and a guess.

**It is correct at any poll cadence, and it fails silent.** The claim rests on a delta
being exactly three of *his* deliveries, and a bowler's own three deliveries are
consecutive by definition however often we looked. What granularity changes is only
whether the window lands cleanly: production polls every fifteen seconds against a ball
every thirty-five, so most deltas are a ball or none. A scorer syncing in lumps of overs
produces `{6 balls, 3 wickets}` and we say nothing. Missing one beats inventing one.

**A poll in which he did not bowl clears nothing.** A bowler between overs keeps his
two-in-two, which is what the Laws say — consecutive deliveries *by him*, not
consecutive balls of the match — and it is why the across-the-over-boundary case (fifth
and sixth balls of one over, first of his next) works, which is the case a naive
implementation loses. Wides are invisible to the over count, and that is right too,
since a wide does not break a hat-trick. **A counter going backwards is a correction,
not cricket**, and the history is thrown away rather than reasoned about.

**The three victims are named, and they are exactly derivable.** The last three
dismissals of the innings *are* his three — not by assumption, but because a run-out or
a wicket at the other end in the middle of the sequence would have advanced his ball
count without a wicket to his name, which breaks the suffix and means no hat-trick was
claimed. `hatVictims` checks each against his name anyway and drops the clause rather
than guess, because a scorer's spelling can move between polls and three names that are
not the right three is worse than no names. The clause is the three men rather than the
words "three in three", since the tile already says HAT-TRICK.

#### `on_a_hat_trick` — the one event that looks forward, and the retraction

Two balls, two wickets: the same suffix test one ball shorter. It is the only thing the
band ever says about a ball that has not been bowled, which is why it outranks a wicket
— and the only type whose truth can **expire on a ball we never see**.

**The tile states the fact and the bar states what it means** — TWO IN TWO over "W Vane
2-11 · on a hat-trick" — because a tile reading ON A HAT-TRICK would leave the sentence
nothing to add.

It is built to die young: `ttl` two minutes, `repeat` null, and a real **retraction**
rather than mere ageing. This is new machinery and it is small: an event may carry
`retires` of its own and `retire_only`, in which case the store applies the retirement
and **throws the event away** — it is never shown, never remembered in `byId`, and
`live-engine.js` filters it out of what a poll hands back, so a simulator or an
inspector listing "what this poll produced" cannot print a sentence that was
deliberately never written. "W Vane did not take a hat-trick after all" is not news.

**And the retraction only retracts what it can prove.** A poll with no wicket in it at
all proves the hat-trick ball was survived, and the line goes. A poll that spans two
balls and brought one wicket does not: it may have been the hat-trick ball or the one
after, and the suffix test cannot separate them either — so no hat-trick was claimed and
nothing is retracted. Both halves stay honest by saying nothing, and the two-minute ttl
clears the pending line. Retracting there would be as much a guess as claiming it. The
dismissals themselves are unaffected, having each had their own event, so the room is
under-informed rather than misinformed.

**A hat-trick retires the two-in-two** for the other answer: the question has been
settled by the best possible result.

#### It cannot be seen in the simulator

`playInnings` snapshots **once per completed over** and the whole simulated day is
indexed on that axis, so every card the simulator hands the extractor advances six balls
at a time. A hat-trick therefore arrives as `{6 balls, 3 wickets}` and is refused, and
two-in-two never fires at all. That is the detector being right, not the simulator being
broken — but it does mean this family has to be verified on a **ball-by-ball bench**
rather than by walking the sim, which is how it was done (including the
across-the-over-boundary case and the retraction).

Putting it in the simulator means per-ball snapshots kept under the existing over axis,
picked by the fraction of the over elapsed — self-contained, but a simulator job rather
than a wording one.

### The passage of play, as an event

```
Wendover have added 32 in 3 overs        ·  W Fairhead 31* and T Denham 13*
Wendover have added 4 in 5 overs         ·  W Fairhead 45* and T Denham 29*
Wendover have lost three for 13 in 6 overs  ·  W Fairhead 50* and H Godden 0*
High Wycombe have added 24 in 3 overs
```

> The **wording** of this family is provisional — James is reviewing the text of the
> whole stream in a later pass. What follows is the emission logic, which is the part
> that is settled.

Three faces of one idea, and the idea is the thing a scoreboard structurally cannot
show: it displays a number going up, and it can never say that the number has started
going up *faster*, or has stopped, or that the innings is falling over.

| face | base | window | test |
|---|---|---|---|
| `collapse` | 72 | 3 wickets within 6 overs | wickets alone — it is not defined by time |
| `charge` | 52 | 3 overs (+3 slack) | ≥ 1.75× the baseline rate, ≥ 24 runs, ≤ 1 wicket |
| `squeeze` | 50 | 5 overs (+3 slack) | ≤ 0.45× the baseline, ≤ 12 runs, baseline ≥ 4 an over |

All three are subtractions of two published totals — the same arithmetic the floor's
passage clause already does, promoted to news when it crosses a threshold worth a
screen.

**The baseline is the innings itself**, not a par rate for the league. "They have gone
from four an over to nine" is the news; "they are scoring at nine" is a fact about the
pitch. And it is measured **up to the window's start, never including the window**, or a
burst pollutes the baseline it is being judged against and every burst comes out smaller
than it was.

**A ratio is not enough on its own.** Two runs an over against one is a doubling and it
is nothing, so each face carries an absolute floor as well. The squeeze also requires a
baseline *worth* squeezing: a side already scoring at two an over cannot be strangled,
and saying so would be reporting an ordinary league afternoon as a triumph.

**Each face has its own window,** because the three are not the same length of event. A
burst is three overs; a drying-up needs five or six before it is real rather than one
quiet over; a collapse is defined by its wickets and not by time at all — which is why
it reads the log from the other end (`anchorWithin`, the oldest row within six overs,
against `anchorBack`'s newest row at least *n* overs back).

**The window must be roughly the one we asked for.** The division's log is sampled per
observation, so the nearest anchor to "three overs ago" can be twelve overs back — at
which point the test means something else entirely and the sentence is about a different
passage of play. `slack` bounds it, and no anchor in range yields no event.

**They are ranked, because one window can answer to two of them.** Three wickets for
eleven is both a collapse and a squeeze, and the collapse is the bigger thing to have
happened. The charge cannot collide with either, since it caps the wickets in its window
— a burst with three men out is not a burst.

#### One event per passage, not one per over

A burst that runs for six overs answers the charge test on every one of them, and a band
that said so would be reporting the same four overs four times. The rule is **disjoint
windows**: the next event of a face may not fire until its own window has cleared the
last one (`surgeFresh`, riding on `m._surges` with the rest of the derived memory). So
two charges always describe two different passages, and the constant that decides it is
the window itself rather than a cooldown invented beside it.

**The same rule applies between the surfaces, one level up.** Two places can tell the
same passage of play, and both now stand down:

- **A surge stands the floor down** for that poll (`saidScore`), exactly as a wicket
  does. The score line's clause *is* the passage clause — the same subtraction over the
  same overs — so an over that produced a charge would otherwise say "44 in the last 4
  overs" twice from one poll, the second time with the duller half of it. On the
  division's feed the surge replaces the score line outright.
- **The floor never measures back past the last thing we said.** A charge has just
  announced four overs in its own tile; a floor line measuring six overs through the
  same passage restates it a minute later. So `passageClause` clamps its anchor to the
  last surge in that innings and describes what has happened *since*. Where that leaves
  nothing measurable the fixture takes the slot, but it will take the oldest row after
  the announcement rather than sit silent for five overs — the passage since is short,
  and it is what has happened.

**A passage is an incident**, so none of the three is ever retired: "they added 44 in
four overs" stays true afterwards, and a later squeeze does not unmake an earlier
charge. All three retire the routine snapshot, for the usual reason — once the band has
said what the last four overs were worth, where they are is the duller half of it.

**And this is the one family the division's feed can hold its own in.** A charge, a
squeeze and a collapse are made of nothing but totals and overs, which is all its card
carries. Everything else the band says about a match — the people, the dismissals, the
spells — is ours alone, so these three are what let another club's afternoon be
*described* rather than merely scored.

### The last pair together — a state, not a transition

```
I Nine 24* and K Eleven 1*   ·  41 still needed  ·  Wendover 146/9
W Fairhead 45* and A Roan 3*                     ·  Wendover 224/9
```

Nine down, and everything that happens now is the end of the innings one way or the other.
A consequence of a wicket like `new_batsman`, but a much larger one: an arrival changes who
is batting, where this changes what the rest of the innings can be. It sits below the
`wicket` that made it (70) and is handed **`tension`** — nine down needing 41 is a
completely different line from nine down at 300, and the chase model already knows which.

**It is tested as a state, and that is the interesting part.** The obvious implementation
is "the ninth wicket falling", and it does not work: on that poll the man coming in has
faced nothing, so there is no pair to name. `creasePair` requires both men to have faced
something — the same rule `new_batsman` uses, and the right one here too, since a pair is
*together* once both are batting. So the condition is tested on every poll and the answer
is latched:

```js
function onceOnly(m, ii, tag)   // one sentence per innings, in the derived memory
```

The store's id de-duplication would have hidden a missing latch, exactly as it hid the
[repeating maiden](#maidens-and-why-the-probe-turned-out-not-to-be-needed) — so the latch
lives in the extractor, where the decision belongs.

**Nine wickets is the last pair only if there is a pair.** A side batting a man short is
all out at nine, and requiring two men at the crease is what tells the difference without
having to know the squad size — which no card reliably states.

**The clause is the chase, where there is one.** Nine down needing 41 is the whole question
the rest of the afternoon answers, and although the strip's chase block carries the same
figure, this is the one line on the band where it *is* the news rather than the standing
state. On a first innings there is nothing true to add — the stand is a ball old by
construction — so the line is the pair and the score, with the tail's `/9` doing the work.

**And the arrival stands down for these two.** The last-pair line names the incoming man
and what he has, so "K Eleven to the crease" a line later is the same moment said twice,
and the smaller half of it. Suppressed at emission rather than by retirement, because the
arrival is pushed *after* this and a retirement only reaches events already in the store.

**The tenth wicket unmakes it** — they are not together any more, they are all out — so
`wicket` retires it, as do `innings_closed`, `match_finished` and `abandoned`. The wicket
that *creates* the last pair does not, and for a reason worth keeping in mind when reading
that table: the wickets block runs first in the extractor, so its retirement reaches only
events already in the store.

### Closing in on a milestone — forward-looking, and safe about it

```
J Harrington 44  ·  needs 6 for his fifty       ·  Wendover 104/2
W Fairhead 94    ·  needs 6 for his hundred     ·  Wendover 202/5
```

The second type that looks forward, and a far safer one than `on_a_hat_trick`: "he needs
six for his fifty" stays true for a dozen balls where a hat-trick ball is answered by the
next delivery. So it needs none of the retraction machinery — the milestone retires it, a
wicket retires it, and the ttl outlives neither.

**The tile says CLOSING IN and the sentence says what he is closing in on and by how
much** — the same division of labour as TWO IN TWO over "on a hat-trick".

**Fired on entering the last ten**: crossing 40, or 90. A transition, so it goes out once
and `repeat: null` keeps it that way — a batter who sits in the forties for twenty minutes
is not news twenty times. Ten is the right width: five is so close that a single blow
skips the window altogether, and twenty is not approaching anything.

**The higher mark is tested first**, so a batter arriving in the nineties is closing in on
a hundred and not on a fifty he passed an hour ago. And `< mark` keeps it out of the
milestone's way: a blow from 44 to 52 crossed the window and the mark in one poll, and the
`fifty` has already said the only thing worth saying.

**The gap is as at the poll**, and it can be a run or two stale by the time the band shows
it. That is the softest version of the risk `on_a_hat_trick` carries, because what ages is
a number inside a sentence that stays true — and the milestone firing is what stops the
gap ever being seen at zero or below.

| mark | magnitude | interest (ours) | lands |
|---|---|---|---|
| 50 | 0.3 | 40 | beside `match_started` (44) |
| 100 | 0.8 | 58 | just under the `fifty` it is not yet (64) |

**A man out in the forties makes the line false, not old**, so `wicket` takes the approach
with it. **Known over-reach:** `RETIRES` is per match, so that also retires the *other*
batter's approach, which is still perfectly true. It costs that event the rest of its time
on the band and never puts a wrong sentence on screen, where not retiring would leave the
band telling a room that a man walking off needs six more. Two batters approaching marks
at once is rare; being wrong in public about one of them is not worth the trade.

**There is no approach to 150**, because there is no `hundred`-style milestone above a
hundred either. If one is ever added the window comes with it.

### A partnership, which is the first event about two people

```
J Harrington and W Fairhead  ·  53 together in 8.2 overs  ·  Wendover 104/2
```

One type, `stand`, every fifty. The shape is the individual family's with
the pair where the person goes — who, the figure, what qualifies it, the side and its
total — and the new thing is the qualifier: **a stand's length**, which no surface on
the wall carries and which is the difference between a counter-attack and an hour of
survival.

**The runs are `fow` arithmetic and need no memory.** A stand is the total now less the
total when the last man went, and both figures are published by the scorer. Extras
added while the two have been in belong to the stand, which is what a partnership
means.

**The overs are memory, and they are guarded.** The feed carries no over on a fall — so
the only honest source for when a wicket fell is the over count on the card we were
holding when it appeared (`logFall`, riding on `m._falls`). At fifteen seconds a poll
that is within a ball or two. Under a lumpy sync it is overs out, so the log records how
much cricket the poll itself spanned and **more than two overs marks the reading
`wide`**, after which the stand is stated in runs alone. A missing clause beats an
invented number. An opening stand needs no log at all: nobody is out, so the innings'
own over count is its length.

**The figure is the stand as it stands, not the mark.** By the time a poll catches it
they are usually a few runs past: 53 is the true number, and the one the strip's own
figures can be reconciled with.

**Every fifty, and one type for all of them.** It began as `stand_fifty` and
`stand_hundred`, which stopped dead at a hundred — a stand of 150 or 200 raised nothing at
all. A type per fifty is the wrong shape, and a 150 stand under a tile reading CENTURY
STAND is worse, so the tile says the noun (PARTNERSHIP), the sentence says the figure — it
always did — and `magnitude` carries the difference. The `team_total` pattern, for the
same reason.

| mark | magnitude | interest (ours) | lands |
|---|---|---|---|
| 50 | 0.32 | 58 | just under an individual `fifty` (64) |
| 100 | 0.52 | 79 | above a `wicket` (70), below a personal `hundred` (92) |
| 150+ | 0.72–1.0 | 80 | the tier cap |

The cap flattens 150 and 200 together, which is the right shape rather than a limitation:
by then the stand is the biggest thing in the match bar somebody's hundred, and a league
afternoon rarely produces one. **The floor is 0.32 and not zero** — a magnitude of nothing
puts the commonest case at the bottom of the multiplier, which is the mistake `team_total`
made first time and which priced a first hundred at 20.

**The highest mark crossed, and only that one.** A poll wide enough to take a stand from
40 to 105 is wide enough that "fifty together" would be a wrong number the moment it went
up.

**No split of the contributions**, though the card carries both. "34 and 19" beside "53
together" invites a reader to add them up and get a different number, because the
extras belong to the stand and to neither batter. The one place the arithmetic would be
visibly wrong is the place it would be checked.

**A stand is not an incident, and it is the one thing on the wall that can be made
false by a later event.** Two men on 53 together stop being on 53 together the moment
one of them is out, so `wicket` **retires** the stand in that match, and a stand retires
its own kind — the same pair on 153 make "104 together" a wrong number rather than an old
one, whatever marks the two lines happened to be about. That is the retirement test
exactly, and it is why a stand does not get the wicket's exemption.

**Not in the same poll as a wicket.** The stand is measured from the last fall, so a
poll that brought one is comparing two different pairs and the crossing would be an
artefact of the arithmetic. Wickets unchanged is the whole test. Nor off a synthesised
previous card — the same guard the arrival and the boundary rules use, or a
late-publishing scorer announces a partnership built before we were watching.

**Not in the same breath as a personal milestone — but only when it really is the same
fact.** A stand of 54 with fifty of them to one man *is* his fifty, and his is the
bigger claim, being the one a scorecard keeps. But a man who reaches fifty across three
partnerships on the same poll as this pair reach theirs is a coincidence of arithmetic,
and a first cut of this rule suppressed exactly that — on both test innings. So the test
is his **share of this stand** (`standShare`: his total now, less what the fall log says
he had when the last man went), and it is applied only when the log can prove it. An
unproven share suppresses nothing.

The test generalises to every mark without changing: a share of 150 in a 150 stand means
he made all of it, where a hundred of it means the stand and his hundred are two facts and
both are said.

#### And what the wicket says about it

```
Wendover 139/3 (25 ov)  ·  B Duff ct Vane b Duff 46 — W Vane 2-19, ending a stand of 85  ·  Denham to bat
```

The stand a wicket broke is what the wicket *did* to the match, and it is the half a
scoreboard can never show: the strip's figures are a state, and a partnership only
exists as the difference between two of them. Two fall figures subtracted, so it is
exact for a backfilled wicket as much as for the newest one — `newDismissals` now
carries `prev_fow` for the purpose, with 0 for the first wicket, whose stand is the
opening one.

It goes **inside** the dismissal clause rather than beside it, because that clause is
the group marked `shrink`: on a long line the stand is the first thing a reader can
afford to lose, where the scoreline at the head and the club at the tail are not.
Thirty runs is where it becomes worth saying; below that the stand is not what the
wicket did, and a clause reporting every eight-run partnership would be reporting the
over rate again.

### A batter arriving, and why it is detected on his first ball

`new_batsman` fires on a **runs/balls counter moving off zero**, not on his appearing
in the card. RV lists the whole squad with a `number` of 99 until they bat, and the
worker's normalisation of that is not something the band should read tea leaves from;
a counter moving is unambiguous on any shape of card, and it is the same kind of claim
the boundaries make — a difference between two stated numbers.

It also puts the sentence in a better place. The arrival lands a poll or two *after*
the dismissal that caused it rather than in the same breath, so the band says the
wicket and then says who walked out to face the next one, which is the order the
ground saw it in.

**The openers are not an arrival.** At 0/0 nobody has come in — they have started, and
the toss and the first score line have that covered. So it takes a wicket to have
fallen, which is also what makes the line worth reading: a batter is only news when
the situation he walks into is. And not off a synthesised innings either — the empty
previous card that the `!pinn` branch builds makes every batter look brand new, so a
late-publishing scorer would announce both not-out batters at once.

**A wicket retires the last arrival**, and this is a state, not an incident: "T Denham
is in" describes the pair at the crease, and a wicket has just broken that pair. Same-poll
ordering makes it safe rather than lucky — the wickets are pushed before the batters
loop runs, so a wicket landing beside the arrival that *followed* it retires the
previous one and leaves the new one standing.

### Spells — the one thing a scorecard knows and never says

A bowling card carries a running total per bowler and nothing else: no spells, no
ends, no first change. But a spell is **derivable from that one figure**, because of
how cricket is arranged — a bowler in a spell bowls every *other* over. So his count
standing still while the innings advances by two overs means he has been taken off,
and it means it at the moment the room notices: the over he would have bowled and did
not.

**Twelve balls is the rule and it is not a fudge factor.** It is one over from each
end — the over he did not bowl, plus the one from the other end that proves the game
moved on rather than stopped.

**The gap is measured to where the innings stood when he STARTED the over**, not where
it stands now. His own deliveries move the innings' count along with his, so comparing
the two current figures counts his own over as part of the gap — and left that way an
ordinary rotation reads as a fresh spell **every second over**: six of his plus six
from the other end is exactly the twelve the rule is looking for. Measured both ways
against a fourteen-over innings, at one poll an over and again at one poll a ball: the
corrected rule puts the same two spells in the same two places at both cadences, which
is the test that matters, since production polls at fifteen seconds and a lumpy scorer
polls at whatever he feels like.

**An opening bowler is not a change.** The pair who start an innings take the new ball
together and only one of them is in the card after the first over, so the other turns
up as a brand-new bowler on the second and was announced as though the captain had
rung a change after six balls. Anyone whose first over is one of the innings' first
two opened the bowling.

**Three overs or it is not a spell.** Two is a look, and a band announcing every bowler
who had a look would be reporting the over rate. The floor is on the *spell's* own
overs, so a bowler returning for one more over and being taken off again does not get
a line off the back of the six he bowled an hour ago.

**The figures are the spell's, not the match's** — the spell is what just ended, and
his running total is a different fact that will be on the scorecard all evening. Where
the two differ the clause says so (`3–24 in all`) rather than leaving a reader to
wonder which they are looking at; where they are the same, which is most spells,
nothing is said.

**`magnitude` is what decides whether one reaches the wall**, and it is why this is one
type rather than two. It is set from the wickets in the spell with a nod to the
maidens, so a wicketless five overs scores 26 and a three-for scores 50 — the spread
the type wants, off the dial that already means "how big".

**What this cannot see**, stated so nobody looks for it later:

- **A change of ends reads as one spell**, because the card has no ends in it.
- **The last spell of an innings never ends**, because the innings stops advancing and
  the clock this runs on is the innings' own over count. The innings closing is the
  news at that point and has its own type.
- **A spell spanning a break is one spell**, which is right: tea does not take a bowler
  off.

**The state rides on the card**, the way `_received_at` does — the engine holds this
poll's card as the next poll's `prev`, so a map stamped on it (`m._spells`, keyed by
innings and bowler) is a map we have next time, and it carries where each spell began
so its own figures can be subtracted out of the running total at the end. It is
stamped on **every** poll including the first, where the moves are thrown away: a poll
that skipped it would lose a bowler's place in his spell. **An innings we have never
tracked says nothing** — its bowlers are all "new" against an empty map, so a first
sighting or a late-published innings would announce four changes at once for overs
nobody watched us miss. Seed the map, wait for the next poll. It is the rule the
wickets follow one block up, applied where it cannot be softened, since a spell needs
a history by definition.

### A stream coming online

```
STREAM   Wendover v Denham in TVCL Div 6C is being live streamed · @WendoverCricketClub
```

The one event on the wall that is **not news about the cricket**. It is an invitation
— this game can be watched, and here is where — which is why it outranks a match
merely starting, why its ttl is twenty minutes rather than five (a viewer has to fetch
a phone, find the channel and settle), and why it fades slowly and comes back. An
invitation nobody was in the room for is an invitation nobody got, where a wicket
announced to an empty room has at least happened.

**It says the fixture, not the score.** When a stream comes online the match may be
four minutes old, and a viewer deciding whether to go and watch wants to know *which
game*, not what the score is. The division rides in the same clause for the reason it
does on a match starting: on a wall showing three of our sides there is otherwise
nothing to say which one this is.

**The handle is its own group**, and is the only part of any line on this band that is
an instruction rather than a statement. It takes the club type a club name takes,
because that is what it is — the club's name, in the form a reader has to type. It
comes from `live-config.json` once (`_youtube_channel`, read from the authored
`homepage_cards` YouTube entry) rather than from each fixture, and the line is complete
without it.

**Three signals, ranked by how much they prove.** It is detected as a *transition*, the
way the toss is:

| signal | what it proves |
|---|---|
| `recording_started_utc` appearing | the stream came online, outright |
| a `video_id` appearing | probably — an id may be minted with a scheduled broadcast, but on a card that had none it is new |
| the first clip arriving | a camera exists; footage cannot be produced without one |

The first is the real answer, and `scripts/probe_live.py`'s anchor loop is the evidence
for it: it retries `recording_started_utc` precisely because a match probed *before* its
Frogbox stream comes online has none, and gains one when it does. The other two are
there because **the Worker's normalisation decides which of the three actually reaches
us, and that is not visible from this repo** — worth confirming with
`scripts/probe_live.py <pc_id> --raw` the next time a streamed fixture comes round.

**A card that carries its stream all day yields nothing**, and that is the honest
failure rather than a bug: there is no transition to find, so nothing is announced —
which beats announcing a stream at whatever time we happened to start polling. Same
rule `match_started` follows.

### The score line is written against the scoreboard beside it

`score_update` is the **floor**: it goes out every over on every match we can see, and
it is the one type that is not news. Under v1 the band *was* the scoreboard, so the
line was the score — club, figure, overs — with a clause behind it. The strip is now
the scoreboard stood on its end, and by the time that landed every group of the old
line was already on it, larger and better set:

| the old line said | the strip says it |
|---|---|
| `Wendover 60/1 (6 ov)` | the `Runs`, `Wickets` and `Overs` apertures, in gold |
| `· Denham to bat` | the `TO BAT` tile under the side still to come |
| `· Need 47 from 60 balls, 5 wickets left` | the chase block — `To win`, `Balls left`, `Req rate` |
| `· Wendover v Denham · TVCL Div 6C` | two crest tiles over the division in the footer |

So the floor stopped repeating the numbers and took the half of a quiet over the
scoreboard cannot hold. **The split is the one the two surfaces are for:**

- **the strip is STATE** — where they are, this second;
- **the ticker is CHANGE** — who is doing it, and how the last few overs have gone.

A scoreboard has never named a person and cannot say what happened five overs ago, and
those are exactly what makes a routine over worth a line. They are also what a
commentator reaches for when nothing has happened: *"Harrington settled on 38,
Fairhead 15, forty-four together."*

```
J Harrington 38* and W Fairhead 15*  ·  44 together          ·  Wendover batting
J Harrington 38* and W Fairhead 15*  ·  J Harrington 38, two fours  ·  Wendover batting
W Fairhead 0* and B Duff 9*          ·  25 for one in the last 5 overs  ·  Wendover batting
High Wycombe                         ·  18 for two in the last 5 overs
```

**The lead is the most specific actor the feed can name.** Our own card knows who is
in, so the pair leads and the club drops to the tail; the division's card has no
batters at all, so the club *is* the most specific thing it holds and it leads. One
shape filled as far as each feed allows, rather than two different sentences — the
same rule that made the old line the league line, pointed the other way now that there
is something better than a scoreline to lead with.

**The star is doing work.** `38*` is how a scorecard says an innings is still going,
and it is the reason a figure is worth reading on this line at all: these two are the
men in, and neither number is final.

**The tail names the batting side in one word.** It is the same job it does on every
individual event — two names off our own feed could belong to either side, and the
strip's footer says which of *our* XIs this is, never which club is batting. The score
is not repeated with it.

#### The clause, in the order a reader would miss it

1. **The boundaries just hit** (`boundaryClause`) — the only candidate that is news
   rather than standing context, and the reason the floor is worth a screen at all
   during a passage of play.
2. **The stand** — `44 together`, runs added since the last wicket fell. A subtraction
   of two figures the feed states: the total now, and the total when the last man went
   (`fow`). Extras added while the two have been together belong in it, which is what a
   partnership *means*, so the team total is the right minuend. No wicket yet means the
   whole total is the stand, and an opening partnership is the commonest thing this
   clause says. **It refuses to guess**: if the fall figures cannot account for every
   wicket — one of them null, a name that changed spelling between polls — the highest
   `fow` we can see belongs to an *earlier* wicket and the stand would come out too
   big, so it stands down and the passage takes the slot. Under ten runs it stands down
   as well; "3 together" is arithmetic, not a story.
3. **The passage** — `25 for one in the last 5 overs`, which is the clause that works
   off a bare scoreline and so the division's normal one.

**The chase left this line altogether**, and so did the side still to bat. Both were
ranked ahead of naming anybody in the old order, and both are now tiles of the strip's
own panel in figures a room can read; saying them again in prose a few centimetres
away was the duplication this pass is about. `toBatTail` survives on the **wicket**,
whose scoreline is stamped to the ball it fell on and which has no panel duplicating it.

**With nothing to say, say whose game it is.** A first sighting has no history to
subtract and a division card has nobody to name, so the fallback is the fixture and its
division — the one line worth more than a club standing on its own.

#### The passage is two stated totals, subtracted

An over log rides on the card as `m._passage` (the `_spells` and `_received_at`
precedent), carried forward poll to poll by `carryDerived` (which brings the fall log with
it) and appended to by `logOver`. Each row is `{balls, runs, wickets}` at a whole over.

That is all the clause is, and it is why it may make a claim about **time** where a
boundary counter may not: both ends of it are scores the scorer published, and the
overs between them are the difference of two over counts. Nothing is inferred about
any individual ball.

- **The anchor is the newest row at least five overs old** — about half an hour of a
  league afternoon, long enough for a rate to mean something. Early in an innings there
  is no row that old, so the oldest is used instead, provided it is two overs back. One
  over back is the over that has just finished, and "6 in the last over" is the
  ball-by-ball claim this clause exists to avoid making.
- **The log is kept whether or not a line goes out.** It records where the innings
  stood, not what we said, so an over that produced a wicket — and therefore no floor
  line — still leaves an anchor behind it. Logging inside that gate would measure the
  next five overs from the wrong ball.
- **The division logs per observation, not per over.** That feed has no over-by-over
  truth to offer and its over count arrives coarse and patchy, so the anchor is
  wherever the last changed scoreline was seen and the clause states the gap it
  actually measured. `34 in the last 6 overs` off two observations six overs apart is
  the same subtraction as six consecutive ones.
- **The overs are written as a scorecard writes them** (`oversWord`), so a gap of
  twenty-one balls is `3.3 overs` and never `3.5` — a part-over gap is the normal case
  on the division's feed, and a decimal there would be a different number from the one
  it means.
- **A wicket count is counted, not introduced.** `countWord` gives "a four" because one
  four is a thing that happened; a wicket column has always been read as a number, so
  `wicketWord` gives "for one", "for two".

### There is no `four` or `six` event

Both were removed, and the reasoning generalises. A boundary is a **counter** on the
batter, and a counter cannot say *when*: the event's `happened_at` was the poll
bracket, so a lumpy sync raised a SIX tile for a shot played twenty minutes earlier
and freshness — which prices news by when it happened — had no way to know. The
counters are not even reliable about *how many*: against one real scorecard the
highlight feed had 58 fours to the batters' 55 and 17 sixes to their 13, because a
boundary in byes is not a batter's four and scorers' boundary columns drift.

So the boundary became a **clause on the score** instead (`boundaryClause`). Nothing
is lost and the dishonesty goes: the score is current by construction, and the
boundaries qualify it rather than claiming a moment of their own.

```
J Harrington 38* and W Fairhead 15*  ·  J Harrington 38, two fours and a six  ·  Wendover batting
J Harrington 38* and W Fairhead 15*  ·  Two fours  ·  Wendover batting
High Wycombe  ·  Three fours
```

Three rules inside it:

- **No time claim at all.** This briefly said "in that over" when the innings had
  advanced by exactly six balls — true whenever it fired, but it fired by *accident*:
  the score line only goes out on a whole over while the previous poll lands wherever
  the 15-second timer put it, so a six-ball delta is a coincidence of poll timing and
  not a fact about the cricket. A phrase that appears on one over and not the next,
  for reasons invisible in the ground, reads as a bug.
- **The batter is named only when he hit all of them.** Two batters sharing a burst
  get the count and no name: "two fours for J Harrington" when one was his partner's
  is a small lie nobody would ever catch.
- **Name and total first, then the shots** — matching the dismissal clause, which is
  already name-then-figure.

A boundary row from the highlight feed does **not** re-raise one of these events
either. Footage of a boundary is a REPLAY, which is its own surface; letting an
unclaimed row raise a `four` would bring the type back through the side door on the
streamed match only — the one place the inconsistency would be hardest to spot.

**A final group names the bowling side**, on the `wicket`, first innings only:
`· Chenies & Latimer to bat`, with the club in the **batting team's own strong type**
and the state muted behind it. It was on the `score_update` too until the strip became
the scoreboard, which states the same fact as a `TO BAT` tile — see the score line
above. It was the one thing the band never said
— a wicket named who got him, a score said where they were, and on a wall showing
three of our XIs at once neither said which club was bowling. It replaced a
possessive club inside the dismissal clause, which paid for the name twice over in the
phrase least able to afford it.

It is first innings only because "to bat" is only true there; in a chase the fielding
side has already batted and the same words would be a plain falsehood.

**Both feeds carry it.** The division's card is thinner in every other respect — no
batters, no bowlers, no dismissals — but it names both clubs and says which is
batting, which is all this phrase needs. One wall, one way of writing a score.

**The particulars are what gives way.** A long line overflows, and the segment used to
clip its own right-hand end — losing the newest information and the club. The group
carrying the particulars is marked `shrink` and every other group is pinned, so the
clause ellipsises inside itself: a dismissal's how-and-for-how-many is what a reader
can most afford to lose, where the figure at the head and the club at the tail are not.

**The score's clause is chosen in one order** — the burst, then the stand, then the
passage, then the fixture. See the score line above for what each one is and why it
sits where it does.

**The floor stands down when the poll already said the score.** A wicket, a four and a
six all lead with the scoreline now, so one landing on an over boundary used to produce
the same sentence twice from one poll — and the second was the weaker of the two, since
the incident says what *happened* while the floor says only where they are. Worse, the
floor line is added *after* the incident, so it was never retired by it: once the
incumbent's time-share discount bit, the band dropped the wicket and repeated its
scoreline with a duller clause. The floor exists to fill silence, and an over that
produced a wicket was not silent.

**Boundaries are not events at all any more** — see below. The reason they could not
be split is the same reason they could not stand alone: the feed. A wicket has a
row; a boundary has only a **counter** on the batter (`fours`, `sixes`). A jump from 1
to 3 says two of them happened somewhere in the gap and nothing about their scores,
their overs or their order, so emitting two events off one observation would be
inventing a ball we were never told about. The honest unit is the burst: one event
that says how many — `W Fairhead moves on to 15 (2 fours)` — with the batter's total
carrying the rest. Per-ball boundary events need per-ball data, which today exists
only for a **streamed** match, where the clip carries its own over and ball.

`score_update`'s `ttl` is deliberately longer than the gap between two of them. A
snapshot is retired by its own successor, so the **only** way an old one survives is
that no newer score exists — in which case it is still the best truth we have. At
three minutes it died between overs and left the coverage rule with nothing current
to lift.

**There is no `innings_update` any more**, and the way it died is worth recording.
It was a second, heavier snapshot every fifth over, and its purpose was a *coverage*
rule — make sure every match gets a score on screen from time to time — expressed as
a type weight. It bought that badly: it never fired for the division at all, it
lifted a match that had just been on screen exactly as much as one unshown for twenty
overs, and counting in overs meant rain or a slow over rate suspended the guarantee
precisely when it mattered. It also carried a second, unrelated job — a non-weather
`break_desc` was written as an `innings_update`, which is where the name came from
and why it described neither job. The coverage rule now lives in the scheduler and
the break has its own type.

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
| `score_update` | `toss`, `match_started`, the previous `score_update` |
| `innings_closed` | those, plus `match_break` |
| `match_finished`, `abandoned` | all of the above, plus `probability_shift` |

**A wicket retires a score but is not retired by one**, which is the one asymmetry in
the table. Its scoreline is stamped to the ball it fell on, so it reads as where that
wicket left them rather than as a claim about now, and a later whole-over total makes
it older rather than false. It is also an incident: it happened, and the incident rule
is what stops a routine snapshot deleting it.

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
score = interest × freshness × novelty × coverage

freshness  1 while new, → 0 across the type's ttl, squared so the tail is shallow
novelty    1 if never shown, or if it is the event currently on screen;
           0 inside the repeat window after it left; then fade^shown_count
coverage   1 for everything but the floor; for a floor event, climbs from 1 to
           1 + COVERAGE_LIFT as its match goes unmentioned for COVERAGE_MS
```

### Coverage — nobody goes unmentioned

The rule is *"no match goes longer than this without a score on the wall"*, and that
is a claim about a **match** and a **clock**, not about a kind of event — which is why
saying it as a type weight went wrong (see `innings_update` above). Two dials, both
meaning what they say: `COVERAGE_MS` (20 minutes — about five overs at a club over
rate, but counted in the units the room experiences) and `COVERAGE_LIFT` (2, i.e. up
to 3×).

The lift is what carries a snapshot over the floor at all. A division score is worth
**7** against a floor of **8**, so unaided it can never take the band; fully neglected
it reaches 21, which clears the floor and still sits below anything that is actually
news. One of ours goes 12 → 36.

It is a **multiplier on the score, not a bonus on the interest**, and that matters:
freshness and retirement still multiply through, so coverage can only ever promote a
score that is *current and true*. A match whose scorer has gone quiet produces no new
snapshot, nothing gets lifted, and the honest outcome is that we say nothing about it.

It is measured from the later of *when that match was last on the band* and *when we
first heard of it*, so a device joining mid-afternoon does not treat every match as
starved at once. It is stamped when any event for the match **leaves** the band, not
just a score: the rule is about the match being mentioned, so a wicket satisfies it
too. Showing a match therefore resets its own clock — a busy match is never padded
and a quiet one is picked up without anyone having to list it.

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
either side. *(2026-10-01: to move from the scheduler's pick to the replay caption,
which holds the band while the player's replay plays. See
[Replays](#replays--footage-is-rotation-content-and-the-store-decides-what-is-still-worth-it).)*

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

**The challenger must clear the floor too, and for a long time it did not.** The floor
was tested against `rows[0]` and against the incumbent, but `rows[0]` is usually the
incumbent itself — so all that established was that the band was worth holding at all,
never that the next in line deserved it. `share` halves every 18 seconds, so after a
minute or two the incumbent's *discounted* standing drops below any old thing in the
store and the band was handed to it. Reproduced against the real store: a wicket at
interest 70 decaying 70 → 44.8, then a league `score_update` scoring **4.9** taking
the screen off it at +90s. The rival scan now skips anything under the floor; with no
eligible rival the incumbent simply holds, and it still loses the band the moment its
*own* raw score falls through, which is what makes the chrome collapse rather than
reach for the next thing down.

Two things follow. The floor had been leaky for **every** low-interest type, not just
that one. And the gap measurements that tuned the chrome's retraction (below) were
taken while the leak was live, so the wall was being kept awake by filler it should
never have shown.

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

### What a diff of two RV polls can actually tell us

Verified against real payloads (`scripts/probe_live.py <pc_id> --raw`, a 2026 league
match and a junior friendly), not against the simulator — which differs from RV in
ways that flattered the extractor twice, see below.

**The fields RV gives us, per poll**

| level | fields |
|---|---|
| match | `scores_updated` (the scorer's cursor), `status_id`, `is_live_score`, `was_live_scored`, `match_break_id`/`match_break_desc`, `score_text`, `leader_text`, `toss_won_by`, `batted_first`, `follow_on`, `matchStreams[].MatchStreamHighlights` |
| team | `result_id`/`result_type_text`, `won_toss`, `points`, `match_score_text` |
| innings | `runs`, `wickets`, `overs_bowled` (decimal, `32.1` = 32 overs 1 ball), `extras` + `byes`/`leg_byes`/`wides`/`no_balls`/`penalty_runs`, `close_type_id`, `innings_number`/`innings_order`, `CBalls` |
| batting perf | `runs`, `balls`, `fours`, `sixes`, `number` (batting position), `dismissal_id`, `dismissal_text`, `dismisser1_id`, `dismisser2_id`, `fow`, `fow_order`, `minutes`, `player_id`, `times_out`, `inst_num` |
| bowling perf | `overs`, `maidens`, `runs`, `wickets`, `wides`, `no_balls`, `dot_balls`, `consec_wkts`, `unassis_wkts`, `number` (bowling order), `player_id` |

**Known exactly, from the diff alone**

- The change in the innings' runs, wickets and overs.
- **Which** batters are newly out, **how** (`dismissal_text`, the scorer's own words),
  for how many, off how many balls, and **at what score** (`fow`).
- The **order** the wickets fell in — by `fow`, ascending. Not by `fow_order`, see below.
- Per-batter deltas in `runs`, `balls`, `fours`, `sixes`. So "two fours since the last
  poll" is an exact count, not an estimate.
- Per-bowler deltas in `overs`, `runs`, `wickets`, `maidens`, `dot_balls`, `wides`,
  `no_balls` — so we know exactly who bowled during the interval and what it cost them.
- Whether the scorer synced at all (`scores_updated` moving), which is the stall detector.
- Breaks, an innings closing, the toss, the result.

**Bounded, but not exact**

- *The over a wicket fell in.* Bounded by the interval — it fell after the previous
  poll's `overs_bowled` and at or before this one's — and no tighter. With several
  wickets in one interval, `fow` orders them inside that bound but cannot place them.
- *When anything happened in clock terms.* The bracket is `[previous scores_updated,
  this scores_updated]`, and that is the honest width. It collapses to seconds on a
  live-scored match and opens to half an hour on a scorer syncing in lumps.

**Not knowable at all**

- *The ball a wicket fell on.* `fow` is a score, not a position. `CBalls` on the
  innings looks like where ball-by-ball would live and was **null in both matches**.
- *When a boundary happened, or in what order.* Fours and sixes are **counters** on
  the batter, with no row, no score and no position of their own. A jump from 1 to 3
  says two happened somewhere in the interval and nothing else — which is why
  boundaries are emitted as one burst event that states the count, while wickets are
  emitted one apiece.
- *Whether a four came before or after a wicket in the same interval.*
- *Extras ball by ball* — only the innings totals move.

**Two traps the simulator hid**, both found by probing and both now handled:

- **`dismissal_id` means the opposite of the obvious.** RV: `0` = has not batted,
  **`1` = not out**, `14` = retired not out, `2`/`3`/`4`/`6` = caught/lbw/bowled/run
  out. A truthiness test reads every not-out batter as a wicket. The simulator numbers
  it the other way round (`0` = not out), so nothing ever looked wrong. `isOut()`
  decides on the **wording** instead, which both shapes agree on.
- **`fow_order` is usually null.** Two dismissals out of eleven in the league match,
  none at all in the friendly — while the simulator fills it in for everybody. Fall
  order is derived by sorting on `fow`; `fow_order` is kept only as the tie-break for
  two wickets at the same score, which is exactly the case it was populated for.

**Worth a live probe, because it would change the model.** `minutes` (minutes at the
crease) is populated in the completed league match and null in the friendly. If it
populates *during* play it is the missing timing signal: the interval between two
wickets is the incoming batter's `minutes`, which would let a backfilled wicket be
placed in time instead of estimated from the run rate. Needs a probe against a match
actually in progress to settle.

**One gap this does not close.** All of the above is **raw RV**. The client sees the
**Worker's** mapped shape (`rv.mjs`), which is not in this repo, so which of these
fields survive the mapping — and under what names — cannot be checked from here. The
extractor is written to accept both shapes (`dismissal_text` or `how`, RV's numbering
or the simulator's) rather than assume.

Two things are known about that mapping from an earlier probe, and are worth reading
before re-deriving any of this: rv.mjs already **normalises `fall[].order` to the
wicket number** (it is not `fow_order`), and it resolves dismissal ids to names,
emitting `out_kind` and a resolved `fielder`. Which also means **the bowler is a
structural field** — `dismisser2_id` — where `bowlerOf()` here parses him out of the
scorer's `how` string with a regex. That should probably become the id.

### Ball rows are read as data, and we do not wait for them

`MatchStreamHighlights` is the **only per-ball source RV has**. Verified complete
across all 96 rows of a real streamed match: `over_no`, `ball_no`, `dt_utc`,
`innings_id`, `batter_id`, `bowler_id` and `metric` were populated on every one. A
wicket row is self-sufficient — `metric` is the **wicket ordinal**,
`dismissed_batter_id` was set on 15/15 — and `1004`/`1005` rows are milestones (metric
100/200/300 for the team total, 50 for a player fifty).

**Coverage against that match's scorecard:** wickets exact (6/6 and 9/9); boundaries
*higher* in the highlights — 58 fours to the batters' 55, 17 sixes to their 13 —
because a boundary in byes is not a batter's four and scorers' boundary counters
drift. So the row is authoritative for *an event happening*; the scorecard stays
authoritative for the score.

**One endpoint, one poll.** `matchStreams` rides in the same match JSON as the
scorecard, so this is not two feeds on two cadences — it is publication latency
inside Frogbox. Slowing our poll would make a row more likely to have landed by the
time we see the scorecard move, but only by delaying the score by the same amount:
making the wall late in order to caption a boundary.

**So the scorecard triggers and the row corrects, afterwards.** A row does three jobs,
none of which involves holding anything back:

1. **It stamps the true instant.** `happened_at` is otherwise the poll bracket, which
   is honest but can be half an hour wide and is simply wrong when a card arrives
   late. `dt_utc` collapses it to a point, so freshness prices the incident by when it
   actually happened. This amends an event **even once shown** — unlike the footage
   join — because correcting *when* something happened changes nothing that was said.
2. **It dates the ball** — `over`/`ball` are kept on the event record.
3. **It surfaces balls the scorecard never reported**, which is where those surplus
   boundaries land. They become events in the house grammar rather than the feed's own
   sentence: `Wendover 36/0 (7 ov) · D Cleary four off F Nelson (6.2)`.

**Why a boundary burst is still not split per ball.** It looks like the rows should
let `(2 fours)` become two events, and they cannot — because the scoreline at a given
ball is **not recoverable**. The rows carry boundaries and wickets and never the
singles between them, so two split events would carry the same current scoreline and
the same running total and read identically on the band. The burst stays the unit
until there is a reason for the two lines to differ. The per-ball stream's real home
is the replay surface and the ball-events pipeline, which already consume it.

**Unmeasured, and it decides one open question.** Nobody has timed the lag between a
ball and its row appearing. It is cheap to log on a live Saturday — `dt_utc` against
the poll that first carries the row — and it is the number that says whether a
one-poll grace on a boundary burst would buy anything.

### One line, one list

Most events hand the band a sentence. A **scoreline** is not a sentence: "High Wycombe
9/0 (1 ov)" is a club, a figure and the overs that qualify it, and those three are
typed differently — the club in white at 900, the figure in **gold** because gold is
the scoreline everywhere on this wall, the overs a rung smaller and blue because they
qualify the score rather than being part of it. That is `.sq-runs` and `.sq-ov` on the
match-day board, mirrored: a score on the band and a score on the tile a few
centimetres above it are the same fact and are typed the same way.

So a payload carries **one `parts` list**:

```js
parts: [
  { cls: 'bat', text: 'J Harrington' }, { cls: 'score', text: '54' },
  { sep: true },
  { cls: 'det', text: 'from 44 balls, 7 fours and a six', shrink: true },
  { sep: true },
  { cls: 'team', text: 'Wendover' }, { cls: 'det', text: '104/2' }
]
```

`{ sep: true }` ends a group and draws the dot; `shrink: true` marks the group that may
ellipsise. `headline` is the same line flat — what the inspector's row, the simulator's
HUD and any log line read — and it is **derived** by `say()` from the parts rather than
typed out beside them, so the two cannot drift.

**It used to be three fields.** `headline`, `detail` and `tail`, each with an optional
`_parts` twin, drawn in that order with the dots supplied by the renderer. Three boxes
bought exactly two things — which phrase gives way, and separators no payload has to
punctuate for itself — and both survive here as `shrink` and `{sep}`. What they did not
buy was any distinction of **meaning**; and the moment the middle clause needed
marked-up parts too (a club anywhere on this wall is set in the heavy type, so a club
landing in `detail` could not be) all three were the same thing under different names.
The nesting that would have required brought a CSS specificity fight with it —
`.det .team` against `.det` — which simply does not arise when the parts are siblings.

The practical gain is that **a line that wants to be a sentence can be one**. Narrative
is the direction the band is going, and three fixed boxes is a data grammar.

**The list is normalised on the way in** — empty parts dropped, then leading, trailing
and doubled separators collapsed. That is what lets a builder write
`[score, SEP, maybeClause, SEP, maybeTail]` without first checking whether the middle
one came out empty, which is what the old builders spent most of their length on.

Classes are **whitelisted** in the renderer: a payload is built from feed data, and a
stylesheet class is the one place a renderer can be talked into something by a string
it did not write.

**A club name is always `team`.** The rule for this wall is that a club is set in the
heavy weight — `.sb-team` on the match-day tile, `.bclub` on the strip's scoreboard,
`.team` on the band — so every phrase that names one does it as a part, never inside a
prose string. `fixtureParts()` writes a fixture that way (CCs dropped, both clubs their
own part) and `resultParts()` lifts the club out of the front of the feed's own result
sentence by matching it against the two clubs we already know are playing, longest
first. No match means no split and the sentence goes out as prose: guessing where a
club name ends inside somebody else's sentence is how you end up with "Wend" in bold.

Events also carry **`who`** — the player the event is about. It exists because the clip
join used to match a name against the *headline*, which was right while a wicket's
headline was "C Godden 2, lbw b Vane"; once the headline became the scoreline that test
could never match again, and every clip would have attached to the first candidate
event regardless of whose it was.

### Clips join events; they are not events

> **SUPERSEDED 2026-10-01** (built the same day): footage becomes a `replay` record
> the band never shows, played by a replay queue at slide boundaries. The join below is
> to be deleted. See [Replays](#replays--footage-is-rotation-content-and-the-store-decides-what-is-still-worth-it).

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
| **Gold tile** — bottom left | **whose match**: our XI, or the division for somebody else's |
| **Ticker** — the bottom bar | the **text**: the event description |
| **Strip** — the side bar | **one panel**, chosen by the type — under a **head** naming the division |
| **Flash** — the slide's box | the **footage**, when the event has any |

Read out of the corner it is one sentence either way: along the bottom, `WICKET` →
"Harrington bowled Duff 62"; up the side, `WICKET` → the chase it just dented, over
"1st XI · TVCL Div 6C".

> **SUPERSEDED 2026-10-01.** The gold tile names the match again: our XI ("1st XI")
> on our games, the division's short form ("TVCL Div 6C") on everybody else's. The
> strip's footer is gone; the division heads the scoreboard exactly as it heads the
> ladder. The band's sentences already stand on their own (see Open questions), so the
> type in the tile was the same news twice. The section below is kept as the history
> of the decision it reverses.

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
| `score` | the match as a vertical scoreboard — see below | built |
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

### The `score` panel is the scoreboard stood on its end

> James's direction, 2026-09-27.

The ticker is moving away from being a second scoreboard and towards a plain,
non-technical headline. The figures do not disappear with it — they move to the strip,
which already did this well for a run chase. So whenever the strip is **not** showing
the ladder, the band carries the match's numbers and its state, read top to bottom.

An **innings** is the unit, and it is always written the same way: the side, then its
figures under it.

| 1st innings | | 2nd innings | |
|---|---|---|---|
| | **crest + XI** | | **crest + XI** |
| gold | Total | gold | Total |
| gold | Wickets | gold | Wickets |
| | Overs | | **crest + XI** |
| | Run rate | gold | Total |
| | **crest + XI** | gold | Wickets |
| | TO BAT | | Overs |
| | | | To win |
| | | | Balls left |
| | | | Req rate |

**Gold is the score and nothing else** — total and wickets. Overs, rate and what's
needed stay white. That is also what binds a team tile to its figures without a box or
a tighter gap: the gold pair *is* the score line, so the eye groups the three rows
without being told.

### The scoreboard's team tile is a second dialect

> James's direction, 2026-09-27.

`tile(t, opt)` now draws in one of two dialects, and the difference is the whole of what
the two panels are for. The **ladder** keeps every channel it had. The **scoreboard**
(`opt.badge`) names its sides by **crest** and drops the other two identity channels:

| channel | ladder | scoreboard | why |
|---|---|---|---|
| name | TLA | **crest over XI** | a scoreboard names two sides, and two it can name properly; ten of these down an 8vw column would be unreadable, and the ladder is about *position*, not identity |
| our team | gold left bar | **dropped** | with two tiles and the footer naming the XI there is nothing left to pick out — and the bar was competing with the gold score figures for the column's one accent |
| bat / bowl glyph | shown | **dropped** | the **layout** now says who is batting: each side sits above its own figures, and the lower block is the one with numbers still moving. A glyph is the third telling of it |
| certainty fill | one per tile | **moved** — one per panel, on "To win" | see below |
| provisional clock | shown | shown | "decided, not yet official" is a state nothing else on the surface reports |

**The crest is baked, the TLA is its fallback.** `_club_crest()` in `build.py` resolves a
club-name slug against `assets/images/crests/` — the localised badges `fetch_fixtures`
already caches — and every strip team row carries a `crest` beside its `tla`. A club with
no cached badge renders the abbreviation instead, which is exactly what `_team_tla`'s
docstring has always called itself. On the division tables we play in that is currently
21 crests out of 25 clubs, so the mixed state is the normal one, not an edge case.

**Any Wendover side takes our own logo**, keyed on the slug and *not* on the `ours`
flag: another Wendover XI in the same division is not our fixture but is still our
badge. `/assets/images/wcc-logo.png` is not in `crests/` — that directory is opposition
badges, and ours has never needed fetching.

**Two lines: the crest, and the XI under it.** The crest *is* the club, so the label is
not — "DENHAM CC" under the Denham badge is the same fact twice in a band with no room to
spare. What a badge cannot say is *which* Denham side, and on a division afternoon that is
the useful half.

**The consequence, and it is deliberate:** in a 1st XI v 1st XI fixture both tiles read
`1ST XI` and the crest is the only thing telling the two sides apart. That is the trade
the crest was brought in to make.

**Crest over label, not crest instead of label.** Four of the twenty-five clubs in our
divisions have no cached badge, and a crest a viewer doesn't recognise is no worse off for
being labelled. A crest-less club keeps the same tile and simply has no badge; the TLA is
not printed over a spelt-out label, being the abbreviation *of* a club name.

**The tile grows for it** (`--badge-flex`, 1.5 figure tiles' worth). A crest over a label
will not read at a figure tile's height; the figures give up a little in exchange, being
single numbers. `scorePanel` counts the same figure when it sizes the spacer, so the CSS
token and the JS constant have to stay in step — one value in two languages.

**`_desig_of()` is the other half of `_club_of()`**, splitting a league-table team name on
` - `. Designations are not a closed set — alongside `1st XI` the tables carry
`Saturday 2XI`, `Under 15 Spitfires` and `Under 10 - Hurricanes` — so it takes the whole
tail rather than parsing a number out of it, and it requires spaces around the separator
so a hyphenated club (`Chenies & Latimer`, `Winchmore Hill`) is never cut in half.

**No designation is a real case**, and `badgeLabel()` holds the chain for it. Some tables
name teams by club alone — the women's indoor softball division does — so there is no XI
to print, and a bare crest with nothing under it says less than the club would. Our own
row never falls that far: the build fills its `desig` from the fixture's own team name
when the table has none. So that panel comes out asymmetric — `WOMEN'S SOFTBALL KITES`
against `CHESHAM CC` — each side taking the best name it has.

**The step-down is decided once per panel, from both labels.** Per tile, an "Under 15
Spitfires" beside a "1st XI" would set the two sides of one scoreboard at two different
type sizes, which reads as a mistake rather than as a fit. The scoreboard's bounds are
also looser than the footer's — a smaller face with two lines to wrap into, about 14
characters a line — so `tooWide` took its thresholds as arguments and the footer kept its
own. An XI sails inside them; what does not is a junior designation or a club name
standing in for a missing one.

**White disc, contained** — `.tile.badge img`, the club's own idiom from `.sb-crest` and
`.crest img`. The white is load-bearing rather than decorative: the cached badges are
transparent PNGs drawn for light backgrounds, and several are dark line art that would
vanish on the matte.

### One swingometer, on "To win" — the board's arrangement

> James's direction, 2026-09-27.

The lean does not disappear from the scoreboard, it **moves**: off the two team tiles and
onto the **"To win" figure**, one fill per panel. Which is exactly what the match-day
board already does, and for the reason its own comment gives — that is "the one aperture
that is about the outcome rather than the score".

Two tiles leaning opposite ways is one fact told twice, in a column that is already
carrying both sides' figures. Ten tiles each leaning is the ladder's whole point, so the
ladder keeps it per tile.

The channels are unchanged and now come out of one function, `fill(lean, certainty)`,
because two places paint it:

- **colour** = the lean, always the full outcome colour, never washed out;
- **height** = the certainty, a band rising from the bottom, capped below 1 so a game
  still being played never paints a full tile.

**It is not mirrored and does not need to be.** The figure belongs to the side chasing,
so the fill under it is theirs — the same argument the board makes for its aperture
("'To win' only ever appears in the batting zone").

**The two channels come straight off the chasing side's tile state** (`tiles[1]`, by
construction), *not* from a second call into the chase model. `assess` has already priced
that side — from `WccChase.chaseState` while the game runs, from the feed's own verdict
once it is decided — and has already mirrored it onto the right side. Asking the model
again would be a second opinion where the entire point of the shared module is that the
ladder, the board and this tile give one.

**A decided match has a verdict, not a lean — the same as the board.** The board drops
its apertures at the close and posts a verdict badge; the strip now does the same.
`assess` returns `verdict` (W/L/T/D/A/C/NR, `verdictFor`) and no lean for a complete
card, confirmed or not, so the fill goes from the ladder rows and from "To win", and each
side's tile wears the badge top-right — `WON · 22`, points only where `settledPoints` can
price them (TVCL). The provisional clock stays bottom-left until `final`. A TVCL washout
now prices at 7 each with no innings behind it, as the board's `pricePoints` does, so an
abandoned game settles the ladder instead of standing as a barrier. The strip's labels
are shorter than the board's for the long verdicts (`ABD · 7`, `CANC`, `NR`), since
"ABANDONED · 7" does not fit an 8vw tile. **Trial:** on the ladder rows the fill is now
a slim bar on the tile's left-hand edge (right tried first) (the board's `.sq-fill`), not a wash behind
the type; "To win" keeps its wash, as the board's aperture does.
> James's direction, 2026-09-30.

**The point-difference lines go once either end has a result** (`data-done` on the
focus tile, checked in `drawLinks`). The badge says what the result was worth, and a
gap beside it cannot say whether it is before or after those points; with a finished
side held behind one still playing it would be measured the wrong way round as well.
> James's direction, 2026-10-01.

**The ladder model is `assets/js/live-ladder.js`** (`WccLadder`), moved out of the
strip with no change in behaviour (400 randomised division states compared, identical):
side resolution, `assess`, `verdictFor`, `settledPoints`, `expectedPoints`, `ladder` and
`rows(view, cardOf, staleOf)`. Pure and DOM-free like `live-chase.js`, so the engine can
run it over EVERY division.

#### The league table's story (`extractLadder`)

The engine loads the strip's own views from `/live-strip.json` (written by
`build_live_strip` beside the page) and, on **every tick**, runs `WccLadder.rows` over each
division against its latest cards — the same arithmetic, stale-score rule
(`WccLadder.staleness`) and barrier the strip draws with, so the arrows on the column
and the events in the band are one calculation. `st` (`ladderState`) remembers each
division's order and each row's arrow between calls.

| type | fires when | line |
|---|---|---|
| `ladder_expected` (46, "On course") | a row's arrow appears or changes (direction, places or projected rank) and has **held for `LADDER_HOLD_MS` (2 min)** | `If it stays this way, Haddenham move up to 3rd, above Chesham` — only when the side and every side it crosses is priced — a chase on, or a result (or not playing). The ARROW obeys the same rule (`ladder()` in live-ladder.js), so a placeholder side silences both |
| `ladder_shift` (60, "Ladder move") | the committed order changes — under the barrier rule this can be when the OTHER game finishes | `Wendover move up to 4th, above Hurley and Maidenhead Royals` |

- **One event per switch**: said from the side going UP, naming whom it passes; our own
  side going down is always said from our side (`Wendover drop to 5th, below Denham`).
  Both clubs always named; Wendover named as the subject, as on a result.
- **An arrow that goes is silent**: its event is retracted by id (`retire_ids`, a
  `retire_only` event) — an expected move belongs to a TEAM, and both sides of one
  fixture can carry one, so per-match `RETIRES` is the wrong scope.
- **Ordering — `after`**: an expected move names the not-yet-shown swing in its match, an
  actual move its match's unshown result, and scores 0 (`waiting`, flagged in the
  inspector) until that predecessor has been shown, retired, or fallen below the floor.
- The simulator's scripted `LADDER_MOVES` are gone: its afternoon's ladder events are
  now the real algorithm's. Measured on the simulated day: swing 17:56/18:00 → expected
  "up to 5th" 18:02 → retracted and re-said as "up to 4th" 18:06 → retracted on the
  18:16 swing → result 18:28 → `ladder_shift` "up to 4th, above Hurley and Maidenhead
  Royals" held behind the result.
- An expected event about a side whose own game is over can still fire when
  its row moves because of somebody else's game (Amersham, posted without a score, so
  never priced and never final).

#### The swing (`probability_shift`, `swingCheck`)

**A crossing, not a jump.** It used to fire on a 15-point move between two polls — a
property of the poll rate, and four times in a quarter of an hour on one chase. It now
fires when the chasing side's chance crosses into a new band — `< 0.2` defenders on top,
`< 0.5` defenders favourites, `< 0.8` chasers favourites, above that chasers closing in —
with **0.05 of hysteresis** either side of each edge. The first band a chase is seen in
is set silently. **`SWING_GAP_MS` (10 min)** between swings in one match, except when the
favourite changes; a held-back crossing still goes out when the gap ends if it is still
true. A new swing retires the last one in the match. Division chases swing too, checked
whenever their scoreline moves.

**No percentages** — what happened in words, then why: the passage clause if there is
one, else where the chase stands.

| crossing | line |
|---|---|
| chasers become favourites | `Wendover now favourites against Denham · 27 needed from 7 overs, 2 wickets in hand` |
| chasers closing in | `Wendover closing in on the Denham target · 26–0 in the last 3 overs` |
| chasers slip back from closing in | `Denham fighting back · 19–1 in the last 5 overs` |
| defenders become favourites | `Wendover’s chase turns, Denham now favourites · 10–1 in the last 3 overs` |
| defenders on top | `The Lee on top against Tring Park · 50–3 in the last 9 overs` |
| chasers recover from that | `Wendover back in the chase against Denham · 40 needed from 8 overs, 2 wickets in hand` |

The opposition is always named on our games and both clubs on a division's; Wendover
may be the subject, and as an object is dropped ("the target", no "against Wendover").
> James's direction, 2026-10-01.

Between the innings there is no fill: `chaseState` needs two innings, so the To-bat
slot's target figure stands on its own until the chase begins.

`.cval` and `.clabel` became `position: relative; z-index: 1` to sit on top of the fill,
the same fix the board needed for `.sb-cell > .sb-label, .sb-cell > .sb-num`.

**Ten tiles in the second innings** — exactly the column the ladder is built for, so
the panel fills the band with no spacer and no stretching. The first innings is seven,
and the spacer takes the remaining three shares so the tiles keep the ladder's height.
A `flex: 1` spacer beside ten `flex: 1` tiles would make every tile an eleventh of the
column and put the panel visibly out of step with the ladder it shares the band with,
so at ten the spacer is omitted outright rather than floored at one.

**The side batting is always the lower block**, which is where the eye already is
coming out of the corner. That falls out of `matchTiles` putting the side that batted
first on top, and is why one ordering reads correctly in both innings.

**The first innings keeps its overs; the closed one loses them.** During a chase the
first block is total and wickets only — its overs are spent, and the figure that
matters about a closed innings is what it set.

### The panel is a scorebox, and the live figures are apertures in it

> James's direction, 2026-09-27.

The score panel's tiles sit in a **pale housing** (`.housing`) and the figures of the side
**currently batting** are **sunk into dark apertures** in it. Which is the match-day
board's scoreboard, in this column's terms — `--housing` is the colour the board's `.sb`
sits on, and `--aperture` is its `.sb-cell` exactly: "digits sunk into a dark panel, as
they are on a board: the figure is what carries, the housing recedes."

**One dark tone does two of the board's jobs**, because here they coincide. The board has
an aperture for a figure that is still moving (`.sb-cell`) *and* a recess for the side that
is in (`.sq-bat`, "a recess is the same thing the scoreboard's apertures do with the
figures that matter"). The figures still moving *are* the batting side's, so one tone says
both.

**The housing goes behind the tiles, not under the whole column** — that is the whole
reason for it. Light shows through the gaps, so a run of batting tiles reads as **separate
apertures in a scorebox** rather than one continuous recess. The first attempt put the dark
shade straight onto the matte and got the continuous version, which is right for the
board's `.sq-bat` (it bleeds full width on purpose) and wrong for a column of figures.
`.housing` also carries padding, so the pale shows on all four sides of every aperture
rather than only between them.

**Both blocks are wrapped (`.blk`), only one is pale (`.blk.box`)**, and the off-box
wrapper earns its place twice over. It carries no background, so the matte shows through it
whole — tiles and gaps alike — and the side watching reads as one continuous dark region.
Beyond that:

- **No fourth shade.** Left as the column's own children, those tiles kept `.tile`'s
  `rgba(255,255,255,0.06)`, which over the matte composites to `#172339` — a washed-out
  grey-blue that is neither the matte (`#08152c`) nor the housing (`#162744`), and visibly
  duller and darker than the pale it sits against. Three definite tones is the design; a
  translucent wash of one of them is a fourth.
- **One tile width.** The housing's padding insets its tiles, so an unwrapped block's tiles
  were wider than the boxed block's by 0.4vh a side. Same wrapper, same padding, same
  width, whichever block a tile is in.

**And it wraps ONE BLOCK, not the panel: the innings on show.** The side not batting keeps
the column's own matte. That is what makes the box mean something rather than being the
panel's backdrop — pale is the innings being played, matte is the side watching it, and
inside the pale the apertures are the figures still moving.

It could not have been done the other way round, by tinting the bowling side's tiles dark
inside a full-width housing: the matte and an aperture over the housing composite to within
a couple of units of each other (`#08152c` against about `#0e192c`), so a dark bowling tile
would have read as an aperture — the exact opposite of what it is.

So `scorePanel` builds **two blocks**, a side's crest plus the figures belonging to it, each
carrying its own share count. `box` is the innings on show, `other` is the side watching.
Which one comes first never changes — the side that batted first is always on top — so the
box simply **moves down the column at the innings break**: it is the upper block in the
first innings, the lower one in the chase.

**A pre-match card gets no box at all.** There are no figures to house, so both sides sit
plainly on the matte, which is the state the tiles are already in.

**And the tiles inside give up their own background: two shades, not three.** The board's
note on its division heading is the precedent — "a container tint under a group of tiles
that already have their own backgrounds was a third shade doing what the centring does for
nothing." A settled figure therefore sits flush on the housing, which is also the board's
own grammar for one (a closed innings is "stated on a line beneath", on the tile, not in an
aperture). What still marks it settled is the dimmed value.

**Outside the box:** the other side's tiles, the trailing spacer and the footer, all on the
matte. So the box is exactly as tall as the innings on show, and the footer stays chrome
instead of becoming the scoreboard's bottom edge. Each part takes its own shares, so every
tile keeps the height it had when they were all the column's own children.

**Only while an innings is open.** At the interval and at the close nobody is in, so
nothing is sunk — the board's rule for `.sq-bat` ("not shown on a decided game"). The first
innings sinks while it runs and comes up flush and settled the moment it closes; the chase
then sinks in its place, taking the chase block with it, since those figures are the
chasing side's too. Which makes the pair legible without a legend: **sunk means live
figures, flush-and-dimmed means figures that cannot change.**

**Settled figures read quieter** (`.stat-tile.done`): flatter base, dimmer value, and
gold dimmed *as gold* rather than falling back to white, or a closed innings would stop
looking like a score. Two things are settled — every figure of a finished match, under
the `FINAL` caption, and a closed innings while the next one runs. Same treatment,
because they mean the same thing: this number cannot change again. It is also what
keeps the live half of a chase the brighter one.

**Two tiles were dropped, each because it answered a question twice:**

- `Target`, the panel's one figure under v1. The chase block's **To win** is the same
  fact live (target minus what they have), and between the innings the To-bat slot
  shows the target outright — a standing `Target` beside a falling `To win` was two
  numbers for one question.
- `Wkts left`. The chasing side's own `Wickets` tile now sits three rows up, and a
  column carrying both "3 wickets" and "7 wkts left" makes the reader subtract twice to
  check they agree. The scoreboard's figure wins, because it is the one a scoreboard
  states.

**The To-bat slot takes a figure once there is one.** While the first innings is
running, "TO BAT" under the fielding side is the only true thing to write. Once that
innings closes, the slot carries the **target** instead — the whole news of the
interval, and otherwise unsaid until the chase begins.

**A pre-match card writes no figures.** With the toss in and no ball faced the panel is
the two sides and their glyphs, which is the honest state and the one the tiles are
already in.

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

> `Denham elected to bat` · `Wendover will take the field from 13:00`

**Two phrases, not two sentences.** That is the band's grammar — the headline is the
news, the detail qualifies it, and the renderer sets the dot between them. Written as
full stops it was the one event on the wall punctuating itself, which read as a caption
rather than as a line of the same ticker. The split falls where the fact does: the
winner's choice is the news, what it means for the other side is the consequence, which
is exactly what the muted half is for. ("take the field", not "take *to* the field".)

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
| complete | `Result` | verdict badge (`WON · 22`), no fill |

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

**Empty means retracted, and it is no longer a sticky latch.** The wall must never
carry an L with nothing in it: when the scheduler has no pick the bar hides itself and
the strip has no panel to draw, so anything still standing is a matte frame wrapped
round a shrunken slide, announcing a live surface that is not saying anything.

The history is worth keeping, because both previous numbers looked reasonable and were
both wrong. Twelve minutes came from the feed-driven question ("is there cricket
today"), which changes twice a day. Two minutes came from measuring collapsed gaps — a
median of 30s, a longest of 75s — and picking a number that cleared them all so the
band rode through a passage of play. Both were answering *"how long a gap should the
chrome sit through"*, and the answer to that is none: a gap **is** the chrome having
nothing to say. (Those measurements were also taken while the floor was leaking, so
the gaps were smaller than the real ones.)

What is left is an **anti-flap guard, not a policy**: `LIVE_HIDE_DEBOUNCE_MS` is
**6 seconds**, under the band's own `MIN_SHOW_MS`, so it can never hold an emptiness
anyone reads as a state, and comfortably longer than the 0.7s retraction glide. It
exists only because the two feeds ingest on separate timers and two polls can land a
second apart.

**The churn this exposes is real and is not that constant's to fix.** Snapshots arrive
about one an over, so an ordinary over can leave a genuine gap and the L will come down
for it. The answer is to keep something worth showing on the band — see *Coverage* —
not to hold an empty frame up until the next event.

**Measured on `WccClock`, not with a `setTimeout`.** A timeout is real time, and the
simulator runs an afternoon in a couple of minutes — so a long timer would never fire
in a session and the retraction could not be looked at at all. It also means a **held**
clock never retracts: parked at 13:10 to read the inspector, the subtraction stays at
zero and the L stays up, which is the clock being held meaning what it says. The engine
rebroadcasts every second regardless of mode, so the quiet spell is a subtraction
against the scheduler's clock: it advances with the simulated day and stops dead while
the clock is held.

An engine too old to broadcast `wcc-events` falls back to the v1 answer, so an
asset-cache skew degrades to the old behaviour rather than to a chrome that never
appears.

One consequence worth knowing: on a fresh load mid-innings the chrome stays down until
the first event, which can be up to an over. That is the doctrine working as written —
nothing has happened since we started watching — but it is a visible change from v1.

## Replays — footage is rotation content, and the store decides what is still worth it

> James's design direction, 2026-10-01. **Built 2026-10-01** (see *As built* at the end
> of this section). Supersedes
> [Clips join events; they are not events](#clips-join-events-they-are-not-events), the
> scheduler's *Footage runs to its end* hold, and settles open question 6.

### What it replaces

Live footage reaches the screen today by **two routes that never meet**:

- **The flash.** `detectClips` (`live-engine.js`) hands every clip id it has not seen
  to `WccPlayer.flash`, filtered by `flashEvents`, which is still `'all'` from testing.
  The player prefetches the whole clip into `wcc-hls-v1`, then plays it at the next slide
  boundary (immediately on a paused interactive device), at least 45s after the last one,
  from a queue of five that drops its oldest.
- **The band.** `extractLive` stamps a wicket's true instant off its row, and
  `attachClip` folds the footage into an unshown wicket (`CLIP_BONUS`). A wicket clip
  nothing claims becomes a second `wicket`, and boundary clips are dropped. When the
  scheduler picks an event with a clip, it holds the band for clip length plus a beat,
  saying "footage running".

Nothing tells the player to play what the band is holding. The band can sit on a
wicket for half a minute with no picture, and the picture can arrive a minute later
under a different sentence. The flash also has **no age test**: a device that loses its
link for twenty minutes comes back to a backlog of clips that all count as new, and up
to five of them play one per boundary, twenty minutes late.

### Every ball, at the next boundary

**During a streamed match every row with footage is a replay**: every four, every six,
every wicket, every "other". The objection that removed `four` and `six` as *events*
does not reach footage. That objection was that a counter cannot date a boundary, and a
highlight row carries `dt_utc`, `over_no` and `ball_no`. The rule stands for the band;
boundaries still live as a clause on the score. Footage of them is a different surface.

**Timing is unchanged, and it is the slideshow's.** A replay plays at the next slide
boundary, in the slide's box, exactly as the flash does now. The clips are already
minutes old, so a few seconds more is free, and a clean cut between slides is worth
more than those seconds. A paused interactive device still plays one as soon as it is
ready.

**It costs the rotation, and that is accepted.** A streamed match produced about ninety
rows (58 fours, 17 sixes, 15 wickets): roughly fifteen an hour, so seven or eight
minutes an hour of the deck at thirty seconds each. On a streamed afternoon the replay
*is* the most interesting thing on the wall. There is one camera today, so one match.

### The store admits; a replay queue presents

The event stream already knows how to answer *"is this still worth showing?"* (dedupe,
match attribution, freshness from when it happened, a received time that differs from
it). Replays use that rather than building a second copy:

- **Every clip row becomes a `replay` record in the store**, keyed by clip id and
  timed by `dt_utc`. A row with no playable `url` still stamps the instant on its
  scorecard incident (`stampBallTime`, unchanged).
- **A `replay` never competes for the band.** The scheduler's ranking skips it.
  Ninety rows a match on the band would be the per-boundary events coming back through
  the side door, crowding out wickets and results.
- **A replay queue in the player consumes them.** At each slide boundary it plays the
  best unplayed replay that is still fresh and fully cached. It **expires anything past
  the TTL** (10 minutes, measured from `dt_utc`), which is the test the flash lacks and
  what keeps a reconnect from replaying a backlog. Order is freshness first, with
  wickets ahead of boundaries when two are ready together.
- **The join goes.** `attachClip`, `CLIP_BONUS` and the band's footage hold are
  deleted, not tuned. A wicket's text is never held back for its footage, and footage
  is never folded into a line already read out. The scorecard stays the trigger for the
  news, and the row stays the correction for its timing.
- **Download is still gated.** A replay is playable only once `WccHlsCache.prefetch`
  has the whole clip, so a replay always opens on local bytes. A prefetch that fails
  goes back to be retried on the next poll, inside the TTL, rather than sitting
  unplayable in a slot.
- **Seen-ness survives a reload.** The flash keeps its seen set in memory, so a reload
  turns everything into backlog and nothing plays. The store's ids and the cache's
  per-clip markers are the better memory. Either way, the TTL is what decides.

### As built (2026-10-01)

- **Store** (`live-events.js`): `extractLive` turns every clip row with a `url` into a
  `replay` record (`replayEvent`) on every poll, the first included. The store keeps
  replays in their own list (same `byId` dedupe; no ranking, no tail broadcast, no
  eviction order), and `store.replays(now)` returns those younger than the TTL by
  `replayAt` (the ball's time). The rows' only other job is `stampBallTime`.
  `attachClip`, `CLIP_BONUS`, `clipHoldMs`, the scheduler's `clipUntil` hold,
  `ball_clip` and the unclaimed-row wicket are deleted.
- **Engine** (`live-engine.js`): `offerReplays` hands every fresh replay to
  `WccPlayer.flash` after each live ingest (replacing `detectClips` and its
  first-poll baseline). While a replay plays, `replayAnswer` replaces the scheduler's
  pick: `showing` is the replay record with a per-tick `replayPayload` caption, so the
  gold tile, the strip's `score` panel and the chrome latch all follow it, and
  `events.tick` is not asked until it ends.
- **Player** (`player-core.js`): the flash queue is the replay queue. It checks the TTL
  on arrival and again at play time, puts wickets ahead of boundaries and then the
  freshest first, drops a failed prefetch so the next offer retries it, and keeps
  seen-ness in `localStorage` (`wccReplaySeen`, pruned past twice the TTL). It
  announces start and end as a `wcc-replay` window event. The 45s minimum gap
  stays.

### What a ball meant: RV's event types, and the caption (2026-10-01)

RV tags more than fours, sixes and wickets, and says the number each is about in a
`metric` field the Worker used to drop. Read off five streamed matches against their
scorecards:

| RV type | Worker `event` | `metric` | Frogbox title |
|---|---|---|---|
| 1001 | `wicket` | the wicket's number, 1–10 | yes |
| 1002 / 1003 | `four` / `six` | 4 / 6 | yes |
| 1004 | `team_milestone` | the total: 100, 200, 300 | none |
| 1005 | `milestone` | the batter's 50 or 100 | none |
| 1006 | `five_for` | 5 (batter = the man out, bowler = the bowler) | none |
| 1008 | `appeal` (turned down) | 0 | "HOWZAT! … appeal for the wicket of …" |
| 1009 | `chance` (missed) | 0 | "MISSED! A great chance …" |

Anything else stays `other`. **A milestone is a row of its own on the ball that brought
it up**, beside the shot's row. So reels (`selectReel`) and replays (`replayBall`) are
**one per ball**: the footage of the ball's leading row (wicket, six, four, then the
rest), carrying every kind on it. A later row for the same ball enriches the replay
already in the store (`cfg.replay`) rather than adding a second one.

**The caption says what the ball meant**, in the band's own grammar, from the rows and
from the card and nothing else:

- `REPLAY · R Cooke hits a four to reach a fifty · 34.4 overs ↻ 6m`
- `REPLAY · T Duff hits a six to bring up 100 · 13.6 overs ↻ 6m`
- `REPLAY · S Govekar caught by M Gedye for 40 ending a stand of 165 · bowler R Cooke · 18.5 overs ↻ 6m`.
  The wicket is the band's `wicketParts`, off the card's frozen row.
- `REPLAY · 200 up · 25.6 overs ↻ 6m`, `… takes a five-for`, `… survives an appeal`,
  `… survives a chance`.

**Shape rules** (James, 2026-10-01): the bowler is named only where the ball is his (a
wicket, a five-for), not on boundaries, milestones, appeals or chances. Every club
mention is optional (`drop`), so the ticker's `fit` takes it off before anything else
truncates. The closing group is the ball's over and its age in the wall's own stale
token, "14.2 overs ↻ 24m", never under a minute.

A milestone's batter is checked against the card (his runs reach the mark), because
the rows are not corrected when a scorer fixes a card. Khan's maiden hundred was
credited to Beagley in the rows and on the live card, and only the card was put right.
When the two disagree the name is left out and the milestone stays. **Not said:**
counts ("his third six") and the batter's score at the ball. The rows miss balls
bowled before the stream came on, and scorers' counters drift. `/curate` and its
persisted JSON are untouched: `fetch_ball_events.py` keeps its own `EVENT_TYPES`.

### Two scores on screen, and only one claims to be now

Frogbox burns its own graphics into the clip, including the score **as it was at that
ball**. The chrome beside it carries the score **as it is**. Two scores are not the
problem. Two scores that **both claim to be current** are, and that is exactly what the
band's grammar would produce: every incident line leads with the current scoreline, so
"Wendover 87/3" would sit beside a burned-in 64/2 and the room could not tell which was
wrong.

The options, and why this one:

- **Tandem (the replay is the band's event).** It keeps the L explaining the picture,
  but it collides the two scores. It also couples the scheduler's pick to slide
  boundaries it does not control, and it floods the band. *Deferring* the band's news
  until the footage is ready would make the streamed match, the one we most want to be
  live on, the slowest thing on the wall. That is the same reason rows are not waited
  for.
- **Rotation, chrome concealed (v1's full-bleed).** The Frogbox graphics are
  self-sufficient and nothing contradicts them, but the L would reflow twice a replay,
  about fifteen times an hour. Covering it without reflowing loses the match and
  division context and stalls the band.
- **Rotation, chrome carries on regardless.** It is simple, but the words drift off
  onto another match while the picture plays, and the two scores collide at random.
- **Chosen: rotation, with the chrome in a replay mode.** It carries the replay's
  *identity* and its *age*, and never a score of its own.

### The chrome while a replay plays

| surface | carries |
|---|---|
| **Gold tile** | that clip's match: our XI, as for any other event |
| **Ticker** | a `REPLAY` caption in house grammar **with no scoreline**, and how long ago it was: `REPLAY · J Harrington four off W Vane (14.3) · 6 min ago` |
| **Strip** | unchanged: the current scoreboard for that match |
| **Flash** | the footage, in the slide's box, with its own Frogbox graphics |

**The age is what makes the burned-in score honest.** Once the band says *6 min ago*,
the scorebug in the picture is plainly a record of then. The strip's current scoreboard
beside it stops contradicting the picture and starts adding to it: there is what
happened, and here is where it stands now.

**The band holds the caption until the clip ends.** *Footage runs to its end* survives
in this narrower form. An event that lands mid-replay waits about thirty seconds, which
is small against TTLs of five minutes and up. The scheduler's clock keeps running for
those events; only the band's display is held.

**A replay counts as `showing`** for the chrome latch, because the L has something to
say. On a quiet spell with the L retracted, a replay therefore brings it up. That is
consistent with *Putting the chrome away*, though it is a reflow; watch for it.

**Wording is part of the wording pass.** The `REPLAY` caption follows the band's rules
(scorecard notation, no apostrophes, our club never named), and its "ago" uses the
row's `dt_utc`, not the poll that delivered it.

### Innings reels are the slide's content, not replays

> Agreed 2026-10-01. Live replays and innings reels are **two different things**, and
> only the first touches the chrome.

The live-match slide already walks the match in order: **Pre-match → 1st innings clips
→ 1st innings scorecard → 2nd innings clips → 2nd innings scorecard → Result**
(`buildViews` in `templates/slides/live-match.html`). Each clip is its own panel, the
innings tab groups them, and the slide ends itself (`wcc-done`) after its last panel.
The reel uses the same filter at both points: `selectReel` keeps every wicket, six and
"other", plus the first four of each of our batters who did not hit a six.

**When each innings' reel is in the rotation — on the wall:**

| match state | 1st innings reel | 2nd innings reel |
|---|---|---|
| 1st innings in play | no | no |
| **innings break**: 1st innings closed, no ball yet bowled in the 2nd | **yes** | no |
| 2nd innings in play | **drops out** | no |
| match `complete` | yes | yes |

**In someone's hand, a clip joins its innings' reel as soon as it is cached** (agreed
2026-10-01). It is the same split as the live chrome toggle: the wall decides for a
room, while a reader is there to decide for themselves. On the wall, a reel that grows
through the innings would replay itself on every pass of the slide. By late in the
innings it would be ten minutes of footage the room saw minutes ago, standing in front
of the scorecard. In the hand none of that costs anything, because the reader steps
past it, and the early release is worth more there than anywhere:

- **A phone gets no live replays at all.** Portrait has no flash overlay, so the
  slide's reel is the only footage a phone sees during the innings.
- **It is the only catch-up.** Live replays play once and expire, so someone who opens
  the deck at three o'clock has missed every one. The reel is how they see the first
  wicket.

The player already knows which kind of surface it is (`interactive`), so this is one
condition in `buildViews`, not a second slide.

**Skipping a reel in one press.** Releasing clips early only works if the reader can
get past them. Today they `next` through one clip at a time, and the slide's innings
tabs cannot help: `#wcc-tap` is a full-viewport gesture layer over every slide, so a
tap never reaches the slide's tabs. The skip therefore belongs to the **player's
control bar**: a *skip highlights* button that appears only while the current panel is
part of a run of clips, and jumps to the first panel after the run (the innings'
scorecard). That needs the slide to tell the player which panels form the run.
`WccSlide.notifyPanel` already carries per-panel metadata (`dur`), so the run can go
the same way. The last-match `video.html` reels have the same one-at-a-time problem,
and the same button should serve both.

**The break is read off the card, not off `break_desc`.** The test is that the 1st
innings is closed and the 2nd has no ball bowled. A rain break or drinks mid-innings
cannot satisfy it, so it needs no weather vocabulary. "No ball bowled" means overs or
balls, not the innings row existing: the card can name the openers before the first
ball. Today the reel is gated on `m.complete` alone; the gate becomes this per-innings
rule.

*Built 2026-10-01 (`reelReleased` / `inningsBreak`), with one refinement found in the
simulator.* An innings that ran its overs out is not `closed` on the card until the 2nd
innings' row appears, which can be most of the way through the interval. So
`break_desc` is read for its **innings** word as well (never for weather). The release
is also **sticky** until the 2nd innings has a ball, because the interval's
`break_desc` clears when the players walk out, minutes before that ball is scored.
Prefetch starts once an innings is closed (`reelWanted`); in the hand it starts as
clips arrive. Rows with no `url` are left out of reels.

**It is slide content, so the chrome ignores it.** No `REPLAY` caption, no hold on the
band, no `showing` for the latch. While a ten-minute reel plays as the slide, the event
stream carries on presenting everything else going on: the other matches of the day,
the ladder, and this match's own `innings_closed`. A reel is retrospective by
construction, since its tab says *1st Innings*, so its burned-in Frogbox scores claim
nothing about now. That is the same footing as the last-match reels.

**The replay TTL does not apply.** The TTL governs live replays only. An innings reel
is a record and plays whole, however old its clips are. It also costs no network, since
every clip was cached when it played (or was prefetched) as a live replay. The reel's
prefetch should still start when the 1st innings closes rather than at `complete`,
to fill any gaps.

**Dropping out mid-reel.** When the 2nd innings starts, the clip on screen finishes and
the slide moves on to the 1st innings scorecard. The remaining clips are dropped, not
deferred; live replays outrank background from here. This needs a fix, below, because
today's rebuild is by index.

**The same reel then returns at full time**, as part of the whole-match walk. That is
the one sanctioned repeat. Live replays play once and expire.

### Existing faults this depends on

*Fixed 2026-10-01.* A rebuild now re-anchors on the panel's identity
(`anchorAfterRebuild`). A clip that drops out under the screen finishes as an
*orphan*, then hands on to the next panel that survives. Clips are revealed one by one
as they cache. The slide reports its remaining length to the kiosk player
(`wcc-extend`), which only ever moves its backstop later. The history follows.

All three were already live for the full-time reel. The innings break would have made
them more likely.

- **A rebuild re-anchors by index, not by panel.** `onFeed` rebuilds `views` and keeps
  `idx`. Reel panels sit *before* their innings' scorecards, so revealing a reel while
  a scorecard is up shifts what `idx` points at. The repaint then lands on a clip panel
  and holds it, with a scorecard's dwell. Removing a reel mid-clip clamps `idx`. Playing
  clip 5 of 20 when the reel drops out leaves `idx` past the end of the new list, so the
  slide ends and skips the scorecards. The fix is to re-anchor on the panel's identity
  (tab, kind, clip id) across a rebuild. When the panel has gone, re-anchor on the next
  panel that still exists.
- **The slide's 900s backstop can cut the full-time reel.** `build.py` gives
  `live-match-*` slides `duration: 900`. A real streamed match's `selectReel` subset is
  roughly forty clips at up to thirty seconds each, so the two innings plus scorecards
  can run past fifteen minutes. The deck would then advance mid-way through the 2nd
  innings reel, and the next visit starts again from Pre-match. The 2nd innings reel and
  the Result would never be reached. The tea reel (about twenty clips) fits; full time
  may not. Size the backstop from the panel list, or let the slide report its own
  length.
- **A reel is revealed only when every clip is cached.** One clip that keeps failing
  hides the whole innings. Reveal the cached clips instead.

### Costs and what is unknown

- **The Worker passes the row's time through as `happened_ms`** *(built 2026-10-01)*,
  in epoch milliseconds, **corrected for a clock that runs an hour slow**. The stream's
  timestamps (`dt_utc`, `recording_started_utc`) sit `utc_off_min` behind real UTC,
  while the match's own `date1` is right. Against YouTube's `actualStartTime`, the
  recording anchor was 3605–3608 s early on all four BST matches checked (28 June to
  12 September). Taken raw, every clip would look an hour old and the TTL would drop
  all of them. `normaliseMatch` adds `utc_off_min` back. That the skew is zero in GMT
  is an assumption, since no streamed match has fallen there yet. The offline
  `fetch_ball_events.py` path is unaffected, because it only ever subtracts two stream
  timestamps, so the skew cancels.
- **The ball-to-row lag is unmeasured.** The 10-minute TTL has to absorb publication
  lag, then the download, then the wait for a boundary. Log `dt_utc` against the poll
  that first carries each row on the next streamed Saturday.
- **The Frogbox graphics at the slide's retracted size**, read at ten feet, are
  unknown. If they are not legible, the fallback is *rotation, chrome concealed*, at the
  cost of the reflow.
- **The simulator mirrors the feed's rows** *(2026-10-01)*: every four, six, wicket
  and `other`, with RV's numbering and each ball's own time. Its row lag is still an
  assumption (see *What the simulator is NOT honest about*).
- **Other clubs' Frogbox streams.** We only read clips for our own matches, because
  the Worker polls RV for our `pc_id`s and the division feed is PC-API, which has no
  clips. RV carries every PCS match and the PC→RV id mapping is not club-specific, so a
  division match streamed by another club may well expose `MatchStreamHighlights` the
  same way. Unverified; `scripts/probe_live.py <their pc_id> --clips` on a streamed
  fixture would settle it.

## Testing it: the match-day simulator

There is no live cricket most days and none at all out of season, so
`assets/js/live-sim.js` is the whole day in a few minutes.

```
WCC_SIM_MATCHES=1 WCC_SIM_LEAGUE=1 WCC_LIVE_ENABLED=1 python3 scripts/build.py
cd site && python3 -m http.server 8000
open 'http://localhost:8000/slideshow/live/?sim=matchday'
```

**Build with the overrides, not without them** — and a day with no fixtures is exactly
when that matters, not an excuse to skip them. The match-day board is baked at build
time, so on an empty day a plain `build.py` produces a perfectly valid site with no
matches in it: the board drops out of the live deck, `live-config.json` has nothing
pollable, and the simulator has nowhere to land. A plain build in mid-session silently
destroyed the day being tested and it is not recoverable, because `site/` is
gitignored. See the two override sections below.

**It arrives paused** at the start of the day with the first poll already on screen
(the engine polls once on start, so there is a toss to look at). Nothing moves again
until you ask it to — which is the state you want on arrival, rather than a running day
you have to catch. Add **`&play`** to start it running, or **`&at=16:20`** to begin part
way through the afternoon.

### What the simulator is NOT honest about

`clipsUpTo` was a stand-in until 2026-10-01: no fours, a constant `ball`, an `over`
interpolated from the fall-of-wicket score, and no bowler. It now **mirrors
`MatchStreamHighlights` field for field**, against the 96 rows of the 12 September
streamed match as the Worker normalises them. `playInnings` logs every ball Frogbox
would clip (four, six, wicket, and an occasional untitled `other`), and each row is
one of those balls:

- **Numbering is RV's.** `over` is completed overs, so 0-based, and `ball` counts
  every delivery in the over including wides. That is why a real row, and now a
  simulated one, can say ball 7.
- **Each row carries its own `happened_ms`**: the ball's time on the day's clock, with
  the innings break and rain added back. So a replay's age is the age of its ball.
- **Rows agree with the card.** Fours, sixes and wickets per innings match the batters'
  columns, minus any ball bowled before the stream came online (`STREAM_ON_MS`), which
  has no footage.
- **`batting_team` / `bowling_team` are club names**, as RV's are, not team labels.
  Consumers join on `innings_id` first for that reason.
- **Titles** are drawn from the real feed's own phrasings. `other` rows have none, as
  in the feed.

Still not honest:

- **Row lag.** A row lands `CLIP_LAG_MS` (40 s) after the card has its over, so 1 to
  5 minutes after the ball. The real ball-to-row lag is unmeasured. Because the card
  moves a whole over at a time, a ball bowled just before rain or a scorer stall is
  listed only after it. That is a useful stale-replay case, but it is the simulator's,
  not a measured one.
- **The fours/sixes ratio.** The real match ran 58:17; the engine's weights give
  about 48:7 over a match. These are Saturday-league weights rather than that match's
  flat track.
- **Ids are strings** (`c1-10.4-wicket`), not RV's integers. They are stable across
  polls, which is the property the store's dedupe needs.

### Testing replays: `v`, and the day holds while one plays

Replays are the one thing the other keys cannot test. The TTL and a clip's age are
*simulated* time, but the minimum gap between replays and the slide boundaries are
*real* time, so `c`, `.` and a played day all let clips expire before they get a turn.
**`v` runs the day a poll at a time until the player has a replay ready, then plays
it there and then** (`WccPlayer.replayReady` / `playReplayNow`, simulator-only hooks),
with the day held. **`c` plays replays inline too**: a replay is a change on screen, so
the step stops on one and plays it. While any replay is on screen the simulated clock
does not move (`replayOn`, from the player's `wcc-replay`), because on a real Saturday
the clip and the day run at the same speed. Both steps wait in real time only while a
replay is still downloading (`afterPrefetch`), so a stretch with no footage runs at full
speed. Every run clears `wccReplaySeen`, because the simulator replays the same clip ids
each time and a remembered one would never be offered again.

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
disarmed so it does not fire fifty video takeovers on its way past. `offerReplays` reads
`WccPlayer.flash` fresh every poll, so borrowing it is enough and the shipping engine
needs no flag. It is given back a *turn* later rather than at the end of the loop,
because the engine offers replays inside its poll's own promise chain, which settles after
the synchronous skip has returned. After the skip, the next poll offers whatever is still
inside the replay TTL at the new time, as a reconnect would.

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
  (`leagueById[fx.match_id]`) and the match-day board via its baked other-game tiles. An
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
feed carries no scorer cursor at all). Every surface reads them, so no two of them can
give a different account of the same match.

Two things the simulator is deliberate about here:

- **A card that stands still is not "in play".** `stillScoring()` excludes the never-scored,
  the unfinished, the book-kept and the unreadable, so the HUD's count and `c` (jump to the
  next change) don't offer moments that never arrive.
- **The stall freezes the CARD, not the cricket.** When the scorer comes back the score
  jumps several overs at once, which is what actually happens and what a board must survive.

### Simulating a league match day

The division needs one thing our own matches do not: **a baked fixture list**, because the
match-day board's other-game tiles and the ladder's other tiles are baked and the feed only
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

#### A note about the example day: TWO Wendover teams in ONE division

`2026-10-04` is an unusual fixture list — Women's Softball **Hawks (10:15)** and **Kites
(11:45)**, both in competition `142917`. `attach_league_context` hangs a `league` block off
*each* match event, so the division's other games are baked under both cards, while the one
game in that division a viewer would most want alongside the Hawks — the Kites' — is
absent from both, because our own club is excluded from "other games" by definition:

```
Women's Softball Hawks → others: ['990291700']
Women's Softball Kites → others: ['990291700']
```

**The match-day board handles this at the layout, not the feed** — `match_day_layout`
bands by DIVISION rather than by fixture, so the two sides share one band and everyone
else's games are listed once. Worth knowing while testing on this date: the doubled
`others` in the baked data is `attach_league_context`, not the simulator.

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

`live-events`, in the **Live Test** deck (`content/slideshows/live-test.json`) — the
match-day board and the inspector, and nothing else. It is deliberately NOT in the Match
Day deck and the deck declares no `homepage_rank`, so it reaches neither the homepage nor
a screen rotation: it is an instrument for us, not something the wall should ever show.
Reach it at `/slideshow/live-test/?sim=matchday`. It renders the `wcc-events` broadcast: the
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

> **THE WORDING REVIEW OF 2026-09-29 IS AHEAD OF THIS DOCUMENT.** James read a whole
> simulated afternoon line by line and rewrote most of the band; the code is the
> authority for the exact text until this page is re-levelled. The rules that came out
> of it, which any new type must follow:
>
> - **The sentence stands on its own.** The gold tile is back to the team and
>   division (done 2026-10-01), so no line may lean on it to name the event: a fifty
>   says "reaches a fifty", a wicket maiden says "wicket maiden".
> - **The club named is never ours** (`clubTag`). His own club takes "for", the side he
>   is up against takes "v", and the opposition is what identifies the match on a wall
>   showing three of our sides.
> - **That phrase is discretionary**: `drop: true` on a part, and the ticker takes it
>   off again when the line would otherwise truncate (`fit` in live-ticker.html). Say
>   it when there is room; never truncate the news to say it.
> - **Gold is for totals.** A score, a batter's running total, a bowler's match
>   figures. Never an increment: a spell's figures, a passage's runs, an economy
>   through a window and a stand's rate are all in the plain type.
> - **The strip holds the state**, so no line repeats the innings total.
> - **In the second innings the verb is "chasing"**, not batting, added or scored.
> - **Punctuation glues**: a part beginning with a comma takes no space in front of it
>   (`glue` in the ticker, `textOf` here), which is how a figure keeps its colour
>   without the comma taking it too.
>
> **Still to do, in James's order (2026-09-29):**
>
> 1. ~~**`innings_closed`**~~ — WRITTEN 2026-10-01 (`closedPayload`), past tense:
>    "Gerrards Cross were bowled out for 181 v Haddenham" / "Chenies & Latimer finished
>    on 241/9" / "Bowled out for 181 v Chenies & Latimer" (ours, subject dropped).
>    Bowled out = ten down, the runs alone; declared on; otherwise finished on.
> 2. **`match_break` / the innings break** alongside it, for the same reason.
> 3. ~~**`match_finished`**~~ — WRITTEN 2026-09-30, see "The result sentence" below.
>    **`probability_shift`** and **`ladder_shift`** are unreviewed and still on
>    their old text.
> 4. **The ladder's red/green fill** is unreviewed.
> 5. **`team_total` would like the overs remaining in a first innings too.** It has
>    them in a chase only, because the allotment is inferred from the first innings'
>    close — the DLS overs note again, and the per-competition table would answer both.
> 6. **How long they were off for** is stated when play resumes, not while they are
>    off: we know when a break began and never when it will end, and a duration that
>    grows on screen is a clock rather than a line.
> 7. ~~**The strip's chase apertures**, flat and dimmed at SIM 19:25~~ — ANSWERED, and
>    it was not the strip. The panel was right: that match had finished, and a finished
>    match's figures are settled by design. What was wrong was the LINE beside it —
>    "Tring Park are chasing The Lee", half an hour after Tring Park had lost. A card
>    does not stop moving when the game does (a late sync, a correction, the same
>    innings re-stated), and the completion branch returns on the transition poll only,
>    so every later change was still being read as a live scoreline. Both feeds' score
>    lines and the passage family are now guarded on `!m.complete`: **a match that is
>    over has no score to report, only a result.**


**1. The remaining event types have not been written for the L-frame.** Written so
far: `toss`, `match_started`, `score_update` (rewritten against the scoreboard beside
it: the pair at the crease, the stand or the passage, the batting side — no scoreline),
`wicket` (club, gold figure, blue overs, then the dismissal in scorecard notation and
who is still to bat), and the individual family above —
`hundred`/`fifty`/`five_for` rewritten, `new_batsman`, `spell_started` and
`spell_ended` added, `stand` — the first event about two players rather than one — the passage family (`charge`, `squeeze`, `collapse`),
`hat_trick`/`on_a_hat_trick`, the maidens (`wicket_maiden`, `maiden_run`) and
`team_total`, whose **wording is still provisional**, and `match_finished` (below).
**Still on the generic default:** `abandoned`, `rain_break`, `match_break`, and
`probability_shift`/`ladder_shift`, which are deliberately held back with the swing
and highlight work. Walking them **one at a time** is the way this has gone and the
way it should continue.

#### The result sentence (`match_finished`, `finishedPayload`)

How it ended, then who won — read off the scorecard, never the feed's prose:

| ending | line |
|---|---|
| chasing side bowled out | `Denham are bowled out · Wendover win by 34 runs` |
| chasing side reaches the first innings' overs | `Gerrards Cross run out of overs · Haddenham win by 34 runs` |
| target passed, we set it | `Denham chase down the target to win by 2 wickets` |
| target passed, anyone else set it | `Wendover chase down the Denham target to win by 2 wickets` |
| defended, ending unprovable (first innings all out, so no allotment) | `Wendover beat Denham by 30 runs` / `Denham win by 30 runs` |
| tie | `Denham are bowled out level on 180 · Match tied` |
| division card with no score (kept in the book) | `Amersham beat Wooburn Narkovians` (from `result_applied_to`); `… and … tie` / `draw` |
| DLS / concession / award / not two innings | the feed's own words (`resultParts`), plus the fixture on a division match |

- **Wendover is named here, as a subject** — the one exception to the never-our-name
  rule, because a result without its winner is not a result. The object case still
  holds: we set "the target", never "the Wendover target".
- **Division lines name both clubs and no division** (the strip carries that).
- **The hedge is ours only**: `– result to be confirmed` while `complete && !final`,
  and the separate `final` event repeats the sentence with `– result confirmed`. The
  division feed has no `final`, so it never hedges.
- `abandoned` keeps `abandonedPayload`, now on first sighting too.

> James's direction, 2026-09-30.

**2. Some type labels are written for a table, not for an 8vw block.** The tile
renders `TYPES[].label`, so `match_finished` puts "MATCH FINISHED" in the corner where
"RESULT" belongs. Probably wants a separate tile label per type.

**3. ~~`score_update` for another club can never be shown~~ — ANSWERED by coverage.**
It was true and it was an accident: `round(12 × 0.55) = 7` against a `SHOW_FLOOR` of 8
excluded a division's coarse scoreline by arithmetic rather than by a decision. The
coverage multiplier is the decision — a division score stays out while its match is
being covered and climbs past the floor when it is not.

**4. The live dot has lost its meaning.** It pulsed for "this match is in play"; beside
a type label it is decoration, and it is wrong beside `RESULT`.

**5. `No feed` has no mark of its own on a tile**, so a failed fetch now looks like a
game not yet started — the honest half of a bad choice, since the alternative was to
keep asserting a game was in play. The `aged` band (10–30 min) has nowhere to live
either: the board shows the score with a `↻ 14m` chip and a tile has no chip. Both
would be answered by a third mark in the bottom-left slot — a hollow dot to the filled
one.

**6. Which events take over the screen.** *Settled 2026-10-01: every ball with
footage, as rotation content at slide boundaries, admitted by a 10-minute TTL, with the
band in a score-free replay mode. See
[Replays](#replays--footage-is-rotation-content-and-the-store-decides-what-is-still-worth-it).
The rest of this item is the history.* Footage currently means takeover. Every
wicket clip pausing the slideshow may be too much; a minimum gap between takeovers is
one constant away. This is also where the **REPLAY** direction lands: a clip is to
become an event in its own right, with its own caption, score and team graphics —
at which point `attachClip` is wrong rather than in need of tuning, since it folds
footage into the incident instead.

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

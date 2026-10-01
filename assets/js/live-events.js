/* live-events.js — the live EVENT STREAM: extraction, store, interest, scheduling.
 *
 * The v2 substrate. The v1 live chrome renders CURRENT STATE — the ticker cycles
 * whatever the latest poll says the score is, the strip paints where the table
 * stands. That is the wrong unit for a screen someone glances at: what a glance
 * wants is WHAT JUST HAPPENED. So the feed stops being the thing we render and
 * becomes the thing we differentiate, and the chrome becomes a scheduler over the
 * resulting stream of events.
 *
 * An event carries THREE times, and the distinction between them is the whole
 * design:
 *   happened_at  [from, to] — when it actually happened out on the field. A range,
 *                because a poll only brackets it: somewhere between the scorer's
 *                previous sync and this one. Sometimes unknowable (from = null).
 *   received_at  when THIS client learned of it. Always known. A device that joins
 *                late has old events it has never shown, and that is not the same
 *                as an event it showed an hour ago.
 *   shown_at     when the chrome last showed it. null = never shown. This is what
 *                stops the surface repeating itself, and what lets it repeat
 *                deliberately when there is nothing newer.
 *
 * On top of them sits `interest` (how much this event deserves a screen) and a
 * scheduler that ranks the store and answers ONE question per tick: which event,
 * if any, should the chrome be showing — and for how long. "None" is a real answer
 * and means the chrome collapses.
 *
 * The news flash is not a separate feature here. An event that carries a clip is
 * shown BY playing the clip: the slideshow pauses, the footage runs, and the
 * ticker beside it describes that same event instead of drifting on its own cycle.
 * "Show this event" is one verb whose shape depends on what the event has.
 *
 * PURE and DOM-free: feeds in, events out, a ranking on request. Every surface —
 * the real chrome, the inspector slide, the simulator — drives the same functions.
 *
 * See docs/live-events.md for the model, the type table and the open questions.
 */
(function () {

    // ---- the type table -----------------------------------------------------
    // `base` is the event's interest before any context; `ttl` is how long it stays
    // news (ms of REAL time — the simulator scales its clock, not these); `repeat`
    // is how long before an already-shown event may be shown again, or null for
    // never. A result is worth re-showing for a long while (it is the standing
    // answer to "what happened?"); a score update is worth showing once and is
    // superseded by the next one anyway.
    //
    // Weights are a starting position, meant to be argued with — that is what the
    // inspector slide is for. They are deliberately spread out rather than fine:
    // the ordering between tiers is the claim, not the exact number.
    //
    // `panel` is the FOURTH property, and it belongs here for the same reason the
    // other three do: it is a claim about the kind of event, not about the strip.
    // It names which panel the side bar should be showing while this event is on —
    // see the L-frame decomposition below.
    var TYPES = {
        /* A HAT-TRICK — the rarest thing in a league season and the top of the table.
         * Above a hundred and a five-for because both of those are an afternoon's work
         * and this is three deliveries. See `trackSpells` for why it can be claimed
         * from a scorecard diff at all. */
        hat_trick:         { base: 94, ttl: 900000,  repeat: 420000, label: 'Hat-trick',      panel: 'profile' },
        hundred:           { base: 92, ttl: 900000,  repeat: 420000, label: 'Hundred',        panel: 'profile' },
        five_for:          { base: 90, ttl: 900000,  repeat: 420000, label: 'Five wickets',   panel: 'profile' },
        match_finished:    { base: 88, ttl: 2700000, repeat: 300000, label: 'Match finished', panel: 'ladder' },
        abandoned:         { base: 84, ttl: 2700000, repeat: 600000, label: 'Abandoned',      panel: 'ladder' },
        /* THE LADDER, WHERE THERE IS ONE: the band has just said the score that
         * matters, and the scoreboard beside it said it again. Half the match decided
         * is the first moment the table can be read against it. Falls back to the
         * scoreboard where there is no table (a friendly, a cup).
         * > James's direction, 2026-10-01. */
        innings_closed:    { base: 74, ttl: 900000,  repeat: 300000, label: 'Innings closed', panel: 'ladder' },
        /* A PARTNERSHIP PASSING A MARK — every fifty, and ONE type for all of them.
         *
         * It was two types, `stand_fifty` and `stand_hundred`, which stopped dead at a
         * hundred: a stand of 150 or 200 raised nothing at all. Adding a type per fifty
         * is the wrong shape, and a 150 stand under a tile reading CENTURY STAND is
         * worse — so the tile says the noun (PARTNERSHIP), the sentence says the figure
         * (it already did: "153 together in 22 overs"), and `magnitude` carries the
         * difference. The `team_total` pattern, for the same reason.
         *
         * See `standMarkMagnitude` for where each mark lands. A fifty stand sits just
         * under an individual fifty and a hundred stand above a wicket — one man's
         * hundred is still the bigger claim, because a scorecard remembers it and does
         * not remember the stand he was half of. */
        stand:             { base: 64, ttl: 600000,  repeat: 300000, label: 'Partnership',    panel: 'score' },
        /* THE LAST PAIR TOGETHER — nine down, and everything that happens now is the end
         * of the innings one way or the other. It is a consequence of a wicket, like
         * `new_batsman`, but a much larger one: an arrival changes who is batting where
         * this changes what the rest of the innings can be.
         *
         * Below a `wicket` (70) because the wicket that made it is the news and this is
         * what follows from it, and it is handed `tension` — nine down chasing 47 is a
         * completely different line from nine down at 300, and the chase model already
         * knows which. */
        last_pair:         { base: 54, ttl: 480000,  repeat: null,   label: 'Last pair',      panel: 'score' },
        /* A COLLAPSE — three wickets inside six overs. It sits just above `wicket`,
         * and the reason it outranks the thing it is made of is that the aggregate is
         * the story: each of those three has already had its own line at 70, and what
         * none of them said is that the innings is falling over. Rare enough that it
         * cannot crowd the band. */
        collapse:          { base: 72, ttl: 720000,  repeat: 300000, label: 'Collapse',       panel: 'score' },
        /* TWO IN TWO — the only event on the wall that looks FORWARD. Everything else
         * the band says has happened; this one says what is about to be bowled, which
         * is why it outranks a wicket and why it is the one type whose truth can expire
         * on a ball we never see.
         *
         * So it is built to die young. `ttl` is two minutes, `repeat` is null, and the
         * real guard is a RETRACTION: the moment he bowls again without the third, the
         * extractor un-says it (see `retire_only`). The ttl is only the backstop for a
         * bowler who is taken off, or rain, or an innings that ends on it.
         *
         * The tile states the fact and the bar states what it means — TWO IN TWO over
         * "T Duff 2-14 · on a hat-trick" — because the tile saying "ON A HAT-TRICK"
         * would leave the sentence nothing to add. */
        on_a_hat_trick:    { base: 76, ttl: 120000,  repeat: null,   label: 'Two in two',     panel: 'profile' },
        wicket:            { base: 70, ttl: 300000,  repeat: 180000, label: 'Wicket',         panel: 'score' },
        fifty:             { base: 64, ttl: 480000,  repeat: 300000, label: 'Fifty',          panel: 'profile' },
        ladder_shift:      { base: 60, ttl: 900000,  repeat: 420000, label: 'Ladder move',    panel: 'ladder' },
        /* WHERE THE TABLE IS HEADING — fired by the same logic that puts an arrow on a
         * ladder row, once the arrow has held for `LADDER_HOLD_MS`. Just under the
         * swing, because it is the swing's consequence and follows it on screen (see
         * `after`); withdrawn silently if the arrow goes. See `extractLadder`.
         * > James's direction, 2026-10-01. */
        ladder_expected:   { base: 46, ttl: 900000,  repeat: 420000, label: 'On course',      panel: 'ladder' },
        rain_break:        { base: 56, ttl: 1800000, repeat: 600000, label: 'Rain',           panel: 'score' },
        /* THE PASSAGE OF PLAY CHANGING CHARACTER — the two events a scoreboard can
         * never show. It displays a number going up; it cannot say that the number has
         * started going up FASTER, or stopped.
         *
         * The charge outranks the squeeze because a burst is something happening and a
         * squeeze is something not happening — but the squeeze is barely lower, since
         * a side scoring at one an over for six overs is the match being won by the
         * bowling side and nothing else on the wall reports it.
         *
         * Both are incidents: "they added 44 in four overs" stays true afterwards, so
         * neither is retired. What stops them repeating is not the ranking but the
         * disjoint-window rule in the extractor — see `surgeAt`. */
        /* A WICKET MAIDEN — six balls for nothing and a man out, which is the best
         * over a bowler bowls short of a hat-trick. Below the wicket itself on purpose:
         * the dismissal has already had its own line at 70, and what this adds is that
         * the over around it was also flawless. `magnitude` carries the difference
         * between one wicket and two, which is where this type earns being one type —
         * a double-wicket maiden lands in the wicket's own tier. */
        wicket_maiden:     { base: 56, ttl: 420000,  repeat: 240000, label: 'Wicket maiden',  panel: 'profile' },
        charge:            { base: 52, ttl: 360000,  repeat: 240000, label: 'Charge',         panel: 'score' },
        /* MAIDENS ON THE TROT — the squeeze told through one bowler, and priced level
         * with it for that reason. Three is the threshold: one maiden is an ordinary
         * over in league cricket and two is a good spell going well, but three
         * consecutive overs for nothing is the fielding side taking the game over. */
        maiden_run:        { base: 50, ttl: 480000,  repeat: 300000, label: 'Maiden overs',   panel: 'profile' },
        squeeze:           { base: 50, ttl: 480000,  repeat: 300000, label: 'Squeeze',        panel: 'score' },
        probability_shift: { base: 48, ttl: 420000,  repeat: 300000, label: 'Swing',          panel: 'score' },
        /* A DIVISION MATCH GETTING UNDER WAY. Every state change should be announced,
         * and this was the one the stream stayed silent through: the board's squares
         * turned over to "In play" and the ladder's tiles gained their mark with
         * nothing said about either.
         *
         * Placed just above `toss`, which the docs left as an inspector decision. A
         * game actually beginning is a shade more than the toss that preceded it, and
         * well below an innings closing (74). At 0.55 for another club that is 24
         * against a floor of 8, so a division's worth of starts really will queue up
         * around one o'clock — which is the quietest part of the afternoon and
         * exactly what the floor types exist to fill.
         *
         * `repeat: null` because it is a one-off fact: a match does not start twice,
         * and re-announcing it an hour on would be a lie about what is new. The ttl
         * is short for the same reason.
         *
         * Panel is the LADDER, and not as a curatorial choice — the event IS a ladder
         * repaint. Both sides' tiles change the moment the match goes live, so the
         * strip is showing the thing that just changed. */
        /* THESE TWO CYCLE. A division's matches start within half an hour of each
         * other and a club's XIs toss at much the same time, so around one o'clock
         * there are several of each and very little else — exactly the moment to go
         * round them again rather than collapse. `repeat: null` made that impossible:
         * it pins novelty at zero for good, so each could be shown once and never
         * again. With a window they come back at 0.45 of their standing, then 0.2,
         * which fades them out over two or three passes instead of one.
         *
         * The windows are short because the fade does the limiting: `base` and `ttl`
         * together mean a league start can clear the floor about twice and a toss
         * about three times, after which they drop out whatever the window says. */
        /* THE STREAM COMING ONLINE — the one event on the wall that is not news about
         * the cricket at all. It is an invitation: this game can be WATCHED, and here
         * is where. That is why it outranks a match merely starting, and why it fades
         * slowly and comes back — an invitation nobody was in the room for is an
         * invitation nobody got, where a wicket announced to an empty room has at
         * least happened.
         *
         * `ttl` is long for the same reason. A viewer has to fetch a phone, find the
         * channel and settle; twenty minutes is the window in which acting on it is
         * still worth doing, where a toss is stale in five.
         *
         * Panel is the SCORE, because by the time the stream is up there is a match to
         * show and the question a viewer asks next is what they would be watching. */
        stream_started:    { base: 46, ttl: 1200000, repeat: 300000, fade: 0.7, label: 'Stream', panel: 'score' },
        /* A TEAM TOTAL PASSING A HUNDRED — and the one type on the band whose headline
         * figure is ALREADY on the strip, in gold, larger. It is here because the
         * crossing is a moment and a scoreboard only shows a state: the strip says
         * 203/4 and can never say they have just gone past two hundred.
         *
         * It pays for itself by naming the men who built it, which the strip cannot do
         * at all — and where it cannot (the division's card carries no batters) the line
         * leans entirely on the crossing. That is the weakest case on the wall and it is
         * deliberately priced as such.
         *
         * ONE TYPE FOR EVERY MARK, with `magnitude` doing the ordering: a hundred in a
         * league innings is routine and three hundred is a monster, so 100 lands near
         * `match_started` and 200 or more just under an individual fifty. The tier cap
         * means a 300 cannot climb past a fifty, which is the right shape — a total is
         * the side's afternoon and a fifty is one man's. */
        team_total:        { base: 50, ttl: 480000,  repeat: 300000, label: 'Team total',     panel: 'score' },
        /* CLOSING IN ON A MILESTONE — the second forward-looking type, and a far safer
         * one than `on_a_hat_trick`. "He needs six for his fifty" stays true for a dozen
         * balls where a hat-trick ball is answered by the next delivery, so it needs no
         * retraction machinery: the milestone itself retires it, a wicket retires it, and
         * the ttl outlives neither.
         *
         * Below the milestone it anticipates, necessarily, and `magnitude` keeps the two
         * marks apart — approaching a fifty sits by a match starting, approaching a
         * hundred just under the fifty it is not yet. */
        approaching:       { base: 46, ttl: 300000,  repeat: null,   label: 'Closing in',     panel: 'profile' },
        match_started:     { base: 44, ttl: 900000,  repeat: 90000, fade: 0.7, label: 'In play', panel: 'ladder' },
        toss:              { base: 40, ttl: 1800000, repeat: 90000, fade: 0.7, label: 'Toss', panel: 'form' },
        /* PLAY HAS STOPPED, AND NOT FOR THE WEATHER — an innings break, drinks, tea.
         * Formerly written as an `innings_update`, which is where that type got its
         * name and why the name described neither of its two jobs. A break is a state
         * change like any other and deserves a type that says so.
         *
         * Below the toss and well below `rain_break`: the covers coming on is a
         * different order of news from the players coming off for tea, because one
         * threatens the game and the other is the game going to plan. */
        /* A NEW BATTER AT THE CREASE — the first type that exists because a PERSON
         * changed rather than a number did.
         *
         * It sits just under `match_started` and well under `wicket`, because it is
         * usually a consequence of one: the dismissal is the news and this is what
         * followed from it a minute later. What makes it worth a screen of its own is
         * the situation rather than the arrival — a number four walking out at 12/2,
         * or the last recognised batter in with forty still needed — and the
         * scheduler already prices that through the match's `tension`.
         *
         * `repeat: null` because a batter comes in once. The ttl is short for the
         * same reason: "X is in" stops being news the moment he has faced a few
         * overs, and after that the score line speaks for both of them. */
        new_batsman:       { base: 36, ttl: 300000,  repeat: null,   label: 'Batter in',      panel: 'profile' },
        /* A SPELL ENDING — the only individual event on the wall that comes with a
         * finished story attached. A hundred and a five-for are milestones a player
         * passes through; a spell is a thing with a beginning, a middle and figures.
         *
         * Above `new_batsman` for that reason and below `fifty`, because four tight
         * overs is a smaller piece of an afternoon than a half-century. What actually
         * decides whether one reaches the wall is `magnitude`, which the extractor
         * sets from the wickets in it — a wicketless spell scores 26 and a three-for
         * 50, which is the spread the type wants and the reason it is one type rather
         * than two. */
        spell_ended:       { base: 40, ttl: 480000,  repeat: null,   label: 'Spell',          panel: 'profile' },
        /* AND A SPELL BEGINNING — a bowling change, which is the captain's half of
         * the contest and the one thing the band has never said about the fielding
         * side. Lower than the ending because it is an arrival rather than a result;
         * the same relationship `new_batsman` has to a wicket. */
        spell_started:     { base: 30, ttl: 300000,  repeat: null,   label: 'Change',         panel: 'profile' },
        /* THE THREE LABELS ABOVE ARE WRITTEN FOR THE TILE, not for this table, and
         * they are the first ones that were. `isLongLabel` in live-ticker.html steps
         * the gold block's type down past nine characters or a seven-letter word, so
         * "New batter" and "Spell over" would both have shrunk the brightest thing on
         * the wall to say something a shorter word says as well: BATTER IN, SPELL,
         * CHANGE. CHANGE is the bowling change the line then names — the tile carries
         * the noun and the sentence does the rest, which is the rule the toss set. */
        match_break:       { base: 26, ttl: 600000,  repeat: null,   label: 'Break',          panel: 'score' },
        /* AND PLAY STARTING AGAIN, which is the only place the length of a stoppage
         * can be stated: while they are off we know when it began and not when it will
         * end, and a duration that grows on screen is a clock, not a line. Priced a
         * shade above the break itself — a ground that has been sitting under covers
         * for half an hour wants to be told the covers are off.
         * > James's direction, 2026-09-29. */
        play_resumed:      { base: 40, ttl: 600000,  repeat: null,   label: 'Play resumes',   panel: 'score' },
        ball_clip:         { base: 20, ttl: 180000,  repeat: null,   label: 'Ball',           panel: 'score' },
        /* THE FLOOR, and now the only snapshot type there is. `ttl` is deliberately
         * longer than the gap between two of them: a snapshot is retired by its own
         * successor (see RETIRES), so the ONLY way an old one survives is that no
         * newer score exists — in which case it is still the best truth we have, and
         * dying at three minutes left the coverage rule below with nothing current to
         * lift. Two overs' worth is enough to bridge a slow over rate or a scorer
         * syncing in lumps without ever outliving the score it states. */
        score_update:      { base: 12, ttl: 540000,  repeat: null,   label: 'Score',          panel: 'score' }
    };
    function typeOf(t) {
        return TYPES[t] || { base: 10, ttl: 180000, repeat: null, label: t, panel: 'score' };
    }

    /* WHAT A NEW EVENT RETIRES, within the same match.
     *
     * Some events do not merely outrank their predecessors, they make them WRONG.
     * "Chalfont 9/0 (2 ov)" is not old news once 17/0 lands; it is a false statement
     * about the score, and a surface showing it is lying to the room whatever its
     * freshness works out to. A retired event scores 0, can never be picked, is the
     * first thing evicted when the store fills, and loses the band at once if it is
     * the one on screen.
     *
     * IT IS NOT ONLY A TYPE RETIRING ITSELF. This began as "a score update supersedes
     * the previous score update", which is true but far too narrow: once we are
     * reporting a score for a match, that match's "In play" and its toss have both
     * stopped being news about it — the screen has moved on and they describe a state
     * we have visibly left. So each type names what it retires, and a type retiring
     * its own kind is just the commonest row rather than the whole idea.
     *
     * INCIDENTS ARE NEVER RETIRED, and the distinction matters: a wicket is still a
     * true account of a wicket an hour later, a second wicket does not unmake the
     * first, and a result does not unmake either. Only the descriptions of a state
     * the match has since left are in here. */
    var RETIRES = {
        // Play is under way, so the toss is history.
        match_started:  ['toss'],
        // A score is being reported: the match is plainly started and plainly tossed,
        // and any earlier score for it is now simply wrong.
        /* AND THE INNINGS THAT CLOSED, AND ANY BREAK. A score line only goes out when
         * the innings has advanced by a whole over, so by the time one exists the
         * players are plainly back on and the previous innings is plainly history —
         * both of which the band was leaving on screen for the rest of their ttl.
         * "Wendover 248/9 · Target 249" beside a chase already 40 for 1 is a state the
         * match has left, which is exactly what this table is for.
         * > James spotted this one, 2026-09-29. */
        score_update:   ['toss', 'match_started', 'score_update',
                         'innings_closed', 'match_break', 'rain_break', 'play_resumed'],
        /* A WICKET CARRIES A SCORE, so it retires the same things a score does: it
         * leads with the scoreline the wicket left behind, and once that is on the
         * wall the match's toss, its "In play" and any earlier running total all
         * describe a state we have visibly left.
         *
         * NOT SYMMETRIC, and deliberately: `score_update` does not retire it back. A
         * wicket's scoreline is stamped to the ball it fell on, so a later whole-over
         * total does not make it false, only older, which is freshness's business
         * rather than retirement's. It is also an INCIDENT: it happened, and the
         * incident rule is what stops a routine snapshot deleting it. */
        /* AND IT RETIRES THE LAST ARRIVAL. "T Denham is in" describes the pair at
         * the crease, and a wicket has just broken that pair — one of the two named
         * in it has gone. It is not merely older, it is a sentence about a state the
         * match has left, which is exactly what this table is for.
         *
         * Same-poll ordering makes this safe rather than lucky: the wickets are
         * pushed before the batters loop runs, so a wicket landing with the arrival
         * that FOLLOWED it retires the previous one and leaves the new one standing. */
        /* A STAND IS A PAIR STILL TOGETHER, so the wicket that separates them makes
         * the line FALSE, not merely old: "J Harrington and W Fairhead · 53 together"
         * beside a board showing the next man in is the room being lied to. This is
         * the retirement test exactly — a description of a state the match has left —
         * and it is why a stand is not an incident the way a wicket is.
         *
         * A bigger mark retires the smaller one for the same reason: the same two men
         * on 104 together make "53 together" a wrong number, not an old one. */
        /* A MAN OUT IN THE FORTIES makes "needs six for his fifty" false, not old, so the
         * wicket takes the approach with it.
         *
         * KNOWN OVER-REACH: `RETIRES` is per match, so this also retires the OTHER
         * batter's approach, which is still perfectly true. It costs that event the rest
         * of its time on the band and never puts a wrong sentence on screen, where the
         * alternative — not retiring — leaves the band telling a room that a man who is
         * walking off needs six more. Two batters approaching marks at once is rare;
         * being wrong in public about one of them is not worth the trade. */
        /* AND THE TENTH WICKET UNMAKES THE LAST PAIR. They are not together any more;
         * they are all out, and `innings_closed` is about to say so.
         *
         * The wicket that CREATES the last pair does not retire it, because the wickets
         * block runs first in the extractor and the retirement only reaches events
         * already in the store. */
        wicket:         ['toss', 'match_started', 'score_update', 'new_batsman', 'stand',
                         'innings_closed', 'match_break', 'rain_break', 'play_resumed',
                         'approaching', 'last_pair'],
        // He got there: the anticipation has been answered by the best possible result.
        fifty:          ['approaching'],
        hundred:        ['approaching'],
        /* A BIGGER MARK RETIRES THE SMALLER ONE, which one type expresses better than
         * two did: the same pair on 153 make "104 together" a wrong number, whatever
         * marks the two lines happened to be about. */
        stand:          ['score_update', 'stand'],
        /* A PASSAGE IS AN INCIDENT — it happened, and a later one does not unmake it,
         * so none of the three appears in anybody's retirement list. They retire the
         * routine snapshot for the usual reason: once the band has said what the last
         * four overs were worth, "where they are" is the duller half of it. */
        /* THE THIRD BALL TOOK A WICKET, so "on a hat-trick" has been answered and must
         * go — the retraction below handles the other answer. */
        hat_trick:      ['score_update', 'on_a_hat_trick'],
        on_a_hat_trick: ['score_update'],
        /* A BIGGER MARK RETIRES A SMALLER ONE: "200 up" is a wrong number once they are
         * past three hundred, the same reasoning a century stand retires its fifty.
         * Scoped per match as always, which here is exactly right — both sides' totals
         * in one match are the same running story and the older one is the stale half. */
        team_total:     ['score_update', 'team_total'],
        wicket_maiden:  ['score_update'],
        /* A LONGER RUN RETIRES A SHORTER ONE — "three in a row" is a wrong number once
         * it is four, the same reasoning a century stand retires its fifty.
         *
         * KNOWN SCOPE LIMITATION: `RETIRES` is per MATCH, so a second bowler's run of
         * maidens would retire the first bowler's, which is not false, only earlier. It
         * costs an event a little of its time on the band, it needs two bowlers with
         * three consecutive maidens each inside one ttl to happen at all, and the
         * alternative is a per-person retirement scope that nothing else wants. */
        maiden_run:     ['score_update', 'maiden_run'],
        charge:         ['score_update'],
        squeeze:        ['score_update'],
        collapse:       ['score_update'],
        // An innings closing settles every running figure for that innings.
        play_resumed:   ['match_break', 'rain_break'],
        // And the pair, the approach and the hat-trick ball: an innings that is over
        // has no partnership still going, nobody closing in on anything, and no next
        // ball. > James's observation, 2026-10-01.
        innings_closed: ['last_pair', 'toss', 'match_started', 'score_update', 'match_break',
                         'new_batsman', 'spell_started', 'stand', 'approaching',
                         'on_a_hat_trick'],
        // And a verdict settles everything that described the game in progress —
        // but not its wickets, its sixes or its hundreds, which happened.
        // A swing replaces the last one: "Denham now favourites" is wrong once
        // "Wendover fighting back" is true.
        probability_shift: ['probability_shift'],
        match_finished: ['last_pair', 'toss', 'match_started', 'score_update', 'match_break',
                         'probability_shift', 'new_batsman', 'spell_started'],
        abandoned:      ['last_pair', 'toss', 'match_started', 'score_update', 'match_break',
                         'probability_shift', 'new_batsman', 'spell_started']
    };

    // A league-other match matters less than one of ours — but NOT so much less
    // that a title decided down the road never reaches the screen. One dial, so the
    // club-centricity of the whole surface can be tuned in a single place.
    var OTHER_CLUB_FACTOR = 0.55;
    // Something to watch beats something to read, at equal news value.
    var CLIP_BONUS = 12;
    // Below this, nothing is worth a screen and the chrome collapses. The floor is
    // what makes an empty afternoon read as empty instead of as a loop of stale
    // scorelines.
    var SHOW_FLOOR = 8;

    /* ---- coverage: nobody goes unmentioned -----------------------------------
     *
     * THE RULE THE TYPE TABLE USED TO STAND IN FOR. What we actually want is "no
     * match goes longer than this without a score on the wall", and that is a claim
     * about a MATCH and a CLOCK — not about a kind of event. Said as a type weight
     * (a heavier snapshot every fifth over) it came out wrong three ways: it never
     * applied to the division, it lifted a match just shown as much as one neglected
     * all afternoon, and it was counted in overs, so rain or a slow over rate
     * switched the guarantee off exactly when it was needed.
     *
     * Said here it is two dials that mean what they say. `COVERAGE_MS` is how long a
     * match may go unmentioned; `COVERAGE_LIFT` is how hard we push to prevent it.
     * Twenty minutes is about five overs at a club over rate, which is the interval
     * the old rule was reaching for — but now measured in the units the room
     * experiences rather than in balls we may not be told about.
     *
     * The lift is what carries a snapshot over the floor. A division score is worth
     * 7 against a floor of 8, so it can never take the band unaided; fully neglected
     * it reaches 21, which clears the floor and sits below anything that is actually
     * news. One of ours goes 12 -> 36. It is a MULTIPLIER on the score rather than a
     * bonus on the interest so that it cannot resurrect a stale or retired snapshot:
     * freshness and supersession still multiply through, so the only thing coverage
     * can promote is a score that is both current and true.
     *
     * SELF-CANCELLING. Showing a match resets its own clock, so a busy match is never
     * padded and a quiet one is picked up without anyone having to list it. */
    var COVERAGE_MS = 20 * 60000;
    var COVERAGE_LIFT = 2;
    // Only the floor is lifted. Real news does not need help reaching a screen, and
    // a rule that lifted everything would just be a second freshness.
    var COVERAGE_TYPES = { score_update: 1 };

    /* How much of an innings may already be played when we first see it and still be
     * treated as having happened on our watch. Three is a passage of play we can
     * honestly walk the band through; a card that turns up at 90/6 is a scorer
     * publishing late, and reciting six dismissals nobody saw is not news. */
    var NEW_INNINGS_MAX_WICKETS = 3;

    // ---- interest -----------------------------------------------------------
    // Interest is fixed at EXTRACTION time, from the event and the state that
    // produced it: how much this event deserves a screen, before any question of
    // when it arrived or whether we have shown it. Time is the scheduler's job, and
    // keeping the two apart is what makes either tunable.
    function interestOf(type, ctx) {
        ctx = ctx || {};
        var t = typeOf(type);
        var v = t.base;
        if (!ctx.ours) v *= OTHER_CLUB_FACTOR;
        if (ctx.clip) v += CLIP_BONUS;
        // A wicket in a tight chase is a different event from a wicket on the first
        // morning of a one-sided game, and the chase model already knows which is
        // which. `tension` is 1 when the match is on a knife edge and 0 once it is
        // decided in all but name.
        if (ctx.tension != null) v += 18 * ctx.tension;
        // A swing is only as interesting as it is big: a 6-point wobble is noise,
        // a 30-point lurch is the story of the afternoon.
        if (ctx.magnitude != null) v *= Math.min(1.6, 0.4 + 1.6 * ctx.magnitude);
        /* CONTEXT MAY NOT PROMOTE AN EVENT OUT OF ITS TIER. Left unclamped, a tense
         * wicket with footage scored 92 — level with a hundred and above a finished
         * match — so a routine dismissal with a replay attached outranked the best
         * individual performance of the season. The type table is the claim about what
         * matters; context is meant to order events WITHIN a tier, not rewrite the
         * tiers. A quarter of base is enough room to do that and not enough to jump. */
        return Math.max(1, Math.round(Math.min(v, t.base * 1.25)));
    }

    // How tight is this match, 0..1, from the chase model's win probability. First
    // innings has no honest answer, so it reads as middling rather than as tense.
    function tensionOf(card) {
        var st = window.WccChase ? WccChase.chaseState((card && card.innings) || []) : null;
        if (!st) return 0.35;
        return Math.max(0, 1 - Math.abs(2 * st.p - 1));
    }

    // ---- how long a pick stays up -------------------------------------------
    /* MOSTLY IT IS NOT A DURATION AT ALL. An event holds the band while it is still
     * the best thing above the floor, so "how long" is an outcome of `base`, `ttl`
     * and what else is happening — see `tick`. Only two things here are real clocks,
     * and both are about honesty rather than pacing. */

    /* NOTHING MAY APPEAR FOR AN INSTANT. Decisions are taken when a poll brings new
     * information, and the two feeds run on different cadences, so two ingests can
     * land a second apart and swap the band twice. This is the floor on how briefly
     * anything can be up — long enough to be read at a glance across a room, short
     * enough that real news is never held back by much. */
    var MIN_SHOW_MS = 10000;

    /* FOOTAGE RUNS TO ITS END. A clip is not a caption that can be swapped
     * mid-sentence: the slideshow has given way to it, and cutting it off mid-wicket
     * because a six landed elsewhere is worse than being a few seconds late to the
     * six. The clip plus a beat either side — a moment to register what is about to
     * be shown, and a moment before the slideshow is handed back. */
    function clipHoldMs(ev) {
        return Math.round(((ev.clip && ev.clip.duration) || 30) * 1000) + 2500;
    }
    /* The MINIMUM a pick will be up for, which is all `dwell` means now. Kept on the
     * record because a surface preparing to show an event still wants to know
     * whether it is about to run footage or put up a line of text. */
    function dwellFor(ev) {
        return ev.clip ? clipHoldMs(ev) : MIN_SHOW_MS;
    }

    /* ---- the L-frame decomposition ------------------------------------------
     *
     * The L-frame is ONE presentation of ONE event, not three renderers that happen
     * to be on at the same time. When the scheduler picks an event its parts are
     * split by KIND OF INFORMATION, and each surface always does the same job:
     *
     *   tile   (bottom left)      the TYPE — what kind of thing just happened
     *   ticker (the bottom bar)   the TEXT — what happened
     *   strip  (the side bar)     ONE panel — what it did to the match — over a
     *                             footer naming WHOSE match it is
     *
     * The tile is the hinge of both readings out of the corner: along the bottom,
     * WICKET → "Harrington bowled Duff 62"; up the side, WICKET → the chase it just
     * dented, over "1st XI · Div 6C TVCL".
     *
     * THE TILE CARRIES THE TYPE, NOT THE CONTEXT, and that is a change from v1. The
     * gold block is the brightest thing on a wall and is read first, so it should say
     * what happened rather than whose it is; and the type is a short closed
     * vocabulary that fits the 8vw band at full size, which a team name over a
     * division never did. Attribution moves to the strip's BOTTOM band — bottom, so
     * that it lands on both paths out of the corner rather than stranded at the far
     * end of one.
     *
     * This lives here, beside the type table, because the panel is a property of the
     * KIND of event and every surface has to agree about it. The strip deciding for
     * itself is how you end up with a ladder beside a wicket and a chase beside a
     * ladder move.
     *
     * AVAILABILITY OVERRIDES THE REQUEST. A friendly has no league table, a division
     * match has no baked form, and player profiles do not exist yet — so a panel is a
     * PREFERENCE with a fallback chain behind it, and the chain is walked until
     * something can actually be drawn. That is also how the grey areas resolve
     * themselves without a special case: a toss asks for form, form is only baked for
     * our own teams, so a league toss lands on the ladder — which is exactly what it
     * wanted anyway. */
    var PANELS = {
        // Match score / chase position — the strip's original two-tile view. The
        // terminal fallback for almost everything, because a match always has a score
        // once a ball has been bowled.
        score:   { label: 'Match score', chain: ['score', 'ladder'] },
        // The division, ordered by league position, with this match's sides marked.
        ladder:  { label: 'League ladder', chain: ['ladder', 'score'] },
        // How the two sides have been going — the baked five-result `form`. Frames a
        // toss, which is the one moment with no score to show at all.
        form:    { label: 'Recent form', chain: ['form', 'ladder', 'score'] },
        // A person's season, for an event that is about a person. UNBUILT — see the
        // player-profiles work — so it always falls through today, which is the
        // fallback chain doing its job rather than a bug.
        profile: { label: 'Player profile', chain: ['profile', 'score', 'ladder'] }
    };

    /* What the strip can actually draw for this event, given what the surface holds.
     * The caller states it, because only the caller knows: the strip knows whether it
     * has a baked division for this match, the engine knows whether a card has any
     * innings in it yet. Anything unstated is taken as unavailable — a panel we cannot
     * prove we can draw is one we must not ask for. */
    function panelFor(type, avail) {
        avail = avail || {};
        var wanted = typeOf(type).panel || 'score';
        var chain = (PANELS[wanted] || PANELS.score).chain;
        for (var i = 0; i < chain.length; i++) {
            if (avail[chain[i]]) {
                return { panel: chain[i], wanted: wanted, fell_back: chain[i] !== wanted };
            }
        }
        // Nothing to show beside the text. A real answer — an event with no match
        // behind it at all, or a match we know nothing about yet — and the strip
        // stands down rather than inventing a panel.
        return { panel: 'none', wanted: wanted, fell_back: wanted !== 'none' };
    }

    /* The whole split for one event. Pure: feed it the event and what the surfaces
     * can draw, and it says what each of the three should say. */
    function decompose(ev, avail) {
        if (!ev) return null;
        var m = ev.match || {};
        var p = panelFor(ev.type, avail);
        return {
            type: ev.type,
            ticker: {
                // The event as ONE line. `parts` is the marked-up form the bar draws;
                // `text` is the same line flat, for every other reader. There is no
                // third field any more — see `say()`.
                text: (ev.payload && ev.payload.headline) || '',
                parts: (ev.payload && ev.payload.parts) || null,
                // Footage changes what showing MEANS: the slideshow gives way and the
                // clip runs in the slide's box, with this same bar beside it.
                clip: !!ev.clip
            },
            strip: {
                panel: p.panel, wanted: p.wanted, fell_back: p.fell_back,
                label: (PANELS[p.panel] || {}).label || '',
                // WHICH match the panel is about. The strip binds on these ids, never
                // on a name — see the side-resolution note in live-strip.html.
                pc_id: m.pc_id == null ? null : m.pc_id,
                match_id: m.match_id == null ? null : m.match_id,
                // The strip's head: the division, over either panel.
                division: m.division || '',
                ours: !!m.ours
            },
            /* The gold tile: WHOSE MATCH. Our XI on our games, the division on
             * everybody else's (two club names have never fitted 8vw) — the same
             * rule as `attribution` in live-ticker.html. */
            tile: { label: m.tile || (m.ours ? (m.team_short || m.team || 'Wendover') : m.division) ||
                           typeOf(ev.type).label || ev.type, type: ev.type }
        };
    }

    // ---- the store ----------------------------------------------------------
    // Holds every event this client has heard about, newest last. Dedupe is by `id`,
    // which every extractor builds deterministically from the match, the type and
    // the thing that changed — so the same wicket seen in five consecutive polls is
    // one event, first-seen time preserved.
    function store(opts) {
        opts = opts || {};
        var CAP = opts.cap || 400;
        var events = [], byId = {};
        var current = null;        // the event the chrome is showing, if any
        var shownSince = 0;        // when it went up
        var clipUntil = 0;         // footage must run to its end; see `tick`
        /* WHEN EACH MATCH WAS LAST ON THE BAND, and when we first heard of it at all.
         * Coverage is measured against the later of the two: a match whose first event
         * arrived a minute ago has not been neglected, it has only just turned up, and
         * treating it as starved would put every match on the wall at maximum lift the
         * moment a device joins. Keyed on `match.key`, which every extractor builds. */
        var shownAt = {}, firstSeen = {};

        function add(ev) {
            if (!ev || !ev.id) return null;
            if (byId[ev.id]) return null;                 // already known: not news twice
            ev.shown_at = null; ev.shown_count = 0;
            ev.superseded = false;
            ev.dwell = dwellFor(ev);
            // What this event retires in its own match — see RETIRES. Same match
            // only: a score in one game says nothing about the state of another.
            /* RETIREMENT BY ID, for the one family whose "same match" is the wrong
             * scope: an expected ladder move belongs to a TEAM, and both sides of one
             * fixture can carry one. `retire_ids` names exactly the events that have
             * stopped being true. */
            (ev.retire_ids || []).forEach(function (id) {
                if (byId[id]) byId[id].superseded = true;
            });
            var kill = ev.retires || RETIRES[ev.type];
            if (kill) {
                for (var s = 0; s < events.length; s++) {
                    var old = events[s];
                    if (old.match.key === ev.match.key && kill.indexOf(old.type) !== -1) {
                        old.superseded = true;
                    }
                }
            }
            /* A RETRACTION HAS DONE ITS WHOLE JOB, and it is not something to show. It
             * is deliberately not remembered in `byId` either: it carries no id worth
             * de-duplicating, and the extractor that raised it is one-shot by its own
             * state (`_spells[..].on`). */
            if (ev.retire_only) return null;
            byId[ev.id] = ev;
            events.push(ev);
            var mk = ev.match && ev.match.key;
            if (mk && firstSeen[mk] == null) firstSeen[mk] = ev.received_at;
            /* Oldest-first eviction, and a cap must never silently drop news we still
             * owe a screen — so the order of preference is: a superseded snapshot
             * (retired, and owed nothing), then something already shown, then, only if
             * neither exists, the oldest thing there is. */
            while (events.length > CAP) {
                var i = events.findIndex(function (e) { return e.superseded; });
                if (i < 0) i = events.findIndex(function (e) { return e.shown_count > 0; });
                var gone = events.splice(i < 0 ? 0 : i, 1)[0];
                if (gone) delete byId[gone.id];
            }
            return ev;
        }

        // Freshness: 1 while the event is new, falling to 0 across its ttl. Squared
        // so the tail is shallow — an event does not become worthless the instant it
        // is no longer the latest thing.
        /* Freshness decays from when the event HAPPENED, not from when we heard about
         * it. The two differ exactly where it matters: a clip of a wicket from twenty
         * overs ago arrives now, and announcing it as the latest news would be a lie
         * the room can see out of the window. `happened_at[1]` is the late bound of
         * the bracket — the latest moment it can have happened — so using it is the
         * charitable reading of our own uncertainty. Unbracketed events (no cursor on
         * either side) fall back to `received_at`, which is all we know about them.
         *
         * `received_at` is NOT redundant: a device that joined late holds events it
         * has never shown, and that is `novelty`'s business, below. */
        function freshness(ev, now) {
            var t = typeOf(ev.type);
            var at = (ev.happened_at && ev.happened_at[1]) || ev.received_at;
            /* ...but only so far back. `happened_at` comes from the SCORER's cursor,
             * and a scorer who stopped syncing an hour ago still yields a healthy poll
             * (the trap rv.mjs already warns about for a board's status). Taken
             * literally, every event from such a feed is born an hour old, scores zero
             * and the chrome collapses on a match day — while we in fact just learned
             * all of it and the room has seen none of it.
             *
             * So an event may not be treated as older than this relative to when we
             * received it. Deliberately longer than the newsy ttls (a six is stale
             * after four minutes either way, so old footage still cannot pose as
             * breaking news) and shorter than a result's, so a result we hear late is
             * still worth the screen it deserves. */
            var MAX_BACKDATE = 900000;
            at = Math.max(at, ev.received_at - MAX_BACKDATE);
            var age = now - at;
            if (age <= 0) return 1;
            if (age >= t.ttl) return 0;
            return Math.pow(1 - age / t.ttl, 2);
        }
        // Novelty: never shown = 1. Shown = 0 until its repeat window passes, then a
        // fraction that shrinks each time it comes round again, so an event can hold
        // a quiet afternoon without becoming the afternoon.
        /* HOW FAST AN EVENT FADES ON REPETITION. Each showing multiplies its
         * standing by this, so 0.45 is "shown once, now worth under half" — right for
         * news, which is diminished by having been said.
         *
         * SOME TYPES ARE NOT DIMINISHED THAT FAST. Around one o'clock a division's
         * matches all start and a club's XIs all toss, and there is nothing else on;
         * going round them twice more is better than collapsing. At 0.45 that is
         * arithmetically impossible however the other dials are set — a third pass
         * needs `interest x 0.45^2 >= 8`, i.e. an interest of 40, i.e. a base above
         * `innings_closed` for a match that has merely begun. The decay is the
         * binding constraint, so it is the one that has to be a per-type property. */
        var FADE = 0.45;
        function fadeOf(t) { var d = typeOf(t); return d.fade == null ? FADE : d.fade; }

        function novelty(ev, now) {
            /* THE EVENT ON SCREEN IS NOT BEING RE-SHOWN, IT IS STILL BEING SHOWN, so
             * novelty does not touch it. This is what lets an event hold its place by
             * scoring rather than by a separate hold: it stays top of the ranking
             * until its own freshness drops it below the floor or something outscores
             * it, which is the whole model. `shown_at` is stamped when it LEAVES, so
             * the repeat window measures time off the screen — which is what "how
             * long before it may be shown again" was always supposed to mean. */
            if (ev === current) return 1;
            if (!ev.shown_at) return 1;
            var t = typeOf(ev.type);
            if (t.repeat == null) return 0;
            if (now - ev.shown_at < t.repeat) return 0;
            return Math.pow(fadeOf(ev.type), ev.shown_count);
        }
        /* How starved this event's match is of a screen, 1..1+COVERAGE_LIFT. 1 for
         * everything that is not the floor, and for a match shown recently. */
        function coverage(ev, now) {
            if (!COVERAGE_TYPES[ev.type]) return 1;
            var mk = ev.match && ev.match.key;
            if (!mk) return 1;
            var last = shownAt[mk] != null ? shownAt[mk] : firstSeen[mk];
            if (last == null) return 1;
            var since = now - last;
            if (since <= 0) return 1;
            return 1 + COVERAGE_LIFT * Math.min(1, since / COVERAGE_MS);
        }
        function score(ev, now) {
            if (ev.superseded) return 0;
            return ev.interest * freshness(ev, now) * novelty(ev, now) * coverage(ev, now);
        }

        // Rank everything showable, best first. The scheduler's working, exposed
        // because the inspector slide renders exactly this — the point is to be able
        // to see WHY one event beat another, not just which won.
        /* AN EVENT THAT FOLLOWS ANOTHER WAITS FOR IT. `after` names the event this one
         * is the consequence of — the swing an expected ladder move comes from, the
         * result an actual one comes from — and while that event is still in the
         * running and has not yet been on screen, this one scores nothing. It is
         * released the moment its predecessor has been shown, retired, or has decayed
         * below the floor, so a predecessor that never makes the band cannot hold its
         * consequence back for ever. */
        function waiting(ev, now) {
            var pre = ev.after ? byId[ev.after] : null;
            if (!pre || pre.superseded || pre.shown_count > 0) return false;
            return pre.interest * freshness(pre, now) * novelty(pre, now) *
                   coverage(pre, now) >= SHOW_FLOOR;
        }
        function ranked(now) {
            return events.map(function (ev) {
                var f = freshness(ev, now), n = novelty(ev, now), c = coverage(ev, now);
                var held = waiting(ev, now);
                return { ev: ev, freshness: f, novelty: n, coverage: c,
                         superseded: !!ev.superseded, waiting: held,
                         score: (ev.superseded || held) ? 0 : ev.interest * f * n * c };
            }).sort(function (a, b) {
                return b.score - a.score || b.ev.received_at - a.ev.received_at;
            });
        }

        /* The ranking as a surface should show it — which is now simply the
         * ranking. It used to substitute the numbers the showing event WON with,
         * because being picked stamped `shown_at` and zeroed its novelty, so the one
         * row you most wanted to understand read as a flat zero. Novelty no longer
         * touches the event on screen, so its live figures are both honest and the
         * interesting thing to watch: you can see a pick decaying towards the floor
         * and know when it is about to lose the band. */
        function rankedForDisplay(now) { return ranked(now); }
        function rowFor(ev, now) {
            if (!ev) return null;
            var f = freshness(ev, now), n = novelty(ev, now), c = coverage(ev, now);
            return { score: ev.superseded ? 0 : ev.interest * f * n * c,
                     freshness: f, novelty: n, coverage: c };
        }

        /* THE ONE QUESTION: what should be on screen?
         *
         * AN EVENT HOLDS THE SCREEN BY STILL DESERVING IT, not by a clock of its own.
         * It is put up because it is the best thing above the floor, and it stays up
         * until either its own freshness decays it below the floor or something
         * outscores it. There is no separate duration to tune, which is the point:
         * how long a wicket sits there is a consequence of what a wicket is worth and
         * how long it stays news, and both of those are already in the type table.
         * Wanting a score to hold for three minutes is therefore a statement about
         * its `base` and its `ttl`, made in the one place all the other such
         * statements are made.
         *
         * This replaces an explicit per-event `dwell`, which existed for a reason
         * that has gone: picking an event used to stamp `shown_at` and zero its
         * novelty, so without a hold it would have lost the screen on the very next
         * tick. Novelty now leaves the current event alone, so the hold falls out of
         * the scoring for free.
         *
         * TWO THINGS STILL OVERRIDE THE SCORE, and both are about honesty rather than
         * presentation:
         *
         *  - FOOTAGE RUNS TO ITS END. A clip is not a caption that can be swapped
         *    mid-sentence; the slideshow has given way to it and cutting it off
         *    mid-wicket because a six landed elsewhere is worse than being a few
         *    seconds late to the six.
         *  - A MINIMUM SHOW TIME, so nothing appears for an instant. Decisions are
         *    taken when a poll brings new information, and two feeds on different
         *    cadences can land a second apart; without a floor on how briefly
         *    something can be up, the band would blink.
         *
         * And one thing cuts a pick short: SUPERSESSION. A hold protects an event,
         * never a falsehood — once a newer snapshot has made this one wrong, keeping
         * it up is keeping a wrong score on the wall on purpose.
         *
         * ASKED EVERY TICK, not only when a poll brings something in. The store's
         * membership only changes on an ingest, but the SCORES do not: freshness
         * decays continuously, so the answer can change with no new data at all —
         * the pick can fall below the floor, two events with different ttls can swap
         * as they decay at different rates, and a repeat window expiring can make
         * something eligible again. Asking only on ingest would leave an event on
         * screen after it had stopped being worth one, for as long as a poll
         * interval: fifteen seconds in play, thirty while a result settles, two
         * minutes on an idle feed.
         *
         * IT CANNOT FLAP, which is what made the gate look necessary. An event that
         * loses the band is stamped `shown_at` there and then, which drops its
         * novelty to zero for its whole repeat window — so whatever displaced it
         * cannot be displaced straight back by it. The minimum show time covers the
         * rest.
         */
        function leave(now) {
            if (current) {
                current.shown_at = now;               // the repeat window starts here
                // …and this match has now had its turn, whatever the event was: the
                // coverage rule is about the MATCH being mentioned, not about a score
                // being the thing that mentioned it. A wicket satisfies it too.
                var mk = current.match && current.match.key;
                if (mk) shownAt[mk] = now;
            }
            current = null; clipUntil = 0; shownSince = 0;
        }
        function answer(now, reason, rows) {
            return { event: current, until: clipUntil || 0, holding: !!current,
                     picked: rowFor(current, now), ranked: rows || rankedForDisplay(now),
                     reason: reason };
        }
        /* HOW MUCH THE BAND IS THE INCUMBENT'S BY RIGHT, as it goes on holding it.
         * Halves every SHARE_MS of screen time. It is applied ONLY when comparing the
         * event on screen against the alternatives, never to the floor test — so an
         * event with no rival keeps the band until it genuinely stops being worth one,
         * while a queue of comparable events takes turns.
         *
         * Without it the freshest event squats. Everything waiting is by definition
         * older and so less fresh, which means it can never outscore the incumbent and
         * only gets the band when the incumbent falls through the floor — a division's
         * eight matches all starting at one o'clock would announce the last of them
         * and then sit on it for seven minutes. */
        var SHARE_MS = 18000;

        function tick(now) {
            now = now == null ? Date.now() : now;
            if (current && current.superseded) leave(now);
            // Footage, and then the floor on how briefly anything may be up.
            if (current && clipUntil && now < clipUntil) return answer(now, 'footage running');
            if (current && now - shownSince < MIN_SHOW_MS) return answer(now, 'minimum show time');

            var rows = ranked(now);
            var best = rows[0];
            if (!best || best.score < SHOW_FLOOR) {
                leave(now);
                // The honest empty answer: nothing out there is worth a screen, so
                // the chrome collapses rather than recycling.
                return { event: null, until: 0, holding: false, picked: null, ranked: rows,
                         reason: rows.length ? 'nothing above the floor' : 'no events' };
            }
            if (current) {
                /* The incumbent keeps the band unless a challenger beats its
                 * time-discounted standing — and drops it outright if its own raw
                 * score has fallen through the floor, which is the test above applied
                 * to itself rather than to the best of the field. */
                var mine = rowFor(current, now);
                if (mine && mine.score >= SHOW_FLOOR) {
                    var share = Math.pow(0.5, (now - shownSince) / SHARE_MS);
                    /* THE CHALLENGER MUST CLEAR THE FLOOR TOO, and this is the only
                     * place the floor was not being applied. The test above is made
                     * against `rows[0]`, which is frequently the INCUMBENT — so all
                     * it establishes is that the band is worth holding at all, not
                     * that the next in line deserves it.
                     *
                     * Left unchecked the time-share discount eventually hands the band
                     * to anything at all: `share` halves every SHARE_MS, so after a
                     * minute or two the incumbent's discounted standing is worth less
                     * than a league score update at 4.9, and a below-floor snapshot
                     * takes a screen the floor exists to deny it. The discount is
                     * meant to pass the band around a queue of COMPARABLE events, not
                     * to lower the bar to let filler in.
                     *
                     * So the scan skips anything under the floor. With no eligible
                     * rival the incumbent simply holds, and it still loses the band
                     * the moment its own raw score falls through — the test above,
                     * applied to itself — which is what makes the chrome collapse
                     * rather than reach for the next thing down. */
                    var rival = null;
                    for (var i = 0; i < rows.length; i++) {
                        if (rows[i].ev !== current && rows[i].score >= SHOW_FLOOR) {
                            rival = rows[i]; break;
                        }
                    }
                    if (!rival || rival.score <= mine.score * share) {
                        return answer(now, 'still the best', rows);
                    }
                    best = rival;
                }
            }
            leave(now);
            current = best.ev;
            shownSince = now;
            current.shown_count++;
            clipUntil = current.clip ? now + clipHoldMs(current) : 0;
            return answer(now, current.shown_count > 1 ? 'again (nothing newer)' : 'best ranked',
                          ranked(now));
        }

        return {
            add: add, tick: tick, ranked: ranked, rankedForDisplay: rankedForDisplay, score: score,
            freshness: freshness, novelty: novelty, coverage: coverage,
            all: function () { return events.slice(); },
            get: function (id) { return byId[id] || null; },
            current: function () { return current; },
            size: function () { return events.length; },
            // Test/inspector seam: drop everything and start the day again.
            reset: function () { events = []; byId = {}; current = null; shownSince = 0; clipUntil = 0; }
        };
    }

    // ---- extraction: our matches (the rich RV feed) -------------------------
    // Diff two consecutive `wcc-live` polls into events. `prev` null (the first poll
    // of the session) yields NO change events: everything in that poll already
    // happened before we were watching, and announcing a morning's wickets at once
    // is the bug this guards against. Standing facts that are still news — the toss,
    // a result already posted — are emitted, because those are states, not changes.
    function extractLive(prev, next, now, cfg) {
        cfg = cfg || {};
        var out = [];
        var prevById = index(prev, 'pc_id');
        (next && next.matches || []).forEach(function (m) {
            var p = prevById[String(m.pc_id)];
            var ctx = matchCtx(m, cfg, true);
            // The bracket: RV stamps each match with the scorer's own last sync, so
            // the window is the scorer's, not our poll timer's — much tighter, and
            // right even when a poll is late. No cursor on either side leaves the
            // event unbracketed rather than guessing our own clock at it.
            var from = p ? (secs(p.scores_updated) || p._received_at || null) : null;
            var to = secs(m.scores_updated) || now;
            var when = [from, to];
            var push = function (type, id, payload, extra) {
                out.push(event(type, ctx.key + ':' + id, ctx, when, now, payload, extra));
            };

            /* SPELLS ARE TRACKED BEFORE ANYTHING IS DECIDED, and on every poll —
             * including the first one, where the moves are thrown away. The map is
             * the memory the next poll diffs against, so a poll that skipped it
             * would lose a bowler's place in his spell and report the wrong figures
             * when it ended. It rides on the card, exactly as `_received_at` does. */
            var spell = trackSpells(p ? p._spells : null, m);
            m._spells = spell.map;
            // The over log rides on the card the same way, and for the same reason:
            // the passage clause is a subtraction against where the innings stood
            // several overs ago, which is memory no single poll holds.
            carryDerived(p, m);

            if (!p) {
                // First sighting. The toss is a standing fact worth announcing (it
                // frames everything after it); a match already decided when we
                // joined is the answer to "what happened?" and belongs on screen.
                if (m.toss && m.toss.text) push('toss', 'toss', tossPayload(m, ctx));
                if (m.complete) push(abandonedCard(m) ? 'abandoned' : 'match_finished', 'result',
                    abandonedCard(m) ? abandonedPayload(m, ctx)
                        : finishedPayload(m, ctx, m.final ? '' : 'result to be confirmed'));
                return;
            }
            // A LATER START is not a first sighting. A match that begins at three
            // o'clock has been in the feed since breakfast as a fixture with no toss
            // and no innings, so its toss arrives on an ordinary poll — the `!p`
            // branch above would never see it, and the event would be lost for every
            // match but the first of the day.
            if (m.toss && m.toss.text && !(p.toss && p.toss.text)) {
                push('toss', 'toss', tossPayload(m, ctx));
            }

            /* --- THE STREAM COMING ONLINE. Detected as a transition, like the toss:
             * a card with no stream marker last poll and one now.
             *
             * WHICH MARKER, in order of how much it actually proves. RV's stream object
             * carries `recording_started_utc`, and probing a real streamed match shows
             * it is ABSENT until the stream comes online and appears when it does —
             * which is exactly the moment we want and the only field that means it
             * outright (see the anchor retry loop in scripts/probe_live.py). A video id
             * is the next best: it may be minted with a scheduled broadcast, but on a
             * card that had none it is still new. And FOOTAGE PROVES A STREAM without
             * naming it — a clip cannot exist without a camera — which is the backstop
             * for a normalisation that passes neither field through.
             *
             * A CARD THAT CARRIES ITS STREAM ALL DAY YIELDS NOTHING, and that is the
             * honest failure: there is no transition to find, so nothing is announced,
             * rather than a stream being announced at whatever time we happened to
             * start polling. Same rule `match_started` follows.
             *
             * Worth confirming against a real streamed fixture with
             * `scripts/probe_live.py <pc_id> --raw` when one next comes round: the
             * Worker's normalisation is what decides which of the three we get, and
             * that is not visible from this repo. */
            if (streamOf(m) && !streamOf(p)) {
                push('stream_started', 'stream', streamPayload(m, ctx, cfg));
            }

            var pi = p.innings || [], mi = m.innings || [];

            // A new innings in the list means the previous one closed — and in a
            // two-innings game that is the moment a target exists, which is the most
            // useful thing the surface can say all afternoon.
            var closedNow = false;    // see the score line at the foot of the innings loop
            if (mi.length > pi.length && pi.length) {
                var closed = mi[pi.length - 1] || pi[pi.length - 1];
                closedNow = true;
                push('innings_closed', 'inn' + pi.length + 'close', closedPayload(m, ctx, closed));
            }

            mi.forEach(function (inn, ii) {
                var pinn = matchInnings(pi, inn, ii);
                /* AN INNINGS' FIRST POLL IS NOT A BLANK. `matchInnings` has nothing to
                 * pair a brand-new innings with, and "no previous innings, so skip the
                 * lot" threw away everything that happened in it up to that moment —
                 * which on our own matches is the whole of the first over. A wicket in
                 * over one simply never existed, and the first thing the band said
                 * about the match was "Wendover 10/1 (2 ov)", announcing a wicket it
                 * had never reported.
                 *
                 * The match being new is a different thing from an innings being new,
                 * and only the first is a reason for silence. A match we have never
                 * polled is handled far above by the `!p` branch, which is what stops a
                 * device joining at four o'clock reciting the afternoon. By the time we
                 * are in here we have been watching, so an innings appearing is news
                 * that happened on our watch: it is diffed against an empty innings,
                 * exactly as though we had seen it start at 0/0.
                 *
                 * WITH ONE GUARD. A scorer can publish an innings late and hand us a
                 * card that is already deep into it, and enumerating a collapse the
                 * room never saw is not news, it is a recital. Past a few wickets we
                 * stay quiet and let the next over's score line speak for it. Only the
                 * wickets and the score line are at stake either way: the boundary and
                 * milestone rules already require a batter we saw before, so they
                 * cannot fire off an empty previous card. */
                // Whether this innings was in the PREVIOUS card at all, captured before
                // the synthesis below replaces the answer. The team milestone needs it:
                // a crossing is a transition, and an innings we are seeing for the
                // first time crossed all of its marks before we were watching.
                var watched = !!pinn;
                if (!pinn) {
                    if ((inn.wickets || 0) > NEW_INNINGS_MAX_WICKETS) return;
                    pinn = { runs: 0, wickets: 0, overs: '0', batters: [], bowling: [],
                             at_crease: [], fall: [], last_wicket: null };
                }
                var side = inn.club || inn.side || '';
                // Who is batting and who is waiting — once per innings, because every
                // scoreline this block writes names the same two sides.
                var sides = sidesOf(m, ctx, inn);
                /* HOW FAR THE INNINGS MOVED IN THIS POLL, read once at the top because
                 * three things below need it: the floor's over boundary, the over log,
                 * and — the reason it moved up here from the floor — whether a wicket
                 * was watched closely enough to say WHEN it fell. */
                var ob = balls(inn.overs), pb = balls(pinn.overs);
                /* HAS THIS POLL ALREADY STATED THE SCORE? A wicket, a four and a six
                 * all now lead with the scoreline, so when one of them lands on an
                 * over boundary the floor's own line is the same sentence twice — and
                 * the second one is the weaker of the two, because the incident says
                 * what happened and the floor says only where they are. The floor
                 * exists to fill SILENCE; an over that produced a wicket was not
                 * silent. See the score line at the foot of this block. */
                var saidScore = false;

                // --- wickets. A poll can span more than one, and only the last is
                // described in the feed — so say that one and count the rest, rather
                // than inventing detail for wickets we cannot see.
                /* EVERY WICKET IS ITS OWN EVENT, and a poll that brings three of
                 * them queues three.
                 *
                 * This used to be one event with "(+2 more this over)" hung off it,
                 * which was wrong twice. It is not an OVER — it is the gap between two
                 * polls, and under a scorer syncing in lumps that gap is twenty
                 * minutes and can span half an innings. And it threw away two
                 * dismissals to describe a third: the card carries a row per batter
                 * (RV's PlayerPerfs), so who fell, how, and for how many is known for
                 * every one of them, not just the last.
                 *
                 * SEQUENCING IS NOT NEW WORK. Separate events for the same match are
                 * exactly what the scheduler already handles — equal interest, equal
                 * freshness, and the incumbent's time-share discount hands the band on
                 * after a few seconds, which is how a division's eight tosses take
                 * turns. Wickets are incidents so they never retire each other, and
                 * pushing them in fall order makes the ranking's tie-break — insertion
                 * order, since same-poll events share a `received_at` — show them in
                 * the order they actually fell.
                 *
                 * THE SCORE EACH ONE LEFT comes from that batter's own fall-of-wicket
                 * figure, so a backfilled wicket states the score at the time rather
                 * than the score now. Only the LATEST wicket takes the card's current
                 * scoreline and its over number: the over is the one thing the fall
                 * figure does not carry, and for the newest wicket the card's own
                 * reading is a few balls old at most. Earlier ones go without an over
                 * rather than borrowing one that belongs to a later ball.
                 *
                 * If the rows cannot be reconciled with the wicket count — a feed that
                 * does not carry them, a name that changed spelling between polls — it
                 * falls back to one event for the batch, which is the old behaviour
                 * minus the sentence about overs. */
                /* THE SCORELINE LEADS, as it does on a four and a score. A wicket is
                 * read first as a position — 13/3 — and only then as a person, and the
                 * two halves used to be the wrong way round: the name was in the
                 * headline and the thing a glance across a room actually wants was in
                 * the muted clause behind it. The clause is the dismissal in one
                 * sentence: who, how, for how many, and who got him with what figures. */
                var dw = (inn.wickets || 0) - (pinn.wickets || 0);
                /* WHERE THE LATEST WICKET FELL, stamped before anything is said about
                 * it. `wide` is the poll's own honesty: more than two overs of cricket
                 * in one reading and the over count on this card is not where the
                 * wicket fell, so the stand it started will be stated without a
                 * length. See logFall. */
                if (dw > 0) logFall(m, ii, inn.wickets || 0, ob, ob - pb > 12, inn);
                var fell = dw > 0 ? newDismissals(pinn, inn) : [];
                if (dw > 0 && fell.length === dw) {
                    fell.forEach(function (d, di) {
                        /* Only the LATEST wicket takes the card's current scoreline and
                         * its over number. The over is the one thing a fall-of-wicket
                         * figure does not carry, and for the newest wicket the card's
                         * own reading is a few balls old at most; an earlier one goes
                         * without an over rather than borrowing one that belongs to a
                         * later ball. */
                        var at = di === fell.length - 1
                            ? { runs: inn.runs, wickets: inn.wickets, overs: inn.overs }
                            : { runs: d.fow, wickets: d.order };
                        var dlast = di === fell.length - 1;
                        push('wicket', 'i' + ii + 'w' + d.order,
                            /* EVERY WICKET THE SAME SHAPE. A backfilled one used to
                             * carry the score it left, on the argument that it
                             * describes a position the strip is no longer showing —
                             * but it read as a different KIND of line a minute after
                             * the last one, which is worse than a missing figure.
                             * > James's direction, 2026-09-29. */
                            say(wicketParts(d, inn, sides, ctx, dlast, standEnded(d, inn, dlast)),
                                { who: d.name, fielder: d.fielder || null }),
                            { tension: ctx.tension });
                        saidScore = true;
                    });
                } else if (dw > 0) {
                    // The rows could not be reconciled with the wicket count — a feed
                    // without them, or a name that changed spelling between polls. One
                    // event for the batch, saying honestly what it cannot separate.
                    var w = inn.last_wicket;
                    var also = dw > 1 ? ' (+' + (dw - 1) + ' more since the last update)' : '';
                    push('wicket', 'i' + ii + 'w' + inn.wickets,
                        say(wicketParts(w, inn, sides, ctx, true, null, also),
                            { who: w && w.name || '', fielder: w && w.fielder || null }),
                        { tension: ctx.tension });
                    saidScore = true;
                }

                /* --- NINE DOWN, AND THE LAST PAIR TOGETHER. Placed with the other
                 * consequences of a wicket, and tested as a STATE rather than as the
                 * ninth wicket falling: on that poll the man coming in has faced
                 * nothing, so there is no pair to name yet. `creasePair` requires both
                 * of them to have faced something — the same rule `new_batsman` uses,
                 * and the right one here too, since a pair is together once both are
                 * batting. `onceOnly` is what turns a standing state into one sentence.
                 *
                 * Nine wickets is the last pair only if there IS a pair: a side batting
                 * a man short is all out at nine, and requiring two men at the crease is
                 * what tells the difference without having to know the squad size. */
                var pairSaid = {};
                if ((inn.wickets || 0) === 9 && !inn.closed && !m.complete) {
                    var lastTwo = creasePair(inn);
                    if (lastTwo.length === 2 && onceOnly(m, ii, 'last_pair')) {
                        push('last_pair', 'i' + ii + 'last',
                             lastPairPayload(lastTwo, inn, mi, sides, ctx),
                             { ours: isOurPlayer(ctx, sides.bat), tension: ctx.tension });
                        /* AND THE ARRIVAL BELOW STANDS DOWN FOR THESE TWO. The last-pair
                         * line names the incoming man and what he has, so "K Eleven to the
                         * crease" a line later is the same moment said twice — and the
                         * smaller half of it, since the pair line says what the arrival
                         * MEANS. Suppressed at emission rather than by retirement because
                         * the arrival is pushed after this and a retirement only reaches
                         * events already in the store. */
                        lastTwo.forEach(function (b) { pairSaid[b.name] = true; });
                    }
                }

                // --- milestones, per batter, by name. `batters` is the full card, so
                // this catches a fifty reached by someone already dismissed by the
                // time we polled.
                var pbat = byName(pinn.batters);
                // Whose milestone this poll already carried. The stand below reads it:
                // one passage of play should not be announced twice.
                var milestoned = {};
                (inn.batters || []).forEach(function (b) {
                    var was = pbat[b.name];
                    if (!was) return;
                    [[100, 'hundred'], [50, 'fifty']].forEach(function (pair) {
                        var mark = pair[0], type = pair[1];
                        if ((was.runs || 0) < mark && (b.runs || 0) >= mark) {
                            /* WHOSE MILESTONE decides both how much is said and how
                             * much it is worth. The match being ours does not make the
                             * batter ours — their opener reaching fifty against us is
                             * the same diff — so the club test goes through to the
                             * interest as well, where it takes the ordinary
                             * other-club discount. Their hundred still outranks our
                             * fifty; our fifty outranks theirs. */
                            var mine = isOurPlayer(ctx, sides.bat);
                            milestoned[b.name] = true;
                            push(type, 'i' + ii + mark + b.name,
                                 milestonePayload(b, mark, inn, sides, ctx, mine), { ours: mine });
                        }
                    });
                    /* --- AND CLOSING IN ON ONE. Same loop, same `was` guard: a batter we
                     * are meeting for the first time entered the forties before we were
                     * watching, and the approach is a transition like every other.
                     *
                     * The higher mark is tested first, so a batter who arrives in the
                     * nineties from the eighties is closing in on a hundred and not on a
                     * fifty he passed an hour ago.
                     *
                     * `< mark` is what keeps this out of the milestone's way: a blow that
                     * takes him from 44 to 52 crossed the window and the mark in one, and
                     * the `fifty` above has already said the only thing worth saying. */
                    if (!isOut(b)) {
                        APPROACH_MARKS.some(function (mark) {
                            var lo = mark - APPROACH_WINDOW;
                            if ((was.runs || 0) >= lo) return false;
                            if ((b.runs || 0) < lo || (b.runs || 0) >= mark) return false;
                            var near = isOurPlayer(ctx, sides.bat);
                            push('approaching', 'i' + ii + 'near' + mark + b.name,
                                 approachPayload(b, mark, inn, sides, ctx),
                                 { ours: near, magnitude: approachMagnitude(mark) });
                            return true;
                        });
                    }
                });

                /* --- A BATTER ARRIVING. Detected on his FIRST BALL FACED, not on
                 * his appearing in the card: RV lists the whole squad with a
                 * `number` of 99 until they bat, and the worker's normalisation of
                 * that is not something the band should be reading tea leaves from.
                 * A runs/balls counter moving off zero is unambiguous on any shape of
                 * card, and it is the same kind of claim the boundaries make — a
                 * difference between two stated numbers.
                 *
                 * It also puts the sentence in a better place. The arrival fires a
                 * poll or two after the dismissal that caused it rather than in the
                 * same breath, so the band says the wicket, then says who walked out
                 * to face the next one — which is the order the ground saw it in.
                 *
                 * THE OPENERS ARE NOT AN ARRIVAL. At 0/0 nobody has come IN; they
                 * have started, and the toss and the first score line have that
                 * covered. So it takes a wicket to have fallen, which is also what
                 * makes the line worth reading: a batter is only news when the
                 * situation he walks into is.
                 *
                 * And not off a synthesised innings either. The empty previous card
                 * that `!pinn` builds makes every batter look brand new, so a late
                 * publishing scorer would announce both not-out batters as arrivals
                 * — the same recital the wicket guard above exists to prevent. */
                if ((pinn.batters || []).length && (inn.wickets || 0) >= 1) {
                    (inn.batters || []).forEach(function (b) {
                        if (!b || !b.name || isOut(b) || !(b.runs || b.balls)) return;
                        if (pairSaid[b.name]) return;       // the last pair said it
                        var before = pbat[b.name];
                        if (before && (before.runs || before.balls)) return;
                        var mine = isOurPlayer(ctx, sides.bat);
                        push('new_batsman', 'i' + ii + 'in' + b.name,
                             arrivalPayload(b, inn, sides, ctx, mine),
                             { ours: mine, tension: ctx.tension });
                    });
                }

                /* --- A STAND REACHING A MARK. Sits after the personal milestones
                 * because that is the order of the claim: a man's fifty is the bigger
                 * half of the same passage of play, and same-poll events are shown in
                 * insertion order.
                 *
                 * NOT IN THE SAME POLL AS A WICKET. The stand is measured from the
                 * last fall, so a poll that brought a wicket is comparing two
                 * different pairs' stands and the crossing would be an artefact of
                 * the arithmetic rather than something that happened. Wickets
                 * unchanged is the whole test.
                 *
                 * AND NOT OFF A SYNTHESISED PREVIOUS CARD either — the empty one the
                 * `!pinn` branch builds makes any stand look like it was just built,
                 * so a late-publishing scorer would announce a fifty partnership put
                 * together before we were watching. The same guard the arrival and the
                 * boundary rules use: we must have seen this innings before.
                 *
                 * ONE MARK PER POLL. A gap wide enough to cross both is wide enough
                 * that only the bigger one is worth saying. */
                var standNow = partnershipRuns(inn), standWas = partnershipRuns(pinn);
                if (standNow != null && standWas != null && (pinn.batters || []).length &&
                    (inn.wickets || 0) === (pinn.wickets || 0)) {
                    var spair = creasePair(inn);
                    /* NOT IN THE SAME BREATH AS A PERSONAL MILESTONE — but only when
                     * it really is the same fact. A stand of 54 with fifty of them to
                     * one man IS his fifty, and his is the bigger claim of the two,
                     * being the one a scorecard keeps. A man who reaches fifty across
                     * three partnerships on the same poll as this pair reach theirs is
                     * a coincidence of arithmetic, and suppressing that would lose a
                     * real event to an accident — which is what a first cut of this
                     * rule did, on both test innings.
                     *
                     * So the test is his SHARE of this stand, and it is only applied
                     * when we can prove it. `standShare` is null when the fall log
                     * cannot answer, and an unproven share suppresses nothing. */
                    /* THE HIGHEST MARK CROSSED, and only that one. A poll wide enough
                     * to take a stand from 40 to 105 is wide enough that "fifty
                     * together" would be a wrong number the moment it went up. */
                    var smark = spair.length
                        ? Math.floor(standNow / STAND_MARK) * STAND_MARK : 0;
                    if (smark && standWas < smark) {
                        var hogged = spair.some(function (b) {
                            var sh = milestoned[b.name] ? standShare(m, ii, inn, b) : null;
                            return sh != null && sh >= smark;
                        });
                        if (!hogged) {
                            var smine = isOurPlayer(ctx, sides.bat);
                            push('stand', 'i' + ii + 'st' + (inn.wickets || 0) + '_' + smark,
                                 standPayload(spair, standNow, standBalls(m, ii, inn, ob),
                                              inn, sides, ctx),
                                 { ours: smine, tension: ctx.tension,
                                   magnitude: standMarkMagnitude(smark) });
                        }
                    }
                }

                // --- a bowler's fifth
                var pbowl = byName(pinn.bowling);
                (inn.bowling || []).forEach(function (bw) {
                    var was = pbowl[bw.name];
                    if (was && (was.wickets || 0) < 5 && (bw.wickets || 0) >= 5) {
                        // The bowler's side is the one NOT batting, which `sidesOf`
                        // already resolved for the scoreline above.
                        var his = isOurPlayer(ctx, sides.other);
                        push('five_for', 'i' + ii + '5w' + bw.name,
                             fiveForPayload(bw, inn, sides, ctx, his), { ours: his });
                    }
                });

                /* --- A TEAM TOTAL PASSING A HUNDRED. Above the passage family and the
                 * floor because it is a plainer fact than either: a number went past a
                 * round number, which needs no window and no baseline.
                 *
                 * Deliberately NOT gated on a whole over. It is the crossing that is the
                 * news and the ball it happened on is the one the ground cheered, so a
                 * poll mid-over says it then rather than waiting for the over to end.
                 *
                 * `watched` is the guard every transition here needs: an innings we had
                 * not seen before this poll crossed its marks off-screen, and a card
                 * published late would otherwise recite them. */
                if (watched && !inn.closed && !m.complete) {
                    var mark = teamMarkCrossed(pinn, inn, mi);
                    if (mark) {
                        var mmine = isOurPlayer(ctx, sides.bat);
                        push('team_total', 'i' + ii + 'team' + mark,
                             teamMarkPayload(mark, inn, sides, mmine, atHome(sides, m, ctx), mi, ctx),
                             { ours: mmine,
                               /* A HUNDRED IS ROUTINE AND THREE HUNDRED IS A MONSTER, and
                                * one type covers both — so the mark itself is the
                                * magnitude. 100 lands near a match starting, 200 and up
                                * just under an individual fifty, and the tier cap stops
                                * any total climbing past one. */
                               magnitude: teamMarkMagnitude(mark) });
                    }
                }

                /* --- THE PASSAGE OF PLAY, when it has changed character. Last of
                 * the real events and directly above the floor, which is also where it
                 * belongs in the reading: it is the floor's own arithmetic promoted to
                 * news when it crosses a threshold.
                 *
                 * WHICH IS WHY IT STANDS THE FLOOR DOWN. The score line's clause is
                 * the passage clause — the same subtraction over the same overs — so an
                 * over that produced a charge would say "44 in the last 4 overs" twice
                 * from one poll, the second time with the duller half of it. Same rule
                 * the wicket already follows, and the same reason.
                 *
                 * Only on a whole over, like the floor: the window is measured in overs
                 * and a mid-over reading would compare part of one with the whole of
                 * another. */
                if (ob > pb && ob % 6 === 0 && !m.complete) {
                    var sg = surgeAt(m, ii, inn, ob);
                    if (sg && surgeFresh(m, ii, sg.face, ob, sg.balls)) {
                        var sgmine = isOurPlayer(ctx, sides.bat);
                        push(sg.face, 'i' + ii + sg.face + ob,
                             surgePayload(sg, inn, sides, sgmine, ctx, mi),
                             { tension: ctx.tension });
                        saidScore = true;
                    }
                }

                /* --- the floor. Not news and not pretending to be: it is what keeps
                 * a screen truthful when nothing has happened for ten overs, and its
                 * interest is low enough that any real event outranks it.
                 *
                 * ONE SNAPSHOT A TYPE, AND ONE AN OVER. There used to be a second,
                 * heavier one every fifth over (`innings_update`), whose whole purpose
                 * was to make sure a match got a score on screen from time to time —
                 * a coverage rule expressed as a type weight. It bought that badly:
                 * it never fired for the division at all, it lifted a match that had
                 * just been on screen exactly as much as one unshown for twenty
                 * overs, and counting in overs meant rain or a slow over rate
                 * suspended the guarantee precisely when it mattered. The rule is now
                 * stated where it belongs, as `coverage` in the scheduler. */
                /* THE OVER LOG IS KEPT WHETHER OR NOT A LINE GOES OUT, because it is
                 * not a record of what we SAID, it is a record of where the innings
                 * stood at each whole over — which is what the passage clause
                 * subtracts. Logging it inside the `!saidScore` gate would mean an
                 * over that produced a wicket left no anchor behind it, and the next
                 * five overs would be measured from the wrong ball. */
                if (ob > pb && ob % 6 === 0) logOver(m, ii, ob, inn);
                /* NOT ONCE THE MATCH IS OVER, which is the same rule the division's
                 * scoreline follows above: a card that keeps being corrected after the
                 * close would put a live-sounding line on the band beside a strip
                 * showing FINAL. The incidents above are guarded by their own
                 * freshness tests; these two describe an afternoon in progress. */
                /* AND NOT IN THE POLL AN INNINGS CLOSED. The closing line carries the
                 * score that matters, and a score line about the new innings retires
                 * it (see RETIRES) — in the same poll, so it was struck before it had
                 * ever been on screen. */
                if (ob > pb && ob % 6 === 0 && !saidScore && !m.complete && !closedNow) {
                    push('score_update', 'i' + ii + 'ov' + (ob / 6),
                         scorePayload(m, ctx, sides, inn, ii, ob,
                                      sinceLastPoll(pinn, inn, ob, pb), mi));
                }
            });

            /* --- SPELLS. Emitted after the innings loop rather than inside it
             * because the tracker walks the whole card in one pass — a spell is a
             * fact about a bowler across polls, not about the diff of one innings.
             * The innings and the sides are recovered from the move's own index. */
            spell.moves.forEach(function (mv) {
                var sinn = mi[mv.ii];
                if (!sinn) return;
                var ssides = sidesOf(m, ctx, sinn);
                // A bowler belongs to the side that is NOT batting.
                var his = isOurPlayer(ctx, ssides.other);
                if (mv.kind === 'start') {
                    push('spell_started', 'i' + mv.ii + 'spell' + mv.name + mv.now.balls,
                         spellStartPayload(mv, sinn, ssides, ctx, his), { ours: his });
                    return;
                }
                var end = spellEndPayload(mv, sinn, ssides, ctx, his);
                /* A SPELL IS THREE OVERS OR IT IS NOT A SPELL. Two is a look, and a
                 * band that announced every bowler who had a look would be reporting
                 * the over rate. The floor is on the SPELL's own overs, so a bowler
                 * returning for one more over and being taken off again does not get
                 * a line off the back of the six he bowled an hour ago. */
                if (end.overs < 3) return;
                push('spell_ended', 'i' + mv.ii + 'spellend' + mv.name + mv.now.balls,
                     end.payload, { ours: his, magnitude: end.magnitude });
            });

            /* --- THREE IN THREE, and the ball before it. Out of the same tracker and
             * for the same reason: a hat-trick is a fact about one bowler's deliveries
             * across polls, which is not something the diff of a single innings can see.
             *
             * The `miss` strike is the RETRACTION — the hat-trick ball was bowled and
             * did not take a wicket, so the sentence the band may still be holding has
             * stopped being true. It carries no payload worth reading and never reaches
             * a screen; `retire_only` is the whole point of it. */
            spell.strikes.forEach(function (mv) {
                var sinn = mi[mv.ii];
                if (mv.kind === 'miss') {
                    push('retraction', 'i' + mv.ii + 'nohat' + mv.name,
                         say([]), { retires: ['on_a_hat_trick'], retire_only: true });
                    return;
                }
                if (!sinn) return;
                var ssides = sidesOf(m, ctx, sinn);
                var his = isOurPlayer(ctx, ssides.other);
                /* A MAIDEN, AND THE TWO THINGS THAT MAKE ONE WORTH SAYING. Ranked, not
                 * both: a wicket maiden that completes three in a row is one over and
                 * gets one line, and the run is the bigger half of it — so its payload
                 * carries the wicket too. A lone wicketless maiden says nothing at all,
                 * which is the right answer in a league where most bowlers manage one. */
                if (mv.kind === 'maiden') {
                    if (mv.run >= MAIDEN_RUN_NEWS) {
                        push('maiden_run', 'i' + mv.ii + 'mdn' + mv.name + mv.now.balls,
                             maidenRunPayload(mv, sinn, ssides, ctx), { ours: his });
                    } else if (mv.wkts >= 1) {
                        push('wicket_maiden', 'i' + mv.ii + 'wm' + mv.name + mv.now.balls,
                             wicketMaidenPayload(mv, sinn, pi[mv.ii], ssides, ctx),
                             { ours: his, magnitude: Math.min(1, mv.wkts * 0.4) });
                    }
                    return;
                }
                if (mv.kind === 'hat') {
                    push('hat_trick', 'i' + mv.ii + 'hat' + mv.name + mv.now.balls,
                         hatTrickPayload(mv, sinn, pi[mv.ii], ssides, ctx), { ours: his });
                    return;
                }
                push('on_a_hat_trick', 'i' + mv.ii + 'two' + mv.name + mv.now.balls,
                     onAHatTrickPayload(mv, sinn, ssides, ctx),
                     { ours: his, tension: ctx.tension });
            });

            // --- a swing worth remarking on: the chase crossing into a new band.
            // See `swingCheck` — after the innings loop on purpose, so the passage
            // log it quotes already holds this poll.
            var sw = swingCheck(m, ctx, now);
            if (sw) push('probability_shift', sw.id, sw.payload, { magnitude: sw.magnitude });

            /* --- breaks, and the two ways an afternoon ends.
             *
             * The sides are read off the innings in play, because the break line names
             * the opposition like every other line — and a match in a break still has
             * an innings, it is simply not moving. */
            var bsides = mi.length ? sidesOf(m, ctx, mi[mi.length - 1]) : { bat: '', other: '' };
            if (m.break_desc && m.break_desc !== p.break_desc) {
                var rain = /rain|weather|wet|shower/i.test(m.break_desc);
                m._break_since = now;
                push(rain ? 'rain_break' : 'match_break', 'break' + m.break_desc,
                     breakPayload(m, ctx, bsides));
            } else if (m.break_desc) {
                m._break_since = p._break_since || null;    // still off, same stoppage
            } else if (p.break_desc && !m.complete) {
                push('play_resumed', 'resume' + p.break_desc + (p._break_since || ''),
                     chaseStartPayload(m, ctx, p.break_desc) ||
                     resumePayload(m, ctx, bsides, p._break_since, now, p.break_desc));
            }
            /* THE INNINGS CLOSES AT THE BREAK, not when the next one starts. A side
             * that bats its overs out is not all out, so its innings can still read as
             * open while the players are walking off: the card's only word for it is
             * an innings break. Waiting for the chase to appear left the last over's
             * score line on screen through the whole interval, and the target unsaid
             * until the break was over.
             *
             * Same id as the next-innings path above, so whichever sees it first says
             * it and the other is a duplicate. Pushed AFTER the break line, because it
             * retires it: "Wendover 241/9 · Target 242" says everything "Innings
             * break" does, and more.
             * > James's observation, 2026-10-01 (SIM 15:55). */
            var lastInn = mi[mi.length - 1], plastInn = pi[pi.length - 1];
            var breakClose = !m.complete && lastInn && mi.length === pi.length &&
                ((lastInn.closed && plastInn && !plastInn.closed) ||
                 (/innings/i.test(m.break_desc || '') && m.break_desc !== p.break_desc));
            if (breakClose) {
                push('innings_closed', 'inn' + mi.length + 'close', closedPayload(m, ctx, lastInn));
            }
            if (m.complete && !p.complete) {
                var res = m.result_club || m.result || 'Match finished';
                var aband = /abandon|no result|wash|cancel/i.test(res);
                push(aband ? 'abandoned' : 'match_finished', 'result',
                    aband ? abandonedPayload(m, ctx)
                          : finishedPayload(m, ctx, m.final ? '' : 'result to be confirmed'));
            }
            // Confirmation is its own small event: the surface has been hedging with
            // "result to be confirmed" and can now stop.
            if (m.complete && p.complete && m.final && !p.final) {
                push('match_finished', 'final', finishedPayload(m, ctx, 'result confirmed'));
            }

            /* --- clips. A clip is not an event of its own: it is footage OF one, so
             * it joins the event it shows and only stands alone when nothing claims
             * it.
             *
             * THE JOIN MUST REACH BACK PAST THIS POLL. Footage lags the scorecard —
             * the wicket is in the feed a poll or two before the clip of it is — so
             * searching only the events extracted from this poll finds nothing and
             * emits a second, duplicate wicket. The store is therefore searched too,
             * via `cfg.recent`, which is how the pair ends up as one thing on screen.
             * (Without a `recent` the extractor still works and still degrades to the
             * duplicate, so a caller that has no store is not broken by this.) */
            (m.clips || []).forEach(function (c) {
                /* THE ROW IS A BALL EVENT BEFORE IT IS FOOTAGE, and this pass takes
                 * the fact rather than the film. `MatchStreamHighlights` carries
                 * `over_no`, `ball_no` and `dt_utc` on every row — verified complete
                 * across 96 rows of a real streamed match — which is the only
                 * per-ball truth RV has anywhere. The scorecard cannot place a
                 * boundary or a wicket in time at all.
                 *
                 * WE DO NOT WAIT FOR IT. The scorecard stays the trigger, because it
                 * is faster and because waiting would make the streamed match — the
                 * one we most want to be live on — the slowest thing on the wall.
                 * The row lands a poll or two later and corrects the record behind
                 * the event, which is invisible on the band and is exactly what
                 * `happened_at` is for.
                 *
                 * `url` is not required here: a row with no playable clip is still a
                 * statement that a ball happened at a time, and only the footage path
                 * below needs something to play. */
                stampBallTime(out, c);
                stampBallTime(cfg.recent ? cfg.recent(ctx.key) : [], c);
                if (!c.url) return;
                var claimed = attachClip(out, c) ||
                              attachClip(cfg.recent ? cfg.recent(ctx.key) : [], c);
                if (claimed) return;
                /* A BOUNDARY ROW STOPS HERE. `four` and `six` are no longer event
                 * types — a counter cannot date a boundary and the scorers' counters
                 * drift, so the boundary lives as a clause on the score instead (see
                 * `scorePayload`). Letting an unclaimed row raise one anyway would
                 * bring them back through the side door, on the streamed match only,
                 * which is the one place the inconsistency would be hardest to spot.
                 * Footage of a boundary is a REPLAY, and that is its own surface. */
                if (c.event === 'four' || c.event === 'six') return;
                /* NOTHING CLAIMED IT — so this is a ball the scorecard never
                 * reported. Real and commoner than it sounds: against the same
                 * scorecard the highlight feed had 58 fours to the batters' 55 and 17
                 * sixes to their 13, because a boundary in byes is not a batter's
                 * four and scorers' boundary counters drift. It becomes an event in
                 * the house grammar rather than the feed's own sentence. */
                var type = c.event === 'wicket' ? 'wicket' : 'ball_clip';
                var clipWhen = c.happened_ms ? [c.happened_ms, c.happened_ms] : when;
                out.push(event(type, ctx.key + ':clip' + c.id, ctx, clipWhen, now,
                               ballPayload(m, ctx, c, type),
                               { clip: clipOf(c), tension: ctx.tension }));
            });
        });
        // Remember when we saw each card, so the NEXT poll can bracket against a
        // real instant even when the scorer's cursor is missing.
        (next && next.matches || []).forEach(function (m) { m._received_at = now; });
        return out;
    }

    // ---- extraction: the division's other matches (the lean PC feed) --------
    // A much thinner diff, because the feed is much thinner: result-and-innings
    // granularity, no at-crease, no clips (see pc.mjs). What it CAN tell us is the
    // thing the ladder cares about — a match finishing — plus a coarse scoreline.
    function extractLeague(prev, next, now, cfg) {
        cfg = cfg || {};
        var out = [];
        var prevById = index(prev, 'match_id');
        (next && next.matches || []).forEach(function (m) {
            var p = prevById[String(m.match_id)];
            var ctx = matchCtx(m, cfg, false);
            var when = [p ? (p._received_at || null) : null, now];
            carryDerived(p, m);
            var push = function (type, id, payload, extra) {
                out.push(event(type, ctx.key + ':' + id, ctx, when, now, payload, extra));
            };
            if (!p) {
                if (m.complete) push(abandonedCard(m) ? 'abandoned' : 'match_finished', 'result',
                    abandonedCard(m) ? abandonedPayload(m, ctx) : finishedPayload(m, ctx));
                return;
            }
            if (m.complete && !p.complete) {
                var res = m.result_club || m.result || 'Match finished';
                var aband = /abandon|no result|wash|cancel/i.test(res);
                push(aband ? 'abandoned' : 'match_finished', 'result',
                     aband ? abandonedPayload(m, ctx) : finishedPayload(m, ctx));
                return;
            }
            /* THE MATCH GETTING UNDER WAY. The one state change the stream used to
             * pass over in silence: the board's square turns to "In play" and both
             * the division's tiles gain a mark, with nothing said about either.
             *
             * A TRANSITION, never a standing fact — it sits below the `!p` branch on
             * purpose. A match already in play when we first poll started before we
             * were watching, and announcing a one o'clock start at four is the bug
             * the whole `prev`-null rule exists to prevent.
             *
             * Guarded on `!m.complete` because a card can arrive late and jump
             * straight to a result, and "X are hosting Y" about a game that finished
             * an hour ago is worse than saying nothing. */
            if (!m.complete && m.phase === 'live' && p.phase !== 'live') {
                push('match_started', 'started', startedPayload(ctx));
            }
            var pi = (p.innings || []), mi = (m.innings || []);
            var closedNow = false;
            if (mi.length > pi.length && pi.length) {
                var closed = mi[pi.length - 1];
                closedNow = !!closed;
                if (closed) push('innings_closed', 'inn' + pi.length + 'close',
                                 closedPayload(m, ctx, closed));
            }
            // The coarse scoreline, when it moves. One event per distinct scoreline
            // rather than per over — this feed has no over-by-over truth to offer.
            /* A FINISHED MATCH HAS NO SCORE TO REPORT, only a result.
             *
             * The card does not stop moving when the game does: a scorer syncs the
             * last over after the players have gone in, a correction lands an hour
             * later, and the feed re-states the same innings with a run added. Each of
             * those is a changed scoreline, and this block was turning it into "Tring
             * Park are chasing The Lee" half an hour after Tring Park had lost.
             *
             * The completion branch above returns on the TRANSITION poll only, which is
             * what hid this: the first poll after the result is guarded, every later
             * one was not. A match that is over is over — the result is the news and it
             * has its own type.
             * > James spotted this one, 2026-09-29. */
            var last = mi[mi.length - 1], plast = pi[pi.length - 1];
            /* NOT IN THE POLL AN INNINGS CLOSED, for the reason the rich feed gives:
             * "Haddenham are chasing Gerrards Cross" at 0/0 retired the innings-closed
             * line it arrived with, so a division's target was never once on screen. */
            if (!m.complete && last && !closedNow &&
                (!plast || last.runs !== plast.runs || last.wickets !== plast.wickets)) {
                var sides = sidesOf(m, ctx, last);
                /* THE LOG IS KEPT PER OBSERVATION HERE, not per over: this feed has no
                 * over-by-over truth to offer and its over count arrives coarse and
                 * patchy, so the anchor is wherever the last changed scoreline was
                 * seen. The clause states the gap it actually measured, so an
                 * irregularly sampled innings reads honestly — "34 in the last 6
                 * overs" off two observations six overs apart is the same subtraction
                 * as six consecutive ones. */
                var lob = balls(last.overs);
                if (lob) logOver(m, mi.length - 1, lob, last);
                /* THE DIVISION'S CHASES SWING TOO, on the same bands. Only when the
                 * scoreline moves, which is the only time this card's price can. */
                var lsw = swingCheck(m, ctx, now);
                if (lsw) push('probability_shift', lsw.id, lsw.payload, { magnitude: lsw.magnitude });
                /* THE SAME MILESTONE, and the one place it says nothing the strip is not
                 * already showing: this card carries no batters, so there is no clause to
                 * name them with. It goes out anyway because the CROSSING is a moment and
                 * a scoreboard only ever shows a state — but this is the thinnest line on
                 * the wall and the `magnitude` on a first hundred keeps it near the floor.
                 *
                 * `plast` is the `watched` guard in this feed's terms: an innings that was
                 * not in the previous card crossed its marks before we looked. */
                /* AND IT HAS TO BE THE SAME INNINGS. `plast` is the previous card's LAST
                 * innings, which is a different innings once the second has begun — and
                 * a chase at 105 compared against a first innings of 80 would announce a
                 * hundred we never watched arrive. The innings COUNT matching is what
                 * makes the two figures comparable. */
                var lprev = pi.length === mi.length ? plast : null;
                if (lprev && !last.closed && !m.complete) {
                    var lmark = teamMarkCrossed(lprev, last, mi);
                    if (lmark) {
                        push('team_total', 'i' + (mi.length - 1) + 'team' + lmark,
                             teamMarkPayload(lmark, last, sides, false, atHome(sides, m, ctx), mi, ctx),
                             { magnitude: teamMarkMagnitude(lmark) });
                    }
                }
                /* THE DIVISION GETS THE PASSAGE FAMILY TOO, and it is the one place
                 * this feed can hold its own: a charge, a squeeze and a collapse are
                 * made of nothing but totals and overs, which is all its card carries.
                 * Everything else the band says about a match — the people, the
                 * dismissals, the spells — is ours alone, so these three are the only
                 * events that let another club's afternoon be described rather than
                 * merely scored.
                 *
                 * `surgeAt` does the honesty for us: this log is sampled per
                 * observation, and a window that cannot be bounded near the length
                 * asked for yields nothing. */
                var lsg = lob ? surgeAt(m, mi.length - 1, last, lob) : null;
                if (lsg && surgeFresh(m, mi.length - 1, lsg.face, lob, lsg.balls)) {
                    push(lsg.face, 'sg' + mi.length + lsg.face + lob,
                         surgePayload(lsg, last, sides, false, ctx, mi));
                } else {
                    push('score_update', 'sc' + mi.length + '_' + last.runs + '_' + last.wickets,
                         scorePayload(m, ctx, sides, last, mi.length - 1, lob, null, mi));
                }
            }
        });
        (next && next.matches || []).forEach(function (m) { m._received_at = now; });
        return out;
    }

    /* ---- THE LEAGUE TABLE'S STORY -------------------------------------------
     *
     * Two events, both read off the strip's own ladder (`WccLadder.rows`, one copy of
     * the arithmetic for the column and the band):
     *
     *   ladder_expected   an ARROW — "if it stays this way" there will be a switch.
     *                     The arrow is baseline rank → projected rank, so this fires
     *                     exactly when one appears or changes, once it has held for
     *                     LADDER_HOLD_MS (a chase near a tipping point would otherwise
     *                     announce itself every poll). An arrow that goes is SILENT:
     *                     its event is retired, never contradicted.
     *   ladder_shift      the ladder actually MOVED — a committed swap, which under the
     *                     barrier rule can land when the OTHER game finishes, not
     *                     this side's own.
     *
     *   If it stays this way, Haddenham move up to 3rd, above Chesham
     *   Haddenham move up to 3rd, above Chesham
     *   Wendover drop to 5th, below Denham            (ours only, going down)
     *
     * ONE EVENT PER SWITCH, NOT TWO. A swap puts an arrow on both rows; the band says
     * it once, from the side going UP, naming the side it passes — except that our
     * own side going down is always said from our side. Both clubs are always named.
     *
     * `st` is the caller's memory between calls (the order last seen, each row's
     * arrow and how long it has stood). Called by the engine on every tick, so the
     * hold is measured on the clock rather than on a poll arriving.
     * > James's direction, 2026-10-01. */
    var LADDER_HOLD_MS = 120000;
    function extractLadder(st, views, cardOf, staleOf, now, cfg) {
        var out = [];
        if (!window.WccLadder || !st) return out;
        cfg = cfg || {};
        (views || []).forEach(function (view) {
            // Only a view that HAS a ladder: a points system, and a table that does
            // not already count today (`ladder()` returns the league order untouched
            // for those, so nothing would ever move anyway).
            if (!view.win_points || view.table_counts_today || (view.teams || []).length < 3) return;
            var rows = WccLadder.rows(view, cardOf, staleOf);
            var vk = String(view.pc_id != null ? view.pc_id : (view.name || ''));
            var vs = st[vk] || (st[vk] = { order: null, arrows: {} });
            var byKey = {};
            rows.forEach(function (r) { byKey[r.key] = r; });
            var name = function (r) { return dropCC(r.club || r.tla || ''); };
            var ctxFor = function (r) {
                var fx = WccLadder.fixtureForTeam(view, r.key);
                if (fx) return matchCtx(fx.ours ? { pc_id: fx.match_id } : { match_id: fx.match_id },
                                        cfg, !!fx.ours);
                return matchCtx({ pc_id: view.pc_id }, cfg, true);
            };
            // What this side's move follows: the swing in its match not yet shown
            // (expected), or its match's result (actual). See `waiting` in the store.
            var follows = function (ctx, type) {
                if (!cfg.recent) return null;
                var ev = cfg.recent(ctx.key).filter(function (e) {
                    return e.type === type && !e.superseded && e.shown_count === 0;
                })[0];
                return ev ? ev.id : null;
            };

            /* ACTUAL: the committed order against the one last seen. */
            var order = rows.map(function (r) { return r.key; });
            if (vs.order) {
                var was = {};
                vs.order.forEach(function (k, i) { was[k] = i; });
                rows.forEach(function (r, i) {
                    if (was[r.key] == null || was[r.key] === i) return;
                    var up = i < was[r.key];
                    if (!up && !r.ours) return;
                    // Whom it passed: above it before and below it now, or the reverse.
                    var passed = rows.filter(function (q, j) {
                        return q !== r && was[q.key] != null &&
                               (up ? (was[q.key] < was[r.key] && j > i)
                                   : (was[q.key] > was[r.key] && j < i));
                    });
                    var ctx = ctxFor(r);
                    out.push(event('ladder_shift',
                        ctx.key + ':ladder' + r.key + '@' + (i + 1) + '/' + r.ptsNow, ctx, [null, now], now,
                        say(movePhrase(r, i + 1, up, passed.map(name), name)),
                        { ours: !!r.ours, magnitude: Math.min(1, Math.abs(was[r.key] - i) / 3),
                          after: follows(ctx, 'match_finished') }));
                });
            }
            vs.order = order;

            /* EXPECTED: each row's arrow, held before it is said. */
            rows.forEach(function (r) {
                var sig = r.ghost ? r.ghost + r.ghostN + '@' + r.projRank : '';
                var a = vs.arrows[r.key] || (vs.arrows[r.key] = { sig: '', since: now, said: '', id: null });
                if (sig !== a.sig) { a.sig = sig; a.since = now; }
                // The arrow it announced has gone or changed: retire what was said.
                if (a.id && a.said !== sig) {
                    out.push(event('ladder_expected', 'retract:' + a.id + ':' + now, ctxFor(r),
                        [null, now], now, say([]), { retire_ids: [a.id], retire_only: true }));
                    a.id = null; a.said = '';
                }
                if (!sig || a.said === sig || now - a.since < LADDER_HOLD_MS) return;
                var up = r.ghost === 'up';
                if (!up && !r.ours) return;
                var passed = rows.filter(function (q) {
                    return q !== r && q.baseRank != null &&
                           (up ? (q.baseRank < r.baseRank && q.projRank > r.projRank)
                               : (q.baseRank > r.baseRank && q.projRank < r.projRank));
                });
                /* Every side named here is PRICED — a chase on or a result — because
                 * the arrow itself is only drawn when it is (see `ladder()` in
                 * live-ladder.js). The band never claims a move the strip isn't showing. */
                var ctx = ctxFor(r);
                var id = ctx.key + ':expect' + r.key + sig + ':' + now;
                out.push(event('ladder_expected', id, ctx, [null, now], now,
                    say([det('If it stays this way,')]
                        .concat(movePhrase(r, r.projRank, up, passed.map(name), name))),
                    { ours: !!r.ours, magnitude: Math.min(1, (r.ghostN || 1) / 3),
                      after: follows(ctx, 'probability_shift') }));
                a.said = sig; a.id = id;
            });
        });
        return out;
    }
    // "Haddenham move up to 3rd, above Chesham" / "Wendover drop to 5th, below Denham".
    function movePhrase(r, to, up, passed, name) {
        var list = passed.slice(0, 3);
        var parts = [team(name(r)), det((up ? 'move up to ' : 'drop to ') + ordinal(to))];
        if (list.length) {
            parts.push(det(up ? ', above' : ', below'));
            list.forEach(function (n, i) {
                if (i) parts.push(det(i === list.length - 1 ? 'and' : ','));
                parts.push(team(n));
            });
        }
        return parts;
    }

    /* A ladder move handed in from outside (`handle.addLadderMove`) — the seam the
     * strip was going to use before the engine derived moves itself. Kept for a
     * console or a test; nothing in the wall calls it now. */
    function ladderEvent(move, now, cfg) {
        if (!move || !move.club) return null;
        var ctx = matchCtx({ pc_id: move.pc_id, match_id: move.match_id,
                             home: move.club, away: '' }, cfg || {}, !!move.ours);
        var n = Math.abs(move.places || 0);
        return event('ladder_shift', ctx.key + ':ladder' + move.club + move.to, ctx,
            [move.since || null, now], now,
            say(movePhrase({ club: move.club }, move.to, move.places > 0, [],
                           function (r) { return dropCC(r.club); })),
            { magnitude: Math.min(1, n / 3) });
    }

    // ---- helpers ------------------------------------------------------------
    function event(type, id, ctx, when, now, payload, extra) {
        extra = extra || {};
        return {
            id: id, type: type, label: typeOf(type).label,
            match: { key: ctx.key, ours: ctx.ours, pc_id: ctx.pc_id, match_id: ctx.match_id,
                     team: ctx.team, team_short: ctx.team_short, tile: ctx.tile,
                     opponent: ctx.opponent, division: ctx.division,
                     title: ctx.title },
            happened_at: when && when[1] != null ? [when[0], when[1]] : [null, now],
            received_at: now,
            shown_at: null, shown_count: 0,
            /* `extra.ours` OVERRIDES THE MATCH. Almost every event belongs to the
             * match and takes its side from it, but an event about a PERSON belongs
             * to that person's club — and on our own feed both sides' players arrive
             * through the same diff. An opposition hundred is somebody else's news
             * happening in our match, and should be priced as such. */
            interest: interestOf(type, { ours: extra.ours == null ? ctx.ours : !!extra.ours,
                                         clip: !!extra.clip,
                                         tension: extra.tension, magnitude: extra.magnitude }),
            payload: payload || {},
            clip: extra.clip || null,
            /* A PER-EVENT RETIREMENT LIST, overriding the type's. Almost nothing needs
             * it: what an event makes false is a property of its KIND, which is why
             * `RETIRES` is a table. The exception is the retraction below, which has no
             * kind of its own because it is not an event about the cricket. */
            retires: extra.retires || null,
            /* A RETRACTION: something the band has said has stopped being true and
             * nothing has replaced it. It retires and is then thrown away, because
             * "T Duff did not take a hat-trick after all" is not news and must never
             * reach a screen. The store drops it in `add`. */
            retire_only: !!extra.retire_only,
            // See `waiting` in the store, and `retire_ids` in `add`.
            after: extra.after || null,
            retire_ids: extra.retire_ids || null
        };
    }
    // Everything a surface needs to say WHICH match an event belongs to, resolved
    // once per card. `key` is the stable identity events are namespaced by.
    function matchCtx(m, cfg, ours) {
        var id = ours ? m.pc_id : (m.match_id != null ? m.match_id : m.pc_id);
        var c = (cfg.byId || {})[String(id)] || {};
        /* THE BAKED DIVISION FIXTURE, for somebody else's match. The PC card is
         * deliberately thin — ids, innings, a result — so the clubs, the competition
         * and above all the GROUND come from the fixture list the build already
         * writes and the engine already fetches. Absent (a caller with no config, an
         * invented id) it simply falls through to the card. */
        var lr = ours ? {} : ((cfg.leagueById || {})[String(id)] || {});
        return {
            key: (ours ? 'w' : 'l') + id,
            ours: !!ours, pc_id: ours ? id : (m.pc_id != null ? m.pc_id : null),
            match_id: ours ? null : id,
            team: c.team_name || (ours ? 'Wendover' : (lr.home_club_name || m.home || '')),
            // The XI's snappy form for the gold tile ("Women's Hawks"); see `team_short` in build.py.
            team_short: ours ? (c.team_short || c.team_name || 'Wendover') : '',
            // What the gold tile says for this match — see `tileOf`.
            tile: ours ? (c.team_short || c.team_name || 'Wendover') : tileOf(id, cfg),
            opponent: c.opposition || (ours ? (m.away || '') : (lr.away_club_name || m.away || '')),
            /* THE SHORT FORM FIRST — from EITHER config, before either raw name.
             *
             * `competition_short` is the build's own shortener ("Div 6C TVCL") and is
             * now stamped on the league rows as well as ours, so the same division is
             * labelled the same way whoever is playing in it.
             *
             * ORDER IS THE WHOLE POINT HERE, and getting it wrong is what this fixed.
             * Ranked by config first — ours, then the league's, then the card — a raw
             * `c.competition` beat a shortened `lr.competition_short`, and the
             * simulator indexes its league fixtures into `byId` as well as
             * `leagueById` (live-sim.js buildDay), so on the wall every division match
             * said "Division 6C" while the strip beside it said "Div 6C TVCL". Rank by
             * the SHAPE of the answer instead: every short form, then every long one. */
            division: c.competition_short || lr.competition_short ||
                      c.competition || m.competition || lr.competition_name || '',
            title: matchTitle(m),
            // Not carried onto the event record — only the text builders want them.
            home_club: lr.home_club_name || m.home || '',
            away_club: lr.away_club_name || m.away || '',
            ground: lr.ground_name || m.ground_name || '',
            our_club: c.our_club || '',
            // The fixture's scheduled start, "13:00", for an event describing a match
            // that has not begun. Baked into live-config by the daily build.
            start_time: c.time || lr.match_time || '',
            tension: ours ? tensionOf(m) : null
        };
    }
    /* THE GOLD TILE NAMES ONE OF OURS, EVEN ON SOMEBODY ELSE'S MATCH.
     *
     * The wall is for Wendover, and a division match matters to the room because of
     * which of our sides it affects — so the tile names that side: "2nd XI" over
     * Chesham v Tring Park, since the 2nd XI is who that result moves on the table.
     *
     * Read off the strip's baked views (the division table, with `wendover` on every
     * one of our rows and their short names as `desig`): the view whose fixtures
     * include this match. One of ours in that division → that side. More than one —
     * the women's indoor table has two — and the match decides: the one playing in
     * it, if either is; otherwise neither has a better claim than the other, and the
     * tile goes back to the division's own short form (an empty answer here).
     * > James's direction, 2026-10-01. */
    function tileOf(matchId, cfg) {
        var views = (cfg && cfg.views) || [];
        for (var i = 0; i < views.length; i++) {
            var fx = (views[i].fixtures || []).filter(function (f) {
                return !f.ours && String(f.match_id) === String(matchId);
            })[0];
            if (!fx) continue;
            var mine = (views[i].teams || []).filter(function (t) { return t.wendover || t.ours; });
            if (mine.length === 1) return mine[0].desig || '';
            var playing = mine.filter(function (t) {
                return (fx.team_ids || []).indexOf(String(t.team_id)) !== -1;
            });
            return playing.length ? (playing[0].desig || '') : '';
        }
        return '';
    }

    function matchTitle(m) {
        var h = (m && m.home) || '', a = (m && m.away) || '';
        return h && a ? h + ' v ' + a : (h || a || '');
    }
    function index(feed, key) {
        var out = {};
        (feed && feed.matches || []).forEach(function (m) {
            if (m[key] != null) out[String(m[key])] = m;
        });
        return out;
    }
    function byName(list) {
        var out = {};
        (list || []).forEach(function (x) { if (x && x.name) out[x.name] = x; });
        return out;
    }
    // Pair this poll's innings with the same innings last poll. `innings_id` when the
    // feed carries one, else the chronological slot — never the side's name, which a
    // two-innings-each game would collide on.
    function matchInnings(prevList, inn, ii) {
        if (inn.innings_id != null) {
            for (var i = 0; i < prevList.length; i++)
                if (String(prevList[i].innings_id) === String(inn.innings_id)) return prevList[i];
            return null;
        }
        return prevList[ii] || null;
    }
    function balls(overs) { return window.WccChase ? WccChase.ballsOf(overs) : 0; }
    /* ---- THE SWING -----------------------------------------------------------
     *
     * A CROSSING, NOT A JUMP. This fired when the chase model moved 15 points between
     * two polls, which made it a property of how often we poll — the same afternoon
     * polled twice as often never swung at all — and it could fire four times in a
     * quarter of an hour on one chase. It now fires when the chase crosses into a new
     * BAND of the chasing side's chance:
     *
     *     0  < 0.2   the defending side on top
     *     1  < 0.5   the defending side favourites
     *     2  < 0.8   the chasing side favourites
     *     3          the chasing side closing in
     *
     * with SWING_MARGIN of hysteresis either side of every edge, so a chase sitting
     * on 50% does not flip every poll. The first band a chase is seen in is set
     * silently: that is a state, not a swing. With no allotment known the model caps
     * its certainty (see live-chase.js), so only the favourite changing can fire.
     *
     * NO PERCENTAGES. The model is an approximation — fine for a fill height, not a
     * figure to quote — so the line says what happened in words, then WHY: the
     * passage that did it ("30–3 in the last 5 overs", the passage clause), or failing
     * that where the chase stands.
     *
     *   Denham’s chase turns, Wendover now favourites  ·  30–3 in the last 5 overs
     *   Wendover now favourites against Denham  ·  48 needed from 5 overs, 4 wickets in hand
     *   Wendover closing in on the Denham target  ·  12 needed from 18 balls, 6 wickets in hand
     *   Denham fighting back  ·  …                       (we were chasing)
     *
     * ALWAYS THE OPPOSITION on our games and BOTH clubs on a division's. Wendover
     * may be the subject; as an object it is dropped ("the target", no "against
     * Wendover"), and every line names the other side somewhere.
     * > James's direction, 2026-10-01. */
    var SWING_EDGES = [0.2, 0.5, 0.8], SWING_MARGIN = 0.05;
    /* AND A GAP BETWEEN SWINGS IN ONE MATCH, except for the favourite changing. A
     * see-saw chase crosses the "on top" edge back and forth for an hour (measured
     * on the simulated day: six swings in two hours on one division game), and every
     * crossing but the flip is a shade of the last one. A crossing held back is not
     * lost: the band is only moved when the event goes out, so one still true when
     * the gap ends is said then. */
    var SWING_GAP_MS = 600000;
    function swingBand(p, from) {
        var k;
        if (from == null) {
            k = 0;
            while (k < 3 && p >= SWING_EDGES[k]) k++;
            return k;
        }
        k = from;
        while (k < 3 && p >= SWING_EDGES[k] + SWING_MARGIN) k++;
        while (k > 0 && p < SWING_EDGES[k - 1] - SWING_MARGIN) k--;
        return k;
    }
    // The chase's band this poll against the one carried on the card (`_swing`, the
    // `_spells` precedent): an event when it has changed, else null.
    function swingCheck(m, ctx, now) {
        var inns = (m && m.innings) || [];
        if (m.complete || inns.length !== 2) return null;
        var st = window.WccChase ? WccChase.chaseState(inns) : null;
        if (!st || st.p == null) return null;
        if (!m._swing) { m._swing = { band: swingBand(st.p, null) }; return null; }
        var from = m._swing.band, to = swingBand(st.p, from);
        if (to === from) return null;
        var flip = (from < 2) !== (to < 2);
        if (!flip && m._swing.at != null && now - m._swing.at < SWING_GAP_MS) return null;
        m._swing.band = to; m._swing.at = now;
        var payload = swingPayload(m, ctx, st, from, to);
        if (!payload) return null;
        return { id: 'swing' + from + '>' + to + '@' + balls(inns[1].overs), payload: payload,
                 // The favourite changing is the big one.
                 magnitude: flip ? 1 : 0.6 };
    }
    function swingPayload(m, ctx, st, from, to) {
        var inns = m.innings;
        var a = inningsClub(m, ctx, inns[0]), b = inningsClub(m, ctx, inns[1]);
        if (!a || !b || a === b) return null;
        var ours = function (c) { return ctx.ours && isOurPlayer(ctx, c); };
        /* EVERY BAND SAYS WHO IS CHASING, AND NEVER NAMES US.
         *
         * The side that batted first is DEFENDING a total and the side batting is
         * CHASING, and one of those two words is in every line — two clubs and "on
         * top against" named the match without its shape. The defending side carries
         * its total ("defending 200", gold: it is a total), the chasing side the
         * chase. No possessives: "against Tring Park's chase" read the wrong way round.
         *
         * When the subject would be Wendover the subject goes, as on every other line
         * ("Falling behind, Denham now favourites"); when we would be the object we
         * are simply not named ("Denham back in the chase").
         * > James's direction, 2026-10-01. */
        var ua = ours(a), ub = ours(b);
        var total = { cls: 'score', text: String(inns[0].runs || 0) };
        // "v X" after a named subject is discretionary; after a dropped one it is what
        // says which of our games this is, so it stays.
        var vs = function (c, keep) {
            if (ours(c)) return [];
            var p = [det('v'), team(c)];
            if (!keep) p.forEach(function (x) { x.drop = true; });
            return p;
        };
        var defending = function (lead) {          // the side that batted first, on its way up
            return ua ? [det(capitalise(lead)), det('defending'), total].concat(vs(b, true))
                      : [team(a), det(lead), det('defending'), total].concat(vs(b));
        };
        var head;
        if (to === 3) head = ub ? [det('Closing in on the'), team(a), det('target')]
                                : [team(b), det('closing in on the'), ua ? null : team(a), det('target')];
        else if (to === 2 && from < 2) head = ub ? [det('Now favourites chasing'), team(a)]
            : [team(b), det('now favourites')].concat(ua ? [det('in the chase')] : [det('chasing'), team(a)]);
        else if (to === 2) head = defending('fighting back');
        else if (to === 1 && from > 1) head = ub ? [det('Falling behind,'), team(a), det('now favourites')]
            : ua ? [team(b), det('falling behind in the chase')]
                 : [team(b), det('falling behind,'), team(a), det('now favourites')];
        else if (to === 1) head = ub ? [det('Back in the chase')].concat(vs(a, true))
                                     : [team(b), det('back in the chase')].concat(vs(a));
        else head = defending('on top');
        /* NO CHASE ARITHMETIC. "48 needed from 5 overs, 4 wickets in hand" is what the
         * strip's scoreboard is showing beside it, so the band said it twice. A
         * passage clause stays when there is one — what the last few overs were worth
         * is not on the strip, and it is usually why the band moved. */
        var inn = inns[1];
        var why = passageClause(m, 1, balls(inn.overs), inn);
        return say(head.concat(why ? [SEP, det(why, true)] : []));
    }
    /* WHICH CLUB AN INNINGS IS — by team id against the card's home and away where
     * the card has them (the division's PC card), else the innings' own club (RV
     * names it). Shared by the result line and the swing. */
    function inningsClub(m, ctx, inn) {
        var home = dropCC(ctx.home_club || m.home || ''),
            away = dropCC(ctx.away_club || m.away || '');
        if (inn.team_batting_id != null && m.home_team_id != null) {
            if (String(inn.team_batting_id) === String(m.home_team_id)) return home;
            if (String(inn.team_batting_id) === String(m.away_team_id)) return away;
            return '';
        }
        return dropCC(inn.club || inn.side || '');
    }
    /* THE TOSS, and the first type phrased for the L-frame rather than for a bar
     * standing on its own.
     *
     * The gold tile now says TOSS, so the sentence must not: RV's ready-made
     * `toss.text` is "Chalfont St Peter CC won the toss and elected to bat", which
     * with the tile beside it says "toss" twice and spends the front of the line
     * getting to the only part that is news — the decision. Rebuilt from the parts
     * instead, as the live-match slide's intro already does, and reduced to what the
     * tile leaves unsaid: WHO, and WHAT THEY CHOSE.
     *
     * `winner_club` over `winner` because the latter carries the team designation
     * ("Chalfont St Peter CC 2nd XI"), which is the strip's business, not the bar's.
     * The feed's own sentence is the fallback when the parts are missing — a phrase
     * we cannot take apart is still better than no toss at all.
     *
     * Expect this shape to recur: with the tile carrying the noun, every type's
     * headline wants re-reading for a word it no longer has to say. */
    function tossPayload(m, ctx) {
        var t = (m && m.toss) || {};
        /* BOTH CLUBS FROM THE CONFIG, not from the toss object. `is_wendover` says
         * which of the two won it, and the build has already written both names down
         * — so the two sentences name the sides in one consistent style instead of
         * mixing the feed's `winner_club` with a name from somewhere else. It also
         * sidesteps matching `winner_club` against the card's home/away, which is the
         * name-join trap the strip's own comments warn about at length. */
        var ours = dropCC(ctx.our_club || ''), theirs = dropCC(ctx.opponent || '');
        var winner = '', other = '';
        if (typeof t.is_wendover === 'boolean' && ours && theirs) {
            winner = t.is_wendover ? ours : theirs;
            other  = t.is_wendover ? theirs : ours;
        } else {
            // A toss we cannot attribute to a side: say what we can and no more.
            winner = dropCC(t.winner_club || t.winner || '');
        }
        if (!winner || !t.decision) return say([det(t.text || 'Toss')]);

        /* THE SECOND SENTENCE IS THE OTHER SIDE'S HALF OF THE SAME FACT. A toss
         * decides what BOTH teams are about to do, and saying only the winner's
         * choice leaves the reader to work out the consequence — which is the part
         * that says what they are about to watch. Electing to bat sends the other
         * side into the FIELD; electing to bowl sends them to the CREASE.
         *
         * The decision's own word is kept rather than normalised, because RV writes
         * the vocabulary the scorer chose and "elected to field" is as good English
         * as "elected to bowl". */
        var bat = /^bat/i.test(String(t.decision).trim());
        /* TWO PHRASES, NOT TWO SENTENCES, because that is the band's grammar: the
         * headline is the news, the detail qualifies it, and the renderer sets the
         * dot between them. Written here as full stops it was the one event on the
         * wall punctuating itself, which read as a caption rather than as a line of
         * the same ticker.
         *
         * The split falls where the fact does. The winner's choice is the news; what
         * it means for the other side is the consequence, which is exactly what the
         * muted half is for.
         *
         * THE DETAIL IS STILL NOT THE MATCH NAME, and that part of the original note
         * stands: the L-frame already says whose game it is twice over — the strip's
         * footer names our XI and its division, and the ladder beside it marks the two
         * sides with bat and ball. A third statement of the same fact is the thing the
         * split exists to stop. */
        /* The scheduled start, when the build knew one. No guard on it having
         * passed: a toss is shown once and its ttl is half an hour, so "from 13:00"
         * is only ever read within a few minutes of being true. */
        /* "WON THE TOSS AND ELECTED TO", in full. The sentence was cut to the
         * decision alone because the gold tile says TOSS beside it — but the tile is
         * going back to the team and the division before this ships, and "Denham
         * elected to bat" standing on its own is a line with a word missing.
         * > James's direction, 2026-09-29. */
        return say([team(winner),
                    det('won the toss and elected to ' + String(t.decision).trim()),
                    SEP, team(other),
                    det(other ? 'will take the ' + (bat ? 'field' : 'crease') +
                        (ctx.start_time ? ' from ' + ctx.start_time : '') : '', true)]);
    }
    /* WHY THEY ARE OFF, IN THE WORDS OF THE THING THAT STOPPED IT.
     *
     *   Rain has stopped play v Denham
     *   Tea at High Wycombe hosting Maidenhead & Bray
     *   Play is held up for an injury v Denham
     *
     * The line used to be the feed's own label over the fixture — "Rain delay ·
     * Wendover v Denham" — which reads as a status field rather than as news, and
     * needed the gold tile to make sense of it.
     *
     * THE FEED'S TEXT IS A SCORER'S FREE CHOICE. RV asks for a reason from a list with
     * an "Other" on the end, so the vocabulary below is a set of patterns over a
     * string we do not control, and anything it does not recognise goes out in the
     * scorer's own words rather than being forced into a sentence that might be wrong.
     * DELAYED vs STOPPED comes from the scorer too: "rain delay" is his word for it,
     * and where he has not said, play has stopped.
     *
     * A MATCH OF OURS TAKES THE OPPOSITION TAG and somebody else's takes the fixture,
     * which is the same rule the rest of the band follows. (The division's PC feed
     * carries no break at all today, so that half is written for a feed we may yet
     * get rather than one we have.)
     * > James's direction, 2026-09-29. */
    var BREAK_WORDS = [
        [/rain|shower|wet|weather|covers/i, 'Rain has $ play'],
        [/bad light|light/i,                'Bad light has $ play'],
        [/injur|medical|blood/i,            'Play is held up for an injury'],
        [/ground|pitch|outfield/i,          'Play is held up on the ground'],
        [/tea/i,                            'Tea'],
        [/lunch/i,                          'Lunch'],
        [/drinks/i,                         'Drinks'],
        [/innings/i,                        'Innings break']
    ];
    function breakWords(desc) {
        var t = String(desc || '').trim();
        if (!t) return 'Play has stopped';
        for (var i = 0; i < BREAK_WORDS.length; i++) {
            if (BREAK_WORDS[i][0].test(t)) {
                return BREAK_WORDS[i][1].replace('$', /delay/i.test(t) ? 'delayed' : 'stopped');
            }
        }
        return t;
    }
    // Where it is happening: the opposition for one of ours, the fixture for anybody
    // else's — "at High Wycombe hosting Maidenhead & Bray".
    function whereParts(m, ctx, sides) {
        if (ctx.ours) return clubTag(ctx, '', oppositeOf(ctx, sides), 'v', 'v');
        var h = dropCC((ctx && ctx.home_club) || (m && m.home) || '');
        var a = dropCC((ctx && ctx.away_club) || (m && m.away) || '');
        return (h && a) ? [det('at'), team(h), det('hosting'), team(a)] : [];
    }
    // The club on the other side of the fixture from us, whichever of the two is
    // batting — a break is not about an innings, so it cannot read the side off one.
    function oppositeOf(ctx, sides) {
        if (!sides) return '';
        if (sides.bat && !isOurPlayer(ctx, sides.bat)) return sides.bat;
        return (sides.other && !isOurPlayer(ctx, sides.other)) ? sides.other : '';
    }
    function breakPayload(m, ctx, sides) {
        return say([det(breakWords(m.break_desc))].concat(whereParts(m, ctx, sides)));
    }
    /* AND HOW LONG IT COST, which is the one figure a ground actually discusses while
     * it waits. Measured from when WE first saw the break rather than from a time the
     * feed states — it states none — so it is a floor on the real figure, and a poll
     * lands every fifteen seconds, which makes the floor a tight one. Nothing is said
     * when the break began before we were watching. */
    /* THE END OF THE INNINGS BREAK IS THE START OF THE CHASE, and that is the news —
     * "Play resumes" is a rain delay's sentence, and after an innings break it said
     * nothing a room did not already know.
     *
     *   Chenies & Latimer begin their chase of 241      (theirs, in our match)
     *   The chase of 241 begins v Chenies & Latimer     (ours: never our own name)
     *
     * READ OFF THE FIRST INNINGS, not the second: the card can come off the break a
     * poll before the chase's first over is in it, and the target and the side that
     * must reach it are both already known from the innings that closed. Only for a
     * match with one innings in the book — anything else is not the start of a
     * chase, and falls back to the ordinary restart.
     * > James's direction, 2026-10-01. */
    function chaseStartPayload(m, ctx, why) {
        var inns = (m && m.innings) || [];
        if (!/innings/i.test(why || '') || !inns.length || inns.length > 2) return null;
        if (inns.length === 2 && balls(inns[1].overs) > 6) return null;
        var first = inns[0], chaser = sidesOf(m, ctx, first).other;
        if (!chaser) return null;
        // The first innings' total, never total plus one — see `chaseFigure`.
        var target = chaseFigure(inns);
        if (isOurPlayer(ctx, chaser)) {
            var foe = sidesOf(m, ctx, first).bat;
            return say([det('The chase of'), target, det('begins')]
                       .concat(foe ? [det('v'), team(foe)] : []));
        }
        return say([team(chaser), det('begin their chase of'), target]);
    }

    /* THE FIGURE A CHASE IS CHASING: the first innings' TOTAL, not total plus one.
     * "Chasing 247" is the score on the board the room has just watched made; 248 is
     * a number nobody saw. One helper so every line that says it says the same one.
     * > James's direction, 2026-10-01. */
    function chaseFigure(inns) {
        var first = inns && inns[0];
        return first && first.runs != null ? { cls: 'score', text: String(first.runs) } : null;
    }

    /* TIME LOST IS A STOPPAGE'S, not a break's. Rain, bad light, the weather in
     * general take time out of the game, and how much is the news of the restart.
     * An innings break, tea, drinks are the game's own schedule: nothing was lost,
     * and "8 minutes lost" after an innings break says something false.
     * > James's observation, 2026-10-01 (SIM 16:03). */
    var STOPPAGE_RE = /rain|weather|wet|shower|light|storm|lightning|hail/i;
    function resumePayload(m, ctx, sides, since, now, why) {
        var mins = since && STOPPAGE_RE.test(why || '') ? Math.round((now - since) / 60000) : 0;
        return say([det('Play resumes')].concat(whereParts(m, ctx, sides))
                   .concat(mins > 0
                       ? [SEP, det(mins + ' minute' + (mins === 1 ? '' : 's') + ' lost')] : []));
    }

    /* A MATCH CALLED OFF, AND WHAT THE TWO SIDES GOT FOR IT.
     *
     *   Match abandoned at Hurley v Maidenhead Royals  ·  7 points each
     *
     * The line was the feed's own word for it ("Abandoned") over the fixture, which
     * read as a label on a listing rather than as news — and it left out the only
     * thing anybody in the division wants to know, which is the points. A washout is
     * seven each under TVCL Win/Lose (Match Rules §9), and `tvcl-points.js` is the one
     * copy of that arithmetic on the client: the strip prices its ladder off it and
     * the match-day board badges finished games with it.
     *
     * GATED ON THE COMPETITION, as every caller of that port must be — seven points is
     * a TVCL number, and an indoor or a Traditional division does not work that way.
     * Guarded on the port being loaded at all, because the asset cache can serve this
     * page a script it has not got yet; without it the line simply stops after the
     * fixture, which is what it said before.
     * > James's direction, 2026-09-29. */
    function abandonedPayload(m, ctx) {
        var pts = '';
        if (/tvcl/i.test(ctx.division || '') && window.WccPoints) {
            var p = WccPoints.tvcl((m && m.innings) || [], 'abandoned');
            if (p && p[0] === p[1]) pts = p[0] + ' points each';
        }
        return say([det('Match abandoned at')].concat(fixtureParts(m, ctx))
                   .concat([SEP, det(pts)]));
    }
    /* A MATCH DECIDED, said as how it ended and then who won.
     *
     *   Denham are bowled out  ·  Wendover win by 34 runs – result to be confirmed
     *   Denham chase down the target to win by 2 wickets – result to be confirmed
     *   Wendover chase down the Denham target to win by 2 wickets
     *   Gerrards Cross run out of overs  ·  Haddenham win by 34 runs
     *   Amersham beat Wooburn Narkovians                (a division card with no score)
     *
     * THE ONE PLACE WENDOVER IS NAMED AS A SUBJECT. Everywhere else the band leaves
     * our own name out (see `clubTag`), but a result with the winner left out is not a
     * result. The object-case rule still holds: when WE set the target the chase is
     * "the target", not "the Wendover target". A division match names both clubs
     * every time and leaves the division to the strip.
     *
     * THE WAY IT ENDED IS READ OFF THE SCORECARD, not the feed's prose — RV lags with
     * "trails by…" until the scorer publishes, and PC carries no margin at all. Only
     * the three endings the card can prove are said: the chase passing the target,
     * the chasing side bowled out, the chasing side reaching the first innings'
     * overs (which needs an allotment, see `WccChase.allotmentOvers`). A defended
     * total with no provable ending falls back to "A beat B by 34 runs".
     *
     * ANYTHING THE SCORECARD CANNOT EXPLAIN goes out in the feed's own words with
     * the fixture beside it: a DLS target, a concession, an awarded match, a card
     * that is not two innings. A margin worked out from the runs would be wrong for
     * every one of those.
     * > James's direction, 2026-09-30. */
    function abandonedCard(m) {
        return /abandon|no result|wash|cancel/i.test(m.result_club || m.result || '');
    }
    function finishedPayload(m, ctx, hedge) {
        return say(finishedParts(m, ctx).concat([det(hedge ? '– ' + hedge : '')]));
    }
    function finishedParts(m, ctx) {
        var home = dropCC(ctx.home_club || m.home || ''),
            away = dropCC(ctx.away_club || m.away || '');
        var ours = function (club) { return ctx.ours && isOurPlayer(ctx, club); };
        var plural = function (n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); };
        var clubOf = function (inn) { return inningsClub(m, ctx, inn); };
        var text = String(m.result_club || m.result || '');
        var odd = /dls|d\/l|duckworth|revised|conced|forfeit|award/i.test(text);
        var inns = m.innings || [];

        if (inns.length === 2 && !odd) {
            var i1 = inns[0], i2 = inns[1];
            var a = clubOf(i1), b = clubOf(i2);          // a set the target, b chased it
            var r1 = i1.runs || 0, r2 = i2.runs || 0;
            if (a && b && a !== b) {
                if (r2 > r1) {
                    return [team(b), det('chase down the'), ours(a) ? null : team(a),
                            det('target to win by ' + plural(10 - (i2.wickets || 0), 'wicket'))];
                }
                var allot = window.WccChase ? WccChase.allotmentOvers(i1) : null;
                var how = (i2.wickets || 0) >= 10 ? 'are bowled out'
                        : (allot && balls(i2.overs) >= allot * 6) ? 'run out of overs' : '';
                if (r1 > r2) {
                    var by = plural(r1 - r2, 'run');
                    if (how) return [team(b), det(how), SEP, team(a), det('win by ' + by)];
                    return ours(b) ? [team(a), det('win by ' + by)]
                                   : [team(a), det('beat'), team(b), det('by ' + by)];
                }
                if (how) return [team(b), det(how),
                                 det(ours(a) ? 'level on ' + r1 : 'level with'),
                                 ours(a) ? null : team(a), det(ours(a) ? '' : 'on ' + r1),
                                 SEP, det('Match tied')];
                return [team(a), det('and'), team(b), det('tie on ' + r1)];
            }
        }
        // No scorecard to read (a division match kept in the book), so the winner
        // comes from the card's one structural fact about it.
        if (!odd && home && away && !ctx.ours) {
            var won = m.result_applied_to != null ? String(m.result_applied_to) : '';
            if (won && won === String(m.home_team_id)) return [team(home), det('beat'), team(away)];
            if (won && won === String(m.away_team_id)) return [team(away), det('beat'), team(home)];
            if (/\btie/i.test(text)) return [team(home), det('and'), team(away), det('tie')];
            if (/\bdraw/i.test(text)) return [team(home), det('and'), team(away), det('draw')];
        }
        var said = resultParts(text || 'Match finished', m, ctx);
        return ctx.ours ? said : said.concat([SEP]).concat(fixtureParts(m, ctx));
    }

    /* IS THIS CARD SAYING A STREAM IS RUNNING? Returns a stable marker rather than a
     * boolean, so a card can be compared with the one before it. See the call site for
     * why the three signals are ranked the way they are. */
    function streamOf(m) {
        if (!m) return null;
        var s = m.stream || (m.matchStreams && m.matchStreams[0]) || null;
        var began = (s && (s.recording_started_utc || s.recording_start_utc)) ||
                    m.recording_started_utc || m.stream_started_at || null;
        if (began) return 'rec:' + began;
        var vid = (s && (s.video_id || s.youtube_video_id)) || m.video_id || null;
        if (vid) return 'vid:' + vid;
        if (m.streamed) return 'flag';
        // Footage cannot exist without a camera.
        if ((m.clips || []).length) return 'clips';
        return null;
    }

    /* THE STREAM IS UP.
     *
     *   Wendover v Denham in Div 6C TVCL is being live streamed  ·  @WendoverCricketClub
     *
     * The fixture, not a scoreline: at the moment a stream comes online the match may
     * be four minutes old, and a viewer deciding whether to go and watch wants to know
     * WHICH GAME, not what the score is. The division rides in the same clause for the
     * same reason it does on a match starting — on a wall showing three of our sides
     * there is otherwise nothing to say which one this is.
     *
     * THE HANDLE IS ITS OWN GROUP, and it is the only part of the line that is an
     * instruction rather than a statement. It comes from live-config, once, rather
     * than from each fixture — see `_youtube_channel` in build.py.
     *
     * NOT IN THE CLUB TYPE, though it contains the club's name. The heavy weight on
     * this wall means "a club, as one of the sides in a match", and it is already
     * doing that twice in this very line; a third strong block on the end made the
     * channel read as a third team. It is an address, so it recedes to the supporting
     * type and lets the fixture keep the emphasis.
     * > James's direction, 2026-09-28. */
    function streamPayload(m, ctx, cfg) {
        var yt = (cfg && cfg.youtube) || {};
        var handle = String(yt.handle || '').replace(/^@/, '');
        return say(fixtureParts(m, ctx)
            .concat([det(ctx.division ? 'in ' + ctx.division : ''),
                     det('is being live streamed'),
                     SEP, det(handle ? '@' + handle : '')]));
    }

    /* A DIVISION MATCH STARTING, said as a sentence rather than a scoreline —
     * "High Wycombe are playing Maidenhead & Bray at London Road".
     *
     * A SENTENCE rather than "v" because it reads as news where a fixture line reads
     * as a listing. It was "are hosting", which said home and away in one word; the
     * ground clause says that plainly when the feed carries one, and "playing" is the
     * word a person would use.
     * > James's direction, 2026-09-29.
     *
     * THE GROUND IS OPTIONAL AT EVERY LEVEL. It is a real PC field that
     * fetch_league_fixtures reads, but it is frequently null — and the invented
     * division the simulator runs on has none at all — so the sentence has to be
     * complete without it. It is also dropped when it merely repeats the home club,
     * since "High Wycombe are hosting X at High Wycombe CC" tells nobody anything. */
    function startedPayload(ctx) {
        var home = dropCC(ctx.home_club), away = dropCC(ctx.away_club);
        if (!home || !away) return say([det('Match under way')]);
        var ground = String(ctx.ground || '').trim();
        var repeats = ground && dropCC(ground).toLowerCase().indexOf(home.toLowerCase()) === 0;
        /* THE DIVISION IS NAMED, in the chrome's own short form. The strip's ladder
         * is beside it, but the ladder is ten tiles of abbreviations and does not
         * say which competition they are — so on a wall showing three divisions at
         * once "High Wycombe are playing Maidenhead & Bray" was a fixture with no
         * league attached. It is part of the same sentence rather than a group of
         * its own: "in Div 6C TVCL" completes the clause, where a dot before it
         * would make it a second fact.
         * > James's direction, 2026-09-28. */
        return say([team(home), det('are playing'), team(away),
                    det(ground && !repeats ? 'at ' + ground : ''),
                    det(ctx.division ? 'in ' + ctx.division : '')]);
    }

    /* ---- ONE LINE, ONE LIST ---------------------------------------------------
     *
     * A payload used to carry three phrases in three fields — `headline`, `detail`,
     * `tail`, each with an optional `_parts` twin — and the renderer drew them in that
     * order with a dot between. Three boxes bought exactly two things: which phrase
     * gives way when the line is too long, and separators the payload never has to
     * punctuate for itself. It did NOT buy any distinction of meaning, and the moment
     * the middle clause needed marked-up parts too (a club there must be set in the
     * heavy type like every other club on this wall) all three became the same thing
     * with different names.
     *
     * So there is one `parts` list. A part is `{ cls, text }`; `{ sep: true }` ends a
     * group and draws the dot; `shrink: true` marks the group that may ellipsise. The
     * two things the three fields were for survive intact, said once each, and a line
     * that wants to be a sentence rather than three columns can simply be one — which
     * is the direction the band is going.
     *
     * `headline` is still written, because it is what every OTHER reader wants: the
     * inspector's row, the simulator's HUD, a log line. It is derived here rather than
     * typed out beside the parts, so the flat form and the marked-up one cannot drift.
     *
     * The list is NORMALISED on the way in — empty parts dropped, then leading,
     * trailing and doubled separators collapsed. That is what lets a builder write
     * `[score, SEP, maybeClause, SEP, maybeTail]` without checking whether the middle
     * one came out empty, which is most of what the old builders spent their length on. */
    var SEP = { sep: true };
    function say(parts, extra) {
        var clean = [], group = [];
        function flush() {
            if (!group.length) return;
            if (clean.length) clean.push(SEP);
            clean = clean.concat(group);
            group = [];
        }
        (parts || []).forEach(function (x) {
            if (!x) return;
            if (x.sep) { flush(); return; }
            if (x.text == null || String(x.text) === '') return;
            group.push(x);
        });
        flush();
        var out = { parts: clean, headline: textOf(clean) };
        if (extra) { for (var k in extra) { if (extra[k] != null) out[k] = extra[k]; } }
        return out;
    }
    // The flat form of a parts list: a word space inside a group, the band's own dot
    // between them. What the inspector, the HUD and every log line read.
    function textOf(parts) {
        var out = [], group = '';
        // A part beginning with punctuation continues the one before it and takes no
        // space in front of it — the renderer's own rule (`glue` in live-ticker.html),
        // kept in step so the flat form and the marked-up one read the same.
        function add(t) { group += (group && !/^[,;:.!?)\u2019']/.test(t) ? ' ' : '') + t; }
        (parts || []).forEach(function (x) {
            if (!x) return;
            if (x.sep) { if (group) out.push(group); group = ''; return; }
            if (x.text == null || String(x.text) === '') return;
            add(String(x.text));
        });
        if (group) out.push(group);
        return out.join(' \u00b7 ');
    }
    // Shorthand for the two parts almost every line is built out of.
    function team(t) { return t ? { cls: 'team', text: t } : null; }
    function det(t, shrink) { return t ? { cls: 'det', text: t, shrink: !!shrink } : null; }

    /* A FIXTURE, with both clubs in the type a club is set in.
     * `matchTitle` writes "Wendover CC v Chenies & Latimer CC" for ids and logs; this
     * is the same fact for the band — CCs dropped, as the match-day board drops them,
     * and each club a part of its own so it takes the heavy weight. */
    function fixtureParts(m, ctx, extra) {
        var h = dropCC((ctx && ctx.home_club) || (m && m.home) || '');
        var a = dropCC((ctx && ctx.away_club) || (m && m.away) || '');
        if (!h || !a) return [det(matchTitle(m)), det(extra)];
        return [team(h), det('v'), team(a), det(extra)];
    }

    /* THE RESULT SENTENCE, with its club lifted out of it.
     *
     * RV hands us one string — "Wendover CC won by 5 wickets" — and the club inside it
     * has to be set like a club. There is no marked-up form in the feed, so the name
     * is matched off the FRONT of the sentence against the two clubs we already know
     * are playing, longest first so "Wendover CC" wins over "Wendover".
     *
     * No match means no split, and the sentence goes out as prose: a result we cannot
     * take apart is still a result, and guessing where a club name ends inside
     * somebody else's sentence is how you end up with "Wend" in bold. */
    function resultParts(text, m, ctx) {
        var t = String(text || '').trim();
        if (!t) return [];
        var names = [(ctx && ctx.home_club) || (m && m.home) || '',
                     (ctx && ctx.away_club) || (m && m.away) || ''];
        names = names.filter(Boolean);
        names = names.concat(names.map(dropCC));
        names.sort(function (a, b) { return b.length - a.length; });
        for (var i = 0; i < names.length; i++) {
            if (names[i] && t.toLowerCase().indexOf(names[i].toLowerCase()) === 0) {
                return [team(dropCC(names[i])), det(t.slice(names[i].length).trim())];
            }
        }
        return [det(t)];
    }

    /* A SCORELINE, AS THE MATCH-DAY BOARD WRITES ONE.
     *
     * The band and the board are a few centimetres apart and are describing the same
     * innings, so "High Wycombe 9/0 (1 ov)" has to be the same three things in the
     * same three types in both places: the club, the figure, the overs that qualify
     * it. `parts` is how a payload says so — the ticker turns each into its own span
     * (`.team` / `.score` / `.ov`, mirroring `.sq-runs` and `.sq-ov` on the board).
     * `headline` carries the flat form alongside, because every other reader of an
     * event — the flash, the inspector slide, a log line — wants a string.
     *
     * Overs are omitted rather than faked when the feed has none: the PC card
     * sometimes carries a total and no over count, and "(0 ov)" would be a claim
     * about the innings rather than a gap in the feed. */
    /* AN INNINGS THAT HAS CLOSED, IN THE PAST TENSE.
     *
     *   Gerrards Cross were bowled out for 181 v Haddenham       (the division)
     *   Chenies & Latimer finished on 241/9                      (ours, their innings)
     *   Bowled out for 181 v Chenies & Latimer                   (ours, our innings)
     *
     * PAST TENSE because by the time it is on the band the next innings has often
     * begun and the strip is already showing its score: "Wendover 241/9 · Target
     * 242" read as the state of the match, and it no longer was. It still repeats a
     * figure the strip has shown, and that is the point of it — how an innings ended
     * is the one line of the afternoon worth saying twice.
     *
     * HOW IT ENDED decides the verb: ten down is bowled out (and the score is the
     * runs alone — "for 181", the wickets being the whole of the news), a declaration
     * is a declaration, and anything else — the overs run out — finished on a score.
     *
     * The clubs follow the rest of the wall (`clubTag`): never ours. Our own innings
     * drops its subject and keeps the opposition, which is what says which of our
     * games it is; theirs in our match names them and nobody else; a division innings
     * names both, the opponent discretionary.
     * > James's direction, 2026-10-01. */
    function closedPayload(m, ctx, inn) {
        var sides = sidesOf(m, ctx, inn), club = sides.bat || '';
        var allOut = (inn.wickets || 0) >= 10;
        var verb = allOut ? 'bowled out for' : (inn.declared ? 'declared on' : 'finished on');
        var fig = { cls: 'score', text: allOut ? String(inn.runs || 0)
                                               : (inn.runs || 0) + '/' + (inn.wickets || 0) };
        if (club && isOurPlayer(ctx, club)) {
            return say([det(capitalise(verb)), fig]
                       .concat(sides.other ? [det('v'), team(sides.other)] : []));
        }
        if (!club) return say(scoreParts(dropCC(inn.club || inn.side || ''), inn));
        var foe = sides.other && !isOurPlayer(ctx, sides.other)
            ? [det('v'), team(sides.other)].map(function (x) { x.drop = true; return x; })
            : [];
        return say([team(club), det((allOut ? 'were ' : '') + verb), fig].concat(foe));
    }

    function scoreParts(club, inn) {
        return [team(club), { cls: 'score', text: (inn.runs || 0) + '/' + (inn.wickets || 0) },
                inn.overs != null && inn.overs !== ''
                    ? { cls: 'ov', text: '(' + inn.overs + ' ov)' } : null];
    }

    /* WHO IS BATTING AND WHO IS WAITING. Both feeds, because both write the same
     * sentence and the sentence needs the same two names.
     *
     * Paired by `team_batting_id` against the card's own home/away ids where the card
     * has them, which is how the match-day board does it
     * (templates/slides/match-day.html) and the only way that survives two clubs with
     * similar names. The RV card has no such id but does name the batting CLUB on the
     * innings, so the fallback matches that against home/away — and the fallback is
     * what runs on every one of our own matches, not a rare path.
     *
     * `other` is empty when the pairing fails rather than guessed at, and the caller
     * says something else instead: naming the wrong club as still to bat would be a
     * confident lie about the one fact the clause exists to add. */
    function sidesOf(m, ctx, inn) {
        var home = dropCC(ctx.home_club || m.home || ''),
            away = dropCC(ctx.away_club || m.away || '');
        if (inn.team_batting_id != null && m.home_team_id != null) {
            return String(inn.team_batting_id) === String(m.home_team_id)
                ? { bat: home, other: away } : { bat: away, other: home };
        }
        var bat = dropCC(inn.club || inn.side || '');
        if (bat && bat === away) return { bat: away, other: home };
        if (bat && bat === home) return { bat: home, other: away };
        return { bat: bat || home, other: '' };
    }

    /* A club without its trailing "CC" — "Denham CC" -> "Denham". The port of
     * build.py's `drop_cc`, so a club is named on the L-frame exactly as the
     * match-day board names it a few centimetres away. */
    function atHome(sides, m, ctx) {
        var home = dropCC((ctx && ctx.home_club) || (m && m.home) || '');
        return !!(home && sides && sides.bat === home);
    }
    function dropCC(name) {
        if (!name) return '';
        // ", Bucks" or "(Penn)" goes with it — PC's qualifier for a same-named club. See drop_cc.
        var out = String(name).trim().replace(/\s+(CC|C\.C\.?|Cricket Club)(,\s*[^,]+|\s*\([^)]*\))?$/i, '');
        return out || String(name).trim();
    }

    /* Spell out a dismissal: "c Smith b Jones" -> "caught Smith, bowled Jones".
     * MOVED HERE FROM THE TICKER when the bar stopped building its own text: the
     * event's headline is now the only place a dismissal is phrased, so the
     * expansion has to live with it or the wall silently goes back to reading "b
     * Duff" at a room.
     *
     * The special cases below are all real RV output, not hypotheticals:
     *   "c & b M Robinson"        caught and bowled — the fielder IS the bowler
     *   "lbw  b T Duff"           note the double space RV emits after lbw
     *   "ro (H Godden,J Roan)"    run-outs are abbreviated 'ro', never "run out"
     */
    function expandHow(how) {
        var s = String(how || '').trim().replace(/\s+/g, ' ');
        if (!s || /^(run out|not out|retired|hit wicket|timed out|obstruct|handled)/i.test(s)) return s;
        // Run out, with whoever RV credited: "ro (A,B)" -> "run out (A, B)".
        var ro = s.match(/^ro\b\s*(?:\((.*)\))?$/i);
        if (ro) return 'run out' + (ro[1] ? ' (' + ro[1].split(',').map(function (n) { return n.trim(); }).join(', ') + ')' : '');
        // Caught and bowled: one name, said once.
        var cb = s.match(/^c\s*&\s*b\s+(.*)$/i);
        if (cb) return 'caught and bowled ' + cb[1];
        // lbw: the trailing "b X" is the bowler's credit, exactly as in "c X b Y",
        // so it expands the same way. Matched explicitly only because the generic
        // rule below would leave the stray space RV puts after "lbw".
        var lbw = s.match(/^lbw\s+b\s+(.*)$/i);
        if (lbw) return 'lbw, bowled ' + lbw[1];
        return s.replace(/^c\s+/i, 'caught ').replace(/^st\s+/i, 'stumped ')
                .replace(/^b\s+/i, 'bowled ').replace(/\sb\s+/i, ', bowled ');
    }
    /* A DISMISSAL, AS ONE SENTENCE.
     *
     *   "C Godden LBW for 2 \u2014 bowler W Vane 3\u20139"
     *
     * THE FIGURES ARE THE RESULT PANEL'S, deliberately: `wickets\u2013runs` with an en
     * dash, which is what `_bowl_highlight` writes in build.py and therefore what a
     * bowler's figures look like everywhere else on this wall. (The `five_for` event
     * has been writing `3-9` with a hyphen, which is the same claim in a different
     * hand; it now goes through this builder too.)
     *
     * THE BOWLER COMES OUT OF `how`. RV states the dismissal as a scorer writes it —
     * "c Duff b Vane", "lbw  b Vane", "ro (Nash)" — so the credited bowler is the tail
     * after the last " b ", and a run-out has none. His figures are then looked up in
     * the innings' own bowling card by name, and omitted rather than guessed if he is
     * not on it. */
    /* HOW HE WENT, IN THE WORD A PERSON WOULD USE — "bowled", "caught", "lbw".
     *
     * This was the scorecard's own shorthand (`b`, `ct`, `st`, `ro`), on the argument
     * that it is notation every reader has already met. It is, and "B Duff b 0" still
     * has to be translated by anyone glancing up from the other side of a room —
     * which is the whole audience. The words cost three characters and read as a
     * sentence, which is what this line now is.
     *
     * THE BOWLER IS NOT IN IT. "c Smith b Jones" carries the fielder and the bowler,
     * and the bowler has his own phrase at the end of the line with his figures on
     * it; naming him twice was what the shorthand was buying room for.
     * > James's direction, 2026-09-29. */
    var HOW_WORDS = [
        [/^c\s*&\s*b\s/i, 'caught and bowled'],
        [/^lbw\b/i,         'lbw'],
        [/^c\s/i,           'caught'],
        [/^st\s/i,          'stumped'],
        [/^b\s/i,           'bowled'],
        [/^ro\b|^run out/i, 'run out'],
        [/^hit wicket/i,    'hit wicket'],
        [/^retired/i,       'retired'],
        [/^timed out/i,     'timed out'],
        [/^obstruct/i,      'obstructing the field'],
        [/^handled/i,       'handling the ball']
    ];
    function howWord(how) {
        var t = String(how || '').trim().replace(/\s+/g, ' ');
        for (var i = 0; i < HOW_WORDS.length; i++) {
            if (HOW_WORDS[i][0].test(t)) return HOW_WORDS[i][1];
        }
        return '';
    }
    /* AND WHO DID IT — the fielder, for the three dismissals that have one.
     *
     * A catch, a stumping and a run-out are somebody's work, and on a club's own wall
     * that somebody is the half of the wicket the scorecard remembers and nobody says
     * out loud. The bowler has had his name on every wicket line all afternoon; this
     * is the only place the man in the field gets his.
     *
     * TAKEN OUT OF THE SCORER'S PHRASE, which is where it is stated: "c Godden b Vane"
     * is fielder-then-bowler and "ro (H Godden, J Roan)" is a list of them. The card's
     * own `fielder` column is the fallback — RV populates it (see the dismissal
     * probe) — and nothing is claimed when neither has anything.
     * > James's direction, 2026-09-29. */
    function fielderOf(how, fallback) {
        var t = String(how || '').trim().replace(/\s+/g, ' ');
        var ro = t.match(/^ro\b\s*\((.*)\)\s*$/i);
        if (ro) {
            return ro[1].split(',').map(function (n) { return n.trim(); })
                        .filter(Boolean).join(', ');
        }
        // "c & b X" is the bowler catching his own: the fielder IS the bowler, and
        // the word "caught and bowled" already says so.
        if (/^c\s*&\s*b\s/i.test(t)) return '';
        var m = t.match(/^(?:c|st)\s+(.+)$/i);
        if (m) {
            var name = m[1];
            var b = name.lastIndexOf(' b ');
            if (b >= 0) name = name.slice(0, b);
            return name.trim();
        }
        return String(fallback || '').trim();
    }
    /* THE BOWLER'S NAME OUT OF THE SCORER'S PHRASE — the tail after the last " b ".
     *
     * THE LAST ONE, AND A LOWER-CASE ONE. It was the leftmost match of a
     * case-INSENSITIVE " b ", and a fielder whose initial is B answers to that: "st B
     * Duff b D Pardoe" put "Duff b D Pardoe" in the bowler's slot, name, abbreviation
     * and all. A scorer writes the bowler's mark in lower case and it is always the
     * last thing on the line, so both halves of the rule come from the notation rather
     * than from the bug. `lastIndexOf` is case-sensitive, which is the point of it.
     *
     * "b Vane" with no preceding clause is the other shape, and the only one where the
     * mark is at the front. */
    function bowlerOf(how) {
        var t = String(how || '').trim().replace(/\s+/g, ' ');
        if (/^ro\b|^run out/i.test(t)) return '';          // nobody's wicket
        var i = t.lastIndexOf(' b ');
        if (i >= 0) return t.slice(i + 3).trim();
        return /^b\s/.test(t) ? t.slice(2).trim() : '';
    }
    function bowlerFigures(inn, name) {
        if (!name) return '';
        var list = (inn && inn.bowling) || [];
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].name || '').toLowerCase() === name.toLowerCase()) {
                return (list[i].wickets || 0) + '\u2013' + (list[i].runs || 0);
            }
        }
        return '';
    }
    /* THE FIGURES ARE THE CARD'S, SO ONLY THE LATEST WICKET MAY QUOTE THEM.
     *
     * `inn.bowling` is the bowler's running total at THIS poll, not at the ball that
     * got this batter — so on a backfilled wicket it is simply wrong, and visibly so:
     * three wickets in one poll all read "W Vane 3-9" beside three different
     * historical scorelines, each of which correctly said 9/1, 11/2, 13/3.
     *
     * Nor can the truth be inferred. His WICKET count at that point is derivable — it
     * is the dismissals in the batch that name him — but his RUNS are not: the card
     * carries a running total and never says when those runs were hit. Quoting a half
     * derived figure would be as false as quoting the current one and would look more
     * precise, so a backfilled wicket names the bowler and stops there.
     *
     * Same rule the scoreline already follows: the newest event takes the card's
     * current reading, the older ones state only what they can know. */
    /* A WICKET, AS A SENTENCE.
     *
     *   B Duff bowled for a duck  ·  W Vane 1–6 for Chenies & Latimer
     *   C Godden caught for 17, ending a stand of 44  ·  W Vane 3–9 for Chenies & Latimer
     *
     * THE SCORELINE HAS GONE FROM THE FRONT. It used to lead — "Wendover 13/3 (3 ov) ·
     * C Godden lbw 2 — W Vane 3–9 · Chenies & Latimer to bat" — from the v1 days when
     * the band WAS the scoreboard. The strip is the scoreboard now, in figures a room
     * can read, and it is a few centimetres away: what the band is for is the half the
     * strip cannot hold, which is the person and what was done to him.
     *
     * SO THE TWO HALVES ARE THE TWO PEOPLE. The batter and how he went, then the
     * bowler with his figures and whose bowlers these are. "for a duck" rather than
     * "for 0", because that is what the ground says.
     *
     * THE STAND IT ENDED rides inside the batter's clause. A dismissal says who and
     * how; the stand is what it DID to the match, and it is the one figure no
     * scoreboard can show — the strip's numbers are a state, and a partnership exists
     * only as the difference between two of them. It sits in the group marked
     * `shrink`, so on a long line it is the first thing to give way.
     *
     * A BACKFILLED WICKET KEEPS ITS SCORE, as a third group: it is describing a
     * position the match was in some overs ago and the strip is showing the position
     * it is in now, so the two would silently contradict each other. The newest wicket
     * needs no such thing — the strip agrees with it.
     *
     * The figures are the LATEST wicket's privilege for the reason `bowlerFigures`
     * gives: `inn.bowling` is his running total at this poll, which is not what he had
     * when he got an earlier man. Without them the word "bowler" comes back, since a
     * bare name would otherwise be anybody's. */
    function wicketParts(w, inn, sides, ctx, figures, stand, extra) {
        if (!w || !w.name) return [det('Wicket')];
        var word = howWord(w.how), by = fielderOf(w.how, w.fielder);
        // "Caught BY M Peverell" — the scorecard writes "c Peverell b Vane" and drops
        // the preposition, which in a sentence reads as the batter catching him.
        var clause = (word || 'out') + (by ? ' by ' + by : '') +
            (w.runs != null ? (w.runs === 0 ? ' for a duck' : ' for ' + w.runs) : '');
        /* THE STAND IT ENDED, AND WHOSE IT WAS. No comma before it: the phrase is one
         * breath — "bowled for 22 ending a stand of 44 for Denham" — and the club goes
         * HERE rather than with the bowler, because this is the clause about the
         * batting side. It is the shrinkable group, so a long line loses the stand
         * before it loses either name.
         * > James's direction, 2026-09-29. */
        var standTag = [];
        if (stand != null) {
            clause += ' ending a stand of ' + stand;
            standTag = clubTag(ctx, sides.bat, sides.other);
        }
        if (extra) clause += extra;
        var bowler = bowlerOf(w.how), figs = figures ? bowlerFigures(inn, bowler) : '';
        var credit = bowler
            ? (figs ? [{ cls: 'bat', text: bowler }, { cls: 'score', text: figs }]
                    : [det('bowler'), { cls: 'bat', text: bowler }])
            : [];
        /* THE BOWLER'S CLUB, which is his own unless his own is ours — see `clubTag`.
         * A run-out is nobody's wicket, so the group names the side that effected it
         * instead; when that side is us it falls back to the fixture, which is the one
         * thing the line would otherwise leave out. */
        /* THE BOWLER'S CLUB — unless the stand clause has already named the batting
         * side, in which case the line has its match identified and a second club is
         * two names where one will do. */
        if (credit.length && !standTag.length) {
            credit = credit.concat(clubTag(ctx, sides.other, sides.bat));
        } else if (!credit.length && !standTag.length) {
            credit = (sides.other && !isOurPlayer(ctx, sides.other))
                ? [team(sides.other), det('in the field')]
                : clubTag(ctx, '', sides.bat);
        }
        return [{ cls: 'bat', text: w.name }, det(clause, true)]
               .concat(standTag).concat([SEP]).concat(credit);
    }
    /* WHICH BATTERS FELL BETWEEN THESE TWO CARDS, in the order they went.
     *
     * The card carries a row per batter, so a dismissal is "this name had not been
     * given out last time and has been now" — which is true however many polls were
     * missed and however far the feed jumped. Returned in fall order where the rows
     * carry one, and in card order otherwise, because card order IS batting order and
     * that is the right answer often enough to be a sane fallback.
     *
     * `dismissal_id` is RV's own marker and is trusted when present; `how` is the
     * fallback for a feed that only writes the scorer's phrase. */
    /* IS THIS BATTER OUT? Decided on the WORDING, which is the one thing both feed
     * shapes agree on, because `dismissal_id` means opposite things in the two.
     *
     * Checked against real Results Vault payloads rather than against the simulator:
     * RV uses 0 = has not batted, **1 = NOT OUT**, 14 = retired not out, and 2/3/4/6
     * for caught / lbw / bowled / run out. A plain truthiness test on it — which is
     * what this was — reads every not-out batter at the crease as a wicket and every
     * retirement as one too. The simulator numbers it the other way round (0 = not
     * out), which is why nothing here ever looked wrong.
     *
     * So the text decides: "no", "dnb", "rtno" and the retirements are not wickets,
     * anything else a scorer wrote is. A fall-of-wicket score is the tie-breaker for a
     * card with no wording at all. */
    var NOT_OUT_TEXT = /^(no|not out|dnb|did ?not ?bat|rtno|rtnh|retired)/i;
    function isOut(b) {
        if (!b) return false;
        var t = String(b.dismissal_text || b.how || '').trim();
        if (t) return !NOT_OUT_TEXT.test(t);
        if (b.fow != null) return true;
        // Wordless and no fall figure: RV's own numbering, read RV's way.
        if (b.dismissal_id != null) return [0, 1, 14].indexOf(b.dismissal_id) === -1;
        return false;
    }
    /* WHICH BATTERS FELL BETWEEN THESE TWO CARDS, in the order they went.
     *
     * THE FALL ORDER IS DERIVED, NOT READ. `fow_order` looked like the answer and is
     * not: in two real RV cards it was populated for two dismissals out of eleven and
     * for none at all in the other match. Requiring it — which this did — meant the
     * per-wicket split would have fallen back to a single lumped event on virtually
     * every real match, while passing every simulated one, since the simulator fills
     * it in for everybody.
     *
     * `fow` — the score the wicket fell at — IS reliably populated, and sorting on it
     * gives the order directly. `fow_order` is kept as the tie-break for two wickets
     * at the same score, which is exactly the case it was present for in the real
     * card (two at 42), with batting position behind it. Ranking runs over ALL of the
     * innings' dismissals, not just the new ones, so a wicket's number is its true
     * number however many polls we missed.
     *
     * The LATEST wicket needs no `fow`: it is written from the card's own current
     * scoreline. Only the backfilled ones must state the score they left, so only
     * they can force the caller back to the lumped event. */
    /* EVERY DISMISSAL IN THE INNINGS, IN FALL ORDER. Split out of `newDismissals`
     * because the hat-trick needs the same list for a different question — not "what is
     * new" but "who were the last three out" — and two sorts of the same rows, ranked
     * by the same three keys, would be two chances to disagree about the order of an
     * innings. */
    function dismissalsOf(inn, pinn) {
        var was = {};
        ((pinn && pinn.batters) || []).forEach(function (b) {
            if (b && b.name) was[b.name] = isOut(b);
        });
        var all = [];
        ((inn && inn.batters) || []).forEach(function (b, i) {
            if (!b || !b.name || !isOut(b)) return;
            all.push({ name: b.name, how: b.dismissal_text || b.how, runs: b.runs,
                       fielder: b.fielder, fow: b.fow,
                       fow_order: b.fow_order, pos: b.number, seq: i,
                       fresh: !was[b.name] });
        });
        all.sort(function (a, b) {
            return (a.fow == null ? Infinity : a.fow) - (b.fow == null ? Infinity : b.fow) ||
                   (a.fow_order || 0) - (b.fow_order || 0) ||
                   (a.pos == null ? a.seq : a.pos) - (b.pos == null ? b.seq : b.pos);
        });
        /* THE FALL BEFORE THIS ONE, which is what makes the stand it ended a
         * subtraction rather than a guess: two fall-of-wicket figures, both stated by
         * the scorer. The first wicket's predecessor is the start of the innings, so
         * its `prev_fow` is 0 and the stand it ends is the opening one. */
        all.forEach(function (d, i) {
            d.order = i + 1;
            d.prev_fow = i ? all[i - 1].fow : 0;
        });
        return all;
    }
    function newDismissals(pinn, inn) {
        var all = dismissalsOf(inn, pinn);
        var out = all.filter(function (d) { return d.fresh; });
        // A backfilled wicket with no fall figure cannot state the score it left, so
        // the batch is not separable and the caller falls back.
        for (var i = 0; i < out.length - 1; i++) {
            if (out[i].fow == null) return [];
        }
        return out;
    }
    /* WHAT MOVED BETWEEN TWO CARDS, counted rather than guessed.
     *
     * Every figure here is a difference between two stated numbers, which is the
     * whole reason the enriched score can be trusted where a boundary EVENT could
     * not: we are claiming that a batter's four-count went from 1 to 3, not that a
     * particular ball was hit at a particular moment.
     *
     * NO TIME CLAIM AT ALL, and the reason is worth keeping. This briefly said "in
     * that over" whenever the innings had advanced by exactly six balls — true when
     * it fired, but it fired by accident: the score line only goes out on a whole
     * over, while the PREVIOUS poll lands wherever the 15-second timer put it, so a
     * six-ball delta is a coincidence of poll timing rather than a fact about the
     * cricket. A phrase that appears on one over and not the next, for reasons
     * invisible in the ground, reads as a bug. `balls` stays because it is a real
     * figure; nothing in the wording leans on it. */
    function sinceLastPoll(pinn, inn, ob, pb) {
        var was = byName(pinn.batters), out = {
            runs: (inn.runs || 0) - (pinn.runs || 0),
            balls: ob - pb,
            fours: 0, sixes: 0, who: null, whoRuns: null, movers: 0
        };
        var best = -1;
        ((inn.batters || []) || []).forEach(function (b) {
            var w = was[b.name];
            if (!w) return;                       // unseen last time: nothing to diff
            var d4 = (b.fours || 0) - (w.fours || 0), d6 = (b.sixes || 0) - (w.sixes || 0);
            if (d4 <= 0 && d6 <= 0) return;
            out.fours += d4; out.sixes += d6; out.movers++;
            // Whose clause it is: the batter who hit the most of them.
            if (d4 + d6 > best) { best = d4 + d6; out.who = b.name; out.whoRuns = b.runs; }
        });
        return out;
    }
    // "two fours", "a six", "two fours and a six" — words to three, numerals past it,
    // because "seven fours" reads as prose where "7 fours" reads as a statistic.
    var COUNT_WORDS = ['no', 'a', 'two', 'three'];
    function countWord(n) { return COUNT_WORDS[n] || String(n); }
    /* A COUNTED NUMBER, as against an introduced one. `countWord` says "a four" because
     * one four is a thing that happened; "19 for a in the last 4 overs" is not English,
     * and neither is "needs a for his fifty". A wicket column and a run gap are both
     * read as plain numbers — "for one", "four down".
     *
     * THESE RUN TO TEN where the boundary counts above stop at three, and the reason is
     * what they count: a run gap and a wicket column are small by nature and land in
     * the middle of a sentence ("have lost four for 12"),
     * where a numeral reads as a statistic dropped into prose. A boundary count is
     * already sitting beside a figure. */
    var COUNTED_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six',
                         'seven', 'eight', 'nine', 'ten'];
    function countedWord(n) { return COUNTED_WORDS[n] || String(n); }
    function boundaryPhrase(f, s) {
        var parts = [];
        if (f > 0) parts.push(countWord(f) + ' four' + (f === 1 ? '' : 's'));
        if (s > 0) parts.push(countWord(s) + ' six' + (s === 1 ? '' : 'es'));
        return parts.join(' and ');
    }
    function capitalise(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }

    /* ---- THE SCORE LINE, WRITTEN AGAINST THE SCOREBOARD BESIDE IT -------------
     *
     * `score_update` is the FLOOR: it fires every over on every match we can see, and
     * it is the one type that is not news. Under v1 the band WAS the scoreboard, so
     * the line was the score — club, figure, overs — with a clause behind it. The
     * strip is now the scoreboard stood on its end, and every group of that line is
     * already on it, larger and better set: the figure and the overs are its gold
     * apertures, "Denham to bat" is its TO BAT tile, "need 47 from 60" is its chase
     * block, and the fixture is its two crest tiles over the division in the footer.
     *
     * So the floor stopped repeating the numbers and took the half of a quiet over
     * that the scoreboard cannot hold. The split is the one the two surfaces are for:
     *
     *   THE STRIP IS STATE — where they are, this second.
     *   THE TICKER IS CHANGE — who is doing it, and how the last few overs have gone.
     *
     * A scoreboard has never named a person and cannot say what happened five overs
     * ago; those are exactly what makes a routine over worth a line, and they are what
     * a commentator says when nothing has happened: "Harrington settled on 38,
     * Fairhead 15, 44 together."
     *
     *   J Harrington 38* and W Fairhead 15*  ·  44 together  ·  Wendover batting
     *   High Wycombe  ·  34 for one in the last 5 overs
     *
     * THE LEAD IS THE MOST SPECIFIC ACTOR THE FEED CAN NAME. Our own card knows who
     * is in, so the pair leads and the club falls to the tail, which is the
     * individual family's rule (the strip footer says "1st XI" whoever is batting, so
     * a bare pair of names could be either side's). The division's card has no
     * batters at all, so the club is the most specific thing it has and it leads.
     * One shape, filled as far as each feed allows — not two different sentences.
     */

    /* WHO IS IN. `at_crease` when the feed gives it, else the not-out batters who have
     * faced something — which is what excludes the squad RV parks at `number` 99.
     * Both or neither: one name and a blank is worse than the club.
     *
     * THE FEED'S OWN ANSWER IS TAKEN AS IT STANDS. `at_crease` names the two men in,
     * so a non-striker who has not yet faced a ball is one of them — and at the top of
     * an innings he is precisely the man the band is there to introduce. Filtering him
     * out cost the first two overs of every innings their pair, which is where the
     * introduction belongs. The faced-a-ball test survives on the DERIVED pool, where
     * it is doing the other job: keeping RV's parked squad out of the sentence. */
    function creasePair(inn) {
        var at = ((inn && inn.at_crease) || []).filter(function (b) {
            return b && b.name && !isOut(b);
        });
        if (at.length >= 2) return at.slice(0, 2);
        var out = [];
        ((inn && inn.batters) || []).forEach(function (b) {
            if (!b || !b.name || isOut(b) || !(b.runs || b.balls)) return;
            if (out.length < 2) out.push(b);
        });
        return out.length === 2 ? out : [];
    }
    // A batter as the band writes one: the name, then the figure, with the star a
    // scorecard puts on an innings still going. The star is the whole reason the
    // figure is worth reading on this line — it says these two are the men in.
    function batFig(b) {
        return [{ cls: 'bat', text: b.name },
                { cls: 'score', text: (b.runs || 0) + '*' }];
    }
    /* THE TWO MEN IN, AS ONE CLAUSE — "W Fairhead 12* and A Quill 5*".
     *
     * The band's recurring tail. Nearly every line about our own matches now ends on
     * it: the score, a bowling change, a milestone, a man approaching one, a charge.
     * The reason is the split this pass is built on — the strip holds the STATE and
     * the ticker says what is happening to it, and who is in with what against his
     * name is the one piece of state no tile on the strip carries.
     *
     * Empty when the pair cannot be named, and `say()` drops the group, so a caller
     * appends it without asking whether there is one. */
    function pairParts(pair) {
        // NO "AND". Four parts in two name-and-figure pairs read as a scorecard, which
        // is what they are; the conjunction made them read as a sentence and cost the
        // length of a word in the phrase most likely to be truncated.
        // > James's direction, 2026-09-29.
        return (pair && pair.length === 2)
            ? batFig(pair[0]).concat(batFig(pair[1])) : [];
    }
    function pairOf(inn) { return pairParts(creasePair(inn)); }

    /* THE PARTNERSHIP — runs added since the last wicket fell, which is the one figure
     * of a settled passage of play that no surface on the wall carries.
     *
     * It is a subtraction of two numbers the feed states: the total now, and the total
     * when the last man was out (`fow`, the score at the fall). Extras added while the
     * two have been together belong in it, which is what a partnership means, so the
     * team total is the right minuend.
     *
     * No wicket yet means the whole total IS the stand, and an opening partnership is
     * the commonest thing this clause says.
     *
     * IT REFUSES TO GUESS. If the fall figures cannot account for every wicket — one
     * of them null, a name that changed spelling — the highest `fow` we can see
     * belongs to an EARLIER wicket and the stand would come out too big. Silence, and
     * the passage clause takes the slot.
     *
     * Under ten runs it stands down. "3 together" is arithmetic, not a story, and a
     * stand that young is better described by the over it is part of. */
    /* WHICH PARTNERSHIP IT IS — "opening", "2nd wicket", "3rd wicket".
     *
     * A number of wickets down is a position; the partnership it names is a THING, and
     * one every follower of the game already counts in these words. It costs a word
     * over "batting partnership" and says something that word did not.
     *
     * Read off the wickets that have fallen, which is exact: nobody out is the opening
     * stand, one down is the second-wicket stand. Past the tenth there is nothing to
     * name, and the plain word takes over.
     * > James's direction, 2026-09-29.
     *
     * THE MIDDLE ONES ARE NUMERALS — "6th wicket", not "sixth wicket" — read off the
     * band as a figure rather than a word. "Opening" and "last wicket" keep their
     * words: they are names for those stands, not counts.
     * > James's direction, 2026-10-01. */
    function standName(inn) {
        var w = (inn && inn.wickets) || 0;
        if (w === 0) return 'opening';
        if (w === 9) return 'last wicket';
        return w < 9 ? ordinal(w + 1) + ' wicket' : 'batting';
    }
    var STAND_MIN = 10;
    function partnershipRuns(inn) {
        if (!inn) return null;
        var w = inn.wickets || 0;
        if (!w) return inn.runs || 0;
        var seen = 0, at = -1;
        (inn.batters || []).forEach(function (b) {
            if (!b || b.fow == null) return;
            seen++;
            if (b.fow > at) at = b.fow;
        });
        if (seen < w || at < 0) return null;
        return Math.max(0, (inn.runs || 0) - at);
    }

    /* THE PASSAGE — what the last few overs have been worth, for a feed that cannot
     * name anybody.
     *
     * Two stated whole-over totals, subtracted. That is all it is, and it is why the
     * clause can make a claim about TIME where a boundary counter cannot: both ends
     * of it are scores the scorer published, and the overs between them are the
     * difference of two over counts. Nothing is inferred about any individual ball.
     *
     * The anchor is the newest log row at least `PASSAGE_BACK` overs old — five, which
     * is about half an hour of a league afternoon and long enough for a rate to mean
     * something. Early in an innings there is no row that old, so the oldest row is
     * used instead provided it is two overs back; one over is the over that has just
     * finished, and "6 in the last 1 over" is the ball-by-ball claim this clause
     * exists to avoid making. */
    var PASSAGE_BACK = 5, PASSAGE_MIN = 2, PASSAGE_KEEP = 60;
    /* THE DERIVED MEMORY, carried from poll to poll on the card itself — the
     * `_spells` and `_received_at` precedent. Two logs ride here:
     *
     *   `_passage`  where the innings stood at each whole over (the passage clause);
     *   `_falls`    the over count we OBSERVED the last wicket at (a stand's length).
     *
     * Neither is in the feed. Both are records of what we have watched, which is the
     * only honest place they can come from — and the reason each is guarded against
     * the poll that watched too little of it. */
    function carryDerived(p, m) {
        m._passage = (p && p._passage) || {};
        m._falls = (p && p._falls) || {};
        m._surges = (p && p._surges) || {};
        m._once = (p && p._once) || {};
        m._swing = (p && p._swing) || null;
    }
    /* A LATCH FOR A FACT THAT IS TRUE ONCE PER INNINGS.
     *
     * Most things here are transitions and need no memory: a crossing is a crossing.
     * `last_pair` is not — "nine down" is a STATE, and it has to be tested as one because
     * the poll the ninth wicket falls on does not yet have a pair to name (the new man
     * has faced nothing). Testing the state on every poll and latching the answer says it
     * once, on the first poll that can say it properly.
     *
     * The store's id de-duplication would hide a missing latch, exactly as it hid the
     * repeating maiden — so the latch is here rather than left to the store. */
    function onceOnly(m, ii, tag) {
        var log = m._once || (m._once = {});
        var seen = log[ii] || (log[ii] = {});
        if (seen[tag]) return false;
        seen[tag] = true;
        return true;
    }
    function logOver(m, ii, ob, inn) {
        var log = m._passage || (m._passage = {});
        var row = log[ii] || (log[ii] = []);
        // Same ball or earlier: nothing new to remember. A re-published card can
        // arrive with the innings where it was, and a duplicate row would make the
        // anchor arithmetic depend on how often we polled.
        if (row.length && row[row.length - 1].b >= ob) return;
        /* THE BOWLERS' FIGURES RIDE WITH THE SCORE, because a squeeze is told through
         * them and a snapshot cannot say who has been bowling. Two totals subtracted
         * gives a bowler's economy THROUGH THE WINDOW, which is the figure the event
         * is about — his match economy is a different number and a duller one. Same
         * arithmetic as the row itself, one level down. */
        var bw = {};
        ((inn && inn.bowling) || []).forEach(function (b) {
            if (b && b.name) bw[b.name] = { b: balls(b.overs), r: b.runs || 0,
                                            w: b.wickets || 0 };
        });
        row.push({ b: ob, r: inn.runs || 0, w: inn.wickets || 0, bw: bw });
        if (row.length > PASSAGE_KEEP) row.shift();
    }
    function passageClause(m, ii, ob, inn) {
        if (!ob) return '';
        var row = ((m && m._passage) || {})[ii] || [];
        /* NOT BACK PAST THE LAST THING WE SAID ABOUT THE PASSAGE. A charge or a squeeze
         * has just announced four overs in its own tile; a floor line measuring six
         * overs through the same passage restates it a minute later with the duller
         * half of the same arithmetic. So the clause describes what has happened SINCE
         * the band last described a passage, and where that leaves nothing to measure
         * it says nothing and the fixture takes the slot.
         *
         * `surgeAt`'s own disjoint-window rule is the same idea one level up: neither
         * surface should tell the same passage of play twice. */
        var floor = 0, seen = ((m && m._surges) || {})[ii] || {};
        Object.keys(seen).forEach(function (f) {
            if (seen[f] > floor) floor = seen[f];
        });
        var want = ob - PASSAGE_BACK * 6, anchor = null;
        for (var i = 0; i < row.length; i++) {
            if (row[i].b <= want && row[i].b >= floor) anchor = row[i];
        }
        if (!anchor && row.length && row[0].b <= ob - PASSAGE_MIN * 6 && row[0].b >= floor) {
            anchor = row[0];
        }
        /* The oldest row at or after the surge, when the two rules above have ruled
         * everything out but there IS cricket since the announcement worth measuring.
         * Without this the clause stays silent for a full five overs after every
         * charge, which is the wrong end of the trade: the passage since is short, but
         * it is what has happened. */
        if (!anchor && floor) {
            for (var j = 0; j < row.length; j++) {
                if (row[j].b >= floor && row[j].b <= ob - PASSAGE_MIN * 6) { anchor = row[j]; break; }
            }
        }
        if (!anchor) return '';
        var db = ob - anchor.b;
        if (db < PASSAGE_MIN * 6) return '';
        var runs = (inn.runs || 0) - anchor.r, wk = (inn.wickets || 0) - anchor.w;
        /* THE OVERS ARE WRITTEN AS A SCORECARD WRITES THEM — `oversWord`, so a gap of
         * twenty-one balls is "3.3 overs" and not "3.5". The division's feed samples
         * whenever its scoreline moves, so a part-over gap is the normal case there
         * and a decimal would be a different number from the one it means. */
        var over = ' in the last ' + oversWord(db);
        // A maiden passage is a story of its own, and the only one this clause tells
        // without a number to lead with.
        if (runs <= 0 && !wk) return 'No runs' + over;
        /* RUNS AND WICKETS AS A SCORE, not as prose. "30 for one in the last 5 overs"
         * was reading as a team total rather than as a passage, and the wicket column
         * vanished altogether when nobody was out — so a quiet passage and a passage
         * that cost two wickets were told in the same shape. A scoreline says both in
         * four characters, in the grammar the rest of the wall uses.
         * > James's direction, 2026-09-29. */
        return runs + '\u2013' + wk + over;
    }

    /* WHERE THE LAST WICKET FELL — in OVERS, which is the one thing a fall-of-wicket
     * figure does not carry. The feed states the score at the fall and never the over,
     * so the only honest source is the over count on the card we were holding when the
     * wicket appeared.
     *
     * THAT IS ONLY WORTH ANYTHING IF WE WERE WATCHING CLOSELY. At fifteen seconds a
     * poll the card we see is within a ball or two of the fall; under a scorer syncing
     * in lumps it can be overs late, and a stand's length measured from it would be
     * plain wrong. So the log records how much cricket the poll itself spanned, and
     * more than two overs marks the reading `wide` — after which the stand is stated
     * in runs alone. A missing clause beats an invented number.
     *
     * Only the LATEST fall is kept. It is the only one a current stand is measured
     * from, and the runs half of every stand comes from `fow` arithmetic instead,
     * which needs no memory at all. */
    function logFall(m, ii, wickets, ob, wide, inn) {
        var log = m._falls || (m._falls = {});
        /* WHAT THE MEN STILL IN HAD MADE AT THE FALL, which is what turns a batter's
         * running total into his share of THIS stand. Without it "50 for him and 54
         * for the pair" is unanswerable: his fifty may have been built across three
         * partnerships, and the fact that both crossed on one poll is then a
         * coincidence rather than the same event twice. */
        var at = {};
        ((inn && inn.batters) || []).forEach(function (b) {
            if (b && b.name && !isOut(b)) at[b.name] = b.runs || 0;
        });
        log[ii] = { w: wickets, b: ob, wide: !!wide, at: at };
    }
    /* A BATTER'S SHARE OF THE STAND HE IS IN — his total now, less what he had when
     * the last man went. Null when we cannot say, and the caller must then not claim
     * it: an opening stand needs no log (nobody has been out, so his whole innings is
     * the stand), and a man who walked in after the fall is not in the log at all,
     * which is the same answer as zero. */
    function standShare(m, ii, inn, b) {
        if (!b) return null;
        if (!(inn.wickets || 0)) return b.runs || 0;
        var f = ((m && m._falls) || {})[ii];
        if (!f || f.w !== (inn.wickets || 0) || !f.at) return null;
        return Math.max(0, (b.runs || 0) - (f.at[b.name] || 0));
    }
    function standBalls(m, ii, inn, ob) {
        if (!ob) return 0;
        // Nobody is out: the stand is the innings, and the innings' own over count is
        // its length. No memory required and nothing to be wrong about.
        if (!(inn.wickets || 0)) return ob;
        var f = ((m && m._falls) || {})[ii];
        // The log must be describing THIS stand — the fall that started it — and must
        // have been read closely enough to mean something.
        if (!f || f.w !== (inn.wickets || 0) || f.wide) return 0;
        return Math.max(0, ob - f.b);
    }

    /* A PARTNERSHIP REACHING A MARK — the first event on the wall about two players
     * rather than one.
     *
     *   J Harrington and W Fairhead  ·  53 together in 8.2 overs  ·  Wendover 104/2
     *
     * The shape is the individual family's, with the pair where the person goes: who,
     * the figure, what qualifies it, and the side with its total. What is new is the
     * qualifier — a stand's LENGTH, which no surface on the wall carries and which is
     * the difference between a counter-attack and an hour of survival.
     *
     * THE FIGURE IS THE STAND AS IT STANDS, not the mark. The tile says FIFTY STAND,
     * so the sentence must not (the toss's rule), and by the time a poll catches it
     * they are usually a few runs past — 53, which is the true number and is also the
     * one the strip's own figures can be reconciled with.
     *
     * NO SPLIT OF THE CONTRIBUTIONS, though the card carries both. "34 and 19" beside
     * "53 together" invites a reader to add them up and get a different number,
     * because extras added while the two were in belong to the stand and to neither
     * batter. The one place the arithmetic would be visibly wrong is the place it
     * would be checked. */
    /* EVERY FIFTY, AND WHERE EACH ONE LANDS. One type covers all of them with
     * `magnitude` doing the ordering, exactly as `team_total` does — and the numbers are
     * chosen against what they have to sit beside:
     *
     *   |  50 | 0.32 | 58 | just under an individual `fifty` (64)
     *   | 100 | 0.52 | 79 | above a `wicket` (70), below a personal `hundred` (92)
     *   | 150+| 0.72 | 80 | the tier cap
     *
     * The cap flattens 150 and 200 together, which is the right shape rather than a
     * limitation: by then the stand is already the biggest thing in the match bar
     * somebody's hundred, and a league afternoon rarely produces one.
     *
     * Note the floor is 0.32 and not zero. A magnitude of nothing puts the COMMONEST
     * case at the bottom of the multiplier — the mistake the first cut of `team_total`
     * made, which priced a first hundred at 20. */
    var STAND_MARK = 50;
    function standMarkMagnitude(mark) {
        return Math.min(1, 0.32 + (mark / STAND_MARK - 1) * 0.2);
    }
    function standPayload(pair, stand, ballsTogether, inn, sides, ctx) {
        // The score line's own shape, because it is the same fact grown big enough to
        // be news: which partnership, what it has put on, and the two men in it.
        var lead = [det(capitalise(standName(inn))), det('partnership of'),
                    { cls: 'score', text: String(stand) }];
        if (ballsTogether) lead.push(det('in ' + oversWord(ballsTogether), true));
        return say(lead.concat(clubTag(ctx, sides.bat, sides.other))
                       .concat([SEP]).concat(pairParts(pair)), { who: pair[0].name });
    }
    /* THE STAND A WICKET ENDED, for the dismissal clause — two fall figures
     * subtracted, so it is exact for a backfilled wicket as much as for the newest
     * one and needs none of the log above. The first wicket's predecessor is the
     * start of the innings (`prev_fow` 0), so it ends the opening stand.
     *
     * Thirty is where it becomes worth saying. Below that the stand is not what the
     * wicket did, and a clause reporting every eight-run partnership would be
     * reporting the over rate again. */
    var STAND_NEWS = 30;
    function standEnded(d, inn, last) {
        if (!d || d.prev_fow == null) return null;
        var at = d.fow != null ? d.fow : (last ? (inn.runs || 0) : null);
        if (at == null) return null;
        var n = at - d.prev_fow;
        return n >= STAND_NEWS ? n : null;
    }

    /* ---- THE PASSAGE OF PLAY, AS AN EVENT ------------------------------------
     *
     * Three faces of one idea, and the idea is the one thing a scoreboard structurally
     * cannot show: it displays a number going up, and it can never say that the number
     * has started going up FASTER, or has stopped, or that the innings is falling over.
     * All three are subtractions of two published totals — the same arithmetic the
     * passage clause already does on the floor line, promoted to news when it crosses
     * a threshold worth a screen.
     *
     *   CHARGE    a burst: three or four overs well above the innings' own rate
     *   SQUEEZE   the opposite: five or six overs well below it
     *   COLLAPSE  three wickets inside six overs
     *
     * THE BASELINE IS THE INNINGS ITSELF, not a par rate for the league. "They have
     * gone from four an over to nine" is the news; "they are scoring at nine" is a
     * fact about the pitch. And it is measured up to the WINDOW'S START, never
     * including the window, or a burst pollutes the baseline it is being judged
     * against and every burst looks smaller than it is.
     *
     * A RATIO IS NOT ENOUGH ON ITS OWN. Two runs an over against one is a doubling and
     * it is nothing, so each face carries an absolute floor as well — runs in the
     * window for the charge, runs and a real baseline for the squeeze. The squeeze also
     * requires a baseline worth squeezing: a side already scoring at two an over cannot
     * be strangled.
     *
     * EACH FACE HAS ITS OWN WINDOW, because the three are not the same length of
     * event. A burst is three overs; a drying-up needs five or six before it is real
     * rather than one quiet over; a collapse is defined by its wickets and not by
     * time at all.
     *
     * THE WINDOW MUST BE ROUGHLY THE ONE WE ASKED FOR. The division's log is per
     * observation, so the nearest anchor to "three overs ago" can be twelve overs back
     * — at which point the test means something else entirely and the sentence would be
     * about a different passage of play. `slack` bounds it, and no anchor in range
     * yields no event, which is the honest answer.
     */
    var SURGE = {
        // want/slack in overs; `min_base` is the baseline sample a ratio needs
        charge:   { want: 3, slack: 3, min_base: 5, ratio: 1.75, runs: 24, max_wkts: 1 },
        squeeze:  { want: 5, slack: 3, min_base: 5, ratio: 0.45, runs: 12, base_rate: 4 },
        collapse: { within: 6, wickets: 3 }
    };
    function rateOver(runs, balls) { return balls ? (runs || 0) / (balls / 6) : 0; }
    // The NEWEST row at least `want` overs back, and no more than `slack` overs older
    // than that — a window of about the length asked for.
    function anchorBack(m, ii, ob, want, slack) {
        var row = ((m && m._passage) || {})[ii] || [];
        var hi = ob - want * 6, lo = ob - (want + slack) * 6, best = null;
        for (var i = 0; i < row.length; i++) {
            if (row[i].b <= hi && row[i].b >= lo) best = row[i];
        }
        return best;
    }
    // The OLDEST row within `within` overs — "has this happened recently", which is a
    // different question from "how have the last five overs gone" and needs the other
    // end of the log.
    function anchorWithin(m, ii, ob, within) {
        var row = ((m && m._passage) || {})[ii] || [];
        var lo = ob - within * 6;
        for (var i = 0; i < row.length; i++) {
            if (row[i].b >= lo && row[i].b < ob) return row[i];
        }
        return null;
    }
    /* WHICH FACE, IF ANY. Ranked, because one window can answer to two of them: three
     * wickets for eleven is both a collapse and a squeeze, and the collapse is the
     * bigger thing to have happened. The charge cannot collide with either — it caps
     * the wickets in its window, since a burst with three men out is not a burst. */
    function surgeAt(m, ii, inn, ob) {
        if (!ob || inn.closed) return null;
        var runs = inn.runs || 0, wkts = inn.wickets || 0;
        var c = SURGE.collapse, a = anchorWithin(m, ii, ob, c.within);
        if (a && ob - a.b >= 6 && wkts - a.w >= c.wickets) {
            return { face: 'collapse', runs: runs - a.r, wkts: wkts - a.w, balls: ob - a.b,
                     anchor: a };
        }
        function windowed(cfg) {
            var q = anchorBack(m, ii, ob, cfg.want, cfg.slack);
            if (!q || q.b < cfg.min_base * 6) return null;
            return { anchor: q, runs: runs - q.r, wkts: wkts - q.w, balls: ob - q.b,
                     base: rateOver(q.r, q.b) };
        }
        var w = windowed(SURGE.charge);
        if (w && w.wkts <= SURGE.charge.max_wkts && w.runs >= SURGE.charge.runs &&
            rateOver(w.runs, w.balls) >= SURGE.charge.ratio * w.base) {
            return { face: 'charge', runs: w.runs, wkts: w.wkts, balls: w.balls,
                     anchor: w.anchor };
        }
        w = windowed(SURGE.squeeze);
        if (w && w.base >= SURGE.squeeze.base_rate && w.runs <= SURGE.squeeze.runs &&
            rateOver(w.runs, w.balls) <= SURGE.squeeze.ratio * w.base) {
            // The anchor goes with it: the squeeze names the bowlers who did it, and
            // they are a subtraction against that row (see `squeezeParts`).
            return { face: 'squeeze', runs: w.runs, wkts: w.wkts, balls: w.balls,
                     anchor: w.anchor };
        }
        return null;
    }
    /* ONE EVENT PER PASSAGE, NOT ONE PER OVER. A burst that runs for six overs answers
     * the charge test on every one of them, and a band that said so would be reporting
     * the same four overs four times.
     *
     * The rule is DISJOINT WINDOWS: the next one of a face may not fire until its own
     * window has cleared the last. So two charges always describe two different
     * passages of play, and the constant that decides it is the window itself rather
     * than a cooldown invented beside it. The state rides with the other derived
     * memory, per innings and per face. */
    function surgeFresh(m, ii, face, ob, balls) {
        var log = m._surges || (m._surges = {});
        var seen = log[ii] || (log[ii] = {});
        if (seen[face] != null && ob - seen[face] < balls) return false;
        seen[face] = ob;
        return true;
    }
    /* The shape is the family's: the side, the figure, what qualifies it. The charge
     * and the squeeze share one sentence with different numbers, which is honest —
     * they are the same measurement with the inequality turned round. The collapse
     * leads with the wickets because that is what it is about.
     *
     * NO SCORE TAIL. The innings total is the strip's gold figure a few centimetres
     * away, and this family exists precisely because the strip cannot say the rest.
     *
     * WHO GETS THE CREDIT DEPENDS ON THE FACE, and this is the whole point of the
     * second clause. A charge and a collapse are the batters' — so the pair at the
     * crease closes the line, whosever match it is (the lean that gave it only to ours
     * left a division charge with nothing behind the figure at all). A SQUEEZE IS THE
     * BOWLERS', and naming the two men in while saying they have scored nothing reads
     * as an accusation; the news is the pair of bowlers who dried it up, with what
     * they went for through the window.
     * > James's direction, 2026-09-29. */
    /* THE VERB IS THE EVENT. "Have added 24 in 3 overs" is the arithmetic and could
     * be any of the three; "on a charge scoring 24 in 3 overs" is what happened, and
     * it holds up with no gold tile over it to name the type. In a chase the verb
     * changes again — a side "chasing 24 in 3 overs" is doing something to a target,
     * not merely scoring.
     *
     * NO GOLD ON THE FIGURE. It is a passage's runs, not a total — see the gold rule
     * on `batFig`. The same reason the squeeze's economies are in the plain type.
     * > James's direction, 2026-09-29. */
    /* A PASSAGE OF PLAY, in the score line's shape.
     *
     *   Tring Park on a charge chasing Chesham  ·  27 in 3 overs  ·  A Quill 34* …
     *   Being squeezed v Denham  ·  9 in 4 overs  ·  R Duff 1.2  F Pardoe 2.4 an over
     *   Denham collapse losing four for 12 in 3 overs  ·  W Vane 3–25
     *
     * WHO, WHAT KIND, AGAINST WHOM — then the figures. The charge and the squeeze used
     * to put the runs in the lead ("on a charge scoring 27 in 3 overs") and name
     * nobody they were against; they now read like the score line: the verb of the
     * innings ("chasing" takes its object, a first innings is "v"), a dot, and the
     * passage's own arithmetic as the next clause.
     * > James's direction, 2026-10-01 (SIM 16:25).
     *
     * The opposition follows the wall's rule (`clubTag`): never ours. Our own innings
     * drops its subject; theirs in our match is "chasing" with no object, the hole
     * being the lesser evil, as the score line has it. The COLLAPSE keeps its own
     * sentence — its figures are the news, so they stay in the lead. */
    function surgePayload(s, inn, sides, ours, ctx, inns) {
        var chase = chasing(inns), over = ' in ' + oversWord(s.balls);
        // The subject goes when the subject is us — the score line's rule, and for the
        // same reason: the opposition tag says which match this is.
        var mine = isOurPlayer(ctx, sides.bat);
        var subj = mine ? [] : [team(sides.bat || '')];
        var foeOurs = !sides.other || isOurPlayer(ctx, sides.other);
        var against = foeOurs ? []
            : chase ? [det('chasing'), team(sides.other)]
                    : clubTag(ctx, '', sides.other);
        var lead, figs = [];
        if (s.face === 'collapse') {
            lead = subj.concat([det(mine ? 'Collapse losing' : 'collapse losing'),
                                det(countedWord(s.wkts) + ' for ' + s.runs + over)])
                       .concat(clubTag(ctx, '', sides.other));
        } else {
            var word = s.face === 'squeeze' ? (mine ? 'Being squeezed' : 'being squeezed')
                                            : (mine ? 'On a charge' : 'on a charge');
            /* Theirs in our match, chasing us: the TARGET is the object, since we
             * are never named — "Chenies & Latimer on a charge chasing 241". Gold, as
             * the chase-start line sets it.
             * > James's direction, 2026-10-01. */
            var hole = chase && foeOurs && !mine ? [det('chasing'), chaseFigure(inns)] : [];
            lead = subj.concat([det(word)]).concat(hole).concat(against);
            /* THE WICKETS IN THE PASSAGE, said as the passage's — "for the loss of one
             * wicket". It used to be a clause of its own, "one down", which read as the
             * innings' total beside a scoreboard showing five.
             * > James's observation, 2026-10-01 (SIM poll 61). */
            figs = [SEP, det(s.runs + over + (s.wkts
                ? ' for the loss of ' + countedWord(s.wkts) + ' wicket' + (s.wkts === 1 ? '' : 's')
                : ''))];
        }
        /* WHOSE PASSAGE IT IS. A charge is the batters' and a squeeze is the bowlers';
         * a COLLAPSE is the bowlers' too — the men in are the ones it happened to, and
         * naming them under the word "collapse" reads as an accusation where the
         * wicket-takers' figures read as what did it. */
        var pair = creasePair(inn);
        var clause = s.face === 'charge' ? pairParts(pair) : bowlerParts(s, inn, s.face);
        if (!clause.length && s.face === 'collapse') clause = pairParts(pair);
        return say(lead.concat(figs).concat([SEP]).concat(clause),
                   (s.face === 'charge' && pair.length) ? { who: pair[0].name } : null);
    }
    /* THE BOWLERS A PASSAGE BELONGS TO, and what to say about each.
     *
     *   squeeze    R Duff 1.2  F Pardoe 2.4 an over   — what they went for
     *   collapse   W Vane 3–25  T Duff 1–9            — what they took
     *
     * Both are subtractions against the window's own anchor row, which is why they can
     * be stated at all: a card carries a bowler's running total and never says when
     * the runs were conceded, so his match economy through a quiet passage is mostly
     * made of the overs before it. The FIGURES quoted for a collapse are his match
     * figures, because a wicket-taker's figures are a total and that is the number a
     * reader wants — but WHICH bowlers is still decided by the window.
     *
     * AN OVER EACH AT LEAST for the squeeze: a man who bowled two balls of it is not
     * what happened, and an economy off two balls is noise. A collapse takes anyone
     * who got a wicket in the window, which is the whole point of him being there.
     * Empty for the division's feed, which carries no bowling at all. */
    function bowlerParts(s, inn, face) {
        var was = (s.anchor && s.anchor.bw) || null;
        if (!was) return [];
        var rows = [];
        ((inn && inn.bowling) || []).forEach(function (b) {
            if (!b || !b.name) return;
            var w = was[b.name] || { b: 0, r: 0, w: 0 };
            var db = balls(b.overs) - w.b, dr = (b.runs || 0) - w.r,
                dw = (b.wickets || 0) - (w.w || 0);
            if (face === 'collapse') {
                if (dw > 0) rows.push({ name: b.name, rank: dw,
                                        fig: figuresOf(b.wickets, b.runs), gold: true });
            } else if (db >= 6 && dr >= 0) {
                rows.push({ name: b.name, rank: db, fig: (dr / (db / 6)).toFixed(1) });
            }
        });
        if (!rows.length) return [];
        rows.sort(function (a, b) { return b.rank - a.rank; });
        var out = [];
        rows.slice(0, 2).forEach(function (r) {
            out.push({ cls: 'bat', text: r.name });
            // Gold is for totals: a collapse quotes match figures, a squeeze quotes
            // what the window cost — and only the first of those is one.
            out.push(r.gold ? { cls: 'score', text: r.fig } : det(r.fig));
        });
        if (face === 'squeeze') out.push(det('an over'));
        return out;
    }
    /* THE TWO BOWLERS WHO DID THE SQUEEZING, and what they went for while doing it.
     *
     *   R Duff 1.2 and F Pardoe 2.4 an over
     *
     * Both figures are subtractions against the window's own anchor row, which is why
     * they can be stated at all: a card carries a bowler's running total and never
     * says when the runs were hit, so his match economy through a quiet passage is the
     * wrong number — it is mostly made of the overs before it.
     *
     * AN OVER EACH AT LEAST. A man who bowled two balls of the window is not what
     * happened in it, and his economy off two balls is noise. Ranked by how much of the
     * window each one bowled, which for a normal spell is the two men who bowled all
     * of it. Empty for the division's feed, which carries no bowling at all. */


    /* THE FLOOR'S ONE LINE, both feeds. Lead, clause, tail — and the clause is chosen
     * in the order a reader would miss it:
     *
     *   1. THE BOUNDARIES JUST HIT. The only candidate that is news rather than
     *      standing context, and the reason the floor is worth a screen mid-passage.
     *   2. THE STAND. What these two have put on, which is the shape of the passage
     *      the two names in the lead are in.
     *   3. THE PASSAGE. Runs and wickets over the last few overs — the clause that
     *      works off a bare scoreline, and so the division's normal one.
     *
     * The chase left this line altogether. "Need 47 from 60" was rank two of the old
     * order and it is now three tiles of the strip's own chase block, in figures a
     * room can read; saying it again in prose beside them was the duplication this
     * pass is about. Same for the side still to bat, which is the strip's TO BAT tile.
     *
     * WITH NOTHING TO SAY, SAY WHOSE GAME IT IS. A first sighting has no history to
     * subtract and a division card has nobody to name, so the fallback is the fixture
     * and its division — the one line that is worth more than a club on its own. */
    /* THE BATTING SIDE LEADS AND THE PAIR CLOSES, which is the shape the whole
     * family settled into on 2026-09-29.
     *
     *   Denham batting  ·  W Fairhead 4* and A Quill 0*
     *   Denham batting partnership of 17  ·  W Fairhead 12* and A Quill 5*
     *   High Wycombe batting v Maidenhead & Bray  ·  16–0 in the last 2 overs
     *   W Fairhead moves to 9, a four for Denham
     *
     * The pair used to lead and the club trail as "Denham batting". Reading it aloud
     * the sentence started in the middle: two names arrive with no idea whose they
     * are, and the answer comes six words later. Whose innings this is, then what it
     * is doing, then who is doing it, is the order a person says it in.
     *
     * A BURST OF BOUNDARIES IS ONE MAN'S LINE and takes the whole of it. When a single
     * batter hit everything this poll brought, the news is him — "W Fairhead moves to
     * 9, a four for Denham" — and the pair would only restate his figure a phrase
     * later. Two batters sharing the burst still get the counted version, because
     * naming one of them for his partner's boundary is the small lie the counted
     * version was written to avoid.
     *
     * THE OPPONENT IS NAMED ONLY WHEN THE PAIR CANNOT BE. Two names identify our own
     * match on a wall showing three; the division's card has nobody to name, so its
     * line says "batting v" and carries the fixture instead. */
    function scorePayload(m, ctx, sides, inn, ii, ob, delta, inns) {
        var pr = creasePair(inn), club = sides.bat || '', d = delta || {};
        if (club && d.who && d.movers === 1 && (d.fours > 0 || d.sixes > 0)) {
            // The comma is its own part and glues to the figure before it, so the
            // figure keeps the scoreline's gold and the punctuation does not.
            return say([{ cls: 'bat', text: d.who }, det('moves to'),
                        { cls: 'score', text: String(d.whoRuns || 0) },
                        det(', ' + boundaryPhrase(d.fours, d.sixes))]
                       // His club, or theirs if his is ours — see `clubTag`.
                       .concat(clubTag(ctx, club, sides.other)),
                       { who: d.who });
        }
        if (!club) return say(fixtureParts(m, ctx).concat([SEP, det(ctx.division, true)]));
        var stand = pr.length ? partnershipRuns(inn) : null, clause = '', lead;
        if (stand != null && stand >= STAND_MIN) {
            /* THE PARTNERSHIP IS THE SUBJECT, so the club comes off the front of it:
             * "Opening partnership of 17 for Denham" says whose it is in the phrase
             * that can be dropped, where "Denham batting partnership of 17" spent the
             * strong word on a club the pair behind it will identify anyway. */
            lead = [det(capitalise(standName(inn))), det('partnership of'),
                    { cls: 'score', text: String(stand) }]
                   .concat(clubTag(ctx, club, sides.other));
        } else {
            /* NOTHING TO SAY ABOUT THE STAND: the verb the innings is in leads
             * instead — "batting", or "chasing" in the second innings, which is the
             * one word that says which half of the match this is.
             *
             * WHOSE INNINGS IT IS, UNLESS IT IS OURS. Every other line on this wall
             * names the opposition and never us (see `clubTag`), and this one was the
             * exception only because the club is its grammatical subject. Dropping the
             * subject is what the rest of the rule implies: "Chasing Denham" says
             * whose chase it is by saying whose it is not, and the pair behind it
             * names the two men in.
             * > James's direction, 2026-09-29. */
            var verb = chasing(inns) ? 'chasing' : 'batting';
            lead = isOurPlayer(ctx, club)
                ? [det(capitalise(verb))]
                : [team(club), det('are ' + verb)];
            /* AND THE SIDE ON THE OTHER END OF IT. A chase names them either way —
             * "chasing" is transitive and an object-less one is a sentence with a hole
             * in it — and when they are us, the first innings' total stands in for
             * them: "Chenies & Latimer are chasing 247".
             *
             * A first innings names them when there is no pair to identify the match
             * (the division's line) or when the subject has just been dropped, so our
             * own innings always says which game it is. Discretionary once the pair is
             * there to say it anyway. */
            var other = (sides.other && !isOurPlayer(ctx, sides.other))
                ? dropCC(sides.other) : '';
            if (other && (chasing(inns) || !pr.length || isOurPlayer(ctx, club))) {
                var tag = chasing(inns) ? [team(other)] : [det('v'), team(other)];
                if (pr.length) tag.forEach(function (x) { if (x) x.drop = true; });
                lead = lead.concat(tag);
            } else if (chasing(inns) && !isOurPlayer(ctx, club)) {
                /* THE HOLE FILLED: chasing us, the first innings' total is the object
                 * — "Chenies & Latimer are chasing 247" — as on every other chase line
                 * (`chaseFigure`). > James's direction, 2026-10-01. */
                lead = lead.concat([chaseFigure(inns)]);
            }
            clause = (d.fours > 0 || d.sixes > 0)
                ? capitalise(boundaryPhrase(d.fours, d.sixes))
                : passageClause(m, ii, ob, inn);
        }
        return say(lead.concat([SEP, det(clause, true), SEP]).concat(pairParts(pr)),
                   pr.length ? { who: pr[0].name } : null);
    }
    // Is this the second innings — the one being chased? Both feeds deliver innings in
    // batting order, so the count is the answer.
    function chasing(inns) { return (inns || []).length === 2; }
    /* WHOSE PLAYER IS THIS? The match is ours; the person in the sentence may not be.
     *
     * Every individual event on our own feed can be about either side — their opener
     * reaching fifty against us is the same diff as ours reaching one — and the strip's
     * footer says "1st XI", so a bare name reads as one of ours whoever it belongs to.
     * So the club is named in the tail, and the answer to this question also decides
     * how much of the person's innings the band spells out: more for ours, less for
     * theirs (see the payload builders below).
     *
     * Unresolvable is taken as NOT ours. The lean is a courtesy to our own players,
     * and claiming one on a guess is the one way it could be wrong in public. */
    function ourClub(ctx) { return ctx.ours ? (dropCC(ctx.our_club || '') || 'Wendover') : ''; }
    function isOurPlayer(ctx, club) {
        var our = ourClub(ctx);
        return !!(our && club && dropCC(club).toLowerCase() === our.toLowerCase());
    }
    /* WHICH CLUB A LINE NAMES — AND IT IS NEVER OURS.
     *
     *   "F Pardoe into the attack for Wendover"   → v Denham
     *   "S Moulton to the crease v Wendover"      → for Denham
     *
     * The strip's footer already says which of our XIs this is, so our own name in the
     * sentence spends the one club slot on the thing the reader has and leaves the
     * match unidentified — and on a wall carrying three of our sides at once, the
     * OPPOSITION is the word that says which game you are looking at. So every phrase
     * that names a club on one of our matches names theirs.
     *
     * THE PREPOSITION FOLLOWS FROM WHOSE PLAYER IT IS, which is what keeps the
     * sentence true either way: his own club takes "for", the side he is up against
     * takes "v". One rule, read off which of the two names we are allowed to print.
     *
     * Nothing to name at all yields nothing — an unresolved side is not worth a guess,
     * and `say()` drops the empty group.
     * > James's direction, 2026-09-29. */
    function clubTag(ctx, his, foe, forWord, vWord) {
        /* AND IT IS DISCRETIONARY. `drop` marks both parts as the first thing the band
         * gives up when the line will not fit (see `fit` in live-ticker.html): the
         * opposition is what identifies the match, which is worth saying and is never
         * worth truncating the news to say. The phrase is written either way and the
         * surface decides, because only the surface knows how wide the names are.
         * > James's direction, 2026-09-29. */
        var mark = function (parts) {
            parts.forEach(function (x) { if (x) x.drop = true; });
            return parts;
        };
        if (his && !isOurPlayer(ctx, his)) {
            return mark([det(forWord || 'for'), team(dropCC(his))]);
        }
        if (foe && !isOurPlayer(ctx, foe)) {
            return mark([det(vWord || 'v'), team(dropCC(foe))]);
        }
        return [];
    }

    /* THE TAIL ON AN INDIVIDUAL EVENT: the batting side and where it has left them.
     *
     * One rule for a batter and for a bowler, deliberately — the tail always names the
     * side that is BATTING, so "J Harrington 54 · Wendover 104/2" is his own side and
     * "W Vane 5-21 · Chenies & Latimer 74/5" is the side he is running through. A
     * reader meets the rule twice and has it; two rules would need reading each time.
     *
     * It does two jobs for the length of one. It says whose player this is — the thing
     * the strip's "1st XI" footer cannot, since both sides' players come off the same
     * feed — and it says what state the innings is in, which is the "why now".
     *
     * NO OVERS AND NO GOLD. The overs are on the strip a few centimetres up and the
     * line is already carrying a figure; the one gold number per line should be the
     * news, which here is the person's. So the club takes the batting side's strong
     * type and the figure recedes behind it, exactly as "Chenies & Latimer to bat"
     * does on a score. */
    function sideScoreTail(club, inn) {
        if (!club || !inn) return null;
        return [team(club), det((inn.runs || 0) + '/' + (inn.wickets || 0))];
    }

    /* A BATTER'S FIFTY OR HUNDRED — a person, not a row of a scorecard.
     *
     *   J Harrington 54  ·  from 44 balls, 7 fours and a six  ·  Wendover 104/2
     *
     * The old line was "J Harrington 54 (44) · Fifty for Wendover CC", which said
     * FIFTY a second time under a gold tile already shouting it, wrote the club with
     * its CC where the rest of the wall drops it, and spent its only clause on the
     * one fact the reader had. The three phrases now each say something new: who and
     * how many, how he got there, and what it has done for his side.
     *
     * THE MIDDLE CLAUSE IS WHERE THE LEAN LIVES. Ours gets the shape of the innings —
     * the balls and the boundaries, which is the difference between an hour of
     * blocking and a counter-attack; theirs gets the balls and stops. Both are true,
     * and the choice of how much to say is the one place a club's own wall is allowed
     * a preference. It is also the clause that ellipsises when the line is long, so
     * the extra detail is spent in the phrase that can afford to lose it.
     *
     * The balls figure is omitted rather than faked when the card has none — a
     * milestone "from 0 balls" is a gap in the feed dressed up as a scoring rate. */
    function milestonePayload(b, mark, inn, sides, ctx, mine) {
        /* THE SENTENCE SAYS THE MILESTONE, and the tile is no longer trusted to. The
         * line was "A Quill 52 · from 50 balls · Denham 83/1" — a figure and two
         * qualifications, which only becomes a fifty if you are reading the gold tile
         * as the subject of the sentence. The tile goes back to the team and division
         * before this ships, so every line has to stand up alone.
         * > James's direction, 2026-09-29. */
        var bits = [];
        if (mine) {
            if (b.balls) bits.push('from ' + b.balls + ' balls');
            var shots = boundaryPhrase(b.fours || 0, b.sixes || 0);
            if (shots) bits.push(shots);
        }
        // ONE PHRASE, not two: "reaches a fifty for Denham from 50 balls" is a
        // sentence, where the dot made the balls a separate fact about a number the
        // line had not yet given. The opposition tag is the first thing to go when
        // that phrase will not fit — which on this line it often will not.
        return say([{ cls: 'bat', text: b.name },
                    det('reaches a ' + (MARK_WORDS[mark] || 'milestone'))]
                   .concat(clubTag(ctx, sides.bat, sides.other))
                   .concat([det(bits.join(', '), true),
                            SEP]).concat(pairOf(inn)),
                   { who: b.name });
    }

    /* A BOWLER'S FIFTH — the same three phrases, read from the other end.
     *
     *   W Vane 5-21  ·  9 overs, two maidens  ·  Chenies & Latimer 74/5
     *
     * The figures are the result panel's own `wickets-runs` with an en dash, as
     * `dismissalText` already writes them, so a bowler's figures look the same in
     * every phrase on this wall. What the figures do NOT carry is how long it took
     * him and how much of it he gave nothing away in, which is what the middle clause
     * is for — and, for one of ours, the maidens are the part of a five-for a club
     * actually retells.
     *
     * Overs stay numeric and maidens are worded, which looks inconsistent and is not:
     * "9 overs" is a scorecard figure a reader wants to read as a figure, while "two
     * maidens" is prose. Same rule as the boundaries a line above. */
    function fiveForPayload(bw, inn, sides, ctx, mine) {
        /* HIS OWN CLUB, not the side he is running through. Every other line here
         * names the batting side, and a five-for is the one place that reads wrong:
         * the news is a bowler's afternoon, so the club in the sentence is his.
         * "A fiver" is what the dressing room calls it.
         * > James's direction, 2026-09-29. */
        var bits = [];
        if (bw.overs != null && bw.overs !== '') bits.push('off ' + bw.overs + ' overs');
        if (mine && (bw.maidens || 0) > 0) {
            bits.push(countWord(bw.maidens) + ' maiden' + (bw.maidens === 1 ? '' : 's'));
        }
        return say([{ cls: 'bat', text: bw.name }, det('takes a fiver')]
                   .concat(clubTag(ctx, sides.other, sides.bat))
                   .concat([SEP, { cls: 'score', text: figuresOf(bw.wickets, bw.runs) },
                            det(bits.join(', '), true)]),
                   { who: bw.name });
    }
    /* WHO IS AT THE OTHER END — the not-out batter who is not this one.
     *
     * `at_crease` where the card carries it, because that is the feed's own answer;
     * otherwise the not-out batters who have faced a ball, which is the same set
     * derived. A partner we cannot identify yields nothing and the clause is simply
     * not written, rather than naming whoever happens to be first in the list. */
    /* ---- SPELLS: the one thing a scorecard knows that it never says ------------
     *
     * A bowling card carries a running total per bowler and nothing else — no spells,
     * no ends, no "1st change". But a spell is derivable from the one figure it does
     * carry, because of how cricket is arranged: a bowler in a spell bowls every
     * OTHER over. So his over count standing still while the innings advances by two
     * overs means he has been taken off, and it means it at the exact moment the room
     * notices — the over he would have bowled and did not.
     *
     * TWELVE BALLS IS THE RULE, and it is not a fudge factor. It is one over from each
     * end: the over he did not bowl, plus the one from the other end that proves the
     * game moved on rather than stopped. Eleven would fire mid-over on a guess; a
     * whole eighteen would report the change an over after everybody in the ground had
     * seen it.
     *
     * WHAT THIS CANNOT SEE, stated so nobody looks for it later:
     *   - A CHANGE OF ENDS reads as one spell, because the card has no ends in it.
     *   - THE LAST SPELL OF AN INNINGS never ends, because the innings stops advancing
     *     and the clock this runs on is the innings' own over count. The innings
     *     closing is the news at that point and it has its own type.
     *   - A SPELL THAT SPANS A BREAK is one spell, which is right: tea does not take a
     *     bowler off.
     *
     * The state rides on the CARD, the way `_received_at` does — the engine holds this
     * poll's card as the next poll's `prev`, so a map stamped here is a map we have
     * next time. It is one object per match, keyed by innings and bowler, and it
     * carries where the spell began so that its own figures can be subtracted out of
     * his running total at the end.
     */
    var SPELL_GAP_BALLS = 12;
    function trackSpells(prevMap, m) {
        var map = {}, moves = [], strikes = [];
        (m.innings || []).forEach(function (inn, ii) {
            var innBalls = balls(inn.overs);
            var key = String(inn.innings_id != null ? inn.innings_id : ii);
            /* AN INNINGS WE HAVE NEVER TRACKED SAYS NOTHING. Its bowlers are all
             * "new" against an empty map, so a first poll — or a scorer publishing an
             * innings late — would announce four bowling changes at once for overs
             * nobody watched us miss. Seed the map and wait for the next poll, which
             * is the same rule the wickets follow one block up, applied where it
             * cannot be softened: a spell needs a history by definition. */
            var known = false;
            for (var k in (prevMap || {})) { if (k.indexOf(key + '|') === 0) { known = true; break; } }
            (inn.bowling || []).forEach(function (bw) {
                if (!bw || !bw.name) return;
                var id = key + '|' + bw.name;
                var now = { balls: balls(bw.overs), runs: bw.runs || 0,
                            wickets: bw.wickets || 0, maidens: bw.maidens || 0 };
                var was = (prevMap || {})[id];
                if (!was) {
                    // First sight of him in this innings. His spell began where his
                    // figures were before the over he is in — nothing, for a bowler
                    // opening his account.
                    map[id] = { balls: now.balls, runs: now.runs, wickets: now.wickets,
                                maidens: now.maidens, at: innBalls, done: false,
                                start: { balls: 0, runs: 0, wickets: 0, maidens: 0, dm: 0 },
                                dm: 0,
                                /* NO DELIVERY HISTORY ON FIRST SIGHT, which is also
                                 * the whole guard the hat-trick needs: a scorer who
                                 * publishes an innings with three already to one
                                 * bowler gives us an empty `hist`, so nothing is
                                 * claimed about balls we never watched. */
                                hist: [], on: null };
                    /* AN OPENING BOWLER IS NOT A CHANGE. The pair who start an
                     * innings take the new ball together, and only one of them is in
                     * the card after the first over — so the other turns up as a
                     * brand-new bowler on the second and would be announced as though
                     * the captain had rung a change after six balls. Anyone whose
                     * first over is one of the innings' first two opened the bowling,
                     * which is news the innings starting has already carried. */
                    if (known && innBalls - now.balls >= SPELL_GAP_BALLS) {
                        moves.push({ kind: 'start', ii: ii, name: bw.name,
                                     first: true, before: map[id].start, now: now });
                    }
                    return;
                }
                var rec = { balls: now.balls, runs: now.runs, wickets: now.wickets,
                            maidens: now.maidens, at: was.at, done: was.done,
                            start: was.start, hist: was.hist || [], on: was.on,
                            dm: was.dm || 0 };
                /* ---- HIS LAST FEW DELIVERIES, as a list of poll deltas.
                 *
                 * This is the whole hat-trick mechanism and it needs nothing the card
                 * does not already carry. A hat-trick is three wickets in three
                 * consecutive deliveries BY ONE BOWLER, and if a run of consecutive
                 * polls sums to three balls and three wickets then every delivery in
                 * that run took a wicket — so they were consecutive, necessarily. No
                 * ball-by-ball feed required.
                 *
                 * A poll in which he did not bowl adds nothing and CLEARS nothing: a
                 * bowler between overs keeps his two-in-two, which is exactly what the
                 * Laws say (consecutive deliveries by him, not consecutive balls of
                 * the match). Wides are invisible here because the over count counts
                 * legal deliveries only — and that is right too, since a wide does not
                 * break a hat-trick.
                 *
                 * A COUNTER GOING BACKWARDS IS A CORRECTION, not cricket, and the
                 * history is thrown away rather than reasoned about. */
                var db = now.balls - was.balls, dw = now.wickets - was.wickets;
                var dr = now.runs - was.runs;
                if (db < 0 || dw < 0 || dr < 0) rec.hist = [];
                else if (db > 0) rec.hist = rec.hist.concat([{ b: db, w: dw, r: dr }]);
                rec.hist = trimHist(rec.hist);
                /* THREE IN THREE. Tested before the two-in-two below, which would
                 * otherwise fire on the same poll off the last two balls of it. */
                var three = suffixOf(rec.hist, 3);
                var got = three.b === 3 && three.w === 3;
                if (known && got) {
                    strikes.push({ kind: 'hat', ii: ii, name: bw.name, now: now });
                    rec.on = null;
                }
                /* HAS THE HAT-TRICK BALL BEEN BOWLED? `on` is his ball count when we
                 * announced the two-in-two, so his bowling again resolves it — and if
                 * the hat-trick did not fire on this poll, it resolved the other way
                 * and the band is holding a sentence that has stopped being true.
                 * That is a RETRACTION: see the `miss` strike, which un-says it
                 * without saying anything. */
                if (was.on != null && now.balls > was.on) {
                    /* RETRACT ONLY WHAT WE CAN PROVE. A poll with no wicket in it at all
                     * proves the hat-trick ball was survived, and the sentence goes.
                     *
                     * A poll that spans two balls and brought one wicket does not: it
                     * may have been the hat-trick ball or the one after it, and the
                     * suffix test — which needs three balls and three wickets exactly —
                     * cannot separate them, so no hat-trick was claimed either. Both
                     * halves stay honest by saying nothing, and the two-minute ttl is
                     * what clears the pending line. Retracting here would be as much a
                     * guess as claiming it.
                     *
                     * The wickets themselves are unaffected: each dismissal has already
                     * had its own event, so the room is under-informed rather than
                     * misinformed. */
                    if (!got && known && dw === 0) {
                        strikes.push({ kind: 'miss', ii: ii, name: bw.name });
                    }
                    rec.on = null;
                }
                /* ---- MAIDEN OVERS, and they need nothing but the two counters we
                 * already trust.
                 *
                 * A maiden is six legal deliveries of his for no runs. `maidens` is a
                 * real field on the raw RV bowling row, but whether it populates DURING
                 * play is unverified — and it turns out not to matter, because his own
                 * runs and balls answer the question outright. That is the better
                 * source anyway: the same two numbers the band already quotes as his
                 * figures, rather than a third that could disagree with them.
                 *
                 * HIS BALL COUNT IS ALWAYS A MULTIPLE OF SIX AT AN OVER BOUNDARY, since
                 * a bowler bowls whole overs, so a suffix of exactly six of his
                 * deliveries IS the over he has just finished — no alignment guesswork.
                 * Wides are invisible to the ball count and counted in the runs, which
                 * is exactly right: an over with a wide and nothing else is not a
                 * maiden and this says so.
                 *
                 * AND IT WORKS AT EITHER CADENCE, unlike the hat-trick. At one poll an
                 * over his delta is six balls outright; at fifteen seconds the deltas
                 * are a ball each and sum to six at the boundary. A straddled poll
                 * (balls five to eight) cannot land on six and says nothing.
                 *
                 * A RUN OF THEM is the same test at twelve, eighteen and twenty-four —
                 * no counter to keep, and the same refusal to guess if the window
                 * cannot be landed. Four overs is as far back as `hist` reaches. */
                /* IT MUST BE THE POLL HE FINISHED THE OVER ON. `balls % 6 === 0` is a
                 * standing state, not a transition: while the other end bowls, his
                 * count sits on the boundary and the test answers yes on every poll of
                 * the next four minutes. The store's id de-duplication hid this — the
                 * event carries his ball count, so the repeats collapsed — but an
                 * extractor emitting a maiden thirty times is wrong on its own terms.
                 * `db > 0` is the transition. */
                if (known && db > 0 && now.balls % 6 === 0 && now.balls >= 6) {
                    var mrun = 0, over6 = null;
                    for (var mk = 1; mk <= MAIDEN_RUN_MAX; mk++) {
                        var mx = suffixOf(rec.hist, mk * 6);
                        if (mx.b !== mk * 6 || mx.r !== 0) break;
                        mrun = mk;
                        if (mk === 1) over6 = mx;
                    }
                    if (over6) {
                        /* AND COUNT IT. `spell_ended` used to read the feed's own
                         * `maidens` column for its "two maidens" clause, which is the
                         * one field in this whole file whose live population is
                         * unverified — so a spell's maidens either worked or silently
                         * never appeared, and we could not tell which from here. A
                         * count of the maidens we have PROVED is a number we can stand
                         * behind, and it degrades the way everything else here does:
                         * overs bowled before we were watching are not in it. */
                        rec.dm++;
                        strikes.push({ kind: 'maiden', ii: ii, name: bw.name, now: now,
                                       wkts: over6.w, run: mrun,
                                       run_wkts: suffixOf(rec.hist, mrun * 6).w });
                    }
                }
                if (known && !got) {
                    var two = suffixOf(rec.hist, 2);
                    if (two.b === 2 && two.w === 2 && was.on == null) {
                        strikes.push({ kind: 'two', ii: ii, name: bw.name, now: now });
                        rec.on = now.balls;
                    }
                }
                // The moves below quote `now`, and the derived count has to travel with
                // it: the record is what the next poll diffs, the move is what is said.
                now.dm = rec.dm;
                if (now.balls > was.balls) {
                    /* He has bowled. A long enough gap BEHIND him makes this the
                     * first over of a new spell, and the figures he carried into it
                     * are the ones he had a moment ago.
                     *
                     * The gap is measured to where the innings stood when he STARTED
                     * this over, not where it stands now — his own deliveries have
                     * moved the innings' count along with his, so comparing the two
                     * current figures counts his own over as part of the gap. Left
                     * that way, an ordinary rotation at one poll an over reads as a
                     * fresh spell every second over: six balls of his plus six from
                     * the other end is exactly the twelve the rule is looking for. */
                    var opened = innBalls - (now.balls - was.balls);
                    if (opened - was.at >= SPELL_GAP_BALLS) {
                        /* `dm` is taken from `was`, BEFORE the over just bowled was
                         * counted above — so a maiden that is itself the first over of
                         * a new spell belongs to the new spell, which is where it was
                         * bowled. */
                        rec.start = { balls: was.balls, runs: was.runs,
                                      wickets: was.wickets, maidens: was.maidens,
                                      dm: was.dm || 0 };
                        rec.done = false;
                        if (known) moves.push({ kind: 'start', ii: ii, name: bw.name,
                                                first: false, before: rec.start, now: now });
                    }
                    rec.at = innBalls;
                } else if (!was.done && innBalls - was.at >= SPELL_GAP_BALLS) {
                    // He has been taken off: the over he would have bowled has gone by.
                    rec.done = true;
                    if (known) moves.push({ kind: 'end', ii: ii, name: bw.name,
                                            before: was.start, now: now });
                }
                map[id] = rec;
            });
        });
        return { map: map, moves: moves, strikes: strikes };
    }
    /* Keep only as much of a bowler's delivery history as any test can reach — six
     * balls is twice the longest window and one over of his, which is plenty. */
    // How long a run of maidens the band will count, which is also how far `hist`
    // has to reach. Four is already a passage of play nobody in the ground will forget.
    var MAIDEN_RUN_MAX = 4, MAIDEN_RUN_NEWS = 3;
    var HIST_BALLS = MAIDEN_RUN_MAX * 6;
    function trimHist(hist) {
        var b = 0, cut = 0;
        for (var i = hist.length - 1; i >= 0; i--) {
            b += hist[i].b;
            if (b >= HIST_BALLS) { cut = i; break; }
        }
        return cut ? hist.slice(cut) : hist;
    }
    /* THE LAST `want` DELIVERIES, accumulated backwards out of the poll deltas. It
     * stops as soon as it has enough balls, so the caller can ask whether it landed on
     * exactly the window it wanted: a suffix of 3 balls and 3 wickets is a hat-trick,
     * where 6 balls and 3 wickets is three wickets in an over and says nothing about
     * which three deliveries they came off. Refusing that case is the honesty in this
     * whole mechanism. */
    function suffixOf(hist, want) {
        var b = 0, w = 0, r = 0;
        for (var i = (hist || []).length - 1; i >= 0; i--) {
            b += hist[i].b; w += hist[i].w; r += hist[i].r || 0;
            if (b >= want) break;
        }
        return { b: b, w: w, r: r };
    }

    /* A bowler's figures the way the rest of the wall writes them — `wickets-runs`
     * with an en dash, as `_bowl_highlight` does in build.py. */
    function figuresOf(w, r) { return (w || 0) + '\u2013' + (r || 0); }
    // "6 overs", "6.3 overs", "1 over" — a ball count written the way a scorecard
    // writes one, with the plural it earns.
    function oversWord(b) {
        var t = b % 6 ? (Math.floor(b / 6) + '.' + (b % 6)) : String(b / 6);
        return t + (b === 6 ? ' over' : ' overs');
    }

    /* A BOWLER COMING ON.
     *
     *   T Duff into the attack  ·  1-9 from four overs so far  ·  Wendover 78/5
     *
     * "Into the attack" is the phrase the game itself uses, and it is the whole news:
     * the captain has changed something. The middle clause is what he brings with
     * him and only exists for a bowler returning — a man opening his account has no
     * figures, and inventing a clause to fill the slot would be filler.
     *
     * The tail is the batting side, as it is on every individual event: on a bowling
     * change it says who he is being brought on AGAINST, and what they have made of
     * the afternoon so far. */
    function spellStartPayload(mv, inn, sides, ctx, mine) {
        var sofar = mine && !mv.first && mv.before.balls
            ? figuresOf(mv.before.wickets, mv.before.runs) + ' from ' +
              oversWord(mv.before.balls) + ' so far' : '';
        /* WHO HE IS BOWLING AT, and then the two men he will be bowling at. The tail
         * was the batting side's score — "Denham 23/0" — which is the strip's gold
         * figure repeated in small type; the pair is the half of that state the strip
         * has no room for, and it is what a bowling change is actually about.
         * > James's direction, 2026-09-29. */
        return say([{ cls: 'bat', text: mv.name },
                    det((mv.first ? 'into' : 'back into') + ' the attack')]
                   .concat(clubTag(ctx, sides.other, sides.bat))
                   .concat([SEP, det(sofar, true),
                            SEP]).concat(pairOf(inn)),
                   { who: mv.name });
    }

    /* A SPELL ENDING, which is the one individual event that arrives finished.
     *
     *   T Duff 3-19  ·  seven overs, two maidens  ·  Chenies & Latimer 74/5
     *
     * THE FIGURES ARE THE SPELL'S, not the match's, because the spell is what just
     * ended — his running total is a different fact and will be on the scorecard all
     * evening. Where the two differ the clause says so rather than leaving a reader
     * to wonder which they are looking at; where they are the same, which is most
     * spells, nothing is said and nothing needs to be.
     *
     * The overs are worded here where a five-for's are numeric, and the difference is
     * real: "nine overs" in a five-for qualifies a figure the reader is already
     * reading as a scorecard line, while a spell is being described rather than
     * tabulated. Past three they go back to numerals, as everything else on the band
     * does. */
    function spellEndPayload(mv, inn, sides, ctx, mine) {
        var sp = {
            balls: mv.now.balls - mv.before.balls,
            runs: mv.now.runs - mv.before.runs,
            wickets: mv.now.wickets - mv.before.wickets,
            /* THE MAIDENS WE WATCHED HIM BOWL, not the feed's column — see the maiden
             * detection in `trackSpells` for why a derived count is the sounder of the
             * two, and `dm` for what it is. */
            maidens: (mv.now.dm || 0) - ((mv.before && mv.before.dm) || 0)
        };
        var bits = ['off ' + oversWord(sp.balls)];
        if (mine && sp.maidens > 0) {
            bits.push(countWord(sp.maidens) + ' maiden' + (sp.maidens === 1 ? '' : 's'));
        }
        /* GOLD IS FOR TOTALS, and a spell's figures are an increment — what he did in
         * the last half hour, not what he has. So the spell reads in the plain type
         * and the gold goes on his MATCH figures, which is also the honest ordering of
         * the two: where he has bowled before, "0–16 off 3 overs" is the news and
         * "0–26" is what it has left him on. Where this was his only spell the two are
         * the same number, said once, and it is a total.
         * > James's direction, 2026-09-29. */
        var again = !!mv.before.balls;
        var figs = again
            ? [det(figuresOf(sp.wickets, sp.runs)), det(bits.join(', ') + ',', true),
               { cls: 'score', text: figuresOf(mv.now.wickets, mv.now.runs) }, det('in all')]
            : [{ cls: 'score', text: figuresOf(sp.wickets, sp.runs) },
               det(bits.join(', '), true)];
        return {
            payload: say([{ cls: 'bat', text: mv.name }, det('finishes his spell')]
                         .concat(clubTag(ctx, sides.other, sides.bat))
                         .concat([SEP]).concat(figs),
                         { who: mv.name }),
            // How much of an afternoon this was. Wickets carry it — three in a spell
            // is the best thing a bowler does in a league match — with a nod to the
            // maidens, which is the other way a spell is remembered.
            magnitude: Math.min(1, (sp.wickets / 3) + (sp.maidens > 0 ? 0.15 : 0)),
            overs: sp.balls / 6
        };
    }

    /* THE THREE MEN HE GOT, which is exactly derivable and better than any adjective.
     *
     * The last three dismissals of the innings ARE his three, and not by assumption: a
     * run-out or a wicket at the other end in the middle of the sequence would have
     * advanced his ball count without a wicket to his name, which breaks the suffix and
     * means no hat-trick was claimed in the first place. So if we are here, the three
     * most recent falls are his.
     *
     * Checked against his name all the same, and dropped rather than guessed if the
     * check fails — a scorer's spelling can move between polls, and three names that
     * are not the right three is a worse line than no names at all. */
    function hatVictims(inn, pinn, name) {
        var all = dismissalsOf(inn, pinn);
        if (all.length < 3) return [];
        var last = all.slice(-3);
        for (var i = 0; i < last.length; i++) {
            var b = bowlerOf(last[i].how);
            if (!b || b !== name) return [];
        }
        return last.map(function (d) { return d.name; });
    }
    // "A, B and C" — a list as a sentence writes one.
    function andList(names) {
        if (!names || !names.length) return '';
        if (names.length === 1) return names[0];
        return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    }
    /* A HAT-TRICK.
     *
     *   T Duff 3-19  ·  B Duff, C Godden and H Godden  ·  Chenies & Latimer 74/5
     *
     * WORDING PROVISIONAL — the whole stream's text is a later pass.
     *
     * The clause is the three batters rather than the words "three in three", because
     * the tile already says HAT-TRICK and the L-frame's one rule is that the bar does
     * not repeat it. It is also the better half of the story: which three, and in what
     * state that left the innings.
     *
     * The figures are his MATCH figures, not the spell's. A hat-trick is not a spell
     * ending and the three wickets are in the number either way, so the simpler fact is
     * the honest one here. */
    function hatTrickPayload(mv, inn, pinn, sides, ctx) {
        // Not in the simulation, so it is written to the same intent as the rest: the
        // sentence says what happened, the club is the discretionary tag, and the
        // batting side's running total is the strip's business.
        return say([{ cls: 'bat', text: mv.name }, det('takes a hat-trick')]
                   .concat(clubTag(ctx, sides.other, sides.bat))
                   .concat([SEP, { cls: 'score', text: figuresOf(mv.now.wickets, mv.now.runs) },
                            det(andList(hatVictims(inn, pinn, mv.name)), true)]),
                   { who: mv.name });
    }
    /* TWO IN TWO — the one line on the wall about a ball that has not been bowled.
     *
     *   T Duff 2-14  ·  on a hat-trick  ·  Chenies & Latimer 74/5
     *
     * The tile carries the fact and this carries what it means, which is the only way
     * round that leaves both something to say. */
    function onAHatTrickPayload(mv, inn, sides, ctx) {
        return say([{ cls: 'bat', text: mv.name }, det('is on a hat-trick')]
                   .concat(clubTag(ctx, sides.other, sides.bat))
                   .concat([SEP, { cls: 'score', text: figuresOf(mv.now.wickets, mv.now.runs) }]),
                   { who: mv.name });
    }

    /* ---- A TEAM TOTAL PASSING A MARK ------------------------------------------
     *
     *   Wendover 200 up  ·  J Harrington 78*, W Fairhead 45
     *   High Wycombe 100 up
     *
     * WORDING PROVISIONAL, like the rest of the family.
     *
     * EVERY HUNDRED, AND NOTHING SMALLER. Fifty is an ordinary passage of a league
     * innings and a hundred-and-fifty is a number nobody celebrates; the round hundreds
     * are the ones a ground reacts to, and they are what James asked for.
     *
     * THE CLAUSE IS THE REASON THIS TYPE IS ALLOWED TO EXIST. The mark itself is on the
     * strip in gold and larger, so what the band adds is who built the total — which no
     * surface on the wall says. The lean is the usual one: ours get the top two, theirs
     * the top one, and the division's card has no batters so its line goes without.
     *
     * THE STAR MATTERS HERE. A top score still growing and one that is finished are
     * different facts about the innings, and it is one character. */
    var TEAM_MARK = 100;
    /* THE MEN WHO BUILT IT, in the type every other batter's figure is set in — the
     * name in the batter's weight and the total in gold, because a batter's total is
     * a total. They were one flat string, which put the only figures on the line in
     * the muted type under a gold hundred.
     * > James's direction, 2026-09-29. */
    function topScorers(inn, n) {
        var bats = ((inn && inn.batters) || []).filter(function (b) {
            return b && b.name && (b.runs || 0) > 0;
        });
        bats.sort(function (a, b) { return (b.runs || 0) - (a.runs || 0); });
        var out = [];
        bats.slice(0, n).forEach(function (b) {
            out.push({ cls: 'bat', text: b.name });
            out.push({ cls: 'score', text: b.runs + (isOut(b) ? '' : '*') });
        });
        return out;
    }
    /* HOW MUCH ROAD IS LEFT, when the match will say. Only a chase can: the allotment
     * is inferred from the first innings' close (WccChase.allotmentOvers), so during
     * a first innings there is no honest figure to quote and the clause stays away.
     * See the DLS overs note — a real per-competition allotment would give this to
     * both innings.
     * > James's direction, 2026-09-29. */
    function oversLeft(inns) {
        if (!chasing(inns) || !window.WccChase) return '';
        var st = WccChase.chaseState(inns);
        if (!st || st.balls == null || st.balls <= 0) return '';
        return oversWord(st.balls) + ' left';
    }
    /* WHICH MARK, IF ANY, THIS POLL CROSSED — the highest of them, because a poll wide
     * enough to cross two is wide enough that only the bigger is worth saying, and the
     * smaller would be a wrong number the moment it went up.
     *
     * A CHASE STOPS SHORT OF THE TARGET. The mark that takes a chasing side past the
     * first innings is not a milestone, it is the match, and `match_finished` has it.
     * Announcing "200 up" in the same breath as a result would be the band talking over
     * itself with the duller of the two. */
    function teamMarkCrossed(pinn, inn, inns) {
        var was = (pinn && pinn.runs) || 0, now = (inn && inn.runs) || 0;
        var mark = Math.floor(now / TEAM_MARK) * TEAM_MARK;
        if (!mark || was >= mark) return null;
        if ((inns || []).length === 2) {
            var target = ((inns[0] && inns[0].runs) || 0) + 1;
            if (mark >= target) return null;
        }
        return mark;
    }
    /* A HUNDRED IS ROUTINE AND THREE HUNDRED IS A MONSTER, and one type covers both, so
     * the mark itself is the magnitude. The numbers are chosen against what they have to
     * land ON: `interestOf` turns a magnitude into a multiplier of 0.4 to 1.6 and then
     * caps the whole thing at a quarter above base, so 0.25 puts a first hundred at 40
     * (a shade under a match starting) and 0.55 puts two hundred at the cap, 62, just
     * under an individual fifty. Three hundred cannot climb past that, which is the right
     * shape: a total is the side's afternoon where a fifty is one man's.
     *
     * The first cut of this was `(mark/100 - 1) * 0.35`, which gave a first hundred a
     * magnitude of ZERO — the bottom of the multiplier, 0.4, and an interest of 20,
     * barely clear of the floor. A formula that starts at nothing prices the commonest
     * case as the least interesting thing on the wall. */
    function teamMarkMagnitude(mark) {
        return Math.min(1, 0.25 + (mark / TEAM_MARK - 1) * 0.3);
    }
    /* "100 up for High Wycombe hosting Maidenhead & Bray."
     *
     * THE FIXTURE, NOT JUST THE CLUB. On a wall carrying eight of the division's games
     * "High Wycombe 100 up" is a club and a number with no match attached — and this
     * is the one type whose whole news is a number, so it can afford the other side.
     * `home` picks the preposition, which is how the sentence says where it is being
     * played without a second clause. */
    function teamMarkPayload(mark, inn, sides, mine, home, inns, ctx) {
        /* "100 UP" IS THE NEWS AND THE REST IS THE FIXTURE, so the fixture follows the
         * wall's rule: name the opposition, never us. Ours drops the "for Wendover"
         * and keeps the preposition, which still says where — "100 up chasing Denham",
         * "100 up hosting Denham". Where WE are the other side, the preposition goes
         * with us, since one without an object is not a phrase.
         * > James's direction, 2026-09-29. */
        var ours = ctx && isOurPlayer(ctx, sides.bat);
        var lead = [{ cls: 'score', text: String(mark) }, det('up')];
        if (!ours) lead = lead.concat([det('for'), team(sides.bat || '')]);
        if (sides.other && !(ctx && isOurPlayer(ctx, sides.other))) {
            // "Chasing" says which half of the match this is, and it replaces the
            // preposition rather than joining it: a side chasing is not merely at a
            // ground. > James's direction, 2026-09-28.
            lead.push(det(chasing(inns) ? 'chasing' : (home ? 'hosting' : 'at')));
            lead.push(team(sides.other));
        } else if (sides.other && chasing(inns)) {
            /* CHASING US: the target is the object, since we are never named — the
             * chase-start and passage lines' rule. Gold: a total. */
            lead.push(det('chasing'));
            lead.push(chaseFigure(inns));
        }
        /* THE OVERS IN THE SAME BREATH: "with 21 overs left" belongs to the moment
         * the mark was reached, and as a clause of its own at the end of the line it
         * read as a separate fact about the chase now.
         * > James's direction, 2026-10-01. */
        var left = oversLeft(inns);
        if (left) lead.push(det('with ' + left));
        return say(lead.concat([SEP]).concat(topScorers(inn, mine ? 2 : 1)));
    }

    /* THE LAST `n` MEN OUT, verified as his. The hat-trick's rule generalised: the
     * dismissals at the end of the innings are the newest, and a wicket in the over we
     * are describing is by construction one of them — but a run-out at the other end is
     * a team wicket and not his, so every one is checked against the bowler's name and
     * the whole clause is dropped rather than half-right. */
    function victimsOf(inn, pinn, name, n) {
        var all = dismissalsOf(inn, pinn);
        if (all.length < n) return [];
        var last = all.slice(-n);
        for (var i = 0; i < last.length; i++) {
            if (bowlerOf(last[i].how) !== name) return [];
        }
        return last.map(function (d) { return d.name; });
    }
    /* A WICKET MAIDEN.
     *
     *   T Duff 2-14  ·  D Cole  ·  Denham 20/4
     *
     * WORDING PROVISIONAL, like the rest of this family.
     *
     * The clause is who he got rather than the words "a wicket maiden", because the
     * tile says that already — and naming him is what ties this over to the dismissal
     * the room read a minute ago. With the name unverifiable it falls back to the one
     * other thing the over can say about itself: which of his overs it was. */
    function wicketMaidenPayload(mv, inn, pinn, sides, ctx) {
        // The tile will not be saying it for much longer, so the line says it: six
        // balls, nothing off them and a man out. Then whose over it was, his figures,
        // and the batter he got. > James's direction, 2026-09-29.
        var who = andList(victimsOf(inn, pinn, mv.name, mv.wkts));
        return say([det('Wicket maiden')].concat(clubTag(ctx, sides.other, sides.bat))
                   .concat([SEP, { cls: 'bat', text: mv.name },
                            { cls: 'score', text: figuresOf(mv.now.wickets, mv.now.runs) },
                            det(who ? ', ' + who : '', true)]),
                   { who: mv.name });
    }
    /* MAIDENS ON THE TROT.
     *
     *   T Duff 2-14  ·  three in a row, and a wicket  ·  Denham 20/4
     *
     * The tile is the noun (MAIDEN OVERS) so the clause carries the count, which is the
     * whole news — and the wicket, when there was one, because three maidens with a man
     * out in them is a different over from three without. */
    function maidenRunPayload(mv, inn, sides, ctx) {
        var bits = countWord(mv.run) + ' maidens in a row';
        if (mv.run_wkts === 1) bits += ', and a wicket';
        else if (mv.run_wkts > 1) bits += ', and ' + countWord(mv.run_wkts) + ' wickets';
        return say([{ cls: 'bat', text: mv.name }, det(bits)]
                   .concat(clubTag(ctx, sides.other, sides.bat))
                   .concat([SEP, { cls: 'score', text: figuresOf(mv.now.wickets, mv.now.runs) }]),
                   { who: mv.name });
    }

    function creaseMate(inn, name) {
        var pool = ((inn && inn.at_crease) || []).length ? inn.at_crease : (inn.batters || []);
        var out = null;
        pool.forEach(function (b) {
            if (!b || !b.name || b.name === name) return;
            if (isOut(b) || !(b.runs || b.balls)) return;
            if (!out) out = b;
        });
        return out;
    }

    /* ---- THE LAST PAIR TOGETHER ------------------------------------------------
     *
     *   W Fairhead 45* and A Roan 3*  ·  47 still needed  ·  Wendover 224/9
     *   W Fairhead 45* and A Roan 3*  ·  Wendover 224/9
     *
     * WORDING PROVISIONAL, like the rest of the family.
     *
     * The tile says LAST PAIR, so the sentence does not: it names them, and the tail's
     * `/9` is the fact doing the work rather than decoration.
     *
     * THE CLAUSE IS THE CHASE, WHERE THERE IS ONE. Nine down needing 47 is the whole
     * question the rest of the afternoon answers, and although the strip's chase block
     * carries the same figure this is the one line on the band where it IS the news
     * rather than the standing state. On a first innings there is nothing true to add —
     * the stand is a ball old by construction — so the line is the pair and the score. */
    function lastPairPayload(pair, inn, inns, sides, ctx) {
        // "Last pair batting" — or chasing, which is when nine down is a story rather
        // than a position. The runs still needed stay: it is the whole question the
        // rest of the afternoon answers. > James's direction, 2026-09-29.
        var need = '';
        if (chasing(inns) && window.WccChase) {
            var st = WccChase.chaseState(inns);
            if (st && st.runs > 0) need = st.runs + ' still needed';
        }
        return say([det('Last pair ' + (chasing(inns) ? 'chasing' : 'batting'))]
                   .concat(clubTag(ctx, sides.bat, sides.other))
                   .concat([SEP]).concat(pairParts(pair))
                   .concat(need ? [SEP, det(need, true)] : []),
                   { who: pair[0].name });
    }

    /* ---- CLOSING IN ON A MILESTONE -------------------------------------------
     *
     *   J Harrington needs 6 for a fifty  ·  J Harrington 44* · A Quill 12*
     *
     * WORDING PROVISIONAL, like the rest of the family.
     *
     * The tile says CLOSING IN and the sentence says what he is closing in on and by how
     * much, which is the same division of labour as TWO IN TWO over "on a hat-trick".
     *
     * FIRED ON ENTERING THE LAST TEN — crossing 40, or 90. A transition, so it goes out
     * once and `repeat: null` keeps it that way; a batter who sits in the forties for
     * twenty minutes is not news twenty times. James's own suggestion, and the right
     * width: five is so close that a single blow skips the window altogether, and twenty
     * is not approaching anything.
     *
     * THE GAP IS AS AT THE POLL, and it can be a run or two stale by the time the band
     * shows it — the softest version of the risk `on_a_hat_trick` carries, because what
     * ages is a number inside a sentence that stays true. The milestone firing retires
     * it, which is what stops the gap ever being seen at zero or below. */
    var APPROACH_WINDOW = 10, APPROACH_MARKS = [100, 50];
    var MARK_WORDS = { 50: 'fifty', 100: 'hundred' };
    function approachMagnitude(mark) {
        return Math.min(1, 0.3 + (mark / 50 - 1) * 0.5);
    }
    function approachPayload(b, mark, inn, sides, ctx) {
        var gap = mark - (b.runs || 0);
        /* HIS OWN FIGURE HAS GONE FROM THE FRONT: the pair at the end carries it, with
         * the star, and "A Quill 44 · needs six" was the same number twice under a
         * subtraction. What is left is one sentence — who, how far, and for whom.
         *
         * THE GAP IS A NUMERAL, not `countedWord`: "needs 6", not "needs six". It is
         * the one figure the line exists to give, and it reads off the band faster as
         * a number. Plain type, not gold — it is a gap, not a total.
         * > James's direction, 2026-10-01. */
        return say([{ cls: 'bat', text: b.name },
                    det('needs ' + gap + ' for a ' + MARK_WORDS[mark])]
                   .concat(clubTag(ctx, sides.bat, sides.other))
                   .concat([SEP]).concat(pairOf(inn)),
                   { who: b.name });
    }

    /* A BATTER WALKING OUT.
     *
     *   T Denham to the crease  ·  with J Harrington on 54  ·  Wendover 74/5
     *
     * The news is not that a person exists, it is the SITUATION he has walked into,
     * so the three phrases build it up: who, who he has joined, and what they are
     * standing at. Read backwards off the tail it is the story — 74 for 5, an unbeaten
     * 54 at one end and a new man at the other.
     *
     * The middle clause is the lean again: the partner is named for one of ours and
     * left out for theirs. It is also the honest thing to drop first, since a partner
     * at nought adds nothing that the tail's wicket count has not already said.
     *
     * THIS IS WHERE A PROFILE WOULD GO. "T Denham to the crease" is the moment the
     * unbuilt player set exists for — his season, his best, what he did last week —
     * and the type asks for the `profile` panel so that it lands the day that set is
     * built. Until then it falls through to the match score, which is at least about
     * the situation the sentence is describing. */
    function arrivalPayload(b, inn, sides, ctx, mine) {
        /* WHO HE IS WALKING OUT AGAINST, and who he has joined out there. The man at
         * the other end is now written as the band writes every batter — name and
         * starred figure — rather than as prose ("with A Godden on 8"), so the same
         * fact is set the same way here as it is on the score line above. The new man
         * himself is on nought by construction and is not worth a figure.
         * > James's direction, 2026-09-29. */
        var mate = mine ? creaseMate(inn, b.name) : null;
        return say([{ cls: 'bat', text: b.name }, det('to the crease')]
                   .concat(clubTag(ctx, sides.bat, sides.other))
                   .concat([SEP]).concat(mate ? batFig(mate) : []),
                   { who: b.name });
    }

    function creaseText(inn) {
        var at = (inn && inn.at_crease) || [];
        if (!at.length) return '';
        return at.map(function (b) { return b.name + ' ' + b.runs + '*'; }).join(', ');
    }
    function clipOf(c) {
        return { id: c.id, url: c.url, event: c.event,
                 // The feed does not state a clip's length; frogbox highlights are
                 // pre-trimmed to about half a minute, which is what the dwell has
                 // to budget for until the player measures the real thing.
                 duration: c.duration || 30 };
    }
    function clipText(c) {
        var who = c.batter || c.dismissed || '';
        return (c.event === 'wicket' ? 'Wicket' : c.event === 'six' ? 'Six' : c.event === 'four' ? 'Four' : 'Highlight') +
               (who ? ' — ' + who : '');
    }
    // Footage of an event we already extracted this poll joins it, so a wicket and
    // its replay are ONE thing on screen. Matched on over/ball within the same
    // match, and only for events that could plausibly have a clip.
    function attachClip(out, c) {
        if (c.over == null) return false;
        for (var i = 0; i < out.length; i++) {
            var ev = out[i];
            if (ev.clip) continue;
            // An event the chrome has ALREADY shown is not amended in place: the
            // footage is new information the room has not seen, so it goes on to earn
            // its own screen rather than being folded into a line already read out.
            if (ev.shown_count > 0) continue;
            if (!kindOf(c, ev)) continue;
            /* WHOSE BALL THIS WAS. Matched against the payload's `who` — the name
             * the extractor put on the event — and only then against its text.
             *
             * It used to read the HEADLINE alone, which was right while a wicket's
             * headline was "C Godden 2, lbw b Vane". The headline is now the scoreline
             * (see the wicket and boundary payloads), so the name lives in the clause
             * and a name test against the headline could never match again: every clip
             * would have attached to the first candidate event regardless of who it was
             * of, or to none. */
            var who = c.dismissed || c.batter;
            if (who && !nameMatches(ev, who)) continue;
            ev.clip = clipOf(c);
            // A clip changes what the event IS worth and how long it needs, so both
            // are recomputed rather than left at their text-only values.
            ev.interest += CLIP_BONUS;
            ev.dwell = dwellFor(ev);
            return true;
        }
        return false;
    }
    /* THE TRUE INSTANT, off a ball row, onto the event the scorecard already gave us.
     *
     * This is the whole point of reading the highlights as data. Everywhere else an
     * event's `happened_at` is the POLL bracket — somewhere between the scorer's last
     * sync and this one — which is honest but can be half an hour wide, and is simply
     * wrong when a card arrives late (an innings' first poll — see the note there).
     * A row carries
     * `dt_utc`, so for a streamed match the bracket collapses to a point and freshness
     * prices the event by when it actually happened.
     *
     * IT AMENDS AN EVENT EVEN ONCE SHOWN, unlike the footage join. Correcting when
     * something happened does not change a word of what was said; it only lets a
     * stale incident stop pretending to be news. Stamped once — `ball_time` — so a
     * second row for the same batter moves on to the next candidate instead of
     * rewriting the first. */
    function stampBallTime(list, c) {
        if (!c || c.happened_ms == null) return false;
        for (var i = 0; i < list.length; i++) {
            var ev = list[i];
            if (ev.ball_time) continue;
            if (!kindOf(c, ev)) continue;
            var who = c.dismissed || c.batter;
            if (who && !nameMatches(ev, who)) continue;
            ev.happened_at = [c.happened_ms, c.happened_ms];
            ev.ball_time = true;
            if (c.over != null) { ev.over = c.over; ev.ball = c.ball == null ? null : c.ball; }
            return true;
        }
        return false;
    }
    // Does this row describe the same KIND of thing as this event?
    function kindOf(c, ev) {
        return c.event === 'wicket' && ev.type === 'wicket';
    }
    /* A BALL THE SCORECARD NEVER REPORTED, written the way every other incident on
     * this wall is written: the scoreline leads, the clause says what happened.
     *
     * The scoreline is the innings' CURRENT figures, not the score at that ball —
     * which is not recoverable, because the rows carry only boundaries and wickets
     * and never the singles in between. The over shown is the innings' own, for the
     * same reason: pairing this ball's over with the current total would state a
     * position the match was never in. The row's over and ball are kept on the event
     * instead, where they date it without asserting a scoreline. */
    /* THE SAME SHAPE AS EVERY OTHER WICKET, which is the whole of this rewrite.
     *
     * It led with the innings' current scoreline — "Wendover 15/1 (4 ov) · R Duff out
     * (4.1)" — which is the v1 grammar the wicket line left behind, and it turns up a
     * minute after a properly written wicket saying the same thing in an older hand.
     * (It turns up at all because footage of a wicket the band has ALREADY shown earns
     * its own screen rather than being folded in silently; see `attachClip`.)
     *
     * What it can say is thinner than a scorecard wicket — a row carries the batter,
     * sometimes the bowler, and the ball it happened on, and never how he went or for
     * how many — so it says those and stops. The over and ball stay because they are
     * the one thing this path knows that the scorecard does not. */
    function ballPayload(m, ctx, c, type) {
        var inn = inningsOfClip(m, c);
        var who = c.dismissed || c.batter || '';
        var at = c.over != null ? '(' + c.over + '.' + (c.ball || 0) + ')' : '';
        if (!inn) {
            return say([det(c.title || clipText(c)), SEP]
                       .concat(fixtureParts(m, ctx, at)), { who: who });
        }
        var sides = sidesOf(m, ctx, inn);
        if (!who) {
            return say([det(c.title || clipText(c)), det(at)]
                       .concat(clubTag(ctx, sides.bat, sides.other)), { who: who });
        }
        var lead = [{ cls: 'bat', text: who },
                    det(type === 'wicket' ? 'out' : ''), det(at)];
        var credit = c.bowler
            ? [{ cls: 'bat', text: c.bowler }].concat(clubTag(ctx, sides.other, sides.bat))
            : clubTag(ctx, sides.bat, sides.other);
        return say(lead.concat([SEP]).concat(credit), { who: who });
    }
    // Which innings a row belongs to — by id, then by the batting side's name.
    function inningsOfClip(m, c) {
        var list = (m && m.innings) || [];
        var i;
        if (c.innings_id != null) {
            for (i = 0; i < list.length; i++)
                if (String(list[i].innings_id) === String(c.innings_id)) return list[i];
        }
        if (c.batting_team) {
            for (i = 0; i < list.length; i++)
                if (String(list[i].side || '').toLowerCase() === String(c.batting_team).toLowerCase())
                    return list[i];
        }
        return list[list.length - 1] || null;
    }
    // Does this event name that player? The explicit `who` is authoritative; the
    // text is the fallback for the types that do not carry one.
    function nameMatches(ev, who) {
        var p = ev.payload || {};
        if (p.who) return String(p.who) === String(who);
        return ((p.headline || '') + ' ' + (p.detail || '')).indexOf(who) !== -1;
    }
    function secs(v) { return v ? (v < 1e11 ? v * 1000 : v) : null; }
    function ordinal(n) {
        var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

    window.WccLiveEvents = {
        store: store,
        extractLive: extractLive,
        extractLeague: extractLeague,
        ladderEvent: ladderEvent,
        extractLadder: extractLadder,
        LADDER_HOLD_MS: LADDER_HOLD_MS,
        interestOf: interestOf,
        MIN_SHOW_MS: MIN_SHOW_MS,
        dwellFor: dwellFor,
        decompose: decompose,
        panelFor: panelFor,
        TYPES: TYPES,
        PANELS: PANELS,
        SHOW_FLOOR: SHOW_FLOOR,
        COVERAGE_MS: COVERAGE_MS, COVERAGE_LIFT: COVERAGE_LIFT
    };
})();

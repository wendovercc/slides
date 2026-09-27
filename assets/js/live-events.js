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
        hundred:           { base: 92, ttl: 900000,  repeat: 420000, label: 'Hundred',        panel: 'profile' },
        five_for:          { base: 90, ttl: 900000,  repeat: 420000, label: 'Five wickets',   panel: 'profile' },
        match_finished:    { base: 88, ttl: 2700000, repeat: 300000, label: 'Match finished', panel: 'ladder' },
        abandoned:         { base: 84, ttl: 2700000, repeat: 600000, label: 'Abandoned',      panel: 'ladder' },
        innings_closed:    { base: 74, ttl: 900000,  repeat: 300000, label: 'Innings closed', panel: 'score' },
        wicket:            { base: 70, ttl: 300000,  repeat: 180000, label: 'Wicket',         panel: 'score' },
        fifty:             { base: 64, ttl: 480000,  repeat: 300000, label: 'Fifty',          panel: 'profile' },
        ladder_shift:      { base: 60, ttl: 900000,  repeat: 420000, label: 'Ladder move',    panel: 'ladder' },
        rain_break:        { base: 56, ttl: 1800000, repeat: 600000, label: 'Rain',           panel: 'score' },
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
        match_break:       { base: 26, ttl: 600000,  repeat: null,   label: 'Break',          panel: 'score' },
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
        score_update:   ['toss', 'match_started', 'score_update'],
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
        wicket:         ['toss', 'match_started', 'score_update'],
        // An innings closing settles every running figure for that innings.
        innings_closed: ['toss', 'match_started', 'score_update', 'match_break'],
        // And a verdict settles everything that described the game in progress —
        // but not its wickets, its sixes or its hundreds, which happened.
        match_finished: ['toss', 'match_started', 'score_update', 'match_break',
                         'probability_shift'],
        abandoned:      ['toss', 'match_started', 'score_update', 'match_break',
                         'probability_shift']
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
     * dented, over "1st XI · TVCL Div 6C".
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
                // The event description, as the bar's one line. `detail` is the
                // supporting clause — the scoreline a wicket left behind, the match a
                // result belongs to — and the bar shows it when it has the room.
                text: (ev.payload && ev.payload.headline) || '',
                detail: (ev.payload && ev.payload.detail) || '',
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
                /* The footer, in the band directly above the gold tile. The two cases
                 * are genuinely different. Our match: which of our XIs, division
                 * underneath. Someone else's: the division IS the attribution, because
                 * which two clubs is answered by the panel's own marked tiles and two
                 * club names have never fitted 8vw. */
                foot: m.ours ? (m.team || 'Wendover') : (m.division || 'League'),
                foot_sub: m.ours ? (m.division || '') : '',
                division: m.division || '',
                ours: !!m.ours
            },
            /* The gold tile: the type, and only the type. `label` is the type table's
             * own wording, so the tile and the inspector's Type column cannot drift.
             * (Some of those labels are written for a table rather than for a 8vw
             * block — "Match finished" where the tile wants RESULT — which is a
             * per-type call to make as each one is walked through.) */
            tile: { label: typeOf(ev.type).label || ev.type, type: ev.type }
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
            var kill = RETIRES[ev.type];
            if (kill) {
                for (var s = 0; s < events.length; s++) {
                    var old = events[s];
                    if (old.match.key === ev.match.key && kill.indexOf(old.type) !== -1) {
                        old.superseded = true;
                    }
                }
            }
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
             * (the trap rv.mjs already warns about for the today board's status). Taken
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
        function ranked(now) {
            return events.map(function (ev) {
                var f = freshness(ev, now), n = novelty(ev, now), c = coverage(ev, now);
                return { ev: ev, freshness: f, novelty: n, coverage: c,
                         superseded: !!ev.superseded,
                         score: ev.superseded ? 0 : ev.interest * f * n * c };
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

            if (!p) {
                // First sighting. The toss is a standing fact worth announcing (it
                // frames everything after it); a match already decided when we
                // joined is the answer to "what happened?" and belongs on screen.
                if (m.toss && m.toss.text) push('toss', 'toss', tossPayload(m, ctx));
                if (m.complete) push('match_finished', 'result',
                    { headline: m.result_club || m.result || 'Match finished',
                      detail: m.final ? '' : 'to be confirmed' });
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

            var pi = p.innings || [], mi = m.innings || [];

            // A new innings in the list means the previous one closed — and in a
            // two-innings game that is the moment a target exists, which is the most
            // useful thing the surface can say all afternoon.
            if (mi.length > pi.length && pi.length) {
                var closed = mi[pi.length - 1] || pi[pi.length - 1];
                push('innings_closed', 'inn' + pi.length + 'close', {
                    headline: (closed.club || closed.side || '') + ' ' + closed.runs + '/' + closed.wickets +
                              ' (' + closed.overs + ' ov)',
                    detail: mi.length === 2 ? 'Target ' + ((closed.runs || 0) + 1) : 'Innings closed'
                });
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
                if (!pinn) {
                    if ((inn.wickets || 0) > NEW_INNINGS_MAX_WICKETS) return;
                    pinn = { runs: 0, wickets: 0, overs: '0', batters: [], bowling: [],
                             at_crease: [], fall: [], last_wicket: null };
                }
                var side = inn.club || inn.side || '';
                // Who is batting and who is waiting — once per innings, because every
                // scoreline this block writes names the same two sides.
                var sides = sidesOf(m, ctx, inn);
                /* HAS THIS POLL ALREADY STATED THE SCORE? A wicket, a four and a six
                 * all now lead with the scoreline, so when one of them lands on an
                 * over boundary the floor's own line is the same sentence twice — and
                 * the second one is the weaker of the two, because the incident says
                 * what happened and the floor says only where they are. The floor
                 * exists to fill SILENCE; an over that produced a wicket was not
                 * silent. See the score line at the foot of this block. */
                var saidScore = false;
                // Whose bowlers these are — one phrase for the whole line, first
                // innings only. See toBatTail.
                var tail = toBatTail(sides, mi);

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
                        var dsc = scoreParts(sides.bat || dropCC(side), at);
                        push('wicket', 'i' + ii + 'w' + d.order, {
                            headline: dsc.headline, parts: dsc.parts,
                            detail: dismissalText(d, inn, di === fell.length - 1),
                            tail: tail && tail.text, tail_parts: tail && tail.parts,
                            who: d.name, fielder: d.fielder || null
                        }, { tension: ctx.tension });
                        saidScore = true;
                    });
                } else if (dw > 0) {
                    // The rows could not be reconciled with the wicket count — a feed
                    // without them, or a name that changed spelling between polls. One
                    // event for the batch, saying honestly what it cannot separate.
                    var w = inn.last_wicket;
                    var also = dw > 1 ? ' (+' + (dw - 1) + ' more since the last update)' : '';
                    var wsc = scoreParts(sides.bat || dropCC(side), inn);
                    push('wicket', 'i' + ii + 'w' + inn.wickets, {
                        headline: wsc.headline, parts: wsc.parts,
                        detail: dismissalText(w, inn, true) + also,
                        tail: tail && tail.text, tail_parts: tail && tail.parts,
                        who: w && w.name || '', fielder: w && w.fielder || null
                    }, { tension: ctx.tension });
                    saidScore = true;
                }

                // --- milestones, per batter, by name. `batters` is the full card, so
                // this catches a fifty reached by someone already dismissed by the
                // time we polled.
                var pbat = byName(pinn.batters);
                (inn.batters || []).forEach(function (b) {
                    var was = pbat[b.name];
                    if (!was) return;
                    [[100, 'hundred'], [50, 'fifty']].forEach(function (pair) {
                        var mark = pair[0], type = pair[1];
                        if ((was.runs || 0) < mark && (b.runs || 0) >= mark) {
                            push(type, 'i' + ii + mark + b.name, {
                                headline: b.name + ' ' + b.runs + (b.balls ? ' (' + b.balls + ')' : ''),
                                detail: mark === 100 ? 'Hundred for ' + side : 'Fifty for ' + side,
                                who: b.name
                            });
                        }
                    });
                });

                // --- a bowler's fifth
                var pbowl = byName(pinn.bowling);
                (inn.bowling || []).forEach(function (bw) {
                    var was = pbowl[bw.name];
                    if (was && (was.wickets || 0) < 5 && (bw.wickets || 0) >= 5) {
                        push('five_for', 'i' + ii + '5w' + bw.name, {
                            headline: bw.name + ' ' + bw.wickets + '\u2013' + bw.runs,
                            detail: 'Five wickets in ' + bw.overs + ' overs'
                        });
                    }
                });

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
                var ob = balls(inn.overs), pb = balls(pinn.overs);
                if (ob > pb && ob % 6 === 0 && !saidScore) {
                    var delta = sinceLastPoll(pinn, inn, ob, pb);
                    var ov = ob / 6;
                    /* ONE SENTENCE FOR A SCORE, whichever feed it came off. Our own
                     * matches know more than the division's — who is in, on what —
                     * but a band that wrote our score one way and somebody else's
                     * another made the two read as different kinds of news when they
                     * are the same kind. So the over-by-over line is the league line:
                     * club, figure, overs, and who is still to bat.
                     *
                     * The at-crease pair has left the band altogether. It was saying
                     * the same two names every over whether or not they had changed,
                     * and the division has no equivalent to offer — so the strip's
                     * score panel is where a reader looks for who is in. */
                    var osc = scoreParts(sides.bat || dropCC(side),
                                         { runs: inn.runs, wickets: inn.wickets, overs: ov });
                    push('score_update', 'i' + ii + 'ov' + ov, {
                        headline: osc.headline, parts: osc.parts,
                        detail: scoreDetail(m, ctx, sides, mi, delta),
                        tail: tail && tail.text, tail_parts: tail && tail.parts
                    });
                }
            });

            // --- a swing worth remarking on. The chase model is the authority on
            // who is winning; this fires when its answer moves a long way between
            // polls, which is what a collapse or a counter-attack looks like from
            // the outside.
            var ps = chaseP(p), ns = chaseP(m);
            if (ps != null && ns != null) {
                var d = Math.abs(ns - ps);
                if (d >= 0.15) {
                    // Keyed on the MOVE, not on the clock: a second-resolution
                    // timestamp collides whenever two polls land in the same second.
                    push('probability_shift', 'swing' + Math.round(ps * 100) + '_' + Math.round(ns * 100),
                        { headline: swingText(m, ps, ns),
                          detail: 'Win probability ' + pct(ps) + ' → ' + pct(ns) },
                        { magnitude: Math.min(1, d / 0.5) });
                }
            }

            // --- breaks, and the two ways an afternoon ends
            if (m.break_desc && m.break_desc !== p.break_desc) {
                var rain = /rain|weather|wet|shower/i.test(m.break_desc);
                push(rain ? 'rain_break' : 'match_break', 'break' + m.break_desc,
                     { headline: m.break_desc, detail: matchTitle(m) });
            }
            if (m.complete && !p.complete) {
                var res = m.result_club || m.result || 'Match finished';
                var aband = /abandon|no result|wash|cancel/i.test(res);
                push(aband ? 'abandoned' : 'match_finished', 'result', {
                    headline: res,
                    detail: m.final ? matchTitle(m) : 'To be confirmed · ' + matchTitle(m)
                });
            }
            // Confirmation is its own small event: the surface has been hedging with
            // "to be confirmed" and can now stop.
            if (m.complete && p.complete && m.final && !p.final) {
                push('match_finished', 'final', {
                    headline: m.result_club || m.result || 'Result confirmed',
                    detail: matchTitle(m) + ' · confirmed'
                });
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
                 * boundaryClause). Letting an unclaimed row raise one anyway would
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
            var push = function (type, id, payload, extra) {
                out.push(event(type, ctx.key + ':' + id, ctx, when, now, payload, extra));
            };
            if (!p) {
                if (m.complete) push('match_finished', 'result',
                    { headline: m.result_club || m.result || 'Match finished', detail: ctx.division || matchTitle(m) });
                return;
            }
            if (m.complete && !p.complete) {
                var res = m.result_club || m.result || 'Match finished';
                var aband = /abandon|no result|wash|cancel/i.test(res);
                push(aband ? 'abandoned' : 'match_finished',
                     'result', { headline: res, detail: matchTitle(m) + (ctx.division ? ' · ' + ctx.division : '') });
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
            if (mi.length > pi.length && pi.length) {
                var closed = mi[pi.length - 1];
                if (closed) push('innings_closed', 'inn' + pi.length + 'close', {
                    headline: (closed.side || '') + ' ' + closed.runs + '/' + closed.wickets,
                    detail: matchTitle(m)
                });
            }
            // The coarse scoreline, when it moves. One event per distinct scoreline
            // rather than per over — this feed has no over-by-over truth to offer.
            var last = mi[mi.length - 1], plast = pi[pi.length - 1];
            if (last && (!plast || last.runs !== plast.runs || last.wickets !== plast.wickets)) {
                var sides = sidesOf(m, ctx, last);
                var sc = scoreParts(sides.bat, last);
                /* The same third phrase as our own matches. The division's feed is
                 * thinner in every other respect — no batters, no bowlers, no
                 * dismissals — but it names both clubs and says which is batting,
                 * which is all this phrase needs. One wall, one way of writing a
                 * score. */
                var ltail = toBatTail(sides, mi);
                push('score_update', 'sc' + mi.length + '_' + last.runs + '_' + last.wickets, {
                    headline: sc.headline, parts: sc.parts,
                    detail: scoreDetail(m, ctx, sides, mi),
                    tail: ltail && ltail.text, tail_parts: ltail && ltail.parts
                });
            }
        });
        (next && next.matches || []).forEach(function (m) { m._received_at = now; });
        return out;
    }

    /* A ladder move, handed in rather than derived. The strip owns the ladder — it
     * has the baked league table, the baseline/projected orders and the points port
     * — and re-deriving all that here would be a second copy of the thing the docs
     * already warn about. So the strip announces a committed move and this turns it
     * into an event like any other. Until that wiring exists the simulator is the
     * only source, which is enough to design the algorithm against. */
    function ladderEvent(move, now, cfg) {
        if (!move || !move.club) return null;
        var ctx = matchCtx({ pc_id: move.pc_id, match_id: move.match_id,
                             home: move.club, away: '' }, cfg || {}, !!move.ours);
        var dir = move.places > 0 ? 'up' : 'down';
        var n = Math.abs(move.places || 0);
        return event('ladder_shift', ctx.key + ':ladder' + move.club + move.to, ctx,
            [move.since || null, now], now, {
                headline: move.club + ' ' + dir + ' ' + n + (n === 1 ? ' place' : ' places') +
                          ' to ' + ordinal(move.to),
                detail: (move.division || ctx.division || '') + (move.reason ? ' · ' + move.reason : '')
            }, { magnitude: Math.min(1, n / 3) });
    }

    // ---- helpers ------------------------------------------------------------
    function event(type, id, ctx, when, now, payload, extra) {
        extra = extra || {};
        return {
            id: id, type: type, label: typeOf(type).label,
            match: { key: ctx.key, ours: ctx.ours, pc_id: ctx.pc_id, match_id: ctx.match_id,
                     team: ctx.team, opponent: ctx.opponent, division: ctx.division,
                     title: ctx.title },
            happened_at: when && when[1] != null ? [when[0], when[1]] : [null, now],
            received_at: now,
            shown_at: null, shown_count: 0,
            interest: interestOf(type, { ours: ctx.ours, clip: !!extra.clip,
                                         tension: extra.tension, magnitude: extra.magnitude }),
            payload: payload || {},
            clip: extra.clip || null
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
            opponent: c.opposition || (ours ? (m.away || '') : (lr.away_club_name || m.away || '')),
            division: c.competition_short || c.competition ||
                      m.competition || lr.competition_name || '',
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
    function chaseP(card) {
        var st = window.WccChase ? WccChase.chaseState((card && card.innings) || []) : null;
        return st ? st.p : null;
    }
    function pct(p) { return Math.round(p * 100) + '%'; }
    function swingText(m, was, now) {
        var inns = m.innings || [];
        var chasing = (inns[1] && (inns[1].club || inns[1].side)) || '';
        var up = now > was;
        return chasing + (up ? ' back in it' : ' losing their grip');
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
        if (!winner || !t.decision) return { headline: t.text || 'Toss', detail: '' };

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
        var head = winner + ' elected to ' + String(t.decision).trim();
        var det = '';
        if (other) {
            /* The scheduled start, when the build knew one. No guard on it having
             * passed: a toss is shown once and its ttl is half an hour, so "from
             * 13:00" is only ever read within a few minutes of being true. */
            det = other + ' will take the ' + (bat ? 'field' : 'crease') +
                  (ctx.start_time ? ' from ' + ctx.start_time : '');
        }
        return { headline: head, detail: det };
    }
    /* A DIVISION MATCH STARTING, said as a sentence rather than a scoreline —
     * "High Wycombe are hosting Maidenhead & Bray at London Road".
     *
     * "Hosting" rather than "v" because home and away is the only thing worth
     * knowing about a fixture nobody has bowled a ball in yet, and it reads as news
     * where a fixture line reads as a listing.
     *
     * THE GROUND IS OPTIONAL AT EVERY LEVEL. It is a real PC field that
     * fetch_league_fixtures reads, but it is frequently null — and the invented
     * division the simulator runs on has none at all — so the sentence has to be
     * complete without it. It is also dropped when it merely repeats the home club,
     * since "High Wycombe are hosting X at High Wycombe CC" tells nobody anything. */
    function startedPayload(ctx) {
        var home = dropCC(ctx.home_club), away = dropCC(ctx.away_club);
        if (!home || !away) return { headline: 'Match under way', detail: '' };
        var ground = String(ctx.ground || '').trim();
        var repeats = ground && dropCC(ground).toLowerCase().indexOf(home.toLowerCase()) === 0;
        return {
            headline: home + ' are hosting ' + away + (ground && !repeats ? ' at ' + ground : ''),
            // Nothing: the tile says IN PLAY and the strip's ladder names the
            // division, so a third clause would be the same fact a third time.
            detail: ''
        };
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
    function scoreParts(club, inn) {
        var score = (inn.runs || 0) + '/' + (inn.wickets || 0);
        var ov = inn.overs != null && inn.overs !== '' ? '(' + inn.overs + ' ov)' : '';
        var parts = [{ cls: 'team', text: club }, { cls: 'score', text: score }];
        if (ov) parts.push({ cls: 'ov', text: ov });
        return { parts: parts, headline: club + ' ' + score + (ov ? ' ' + ov : '') };
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

    /* THE SUPPORTING CLAUSE ON A SCORELINE, one rule for both feeds.
     *
     * On a FIRST innings it is the other side, still to bat — which is the fact a
     * glance at "9/0 (1 ov)" is missing, and it names the opposition at the same
     * time. It is only true of a first innings: once the second is under way "yet to
     * bat" is false, and until there is a target to quote the honest fallback is the
     * fixture and its division. */
    /* THE SCORE'S SUPPORTING CLAUSE, and the order it is chosen in.
     *
     * Four things can want the one clause, so they are ranked by how much the reader
     * would miss them:
     *
     *   1. WHAT JUST HAPPENED. A burst of boundaries is the only candidate that is
     *      news rather than standing context, and it is the whole reason the floor
     *      event is worth a screen at all in a passage of play.
     *   2. THE CHASE. Once there are two innings, "need 47 from 60" is the state of
     *      the match and beats naming anybody.
     *   3. WHO IS STILL TO BAT, on a first innings — the fact a bare scoreline is
     *      missing, and it names the opposition while it is at it.
     *   4. THE FIXTURE. Nothing has happened and there is nothing to chase: say whose
     *      game this is and let the tile carry the rest. */
    function scoreDetail(m, ctx, sides, inns, delta) {
        inns = inns || [];
        var burst = boundaryClause(delta);
        if (burst) return burst;
        /* A CHASE STATES ITS OWN TERMS. Once there are two innings the interesting
         * fact is not who is batting but what is left to do, and the chase model
         * already holds it. Both feeds get this: the model needs two innings and a
         * total, which a PC card carries as readily as an RV one — it is only the
         * balls-remaining half that needs an allotment, and that is omitted rather
         * than guessed when the allotment is unknown (see live-chase.js). */
        if (inns.length === 2) {
            var st = window.WccChase ? WccChase.chaseState(inns) : null;
            if (st) {
                return 'Need ' + st.runs + (st.balls != null ? ' from ' + st.balls + ' balls' : '') +
                       ', ' + st.wkts + ' wickets left';
            }
        }
        // Nothing has happened and there is nothing to chase. On a first innings the
        // tail is already naming the other side, so a clause here would be the same
        // fact twice; without one, fall through to the fixture.
        if (toBatTail(sides, inns)) return '';
        // The fixture, named the way the first phrase names a club — a band that
        // wrote "Wendover" and "Wendover CC v Aston Clinton CC" in the same breath
        // would be using two conventions one line apart.
        var h = dropCC(ctx.home_club || m.home || ''), a = dropCC(ctx.away_club || m.away || '');
        var title = h && a ? h + ' v ' + a : (h || a || matchTitle(m));
        return title + (ctx.division ? ' \u00b7 ' + ctx.division : '');
    }

    /* A club without its trailing "CC" — "Denham CC" -> "Denham". The port of
     * build.py's `drop_cc`, so a club is named on the L-frame exactly as the
     * match-day board names it a few centimetres away. */
    function dropCC(name) {
        if (!name) return '';
        var out = String(name).trim().replace(/\s+(CC|C\.C\.?|Cricket Club)$/i, '');
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
    /* THE SCORECARD'S OWN ABBREVIATIONS for the five dismissals anyone sees in a
     * season — `b`, `ct`, `lbw`, `st`, `ro` — and the words for the rest.
     *
     * Not only brevity, though brevity is what paid for the bowler's club a line
     * below: this is the notation a reader has already met on the board, the app and
     * every scorecard they have looked at, so "B Duff b 0" needs no translating. The
     * rare ones stay spelled out because nobody has a shorthand for them ready, and
     * they are rare enough to cost nothing.
     *
     * "for" goes with them: a scorecard writes "B Duff b Vane 0", and "b for 0" is
     * neither the notation nor English. */
    var HOW_WORDS = [
        [/^c\s*&\s*b\s/i, 'c&b'],
        [/^lbw\b/i,         'lbw'],
        [/^c\s/i,           'ct'],
        [/^st\s/i,          'st'],
        [/^b\s/i,           'b'],
        [/^ro\b|^run out/i, 'ro'],
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
    function bowlerOf(how) {
        var t = String(how || '').trim().replace(/\s+/g, ' ');
        if (/^ro\b|^run out/i.test(t)) return '';          // nobody's wicket
        var m = t.match(/(?:^|\s)b\s+(.+)$/i);
        return m ? m[1].trim() : '';
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
    function dismissalText(w, inn, figures) {
        if (!w || !w.name) return 'Wicket';
        var word = howWord(w.how);
        // No "out": the tile already says WICKET, and saying it twice in six words is
        // the L-frame's one rule broken — the type says what happened, the bar says
        // the particulars.
        var out = w.name + (word ? ' ' + word : '') +
                  (w.runs != null ? ' ' + w.runs : '');
        var bowler = bowlerOf(w.how);
        var figs = figures ? bowlerFigures(inn, bowler) : '';
        /* NO CLUB HERE ANY MORE. It was named possessively in this clause — "ct 17 —
         * Chenies & Latimer's W Vane 2-19" — which was correct but paid for the club
         * twice, once for the name and once for the possessive, in the phrase least
         * able to afford it. The third phrase names it once for the whole line.
         *
         * "bowler" comes back only when there are no figures. With them the word is
         * redundant — nobody else on a card has a 1-6 beside their name — but a bare
         * name after a dash, which is what a backfilled wicket leaves, would be
         * anybody. */
        if (bowler) {
            out += ' \u2014 ' + (figs ? bowler + ' ' + figs : 'bowler ' + bowler);
        }
        return out;
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
    function newDismissals(pinn, inn) {
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
        all.forEach(function (d, i) { d.order = i + 1; });
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
    function boundaryPhrase(f, s) {
        var parts = [];
        if (f > 0) parts.push(countWord(f) + ' four' + (f === 1 ? '' : 's'));
        if (s > 0) parts.push(countWord(s) + ' six' + (s === 1 ? '' : 'es'));
        return parts.join(' and ');
    }
    function capitalise(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }
    /* THE THIRD PHRASE: whose bowlers these are, said the only way a first innings
     * lets us say it.
     *
     * The bowling side was the one thing the band never named. A wicket said who got
     * him and a score said where they were, and neither said which club was doing the
     * bowling — on a wall showing three of our XIs at once that is the difference
     * between a fact and a puzzle. Carrying it in the dismissal clause worked but cost
     * the length twice over, once for the club and once for the possessive.
     *
     * As its own phrase it is paid for once and reads as what it is: the club in the
     * batting team's own strong type, the state in the muted type behind it.
     *
     * FIRST INNINGS ONLY, because "to bat" is only true there. In a chase the side
     * fielding has already batted and the same words would be a plain falsehood; that
     * innings gets its own phrasing when we come to it. */
    function toBatTail(sides, inns) {
        if (!sides || !sides.other) return null;
        if ((inns || []).length !== 1) return null;
        return { text: sides.other + ' to bat',
                 parts: [{ cls: 'team', text: sides.other }, { cls: 'det', text: 'to bat' }] };
    }
    /* THE CLAUSE THE BOUNDARIES EARN, or nothing.
     *
     * This is what `six` and `four` used to be as events. They were removed because a
     * counter cannot say WHEN a boundary was hit and the scorers' counters drift
     * against what the camera saw — so a SIX tile could announce a shot played twenty
     * minutes earlier and freshness had no way to know. As a clause on the score none
     * of that arises: the score is current by construction, and the boundaries are
     * qualified by it rather than claiming a moment of their own.
     *
     * The batter is named only when one of them hit the lot; two batters sharing a
     * burst get the count and no name, because "two fours for J Harrington" when one
     * of them was his partner's is the kind of small lie nobody would ever catch. */
    function boundaryClause(d) {
        if (!d || (d.fours <= 0 && d.sixes <= 0)) return '';
        /* NAME AND TOTAL FIRST, then what he did — "J Harrington 38, two fours and a
         * six in that over". The other order put the time phrase after the running
         * total ("…for J Harrington, on 24 in that over") where it read as though the
         * 24 had been scored in the over. It also matches the dismissal clause, which
         * is already name-then-figure. */
        var phrase = boundaryPhrase(d.fours, d.sixes);
        if (d.movers === 1 && d.who) {
            return d.who + (d.whoRuns != null ? ' ' + d.whoRuns : '') + ', ' + phrase;
        }
        return capitalise(phrase);
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
    function ballPayload(m, ctx, c, type) {
        var inn = inningsOfClip(m, c);
        var who = c.dismissed || c.batter || '';
        var at = c.over != null ? ' (' + c.over + '.' + (c.ball || 0) + ')' : '';
        if (!inn) {
            return { headline: c.title || clipText(c), who: who,
                     detail: matchTitle(m) + at };
        }
        var sides = sidesOf(m, ctx, inn);
        var sc = scoreParts(sides.bat || dropCC(inn.club || inn.side || ''), inn);
        var clause = who
            ? (type === 'wicket'
                ? who + ' out' + (c.bowler ? ' \u2014 bowler ' + c.bowler : '')
                : who + (c.bowler ? ' \u2014 ' + c.bowler : ''))
            : (c.title || clipText(c));
        return { headline: sc.headline, parts: sc.parts, who: who, detail: clause + at };
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

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
        six:               { base: 52, ttl: 240000,  repeat: 180000, label: 'Six',            panel: 'score' },
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
        four_clip:         { base: 36, ttl: 240000,  repeat: null,   label: 'Four',           panel: 'score' },
        innings_update:    { base: 22, ttl: 420000,  repeat: null,   label: 'Innings',        panel: 'score' },
        ball_clip:         { base: 20, ttl: 180000,  repeat: null,   label: 'Ball',           panel: 'score' },
        score_update:      { base: 12, ttl: 180000,  repeat: null,   label: 'Score',          panel: 'score' }
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
        score_update:   ['toss', 'match_started', 'score_update', 'innings_update'],
        innings_update: ['toss', 'match_started', 'score_update', 'innings_update'],
        // An innings closing settles every running figure for that innings.
        innings_closed: ['toss', 'match_started', 'score_update', 'innings_update'],
        // And a verdict settles everything that described the game in progress —
        // but not its wickets, its sixes or its hundreds, which happened.
        match_finished: ['toss', 'match_started', 'score_update', 'innings_update',
                         'probability_shift'],
        abandoned:      ['toss', 'match_started', 'score_update', 'innings_update',
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
        function score(ev, now) {
            if (ev.superseded) return 0;
            return ev.interest * freshness(ev, now) * novelty(ev, now);
        }

        // Rank everything showable, best first. The scheduler's working, exposed
        // because the inspector slide renders exactly this — the point is to be able
        // to see WHY one event beat another, not just which won.
        function ranked(now) {
            return events.map(function (ev) {
                var f = freshness(ev, now), n = novelty(ev, now);
                return { ev: ev, freshness: f, novelty: n,
                         superseded: !!ev.superseded,
                         score: ev.superseded ? 0 : ev.interest * f * n };
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
            var f = freshness(ev, now), n = novelty(ev, now);
            return { score: ev.superseded ? 0 : ev.interest * f * n, freshness: f, novelty: n };
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
            if (current) { current.shown_at = now; }   // the repeat window starts here
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
                    var rival = null;
                    for (var i = 0; i < rows.length; i++) {
                        if (rows[i].ev !== current) { rival = rows[i]; break; }
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
            freshness: freshness, novelty: novelty,
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
                if (!pinn) return;
                var side = inn.club || inn.side || '';

                // --- wickets. A poll can span more than one, and only the last is
                // described in the feed — so say that one and count the rest, rather
                // than inventing detail for wickets we cannot see.
                var dw = (inn.wickets || 0) - (pinn.wickets || 0);
                if (dw > 0) {
                    var w = inn.last_wicket;
                    var also = dw > 1 ? ' (+' + (dw - 1) + ' more this over)' : '';
                    push('wicket', 'i' + ii + 'w' + inn.wickets, {
                        headline: w ? (w.name + ' ' + w.runs + (w.how ? ', ' + expandHow(w.how) : '')) : 'Wicket',
                        detail: side + ' ' + inn.runs + '/' + inn.wickets + ' (' + inn.overs + ' ov)' + also,
                        fielder: w && w.fielder || null
                    }, { tension: ctx.tension });
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
                                detail: mark === 100 ? 'Hundred for ' + side : 'Fifty for ' + side
                            });
                        }
                    });
                    // Sixes and fours are counters, not events, so the DELTA is the
                    // event. A four only earns a screen when there is footage of it
                    // (see the type table) — the extractor emits it regardless and
                    // lets the clip join decide, because a clip can arrive a poll
                    // after the runs do.
                    var d6 = (b.sixes || 0) - (was.sixes || 0);
                    if (d6 > 0) push('six', 'i' + ii + '6' + b.name + b.sixes, {
                        headline: b.name + ' six', detail: side + ' ' + inn.runs + '/' + inn.wickets
                    }, { tension: ctx.tension });
                    var d4 = (b.fours || 0) - (was.fours || 0);
                    if (d4 > 0) push('four_clip', 'i' + ii + '4' + b.name + b.fours, {
                        headline: b.name + ' four', detail: side + ' ' + inn.runs + '/' + inn.wickets
                    });
                });

                // --- a bowler's fifth
                var pbowl = byName(pinn.bowling);
                (inn.bowling || []).forEach(function (bw) {
                    var was = pbowl[bw.name];
                    if (was && (was.wickets || 0) < 5 && (bw.wickets || 0) >= 5) {
                        push('five_for', 'i' + ii + '5w' + bw.name, {
                            headline: bw.name + ' ' + bw.wickets + '-' + bw.runs,
                            detail: 'Five wickets in ' + bw.overs + ' overs'
                        });
                    }
                });

                // --- the floor. These two are not news and are not pretending to
                // be: they are what keeps a screen truthful when nothing has
                // happened for ten overs. Every whole over for our matches, every
                // fifth over as an innings summary. Their interest is low enough
                // that any real event outranks them.
                var ob = balls(inn.overs), pb = balls(pinn.overs);
                if (ob > pb && ob % 6 === 0) {
                    var ov = ob / 6;
                    push('score_update', 'i' + ii + 'ov' + ov, {
                        headline: side + ' ' + inn.runs + '/' + inn.wickets + ' (' + ov + ' ov)',
                        detail: creaseText(inn)
                    });
                    if (ov % 5 === 0) {
                        var st = window.WccChase ? WccChase.chaseState(mi) : null;
                        push('innings_update', 'i' + ii + 'inn' + ov, {
                            headline: side + ' ' + inn.runs + '/' + inn.wickets + ' after ' + ov + ' overs',
                            detail: st && ii === 1
                                ? 'Need ' + st.runs + (st.balls != null ? ' from ' + st.balls + ' balls' : '') +
                                  ', ' + st.wkts + ' wickets left'
                                : creaseText(inn)
                        });
                    }
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
                push(rain ? 'rain_break' : 'innings_update', 'break' + m.break_desc,
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
                if (!c.url) return;
                var claimed = attachClip(out, c) ||
                              attachClip(cfg.recent ? cfg.recent(ctx.key) : [], c);
                if (claimed) return;
                var type = c.event === 'wicket' ? 'wicket' : c.event === 'six' ? 'six'
                         : c.event === 'four' ? 'four_clip' : 'ball_clip';
                // A clip's own timing when the feed offers one, so late footage is
                // dated by the incident rather than by the poll that carried it.
                var clipWhen = c.happened_ms ? [c.happened_ms - 60000, c.happened_ms] : when;
                out.push(event(type, ctx.key + ':clip' + c.id, ctx, clipWhen, now, {
                    headline: c.title || clipText(c),
                    detail: matchTitle(m) + (c.over != null ? ' · ' + c.over + '.' + (c.ball || 0) : '')
                }, { clip: clipOf(c), tension: ctx.tension }));
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
                push('score_update', 'sc' + mi.length + '_' + last.runs + '_' + last.wickets, {
                    headline: (last.side || '') + ' ' + last.runs + '/' + last.wickets +
                              (last.overs ? ' (' + last.overs + ' ov)' : ''),
                    detail: matchTitle(m) + (ctx.division ? ' · ' + ctx.division : '')
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
        var head = winner + ' elected to ' + String(t.decision).trim() + '.';
        if (other) {
            /* The scheduled start, when the build knew one. No guard on it having
             * passed: a toss is shown once and its ttl is half an hour, so "from
             * 13:00" is only ever read within a few minutes of being true. */
            head += ' ' + other + ' will take to the ' + (bat ? 'field' : 'crease') +
                    (ctx.start_time ? ' from ' + ctx.start_time : '') + '.';
        }
        /* NO SUPPORTING CLAUSE. The match was named here at first — but the L-frame
         * already says it twice over: the strip's footer names our XI and its
         * division, and the ladder beside it now puts bat and ball glyphs on the two
         * sides involved. A third statement of the same fact is the thing the split
         * exists to stop. */
        return { headline: head, detail: '' };
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
            if (['wicket', 'six', 'four_clip'].indexOf(ev.type) === -1) continue;
            var kindMatches = (c.event === 'wicket' && ev.type === 'wicket') ||
                              (c.event === 'six' && ev.type === 'six') ||
                              (c.event === 'four' && ev.type === 'four_clip');
            if (!kindMatches) continue;
            var who = c.dismissed || c.batter;
            if (who && (ev.payload.headline || '').indexOf(who) === -1) continue;
            ev.clip = clipOf(c);
            // A clip changes what the event IS worth and how long it needs, so both
            // are recomputed rather than left at their text-only values.
            ev.interest += CLIP_BONUS;
            ev.dwell = dwellFor(ev);
            return true;
        }
        return false;
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
        SHOW_FLOOR: SHOW_FLOOR
    };
})();

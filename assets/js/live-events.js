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
    var TYPES = {
        hundred:           { base: 92, ttl: 900000,  repeat: 420000, label: 'Hundred' },
        five_for:          { base: 90, ttl: 900000,  repeat: 420000, label: 'Five wickets' },
        match_finished:    { base: 88, ttl: 2700000, repeat: 300000, label: 'Match finished' },
        abandoned:         { base: 84, ttl: 2700000, repeat: 600000, label: 'Abandoned' },
        innings_closed:    { base: 74, ttl: 900000,  repeat: 300000, label: 'Innings closed' },
        wicket:            { base: 70, ttl: 300000,  repeat: 180000, label: 'Wicket' },
        fifty:             { base: 64, ttl: 480000,  repeat: 300000, label: 'Fifty' },
        ladder_shift:      { base: 60, ttl: 900000,  repeat: 420000, label: 'Ladder move' },
        rain_break:        { base: 56, ttl: 1800000, repeat: 600000, label: 'Rain' },
        six:               { base: 52, ttl: 240000,  repeat: 180000, label: 'Six' },
        probability_shift: { base: 48, ttl: 420000,  repeat: 300000, label: 'Swing' },
        toss:              { base: 40, ttl: 1800000, repeat: null,   label: 'Toss' },
        four_clip:         { base: 36, ttl: 240000,  repeat: null,   label: 'Four' },
        innings_update:    { base: 22, ttl: 420000,  repeat: null,   label: 'Innings' },
        ball_clip:         { base: 20, ttl: 180000,  repeat: null,   label: 'Ball' },
        score_update:      { base: 12, ttl: 180000,  repeat: null,   label: 'Score' }
    };
    function typeOf(t) { return TYPES[t] || { base: 10, ttl: 180000, repeat: null, label: t }; }

    /* TYPES THAT DESCRIBE CURRENT STATE rather than an incident. A newer one does not
     * merely outrank its predecessor — it makes it WRONG. "Chalfont 9/0 (2 ov)" is not
     * old news once 17/0 lands, it is a false statement about the score, and a surface
     * that shows it is lying to the room whatever its freshness works out to.
     *
     * Incidents are not in here and must not be: a wicket is still a true account of a
     * wicket an hour later, and a second wicket does not unmake the first. Only
     * snapshots supersede, which is exactly the set the type table already calls "the
     * floor, and not pretending to be news". */
    var SUPERSEDING = { score_update: 1, innings_update: 1 };

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

    // ---- dwell --------------------------------------------------------------
    // How long to hold an event on screen. Two regimes, and the event's own content
    // picks which: footage runs for as long as the footage runs, and text runs for
    // as long as it takes to read. Never a fixed cycle time — that was the v1
    // ticker's mistake, spending nine seconds on "Wendover 4/0" and nine on a
    // hat-trick.
    var DWELL_MIN = 4000, DWELL_MAX = 14000, MS_PER_CHAR = 55;
    // Reading time is the wrong measure for a short sentence that matters. "Wendover
    // won by 3 wickets" is read in two seconds and deserves to sit there anyway —
    // it is the answer to the question the room is asking. So the big types carry
    // their own floor, and the character count only ever raises it.
    var DWELL_FLOOR = {
        match_finished: 9000, abandoned: 8000, hundred: 9000, five_for: 8000,
        innings_closed: 7000, wicket: 6000, ladder_shift: 7000, fifty: 6000,
        rain_break: 6000, probability_shift: 6000, toss: 6000
    };
    function dwellFor(ev) {
        if (ev.clip && ev.clip.duration) {
            // The clip plus a moment either side: a beat to register what is about
            // to be shown, and a beat before the slideshow is handed back.
            return Math.round(ev.clip.duration * 1000) + 2500;
        }
        var text = [(ev.payload && ev.payload.headline) || '',
                    (ev.payload && ev.payload.detail) || ''].join(' ').trim();
        var read = Math.max(DWELL_MIN, Math.min(DWELL_MAX, text.length * MS_PER_CHAR));
        return Math.max(read, DWELL_FLOOR[ev.type] || 0);
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
        var currentUntil = 0;      // when its dwell runs out
        /* THE NUMBERS THAT WON, captured at the instant of the decision. Showing an
         * event marks it shown, which drops its novelty to zero — so by the time any
         * surface renders the ranking, the score that actually won is gone and the
         * current pick reads as a flat 0. That makes the one row you most want to
         * understand the one row you cannot. Held here instead, and substituted back in
         * by `rankedForDisplay`. */
        var currentRow = null;

        function add(ev) {
            if (!ev || !ev.id) return null;
            if (byId[ev.id]) return null;                 // already known: not news twice
            ev.shown_at = null; ev.shown_count = 0;
            ev.superseded = false;
            ev.dwell = dwellFor(ev);
            // This snapshot retires every earlier one of its kind for the same match.
            if (SUPERSEDING[ev.type]) {
                for (var s = 0; s < events.length; s++) {
                    var old = events[s];
                    if (old.type === ev.type && old.match.key === ev.match.key) old.superseded = true;
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
        function novelty(ev, now) {
            if (!ev.shown_at) return 1;
            var t = typeOf(ev.type);
            if (t.repeat == null) return 0;
            if (now - ev.shown_at < t.repeat) return 0;
            return Math.pow(0.45, ev.shown_count);
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

        /* The ranking as a surface should show it: live numbers for everything except
         * the event currently on screen, which reports the numbers it won with (see
         * `currentRow`). `at_pick` marks the substitution, so a reader can tell the one
         * row that is answering "why is this up" from the rest, which answer "what would
         * go up next". */
        function rankedForDisplay(now) {
            var rows = ranked(now);
            if (!current || !currentRow) return rows;
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].ev === current) {
                    rows[i] = { ev: current, score: currentRow.score,
                                freshness: currentRow.freshness, novelty: currentRow.novelty,
                                at_pick: true };
                    break;
                }
            }
            /* RE-SORT, because the substitution changes the row's score and `ranked`
             * ordered it on the post-mark zero — which sank the showing event to the
             * bottom, where a caller that ships only the top of the list (the engine
             * caps it) dropped the one row it most needed to send. Sorted on its winning
             * score it sits where it belongs, at or near the top. */
            return rows.sort(function (a, b) {
                return b.score - a.score || b.ev.received_at - a.ev.received_at;
            });
        }

        /* The one question, asked every tick: what should be on screen?
         *
         * An event being shown holds the screen for its whole dwell — a surface that
         * re-decided every tick would cut a clip off mid-wicket the moment a six
         * landed elsewhere. Only when the dwell expires does anything else get a
         * look, and then the best-ranked event takes it, or nothing does. */
        function tick(now) {
            now = now == null ? Date.now() : now;
            /* A DWELL PROTECTS AN EVENT, NOT A FALSEHOOD. The hold exists so a clip is
             * not cut off mid-wicket by a six landing elsewhere — but if what is on
             * screen has since been superseded, holding it keeps a wrong score up on
             * purpose. Cutting to the truth mid-dwell is the lesser harm, so a
             * superseded pick loses the screen at once. */
            if (current && current.superseded) { current = null; currentUntil = 0; currentRow = null; }
            if (current && now < currentUntil) {
                return { event: current, until: currentUntil, holding: true,
                         picked: currentRow, ranked: rankedForDisplay(now) };
            }
            var rows = ranked(now);
            var best = rows[0];
            if (!best || best.score < SHOW_FLOOR) {
                current = null; currentUntil = 0; currentRow = null;
                // The honest empty answer: nothing out there is worth a screen, so
                // the chrome should collapse rather than recycle.
                return { event: null, until: 0, holding: false, picked: null, ranked: rows,
                         reason: rows.length ? 'nothing above the floor' : 'no events' };
            }
            var ev = best.ev;
            // Captured BEFORE the marking below, which is what destroys the novelty.
            currentRow = { score: best.score, freshness: best.freshness, novelty: best.novelty };
            ev.shown_at = now;
            ev.shown_count++;
            current = ev; currentUntil = now + ev.dwell;
            return { event: ev, until: currentUntil, holding: false, picked: currentRow,
                     ranked: rankedForDisplay(now),
                     reason: ev.shown_count > 1 ? 'repeat (nothing newer)' : 'best ranked' };
        }

        return {
            add: add, tick: tick, ranked: ranked, rankedForDisplay: rankedForDisplay, score: score,
            freshness: freshness, novelty: novelty,
            all: function () { return events.slice(); },
            get: function (id) { return byId[id] || null; },
            current: function () { return current; },
            size: function () { return events.length; },
            // Test/inspector seam: drop everything and start the day again.
            reset: function () { events = []; byId = {}; current = null; currentUntil = 0; currentRow = null; }
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
                if (m.toss && m.toss.text) push('toss', 'toss', { headline: m.toss.text });
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
                push('toss', 'toss', { headline: m.toss.text });
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
                        headline: w ? (w.name + ' ' + w.runs + (w.how ? ', ' + w.how : '')) : 'Wicket',
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
        return {
            key: (ours ? 'w' : 'l') + id,
            ours: !!ours, pc_id: ours ? id : (m.pc_id != null ? m.pc_id : null),
            match_id: ours ? null : id,
            team: c.team_name || (ours ? 'Wendover' : (m.home || '')),
            opponent: c.opposition || (ours ? (m.away || '') : (m.away || '')),
            division: c.competition_short || c.competition || m.competition || '',
            title: matchTitle(m),
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
        dwellFor: dwellFor,
        TYPES: TYPES,
        SHOW_FLOOR: SHOW_FLOOR
    };
})();

/* live-status.js — ONE status vocabulary for every surface that shows somebody's
 * match in progress.
 *
 * The question every board has to answer beside a score is "how current is this?",
 * and the honest answers are few: it's live, it's paused, the scorer has gone
 * quiet, it's finished, nobody is scoring it, we can't reach the feed. Those words
 * were first worked out on the today board; the match-day board needs the same
 * ones, and two boards on one wall giving a different account of the same match
 * would be worse than either account alone. So the vocabulary lives here and the
 * templates only place it.
 *
 * TWO FEEDS, TWO KINDS OF TRUTH, and this is the whole reason the module has two
 * entry points rather than one:
 *
 *   ours()   — Results Vault, via live-worker/src/rv.mjs. It carries the scorer's
 *              own cursor (`scores_updated`), so freshness is REPORTED: we know
 *              when the scorer last synced, independently of when we last polled.
 *
 *   league() — the PC API, via live-worker/src/pc.mjs. It carries no cursor of any
 *              kind, and syncs on a 5-15 minute cadence. So freshness there can
 *              only be OBSERVED — we watch the figures and time how long they have
 *              stood still — and the bands have to be coarser than ours, because a
 *              score that hasn't moved for eight minutes is ordinary there and a
 *              stall here.
 *
 * Nothing in here paints. Each call returns { cls, text } for the caller's own
 * badge element, and the callers' CSS agrees on the class names (live / brk /
 * stale / res / play / wait / off).
 */
(function (global) {
    'use strict';

    /* OURS: how stale a live score may get before the badge stops claiming "Live"
       and starts reporting its age instead. RV is polled every ~20-30s and a
       syncing scorer lands well inside a minute, so five minutes of silence is a
       stall, not jitter. */
    var STALE_AFTER = 300;

    /* THEIRS: the same judgement made without a cursor, so on observed silence and
       against a much slower sync.
         AGED  — the figures may have moved since; a score shown now must say so.
         STALE — too long to show a mid-innings score as if it were the state of
                 play; the status replaces it.
       (A CLOSED innings is exempt from both: see `closed`.) */
    var LEAGUE_AGED = 600;
    var LEAGUE_STALE = 1800;

    /* RV's per-match scorer cursor, as epoch seconds. rv.mjs normalises it, but a
       Worker deployed before that change still sends ASP.NET's `/Date(ms)/`, and
       the two roll out independently — so parse both rather than depending on the
       newer server. */
    function scoresUpdated(card) {
        var v = card && card.scores_updated;
        if (v == null || v === '') return null;
        if (typeof v === 'number') return v > 1e11 ? Math.round(v / 1000) : v;
        var m = /\/Date\((-?\d+)/.exec(String(v));
        return m ? Math.round(Number(m[1]) / 1000) : null;
    }
    /* THE CLOCK EVERY JUDGEMENT HERE READS IS THE FEED'S OWN — `generated_at`, the
       moment the state we are looking at was assembled. Both Workers stamp it in the
       same base as the timestamps inside the payload, which is what makes an age a
       subtraction of two numbers from one clock rather than a comparison across two.

       It also happens to be the only version that works under the match-day
       simulator, which runs an afternoon in a few minutes: its cards are stamped on
       the SIMULATED clock, so a browser `Date.now()` here would price every score as
       hours stale — the one state a simulation of a working day must not manufacture.

       In production `generated_at` is within a poll (~20s) of now, so this ages a
       stalled scorer exactly as a wall clock would, at a granularity of minutes.
       Falling back to the browser clock covers a first paint with no feed yet, where
       there is nothing to age anyway. */
    function clockOf(feed) {
        var g = feed && feed.generated_at;
        if (typeof g === 'number' && g > 1e9) return g > 1e11 ? Math.floor(g / 1000) : g;
        return Math.floor((global.WccClock ? WccClock.now() : Date.now()) / 1000);
    }
    function secsSince(t, feed) { return t ? Math.max(0, clockOf(feed) - t) : null; }
    /* Coarse on purpose: at ten feet the question is "minutes or hours?", and a
       figure that ticks every second reads as noise. */
    function fmtAge(s) { return s < 5400 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; }

    /* ── OUR OWN MATCHES ───────────────────────────────────────────────────
       ONE token answering "how current is this line?". Ordered by what it would be
       dishonest to hide — a broken pipe first, then a settled result, then a
       scheduled pause (during which silence is EXPECTED and must not read as a
       stall), then the live/stalled split, then not-yet-started.

       `transport` is the engine's own poll health ('ok' | 'offline' | 'error' |
       'forbidden'), which no card can report on because a card that never arrived
       says nothing at all. */
    function ours(card, transport, feed) {
        var age = secsSince(scoresUpdated(card), feed);
        if (transport && transport !== 'ok') return { cls: 'off', text: 'No feed', age: age };
        if (!card) return { cls: 'wait', text: 'Awaiting', age: null };
        if (card.phase === 'no-feed') return { cls: 'off', text: 'No feed', age: age };
        if (card.complete) return { cls: 'res', text: 'Result', age: age };
        /* A break is a break whichever way the feed says so: rv.mjs derives
           phase 'break' from `match_break_desc`, but a card carrying the
           description without the phase is the same afternoon. */
        if (card.phase === 'break' || card.break_desc)
            return { cls: 'brk', text: 'Break', detail: card.break_desc || null, age: age };
        if (card.phase === 'live') {
            // Scored and current, or scored and gone quiet — in which case the age
            // REPLACES the word, so the column stays one token wide and a stall is
            // legible across the room.
            if (age != null && age >= STALE_AFTER)
                return { cls: 'stale', text: '↻ ' + fmtAge(age), age: age };
            return { cls: 'live', text: '● Live', age: age };
        }
        /* Nothing scored yet AND the fixture says live scoring isn't switched on —
           the book-only game that would otherwise sit on "Awaiting" all afternoon.
           Deliberately guarded on having no innings, so this hint (whose in-play
           semantics are still unconfirmed) can never contradict a score we can see.

           "SCORE BOOK" AND NOT "NOT SCORED": the past tense read as a verdict on a
           finished game, which is the one thing this state does not say — the match
           may not have started, may be half over, may be long finished, and all this
           token claims is that no live score is coming from it. A noun has no tense to
           mislead with, and it says where the scoring IS rather than that there is
           none. Nor "offline", which is what a broken feed is: the distinction this
           token exists to draw is that nothing is wrong at our end — somebody is
           keeping this game perfectly well, on paper. */
        if (card.live_scoring_allowed === false && !(card.innings || []).length)
            return { cls: 'off', text: 'Score book', age: age };
        return { cls: 'wait', text: 'Awaiting', age: age };
    }

    /* ── SOMEBODY ELSE'S MATCH ─────────────────────────────────────────────
       OBSERVED FRESHNESS. The PC API states no time of any kind about the scoring,
       so the only available evidence is whether the figures have changed since we
       last looked. Kept per match id for the life of the page.

       FIRST SIGHT COUNTS AS NOW, which matters: a board opened at four o'clock has
       no idea how long the numbers on it have stood, and inventing an age would
       accuse a scorer who may have synced a minute ago. So a square starts fresh
       and only earns an age by standing still while we watch. */
    var watch = {};

    // The figures, as a string that changes whenever any of them does. Innings
    // order included, so a second innings starting counts as movement.
    function signature(card) {
        return ((card && card.innings) || []).map(function (inn) {
            return [inn.team_batting_id, inn.runs, inn.wickets, inn.overs,
                    inn.declared ? 'd' : ''].join('/');
        }).join('|') + (card && card.complete ? '#done' : '');
    }
    /* How long this match's figures have stood unchanged, in seconds — null when
       there are no figures yet (nothing to be stale ABOUT: that's a state, and the
       state token says it). Call it once per poll per match: it records what it
       saw, so calling it is how the watch is kept. `feed` is the envelope the card
       came in, whose `generated_at` is the clock (see clockOf). */
    function observe(key, card, feed) {
        var sig = signature(card), now = clockOf(feed);
        var w = watch[key];
        if (!w || w.sig !== sig) { w = watch[key] = { sig: sig, since: now }; }
        return ((card && card.innings) || []).length ? Math.max(0, now - w.since) : null;
    }
    /* Which band an observed age falls in. The caller needs the band rather than
       the number, because the three bands are three different presentations. */
    function band(age) {
        if (age == null) return 'fresh';
        if (age >= LEAGUE_STALE) return 'stale';
        if (age >= LEAGUE_AGED) return 'aged';
        return 'fresh';
    }
    /* An innings nothing can change any more — and so an innings whose figure is
       exempt from every freshness rule, however old it is. Two closed innings on a
       finished game is just a result, and a first innings total stops being news
       the moment the chase starts.

       `closed` is set at the source by rv.mjs; pc.mjs states no such thing, so it
       is derived here from what the API does give: a later innings supersedes this
       one, a declaration closes it, ten down closes it, and a decided match closes
       everything. (Not team-size-agnostic like rv.mjs's `allOut` — the PC card
       carries no roster to count.) */
    function closed(card, inn) {
        if (!inn) return false;
        if (inn.closed != null) return !!inn.closed;
        if (!card) return false;
        if (card.complete) return true;
        if (inn.declared || (inn.wickets || 0) >= 10) return true;
        var inns = card.innings || [];
        return inns.length > 1 && inns.indexOf(inn) === 0;
    }
    /* THE STATE TOKEN for somebody else's match: state only, never freshness —
       except where staleness IS the state worth reporting, which is a score too old
       to stand. Deliberately not the red "● Live": PC-API is result-granularity on
       a 5-15 minute sync, so it can say what state a game is in but never that a
       score is current, and calmer type keeps that promise honest.

       Null when the league poll has said nothing about this match at all, rather
       than asserting "not started" about a game we simply haven't heard from. */
    function league(card, age) {
        if (!card) return null;
        if (card.phase === 'no-feed') return { cls: 'off', text: 'No feed' };
        if (card.complete) return { cls: 'res', text: 'Result' };
        if (band(age) === 'stale') return { cls: 'stale', text: '↻ ' + fmtAge(age) };
        /* Under way per the feed. With innings behind it that's a scored game; with
           none it's PC's "Match In Progress" placeholder — a real and common state
           (a game nobody is scoring ball by ball), and the one thing we can say
           about it truthfully. */
        if (card.phase === 'live') return { cls: 'play', text: 'In play' };
        if (card.phase === 'pre') return { cls: 'wait', text: 'Awaiting' };
        return null;
    }

    global.WccStatus = {
        ours: ours, league: league, observe: observe, band: band, closed: closed,
        fmtAge: fmtAge, scoresUpdated: scoresUpdated, secsSince: secsSince,
        STALE_AFTER: STALE_AFTER, LEAGUE_AGED: LEAGUE_AGED, LEAGUE_STALE: LEAGUE_STALE
    };
})(window);

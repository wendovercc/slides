/* live-ladder.js — the division ladder on a match day: which side of a fixture a
 * team is, what state its tile is in, what its result was worth, and where the
 * table goes from here (display order, and the pending-move arrows).
 *
 * MOVED OUT OF templates/live-strip.html (2026-10-01) so the engine can run the
 * same arithmetic over EVERY division, not just the one the strip is drawing —
 * the arrows are about to drive the "expected league position" events, and the
 * committed moves the "actual league position" ones. One copy, so the arrows on
 * the column and the events in the band cannot disagree. Pure and DOM-free, like
 * live-chase.js: no feeds, no timers, no state. Needs live-chase.js and
 * tvcl-points.js loaded first (both degrade to "nothing claimed" when absent).
 */
(function () {
    'use strict';

    // ---- side resolution ----------------------------------------------------
    // Everything here binds by ID, never by name. Both feeds identify sides
    // structurally — RV per innings/team with `is_home`, PC with `team_batting_id`
    // against `home_team_id` — and the baked fixture says which team id is at home,
    // so a tile resolves to 'home' or 'away' and the two meet there.
    //
    // This used to be a name join, and it was the wrong idea: a scorecard names a
    // side by TEAM ("Wendover CC Friendly XI"), our context by CLUB ("Wendover CC"),
    // with an arbitrary designation tail between them — and a club's own name can
    // itself end in "XI" ("Captain Scott Invitation XI Sunday 1st XI"), so no amount
    // of suffix-stripping is safe. A failed join was silent and looked like two
    // unrelated rendering bugs.

    // Which side of its fixture a tile's team is.
    function tileSide(team, fx) {
        if (!fx || !team.team_id || !fx.home_team_id) return null;
        return String(team.team_id) === String(fx.home_team_id) ? 'home' : 'away';
    }
    // Which side an innings belongs to. RV states it outright; PC gives the batting
    // team's id to compare against the card's home team.
    function inningsSide(card, inn) {
        if (typeof inn.is_home === 'boolean') return inn.is_home ? 'home' : 'away';
        if (inn.team_batting_id && card.home_team_id)
            return String(inn.team_batting_id) === String(card.home_team_id) ? 'home' : 'away';
        return null;
    }
    var other = function (side) { return side === 'home' ? 'away' : 'home'; };

    // Win/loss for one side of a completed match — again without reading prose.
    // Published results come from the feed's own verdict (RV states it per team, PC
    // as the winning team's id). Between "decided" and "published" neither exists
    // yet, so fall back to the scorecard: whoever has more runs is winning. A tie,
    // draw or abandonment leans neither way.
    function outcomeFor(card, side) {
        var t = (card.teams || []).filter(function (x) {
            return (x.is_home ? 'home' : 'away') === side; })[0];
        if (t && t.outcome) {
            return t.outcome === 'won' ? 'win' : t.outcome === 'lost' ? 'loss' : null;
        }
        if ('result_applied_to' in card) {   // PC card: null = nobody won
            if (!card.result_applied_to) return null;
            var winner = String(card.result_applied_to) === String(card.home_team_id) ? 'home' : 'away';
            return winner === side ? 'win' : 'loss';
        }
        var runs = {};
        (card.innings || []).forEach(function (inn) {
            var s = inningsSide(card, inn);
            if (s) runs[s] = (runs[s] || 0) + (inn.runs || 0);
        });
        if (runs.home == null || runs.away == null || runs.home === runs.away) return null;
        return (runs[side] > runs[other(side)]) ? 'win' : 'loss';
    }

    /* THE VERDICT BADGE'S CASE, as the match-day board reads it (`verdictOf` there):
       structural first — a winner is a winner whichever feed says so — and the
       result text only for the games nobody won. Nothing readable → no badge,
       rather than a guessed one. */
    function verdictFor(card, side) {
        var o = outcomeFor(card, side);
        if (o) return o === 'win' ? 'W' : 'L';
        var t = String(card.result_club || card.result || '');
        if (/\btied?\b/i.test(t)) return 'T';
        if (/draw/i.test(t)) return 'D';
        if (/abandon|wash/i.test(t)) return 'A';
        if (/cancel/i.test(t)) return 'C';
        if (/no result/i.test(t)) return 'NR';
        return null;
    }

    // The chase model lives in live-chase.js. Absent → no lean and no certainty,
    // which is the first-innings presentation (see the asset-cache-skew note).
    function chaseState(inns) { return window.WccChase ? WccChase.chaseState(inns) : null; }

    // A match card + WHICH SIDE of it a tile is -> that tile's channels. The single
    // point where feed shapes become tile state; everything above it is model,
    // everything below it is paint. A side we can't resolve (a seeded match with no
    // team ids) reads as a silent feed rather than guessing.
    /* IS THIS MATCH ACTUALLY ON? — the board's `cls: 'play'`, which is what the
       silent dot is supposed to mean and what it had stopped meaning. A break counts:
       the game is under way, the players are just off the field. */
    function onNow(card) {
        return !!card && (card.phase === 'live' || card.phase === 'break' || !!card.break_desc);
    }

    /* THREE IDLE STATES, matching the three the match-day board draws (`WccStatus`
       classes 'play' / 'wait' / 'off'):

         'nodata'  THE DOT — the match is ON and we have no score for it. Either
                   nobody is scoring it ball by ball, or the score we had has been
                   withdrawn as stale. "Match on but no data", which is what the dot
                   has always said it meant.
         'quiet'   NO MARK, ordinary tile — a fixture today that has not started, or
                   one the feed has said nothing about. The board is deliberately
                   silent here too ("rather than asserting 'not started' about a game
                   we simply haven't heard from"), and a dot would be this tile
                   claiming a game is under way when it is not.
         'none'    DIMMED — no fixture at all today. Not playing, not waiting.

       The dot used to go on ALL of these but the last, so a side yet to start looked
       exactly like one in play with an unscored card — which is what made two of the
       division's four games indistinguishable from the other two. */
    function assess(card, side, ourSide, stale) {
        if (!card) return { idle: 'quiet' };
        /* NO FEED is the board's third class and the strip has no third mark for it,
           so it lands on 'quiet' — the honest half of the choice, since the alternative
           was to keep asserting a game was in play when the truth is we could not
           reach it. It does mean a fetch failure now looks like a game not yet
           started; see the note in the commit. */
        if (card.phase === 'no-feed') return { idle: 'quiet' };
        if (!side) return { idle: 'quiet' };
        var inns = card.innings || [];
        /* A DECIDED MATCH HAS A VERDICT, NOT A LEAN. The fill is the swingometer, and
           it is only honest while there is still a game to swing; once it is over the
           tile wears the match-day board's verdict badge instead (see `.res`), whether
           or not the scorer has confirmed it.
           > James's direction, 2026-09-30.
           `final` is the scorer's confirmation (our rich feed only). Decided but
           unconfirmed keeps the clock beside the badge. */
        if (card.complete) {
            return { done: true, verdict: verdictFor(card, side), provisional: card.final === false };
        }
        /* THE TOSS PUTS THE GLYPHS UP BEFORE A BALL IS BOWLED. Until it did, the role
           came only from the last innings in the card, so between the toss and the
           first ball both tiles sat blank — `idle: 'nodata'`, the same state as a
           feed saying nothing at all — while the feed in fact knew exactly who was
           about to bat. A role and no lean is already the first-innings presentation
           (`certainty = 0` below), so this is that same state, half an hour earlier.

           `phase: 'pre'` no longer short-circuits above for the same reason: a
           pre-match card with the toss in it has something to say. One without still
           lands on `nodata`, through the innings check here. */
        if (!inns.length) {
            var firstBat = window.WccChase ? WccChase.battingFirst(card, ourSide) : null;
            // No toss either: the dot only if the game is actually under way — a
            // scoreless card for a match nobody is scoring. Before the start, quiet.
            if (!firstBat) return { idle: onNow(card) ? 'nodata' : 'quiet' };
            return { role: firstBat === side ? 'bat' : 'bowl', certainty: 0 };
        }
        /* A SCORE THE BOARD HAS WITHDRAWN MUST NOT BE LADDERED. `stale` is the
           match-day board's own judgement, computed by the caller from the same
           `live-status.js` bands the squares use — so the two surfaces cannot give
           different accounts of the same match.

           The board strikes three things on a stale square: the batting-half marker,
           the chase pricing (`setSwing(null)`) and the score itself, which the status
           token replaces. Those are exactly this tile's role glyph, its lean and
           certainty, and its TLA-with-a-dot — so withdrawing to the silent-feed state
           is the same decision made in the strip's own vocabulary. It also settles
           the ladder for free: with no `p` on the row, `expectedPoints` falls back to
           neutral, so no ghost arrow and no projected reorder rides a score we have
           just said we do not trust. */
        if (stale) return { idle: 'nodata' };
        var cur = inns[inns.length - 1];
        var batting = inningsSide(card, cur) === side;
        /* `live` is what the dot reports: this match has a card, it has an innings in
           it, it is not complete and the score is not stale — which is precisely "we
           are receiving scores for this game". It is not the same as `role`, which
           said WHICH SIDE was in; that pair has gone (see `.dot`). */
        var out = { role: batting ? 'bat' : 'bowl', live: true };
        var chase = chaseState(inns);
        if (chase) {
            // p is the chasing side's; mirror it for the side defending.
            var p = batting ? chase.p : 1 - chase.p;
            out.lean = p >= 0.5 ? 'win' : 'loss';
            out.certainty = Math.min(0.95, Math.abs(2 * p - 1));
            out.p = p;
        } else {
            out.certainty = 0;   // first innings — a role, no lean
        }
        return out;
    }

    function fixtureForTeam(view, teamId) {
        var fxs = view.fixtures || [];
        for (var i = 0; i < fxs.length; i++) {
            if ((fxs[i].team_ids || []).indexOf(teamId) !== -1) return fxs[i];
        }
        return null;
    }


    // ---- league points ------------------------------------------------------
    // TVCL Win/Lose (Match Rules §9), in tvcl-points.js because the match-day
    // board badges finished games with the same figures. Absent script (a page
    // newer than its cached assets) prices nothing, which the ladder already
    // treats as "not final" and so holds position for.
    function tvclPoints(inns, resultText) {
        return window.WccPoints ? WccPoints.tvcl(inns, resultText) : null;
    }

    // What one side actually earned, once its match is decided. Prefers the
    // server-computed figure on our own rich card; falls back to the port above for
    // the division's other matches. Null when it can't be priced — which the ladder
    // treats as "not final", so it holds position rather than guessing.
    function settledPoints(view, card, side) {
        if (!view.tvcl || !card || !card.complete) return null;
        var inns = card.innings || [];
        var idx = -1;
        for (var i = 0; i < inns.length; i++) if (inningsSide(card, inns[i]) === side) { idx = i; break; }
        if (idx >= 0 && inns[idx].points != null) return inns[idx].points;
        /* Equal figures need no innings to index into: a washout is 7 each whatever
           was bowled, and is usually called off with nothing in the book at all —
           the board's `pricePoints` makes the same exception. */
        var pts = tvclPoints(inns, card.result);
        if (!pts) return null;
        if (pts[0] === pts[1]) return pts[0];
        return idx < 0 ? null : pts[idx];
    }

    // A LOSS IS NOT ZERO. TVCL gives the beaten side batting + bowling bonus points
    // — a team bowled out for 150 that took 6 wickets still banks 8. So the value of
    // an unfinished match is a blend, and even a near-certain loss is worth
    // something. This average stands in for the loser's bonus while a match is
    // still running; once it's decided, settledPoints() replaces it with the real
    // figure. Deliberately a single documented constant, not a model.
    var LOSS_BONUS = 7;
    function expectedPoints(p, winPoints) {
        return p * winPoints + (1 - p) * LOSS_BONUS;
    }

    // ---- the ladder ---------------------------------------------------------
    // Three orders, doing three different jobs:
    //   DISPLAY   — where tiles actually sit. League order, with a swap applied only
    //               when BOTH teams involved are final (settled, or not playing at
    //               all). An unfinished match is a barrier: nothing may jump a team
    //               whose result is still unknown, so the ladder moves once, when
    //               it's earned, instead of twice.
    //   BASELINE  — every unfinished match priced at its neutral expectation.
    //   PROJECTED — the same, but priced at what's ACTUALLY happening out there.
    // The ghost is BASELINE → PROJECTED, so it means "how today is going versus what
    // was expected of it" — not "who has a fixture". At the first ball the two
    // orders are identical and the strip is arrow-free; arrows appear only as
    // matches diverge, and grow as certainty does.
    function ladder(view, rows) {
        var wp = view.win_points;
        // No points system, or a table that may already count today, and the whole
        // overlay is unsafe — show the league's own order and no arrows.
        if (!wp || view.table_counts_today) return rows;

        var neutral = expectedPoints(0.5, wp);
        rows.forEach(function (r) {
            var known = r.points != null;
            r.ptsNow = known ? r.points + (r.settledPts || 0) : null;
            r.final = r.idle === 'none' || r.settledPts != null;
            var pending = known && !r.final && r.idle !== 'none';
            r.base = known ? r.ptsNow + (pending ? neutral : 0) : null;
            // p is only known once a chase is on; before that a match sits at its
            // neutral value, which is exactly why nothing moves in a first innings.
            r.proj = known ? r.ptsNow + (pending ? expectedPoints(r.p != null ? r.p : 0.5, wp) : 0) : null;
        });
        if (rows.some(function (r) { return r.ptsNow == null; })) return rows;

        // DISPLAY: adjacent swaps only, and only between two final teams.
        var out = rows.slice(), swapped = true, guard = 0;
        while (swapped && guard++ < 50) {
            swapped = false;
            for (var i = 0; i + 1 < out.length; i++) {
                var a = out[i], b = out[i + 1];
                if (a.final && b.final && b.ptsNow > a.ptsNow) {
                    out[i] = b; out[i + 1] = a; swapped = true;
                }
            }
        }

        // GHOST: rank under BASELINE vs under PROJECTED. Shown only for matches
        // still in play — a settled team has nothing pending, and its tile has
        // already moved.
        var byBase = rows.slice().sort(function (x, y) { return y.base - x.base || rows.indexOf(x) - rows.indexOf(y); });
        var byProj = rows.slice().sort(function (x, y) { return y.proj - x.proj || rows.indexOf(x) - rows.indexOf(y); });
        /* LIKE FOR LIKE, OR NO ARROW. A side is only PRICED when its projection is a
           reading of its game: a chase on (`p`), or a result (`final` — settled, or
           not playing, whose points cannot move). Anything else — no score, a first
           innings, a stale one withdrawn — sits at the neutral value, a placeholder.
           A chase going well passes a placeholder on paper whatever is happening in
           that other game, so an arrow is drawn only when the side AND every side it
           crosses are priced. The band's "on course" event fires off this arrow, so
           the two cannot disagree.
           > James's direction, 2026-10-01 (SIM 15:57: Gerrards Cross "above
           Chesham", with no score in Chesham's game at all). */
        var priced = function (r) { return r.p != null || r.final; };
        rows.forEach(function (r) {
            r.baseRank = byBase.indexOf(r) + 1;
            r.projRank = byProj.indexOf(r) + 1;
        });
        rows.forEach(function (r) {
            /* THE TWO RANKS THE ARROW IS THE DIFFERENCE OF, kept for the band: the
               expected-position event says where a side is heading ("up to 3rd") and
               whom it would pass, and both are read off these rather than re-derived. */
            if (r.final || r.idle || !priced(r)) return;
            var crossesUnpriced = rows.some(function (q) {
                return q !== r && !priced(q) &&
                       (q.baseRank < r.baseRank) !== (q.projRank < r.projRank);
            });
            if (crossesUnpriced) return;
            var move = byBase.indexOf(r) - byProj.indexOf(r);
            if (move > 0) { r.ghost = 'up'; r.ghostN = move; }
            else if (move < 0) { r.ghost = 'down'; r.ghostN = -move; }
        });
        return out;
    }

    /* THE LADDER FOR ONE DIVISION VIEW: every team's row, in display order, with
       its arrow. `cardOf(fx)` and `staleOf(fx, card)` are the caller's — the feeds
       and the freshness watch are state the caller holds, and this module has none. */
    function rows(view, cardOf, staleOf) {
        var out = (view.teams || []).map(function (team) {
            var fx = fixtureForTeam(view, team.team_id);
            var card = fx ? cardOf(fx) : null;
            var side = fx ? tileSide(team, fx) : null;
            /* Which side of THIS tile's fixture is Wendover, for the toss to be read
               against — `battingFirst` needs it to put "we bat" on the home/away axis
               the tiles bind to. Only our own fixture has a toss in the feed at all
               (the league feed carries none), and there we are one of the two sides,
               so the tile's own `ours` flag answers it without a lookup. */
            var ourSide = (fx && fx.ours && side) ? (team.ours ? side : other(side)) : null;
            var state = fx ? assess(card, side, ourSide, staleOf ? staleOf(fx, card) : false) : { idle: 'none' };
            /* The identity comes along now, not just the tag: an expanded row draws
               the crest, the club and the XI, and it is the same team object the
               scoreboard reads those off. */
            var t = { key: team.team_id, tla: team.tla, ours: team.ours, wendover: team.wendover,
                      points: team.points,
                      crest: team.crest, club: team.club, desig: team.desig,
                      settledPts: fx ? settledPoints(view, card, side) : null };
            for (var k in state) if (state.hasOwnProperty(k)) t[k] = state[k];
            return t;
        });
        return ladder(view, out);
    }

    /* IS THIS CARD'S SCORE TOO OLD TO LADDER? — the match-day board's rule, reached
       the way it reaches it (`paintSquare`). `envelope()` returns the last league
       feed, whose `generated_at` is the clock `WccStatus` ages against.

       ONLY SOMEBODY ELSE'S MATCHES: the board keeps our own score up with its age
       beside it, so withdrawing ours here would overrule it. A CLOSED INNINGS IS
       EXEMPT — nothing can change it, so there is nothing to be stale about.

       `observe` records what it saw and is idempotent while the figures hold still,
       so it is safe to ask as often as a caller renders. One copy, in here, because
       the strip and the engine must withdraw the same scores or their arrows differ.
       No live-status.js → nothing is ever stale, which is the pre-module behaviour. */
    function staleness(envelope) {
        return function (fx, card) {
            var S = window.WccStatus;
            if (!S || !fx || fx.ours || !card || card.complete) return false;
            var inns = card.innings || [];
            var cur = inns.length ? inns[inns.length - 1] : null;
            var age = S.observe('l' + fx.match_id, card, envelope ? envelope() : null);
            if (!cur || S.closed(card, cur)) return false;
            return S.band(age) === 'stale';
        };
    }

    window.WccLadder = {
        staleness: staleness,
        tileSide: tileSide,
        inningsSide: inningsSide,
        other: other,
        outcomeFor: outcomeFor,
        verdictFor: verdictFor,
        onNow: onNow,
        assess: assess,
        fixtureForTeam: fixtureForTeam,
        settledPoints: settledPoints,
        expectedPoints: expectedPoints,
        ladder: ladder,
        rows: rows
    };
})();

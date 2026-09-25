/* live-sim.js — an accelerated match day, for a club that plays six months a year.
 *
 * There is no live cricket most days and none at all out of season, so the live
 * layer would otherwise only ever be developed against an empty feed. This is the
 * whole day in a few minutes: a deterministic ball-by-ball simulation of our own
 * matches and the division's others, turned into the exact feed shapes the Worker
 * emits (`rv.mjs` for ours, `pc.mjs` for the league's), handed to the REAL engine
 * through its `transport` seam.
 *
 * Nothing downstream knows it is a simulation. The engine polls, holds the previous
 * snapshot, differentiates it into events (live-events.js), schedules them and
 * broadcasts — all shipping code. That is the point: a parallel mock would test the
 * mock, and the thing actually worth testing is the diff.
 *
 * Load: any player URL with `?sim=matchday`, e.g.
 *     http://localhost:8000/slideshow/live/?sim=matchday
 * It arrives PAUSED at the start of the day with one poll on screen, so nothing moves
 * until you ask it to. Add `&play` to start it running, or `&at=16:20` to begin part
 * way through the afternoon.
 * Needs no build inputs and no access key — it invents the day (see DAY below), so
 * it works in December on a repo with an empty live-config.json.
 *
 * ONE AXIS, AND IT IS THE DAY'S OWN CLOCK. Sim time — milliseconds since the day began
 * at DAY_START_MIN — is the only thing the controls move. Which over each match is in,
 * how old an event is, when the feed last spoke and what the scheduler thinks "now" is
 * are all functions of it, so there is one thing to drag and "paused" has one meaning:
 * nothing is moving, the deck included.
 *
 *   k               play / pause (paused at boot)
 *   c               straight to the next change ON SCREEN — what the scheduler shows,
 *                   which is not the same question as what happens
 *   [ / ]           slower / faster (x15, x60, x240 real time)
 *   . or n          one poll on (15s while play is on, 30 either side of it)
 *   >               five minutes on
 *   o               to the next over anywhere in play
 *   e               to the next incident — the markers on the bar
 *   b               a minute BACK, which restarts the day there (see below)
 *   r  restart      h  hide/show the HUD
 *
 * The bar under the HUD is the whole afternoon: click it to skip ahead.
 *
 * These deliberately avoid every key player-core.js binds (Space, arrows, Home, End,
 * PageDown, Escape, f/F): both keydown listeners are on the same document, so a shared
 * key would make one press do two unrelated things. Space and → still drive the deck.
 *
 * WHY THERE IS NO STEPPING BACK. The engine holds the previous poll to diff against and
 * the store only ever accumulates, so the day can be run on but not rewound — a rewind
 * would have to rebuild both. A reload rebuilds both for nothing, so `b` and a click
 * behind the playhead reload with `&at=`, which runs the day up to that point and
 * leaves a store that honestly holds the day so far.
 *
 * THE FEEDS ARE POLLED AT THEIR REAL CADENCES, which are not the same as each other.
 * OUR matches every 15 seconds of sim time while something is in play and every 30 either
 * side of that; the DIVISION every five minutes all day, on its own timer. So sixteen
 * polls to a four-minute over on our side and a twentieth of that on the league's, most
 * of them returning a scorecard that has not changed. That is what an afternoon actually
 * looks like, and the unchanged-poll diff is a path the old one-poll-per-over simulation
 * never took. In manual mode the engine schedules nothing, so the simulator is the only
 * thing that decides the ratio between the two — and a chrome tuned against a division
 * that moved as briskly as our own matches would be tuned against a fiction.
 * Matches start at staggered times and finish at different ones, so one run passes
 * through every phase: a toss, first innings, a target set, a chase turning,
 * milestones, a five-for, clips arriving, a rain break, an abandonment, a
 * decided-but-unconfirmed result, and a confirmed one.
 */
(function () {
    if (!/(^|[?&])sim=matchday($|[&])/.test(location.search)) return;

    // ---- the one axis -------------------------------------------------------
    /* SIM TIME, in milliseconds since the day began, is the only clock in here — and it
     * is the DAY's clock rather than a scheduler's. An over takes four minutes of it and
     * the feed is polled every fifteen seconds of it, both of which are what they are on
     * a real Saturday.
     *
     * The simulator used to run one poll per over and then tell the model that poll had
     * taken fifteen seconds: sixteen times out, and out it had to be, because a poll
     * that aged the day by four minutes would have expired a wicket's three-minute
     * repeat window before the next one arrived. Not compressing is what removes the
     * discrepancy, and it buys the unchanged-poll diff — most of a real afternoon — for
     * nothing. */
    var DAY_START_MIN = 12 * 60 + 30;      // the day opens at 12:30…
    var DAY_END_MIN = 20 * 60;             // …and the bar runs to 20:00
    var DAY_MS = (DAY_END_MIN - DAY_START_MIN) * 60000;
    var OVER_MS = 240000;                  // four minutes an over
    /* THE ENGINE'S OWN THREE CADENCES, and the league's. Our matches are polled fast
     * while something is in play and half as often either side of that; the division is
     * polled every five minutes all day, on its own timer. Those are `FAST`/`SLOW`/`IDLE`
     * and `LEAGUE_MS` in live-engine.js — and in manual mode the engine schedules nothing,
     * so the simulator is the only thing that decides the ratio between them. Getting it
     * wrong would show the chrome a division that moved as briskly as our own matches. */
    var FAST_MS = 15000, SLOW_MS = 30000, IDLE_MS = 120000;
    var LEAGUE_MS = 300000;
    /* Coarser, while HISTORY is being skipped. The polls in between still happen, in
     * order, because the store is built out of the differences between them — but their
     * spacing is not what anybody is looking at on the way past. */
    var SEEK_POLL_MS = 60000;
    var INNINGS_BREAK_MS = 480000;         // eight minutes between innings
    function mins(n) { return Math.round(n * 60000); }
    /* A TIME OF DAY, as an offset into the day. The fixtures are written the way the
     * clock says it, because "the shower arrives at 15:00" is a fact about an afternoon,
     * where `rainAt: 30` was a fact about a loop counter. */
    function at(hhmmStr) {
        var p = String(hhmmStr).split(':');
        return ((parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0) - DAY_START_MIN) * 60000;
    }
    function hhmm(ms) {
        var m = DAY_START_MIN + Math.floor(ms / 60000);
        return Math.floor(m / 60) + ':' + String(((m % 60) + 60) % 60).padStart(2, '0');
    }

    // ---- the day ------------------------------------------------------------
    // Invented rather than read from the build, so the simulator has no
    // prerequisites. Deliberately the awkward shape of a real Saturday: two of our
    // sides in different divisions, one of them streamed, plus the rest of one
    // division playing each other.
    var DAY = {
        ours: [
            { pc_id: 7400001, team_name: '1st XI', competition_short: 'TVCL Div 4A',
              our_club: 'Wendover CC', opposition: 'Chalfont St Peter CC', is_home: true,
              streamed: true, allot: 45, start: at('13:00'), publishAfter: mins(25),
              seed: 17,
              // A shower midway through, then play resumes; and the result sits
              // unconfirmed for twenty-five minutes, which is the window the chrome
              // has to hedge with "to be confirmed".
              beats: { clips: true, rainFrom: at('15:00'), rainFor: mins(20) } },
            // WE BAT FIRST here, which is not decoration: it puts our innings at
            // innings[0] and the opposition's chase at innings[1], the mirror of the
            // match above. Every consumer that binds a side by position rather than
            // by identity breaks on one of the two, so one run covers both.
            // A hundred needs an innings with enough runs in it to hold one, which a
            // 200-run chase does not — hence the beat lives on this side of the card.
            { pc_id: 7400002, team_name: '2nd XI', competition_short: 'TVCL Div 6C',
              our_club: 'Wendover CC', opposition: 'Amersham CC', is_home: false,
              weBatFirst: true,
              streamed: false, allot: 40, start: at('13:15'), publishAfter: mins(8),
              seed: 29,
              // A hundred and a five-for guaranteed, so the rare events are in
              // every run rather than in one run out of ten.
              beats: { hundred: true, fiveFor: true } }
        ],
        // The rest of the 2nd XI's division, on the lean PC feed. One is rained off
        // and abandoned; one finishes early and posts its result; one never says
        // anything at all (a match scored in the book).
        league: [
            { match_id: 7410001, home: 'Chesham CC', away: 'Tring Park CC',
              competition: 'TVCL Div 6C', allot: 40, start: at('13:00'), seed: 41 },
            { match_id: 7410002, home: 'Aylesbury Town CC', away: 'Berkhamsted CC',
              competition: 'TVCL Div 6C', allot: 40, start: at('12:45'), seed: 53,
              beats: { rainFrom: at('14:15'), abandon: true } },
            { match_id: 7410003, home: 'Great Missenden CC', away: 'Wycombe House CC',
              competition: 'TVCL Div 6C', allot: 40, start: at('12:55'), seed: 67 },
            { match_id: 7410004, home: 'Flackwell Heath CC', away: 'Hazlemere CC',
              competition: 'TVCL Div 6C', allot: 40, start: at('13:10'), seed: 79, silent: true }
        ]
    };

    var NAMES = ['Harrington', 'Jackson', 'Duff', 'Roan', 'Godden', 'Nash', 'Whitfield',
                 'Pardoe', 'Sealey', 'Brackley', 'Ingram', 'Moulton', 'Carver', 'Rennie',
                 'Fairhead', 'Lomax', 'Beckworth', 'Quill', 'Tandy', 'Vane', 'Oakes', 'Peverell'];
    var INITIALS = 'ABCDEFGHJKLMNPRSTW';

    // ---- deterministic randomness -------------------------------------------
    // A seed gives the same match every run, which is what makes a rendering bug
    // reproducible and a weight change comparable.
    function rng(seed) {
        var s = (seed >>> 0) || 1;
        return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    }
    function pick(r, list) { return list[Math.floor(r() * list.length) % list.length]; }
    /* Eleven names, drawn from a slice of the pool that BELONGS to this side. The
     * naive version drew both teams from the whole list and put the same surname on
     * both cards, which reads as a bug in the extractor rather than as a coincidence
     * — and worse, the extractor keys batters and bowlers BY NAME, so a shared name
     * across innings is a genuine collision risk in the thing under test. */
    function squad(seed, half) {
        var r = rng(seed);
        var pool = half ? NAMES.slice(0, 11) : NAMES.slice(11);
        var used = {}, out = [];
        while (out.length < 11) {
            var n = pick(r, pool);
            var nm = INITIALS[Math.floor(r() * INITIALS.length)] + ' ' + n;
            if (used[nm]) continue;
            used[nm] = 1;
            out.push(nm);
        }
        return out;
    }

    // ---- the scorecard engine ----------------------------------------------
    // A real innings, ball by ball, because the events downstream are differences
    // between scorecards: a fifty is a batter's runs crossing fifty, a five-for is a
    // bowler's column, a wicket is the wickets count moving AND a named dismissal.
    // Fabricating summary lines would produce a feed no extractor could read.
    var OUT_KINDS = [
        { id: 1, kind: 'caught', how: function (f, b) { return 'c ' + f + ' b ' + b; } },
        { id: 2, kind: 'bowled', how: function (f, b) { return 'b ' + b; } },
        { id: 3, kind: 'lbw', how: function (f, b) { return 'lbw  b ' + b; } },
        { id: 4, kind: 'run_out', how: function (f) { return 'ro (' + f + ')'; } },
        { id: 5, kind: 'stumped', how: function (f, b) { return 'st ' + f + ' b ' + b; } }
    ];

    function playInnings(cfg) {
        var r = rng(cfg.seed);
        var bats = cfg.batting.map(function (n, i) {
            return { name: n, runs: 0, balls: 0, fours: 0, sixes: 0, sr: null, pos: i + 1,
                     dismissal_id: 0, out_kind: null, fielder: null, how: 'not out',
                     fow_order: null, fow: null };
        });
        var bowls = cfg.bowling.slice(0, 6).map(function (n) {
            return { name: n, balls: 0, maidens: 0, runs: 0, wickets: 0, wides: 0, no_balls: 0 };
        });
        var extras = { total: 0, nb: 0, wd: 0, b: 0, lb: 0 };
        var runs = 0, wkts = 0, balls = 0;
        var striker = 0, nonStriker = 1, nextIn = 2;
        var fall = [];
        var snaps = [];            // one per completed over
        /* PER-BALL OUTCOME WEIGHTS, set to look like Saturday league cricket rather
         * than a T20 highlights package: about five and a half an over, a dozen-odd
         * fours and a couple of sixes an innings. Worth getting right rather than
         * eyeballing — the whole point of the simulator is that the numbers flowing
         * through the chrome are plausible, and a 500-run innings makes every
         * milestone and every chase calculation nonsense.
         *
         * `temper` is the day's pitch and attack, and it moves the BOUNDARIES (which
         * is what actually differs between a flat track and a green one), with the
         * dots absorbing the difference. */
        var temper = 0.78 + r() * 0.5;
        var pFour = 0.095 * temper, pSix = 0.022 * temper;
        var pOne = 0.26, pTwo = 0.09, pThree = 0.015;
        var pDot = Math.max(0.12, 1 - (pFour + pSix + pOne + pTwo + pThree));
        var pWide = 0.028;
        // Beats: a batter who must reach three figures, a bowler who must take five.
        var heroIdx = cfg.beats && cfg.beats.hundred ? 2 : -1;
        var villainIdx = cfg.beats && cfg.beats.fiveFor ? 1 : -1;

        function snapshot(overNo) {
            var at = [bats[striker], bats[nonStriker]].filter(function (b) {
                return b && b.dismissal_id === 0;
            }).map(clone);
            var out = bats.filter(function (b) { return b.dismissal_id !== 0; });
            snaps.push({
                over: overNo, runs: runs, wickets: wkts, overs: fmtOvers(balls),
                extras: clone(extras),
                batters: bats.filter(function (b) { return b.balls > 0 || b.dismissal_id !== 0 || b.pos <= nextIn; }).map(clone),
                yet_to_bat: bats.filter(function (b) { return b.pos > nextIn; }).map(function (b) { return b.name; }),
                at_crease: at,
                last_wicket: out.length ? clone(out[out.length - 1]) : null,
                fall: out.map(function (b, i) { return { order: i + 1, score: b.fow, who: b.name.split(' ').pop() }; }),
                bowling: bowls.filter(function (b) { return b.balls > 0; }).map(function (b) {
                    return { name: b.name, overs: fmtOvers(b.balls), maidens: b.maidens,
                             runs: b.runs, wickets: b.wickets, wides: b.wides, no_balls: b.no_balls,
                             econ: b.balls ? +(b.runs / (b.balls / 6)).toFixed(2) : null };
                }),
                allOut: wkts >= 10,
                chased: cfg.target != null && runs >= cfg.target
            });
        }

        var bowlerIdx = 0, lastBowler = -1;
        for (var over = 0; over < cfg.allot; over++) {
            /* Who bowls. The villain of a five-for beat gets the ball far more often
             * than a fair rotation would give him, because that is in fact how a
             * five-for happens — a captain who keeps a man on. Beats bias the dice
             * and the overs; they never write a figure straight into the card, so the
             * scorecard stays internally consistent either way. */
            // A bowler may bowl a fifth of the innings and no more, as the league's
            // own regulations have it. Without the cap the five-for beat handed one
            // man fifteen overs of a forty-over innings, which is not a scorecard
            // anybody would believe.
            var maxOvers = Math.ceil(cfg.allot / 5);
            var tries = 0;
            do {
                bowlerIdx = (villainIdx >= 0 && r() < 0.42) ? villainIdx
                          : Math.floor(r() * bowls.length);
                tries++;
            } while (tries < 24 && (bowlerIdx === lastBowler ||
                                    bowls[bowlerIdx].balls >= maxOvers * 6));
            lastBowler = bowlerIdx;
            var bw = bowls[bowlerIdx];
            var overRuns = 0, overLegal = 0;
            for (var ball = 0; ball < 6; ball++) {
                if (wkts >= 10) break;
                if (cfg.target != null && runs >= cfg.target) break;
                var b = bats[striker];
                // A wide costs a run and does not count as a ball, so it is settled
                // before the ball is counted rather than by un-counting it after.
                if (r() < pWide) {
                    extras.wd++; extras.total++; runs++; overRuns++;
                    bw.wides++; bw.runs++;
                    ball--;
                    continue;
                }
                // The hero refuses to get out until three figures.
                var isHero = striker === heroIdx && b.runs < 105;
                // The villain's multiplier has to carry a five-for inside the over cap
                // above (a fifth of the innings), which is why it is this steep.
                var wProb = isHero ? 0.004 : 0.036 * (villainIdx === bowlerIdx ? 4.2 : 0.8) / temper;
                var x = r();
                bw.balls++; b.balls++; balls++; overLegal++;
                if (x < wProb) {
                    var kind = OUT_KINDS[Math.floor(r() * OUT_KINDS.length)];
                    // The fielder credited is never the bowler — "st X b X" reads as
                    // a data bug, and the dismissal string is shown verbatim.
                    var fielder = pick(r, cfg.bowling);
                    for (var fx = 0; fx < 6 && fielder === bw.name; fx++) fielder = pick(r, cfg.bowling);
                    b.dismissal_id = kind.id;
                    b.out_kind = kind.kind;
                    b.fielder = (kind.kind === 'caught' || kind.kind === 'stumped' || kind.kind === 'run_out') ? fielder : null;
                    b.how = kind.how(fielder, bw.name);
                    b.fow = runs;
                    b.sr = b.balls ? +(b.runs / b.balls * 100).toFixed(1) : null;
                    wkts++;
                    if (kind.kind !== 'run_out') bw.wickets++;
                    fall.push(runs);
                    if (nextIn < 11) { striker = nextIn++; } else { striker = nonStriker; }
                    continue;
                }
                // Scoring shot, off the weights above.
                var s = r();
                var scored = s < pDot ? 0
                           : s < pDot + pOne ? 1
                           : s < pDot + pOne + pTwo ? 2
                           : s < pDot + pOne + pTwo + pThree ? 3
                           : s < pDot + pOne + pTwo + pThree + pFour ? 4 : 6;
                // A batter on his way to a hundred turns some of the dots over.
                if (isHero && scored === 0 && r() < 0.45) scored = 1;
                b.runs += scored; runs += scored; overRuns += scored; bw.runs += scored;
                if (scored === 4) b.fours++;
                if (scored === 6) b.sixes++;
                b.sr = b.balls ? +(b.runs / b.balls * 100).toFixed(1) : null;
                if (scored % 2 === 1) { var t = striker; striker = nonStriker; nonStriker = t; }
            }
            // A maiden is six legal balls for nothing — wides included in the runs,
            // which is why `overRuns` counts them.
            if (overLegal === 6 && overRuns === 0) bw.maidens++;
            // Ends of over: swap, snapshot.
            var tt = striker; striker = nonStriker; nonStriker = tt;
            if (bats[striker].dismissal_id !== 0) { var sw = striker; striker = nonStriker; nonStriker = sw; }
            snapshot(over + 1);
            if (wkts >= 10) break;
            if (cfg.target != null && runs >= cfg.target) break;
        }
        return { snaps: snaps, total: runs, wickets: wkts, balls: balls };
    }

    // A shower over one of our matches, so the rain-break event type is in every run
    // rather than only in seasons with weather. Play resumes: the break is a state
    // the surface has to handle, not an ending.
    function rainNow(cfg, ms) {
        var b = cfg.beats || {};
        return b.rainFrom != null && ms >= b.rainFrom && ms < b.rainFrom + (b.rainFor || mins(15));
    }

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    // Balls as a cricket overs string, and a completed over drops its ".0" — the same
    // canonical form rv.mjs emits, because consumers render it verbatim.
    function fmtOvers(balls) {
        var o = Math.floor(balls / 6), b = balls % 6;
        return b ? o + '.' + b : String(o);
    }

    // ---- a simulated fixture -----------------------------------------------
    // Pre-rolls both innings, then answers "what does the feed say at this time of day?".
    // Pre-rolling is what makes the day coherent: the target exists before the chase
    // starts, so the chase can be a real chase.
    function ourMatch(cfg) {
        var oppClub = cfg.opposition;
        var ourXI = squad(cfg.seed, true);
        var oppXI = squad(cfg.seed + 101, false);
        // Who bats first, and so which of the two innings carries the beats: they
        // belong to OUR side either way, which is the whole point of a beat.
        var us = { club: cfg.our_club, team: cfg.our_club + ' - ' + cfg.team_name,
                   is_home: !!cfg.is_home };
        var them = { club: oppClub, team: oppClub + ' - ' + (cfg.opposition_team || '1st XI'),
                     is_home: !cfg.is_home };
        var weFirst = !!cfg.weBatFirst;
        var sides = weFirst ? [us, them] : [them, us];
        sides[0].batted_first = true; sides[1].batted_first = false;
        var firstXI = weFirst ? ourXI : oppXI, secondXI = weFirst ? oppXI : ourXI;
        var first = playInnings({ seed: cfg.seed + 1, allot: cfg.allot, batting: firstXI,
                                  bowling: secondXI, target: null,
                                  beats: weFirst ? (cfg.beats || {}) : {} });
        var second = playInnings({ seed: cfg.seed + 2, allot: cfg.allot, batting: secondXI,
                                   bowling: firstXI, target: first.total + 1,
                                   beats: weFirst ? {} : (cfg.beats || {}) });
        var n1 = first.snaps.length, n2 = second.snaps.length;
        var doneAt = n1 + n2;
        var chased = second.total > first.total;
        var tied = second.total === first.total;
        var winner = tied ? null : (chased ? sides[1] : sides[0]);

        /* THE MOMENTS WORTH STOPPING AT — the bar's markers, and what `e` walks
         * through. Derivable because the day is pre-rolled: the cricket is known before
         * a ball of it is shown. Stated in day time, so rain has to be added back — an
         * over that happens after the covers come on happens that much later. */
        function whenElapsed(el) {
            var rb = cfg.beats || {};
            var rainEl = rb.rainFrom == null ? Infinity : rb.rainFrom - cfg.start;
            return cfg.start + el + (el > rainEl ? (rb.rainFor || 0) : 0);
        }
        function firstOverWhere(snaps, test) {
            for (var i = 0; i < snaps.length; i++) if (test(snaps[i])) return snaps[i].over;
            return null;
        }
        var label = cfg.team_name + ' v ' + cfg.opposition.replace(/ CC$/, '');
        var marks = [
            { at: cfg.start, kind: 'start', label: label + ' — toss' },
            { at: whenElapsed(n1 * OVER_MS), kind: 'break', label: label + ' — innings break' },
            { at: whenElapsed(doneAt * OVER_MS), kind: 'result', label: label + ' — decided' },
            { at: whenElapsed(doneAt * OVER_MS) + cfg.publishAfter, kind: 'final',
              label: label + ' — result confirmed' }
        ];
        if (cfg.beats && cfg.beats.rainFrom != null) {
            marks.push({ at: cfg.beats.rainFrom, kind: 'rain', label: label + ' — rain stops play' });
            marks.push({ at: cfg.beats.rainFrom + (cfg.beats.rainFor || 0), kind: 'rain',
                         label: label + ' — play resumes' });
        }
        // The beats are applied to ONE innings (ours with the bat), so that is the
        // innings the guaranteed milestones are found in, dated through the overs before it.
        var beatSnaps = (weFirst ? first : second).snaps, beatOffset = weFirst ? 0 : n1;
        var hunOver = firstOverWhere(beatSnaps, function (sn) {
            return sn.batters.some(function (bt) { return bt.runs >= 100; });
        });
        if (hunOver != null) marks.push({ at: whenElapsed((beatOffset + hunOver) * OVER_MS),
                                          kind: 'milestone', label: label + ' — a hundred' });
        var fiveOver = firstOverWhere(beatSnaps, function (sn) {
            return sn.bowling.some(function (bw) { return bw.wickets >= 5; });
        });
        if (fiveOver != null) marks.push({ at: whenElapsed((beatOffset + fiveOver) * OVER_MS),
                                           kind: 'milestone', label: label + ' — a five-for' });

        return {
            id: cfg.pc_id, ours: true, cfg: cfg, doneAt: doneAt, marks: marks,
            // Clips arrive on the streamed match only, and they arrive a poll LATE —
            // footage lags the scorecard in reality, and an extractor that assumed
            // otherwise would never join a clip to its wicket.
            card: function (ms) {
                var raw = ms - cfg.start;
                if (raw < 0) return null;                     // not started yet
                // Rain stops play, so the scorecard stops with it: the time spent under
                // the covers moves the clock and not the game. Without this the break
                // would be cosmetic and the feed would keep scoring through it.
                var b = cfg.beats || {};
                var lost = b.rainFrom == null ? 0
                    : Math.max(0, Math.min(ms - b.rainFrom, b.rainFor || mins(15)));
                // Play, as opposed to afternoon: overs come off this and nothing else.
                var elapsed = raw - lost;
                var t = Math.floor(elapsed / OVER_MS);        // completed overs
                var doneElapsed = doneAt * OVER_MS;
                var complete = elapsed >= doneElapsed;
                var final = elapsed >= doneElapsed + cfg.publishAfter;
                var inns = [];
                var i1 = first.snaps[Math.min(t, n1) - 1];
                if (t >= 1) inns.push(inningsOf(sides[0], i1, 1, true));
                if (t > n1) {
                    var i2 = second.snaps[Math.min(t - n1, n2) - 1];
                    if (i2) inns.push(inningsOf(sides[1], i2, 2, false));
                }
                var result = null, resultClub = null;
                if (complete) {
                    if (tied) { result = 'Match tied'; resultClub = 'Match tied'; }
                    else if (chased) {
                        var wl = 10 - second.wickets;
                        result = winner.club + ' won by ' + wl + (wl === 1 ? ' wicket' : ' wickets');
                        resultClub = result;
                    } else {
                        var rm = first.total - second.total;
                        result = winner.club + ' won by ' + rm + (rm === 1 ? ' run' : ' runs');
                        resultClub = result;
                    }
                }
                // Innings closure + at-crease clearing, as rv.mjs does it: the feed
                // never shows batters at the crease in an innings that has ended.
                inns.forEach(function (inn, i) {
                    inn.closed = i < inns.length - 1 || complete ||
                                 (inn.wickets >= 10) || inn.declared;
                    if (inn.closed) inn.at_crease = [];
                });
                return {
                    pc_id: cfg.pc_id,
                    phase: complete ? 'post' : 'live',
                    complete: complete, final: final,
                    result: result, result_club: resultClub,
                    home: cfg.is_home ? cfg.our_club : oppClub,
                    away: cfg.is_home ? oppClub : cfg.our_club,
                    teams: sides.map(function (s) {
                        return { club: s.club, name: s.team, is_home: s.is_home,
                                 batted_first: s.batted_first,
                                 outcome: !final ? null : (tied ? 'tied' : (s === winner ? 'won' : 'lost')) };
                    }),
                    score_text: null,
                    leader_text: complete && final ? result : null,
                    break_desc: rainNow(cfg, ms) ? 'Rain delay'
                              : (!complete && elapsed >= n1 * OVER_MS &&
                                 elapsed < n1 * OVER_MS + INNINGS_BREAK_MS ? 'Innings break' : null),
                    toss: { winner: sides[0].team, winner_club: oppClub, decision: 'bat',
                            is_wendover: false,
                            text: oppClub + ' won the toss and elected to bat' },
                    streamed: !!cfg.streamed, video_id: cfg.streamed ? 'sim-' + cfg.pc_id : null,
                    innings: inns,
                    clips: cfg.streamed ? clipsUpTo(inns, t, cfg.allot) : [],
                    /* The scorer's own cursor, which is what brackets an event's
                     * happened_at — so it is stamped in REAL time, not in the
                     * simulated clock. The two must share a time base with
                     * `received_at`, or every event would claim to have happened
                     * hours after we heard about it. The fiction is the PACE of the
                     * day, not when the client is living. A poll's worth behind now,
                     * because a scorer syncs after the ball, not during it. */
                    scores_updated: Math.floor((clockNow() - FAST_MS) / 1000),
                    // The simulated wall clock, for display only — nothing schedules
                    // off this, and no real feed carries it.
                    sim_clock: new Date(clockNow()).toISOString(),
                    live_scored: true, live_scoring_allowed: true, was_live_scored: true
                };
            }
        };
    }

    function inningsOf(side, snap, order, battedFirst) {
        if (!snap) snap = { runs: 0, wickets: 0, overs: '0', extras: { total: 0, nb: 0, wd: 0, b: 0, lb: 0 },
                            batters: [], yet_to_bat: [], at_crease: [], last_wicket: null, fall: [], bowling: [] };
        return {
            side: side.team, club: side.club, team_label: side.team, is_home: side.is_home,
            batted_first: battedFirst, innings_id: order, order: order, declared: false,
            runs: snap.runs, wickets: snap.wickets, overs: snap.overs,
            extras: snap.extras, batters: snap.batters, yet_to_bat: snap.yet_to_bat,
            at_crease: snap.at_crease, last_wicket: snap.last_wicket, fall: snap.fall,
            bowling: snap.bowling, closed: false
        };
    }

    /* Highlight clips, as frogbox delivers them: one per wicket and per six on the
     * streamed match, arriving a poll after the runs. The URL is a real CORS-open
     * test stream so the news-flash path can actually play something; swap it for a
     * dead URL to exercise the failure branch. */
    /* CLIP FOOTAGE comes from the club's own R2 store — the ball-event clips the
     * offline player already caches, which are real cricket and, crucially, the right
     * LENGTH. The stand-in before this was a public HLS test stream that ran for
     * minutes, so every news flash outstayed its welcome and nothing about the
     * takeover's pacing could be judged.
     *
     * The pool is read from a built `precache.json` (the offline player's clip
     * manifest — see build_precache): the deck's own first, then the wall deck, which
     * reliably has a full season's clips in it. No manifest and no clips → the test
     * stream, so the simulator still runs on a repo that has never synced videos.
     *
     * These are MP4, not HLS. `live-flash.html` plays a plain media file directly and
     * `hls-cache.js` skips pre-staging it; production clips are always Frogbox
     * `.m3u8`, so neither path changes on the wall. */
    var CLIP_FALLBACK = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
    var clipPool = [];

    function loadClipPool() {
        // The deck we are running inside, e.g. /slideshow/live/ -> live.
        var m = location.pathname.match(/\/slideshow\/([^\/]+)\//);
        var urls = ['/slideshow/' + (m ? m[1] : 'live') + '/precache.json',
                    '/slideshow/pavilion-auto/precache.json'];
        return urls.reduce(function (chain, u) {
            return chain.then(function () {
                if (clipPool.length) return;           // the first manifest with clips wins
                return fetch(u, { cache: 'no-store' })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (d) {
                        clipPool = ((d && d.videos) || []).filter(Boolean);
                    })
                    .catch(function () {});
            });
        }, Promise.resolve()).then(function () {
            console.log('[sim] clip pool:', clipPool.length
                ? clipPool.length + ' R2 clip(s)' : 'none found, using the HLS test stream');
        });
    }
    /* A clip URL for a given highlight, chosen from the pool by a hash of its id so a
     * run is repeatable and one incident keeps the same footage across polls (the feed
     * re-lists every clip every poll, and footage that changed under a stable id would
     * be a lie about the same event). */
    function clipUrl(id) {
        if (!clipPool.length) return CLIP_FALLBACK;
        var h = 0, s = String(id);
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return clipPool[h % clipPool.length];
    }
    /* The clip list is CUMULATIVE, as RV's is: every poll returns every highlight of
     * the match so far, not the new ones. That is what the store's dedupe-by-id is
     * for, and shipping a simulator that only ever offered new clips would leave that
     * path untested.
     *
     * Each clip is dated by the INCIDENT, not by the poll carrying it: a wicket that
     * fell at the fall-of-wicket score is placed at the over that score was reached,
     * converted back to the day's own time through OVER_MS. Without this, footage of a
     * wicket from twenty overs ago arrives stamped "just now" and the scheduler treats
     * an old replay as the day's latest news. */
    function clipsUpTo(inns, t, allot) {
        var out = [];
        inns.forEach(function (inn, ii) {
            var oversNow = ballsIn(inn.overs) / 6;
            (inn.batters || []).forEach(function (b) {
                // Which over a dismissal happened in, estimated from the team score
                // when the batter fell against the score now.
                var frac = inn.runs > 0 && b.fow != null ? Math.min(1, b.fow / inn.runs) : 1;
                var atOver = Math.max(0, Math.floor(frac * oversNow));
                var agoMs = Math.max(0, (oversNow - atOver)) * OVER_MS;
                if (b.dismissal_id && b.fow != null) {
                    var wid = 'c' + ii + 'w' + b.name.replace(/\W/g, '');
                    out.push({ id: wid, url: clipUrl(wid),
                               event: 'wicket', title: 'Wicket — ' + b.name,
                               over: atOver, ball: 1, happened_ms: clockNow() - agoMs,
                               batting_team: inn.side, innings_id: inn.innings_id,
                               batter: b.name, dismissed: b.name, bowler: null,
                               // A ball-event clip is a handful of seconds. The dwell is
                               // only an estimate either way — the flash reports its own
                               // `wcc-flash-done` when the footage actually ends.
                               duration: 8 });
                }
                for (var s = 0; s < (b.sixes || 0); s++) {
                    var sid = 'c' + ii + '6' + b.name.replace(/\W/g, '') + s;
                    out.push({ id: sid, url: clipUrl(sid),
                               event: 'six', title: b.name + ' six',
                               over: atOver, ball: 3, happened_ms: clockNow() - agoMs,
                               batting_team: inn.side, innings_id: inn.innings_id,
                               batter: b.name, bowler: null, duration: 8 });
                }
            });
        });
        return out;
    }
    function ballsIn(overs) {
        var p = String(overs || '0').split('.');
        return (parseInt(p[0], 10) || 0) * 6 + (p.length > 1 ? (parseInt(p[1], 10) || 0) : 0);
    }

    // A division match on the LEAN feed: innings totals and a result, nothing else.
    // Kept deliberately poor, because PC-API is deliberately poor — a chrome that
    // only looks right on the rich feed is a chrome that breaks on five of the six
    // matches it will show.
    function leagueMatch(cfg) {
        /* The two sides' team ids. Synthetic unless the day was adopted from the build,
         * because every consumer pairs an innings to a side by comparing
         * `team_batting_id` against the card's own `home_team_id`/`away_team_id` — so
         * self-consistency is what matters, and REAL ids additionally let a surface
         * match the card against a baked league table row. */
        var hid = cfg.home_team_id || String(cfg.match_id) + 'h';
        var aid = cfg.away_team_id || String(cfg.match_id) + 'a';
        var homeXI = squad(cfg.seed, true), awayXI = squad(cfg.seed + 7, false);
        var first = playInnings({ seed: cfg.seed + 1, allot: cfg.allot, batting: homeXI, bowling: awayXI, target: null, beats: {} });
        var second = playInnings({ seed: cfg.seed + 2, allot: cfg.allot, batting: awayXI, bowling: homeXI, target: first.total + 1, beats: {} });
        var n1 = first.snaps.length, n2 = second.snaps.length, doneAt = n1 + n2;
        var chased = second.total > first.total, tied = second.total === first.total;
        var beats = cfg.beats || {};
        var lbl = cfg.home.replace(/ CC$/, '') + ' v ' + cfg.away.replace(/ CC$/, '');
        var marks = [];
        // A silent match never says anything, so there is nothing to stop for.
        if (!cfg.silent) {
            marks.push({ at: cfg.start, kind: 'start', label: lbl + ' — under way' });
            if (beats.rainFrom != null && beats.abandon) {
                marks.push({ at: beats.rainFrom, kind: 'rain', label: lbl + ' — abandoned' });
            } else {
                marks.push({ at: cfg.start + doneAt * OVER_MS, kind: 'result', label: lbl + ' — result' });
            }
        }

        return {
            id: cfg.match_id, ours: false, cfg: cfg, doneAt: doneAt, marks: marks,
            card: function (ms) {
                var elapsed = ms - cfg.start;
                if (elapsed < 0) return null;
                if (cfg.silent) return null;                  // scored in the book
                var t = Math.floor(elapsed / OVER_MS);        // completed overs
                var rained = beats.rainFrom != null && ms >= beats.rainFrom;
                var abandoned = rained && beats.abandon;
                var complete = abandoned || elapsed >= doneAt * OVER_MS;
                var inns = [];
                var cap1 = rained
                    ? Math.min(Math.floor((beats.rainFrom - cfg.start) / OVER_MS), n1) : n1;
                var i1 = first.snaps[Math.min(t, cap1) - 1];
                if (t >= 1 && i1) inns.push({ side: cfg.home, team_batting_id: hid,
                                              runs: i1.runs, wickets: i1.wickets, overs: i1.overs, declared: false });
                if (!rained && t > n1) {
                    var i2 = second.snaps[Math.min(t - n1, n2) - 1];
                    if (i2) inns.push({ side: cfg.away, team_batting_id: aid,
                                        runs: i2.runs, wickets: i2.wickets, overs: i2.overs, declared: false });
                }
                var desc = null, applied = null;
                if (abandoned) desc = 'Abandoned';
                else if (complete) {
                    var w = tied ? null : (chased ? cfg.away : cfg.home);
                    desc = tied ? 'Tied' : w + ' - Won';
                    applied = tied ? null : (chased ? aid : hid);
                }
                var last = inns[inns.length - 1];
                return {
                    match_id: cfg.match_id, competition: cfg.competition,
                    home: cfg.home, away: cfg.away,
                    home_team_id: hid, away_team_id: aid,
                    result_applied_to: applied,
                    phase: complete ? 'post' : 'live', complete: complete,
                    result: desc, result_club: complete && applied ? (chased ? cfg.away : cfg.home) + ' won' : desc,
                    score_text: !complete && last
                        ? last.side + ' ' + last.runs + '/' + last.wickets + ' (' + last.overs + ' ov)' : null,
                    innings: inns
                };
            }
        };
    }

    // ---- the day's clock ----------------------------------------------------
    // ONE PIECE OF STATE: `simTime`, milliseconds since the day began. Everything the
    // feed says and everything the model judges is a function of it (see the header).
    // Built in `go`, not here: the day may still be re-labelled from the build's own
    // config (see adoptBakedDay), and pre-rolling the innings before that lands would
    // simulate the invented fixtures and then throw them away.
    var ours = [], others = [];
    var simTime = 0;
    var polls = 0, leaguePolls = 0;
    // The two feeds run on genuinely separate timers, as they do in production.
    var nextPollAt = 0, nextLeagueAt = 0;
    // How fast the day runs when it is running, as a multiple of real time. x60 is one
    // poll a tick, which is the cadence that reads as an afternoon going by.
    var RATES = [15, 60, 240];
    var rateIdx = 1;
    var TICK_MS = 250;                     // real ms between autoplay ticks
    var playing = false;
    var autoTimer = null;
    /* WHERE THE DAY SITS ON THE WALL. `happened_at`, `received_at` and the scorer's own
     * cursor have to share one time base, so the fiction is parked on TODAY's date at
     * DAY_START_MIN rather than on a fixture's real one: anything that compares the held
     * clock against the real one then sees an afternoon, not a date months out. */
    var dayEpoch = (function () {
        var d = new Date(); d.setHours(0, 0, 0, 0);
        return d.getTime() + DAY_START_MIN * 60000;
    })();
    /* The clock every time-dependent judgement reads (live-clock.js). It is MANUAL for
     * the whole run, so this is the sim clock itself rather than a frozen copy of the
     * real one — which is what makes pausing mean one thing. */
    function clockNow() { return window.WccClock ? WccClock.now() : dayEpoch + simTime; }
    /* Parked QUIETLY. A poll moves time and data together, and anyone looking in between
     * would see a clock that had moved against data that had not — a state that is real
     * to nobody, and a scheduler deciding there decides against a store missing the very
     * poll it is looking at. `clockAnnounce` is the end of the move, and repaints
     * whatever is showing the consequences. */
    function clockPark(ms) {
        if (window.WccClock) WccClock.advance((dayEpoch + ms) - WccClock.now(), true);
    }
    function clockAnnounce() { if (window.WccClock) WccClock.advance(0, false); }

    function liveFeed() {
        return {
            generated_at: Math.floor(clockNow() / 1000), ttl: 30,
            matches: ours.map(function (f) {
                var c = f.card(simTime);
                return c || { pc_id: f.id, phase: 'pre', complete: false, final: false,
                              home: f.cfg.is_home ? f.cfg.our_club : f.cfg.opposition,
                              away: f.cfg.is_home ? f.cfg.opposition : f.cfg.our_club,
                              innings: [], clips: [], teams: [] };
            })
        };
    }
    function leagueFeed() {
        return {
            generated_at: Math.floor(clockNow() / 1000), ttl: 300,
            matches: others.map(function (f) {
                var c = f.card(simTime);
                // A match the feed knows of but has nothing to say about — the state
                // that catches out any surface assuming innings exist.
                return c || { match_id: f.id, phase: f.cfg.silent ? 'no-feed' : 'pre',
                              competition: f.cfg.competition, home: f.cfg.home, away: f.cfg.away,
                              complete: false, innings: [] };
            })
        };
    }

    // The transport the engine polls instead of the Worker. Synchronous data behind a
    // promise, because that is the shape the engine expects and a simulator that
    // resolved differently would hide ordering bugs.
    function transport(kind) {
        return Promise.resolve(kind === 'league' ? leagueFeed() : liveFeed());
    }

    /* Ladder moves, announced rather than derived — the strip owns the league table
     * and the points maths, so in production it is the strip that will call
     * `addLadderMove` when a move commits (see live-events.js). Until that wiring
     * exists the simulator stands in for it, which is enough to design the
     * scheduling against: what matters here is that a ladder move competes with a
     * wicket for the screen, not where the number came from. */
    var LADDER_MOVES = [
        { at: at('16:20'), club: 'Wendover CC', ours: true, places: 2, to: 4,
          division: 'TVCL Div 6C', reason: 'Amersham chase falling away' },
        { at: at('17:05'), club: 'Chesham CC', places: -1, to: 6,
          division: 'TVCL Div 6C', reason: 'Tring Park result posted' }
    ];

    // Match identity for the extractor and the chrome's labels (team name, division),
    // keyed the way both feeds key their cards. Built with the fixtures, for the same
    // reason.
    var cfgById = {};
    // Every moment in the day worth stopping at, sorted: the bar's markers, and what
    // `e` walks through. Each fixture states its own (see `marks`).
    var timeline = [];
    function buildDay() {
        ours = DAY.ours.map(ourMatch);
        others = DAY.league.map(leagueMatch);
        cfgById = {};
        DAY.ours.forEach(function (m) { cfgById[String(m.pc_id)] = m; });
        DAY.league.forEach(function (m) { cfgById[String(m.match_id)] = m; });
        timeline = [];
        ours.concat(others).forEach(function (f) {
            (f.marks || []).forEach(function (mk) { timeline.push(mk); });
        });
        LADDER_MOVES.forEach(function (mv) {
            timeline.push({ at: mv.at, kind: 'ladder',
                            label: mv.club.replace(/ CC$/, '') + ' ' +
                                   (mv.places > 0 ? 'up' : 'down') + ' to ' + mv.to });
        });
        timeline = timeline.filter(function (mk) { return mk.at >= 0 && mk.at <= DAY_MS; })
                           .sort(function (a, b) { return a.at - b.at; });
    }

    var handle = null;
    /* ONE POLL OF EITHER FEED. The clock is already parked at the instant it speaks, so
     * an event's `received_at` is when the feed actually said it. Each returns the
     * engine's own promise, because the caller has to WAIT for it — see `runTo`. */
    function deliverOurs() {
        polls++;
        return handle ? Promise.resolve(handle.poll()) : Promise.resolve();
    }
    function deliverLeague() {
        leaguePolls++;
        return handle ? Promise.resolve(handle.pollLeague()) : Promise.resolve();
    }
    // Guarded: the asset cache can serve this page an older engine that has no such
    // seam, and a missing ladder move is not worth a broken clock.
    function deliverLadder() {
        if (!handle || !handle.addLadderMove) return;
        LADDER_MOVES.forEach(function (mv) {
            if (!mv.fired && simTime >= mv.at) { mv.fired = true; handle.addLadderMove(mv); }
        });
    }
    /* HOW OFTEN OUR OWN FEED IS POLLED RIGHT NOW: the engine's own question
     * (`intervalFor`), asked of the same feed. Fast only while something is genuinely in
     * play — a flat fifteen seconds would poll the empty ends of the afternoon, before
     * the first ball and after the last result, twice as fast as the wall ever does, and
     * the cadence change would never be exercised at all. */
    function ourGap() {
        var ms = liveFeed().matches;
        if (!ms.length) return IDLE_MS;
        var inPlay = ms.some(function (m) {
            return (m.phase === 'live' || m.phase === 'break') && !m.complete;
        });
        return inPlay ? FAST_MS : SLOW_MS;
    }
    /* MOVING THE DAY ON, which is now the only control there is. Every poll due between
     * here and there is delivered, in order, with the clock parked at each one: the diff
     * chain is what makes the store mean anything, so a skip cannot simply land on the
     * far side of an hour of cricket.
     *
     * A LONG skip is delivered coarsely and with the clip flash disarmed, so it does not
     * fire fifty video takeovers on its way past. */
    var moving = false;
    function advance(ms) {
        ms = Math.round(ms);
        // A move still draining is not interrupted: two of them interleaved would
        // deliver one match's polls out of order, and the diff chain is the store.
        if (ms <= 0 || moving) return Promise.resolve();
        // A long skip is history: our feed is delivered on a coarser spacing, while the
        // division keeps its true five minutes, which is coarser still.
        var coarse = ms > mins(30);
        if (ms > mins(10)) disarmFlash();
        var target = simTime + ms;
        moving = true;
        return runTo(target, coarse).then(function () {
            simTime = target;
            clockPark(simTime);
            // Back to the watching cadence, whatever the skip was delivered at.
            nextPollAt = Math.min(nextPollAt, simTime + ourGap());
            moving = false;
            clockAnnounce();      // where the scheduler re-decides
            // The day has an end; playing past it is an empty screen for ever.
            if (playing && simTime >= DAY_MS) setPlaying(false);
            hud();
        });
    }
    /* ONE POLL AT A TIME, AND WAITED FOR. The engine ingests inside its own poll's
     * promise chain, so a run delivered synchronously would have every poll in it
     * ingested after the clock had already reached the far end — and `received_at` is
     * what freshness is clamped against (15 minutes, in live-events.js), so a four-hour
     * skip would land as four hours of cricket that all looked a quarter of an hour old
     * and all competed for the screen at once. Waiting is what keeps each poll stamped
     * with the instant it spoke, and what makes `&at=` leave behind a store that
     * honestly holds the afternoon so far.
     *
     * Chained rather than looped, so a day's worth of polls is a queue of microtasks and
     * not a thousand frames of stack. */
    function runTo(target, coarse) {
        var due = Math.min(nextPollAt, nextLeagueAt);
        if (due > target) return Promise.resolve();
        simTime = due;
        clockPark(simTime);
        deliverLadder();
        // Both, if both fall due on the same instant — which is a real arrival pattern
        // and the one worth having in a simulation of two feeds.
        var work = [];
        if (nextLeagueAt <= due) { nextLeagueAt = due + LEAGUE_MS; work.push(deliverLeague()); }
        if (nextPollAt <= due) {
            nextPollAt = due + (coarse ? SEEK_POLL_MS : ourGap());
            work.push(deliverOurs());
        }
        return Promise.all(work).then(function () { return runTo(target, coarse); });
    }
    /* DISARMING THE CLIP FLASH for the length of a skip. `detectClips` reads
     * `WccPlayer.flash` fresh every poll (live-engine.js), so borrowing it is enough —
     * nothing in the shipping engine has to know that a skip is happening.
     *
     * It is given back A TURN LATER rather than when the loop ends, because the engine
     * detects clips inside its own poll's promise chain: that settles after the
     * synchronous skip has returned, so a flash restored at the end of the loop is a
     * flash restored in time to fire for every poll the skip just delivered. A macrotask
     * is late enough, the sim's transport resolving as immediately as it does. */
    var stashedFlash = null, flashToken = 0;
    function disarmFlash() {
        var p = window.WccPlayer;
        if (!p) return;
        if (!stashedFlash && p.flash) { stashedFlash = p.flash; p.flash = null; }
        var mine = ++flashToken;
        setTimeout(function () {
            if (mine !== flashToken) return;        // a later skip owns it now
            if (stashedFlash) { p.flash = stashedFlash; stashedFlash = null; }
        }, 0);
    }

    /* ---- pausing ------------------------------------------------------------------
     * PAUSED MEANS PAUSED: the deck too, and the surfaces' own rotations with it (they
     * stop on the engine's `wcc-clock` broadcast — see live-ticker.html /
     * live-strip.html). A pause that only stopped the scheduler would be a lie about most
     * of what is moving.
     *
     * Which is why the clock is told as well. It is MANUAL for the whole run now, so
     * "manual" no longer distinguishes a held day from a running one; `WccClock.running`
     * is what the surfaces are really listening for (see live-clock.js).
     *
     * The deck's play state is REMEMBERED rather than assumed: resuming must not start a
     * deck that was already paused when you paused the day. */
    var deckWasPlaying = null;
    function deckApi() {
        return window.WccPlayer && window.WccPlayer.setPlaying ? window.WccPlayer : null;
    }
    /* Pausing the deck WHENEVER THE PLAYER GETS ROUND TO EXISTING. The simulator is
     * injected as a script and arms itself as soon as it parses, which can be before
     * player-core's `start()` has run and put `setPlaying` on WccPlayer — and that is the
     * common case, because the day starts paused. Retrying briefly is what makes "starts
     * paused" hold the deck as well as the clock, rather than silently missing it and
     * leaving the deck running under a stopped screen.
     *
     * Abandoned the moment the day is playing again, so a retry can never pause a deck
     * the user has just been handed back. */
    function holdDeck(tries) {
        if (playing) return;
        var deck = deckApi();
        if (deck) {
            if (deckWasPlaying === null) deckWasPlaying = deck.isPlaying();
            deck.setPlaying(false);
            return;
        }
        if ((tries || 0) < 25) setTimeout(function () { holdDeck((tries || 0) + 1); }, 100);
    }
    /* TO THE NEXT CHANGE ON SCREEN, AT FULL SPEED — the moment the scheduler changes its
     * mind about what to SHOW.
     *
     * A different question from `e`, which goes to the next thing that HAPPENS, and the
     * one to watch the chrome against: the two come apart constantly. A wicket that
     * arrives mid-dwell waits its turn. A dwell expiring with nothing new promotes
     * something that happened ten minutes ago. A superseded pick loses the screen with no
     * new event at all. None of it can be worked out in advance — it depends on the
     * store's state at the instant it is asked — so the day is run until it happens.
     *
     * RUN, not played: a poll at a time still, because the store is built out of the
     * differences between them, but as fast as the promises resolve rather than at the
     * day's watching rate. Crawling there at x60 is the thing this key exists to avoid.
     * Capped, so a quiet stretch cannot run the tab to the end of the day in silence. */
    var seeking = false;
    var SEEK_GIVE_UP_MS = 3600000;              // an hour of the day with nothing changing
    function showingId() {
        var st = handle && handle.events;
        var cur = st && st.current ? st.current() : null;
        return cur ? cur.id : null;
    }
    function showingNow() {
        var st = handle && handle.events;
        var cur = st && st.current ? st.current() : null;
        if (!cur) return null;
        return cur.label + (cur.payload && cur.payload.headline ? ' · ' + cur.payload.headline : '');
    }
    function toNextShowing() {
        if (moving || seeking) return;
        setPlaying(false);                      // this is a step, not a play state
        var from = showingId();
        var limit = simTime + SEEK_GIVE_UP_MS;
        seeking = true;
        hud();
        (function step() {
            if (!seeking) return;               // any other key cancels it
            if (showingId() !== from) return stop(null);
            if (simTime >= DAY_MS) return stop('the day ran out');
            if (simTime >= limit) return stop('nothing changed on screen in an hour');
            var was = simTime;
            advance(ourGap()).then(function () {
                // Defensive: a clock that did not move would spin here for ever.
                if (simTime === was) return stop('the clock did not move');
                step();
            });
        })();
        function stop(why) {
            seeking = false;
            if (why) console.log('[sim] ' + why + ' — still showing ' + (showingNow() || 'nothing'));
            hud();
        }
    }
    function setPlaying(on) {
        playing = !!on;
        seeking = false;
        if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
        /* The clock is manual all run, so "manual" cannot be what tells the surfaces to
         * stop: they are told the day has stopped, which is this. */
        if (window.WccClock && WccClock.running) WccClock.running(playing);
        if (playing) {
            var deck = deckApi();
            if (deck && deckWasPlaying) deck.setPlaying(true);
            deckWasPlaying = null;
            autoTimer = setInterval(function () { advance(TICK_MS * RATES[rateIdx]); }, TICK_MS);
        } else {
            holdDeck(0);
        }
        hud();
    }

    // ---- getting somewhere --------------------------------------------------------
    // The next over boundary anywhere in play: the next moment a score can change. Rain
    // pushes it back as the covers stay on, hence the fallback.
    function nextOverAt() {
        var best = null;
        ours.concat(others).forEach(function (f) {
            var c = f.card(simTime);
            if (!c || c.complete) return;
            var b = f.cfg.beats || {};
            var lost = b.rainFrom == null ? 0
                : Math.max(0, Math.min(simTime - b.rainFrom, b.rainFor || 0));
            var el = simTime - f.cfg.start - lost;
            var when = f.cfg.start + lost + (Math.floor(el / OVER_MS) + 1) * OVER_MS;
            if (when > simTime && (best === null || when < best)) best = when;
        });
        return best === null ? simTime + OVER_MS : best;
    }
    function nextIncident() {
        for (var i = 0; i < timeline.length; i++) {
            if (timeline[i].at > simTime + 1) return timeline[i];
        }
        return null;
    }
    /* BACK. The engine holds the previous poll to diff against and the store only ever
     * accumulates, so the only honest rewind is to run the day again and stop earlier —
     * and a reload does exactly that for nothing, rebuilding both from scratch. The cost
     * is a reload (the deck restarts); the gain is that there is no rewind path in here
     * pretending the model can be run backwards. */
    function back(ms) {
        var to = Math.max(0, simTime - ms);
        var q = location.search.replace(/(^\?|&)at=[^&]*/g, '').replace(/^&/, '?');
        if (!q) q = '?';
        var tail = q.charAt(q.length - 1);
        if (tail !== '?' && tail !== '&') q += '&';
        location.replace(location.pathname + q + 'at=' + encodeURIComponent(hhmm(to)) + location.hash);
    }

    // ---- the HUD ------------------------------------------------------------
    // The one control surface: where the day has got to, what is coming next, and the
    // afternoon as a bar you can click along. Everything else on screen is a simulation
    // of something real; this is the only part that is a set of controls.
    // The event stream itself is inspected on the live-events slide, which is a normal
    // slide rendering a normal broadcast.
    var box = null, txt = null, bar = null, head = null;
    var MARK_COLOURS = { start: '#7fa8d9', break: '#8f8f8f', rain: '#4fb3d9',
                         milestone: '#d4af37', result: '#5fbf7f', final: '#ffffff',
                         ladder: '#c98fd9' };
    function buildHud() {
        box = document.createElement('div');
        box.id = 'sim-hud';
        /* ONLY THE BAR TAKES CLICKS. The HUD sits over the top-left corner of the deck,
         * so a box that swallowed pointer events would eat taps meant for the slide
         * underneath — which is why the whole thing used to be `pointer-events:none`. */
        box.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;padding:6px 10px 8px;' +
            'width:520px;font:11px/1.5 ui-monospace,Menlo,monospace;color:#fff;' +
            'background:rgba(8,21,44,0.88);border-right:1px solid #d4af37;' +
            'border-bottom:1px solid #d4af37;pointer-events:none;text-align:left';
        txt = document.createElement('div');
        txt.style.cssText = 'white-space:pre';
        bar = document.createElement('div');
        bar.style.cssText = 'position:relative;height:12px;margin:6px 0 0;' +
            'background:rgba(255,255,255,0.12);border:1px solid rgba(212,175,55,0.45);' +
            'pointer-events:auto;cursor:pointer';
        bar.title = 'click to skip ahead — behind the playhead restarts the day there';
        // Forward is a skip; backward is a reload, for the reason `back` gives.
        bar.addEventListener('click', function (e) {
            var r = bar.getBoundingClientRect();
            var to = Math.max(0, Math.min(DAY_MS, (e.clientX - r.left) / r.width * DAY_MS));
            if (to > simTime) advance(to - simTime); else back(simTime - to);
        });
        timeline.forEach(function (mk) {
            var tick = document.createElement('div');
            tick.title = hhmm(mk.at) + '  ' + mk.label;
            tick.style.cssText = 'position:absolute;top:0;bottom:0;width:2px;pointer-events:none;' +
                'left:' + (mk.at / DAY_MS * 100).toFixed(2) + '%;' +
                'background:' + (MARK_COLOURS[mk.kind] || '#fff');
            bar.appendChild(tick);
        });
        head = document.createElement('div');
        head.style.cssText = 'position:absolute;top:-3px;width:2px;height:18px;' +
            'background:#d4af37;box-shadow:0 0 4px #d4af37';
        bar.appendChild(head);
        box.appendChild(txt);
        box.appendChild(bar);
        document.body.appendChild(box);
    }
    function hud() {
        if (!box) buildHud();
        var inPlay = ours.concat(others).filter(function (f) {
            var c = f.card(simTime); return c && !c.complete;
        }).length;
        var nx = nextIncident();
        txt.textContent =
            'SIM ' + hhmm(simTime) + '   ' +
                (playing ? '▶ ×' + RATES[rateIdx] : seeking ? '⏩ seeking' : '❚❚ paused') +
            '   poll ' + polls + ' ours / ' + leaguePolls + ' league   ' + inPlay + ' in play' +
            '\nchrome: ' + (showingNow() || '— nothing above the floor') +
            '\nnext:   ' + (nx ? hhmm(nx.at) + '  ' + nx.label : '— nothing left today') +
            '\nk play/pause · c to the next change on screen · [ ] speed · . a poll (' +
                (ourGap() / 1000) + 's)' +
            '\n> +5m · o next over · e next incident · b back 1m · r restart · h hide';
        head.style.left = (Math.max(0, Math.min(1, simTime / DAY_MS)) * 100).toFixed(2) + '%';
    }

    /* KEYS THE PLAYER DOES NOT ALREADY OWN. player-core.js binds its transport on the
     * same document — Space, ←, →, Home, End, PageDown, Escape and f/F (fullscreen) —
     * and both listeners fire, so anything shared here makes one press do two unrelated
     * things. So the simulator keeps to letters and punctuation of its own, and the
     * deck's transport is left alone: Space still plays/pauses the deck, → still moves it
     * on. Check this list against player-core's keydown handler before adding to it.
     *
     * There is one axis now, so there is one set of keys: every one of them moves the
     * day's clock, and data arrives when a poll falls due on the way. */
    document.addEventListener('keydown', function (e) {
        var k = e.key;
        if (e.metaKey || e.ctrlKey || e.altKey) return;   // never shadow a browser shortcut
        if (k === 'k') { e.preventDefault(); setPlaying(!playing); }
        else if (k === ']') { rateIdx = Math.min(RATES.length - 1, rateIdx + 1); if (playing) setPlaying(true); else hud(); }
        else if (k === '[') { rateIdx = Math.max(0, rateIdx - 1); if (playing) setPlaying(true); else hud(); }
        // One poll on, at whatever cadence our feed is being polled at just now. `n` was
        // the old key for it and costs nothing to keep.
        else if (k === '.' || k === 'n') { e.preventDefault(); setPlaying(false); advance(ourGap()); }
        else if (k === '>') { e.preventDefault(); setPlaying(false); advance(mins(5)); }
        else if (k === 'o') { e.preventDefault(); setPlaying(false); advance(nextOverAt() - simTime); }
        else if (k === 'e') {
            e.preventDefault(); setPlaying(false);
            // Land just past it, so the poll that carries the incident has arrived.
            var nx = nextIncident();
            if (nx) advance(nx.at - simTime + 1);
        }
        else if (k === 'c') { e.preventDefault(); toNextShowing(); }
        /* `b`, and NOT `,`: the comma is already prev-slide on the hardware this is driven
         * from (not in player-core.js — it arrives from outside the page), so the two fought
         * exactly as `f` and Space once did on the keys player-core does own. */
        else if (k === 'b') { e.preventDefault(); back(mins(1)); }
        else if (k === 'r') location.reload();
        else if (k === 'h' && box) box.hidden = !box.hidden;
    });

    /* ---- adopting the real day, when the build has one -----------------------
     * The invented DAY above is what makes this work in December, but its pc_ids are
     * fiction — and the `live-match-{team}` slides are each BOUND to a real pc_id
     * baked at build time. So a simulator that only ever invented ids could drive the
     * chrome and the inspector but never the biggest live surface there is.
     *
     * So: if the build baked a day (WCC_TODAY set to a fixture date, or an actual
     * match day), borrow its matches' identities — ids, team names, opposition,
     * division, home/away — and simulate THOSE. The cricket is still ours; only the
     * labels and the ids become real, which is exactly what the slides bind on.
     *
     *     WCC_TODAY=2026-08-08 WCC_LIVE_ENABLED=1 python3 scripts/build.py
     *     open 'http://localhost:8000/slideshow/live/?sim=matchday'
     *
     * Nothing baked → the invented day stands, and the live-match slides simply have
     * nothing to show, as they would on a day with no cricket. */
    function adoptBakedDay() {
        return fetch('/live-config.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (cfg) {
                var ms = ((cfg && cfg.matches) || []).filter(function (m) { return m.pc_id != null; });
                if (!ms.length) return;
                // Keep the simulation's own shape (the beats, the stagger, the
                // streamed one) and re-label it, rather than inventing a fresh
                // fixture per baked match: the beats are what guarantee coverage.
                var templates = DAY.ours.slice();
                DAY.ours = ms.slice(0, Math.max(templates.length, ms.length)).map(function (m, i) {
                    var base = templates[i % templates.length];
                    return Object.assign({}, base, {
                        pc_id: m.pc_id,
                        team_name: m.team_name || base.team_name,
                        competition_short: m.competition_short || m.competition || base.competition_short,
                        our_club: m.our_club || base.our_club,
                        opposition: m.opposition || base.opposition,
                        opposition_team: m.opposition_team || null,
                        is_home: m.is_home == null ? base.is_home : !!m.is_home,
                        // Stagger anything past the template list, so a day with five
                        // teams out does not start five matches on the same ball.
                        start: i < templates.length ? base.start : at('13:00') + mins(12 * i),
                        seed: base.seed + i * 13
                    });
                });
                console.log('[sim] adopted', DAY.ours.length, 'baked match(es):',
                            DAY.ours.map(function (m) { return m.team_name + ' #' + m.pc_id; }).join(', '));
            })
            .catch(function () { /* no config served — the invented day stands */ });
    }

    /* ---- and the division's own identities ------------------------------------
     * From `/live-league.json`, which is the very list the engine polls for itself in
     * production (`leagueConfigUrl`, built by build_league_config from
     * scripts/fetch_league_fixtures.py).
     *
     * This matters more than it looks: BOTH surfaces that show other clubs' matches pair
     * a league card to a BAKED FIXTURE BY MATCH ID — the strip's ladder tiles through
     * `cardFor` (`leagueById[fx.match_id]`) and the today board through
     * `LEAGUE_SCORES[o.match_id]`. Invented ids therefore light up nothing at all: the
     * cards arrive, match no row, and are silently dropped. Exactly the problem the
     * live-match slides' baked pc_ids have, and the same answer.
     *
     * Nothing baked → the invented division stands, which is still worth having: the
     * event stream, the inspector and the ticker key off the feed alone. */
    function adoptBakedLeague() {
        return fetch('/live-league.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (cfg) {
                var ms = ((cfg && cfg.matches) || []).filter(function (m) { return m.match_id != null; });
                if (!ms.length) return;
                // Keep the simulation's own shape — the abandonment, the silent one, the
                // staggering — and re-label it, as adoptBakedDay does for ours. Cycling
                // the templates is what keeps that coverage on a longer fixture list.
                var templates = DAY.league.slice();
                DAY.league = ms.map(function (m, i) {
                    var base = templates[i % templates.length];
                    return Object.assign({}, base, {
                        match_id: m.match_id,
                        home: m.home_club_name || base.home,
                        away: m.away_club_name || base.away,
                        competition: m.competition_name || base.competition,
                        home_team_id: m.home_team_id || null,
                        away_team_id: m.away_team_id || null,
                        // The fixture's real start time when it has one, so the board's
                        // times and the day's shape agree with each other.
                        start: startAtTime(m.match_time, base.start),
                        seed: base.seed + i * 11
                    });
                });
                console.log('[sim] adopted', DAY.league.length, 'baked league match(es):',
                            DAY.league.map(function (m) {
                                return m.home + ' v ' + m.away + ' #' + m.match_id;
                            }).join(', '));
            })
            .catch(function () { /* no config served — the invented division stands */ });
    }
    // "13:00" / "13:00:00" as an offset into the day; anything else keeps the template's.
    function startAtTime(t, fallback) {
        var m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
        if (!m) return fallback;
        var ms = at(m[1] + ':' + m[2]);
        return ms >= 0 && ms < DAY_MS ? ms : fallback;
    }

    // ---- go -----------------------------------------------------------------
    // The engine is started HERE rather than by the player, because the player's own
    // start is gated on an access key this has no need of. Manual: the engine never
    // schedules its own next poll, so the axis above is the only thing that moves.
    function go() {
        if (!window.WccLive) { console.warn('[sim] live-engine.js not loaded — is live_enabled off?'); return; }
        if (!window.WccLiveEvents) console.warn('[sim] live-events.js not loaded — no event stream');
        buildDay();
        /* THE SIM CLOCK IS THE CLOCK, for the whole run and from before the first poll:
         * everything the feed stamps and everything the model judges has to come off one
         * time base, and a first poll delivered against the real clock would stamp the
         * day's opening events hours from the rest of it. */
        if (window.WccClock) { WccClock.manual(true); clockPark(0); }
        else console.warn('[sim] live-clock.js not loaded — the day cannot hold its own time');
        handle = window.WccLive.start({
            frames: function () { return Array.prototype.slice.call(document.querySelectorAll('iframe')); },
            transport: transport, manual: true,
            cfgById: cfgById,
            matches: DAY.ours.map(function (m) { return m.pc_id; }),
            leagueMatches: DAY.league.map(function (m) { return m.match_id; }),
            // Read LAZILY: the player assigns window.onLiveState inside its own
            // start(), which may not have run when the simulator arms itself.
            onState: function (feed, status) {
                if (window.onLiveState) window.onLiveState(feed, status);
            }
        });
        // `WccLive.start` polls both feeds once, so there is a toss on screen on arrival.
        polls = 1; leaguePolls = 1;
        nextPollAt = ourGap();
        nextLeagueAt = LEAGUE_MS;
        console.log('[sim] match day armed —', DAY.ours.length, 'of ours,', DAY.league.length, 'in the division');
        /* SOMEWHERE TO START, for a surface that is only interesting at tea time — and
         * the mechanism `back` reloads through. The day is run up to that point for real,
         * so the store holds the afternoon so far rather than starting empty in the
         * middle of it. */
        var park = (location.search.match(/[?&]at=([^&]+)/) || [])[1];
        if (park) {
            var to = at(decodeURIComponent(park));
            if (to > 0) {
                console.log('[sim] running the day up to', hhmm(to));
                advance(to);
            }
        }
        /* PAUSED ON ARRIVAL, because that is the state you want to be in when you get
         * here: the first poll has landed, there is a toss to look at, and nothing moves
         * again until you ask it to. A day that began by running meant every arrival
         * started with a scramble to stop it. `&play` starts it running instead, which is
         * the right thing for simply watching an afternoon go by. */
        setPlaying(/(^|[?&])play($|[=&])/.test(location.search));
        hud();
    }
    // Adopt the build's day (if it baked one) before anything is pre-rolled.
    function boot() { Promise.all([adoptBakedDay(), adoptBakedLeague(), loadClipPool()]).then(go); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();

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
 * It arrives with TIME HELD and one poll on screen, so nothing moves until you ask it
 * to. Add `&play` to start it running instead.
 * Needs no build inputs and no access key — it invents the day (see DAY below), so
 * it works in December on a repo with an empty live-config.json.
 *
 * TWO THINGS ARE YOURS, and they are separate on purpose — data arriving and time
 * passing are different questions, and every judgement the model makes (freshness,
 * repeat windows, dwell) is a function of the second:
 *
 *   data:  n               one poll forward, carrying the time it took (+15s)
 *          N               one poll at the SAME instant as the last (no time passes)
 *          a               autoplay on/off (starts on)
 *          [ / ]           slower / faster
 *   time:  k               hold / release the clock (holds the whole screen; held at boot)
 *          . / >           push a held clock on 30s / 5m, with no new data
 *          ,               pull it back 30s, to re-watch a decision
 *   r  restart the day     h  hide/show the HUD
 *
 * These deliberately avoid every key player-core.js binds (Space, arrows, Home, End,
 * PageDown, Escape, f/F): both keydown listeners are on the same document, so a shared
 * key would make one press do two unrelated things. Space and → still drive the deck.
 *
 * Holding the clock is what makes the relevance algorithm legible: a ranking sits
 * still long enough to read, a dwell stops expiring under you, and you can skip the
 * ten minutes it takes an event to age out instead of waiting for them.
 * One poll = one over for every match in play, so a full round of the division runs
 * in a few minutes. Matches start at staggered polls and finish at different times,
 * so one run passes through every phase: a toss, first innings, a target set, a
 * chase turning, milestones, a five-for, clips arriving, a rain break, an
 * abandonment, a decided-but-unconfirmed result, and a confirmed one.
 */
(function () {
    if (!/(^|[?&])sim=matchday($|[&])/.test(location.search)) return;

    // ---- the day ------------------------------------------------------------
    // Invented rather than read from the build, so the simulator has no
    // prerequisites. Deliberately the awkward shape of a real Saturday: two of our
    // sides in different divisions, one of them streamed, plus the rest of one
    // division playing each other.
    var DAY = {
        ours: [
            { pc_id: 7400001, team_name: '1st XI', competition_short: 'TVCL Div 4A',
              our_club: 'Wendover CC', opposition: 'Chalfont St Peter CC', is_home: true,
              streamed: true, allot: 45, start: 0, publishAfter: 10, seed: 17,
              // A shower midway through, then play resumes; and the result sits
              // unconfirmed for ten polls, which is the window the chrome has to
              // hedge with "to be confirmed".
              beats: { clips: true, rainAt: 30, rainFor: 4 } },
            // WE BAT FIRST here, which is not decoration: it puts our innings at
            // innings[0] and the opposition's chase at innings[1], the mirror of the
            // match above. Every consumer that binds a side by position rather than
            // by identity breaks on one of the two, so one run covers both.
            // A hundred needs an innings with enough runs in it to hold one, which a
            // 200-run chase does not — hence the beat lives on this side of the card.
            { pc_id: 7400002, team_name: '2nd XI', competition_short: 'TVCL Div 6C',
              our_club: 'Wendover CC', opposition: 'Amersham CC', is_home: false,
              weBatFirst: true,
              streamed: false, allot: 40, start: 4, publishAfter: 3, seed: 29,
              // A hundred and a five-for guaranteed, so the rare events are in
              // every run rather than in one run out of ten.
              beats: { hundred: true, fiveFor: true } }
        ],
        // The rest of the 2nd XI's division, on the lean PC feed. One is rained off
        // and abandoned; one finishes early and posts its result; one never says
        // anything at all (a match scored in the book).
        league: [
            { match_id: 7410001, home: 'Chesham CC', away: 'Tring Park CC',
              competition: 'TVCL Div 6C', allot: 40, start: 2, seed: 41 },
            { match_id: 7410002, home: 'Aylesbury Town CC', away: 'Berkhamsted CC',
              competition: 'TVCL Div 6C', allot: 40, start: 0, seed: 53,
              beats: { rainAt: 22, abandon: true } },
            { match_id: 7410003, home: 'Great Missenden CC', away: 'Wycombe House CC',
              competition: 'TVCL Div 6C', allot: 40, start: 1, seed: 67 },
            { match_id: 7410004, home: 'Flackwell Heath CC', away: 'Hazlemere CC',
              competition: 'TVCL Div 6C', allot: 40, start: 3, seed: 79, silent: true }
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
    function rainNow(cfg, t) {
        var b = cfg.beats || {};
        return b.rainAt != null && t >= b.rainAt && t < b.rainAt + (b.rainFor || 3);
    }

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    // Balls as a cricket overs string, and a completed over drops its ".0" — the same
    // canonical form rv.mjs emits, because consumers render it verbatim.
    function fmtOvers(balls) {
        var o = Math.floor(balls / 6), b = balls % 6;
        return b ? o + '.' + b : String(o);
    }

    // ---- a simulated fixture -----------------------------------------------
    // Pre-rolls both innings, then answers "what does the feed say at poll N?".
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

        return {
            id: cfg.pc_id, ours: true, cfg: cfg, doneAt: doneAt,
            // Clips arrive on the streamed match only, and they arrive a poll LATE —
            // footage lags the scorecard in reality, and an extractor that assumed
            // otherwise would never join a clip to its wicket.
            card: function (t) {
                var raw = t - cfg.start;
                if (raw < 0) return null;                     // not started yet
                // Rain stops play, so the scorecard stops with it: the polls spent
                // under the covers advance the clock and not the game. Without this
                // the break would be cosmetic and the feed would keep scoring
                // through it.
                var b = cfg.beats || {};
                var lost = b.rainAt == null ? 0
                    : Math.max(0, Math.min(raw - b.rainAt + 1, b.rainFor || 3));
                t = raw - lost;
                var complete = t >= doneAt;
                var final = complete && t >= doneAt + cfg.publishAfter;
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
                    break_desc: rainNow(cfg, raw) ? 'Rain delay'
                              : ((t === n1 || t === n1 + 1) && !complete ? 'Innings break' : null),
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
                    scores_updated: Math.floor((clockNow() - pollGap()) / 1000),
                    // The simulated wall clock, for display only — nothing schedules
                    // off this, and no real feed carries it.
                    sim_clock: new Date(simEpoch(t)).toISOString(),
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
     * converted back to real time through the poll pacing. Without this, footage of a
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
                var agoMs = Math.max(0, (oversNow - atOver)) * pollGap();
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
        var homeXI = squad(cfg.seed, true), awayXI = squad(cfg.seed + 7, false);
        var first = playInnings({ seed: cfg.seed + 1, allot: cfg.allot, batting: homeXI, bowling: awayXI, target: null, beats: {} });
        var second = playInnings({ seed: cfg.seed + 2, allot: cfg.allot, batting: awayXI, bowling: homeXI, target: first.total + 1, beats: {} });
        var n1 = first.snaps.length, n2 = second.snaps.length, doneAt = n1 + n2;
        var chased = second.total > first.total, tied = second.total === first.total;
        var beats = cfg.beats || {};
        return {
            id: cfg.match_id, ours: false, cfg: cfg, doneAt: doneAt,
            card: function (t) {
                t = t - cfg.start;
                if (t < 0) return null;
                if (cfg.silent) return null;                  // scored in the book
                var rained = beats.rainAt != null && t >= beats.rainAt;
                var abandoned = rained && beats.abandon;
                var complete = abandoned || t >= doneAt;
                var inns = [];
                var cap1 = rained ? Math.min(beats.rainAt, n1) : n1;
                var i1 = first.snaps[Math.min(t, cap1) - 1];
                if (t >= 1 && i1) inns.push({ side: cfg.home, team_batting_id: String(cfg.match_id) + 'h',
                                              runs: i1.runs, wickets: i1.wickets, overs: i1.overs, declared: false });
                if (!rained && t > n1) {
                    var i2 = second.snaps[Math.min(t - n1, n2) - 1];
                    if (i2) inns.push({ side: cfg.away, team_batting_id: String(cfg.match_id) + 'a',
                                        runs: i2.runs, wickets: i2.wickets, overs: i2.overs, declared: false });
                }
                var desc = null, applied = null;
                if (abandoned) desc = 'Abandoned';
                else if (complete) {
                    var w = tied ? null : (chased ? cfg.away : cfg.home);
                    desc = tied ? 'Tied' : w + ' - Won';
                    applied = tied ? null : String(cfg.match_id) + (chased ? 'a' : 'h');
                }
                var last = inns[inns.length - 1];
                return {
                    match_id: cfg.match_id, competition: cfg.competition,
                    home: cfg.home, away: cfg.away,
                    home_team_id: String(cfg.match_id) + 'h', away_team_id: String(cfg.match_id) + 'a',
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

    // ---- the clock ----------------------------------------------------------
    // Built in `go`, not here: the day may still be re-labelled from the build's own
    // config (see adoptBakedDay), and pre-rolling the innings before that lands would
    // simulate the invented fixtures and then throw them away.
    var ours = [], others = [];
    var poll = 0;
    var SPEEDS = [4000, 2000, 1000, 500];
    var speedIdx = 1;
    // Held on arrival unless `&play` is on the URL — see `go`.
    var START_HELD = !/(^|[?&])play($|[=&])/.test(location.search);
    var playing = !START_HELD;
    var autoTimer = null;
    // A simulated clock, so `happened_at` brackets and the scheduler's freshness
    // decay are not all stamped with the same wall-clock instant. One poll is one
    // over, which is about four real minutes of cricket.
    var SIM_MS_PER_POLL = 240000;
    // The same controllable clock the engine judges freshness against (live-clock.js),
    // so a frozen clock freezes the scorer's cursor and the clip timings with it —
    // otherwise time would stop for the scheduler but keep running for the feed.
    function clockNow() { return window.WccClock ? WccClock.now() : Date.now(); }
    var simStart = clockNow();
    /* HOW MUCH TIME A POLL REPRESENTS. Under a frozen clock a poll advances "now" by
     * this, so stepping polls by hand still produces a coherent day: events age between
     * them and `happened_at` brackets have a real width. Fifteen seconds is the engine's
     * own FAST cadence, i.e. what the gap would actually be on a match day.
     *
     * With the clock left real, the gap between polls is however fast autoplay is
     * running, so that is what the brackets should say — a poll is only ever as old as
     * the last one really was. */
    var POLL_GAP_MS = 15000;
    /* The two time steps. Thirty seconds is about the resolution the model turns on —
     * a wicket's repeat window is three minutes, a six's ttl four — so it takes a
     * handful of presses to walk an event from news to ignored. Five minutes is for
     * skipping to the other side of a ttl in one go. */
    var TIME_STEP_MS = 30000, TIME_JUMP_MS = 300000;
    function pollGap() {
        return (window.WccClock && WccClock.isManual()) ? POLL_GAP_MS : SPEEDS[speedIdx];
    }
    function simEpoch(t) { return simStart + (t == null ? poll : t) * SIM_MS_PER_POLL; }

    function liveFeed() {
        return {
            generated_at: Math.floor(simEpoch() / 1000), ttl: 30,
            matches: ours.map(function (f) {
                var c = f.card(poll);
                return c || { pc_id: f.id, phase: 'pre', complete: false, final: false,
                              home: f.cfg.is_home ? f.cfg.our_club : f.cfg.opposition,
                              away: f.cfg.is_home ? f.cfg.opposition : f.cfg.our_club,
                              innings: [], clips: [], teams: [] };
            })
        };
    }
    function leagueFeed() {
        return {
            generated_at: Math.floor(simEpoch() / 1000), ttl: 300,
            matches: others.map(function (f) {
                var c = f.card(poll);
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

    // Match identity for the extractor and the chrome's labels (team name, division),
    // keyed the way both feeds key their cards. Built with the fixtures, for the same
    // reason.
    var cfgById = {};
    function buildDay() {
        ours = DAY.ours.map(ourMatch);
        others = DAY.league.map(leagueMatch);
        cfgById = {};
        DAY.ours.forEach(function (m) { cfgById[String(m.pc_id)] = m; });
        DAY.league.forEach(function (m) { cfgById[String(m.match_id)] = m; });
    }

    /* Ladder moves, announced rather than derived — the strip owns the league table
     * and the points maths, so in production it is the strip that will call
     * `addLadderMove` when a move commits (see live-events.js). Until that wiring
     * exists the simulator stands in for it, which is enough to design the
     * scheduling against: what matters here is that a ladder move competes with a
     * wicket for the screen, not where the number came from. */
    var LADDER_MOVES = [
        { atPoll: 46, club: 'Wendover CC', ours: true, places: 2, to: 4,
          division: 'TVCL Div 6C', reason: 'Amersham chase falling away' },
        { atPoll: 74, club: 'Chesham CC', places: -1, to: 6,
          division: 'TVCL Div 6C', reason: 'Tring Park result posted' }
    ];

    var handle = null;
    /* A POLL AND THE TIME IT TOOK, which is the honest default: on a real afternoon
     * data does not arrive with zero elapsed time, and if it did, every event in the
     * store would share one timestamp and every bracket would be zero wide — the whole
     * model would look like it worked when it had nothing to work on.
     *
     * `withTime` false is the deliberate exception (shift-N): deliver a poll at the
     * exact instant of the last one, for looking at how simultaneous arrivals rank. */
    function step(withTime) {
        /* TIME AND DATA MOVE TOGETHER, and the scheduler must see only the end of it.
         * Announcing the clock first had it decide against a store that did not yet hold
         * this poll's events — so it would pick the previous over's score, start its
         * dwell, and then be holding a score the very next line of code made obsolete.
         * Quiet here; `handle.poll()` broadcasts once it has ingested. */
        var quiet = withTime !== false && !!handle;
        if (withTime !== false) advanceClock(pollGap(), quiet);
        poll++;
        if (!handle) return;
        handle.poll();
        // The league feed is polled a tenth as often in production (5 min vs 15 s);
        // one poll in four here keeps it visibly coarser without making it useless.
        if (poll % 4 === 0) handle.pollLeague();
        // Guarded: the asset cache can serve this page an older engine that has no
        // such seam, and a missing ladder move is not worth a broken clock.
        if (handle.addLadderMove) LADDER_MOVES.forEach(function (mv) {
            if (mv.atPoll === poll) handle.addLadderMove(mv);
        });
        hud();
    }
    function autoplay(on) {
        playing = on;
        if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
        if (on) autoTimer = setInterval(step, SPEEDS[speedIdx]);
        hud();
    }

    /* ---- time, as its own control -------------------------------------------------
     * Data arriving and time passing are separate questions, so they get separate keys.
     * Freezing is what makes the relevance algorithm legible: a ranking holds still
     * long enough to read, an event's dwell stops expiring under you, and you can skip
     * the ten minutes it takes something to age out instead of waiting for them.
     *
     * Autoplay and a frozen clock are contradictory (autoplay's whole premise is that
     * time passes on its own), so freezing stops it. */
    /* HOLDING TIME HOLDS THE WHOLE SCREEN, not just the scheduler's clock. The deck
     * would otherwise keep advancing off whatever you were reading, and the chrome's
     * own rotations would keep going (those are stopped by the `wcc-clock` broadcast
     * the engine makes — see live-ticker.html / live-strip.html).
     *
     * The deck's play state is REMEMBERED rather than assumed: releasing must not
     * start a deck that was already paused when you held it. */
    var deckWasPlaying = null;
    function deckApi() {
        return window.WccPlayer && window.WccPlayer.setPlaying ? window.WccPlayer : null;
    }
    /* Pausing the deck, WHENEVER THE PLAYER GETS ROUND TO EXISTING. The simulator is
     * injected as a script and arms itself as soon as it parses, which can be before
     * player-core's `start()` has run and put `setPlaying` on WccPlayer — and that is
     * the common case when the clock is held from boot. Retrying briefly is what makes
     * "starts held" hold the deck as well as the clock, rather than silently missing it
     * and leaving the deck running under a held screen.
     *
     * Abandoned the moment the clock is released, so a retry can never pause a deck the
     * user has just handed back. */
    function holdDeck(tries) {
        if (!(window.WccClock && WccClock.isManual())) return;
        var deck = deckApi();
        if (deck) {
            if (deckWasPlaying === null) deckWasPlaying = deck.isPlaying();
            deck.setPlaying(false);
            return;
        }
        if ((tries || 0) < 25) setTimeout(function () { holdDeck((tries || 0) + 1); }, 100);
    }
    function freeze(on) {
        if (!window.WccClock) { console.warn('[sim] live-clock.js not loaded — time cannot be held'); return; }
        WccClock.manual(on);
        if (on) {
            if (playing) autoplay(false);
            holdDeck(0);
        } else {
            var deck = deckApi();
            if (deck && deckWasPlaying) deck.setPlaying(true);
            deckWasPlaying = null;
        }
        hud();
    }
    function advanceClock(ms, quiet) {
        if (window.WccClock && WccClock.isManual()) { WccClock.advance(ms, quiet); hud(); return true; }
        return false;   // a real clock advances itself
    }
    // Stepping time with no clock held is a request to hold it — pressing the key and
    // having nothing happen would read as a broken control.
    function stepTime(ms) {
        if (!(window.WccClock && WccClock.isManual())) freeze(true);
        advanceClock(ms);
    }

    // ---- the HUD ------------------------------------------------------------
    // Small, fixed, and the only thing in here that is not a simulation of something
    // real: the clock's own controls. The event stream itself is inspected on the
    // live-events slide, which is a normal slide rendering a normal broadcast.
    var box = null;
    // Seconds as a short duration ("90s" -> "1m30"), so a long step does not read as a
    // four-digit number of seconds.
    function fmtDur(s) {
        s = Math.abs(Math.round(s));
        if (s < 60) return s + 's';
        var m = Math.floor(s / 60), r = s % 60;
        return m + 'm' + (r ? String(r).padStart(2, '0') : '');
    }
    function hud() {
        if (!box) {
            box = document.createElement('div');
            box.id = 'sim-hud';
            box.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;padding:6px 10px;' +
                'font:11px/1.5 ui-monospace,Menlo,monospace;color:#fff;background:rgba(8,21,44,0.88);' +
                'border-right:1px solid #d4af37;border-bottom:1px solid #d4af37;pointer-events:none;' +
                'white-space:pre;text-align:left';
            document.body.appendChild(box);
        }
        var inPlay = ours.concat(others).filter(function (f) {
            var c = f.card(poll); return c && !c.complete;
        }).length;
        var d = new Date(simEpoch());
        var frozen = !!(window.WccClock && WccClock.isManual());
        /* Two clocks, and the HUD has to keep them apart: the day's fictional wall time
         * (derived from the over count, for flavour) and the SCHEDULER's clock, which is
         * the one being held. Only the second matters to the model.
         *
         * What is shown of it is `advanced` — how much time has been pushed through by
         * hand since the hold — and NEVER the distance to the wall clock, which grows a
         * second every second and would leave a counter ticking away on a screen whose
         * whole point is that nothing is moving. */
        var adv = frozen ? Math.round(WccClock.advanced() / 1000) : 0;
        var clockLine = frozen
            ? '⏸ time HELD' + (adv ? '  ·  +' + fmtDur(adv) + ' stepped' : '')
            : '⏱ time live';
        box.textContent =
            'SIM poll ' + poll + '  ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') +
            '  ' + inPlay + ' in play  ' + (playing ? '▶ ' + (SPEEDS[speedIdx] / 1000) + 's' : '❚❚ paused') +
            '\n' + clockLine +
            '\ndata: n step (+' + (pollGap() / 1000) + 's) · N step (no time) · a auto · [ ] speed' +
            '\ntime: k hold/release · . +' + (TIME_STEP_MS / 1000) + 's · > +' +
                (TIME_JUMP_MS / 60000) + 'm · , −' + (TIME_STEP_MS / 1000) + 's' +
            '\nr restart · h hide  (space/→ still drive the deck)';
    }

    /* KEYS THE PLAYER DOES NOT ALREADY OWN. player-core.js binds its transport on the
     * same document — Space, ←, →, Home, End, PageDown, Escape and f/F (fullscreen) —
     * and both listeners fire, so anything shared here makes one press do two
     * unrelated things. `f` was doing exactly that: holding time AND toggling
     * fullscreen. Space and → were quietly doing it too, stepping a poll as well as
     * driving the deck.
     *
     * So the simulator keeps to letters and brackets of its own, and the deck's
     * transport is left alone: Space still plays/pauses the deck, → still moves it on.
     * Check this list against player-core's keydown handler before adding to it. */
    document.addEventListener('keydown', function (e) {
        var k = e.key;
        if (e.metaKey || e.ctrlKey || e.altKey) return;   // never shadow a browser shortcut
        // --- data arriving
        if (k === 'n') { e.preventDefault(); autoplay(false); step(); }
        else if (k === 'N') { e.preventDefault(); autoplay(false); step(false); }   // poll, no time
        else if (k === 'a') autoplay(!playing);
        else if (k === ']') { speedIdx = Math.min(SPEEDS.length - 1, speedIdx + 1); if (playing) autoplay(true); else hud(); }
        else if (k === '[') { speedIdx = Math.max(0, speedIdx - 1); if (playing) autoplay(true); else hud(); }
        /* --- time passing. `k` holds and releases (the media-player convention, and
         * free here); `.` and `>` push a held clock forward, `,` pulls it back — the
         * frame-step convention, for the same reason. */
        else if (k === 'k') { e.preventDefault(); freeze(!(window.WccClock && WccClock.isManual())); }
        else if (k === '.') { e.preventDefault(); stepTime(TIME_STEP_MS); }
        else if (k === '>') { e.preventDefault(); stepTime(TIME_JUMP_MS); }
        else if (k === ',') { e.preventDefault(); stepTime(-TIME_STEP_MS); }
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
                        start: i < templates.length ? base.start : 2 + i * 3,
                        seed: base.seed + i * 13
                    });
                });
                console.log('[sim] adopted', DAY.ours.length, 'baked match(es):',
                            DAY.ours.map(function (m) { return m.team_name + ' #' + m.pc_id; }).join(', '));
            })
            .catch(function () { /* no config served — the invented day stands */ });
    }

    // ---- go -----------------------------------------------------------------
    // The engine is started HERE rather than by the player, because the player's own
    // start is gated on an access key this has no need of. Manual: the engine never
    // schedules its own next poll, so the clock above is the only clock.
    function go() {
        if (!window.WccLive) { console.warn('[sim] live-engine.js not loaded — is live_enabled off?'); return; }
        if (!window.WccLiveEvents) console.warn('[sim] live-events.js not loaded — no event stream');
        buildDay();
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
        console.log('[sim] match day armed —', DAY.ours.length, 'of ours,', DAY.league.length, 'in the division');
        /* HELD FROM THE START, because that is the state you want to be in when you
         * arrive: the first poll has landed (WccLive.start polls once), so there is a
         * toss on screen to look at, and nothing moves again until you ask it to. A day
         * that began by running meant every arrival started with a scramble to stop it.
         *
         * `&play` starts it running instead, which is the old behaviour and the right
         * one for simply watching an afternoon go by. */
        if (START_HELD) freeze(true); else autoplay(true);
        hud();
    }
    // Adopt the build's day (if it baked one) before anything is pre-rolled.
    function boot() { Promise.all([adoptBakedDay(), loadClipPool()]).then(go); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();

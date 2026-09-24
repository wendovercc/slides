/* live-chase.js — the chase model: resources, target, win probability.
 *
 * ONE copy, because there are now two consumers that must agree. The live strip
 * (templates/live-strip.html) prices tiles and the ladder off it; the event
 * extractor (live-events.js) prices `probability_shift` and `ladder_shift` events
 * off it. Two surfaces disagreeing about who is winning the same match is the
 * failure this module exists to prevent — the `tvclPoints` port already carries
 * that warning, and this is the other half of it.
 *
 * Deliberately PURE: feed shapes in, numbers out. No DOM, no postMessage, no
 * knowledge of tiles or events. Whether a given side is the one batting is the
 * caller's question (it needs fixture identity to answer), so this module speaks
 * only about the side batting SECOND and leaves the mirroring to the consumer.
 *
 * Loaded before any consumer; a consumer must tolerate its absence (the asset
 * cache can serve a page newer than its scripts — see the asset-cache-skew note),
 * which in practice means falling back to "no lean, no certainty".
 */
(function () {
    // APPROXIMATE Duckworth-Lewis Standard Edition resource table (% of a 50-over
    // innings remaining, by overs left × wickets lost), bilinearly interpolated.
    // Good to a few points, which is all a fill height or an event threshold needs
    // — but it is NOT the official table, so don't reuse it for anything that
    // decides a match.
    var DLS_OVERS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
    var DLS_WKTS = [0, 2, 5, 7, 9];
    var DLS = [
        /*  0 ov */[0, 0, 0, 0, 0],
        /*  5 ov */[17.9, 17.6, 16.4, 14.9, 7.0],
        /* 10 ov */[32.1, 30.8, 26.1, 20.6, 7.5],
        /* 15 ov */[45.2, 43.0, 33.6, 23.6, 7.6],
        /* 20 ov */[56.6, 52.4, 39.5, 24.9, 7.6],
        /* 25 ov */[66.5, 60.4, 43.4, 25.7, 7.6],
        /* 30 ov */[75.1, 67.3, 45.7, 25.9, 7.6],
        /* 35 ov */[82.7, 73.0, 47.4, 26.1, 7.6],
        /* 40 ov */[89.3, 77.6, 48.4, 26.3, 7.6],
        /* 45 ov */[95.0, 81.0, 49.1, 26.4, 7.6],
        /* 50 ov */[100.0, 83.8, 49.5, 26.5, 7.6]
    ];
    function lerpIdx(grid, v) {
        if (v <= grid[0]) return [0, 0, 0];
        var last = grid.length - 1;
        if (v >= grid[last]) return [last, last, 0];
        for (var i = 1; i <= last; i++) {
            if (v <= grid[i]) return [i - 1, i, (v - grid[i - 1]) / (grid[i] - grid[i - 1])];
        }
        return [last, last, 0];
    }
    function resourcePct(oversLeft, wktsLost) {
        if (!(oversLeft > 0) || wktsLost >= 10) return 0;
        var o = lerpIdx(DLS_OVERS, oversLeft), w = lerpIdx(DLS_WKTS, wktsLost);
        function at(oi) {
            var a = DLS[oi][w[0]], b = DLS[oi][w[1]];
            return a + (b - a) * w[2];
        }
        var lo = at(o[0]), hi = at(o[1]);
        return lo + (hi - lo) * o[2];
    }

    // Overs as a ball count ("39.4" -> 238). Cricket's .1-.5 fractions are balls,
    // not decimals, so this can't be a plain parseFloat.
    function ballsOf(overs) {
        var s = String(overs == null ? '' : overs).trim();
        if (!s) return 0;
        var p = s.split('.');
        return (parseInt(p[0], 10) || 0) * 6 + (p.length > 1 ? (parseInt(p[1], 10) || 0) : 0);
    }
    // The innings allotment, inferred from how the FIRST innings closed rather than
    // any max_overs field (unreliable in the feed — see the DLS overs note): a side
    // that was neither bowled out nor declared, and stopped on a whole over, was
    // stopped BY the allotment. Anything else leaves it unknown, and the chase
    // model falls back to its wickets-only form.
    function allotmentOvers(first) {
        if (!first || (first.wickets || 0) >= 10 || first.declared) return null;
        var b = ballsOf(first.overs);
        return (b > 0 && b % 6 === 0) ? b / 6 : null;
    }

    function logistic(x) { return 1 / (1 + Math.exp(-x)); }

    // Chase state + win probability for the SIDE BATTING SECOND. One place, one
    // model, deliberately coarse: par from the DLS-style resource split, then a
    // logistic on runs-vs-par whose spread shrinks with the resources left — so an
    // early chase sits near 50/50 (little movement on the ladder) and certainty
    // grows on its own as the game runs out of road.
    function chaseState(inns) {
        if (!inns || inns.length !== 2) return null;
        var first = inns[0], cur = inns[1];
        var firstRuns = first.runs || 0;
        var target = firstRuns + 1;
        var runsLeft = Math.max(0, target - (cur.runs || 0));
        var wktsLost = cur.wickets || 0, wktsLeft = Math.max(0, 10 - wktsLost);
        var allot = allotmentOvers(first);
        var bowled = ballsOf(cur.overs);
        var ballsLeft = allot != null ? Math.max(0, allot * 6 - bowled) : null;
        var p;
        if (allot != null) {
            var oversLeft = ballsLeft / 6;
            var rTot = resourcePct(allot, 0) || 1;
            var rRem = resourcePct(oversLeft, wktsLost);
            var par = firstRuns * (1 - rRem / rTot);
            // Spread of the runs still to come, as a share of the first-innings
            // total. It closes faster than sqrt(resources) would suggest, because a
            // side ahead of par with wickets in hand can simply see the game out —
            // the outcome settles quicker than a symmetric run-race implies.
            var sigma = Math.max(4, 0.13 * firstRuns * Math.pow(rRem / rTot, 0.8));
            p = logistic(((cur.runs || 0) - par) / sigma);
        } else {
            // Allotment unknown (first innings bowled out or declared): no overs
            // axis, so judge on wickets alone — roughly 20 runs a wicket left —
            // and keep the certainty ceiling low, because this is a weak read.
            var exp = wktsLeft * 20;
            p = logistic((exp - runsLeft) / Math.max(10, 0.6 * exp || 10));
            p = 0.5 + (p - 0.5) * 0.4;
        }
        return {
            runs: runsLeft, balls: ballsLeft, wkts: wktsLeft, p: p,
            target: target,
            // Required rate is the number that matters in a chase; without an
            // allotment there are no balls left to require it over, so fall back to
            // the rate actually being scored. The label follows the choice.
            // Always one decimal place, so a whole-number rate doesn't jump the
            // column ("7" beside "6.8"). String, not number, for that reason.
            rr: ballsLeft ? (runsLeft / (ballsLeft / 6)).toFixed(1)
                          : (bowled ? ((cur.runs || 0) / (bowled / 6)).toFixed(1) : null),
            rr_label: ballsLeft ? 'Req rate' : 'Run rate'
        };
    }

    window.WccChase = {
        resourcePct: resourcePct,
        ballsOf: ballsOf,
        allotmentOvers: allotmentOvers,
        chaseState: chaseState
    };
})();

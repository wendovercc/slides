/* tvcl-points.js — Thames Valley CL Win/Lose league points (Match Rules §9).
 *
 * ONE client-side copy, for the same reason live-chase.js is one: two surfaces
 * disagreeing about what a result was worth is worse than neither showing it. The
 * live strip prices its ladder off this; the match-day board badges each finished
 * game with it.
 *
 * A PORT of tvclPoints() in live-worker/src/rv.mjs, which is the authority and
 * carries the unit tests (test/points.test.mjs) — keep the two in step. It has to
 * exist client-side at all because the strip and the board price OTHER clubs'
 * matches, which arrive on the lean PC feed with no points attached; our own match
 * carries the server's figures and a consumer should prefer those when present.
 *
 * ONE DELIBERATE DIVERGENCE from rv.mjs: a washout is priced from the description
 * alone, before the two-innings requirement. rv.mjs attaches its figures PER
 * INNINGS, so a game with fewer than two has nowhere to put them and null is the
 * honest answer there; a badge names a side directly and can carry 7 for a game
 * that never got going, which is the commonest way a washout looks.
 *
 * ONLY TVCL WIN/LOSE. Every other league has its own rules, and a Traditional
 * (draw) division's win is worth something else entirely — so the caller gates on
 * the division being TVCL and shows no points at all when it isn't. `tvcl` here
 * does not test that; it only does the arithmetic it is handed.
 *
 * Deliberately PURE: innings in, numbers out. No DOM, no feed knowledge.
 *
 * Loaded before any consumer; a consumer must tolerate its absence (the asset
 * cache can serve a page newer than its scripts — see the asset-cache-skew note),
 * which here means falling back to no points: the strip holds its ladder position
 * and the board badges the verdict alone.
 */
(function () {
    // Loser's bonuses. Batting first: 100 runs → 1, then one per 25 up to 5.
    var batFirstRuns = function (r) { return r < 100 ? 0 : Math.min(5, 1 + Math.floor((r - 100) / 25)); };
    // Batting second the batting bonus is capped at 3, the %-of-target award
    // carrying the rest.
    var batSecondFixed = function (r) { return r < 100 ? 0 : Math.min(3, 1 + Math.floor((r - 100) / 25)); };
    // Bowling second (i.e. the side that batted first): 2 wickets → 1, then one
    // each, all out → 8.
    var bowlSecondPts = function (w) { return w >= 2 ? Math.min(8, w - 1) : 0; };
    // Bowling first (the side that chased): ~ceil(w/2), capped at 5.
    var bowlFirstPts = function (w) { return Math.min(5, Math.ceil(w / 2)); };
    function pctTargetPts(second, first) {
        if (!first) return 0;
        var p = (second / first) * 100;
        return p > 95 ? 5 : p > 90 ? 4 : p > 85 ? 3 : p > 80 ? 2 : p > 75 ? 1 : 0;
    }

    /**
     * [pointsForTheSideThatBattedFirst, pointsForTheSideThatChased], or null when
     * the outcome isn't a clean win/tie/washout. `inns` is the feed's innings array
     * in batting order; `resultText` is the card's result description. A washout
     * needs no innings (both sides get 7), so the two figures being EQUAL is also
     * the caller's signal that it needn't know which side batted first.
     */
    function tvcl(inns, resultText) {
        var t = String(resultText || '');
        // A washout is 7 each whatever was bowled, so it is priceable from the
        // description alone — which is the usual case, since a game called off
        // rarely has two innings behind it. Tested FIRST for that reason.
        if (/abandon|no result|wash|cancel/i.test(t)) return [7, 7];
        if (!inns || inns.length < 2) return null;
        var i1 = inns[0], i2 = inns[1];
        if (!i1 || !i2 || i1.runs == null || i2.runs == null) return null;
        var r1 = i1.runs || 0, r2 = i2.runs || 0;
        if (/\btied?\b/i.test(t) || r1 === r2) return [14, 14];
        var firstWon = r1 > r2;
        return [
            firstWon ? 22 : batFirstRuns(r1) + bowlSecondPts(i2.wickets || 0),
            firstWon ? bowlFirstPts(i1.wickets || 0) + batSecondFixed(r2) + pctTargetPts(r2, r1) : 22
        ];
    }

    window.WccPoints = { tvcl: tvcl };
})();

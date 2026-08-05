/* live-strip-sim.js — off-day test harness for the live strip.
 *
 * There is no live cricket most days, and none at all out of season, so the strip
 * would otherwise only ever be seen empty. This drives the SHIPPING render path:
 * it fabricates the two feeds the player broadcasts (`wcc-live` for our matches,
 * `wcc-league` for the division's others) in the same normalised shapes the Worker
 * emits, and posts them at the page. Nothing in live-strip.html knows it's a
 * simulation — every tile channel is derived by the real code.
 *
 * Load: /live-strip/?sim=league (or ?sim=friendly). Never loaded otherwise.
 * The build must have baked views for the day, so pick a fixture date:
 *   WCC_TODAY=2026-08-08 WCC_LIVE_ENABLED=1 python3 scripts/build.py   # league
 *   WCC_TODAY=2026-08-02 WCC_LIVE_ENABLED=1 python3 scripts/build.py   # friendly
 *
 * One tick = one over for every match in play, so a full game plays out in about
 * three minutes. Matches start at staggered ticks and end at different times, so a
 * single run shows every tile state: first-innings roles, a chase tightening either
 * way, a decided-but-unpublished result (clock), a published one, a silent feed,
 * and a team with no match at all.
 */
(function () {
  var TICK_MS = 2000;         // one over
  var script = document.currentScript;
  var mode = (script && script.getAttribute('data-sim')) || 'league';
  var views = window.WCC_STRIP_VIEWS || [];

  var view = null;
  for (var i = 0; i < views.length; i++) {
    if (views[i].mode === mode || mode === 'auto') { view = views[i]; break; }
  }
  if (!view) view = views[0];
  if (!view) { console.warn('[strip-sim] no baked views — build with WCC_TODAY set to a fixture date'); return; }
  console.log('[strip-sim] simulating', view.mode, 'view:', view.team_label, view.name || '');

  // Deterministic so a run is repeatable (same seed -> same match).
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  // Pre-roll a whole match as two innings of per-over {runs, wkts}, so any tick is
  // just a prefix sum. `allot` overs a side, all out at 10 wickets, chase stops the
  // moment it passes the target.
  function playMatch(seed, allot) {
    var r = rng(seed);
    var strength = 0.75 + r() * 0.9;          // this pitch/attack's scoring temper
    function innings(target) {
      var overs = [], runs = 0, wkts = 0;
      for (var o = 0; o < allot; o++) {
        var scored = Math.max(0, Math.round((3 + r() * 6) * strength));
        var lost = r() < 0.13 ? 1 : 0;
        runs += scored; wkts += lost;
        overs.push({ runs: scored, wkts: lost });
        if (wkts >= 10) break;
        if (target != null && runs >= target) break;
      }
      return overs;
    }
    var first = innings(null);
    var firstRuns = first.reduce(function (a, o) { return a + o.runs; }, 0);
    return { allot: allot, first: first, second: innings(firstRuns + 1), firstRuns: firstRuns };
  }

  function cum(overs, n) {
    var runs = 0, wkts = 0, balls = 0;
    for (var i = 0; i < Math.min(n, overs.length); i++) {
      runs += overs[i].runs; wkts += overs[i].wkts; balls += 6;
    }
    return { runs: runs, wickets: wkts, overs: String(balls / 6) };
  }

  // A simulated fixture. `sides` are [battedFirst, battedSecond], each
  // {club, team_id, is_home} — the same structural identity the real feeds carry,
  // since that's what consumers bind on: RV states `is_home` per innings and the
  // per-team verdict, PC gives `team_batting_id` and `result_applied_to`. `silent`
  // never emits a card (the "match on, no live data" tile); `publishAfter` is how
  // many ticks a finished match stays decided-but-unpublished — the window where
  // there is NO verdict yet and a consumer must read the scorecard instead.
  function fixture(cfg) {
    var m = playMatch(cfg.seed, cfg.allot || 40);
    var firstOvers = m.first.length, secondOvers = m.second.length;
    var secondRuns = cum(m.second, secondOvers).runs;
    var chased = secondRuns > m.firstRuns;
    return {
      id: cfg.id, ours: !!cfg.ours, sides: cfg.sides, silent: !!cfg.silent,
      start: cfg.start || 0, publishAfter: cfg.publishAfter == null ? 4 : cfg.publishAfter,
      card: function (tick) {
        var t = tick - this.start;
        if (this.silent || t < 0) return null;               // not started / no feed
        var doneAt = firstOvers + secondOvers;
        var complete = t >= doneAt;
        var published = complete && t >= doneAt + this.publishAfter;
        var sides = this.sides, ours = this.ours;
        var innings = [inn(sides[0], cum(m.first, Math.min(t, firstOvers)), ours)];
        if (t > firstOvers) innings.push(inn(sides[1], cum(m.second, t - firstOvers), ours));
        var winner = chased ? sides[1] : sides[0];
        var tied = complete && secondRuns === m.firstRuns;
        var home = sides[0].is_home ? sides[0] : sides[1];
        var away = sides[0].is_home ? sides[1] : sides[0];
        var card = {
          phase: complete ? 'post' : 'live',
          complete: complete,
          result: complete ? (tied ? 'Match tied' : winner.club + ' won') : null,
          innings: innings
        };
        if (ours) {
          // RV shape: per-team verdict, published only once the scorer confirms.
          card.final = published;
          card.teams = sides.map(function (s, i) {
            return { club: s.club, is_home: s.is_home, batted_first: i === 0,
                     outcome: !published ? null : (tied ? 'tied' : (s === winner ? 'won' : 'lost')) };
          });
        } else {
          // PC shape: ids, and the winning team id once the result is posted.
          card.home_team_id = home.team_id;
          card.away_team_id = away.team_id;
          card.result_applied_to = (complete && !tied) ? winner.team_id : null;
        }
        return card;
      }
    };
  }
  function inn(s, sc, ours) {
    var o = { side: s.club, runs: sc.runs, wickets: sc.wickets, overs: sc.overs,
              declared: false, at_crease: [], closed: false };
    if (ours) { o.club = s.club; o.is_home = s.is_home; }
    else o.team_batting_id = s.team_id;
    return o;
  }

  // --- wire the day's fixtures -------------------------------------------------
  // Our own match always plays. In a league view the division's other teams are
  // paired off (the baked fixtures list is empty on any day the league-fixtures
  // fetch didn't run for), with one pair left silent and, if the count is odd, one
  // team with no match at all.
  var byId = {};
  (view.teams || []).forEach(function (t) { if (t.team_id) byId[t.team_id] = t.club; });

  var sims = [];
  var ourFx = (view.fixtures || []).filter(function (f) { return f.ours; })[0] || { team_ids: [] };
  var ourTeam = (view.teams || []).filter(function (t) { return t.ours; })[0] || view.teams[0] || {};
  // Our opponent is whichever id in our own fixture isn't ours — never "the next
  // team in the table", which would bind the real opponent's tile to our match.
  var oppId = (ourFx.team_ids || []).filter(function (id) { return id && id !== ourTeam.team_id; })[0];
  var oppClub = view.mode === 'friendly'
    ? ((view.teams || []).filter(function (t) { return !t.ours; })[0] || {}).club
    : (byId[oppId] || 'Opposition CC');
  var atHome = function (id) { return String(id) === String(ourFx.home_team_id); };
  // Opposition bats first, so our side is the one chasing (the friendly view's
  // chase panel then has something to show).
  sims.push(fixture({
    id: view.pc_id, ours: true, seed: 7, start: 0, publishAfter: 8,
    sides: [{ club: oppClub, team_id: oppId, is_home: atHome(oppId) },
            { club: ourTeam.club, team_id: ourTeam.team_id, is_home: atHome(ourTeam.team_id) }]
  }));

  if (view.mode !== 'friendly') {
    // Pair off the rest of the division. The baked fixtures list is empty on any
    // day the league-fixtures fetch didn't run for, so register each fabricated
    // pairing with the view too — that list is how the strip binds tile → match.
    var others = (view.teams || []).filter(function (t) {
      return t.team_id && t.team_id !== ourTeam.team_id && t.team_id !== oppId
        && !view.fixtures.some(function (f) { return (f.team_ids || []).indexOf(t.team_id) !== -1; });
    });
    var fakeId = 900001;
    for (var j = 0; j + 1 < others.length; j += 2) {
      var id = fakeId++;
      // Alternate which side bats first at home, so both id-attribution paths
      // (home batting first, away batting first) get exercised.
      var homeFirst = j % 4 === 0;
      var a = others[j], b = others[j + 1];
      view.fixtures.push({ match_id: id, ours: false,
                           team_ids: [a.team_id, b.team_id],
                           home_team_id: (homeFirst ? a : b).team_id });
      sims.push(fixture({
        id: id, seed: 11 + j * 7, start: j * 3, allot: 40,
        sides: [{ club: a.club, team_id: a.team_id, is_home: homeFirst },
                { club: b.club, team_id: b.team_id, is_home: !homeFirst }],
        silent: j === 4,                       // one division match with no live data
        publishAfter: j === 2 ? 25 : 3         // one lingers unpublished (clock tile)
      }));
    }
    // An odd division leaves the last team with no match at all — the dimmed tile.
  }

  // --- broadcast ---------------------------------------------------------------
  var tick = 0;
  var homeClub = function (f) { return (f.sides[0].is_home ? f.sides[0] : f.sides[1]).club; };
  var awayClub = function (f) { return (f.sides[0].is_home ? f.sides[1] : f.sides[0]).club; };
  function emit() {
    var live = [], league = [];
    sims.forEach(function (f) {
      var c = f.card(tick);
      if (f.ours) {
        live.push(Object.assign({ pc_id: f.id, home: homeClub(f), away: awayClub(f) },
                                c || { phase: 'pre', complete: false, innings: [] }));
      } else if (c) {
        league.push(Object.assign({ match_id: f.id, home: homeClub(f), away: awayClub(f) }, c));
      } else {
        // Started-but-silent: the feed knows of the match, has nothing to say.
        league.push({ match_id: f.id, phase: 'no-feed', home: homeClub(f), away: awayClub(f), innings: [] });
      }
    });
    window.postMessage({ type: 'wcc-live', status: 'ok', matches: live }, '*');
    window.postMessage({ type: 'wcc-league', matches: league }, '*');
    tick++;
  }
  emit();
  setInterval(emit, TICK_MS);
})();

/* live-engine.js — player-owned live-match engine (parent frame only).
 *
 * The single-poller Worker (live.wendovercc.org) already collapses every device
 * to one upstream RV refresh per TTL; this is the *client* half: ONE poll loop
 * per player frame that broadcasts the normalised feed to every slide iframe as
 * a `wcc-live` message. Live-aware slides (today.html) render from it; the rest
 * ignore it. A slide viewed standalone self-polls instead — this never runs
 * there, so there's exactly one poller whether embedded or not.
 *
 * Why in the player, not the slide: several live-aware slides can share one feed
 * (no per-slide duplicate polling), the feed survives slide transitions, and it's
 * the natural home for the later clip-interrupt / ticker behaviours that live
 * above the slides.
 *
 * Usage (from the player, after the iframes exist):
 *   WccLive.start({ frames: () => Array.from(document.querySelectorAll('iframe')) });
 */
(function () {
  window.WccLive = { start: start };

  function start(opts) {
    opts = opts || {};
    var endpoint = opts.endpoint || 'https://live.wendovercc.org/state.json';
    // Same-origin poll list (the daily build writes it next to the player), so the
    // engine works the instant the site is built — locally and in prod — instead of
    // waiting on the Worker's own copy of the config to deploy. We resolve the ids
    // here and hand them to the Worker as ?pc=, matching the standalone slide's
    // cache key so every device still collapses to one upstream refresh.
    var configUrl = opts.configUrl || '/live-config.json';
    // A function so the frame set is read fresh each poll (a refresh may swap iframes).
    var framesOf = opts.frames || function () { return []; };
    // Called with the feed (or null past the grace window) each poll, so the player
    // can drive parent-frame chrome (the live ticker footer's sticky show/hide latch)
    // off the same state the slides render. A no-op if the caller doesn't need it.
    var onState = opts.onState || function () {};
    var keyName = opts.keyName || 'wccLiveKey';
    // Adaptive cadence: fast while something is actually in play, relaxed when the
    // day's matches are only pre/post, idle when there's nothing on. The Worker's
    // own TTL cache means faster client polling just yields cache hits between
    // upstream refreshes, so this is polite either way.
    var FAST = opts.fastMs || 15000, SLOW = opts.slowMs || 30000, IDLE = opts.idleMs || 120000;
    // Keep showing the last good feed across a brief blip; only fall to the honest
    // "unavailable" state (null feed) once failures persist past the grace window.
    var GRACE = opts.grace == null ? 2 : opts.grace;

    var last = null;        // last good feed (for late-joining slides + blip grace)
    var lastStatus = 'ok';
    var fails = 0;
    var timer = null;
    var pcs = opts.matches || null;   // pollable pc ids; resolved from configUrl if not given
    // Clip news-flash: which events fire ('all' now, for testing; later a subset
    // like ['wicket','six','other']). Baseline the backlog at first feed so only
    // clips that land AFTER load flash; dedupe by id thereafter.
    var flashEvents = opts.flashEvents || 'all';
    var seenClips = null;             // null until baselined; then a {id:1} set
    var cfgById = {};                 // pc_id -> config match (crest/team attribution)

    function key() { try { return localStorage.getItem(keyName) || ''; } catch (e) { return ''; } }

    // --- The access gate, client side ------------------------------------------
    // The Worker's bearer check runs INSIDE the Worker, so every unauthorised poll
    // still costs a Worker invocation. A device with no key, or with a key the
    // Worker refuses, would otherwise sit at the SLOW cadence forever (2,880 hits
    // a day, each one guaranteed to 403) — the site is public, so that's every
    // casual visitor too. So both are terminal here, not backoff cases:
    //   no key      → never start either loop
    //   403         → stop dead; the token is either right or wrong, never flaky
    // We resume only when the key CHANGES to something we haven't had refused
    // (a same-value re-set doesn't retry a known-bad token). In practice a Pi
    // reseeds via ?k= on its next reload, and the bar iPad via the home-page cog;
    // WccLiveKey.onChange catches the live case without waiting for either.
    var stopped = false;     // hard-stopped: no polling at all until the key changes
    var refused = null;      // the key value the Worker 403'd, so we don't retry it

    function halt(reason) {
      stopped = true;
      refused = reason === 'forbidden' ? key() : null;
      if (timer) { clearTimeout(timer); timer = null; }
      if (leagueTimer) { clearTimeout(leagueTimer); leagueTimer = null; }
      lastStatus = reason;
      // Slides show their baked schedule with a "No feed" badge — same honest
      // degraded paint as any other unreachable-feed case.
      broadcast(null, reason);
      onState(null, reason);
    }

    function resume() {
      if (!stopped) return;
      var k = key();
      if (!k || k === refused) return;
      stopped = false; refused = null; fails = 0;
      poll();
      if (leagueIds && leagueIds.length) leaguePoll();
    }

    // --- The poll window (the other half of the gate) ---------------------------
    // live-config.json says when today is worth polling at all: open shortly before
    // the first start, shut at midnight (see live-window.js / build.py). Outside it
    // we make no requests — asleep before the window, stopped for good after it.
    // The midnight close is also the stale-config safeguard: if the nightly build
    // fails, yesterday's window has already ended, so the wall stops rather than
    // polling on until the next successful build.
    var pollWindow = null;   // set once live-config.json resolves; null = no opinion
    var cfgReady = null;     // promise for that resolution, so the league loop can wait

    function windowState() {
      return window.WccLiveWindow ? window.WccLiveWindow.state(pollWindow) : 'open';
    }

    // Arm the gate before anything below can poll. The config resolution still
    // runs while stopped — it's same-origin and free, and it leaves pcs/cfgById
    // ready so a key arriving later resumes into a working loop immediately.
    if (!key()) halt('nokey');
    if (window.WccLiveKey && window.WccLiveKey.onChange) window.WccLiveKey.onChange(resume);

    // Worker URL: ?pc= the resolved ids (works pre-deploy + shares the cache key
    // with standalone slides); a bare URL only as a fallback when the config gave
    // us nothing, letting the Worker's own config drive if it has one.
    function url() {
      if (pcs && pcs.length)
        return endpoint + '?' + pcs.map(function (p) { return 'pc=' + encodeURIComponent(p); }).join('&');
      return endpoint;
    }

    function broadcast(feed, status, targets) {
      var msg = Object.assign({ type: 'wcc-live', status: status }, feed || {});
      (targets || framesOf()).forEach(function (f) {
        try { if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*'); } catch (e) {}
      });
    }

    function eventAllowed(ev) {
      return flashEvents === 'all' || (Array.isArray(flashEvents) && flashEvents.indexOf(ev) !== -1);
    }
    // Detect clips that appeared since load and hand each to the player as a flash.
    // The player owns the timing (boundary vs immediate) + dedupe + min-gap.
    function detectClips(feed) {
      var flash = window.WccPlayer && window.WccPlayer.flash;
      var firstPass = seenClips === null;
      if (firstPass) seenClips = {};
      ((feed && feed.matches) || []).forEach(function (m) {
        (m.clips || []).forEach(function (c) {
          if (c.id == null || seenClips[c.id]) return;
          seenClips[c.id] = 1;
          if (firstPass || !flash || !c.url || !eventAllowed(c.event)) return;
          flash(buildFlash(m, c));
        });
      });
    }
    // The clip's innings as a 1st/2nd ordinal (mirrors the today's-match reel tab):
    // locate the clip's innings within the match's chronological innings[] by id,
    // falling back to a batting-side name match, then to '' when neither resolves.
    function inningsLabel(m, c) {
      var list = (m && m.innings) || [];
      var idx = -1;
      if (c.innings_id != null) {
        for (var i = 0; i < list.length; i++) {
          if (String(list[i].innings_id) === String(c.innings_id)) { idx = i; break; }
        }
      }
      if (idx < 0 && c.batting_team) {
        for (var j = 0; j < list.length; j++) {
          if ((list[j].side || '').toLowerCase() === c.batting_team.toLowerCase()) { idx = j; break; }
        }
      }
      if (idx < 0) return '';
      return (idx === 0 ? '1st' : idx === 1 ? '2nd' : (idx + 1) + 'th') + ' Innings';
    }
    function buildFlash(m, c) {
      var cfg = cfgById[String(m.pc_id)] || {};
      var isWend = /wendover/i.test(c.batting_team || '');
      // Fixture is always our team vs the opposition (not the batting side), matching
      // the today's-match reel — the square's middle gold/white line.
      return {
        id: c.id, url: c.url, event: c.event, title: c.title,
        over: c.over, ball: c.ball, batter: c.batter, bowler: c.bowler, dismissed: c.dismissed,
        crest: isWend ? (cfg.our_crest || '/assets/images/wcc-logo.png') : (cfg.opp_crest || null),
        innings_label: inningsLabel(m, c),
        team: cfg.team_name || m.home || '',
        opp: cfg.opposition || m.away || '',
      };
    }

    function intervalFor(feed) {
      var ms = (feed && feed.matches) || [];
      if (!ms.length) return IDLE;
      // Fast only while genuinely in play. A decided-but-unfinalised match keeps
      // polling at the SLOW cadence so a scorer correction / finalisation is caught.
      var inPlay = ms.some(function (m) { return (m.phase === 'live' || m.phase === 'break') && !m.complete; });
      return inPlay ? FAST : SLOW;
    }

    function schedule(ms) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, ms);
    }

    function onFail(status) {
      fails++;
      lastStatus = status;
      // Within grace, hold the last good scores (a dropped poll shouldn't blank a
      // live score); past it, broadcast null so the slide shows its reason line.
      var held = fails <= GRACE ? last : null;
      broadcast(held, status);
      onState(held, status);
      schedule(SLOW);
    }

    function poll() {
      if (stopped) return;
      var k = key();
      if (!k) { halt('nokey'); return; }
      var w = windowState();
      // Past midnight (or a day with nothing on) — done, and nothing will reopen
      // it before the next reload picks up a fresh config.
      if (w === 'closed') { halt('closed'); return; }
      // Not yet: re-check without touching the network.
      if (w === 'early') { schedule(window.WccLiveWindow.msUntilOpen(pollWindow)); return; }
      fetch(url(), { headers: { 'Authorization': 'Bearer ' + k } })
        .then(function (r) {
          if (r.status === 403) { halt('forbidden'); return; }
          if (!r.ok) { onFail('error'); return; }
          return r.json().then(function (feed) {
            fails = 0; last = feed; lastStatus = 'ok';
            broadcast(feed, 'ok');
            onState(feed, 'ok');
            detectClips(feed);
            schedule(intervalFor(feed));
          });
        })
        .catch(function () { onFail('offline'); });
    }

    // Answer a slide that loaded mid-interval with the last feed at once, so its
    // first live paint doesn't wait a whole poll cycle. The periodic broadcast is
    // the backstop if the slide loads before the first poll returns.
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.type !== 'wcc-live-request' || !e.source) return;
      try { e.source.postMessage(Object.assign({ type: 'wcc-live', status: lastStatus }, last || {}), '*'); } catch (err) {}
    });

    // Featured-match relay: the ticker announces which match its current segment
    // belongs to, and the other chrome surfaces (the strip's ladder) follow it, so
    // the two never drift onto different games on their own cadences. The parent is
    // just the hub — it holds no opinion about what's featured.
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.type !== 'wcc-featured') return;
      framesOf().forEach(function (f) {
        try { if (f && f.contentWindow && f.contentWindow !== e.source) f.contentWindow.postMessage(d, '*'); } catch (err) {}
      });
    });

    // --- League loop: the day's OTHER matches, polled SLOWLY and broadcast as
    // `wcc-league`. Independent of the WCC loop above — its own cadence, endpoint,
    // cache key and config — because PC-API is result-granularity, not ball-by-ball
    // (see the league-wide-today note). Ticker/strip/today render from it; others
    // ignore it. ------------------------------------------------------------------
    var LEAGUE_MS = opts.leagueMs || 300000;   // 5 min — matches the Worker LEAGUE_TTL
    var leagueEndpoint = opts.leagueEndpoint || endpoint.replace('state.json', 'league.json');
    var leagueConfigUrl = opts.leagueConfigUrl || '/live-league.json';
    var leagueIds = null, leagueLast = null, leagueTimer = null;

    // Pass ?m= the resolved ids (works pre-deploy + shares the Worker cache key);
    // a bare URL only if the config gave us nothing, letting the Worker's own config drive.
    function leagueUrl() {
      if (leagueIds && leagueIds.length)
        return leagueEndpoint + '?' + leagueIds.map(function (m) { return 'm=' + encodeURIComponent(m); }).join('&');
      return leagueEndpoint;
    }
    function leagueBroadcast() {
      var msg = { type: 'wcc-league', matches: (leagueLast && leagueLast.matches) || [] };
      framesOf().forEach(function (f) {
        try { if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*'); } catch (e) {}
      });
    }
    function leaguePoll() {
      if (stopped) return;
      var k = key();
      if (!k) { halt('nokey'); return; }
      // Same window as the WCC loop — the other-games feed is context around our
      // match, so it has no reason to be awake when our match isn't.
      var w = windowState();
      if (w === 'closed') { halt('closed'); return; }
      if (w === 'early') { leagueTimer = setTimeout(leaguePoll, window.WccLiveWindow.msUntilOpen(pollWindow)); return; }
      fetch(leagueUrl(), { headers: { 'Authorization': 'Bearer ' + k } })
        .then(function (r) {
          // Same gate, same verdict — a 403 here stops the WCC loop too, since
          // both feeds sit behind the one token.
          if (r.status === 403) { halt('forbidden'); return null; }
          return r.ok ? r.json() : null;
        })
        .then(function (feed) { if (feed) { leagueLast = feed; leagueBroadcast(); } })
        .catch(function () { /* keep last good; retry next tick */ })
        .then(function () { if (!stopped) leagueTimer = setTimeout(leaguePoll, LEAGUE_MS); });
    }
    // Answer a slide that joins mid-interval with the last league feed at once.
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.type !== 'wcc-league-request' || !e.source) return;
      try { e.source.postMessage({ type: 'wcc-league', matches: (leagueLast && leagueLast.matches) || [] }, '*'); } catch (err) {}
    });
    // Resolve league ids from same-origin config; only start the loop if today has
    // any (no idle polling on a day with no other league games).
    fetch(leagueConfigUrl, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        leagueIds = ((cfg && cfg.matches) || []).map(function (m) { return m.match_id; })
          .filter(function (id) { return id != null; });
      })
      .catch(function () { leagueIds = []; })
      // Wait for the WCC config before the first league poll, so the window is in
      // hand — otherwise a fast league config could fire one request through an
      // as-yet-unknown (and possibly closed) window.
      .then(function () { return cfgReady; })
      .then(function () { if (leagueIds && leagueIds.length) leaguePoll(); });

    // Resolve the poll list AND the poll window from the same-origin config, then
    // start polling. Caller-supplied ids (tests/debug) skip the fetch and so carry
    // no window — deliberate, so an explicit ?pc= isn't silently time-gated.
    // A config that fails to LOAD leaves pollWindow null (no opinion) and falls back
    // to the bare Worker URL, as before: a broken config shouldn't blind the wall on
    // a match day. A config that loads and says "nothing today" closes the window.
    if (pcs && pcs.length) {
      poll();
    } else {
      // Assigned synchronously here, before any league-config callback can run, so
      // the league loop's `return cfgReady` above always sees the real promise.
      cfgReady = fetch(configUrl, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (cfg) {
          if (!cfg) return;
          var ms = cfg.matches || [];
          pcs = ms.map(function (m) { return m.pc_id; }).filter(function (id) { return id != null; });
          ms.forEach(function (m) { if (m.pc_id != null) cfgById[String(m.pc_id)] = m; });
          if (window.WccLiveWindow) pollWindow = window.WccLiveWindow.parse(cfg);
        })
        .catch(function () { /* keep pcs null + window null → bare fallback */ })
        .then(function () { poll(); });
    }
  }
})();

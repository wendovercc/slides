/* live-engine.js — player-owned live-match engine (parent frame only).
 *
 * The single-poller Worker (live.wendovercc.org) already collapses every device
 * to one upstream RV refresh per TTL; this is the *client* half: ONE poll loop
 * per player frame that broadcasts the normalised feed to every slide iframe as
 * a `wcc-live` message. Live-aware slides (the match-day and live-match boards)
 * render from it; the rest
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
    /* WHERE THE FEED COMES FROM, as a seam. Default is the Worker over the network;
     * the match-day simulator supplies its own (live-sim.js), which is the whole
     * reason it can drive the real engine instead of being a parallel mock. Called
     * as transport(kind, url) -> Promise<feed>, kind being 'live' or 'league'; a
     * rejection is treated exactly like a failed fetch.
     *
     * A supplied transport also stands in for the ACCESS GATE, because there is no
     * Worker to authorise against: no key is needed and none is checked. The gate
     * exists to stop unauthorised polls costing Worker invocations, and a simulated
     * poll costs nothing. `manual` then hands the clock over too — the engine polls
     * only when asked, so a key press can step the day forward. */
    var transport = opts.transport || null;
    var manual = !!opts.manual;
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

    /* The EVENT STREAM (see live-events.js). The engine holds the previous poll of
     * each feed and differentiates against it, so every surface downstream is fed
     * the same events rather than each deriving its own. This is the v2 substrate:
     * nothing in the shipping chrome consumes it yet (the ticker and strip still
     * render current state), so it is additive — the inspector slide is its first
     * reader, and it broadcasts as `wcc-events`.
     *
     * The previous snapshots are the point: "what's new" is not a property of a feed,
     * only of two feeds, and only this loop sees both. */
    var prevFeed = null, prevLeague = null;
    var events = window.WccLiveEvents ? WccLiveEvents.store() : null;
    /* EVERY time judgement in the event model reads this, never `Date.now()` directly,
     * so the simulator can freeze and step time independently of data arriving (see
     * live-clock.js). Absent module → the wall clock, exactly as before. */
    function clockNow() { return window.WccClock ? WccClock.now() : Date.now(); }
    // The scheduler is re-asked on this tick as well as on every poll: freshness
    // decays between polls, so a pick can fall below the floor with no new data —
    // see the note on `tick` in live-events.js.
    var EVENT_TICK_MS = opts.eventTickMs || 1000;
    var EVENT_CAP = opts.eventCap || 60;

    function eventBroadcast() {
        if (!events) return;
        var now = clockNow();
        var d = events.tick(now);
        var msg = {
          type: 'wcc-events',
          // The scheduler's verdict: what to show, until when, and why it won.
          showing: d.event || null, until: d.until, holding: !!d.holding, reason: d.reason || null,
          // Its working, for the inspector slide — the ranking IS the algorithm, and
          // being unable to see it is what makes weights impossible to tune. Every
          // row's numbers are live now, the showing one included: it holds its place
          // by still outscoring the rest, so watching it fall is watching the
          // decision that will hand the band on.
          ranked: d.ranked.slice(0, 40).map(function (r) {
            return { id: r.ev.id, score: Math.round(r.score * 10) / 10,
                     freshness: Math.round(r.freshness * 100) / 100,
                     novelty: Math.round(r.novelty * 100) / 100,
                     coverage: Math.round(r.coverage * 100) / 100,
                     superseded: !!r.superseded };
          }),
          // The showing event's own figures, so a band can print them plainly.
          picked: d.picked ? { score: Math.round(d.picked.score * 10) / 10,
                               freshness: Math.round(d.picked.freshness * 100) / 100,
                               novelty: Math.round(d.picked.novelty * 100) / 100,
                               coverage: Math.round(d.picked.coverage * 100) / 100 } : null,
          /* THE TAIL OF THE STORE, NOT ALL OF IT. This message crosses into every
           * slide iframe once a second, and a structured clone of four hundred events
           * five times a second is real work on a Pi. Sixty is comfortably more than
           * any surface renders, and `size` still reports the true total so nothing
           * has to lie about how much it is not showing. */
          events: events.all().slice(-EVENT_CAP), size: events.size(), now: now,
          floor: WccLiveEvents.SHOW_FLOOR,
          // So a surface can say out loud that time is not real — an inspector showing
          // ages against a frozen clock with no sign of it would be quietly misleading.
          clock: clockState()
        };
        framesOf().forEach(function (f) {
          try { if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*'); } catch (e) {}
        });
        // Standalone (the inspector slide opened on its own, the simulator page) there
        // are no child frames; the same message on our own window reaches them.
        try { window.postMessage(msg, '*'); } catch (e) {}
    }
    /* The clock, as the rest of the page needs to hear about it. `advanced` is stable
     * between keypresses — never `skew`, which drifts by the second and would put a
     * moving number on a screen that is supposed to be still.
     *
     * Broadcast as its own message because the surfaces that must go still for a hold
     * (the ticker's segment cycle, the strip's view cycle, the pulsing live dot) do not
     * read the event stream — they render current state and rotate on timers of their
     * own, and a held clock has to stop those too or "held" is a lie about most of the
     * screen. */
    function clockState() {
        /* `isHeld` is manual AND not moving, which is what the surfaces actually want: a
         * simulated day that is RUNNING is time passing, and stopping the ticker's cycle
         * for it would freeze most of the screen for the whole run. Falls back to
         * `isManual` for an older live-clock.js that has no such question — the asset
         * cache can serve this page one (see the asset-cache-skew note). */
        if (!window.WccClock) return { manual: false, advanced: 0 };
        var held = WccClock.isHeld ? WccClock.isHeld() : WccClock.isManual();
        return { manual: held, advanced: Math.round(WccClock.advanced() / 1000) };
    }
    function clockBroadcast() {
        var msg = { type: 'wcc-clock', held: clockState().manual, advanced: clockState().advanced };
        framesOf().forEach(function (f) {
            try { if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*'); } catch (e) {}
        });
        try { window.postMessage(msg, '*'); } catch (e) {}
    }
    // A surface that loads mid-hold asks, rather than sitting animated until the next
    // time the clock happens to change.
    window.addEventListener('message', function (e) {
        var d = e.data;
        if (d && d.type === 'wcc-clock-request') clockBroadcast();
    });

    function ingest(kind, feed) {
        if (!events || !window.WccLiveEvents) return;
        var now = clockNow();
        var cfg = {
          byId: cfgById,
          // The baked division fixtures, so an event about somebody else's match can
          // name the clubs and the ground the lean card never carries.
          leagueById: leagueCfgById,
          /* Lets the extractor's clip join reach back past this poll — footage lags
           * the scorecard, so the wicket it belongs to was extracted a poll or two
           * ago and lives in the store, not in this batch. Newest first, this match
           * only, and only recently enough to plausibly be the same incident. */
          recent: function (matchKey) {
            var cutoff = now - 600000;
            return events.all().filter(function (ev) {
              return ev.match.key === matchKey && ev.received_at >= cutoff;
            }).reverse();
          }
        };
        var found = kind === 'league'
          ? WccLiveEvents.extractLeague(prevLeague, feed, now, cfg)
          : WccLiveEvents.extractLive(prevFeed, feed, now, cfg);
        found.forEach(function (ev) { events.add(ev); });
        if (kind === 'league') prevLeague = feed; else prevFeed = feed;
        eventBroadcast();
        return found;
    }
    /* What `start` hands back: the clock and the stream, for a caller that wants to
     * drive them. The simulator steps `poll`/`pollLeague` from a key press; the
     * inspector reads the store directly when it happens to share this window. Also
     * parked on WccLive so a console (or a page that did not start the engine itself)
     * can reach it. */
    var handle = {
      poll: function () { return poll(); },
      pollLeague: function () { return leaguePoll(); },
      events: events,
      // The seam the strip's ladder will use once it announces committed moves: an
      // event source that is neither of the two feeds.
      addLadderMove: function (move) {
        if (!events || !window.WccLiveEvents) return null;
        var ev = WccLiveEvents.ladderEvent(move, clockNow(), { byId: cfgById });
        if (ev) { events.add(ev); eventBroadcast(); }
        return ev;
      },
      broadcastEvents: eventBroadcast
    };
    window.WccLive.handle = handle;

    if (events) setInterval(eventBroadcast, EVENT_TICK_MS);
    // A time jump changes the answer immediately; waiting up to a tick to say so makes
    // stepping the clock feel broken.
    if (events && window.WccClock) WccClock.onChange(eventBroadcast);
    // Held/released is a separate announcement from "time moved", and every surface
    // needs it, not only the ones reading events.
    if (window.WccClock) WccClock.onChange(clockBroadcast);
    // A surface that loads mid-interval asks, rather than waiting up to a tick.
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (d && d.type === 'wcc-events-request') eventBroadcast();
    });

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
      // A simulated day is whatever day the simulator says it is, so the real poll
      // window has no jurisdiction over it — out of season it would close every run
      // before the first tick.
      if (transport) return 'open';
      return window.WccLiveWindow ? window.WccLiveWindow.state(pollWindow) : 'open';
    }

    // Arm the gate before anything below can poll. The config resolution still
    // runs while stopped — it's same-origin and free, and it leaves pcs/cfgById
    // ready so a key arriving later resumes into a working loop immediately.
    if (!transport && !key()) halt('nokey');
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
      // Manual mode: the caller owns the clock (a key press, a simulator tick), so
      // the engine never schedules itself forward.
      if (manual) return;
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
      // A supplied transport carries its own authorisation story (there is no Worker
      // to authorise against), so it bypasses the key gate entirely — see `transport`.
      if (transport) {
        return Promise.resolve()
          .then(function () { return transport('live', url()); })
          .then(function (feed) {
            if (!feed) { onFail('error'); return; }
            fails = 0; last = feed; lastStatus = 'ok';
            broadcast(feed, 'ok');
            onState(feed, 'ok');
            detectClips(feed);
            ingest('live', feed);
            schedule(intervalFor(feed));
          })
          .catch(function () { onFail('offline'); });
      }
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
            ingest('live', feed);
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

    /* THE FEATURED-MATCH RELAY IS GONE. It carried `wcc-featured` from the ticker to
     * the strip, so the two chrome surfaces could not drift onto different games on
     * their own cadences. Both now render the scheduler's pick from `wcc-events`, so
     * they cannot drift apart in the first place, and a message from one to the other
     * about what it is showing would be a third account of a fact they already share.
     * Removed with the strip's conversion to the event stream. */

    // --- League loop: the day's OTHER matches, polled SLOWLY and broadcast as
    // `wcc-league`. Independent of the WCC loop above — its own cadence, endpoint,
    // cache key and config — because PC-API is result-granularity, not ball-by-ball
    // (see the league-wide-today note). Ticker/strip/boards render from it; others
    // ignore it. ------------------------------------------------------------------
    var LEAGUE_MS = opts.leagueMs || 300000;   // 5 min — matches the Worker LEAGUE_TTL
    var leagueEndpoint = opts.leagueEndpoint || endpoint.replace('state.json', 'league.json');
    var leagueConfigUrl = opts.leagueConfigUrl || '/live-league.json';
    var leagueIds = null, leagueLast = null, leagueTimer = null;
    /* THE BAKED FIXTURE ROW PER LEAGUE MATCH, kept rather than thrown away. This
     * config was already being fetched for its match ids alone, while carrying the
     * club names, the competition and the GROUND — the things the lean PC card does
     * not have and an event describing a match needs to say where it is being
     * played. Same idea as `cfgById` does for our own matches from live-config. */
    var leagueCfgById = {};
    function indexLeagueRows(rows) {
      (rows || []).forEach(function (m) {
        if (m && m.match_id != null) leagueCfgById[String(m.match_id)] = m;
      });
    }

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
      if (transport) {
        return Promise.resolve()
          .then(function () { return transport('league', leagueUrl()); })
          .then(function (feed) {
            if (feed) { leagueLast = feed; leagueBroadcast(); ingest('league', feed); }
          })
          .catch(function () { /* keep last good; the caller will ask again */ })
          .then(function () { if (!stopped && !manual) leagueTimer = setTimeout(leaguePoll, LEAGUE_MS); });
      }
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
        .then(function (feed) { if (feed) { leagueLast = feed; leagueBroadcast(); ingest('league', feed); } })
        .catch(function () { /* keep last good; retry next tick */ })
        .then(function () { if (!stopped) leagueTimer = setTimeout(leaguePoll, LEAGUE_MS); });
    }
    // Answer a slide that joins mid-interval with the last league feed at once.
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.type !== 'wcc-league-request' || !e.source) return;
      try { e.source.postMessage({ type: 'wcc-league', matches: (leagueLast && leagueLast.matches) || [] }, '*'); } catch (err) {}
    });
    /* A SIMULATED DAY skips both config fetches. Neither says anything useful about
     * it — out of season `live-config.json` holds no matches at all, which would
     * leave the engine with an empty poll list and a closed window — and the
     * simulator already knows the day's matches, so it hands the match map straight
     * in. Both loops start at once; in manual mode that first poll is the only one
     * until something asks for the next. */
    if (transport) {
      if (opts.cfgById) cfgById = opts.cfgById;
      cfgReady = Promise.resolve();
      pcs = opts.matches || [];
      leagueIds = opts.leagueMatches || [];
      // A caller supplying its own ids skips the config fetch, so it hands the rows
      // over too when it has them — the simulator does, having read the same file.
      indexLeagueRows(opts.leagueRows);
      poll();
      leaguePoll();
      return handle;
    }

    // Resolve league ids from same-origin config; only start the loop if today has
    // any (no idle polling on a day with no other league games).
    fetch(leagueConfigUrl, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        indexLeagueRows(cfg && cfg.matches);
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
    return handle;
  }
})();

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
    function buildFlash(m, c) {
      var cfg = cfgById[String(m.pc_id)] || {};
      var isWend = /wendover/i.test(c.batting_team || '');
      var opp = cfg.opposition || m.away || '';
      return {
        id: c.id, url: c.url, event: c.event, title: c.title,
        over: c.over, ball: c.ball, batter: c.batter, bowler: c.bowler, dismissed: c.dismissed,
        crest: isWend ? (cfg.our_crest || '/assets/images/wcc-logo.png') : (cfg.opp_crest || null),
        innings_label: c.batting_team || '',
        fixture: cfg.team_name ? (cfg.team_name + ' v ' + opp) : ((m.home || '') + ' v ' + (m.away || '')),
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
      var k = key();
      fetch(url(), { headers: k ? { 'Authorization': 'Bearer ' + k } : {} })
        .then(function (r) {
          if (!r.ok) { onFail(r.status === 403 ? 'forbidden' : 'error'); return; }
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

    // Resolve the poll list from the same-origin config (unless the caller passed
    // ids explicitly), then start polling. A failed/empty config still starts the
    // loop — poll() falls back to the bare Worker URL and idles if there's nothing.
    if (pcs && pcs.length) {
      poll();
    } else {
      fetch(configUrl, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (cfg) {
          var ms = (cfg && cfg.matches) || [];
          pcs = ms.map(function (m) { return m.pc_id; }).filter(function (id) { return id != null; });
          ms.forEach(function (m) { if (m.pc_id != null) cfgById[String(m.pc_id)] = m; });
        })
        .catch(function () { /* keep pcs null → bare fallback */ })
        .then(function () { poll(); });
    }
  }
})();

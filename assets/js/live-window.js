/* live-window.js — "should anything be polling the live feed right now?"
 *
 * The daily build bakes a poll window into live-config.json (see live_poll_window
 * in build.py): open shortly before the day's first start, closed at midnight.
 * Every client that touches live.wendovercc.org gates on it — the player's engine
 * and the two standalone slide views — so this lives in one file rather than being
 * reimplemented three times.
 *
 * Two things it buys us:
 *   1. No polling before there's anything to poll (or on a day with no cricket).
 *   2. A self-closing window. If the nightly build fails, the config goes stale —
 *      but a stale config's window ended at ITS midnight, so clients stop on their
 *      own rather than polling on until the next successful build.
 *
 * Times are naive-local ISO ("2026-08-08T11:30"). `new Date()` reads an offset-less
 * date-time as local, which is what we want: the wall's own clock decides.
 */
(function () {
  function parseLocal(s) {
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // cfg → { from, until, matches } with Date|null bounds. A config with no window
  // baked (an older build) yields nulls, which `state` treats as "no opinion".
  function parse(cfg) {
    return {
      from: parseLocal(cfg && cfg.poll_from),
      until: parseLocal(cfg && cfg.poll_until),
      matches: (cfg && cfg.matches) || [],
    };
  }

  // 'open'   — poll now
  // 'early'  — nothing on yet; sleep until `from` (no network)
  // 'closed' — past midnight, or a day with no matches; stop for good
  function state(win, now) {
    now = now || new Date();
    if (!win) return 'open';
    // A window-less config from a day with no matches is closed, not open: the
    // build says there is nothing to poll. Only a config that never carried a
    // window at all (no `until` AND matches present) gets the benefit of the doubt.
    if (!win.until) return win.matches.length ? 'open' : 'closed';
    if (now >= win.until) return 'closed';
    if (win.from && now < win.from) return 'early';
    return 'open';
  }

  // How long to sleep before re-checking an 'early' window. Capped so we re-read
  // the clock periodically instead of trusting one very long timer across a
  // suspend/resume or a clock correction.
  function msUntilOpen(win, now, cap) {
    now = now || new Date();
    cap = cap || 900000;   // 15 min
    if (!win || !win.from) return cap;
    return Math.max(0, Math.min(win.from - now, cap));
  }

  window.WccLiveWindow = { parse: parse, state: state, msUntilOpen: msUntilOpen };
})();

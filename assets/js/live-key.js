/* live-key.js — the live-feed access key, and the two ways it gets onto a device.
 *
 * The live proxy (live.wendovercc.org) is gated by a bearer token so only devices
 * WE control can consume the feed — the site itself is public on GitHub Pages, so
 * the token must NOT ship in the build. It lives in localStorage under `wccLiveKey`
 * (the engine + standalone slides read it there) and gets there one of two ways:
 *
 *   1. Interactive — the Settings cog on the home page (WccLiveKey.set), for the
 *      bar iPad or any device with a keyboard.
 *   2. Non-interactive — a `?k=<token>` on the page URL, captured here into
 *      localStorage and then stripped from the address bar. This is how the Pi
 *      walls provision: the token sits in each Pi's `~/.kiosk_url` (off-repo), so
 *      every boot re-seeds the key — self-healing even after a profile wipe.
 *
 * Both write the same key, so it's set-once and sticky on every device. Load this
 * BEFORE the live engine (it captures synchronously on parse).
 */
(function () {
  var KEY = 'wccLiveKey';
  var PARAM = 'k';

  function get() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function set(v) {
    try {
      v = String(v == null ? '' : v).trim();
      if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY);
      return true;
    } catch (e) { return false; }
  }
  function clear() { try { localStorage.removeItem(KEY); return true; } catch (e) { return false; } }

  // Capture ?k=<token> into localStorage and strip it from the URL so the token
  // isn't left sitting in the address bar / referrer. Only same-page rewrite — no
  // reload. Returns true if a (non-empty) token was captured.
  function capture() {
    var params, token;
    try { params = new URLSearchParams(window.location.search); }
    catch (e) { return false; }
    if (!params.has(PARAM)) return false;
    token = (params.get(PARAM) || '').trim();
    if (token) set(token);
    // Strip it whether empty or not (an explicit ?k= with no value = "clear-ish"
    // noise we don't want lingering). Preserve every other param + the hash.
    params.delete(PARAM);
    var qs = params.toString();
    var url = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
    try { window.history.replaceState(null, '', url); } catch (e) {}
    return !!token;
  }

  capture();

  window.WccLiveKey = { get: get, set: set, clear: clear, capture: capture, storageKey: KEY };
})();

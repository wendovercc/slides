/* preload-gate.js — the hard loading gate, shared by both players.
 *
 * Shows a branded "Preparing slideshow" screen, primes every clip into the video
 * cache (with retry/backoff + progress) and waits for the slide iframes to load,
 * then fades out. Nothing the caller reveals plays until this resolves — so the
 * rotation never opens on an un-primed clip or a cold shell. One code path on the
 * Pi walls and the bar iPad alike. See docs/player-offline-architecture.md.
 *
 * WccPreloadGate.run({ videos, frames, iframeTimeoutMs, maxGateMs })
 *   → Promise<{ failed: Set<url>, timedOut: bool }>
 *
 * The caller owns what to do with `failed`: drop those slides from the rotation
 * (they fall back to the network clip, and a later refresh restores them). Self-
 * contained: injects its own styles, reuses WccVideoCache for the store.
 */
(function () {
  var STYLE_ID = 'wcc-preload-style';
  var FONT = "/assets/fonts/lato-latin-";
  var CSS =
    "@font-face{font-family:'Lato';font-style:normal;font-weight:400;font-display:swap;src:url('" + FONT + "400-normal.woff2') format('woff2');}" +
    "@font-face{font-family:'Lato';font-style:normal;font-weight:700;font-display:swap;src:url('" + FONT + "700-normal.woff2') format('woff2');}" +
    "@font-face{font-family:'Lato';font-style:normal;font-weight:900;font-display:swap;src:url('" + FONT + "900-normal.woff2') format('woff2');}" +
    "#preload{position:fixed;inset:0;z-index:1000;background:linear-gradient(165deg,#0f2346 0%,#0a1c3a 100%);" +
    "display:flex;align-items:center;justify-content:center;font-family:'Lato',-apple-system,Arial,sans-serif;color:#fff;transition:opacity .6s ease;}" +
    "#preload.done{opacity:0;pointer-events:none;}" +
    ".preload-inner{display:flex;flex-direction:column;align-items:center;gap:3.4vh;width:40vw;max-width:640px;text-align:center;}" +
    ".preload-logo{width:16vh;height:auto;object-fit:contain;}" +
    ".preload-title{font-size:3vh;font-weight:900;letter-spacing:.02em;}" +
    ".preload-bar{width:100%;height:1vh;background:rgba(212,175,55,.18);border-radius:1vh;overflow:hidden;}" +
    ".preload-bar i{display:block;height:100%;width:100%;background:#d4af37;transform-origin:left;transform:scaleX(0);transition:transform .3s ease;}" +
    ".preload-readout{font-size:1.8vh;color:#b4c8e4;letter-spacing:.02em;}" +
    ".preload-status{font-size:1.6vh;color:#d4af37;min-height:1.6vh;opacity:0;transition:opacity .4s ease;}";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function buildScreen() {
    injectStyle();
    var el = document.createElement('div');
    el.id = 'preload';
    el.innerHTML =
      '<div class="preload-inner">' +
      '<img class="preload-logo" src="/assets/images/wcc-logo.png" alt="">' +
      '<div class="preload-title">Preparing slideshow</div>' +
      '<div class="preload-bar"><i></i></div>' +
      '<div class="preload-readout"></div>' +
      '<div class="preload-status"></div>' +
      '</div>';
    document.body.appendChild(el);
    var fill = el.querySelector('.preload-bar i');
    var readout = el.querySelector('.preload-readout');
    var status = el.querySelector('.preload-status');
    return {
      update: function (p) {
        var total = p.total || 0, done = p.done || 0, bytes = p.bytes || 0;
        fill.style.transform = 'scaleX(' + (total ? done / total : 1) + ')';
        if (total) {
          var mb = bytes / 1048576;
          readout.textContent = done + ' / ' + total + ' clips · ' + mb.toFixed(mb < 10 ? 1 : 0) + ' MB';
        } else {
          readout.textContent = '';
        }
        status.textContent = p.waiting ? 'Waiting for network…' : '';
        status.style.opacity = p.waiting ? '1' : '0';
      },
      hide: function () {
        el.classList.add('done');
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 700);
      }
    };
  }

  // Resolve once an iframe has loaded: immediately if it's already complete (the
  // load event may have fired before we attached), on 'load', or after timeoutMs so
  // one stuck slide never wedges the gate.
  function frameLoaded(f, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      function done() { if (!settled) { settled = true; resolve(); } }
      try {
        if (f.contentDocument && f.contentDocument.readyState === 'complete') { done(); return; }
      } catch (e) {}
      f.addEventListener('load', done);
      setTimeout(done, timeoutMs);
    });
  }

  function run(opts) {
    opts = opts || {};
    var videos = opts.videos || [];
    var frames = opts.frames || [];
    var iframeTimeoutMs = opts.iframeTimeoutMs || 20000;
    var maxGateMs = opts.maxGateMs || 120000;

    var screen = buildScreen();
    screen.update({ done: 0, total: videos.length, bytes: 0, waiting: false });

    var primeResult = { stored: [], failed: videos.slice() };
    var primeP = (window.WccVideoCache && WccVideoCache.supported)
      ? WccVideoCache.primeWithRetry(videos, { onProgress: screen.update }).then(function (r) { primeResult = r; })
      : Promise.resolve();
    var framesP = Promise.all(frames.map(function (f) { return frameLoaded(f, iframeTimeoutMs); }));

    var readyP = Promise.all([primeP, framesP]).then(function () { return 'ready'; });
    var capP = new Promise(function (res) { setTimeout(function () { res('timeout'); }, maxGateMs); });

    return Promise.race([readyP, capP]).then(function (outcome) {
      screen.hide();
      // On a timeout we drop nothing (show everything best-effort); only a clean
      // finish trusts the failed set.
      return {
        failed: new Set(outcome === 'ready' ? primeResult.failed : []),
        timedOut: outcome === 'timeout'
      };
    });
  }

  window.WccPreloadGate = { run: run };
})();

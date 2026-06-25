/* player-core.js — shared slideshow engine for both players
 * (screen/player.html and slideshow/player.html).
 *
 * Modes (from URL):
 *   ?kiosk / default  — hands-free TV. Slides auto-rotate themselves; the player
 *                       advances whole slides after their derived duration.
 *                       No controls, no touch. Behaviour unchanged from before.
 *   ?interactive      — touch surface (the bar iPad). The player owns a single
 *                       per-panel timer, drives carousel tabs over the slide
 *                       bridge, and renders a control bar.
 *
 * Usage:
 *   WccPlayer.start({
 *     items: [{ slug, duration, panel_duration, frame }],  // ordered, frame = iframe el
 *     onShow: function(index) {}                            // optional (preview hook)
 *   });
 */
(function () {
  var SVG = {
    home: '<path d="M3 11l9-8 9 8" /><path d="M5 10v9h14v-9" />',
    prev: '<path d="M16 5v14l-9-7z" /><rect x="5" y="5" width="2" height="14" />',
    next: '<path d="M8 5v14l9-7z" /><rect x="17" y="5" width="2" height="14" />',
    play: '<path d="M7 5v14l12-7z" />',
    pause: '<rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" />'
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + SVG[name] + '</svg>';
  }

  function injectStyles() {
    var css =
      // Interactive mode is touch/pointer-driven: keep the cursor visible
      // (overrides the kiosk `cursor:none` on both player and slide bases).
      'html,body{cursor:auto!important;}' +
      '#wcc-tap{position:fixed;inset:0;z-index:50;cursor:default;}' +
      '#wcc-bar{position:fixed;left:50%;bottom:max(3vh,env(safe-area-inset-bottom,0px));' +
      'transform:translateX(-50%);z-index:60;display:flex;gap:8px;padding:8px;' +
      'background:rgba(10,28,58,0.82);border:1px solid rgba(212,175,55,0.45);' +
      'border-radius:999px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
      'box-shadow:0 6px 24px rgba(0,0,0,0.45);}' +
      '#wcc-bar button{width:60px;height:60px;border:none;border-radius:50%;background:transparent;' +
      'color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;}' +
      '#wcc-bar button:active{background:rgba(255,255,255,0.12);}' +
      '#wcc-bar button.primary{background:rgba(212,175,55,0.18);}' +
      '#wcc-bar button.primary:active{background:rgba(212,175,55,0.32);}' +
      '#wcc-bar svg{width:30px;height:30px;fill:#fff;stroke:#fff;stroke-width:2;' +
      'stroke-linejoin:round;stroke-linecap:round;}' +
      '#wcc-bar button.primary svg{fill:#d4af37;stroke:#d4af37;}';
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  window.WccPlayer = { start: start };

  function start(opts) {
    var items = opts.items || [];
    var onShow = opts.onShow || function () {};
    if (items.length === 0) return;

    var params = new URLSearchParams(location.search);
    var interactive = params.has('interactive');

    var n = items.length;
    var current = 0;
    var counts = items.map(function () { return null; }); // panel count per item
    var panelIndex = 0;
    var playing = true;
    var timer = null;
    var shownAt = 0;

    function frameWin(i) { return items[i].frame.contentWindow; }
    function send(i, action, extra) {
      try { frameWin(i).postMessage(Object.assign({ type: 'wcc-cmd', action: action }, extra || {}), '*'); }
      catch (e) {}
    }
    function activate(i) {
      items.forEach(function (it, j) { it.frame.classList.toggle('active', j === i); });
      current = i;
      shownAt = Date.now();
      onShow(i);
    }
    function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }

    /* ---- kiosk: whole-slide rotation, slides auto-rotate their own panels ----
     * Every slide's iframe loads at startup and begins auto-rotating its panels
     * immediately. So when a multi-panel slide finally comes on screen its panels
     * are mid-cycle. Tell the outgoing slide to stop and the incoming one to
     * rotate afresh from panel 0, so each slide's rotation is anchored to when it
     * actually becomes visible. */
    function kioskShow(i) {
      if (i !== current) send(current, 'take-over'); // stop the slide we're leaving
      activate(i);
      send(i, 'restart-auto');                       // rotate from panel 0, aligned to now
      clearTimer();
      timer = setTimeout(function () { kioskShow((current + 1) % n); }, (items[i].duration || 20) * 1000);
    }
    function kioskGo(delta) { kioskShow((current + delta + n) % n); }

    /* ---- interactive: player owns the per-panel timer ---- */
    function panelTimer() {
      clearTimer();
      timer = setTimeout(function () {
        var count = counts[current] || 1;
        if (panelIndex < count - 1) {
          send(current, 'next-panel'); // echo updates panelIndex
        } else {
          fwdSlide();
        }
      }, (items[current].panel_duration || 20) * 1000);
    }
    function applyState(panel) {
      var i = current;
      send(i, 'take-over');
      if (playing) {
        panelIndex = 0;
        send(i, 'reset');
        panelTimer();
      } else {
        send(i, 'pause');
        var idx = panel === 'last' ? (counts[i] != null ? counts[i] - 1 : 9999) : (panel || 0);
        send(i, 'goto-panel', { index: idx });
      }
    }
    function interShow(i, panel) { activate(i); applyState(panel); }
    function fwdSlide() { interShow((current + 1) % n, 0); }
    function backSlide() { interShow((current - 1 + n) % n, 'last'); }

    function setPlaying(p) {
      playing = p;
      updatePlayBtn();
      if (p) { send(current, 'resume'); panelTimer(); }
      else { clearTimer(); send(current, 'pause'); }
    }
    function next() {
      if (playing) setPlayingSilent(false);
      if (panelIndex < (counts[current] || 1) - 1) send(current, 'next-panel');
      else fwdSlide();
    }
    function prev() {
      if (playing) setPlayingSilent(false);
      if (panelIndex > 0) send(current, 'prev-panel');
      else backSlide();
    }
    // pause without sending resume/extra (used right before a manual step)
    function setPlayingSilent(p) {
      playing = p; updatePlayBtn(); clearTimer();
      if (!p) send(current, 'pause');
    }

    /* ---- control bar ---- */
    var playBtn = null;
    function updatePlayBtn() {
      if (playBtn) playBtn.innerHTML = icon(playing ? 'pause' : 'play');
    }
    function button(name, cls, handler) {
      var b = document.createElement('button');
      if (cls) b.className = cls;
      b.innerHTML = icon(name);
      b.addEventListener('click', function (e) { e.stopPropagation(); handler(); });
      return b;
    }
    function buildControls() {
      injectStyles();
      var tap = document.createElement('div');
      tap.id = 'wcc-tap';
      tap.addEventListener('click', function () { setPlaying(!playing); });
      document.body.appendChild(tap);

      var bar = document.createElement('div');
      bar.id = 'wcc-bar';
      bar.appendChild(button('home', '', function () { location.href = '/'; }));
      bar.appendChild(button('prev', '', prev));
      playBtn = button('pause', 'primary', function () { setPlaying(!playing); });
      bar.appendChild(playBtn);
      bar.appendChild(button('next', '', next));
      document.body.appendChild(bar);
      updatePlayBtn();
    }

    /* ---- bridge messages from slides ---- */
    window.addEventListener('message', function (e) {
      if (!interactive) return;
      var d = e.data; if (!d) return;
      var idx = items.findIndex(function (it) { return it.frame.contentWindow === e.source; });
      if (idx < 0) return;
      if (d.type === 'wcc-slide') {
        var first = counts[idx] == null;
        counts[idx] = d.panels;
        // Re-apply state on the current slide's handshake (covers the load race
        // where our first commands arrived before the bridge was listening).
        if (idx === current && first && Date.now() - shownAt < 2000) applyState(playing ? 0 : panelIndex);
      } else if (d.type === 'wcc-panel' && idx === current) {
        panelIndex = d.panel;
      }
    });

    /* ---- keyboard ---- */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { interactive ? next() : kioskGo(1); }
      else if (e.key === 'ArrowLeft') { interactive ? prev() : kioskGo(-1); }
    });

    /* ---- go ---- */
    if (interactive) {
      buildControls();
      interShow(0, 0);
    } else {
      kioskShow(0);
    }
  }
})();

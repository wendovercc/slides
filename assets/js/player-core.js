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
      // Docked to the top, centred on the content column (the viewport minus the
      // 20vw sidebar → 40vw), so it reads as centred over the slide rather than
      // pushed right by the sidebar. It sits in the gap between the title/subtitle
      // (left) and the set-meta (right), extending a touch below --safe-y without
      // covering content (the strip sits lower). Flush to the top edge: no top
      // border, only a slight corner round.
      '#wcc-bar{position:fixed;top:0;left:40vw;' +
      'transform:translateX(-50%);z-index:60;display:flex;gap:0.25vw;padding:0.3vw 0.25vw;' +
      'background:rgba(10,28,58,0.82);border:1px solid rgba(212,175,55,0.45);border-top:none;' +
      'border-radius:0 0 0.4vw 0.4vw;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
      'box-shadow:0 0.6vh 2.4vh rgba(0,0,0,0.45);overflow:hidden;}' +
      '#wcc-bar button{width:2.3vw;height:2.3vw;border:none;border-radius:50%;background:transparent;' +
      'color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;}' +
      '#wcc-bar button:active{background:rgba(255,255,255,0.12);}' +
      '#wcc-bar button.primary{background:rgba(212,175,55,0.18);}' +
      '#wcc-bar button.primary:active{background:rgba(212,175,55,0.32);}' +
      '#wcc-bar svg{width:1.15vw;height:1.15vw;fill:#fff;stroke:#fff;stroke-width:2;' +
      'stroke-linejoin:round;stroke-linecap:round;}' +
      '#wcc-bar button.primary svg{fill:#d4af37;stroke:#d4af37;}' +
      // Countdown for the current panel/slide. The wall's tab underline no longer
      // fills, so the timer lives here — visible only while the control bar is.
      '#wcc-bar-progress{position:absolute;left:0;right:0;bottom:0;height:0.22vw;' +
      'background:rgba(212,175,55,0.16);}' +
      '#wcc-bar-progress i{display:block;height:100%;background:#d4af37;' +
      'transform-origin:left;transform:scaleX(0);}';
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
    var progressFill = null; // control-bar countdown fill (interactive only)

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

    /* Control-bar countdown. Mirrors the interactive per-panel timer: fills over
     * the dwell while playing, freezes where it is on pause, empties on nav. All
     * no-ops until the bar exists, so kiosk (the wall) shows nothing. */
    function progressRun(ms) {
      if (!progressFill) return;
      progressFill.style.transition = 'none';
      progressFill.style.transform = 'scaleX(0)';
      void progressFill.offsetWidth;                    // reflow → restart from empty
      progressFill.style.transition = 'transform ' + ms + 'ms linear';
      progressFill.style.transform = 'scaleX(1)';
    }
    function progressReset() {
      if (!progressFill) return;
      progressFill.style.transition = 'none';
      progressFill.style.transform = 'scaleX(0)';
    }
    function progressFreeze() {
      if (!progressFill) return;
      var t = getComputedStyle(progressFill).transform; // matrix at current width
      progressFill.style.transition = 'none';
      progressFill.style.transform = (t && t !== 'none') ? t : 'scaleX(0)';
    }

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
      timer = setTimeout(function () {
        var next = (current + 1) % n;
        if (next === 0 && opts.shouldReloadNow && opts.shouldReloadNow()) { location.reload(); return; }
        kioskShow(next);
      }, (items[i].duration || 20) * 1000);
    }
    function kioskGo(delta) { kioskShow((current + delta + n) % n); }

    /* ---- interactive: player owns the per-panel timer ---- */
    function panelTimer() {
      clearTimer();
      var ms = (items[current].panel_duration || 20) * 1000;
      progressRun(ms);
      timer = setTimeout(function () {
        var count = counts[current] || 1;
        if (panelIndex < count - 1) {
          send(current, 'next-panel'); // echo updates panelIndex
          panelTimer();                // re-arm for the next panel (restarts the fill)
        } else {
          fwdSlide();
        }
      }, ms);
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
        progressReset();
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
      else { clearTimer(); send(current, 'pause'); progressFreeze(); }
    }
    // Manual nav preserves the play/pause state (so a paused wall stays paused
    // when you step across slides, including between slide-set members). When
    // playing, the per-panel timer restarts; when paused, applyState re-pauses
    // the incoming slide.
    function next() {
      clearTimer();
      if (panelIndex < (counts[current] || 1) - 1) {
        send(current, 'next-panel');
        if (playing) panelTimer(); else progressReset();
      } else {
        fwdSlide();
      }
    }
    function prev() {
      clearTimer();
      if (panelIndex > 0) {
        send(current, 'prev-panel');
        if (playing) panelTimer(); else progressReset();
      } else {
        backSlide();
      }
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
      var prog = document.createElement('div');
      prog.id = 'wcc-bar-progress';
      progressFill = document.createElement('i');
      prog.appendChild(progressFill);
      bar.appendChild(prog);
      document.body.appendChild(bar);
      updatePlayBtn();
    }

    /* ---- bridge messages from slides ---- */
    window.addEventListener('message', function (e) {
      var d = e.data; if (!d) return;
      var idx = items.findIndex(function (it) { return it.frame.contentWindow === e.source; });
      if (idx < 0) return;

      // wcc-done: video ended naturally — advance slide (works in both kiosk and interactive)
      if (d.type === 'wcc-done' && idx === current) {
        if (interactive) {
          if (playing) fwdSlide(); // paused → hold last frame until user acts
        } else {
          clearTimer();
          var next = (current + 1) % n;
          if (next === 0 && opts.shouldReloadNow && opts.shouldReloadNow()) { location.reload(); return; }
          kioskShow(next);
        }
        return;
      }

      if (!interactive) return;
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

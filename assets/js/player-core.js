/* player-core.js — shared slideshow engine for both players
 * (screen/player.html and slideshow/player.html).
 *
 * Modes (from URL):
 *   ?kiosk / default  — hands-free TV. Slides auto-rotate themselves; the player
 *                       advances whole slides after their derived duration.
 *                       No controls, no touch. Behaviour unchanged from before.
 *   ?interactive      — touch surface (the bar iPad / phones). The player owns a
 *                       single per-panel timer, drives carousel tabs over the
 *                       slide bridge, and renders an auto-hiding control bar.
 *                       Input: horizontal swipe = prev/next, tap = toggle the bar
 *                       (record mode, future, will remap tap → advance); keyboard
 *                       arrows/Space/Home/End/f; fullscreen where supported.
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
    pause: '<rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" />',
    // Stroke-only corner brackets (rendered with fill:none via the .fs button class).
    expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" />',
    compress: '<path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" />'
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + SVG[name] + '</svg>';
  }

  function injectStyles() {
    var css =
      // Interactive mode is touch/pointer-driven: keep the cursor visible
      // (overrides the kiosk `cursor:none` on both player and slide bases).
      'html,body{cursor:auto!important;}' +
      // touch-action:none so a horizontal drag reaches our swipe handler instead
      // of being eaten by the browser's scroll / pull-to-refresh.
      '#wcc-tap{position:fixed;inset:0;z-index:50;cursor:default;touch-action:none;}' +
      // Docked to the top edge of the whole viewport and centred on the full
      // screen (not the content column). With the players now letterboxing the
      // 16:9 slide, a non-16:9 surface (the iPad, desktop windows) leaves a black
      // band above the slide — the bar lives in that band, clear of slide content,
      // rather than overlapping the title/set-meta row. Targets are sized for
      // touch. Flush to the top edge: no top border, only a slight corner round.
      // Sized in vmax (the longer viewport edge) not vw, so the targets stay the
      // same physical size in portrait and landscape — vw would shrink them in
      // portrait, where the width is the short edge. Only left:50vw (true
      // horizontal centring on the viewport width) stays in vw.
      '#wcc-bar{position:fixed;top:0;left:50vw;' +
      'transform:translateX(-50%);z-index:60;display:flex;gap:0.6vmax;padding:0.7vmax 0.6vmax;' +
      'background:rgba(10,28,58,0.82);border:1px solid rgba(212,175,55,0.45);border-top:none;' +
      'border-radius:0 0 0.6vmax 0.6vmax;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
      'box-shadow:0 0.6vh 2.4vh rgba(0,0,0,0.45);overflow:hidden;' +
      'transition:opacity 0.3s ease,transform 0.3s ease;}' +
      // Auto-hidden state: slide the bar up out of the top band. Keeps the same
      // translateX(-50%) centring so it re-enters from where it lives.
      '#wcc-bar.hidden{opacity:0;pointer-events:none;' +
      'transform:translateX(-50%) translateY(calc(-100% - 0.6vh));}' +
      // Faint grab-handle occupying the bar's slot while it is hidden; a tap on it
      // (or anywhere on the slide) brings the bar back. Padded for a touch target.
      '#wcc-handle{position:fixed;top:0;left:50vw;transform:translateX(-50%);z-index:60;' +
      'padding:0.9vmax 2vmax 1.1vmax;display:flex;justify-content:center;cursor:pointer;' +
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:opacity 0.3s ease;}' +
      '#wcc-handle::before{content:"";width:6vmax;height:0.5vmax;border-radius:0.5vmax;' +
      'background:rgba(212,175,55,0.55);}' +
      '#wcc-handle.hidden{opacity:0;pointer-events:none;}' +
      '#wcc-bar button{width:4.7vmax;height:4.7vmax;border:none;border-radius:50%;background:transparent;' +
      'color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;}' +
      '#wcc-bar button:active{background:rgba(255,255,255,0.12);}' +
      '#wcc-bar button.primary{background:rgba(212,175,55,0.18);}' +
      '#wcc-bar button.primary:active{background:rgba(212,175,55,0.32);}' +
      '#wcc-bar svg{width:2.35vmax;height:2.35vmax;fill:#fff;stroke:#fff;stroke-width:2;' +
      'stroke-linejoin:round;stroke-linecap:round;}' +
      '#wcc-bar button.primary svg{fill:#d4af37;stroke:#d4af37;}' +
      // Fullscreen glyph is drawn as outlined corner brackets, not a filled shape.
      '#wcc-bar button.fs svg{fill:none;}' +
      // Countdown for the current panel/slide. The wall's tab underline no longer
      // fills, so the timer lives here — visible only while the control bar is.
      '#wcc-bar-progress{position:absolute;left:0;right:0;bottom:0;height:0.35vmax;' +
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
    var bar = null;          // control bar (interactive only)
    var handle = null;       // faint grab-handle shown when the bar is auto-hidden
    var hideTimer = null;    // idle auto-hide timer
    var barVisible = true;
    var mode = 'watch';      // gesture dispatch mode; 'record' (future) remaps tap → advance

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
        if (next === 0 && opts.shouldReloadNow && opts.shouldReloadNow()) { if (opts.onReload) opts.onReload(); else location.reload(); return; }
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
      // Back-nav asks for the incoming slide's last panel; honour it whether
      // playing or paused (previously the playing path always reset to panel 0,
      // so stepping back into a multi-clip reel jumped to the first clip).
      var last = panel === 'last' && counts[i] != null ? counts[i] - 1 : null;
      if (playing) {
        if (last != null) { panelIndex = last; send(i, 'goto-panel', { index: last }); }
        else { panelIndex = 0; send(i, 'reset'); }
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
    function goFirst() { interShow(0, 0); }
    function goLast() { interShow(n - 1, 0); }

    function setPlaying(p) {
      playing = p;
      updatePlayBtn();
      if (p) { send(current, 'resume'); panelTimer(); }
      else { clearTimer(); send(current, 'pause'); progressFreeze(); }
      revealBar(); // surface the state change; auto-hide re-arms only while playing
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

    /* ---- control-bar visibility: auto-hide ~3s after the last interaction while
     * playing, reveal on any interaction, stay pinned open while paused. All
     * no-ops in kiosk (no bar exists). ---- */
    function clearHideTimer() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
    function scheduleHide() { clearHideTimer(); if (!bar || !playing) return; hideTimer = setTimeout(hideBar, 3000); }
    function showBar() { if (!bar) return; bar.classList.remove('hidden'); if (handle) handle.classList.add('hidden'); barVisible = true; }
    function hideBar() { if (!bar) return; clearHideTimer(); bar.classList.add('hidden'); if (handle) handle.classList.remove('hidden'); barVisible = false; }
    function revealBar() { showBar(); scheduleHide(); }
    function toggleBar() { barVisible ? hideBar() : revealBar(); }

    /* Gesture dispatch (mode-aware). Watch: a tap toggles the bar, a horizontal
     * swipe steps slides. Record (future) will remap tap → advance. */
    function onTap() { if (mode === 'record') next(); else toggleBar(); }
    function onSwipe(dir) { (dir === 'next' ? next : prev)(); revealBar(); }

    /* Fullscreen. The API is absent on iPhone Safari (video-only there), so the
     * button is only added when supported; this stays a safe no-op regardless. */
    function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement; }
    function toggleFullscreen() {
      var el = document.documentElement;
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      try { if (!fsElement()) { if (req) req.call(el); } else if (exit) exit.call(document); } catch (e) {}
    }

    /* ---- control bar ---- */
    var playBtn = null;
    var fsBtn = null;
    function updatePlayBtn() {
      if (playBtn) playBtn.innerHTML = icon(playing ? 'pause' : 'play');
    }
    function updateFsBtn() {
      if (fsBtn) fsBtn.innerHTML = icon(fsElement() ? 'compress' : 'expand');
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

      // Full-surface gesture layer. A horizontal swipe steps slides; a clean tap
      // toggles the control bar. Movement + time thresholds keep a tap and a swipe
      // from firing each other (a drag never counts as a tap, and vice versa).
      var tap = document.createElement('div');
      tap.id = 'wcc-tap';
      var TAP_SLOP = 10, TAP_MAX_MS = 500, SWIPE_MIN = 45;
      var gp = null;
      tap.addEventListener('pointerdown', function (e) {
        gp = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
      });
      tap.addEventListener('pointerup', function (e) {
        if (!gp || e.pointerId !== gp.id) return;
        var dx = e.clientX - gp.x, dy = e.clientY - gp.y, dt = Date.now() - gp.t;
        gp = null;
        var adx = Math.abs(dx), ady = Math.abs(dy);
        if (adx > SWIPE_MIN && adx > ady * 1.5) { onSwipe(dx < 0 ? 'next' : 'prev'); }
        else if (adx < TAP_SLOP && ady < TAP_SLOP && dt < TAP_MAX_MS) { onTap(); }
      });
      tap.addEventListener('pointercancel', function () { gp = null; });
      document.body.appendChild(tap);

      bar = document.createElement('div');
      bar.id = 'wcc-bar';
      bar.addEventListener('pointerdown', revealBar); // any bar touch keeps it up
      bar.appendChild(button('home', '', function () { location.href = '/'; }));
      bar.appendChild(button('prev', '', prev));
      playBtn = button('pause', 'primary', function () { setPlaying(!playing); });
      bar.appendChild(playBtn);
      bar.appendChild(button('next', '', next));
      var docEl = document.documentElement;
      if (docEl.requestFullscreen || docEl.webkitRequestFullscreen) {
        fsBtn = button('expand', 'fs', function () { toggleFullscreen(); revealBar(); });
        bar.appendChild(fsBtn);
        document.addEventListener('fullscreenchange', updateFsBtn);
        document.addEventListener('webkitfullscreenchange', updateFsBtn);
      }
      var prog = document.createElement('div');
      prog.id = 'wcc-bar-progress';
      progressFill = document.createElement('i');
      prog.appendChild(progressFill);
      bar.appendChild(prog);
      document.body.appendChild(bar);

      handle = document.createElement('div');
      handle.id = 'wcc-handle';
      handle.className = 'hidden'; // bar starts visible, so the handle starts hidden
      handle.addEventListener('pointerdown', function (e) { e.stopPropagation(); revealBar(); });
      document.body.appendChild(handle);

      updatePlayBtn();
      revealBar(); // show now, then arm the idle auto-hide
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
          if (next === 0 && opts.shouldReloadNow && opts.shouldReloadNow()) { if (opts.onReload) opts.onReload(); else location.reload(); return; }
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
      if (e.key === 'ArrowRight') { if (interactive) { next(); revealBar(); } else kioskGo(1); return; }
      if (e.key === 'ArrowLeft')  { if (interactive) { prev(); revealBar(); } else kioskGo(-1); return; }
      if (!interactive) return;
      if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); setPlaying(!playing); }
      else if (e.key === 'Home') { e.preventDefault(); goFirst(); revealBar(); }
      else if (e.key === 'End')  { e.preventDefault(); goLast(); revealBar(); }
      else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); revealBar(); }
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

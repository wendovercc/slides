/* slide-bridge.js — runs inside every slide iframe.
 *
 * Lets the parent player coordinate multi-tab (carousel) slides:
 *  - announces the slide's panel count to the parent,
 *  - echoes the active panel whenever it changes,
 *  - accepts navigation/pause commands from the parent.
 *
 * Non-carousel slides need no extra JS — they default to a single panel.
 * Carousel slides register a controller via WccSlide.register({...}).
 *
 * Two independent concepts, deliberately kept apart:
 *  - the slide's own auto-rotate (on by default; the player calls `take-over`
 *    to stop it in interactive mode so the player owns a single timer),
 *  - the visual *paused* state (`body.paused`), set only on an explicit user
 *    pause, which freezes the active tab's gold underline to full width.
 */
(function () {
  var ctrl = null;     // optional carousel controller
  var count = 1;       // panel count (1 for plain slides)
  var current = 0;     // active panel index

  function post(type) {
    try {
      parent.postMessage({ type: type, panel: current, panels: count }, '*');
    } catch (e) { /* not embedded — ignore */ }
  }

  window.WccSlide = {
    // Carousel controller: { count, show(i), startAuto(), pauseAuto(), restartCurrent() }
    register: function (c) {
      ctrl = c;
      count = c.count || 1;
      current = 0;
      post('wcc-slide');
    },
    // Called by the controller after it changes panel.
    notifyPanel: function (i) {
      current = i;
      post('wcc-panel');
    }
  };

  function setPaused(p) {
    document.body.classList.toggle('paused', p);
  }

  function show(i) {
    if (!ctrl) return;
    i = Math.max(0, Math.min(count - 1, i));
    ctrl.show(i); // controller updates `current` via notifyPanel
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'wcc-cmd') return;
    switch (d.action) {
      case 'take-over':                       // player assumes timing
        if (ctrl) ctrl.pauseAuto();
        break;
      case 'pause':                           // user paused: freeze underline
        setPaused(true);
        if (ctrl) ctrl.pauseAuto();
        break;
      case 'resume':                          // user resumed: re-animate current
        setPaused(false);
        if (ctrl) ctrl.restartCurrent();
        break;
      case 'restart-auto':                    // kiosk: slide just became visible —
        if (ctrl) { setPaused(false); ctrl.show(0); ctrl.startAuto(); } // rotate afresh from panel 0
        break;
      case 'next-panel': show(current + 1); break;
      case 'prev-panel': show(current - 1); break;
      case 'goto-panel': show(typeof d.index === 'number' ? d.index : current); break;
      case 'reset':      show(0); break;
      case 'ping':       post('wcc-slide'); break; // parent (re)requests count
    }
  });

  // Announce on load too: covers plain slides (no controller) and re-announces
  // in case the parent attached its listener after the controller registered.
  window.addEventListener('load', function () { post('wcc-slide'); });
})();

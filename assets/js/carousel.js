/* carousel.js — shared tab/panel rotation for carousel slides.
 *
 * Replaces the per-slide inline rotation scripts. Each slide sets its config
 * before loading this file:
 *
 *   <script>window.WCC_CAROUSEL = { panelDuration: 20, panelSelector: '.panel' };</script>
 *   <script src="/assets/js/carousel.js"></script>
 *
 * Markup is the shared convention: `.panel-nav` with `.panel-tab` children, and
 * panels matched by `panelSelector` (the first carrying `panel-active`).
 *
 * Navigation authority lives in the parent player (via slide-bridge.js); this
 * module only auto-rotates when left alone (the standalone/kiosk case) and
 * exposes a controller the bridge can drive.
 */
(function () {
  var cfg = window.WCC_CAROUSEL || {};
  var panelSelector = cfg.panelSelector || '.panel';
  var panelDuration = cfg.panelDuration || 10;

  var panels = Array.prototype.slice.call(document.querySelectorAll(panelSelector));
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.panel-tab'));
  var nav = document.querySelector('.panel-nav');
  if (nav) nav.style.setProperty('--panel-duration', panelDuration + 's');

  if (panels.length === 0) return;

  var current = 0;
  var timer = null;

  function show(i) {
    panels[current].classList.remove('panel-active');
    if (tabs[current]) tabs[current].classList.remove('active');
    // Force reflow so the active tab's underline animation restarts from 0.
    void (tabs[i] || panels[i]).offsetWidth;
    panels[i].classList.add('panel-active');
    if (tabs[i]) tabs[i].classList.add('active');
    current = i;
    if (window.WccSlide) window.WccSlide.notifyPanel(i);
  }

  function stopAuto() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function startAuto() {
    if (panels.length <= 1) return;
    stopAuto();
    timer = setInterval(function () {
      show((current + 1) % panels.length);
    }, panelDuration * 1000);
  }

  if (window.WccSlide) {
    window.WccSlide.register({
      count: panels.length,
      show: show,
      startAuto: startAuto,
      pauseAuto: stopAuto,
      restartCurrent: function () { show(current); }
    });
  }

  // Default behaviour when not driven by a player: auto-rotate, wrapping.
  startAuto();
})();

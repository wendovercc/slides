/* set-nav.js — drives the sequence strip on a slide-set member.
 *
 * A set member shows one active step whose gold underline fills over the member's
 * dwell, mirroring the carousel tab progress. Because members are separate slides
 * that load up-front (mid-animation by the time they're shown), we restart the
 * fill when the player signals the slide is now visible, via the slide bridge's
 * single-panel controller hooks (`restart-auto` in kiosk, `reset`/`resume` in
 * interactive). Pausing freezes the underline through the base `body.paused` rule.
 */
(function () {
  var dur = (window.WCC_SET_NAV || {}).duration || 20;
  var nav = document.querySelector('.set-nav');
  if (!nav) return;
  var active = nav.querySelector('.panel-tab.active');
  nav.style.setProperty('--panel-duration', dur + 's');

  function restart() {
    if (!active) return;
    active.classList.remove('active');
    void active.offsetWidth;   // reflow → the underline animation restarts from 0
    active.classList.add('active');
  }

  if (window.WccSlide) {
    window.WccSlide.register({
      count: 1,
      show: restart,
      startAuto: restart,
      pauseAuto: function () {},   // body.paused freezes the underline via CSS
      restartCurrent: restart,
    });
  }
})();

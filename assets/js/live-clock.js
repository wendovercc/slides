/* live-clock.js — the clock the live event layer reads, so it can be taken hold of.
 *
 * Every time-dependent judgement in the event model — freshness decaying, a repeat
 * window reopening, a dwell running out, the bracket an event's `happened_at` sits in
 * — is a function of "now". Read straight from `Date.now()` those judgements can only
 * be watched at the speed the afternoon actually happens, which is no way to tune
 * them: you cannot hold a ranking still long enough to read it, and you cannot skip
 * the ten minutes it takes an event to age out.
 *
 * So "now" becomes a thing that can be **frozen and advanced by hand**. The simulator
 * then owns it outright: it parks this clock on the simulated afternoon and moves it,
 * and data arrives when a poll falls due on the way (see live-sim.js). Time passing is
 * therefore the only control there is — which is why `running` exists below, since a
 * clock that is manual is no longer the same thing as a clock that is stopped.
 *
 * PRODUCTION IS UNTOUCHED. Left alone this is `Date.now` with one function call in
 * front of it: `manual` is only ever turned on by the simulator, and nothing in the
 * shipping chrome can reach it. A consumer that loads without this module falls back
 * to `Date.now()` directly (see the asset-cache-skew note), so it is never a hard
 * dependency.
 */
(function () {
    var manual = false;
    /* WHETHER TIME IS MOVING, which is a different question from whether the clock is
     * manual. A manual clock being advanced tick after tick is an afternoon going by, and
     * the surfaces that stop themselves while the clock is HELD — the ticker's segment
     * cycle, the strip's view cycle, the CSS animations — must not stop for that.
     *
     * Whoever drives a manual clock is the only one who knows which of the two it is
     * doing, so it says: the simulator sets this from its own play state. */
    var running = false;
    // Where a frozen clock is parked. Set when freezing, moved by `advance`.
    var held = 0;
    // The instant it was frozen at, so we can say how much time has been pushed
    // through BY HAND since. That number is stable between keypresses, which is the
    // point of it: the distance from a frozen clock to the wall clock grows every
    // second on its own, so displaying that would put a drifting number on a screen
    // whose whole purpose is to be still.
    var frozenAt = 0;
    var listeners = [];

    function now() { return manual ? held : Date.now(); }

    function fire() {
        // A time jump must repaint whatever is showing the consequences at once —
        // waiting up to a broadcast tick makes stepping feel broken.
        listeners.slice().forEach(function (fn) { try { fn(now()); } catch (e) {} });
    }

    window.WccClock = {
        now: now,
        isManual: function () { return manual; },
        /* Freeze at the current instant, or hand the clock back to the wall. Freezing
         * deliberately keeps the instant it was frozen AT rather than resetting to
         * zero — the day so far stays as old as it really is, so ages and brackets
         * remain meaningful. */
        manual: function (on) {
            on = !!on;
            if (on === manual) return;
            if (on) { held = Date.now(); frozenAt = held; }
            manual = on;
            if (!on) running = false;
            fire();
        },
        /* Whether the clock is being RUN rather than merely held. Announced, because
         * every surface that stops itself for a held clock has to start again when the
         * day does. */
        running: function (on) {
            on = !!on;
            if (on === running) return;
            running = on;
            fire();
        },
        /* What "held" means to the rest of the page: manual AND not moving. This is the
         * one a surface should ask, and `isManual` is for a caller that needs to know
         * whether `advance` will do anything. */
        isHeld: function () { return manual && !running; },
        /* Move a frozen clock forward (or back, with a negative step). A no-op while the
         * clock is real — there is nothing to advance.
         *
         * `quiet` moves it WITHOUT telling anyone, for a caller that is part-way through
         * a larger update and will announce the end state itself. A poll is exactly
         * that: time passes AND data arrives, and anyone who looks in between sees a
         * clock that has moved on against data that has not — which is a real state to
         * nobody, and a scheduler deciding there decides on a stale store. */
        advance: function (ms, quiet) {
            if (!manual) return false;
            held += Number(ms) || 0;
            if (!quiet) fire();
            return true;
        },
        set: function (ms) {
            if (!manual) return false;
            held = Number(ms) || 0;
            fire();
            return true;
        },
        /* How much time has been advanced by hand since the clock was frozen. STABLE
         * between keypresses — this is the number a surface should show. Zero while
         * the clock is real. */
        advanced: function () { return manual ? held - frozenAt : 0; },
        // How far a frozen clock has drifted from the wall. Changes every second by
        // its nature, so it is here for diagnosis and must not be put on screen.
        skew: function () { return manual ? held - Date.now() : 0; },
        onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
    };
})();

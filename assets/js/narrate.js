/* narrate.js — the review workbench (/narrate). Phase 7 of docs/narrated-decks.md.
 *
 * Record mode makes a take; this reviews it and exports the narration. The split is
 * deliberate and is the main trap the design warns about: recording is the deck,
 * near-fullscreen, with a minimal HUD, and belongs in the player; review is a table,
 * a waveform and a set of destructive-looking buttons, and emphatically does not.
 * So this page *hosts* the player (`?hosted`) rather than reimplementing it — a beat
 * is reached through the same nav the narrator used.
 *
 * What it edits, and what it does not:
 *   - Cue boundaries can be NUDGED, a few hundred ms either way. That is the
 *     mid-word case, and it reflows only the two adjacent beats.
 *   - A beat can be RE-RECORDED. Its segment then becomes authoritative and the
 *     timeline reflows from there; the cue time is kept as provenance.
 *   - The take itself is never cut. The audio is the master (see "The timeline
 *     invariant"): video adapts to it, and nothing downstream can desync from it.
 */
(function () {
  "use strict";

  var BIN = 0.01;          // envelope resolution, seconds — 10ms is plenty for a cue
  /* One step, both instruments: 10ms, which is finer than the frame the render
     quantises to and fine enough for the audio split a nudge really moves. `shift`
     is the syllable-scale gesture the cue used to have as its base step, and the
     sweep unit for the take's ±500ms hunt — the coarse action differs by job, the
     unit does not. */
  var STEP = 10;           // ms, on a cue and on the take alike
  var COARSE = 10;         // shift: 100ms, a syllable
  var OFF_MAX = 1000;      // the take's calibration is tens of ms; this is slack, not scope
  var MIN_BEAT = 0.2;      // a nudge may not swallow a beat whole

  var state = {
    take: null,      // the take-store session record
    deck: null,      // the deck as played
    url: null,       // object URL for the take audio
    env: null,       // { max: Float32Array, rms: Float32Array } at BIN resolution
    segs: {},        // beat index → re-recorded Blob
    sel: -1,         // selected beat
    rec: null,       // { recorder, beat, started, stream }
    titles: {},      // slug → the catalogue's title, for a take that carries none
    off: 0,          // the whole-take offset, in ms
    rows: [],        // beat index → its row element, so selection is a class not a rebuild
    drag: false,     // the playhead is being scrubbed
    raf: 0,          // the playhead's animation frame
    cache: null      // the take's envelope, drawn once (see waveCache)
  };

  var $ = function (s) { return document.querySelector(s); };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function fmtT(s) {
    if (s == null || !isFinite(s)) return "—";
    var t = Math.floor(s);
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  }
  function status(msg) { $("#status").textContent = msg || ""; }

  // ---- beats -------------------------------------------------------------
  /* The take's cue log, turned into the beat list the timeline exports.
     A beat runs from its cue to the next one; a re-recorded beat's duration is its
     segment's instead, which is what "the segment list is authoritative from there
     on" means in practice. Cue times are kept either way, as provenance. */
  var _beats = null;                      // see invalidate(): the playhead asks 60×/s
  function invalidate() { _beats = null; }
  function beats() {
    if (_beats) return _beats;
    var t = state.take;
    if (!t) return [];
    var cues = t.cues || [];
    var ov = t.overrides || {};
    var out = [];
    var p = 0, plan = t.plan || [];
    for (var i = 0; i < cues.length; i++) {
      var end = i + 1 < cues.length ? cues[i + 1].t : (t.duration || cues[i].t);
      // Name the beat from the plan, walking the two lists together: they are the
      // same sequence unless a slide repeats, and the forward pointer is what keeps
      // a repeat from matching the earlier copy.
      var hit = null;
      for (var k = p; k < plan.length; k++) {
        if (same(plan[k], cues[i].atom)) { hit = plan[k]; p = k + 1; break; }
      }
      if (!hit) for (var j = 0; j < plan.length; j++) {
        if (same(plan[j], cues[i].atom)) { hit = plan[j]; break; }
      }
      out.push({
        i: i,
        atom: cues[i].atom,
        cue: cues[i].t,
        recorded: Math.max(0, end - cues[i].t),
        duration: ov[i] != null ? ov[i] : Math.max(0, end - cues[i].t),
        redone: ov[i] != null,
        plan: hit
      });
    }
    _beats = out;
    return out;
  }
  function same(p, a) {
    return p && a && p.slug === a.slide && p.panel === (a.panel || 0)
        && (p.card || null) === (a.card || null);
  }
  function atomName(b) {
    var p = b.plan;
    return (p && (p.label || p.phase)) || b.atom.slide;
  }
  /* A beat's name is the deck's, one level deeper. The wall's header hierarchy gives
     the two levels the record HUD's spine uses (`1st Innings · Highlights`) and the
     atom adds the third (`OUT! G Jackson gets M Moss`) — so the row, the detail pane,
     the strip and the deck builder are all saying the same string about the same
     thing. A leaf on its own is not a name: every innings has a Bowling. */
  function beatName(b) {
    var slide = null;
    ((state.deck && state.deck.slides) || []).some(function (s) {
      if (s.slug === b.atom.slide) { slide = s; return true; }
      return false;
    });
    // A slug is a filename, and no editor should have to read one. The name comes
    // from what the deck builder showed — the entry's own title where the take
    // carried one, the site catalogue's otherwise — and the slug is only ever the
    // last resort for a slide neither knows about.
    var title = (slide && (slide._title || slide.title))
                || state.titles[b.atom.slide] || b.atom.slide;
    var lvl = String(title).split(" · ");
    var leaf = lvl[lvl.length - 1] || b.atom.slide;
    var phase = b.plan && b.plan.phase;
    var above = (phase && phase !== leaf) ? phase : (lvl.length > 1 ? lvl[lvl.length - 2] : "");
    var label = clipLabel(b.plan && b.plan.label);
    if (label && label !== leaf) return { path: [above, leaf].filter(Boolean), leaf: label };
    return { path: above ? [above] : [], leaf: leaf };
  }
  /* Clip labels are ordinal-prefixed (`4. Four through cover`) so two similar balls
     stay apart in the curation list. A beat row has a number of its own in the
     column beside it, so the ordinal here is the same fact printed twice — and it
     reads as part of the commentary, which it is not. Dropped in the display, kept
     in the data (the same call the record HUD's prompt makes). */
  function clipLabel(s) { return s ? String(s).replace(/^\s*\d+\.\s*/, "") : s; }
  /* One caption, built twice over: `<i>` for the levels above, plain for the beat. */
  function caption(into, b) {
    var n = beatName(b);
    if (n.path.length) into.appendChild(el("i", { text: n.path.join(" · ") + " · " }));
    into.appendChild(document.createTextNode(n.leaf));
    if (b.atom.card) into.appendChild(el("span", { class: "card", text: b.atom.card + "-card" }));
    var fz = freezesFor(b.i);
    if (fz.length) into.appendChild(el("span", { class: "card", text: "· " + fz.length + " freeze" }));
    return into;
  }
  function freezesFor(i) {
    return ((state.take && state.take.freezes) || []).filter(function (f) { return f.beat === i; });
  }

  // ---- the take's envelope ------------------------------------------------
  /* Decoded once, downsampled immediately, and the AudioBuffer dropped: twenty
     minutes of float samples is a quarter of a gigabyte, and everything this page
     does — drawing, per-row slices, the silence and mid-word flags — is answered by
     a 10ms envelope. */
  function envelope(buffer) {
    var ch = buffer.getChannelData(0);
    var per = Math.max(1, Math.round(buffer.sampleRate * BIN));
    var n = Math.ceil(ch.length / per);
    var max = new Float32Array(n), rms = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var a = i * per, b = Math.min(ch.length, a + per), m = 0, s = 0;
      for (var k = a; k < b; k++) {
        var v = ch[k];
        if (v < 0) v = -v;
        if (v > m) m = v;
        s += v * v;
      }
      max[i] = m;
      rms[i] = Math.sqrt(s / Math.max(1, b - a));
    }
    return { max: max, rms: rms, dur: buffer.duration };
  }
  function envSlice(from, to) {
    var e = state.env;
    if (!e) return null;
    return { a: Math.max(0, Math.floor(from / BIN)), b: Math.min(e.max.length, Math.ceil(to / BIN)) };
  }
  function peakIn(from, to) {
    var s = envSlice(from, to);
    if (!s) return null;
    var m = 0;
    for (var i = s.a; i < s.b; i++) if (state.env.max[i] > m) m = state.env.max[i];
    return m;
  }
  function rmsIn(from, to) {
    var s = envSlice(from, to);
    if (!s || s.b <= s.a) return null;
    var t = 0;
    for (var i = s.a; i < s.b; i++) t += state.env.rms[i];
    return t / (s.b - s.a);
  }

  // ---- flags --------------------------------------------------------------
  /* Raised without being asked, because the editor has no way to find these by
     looking: a silent beat, a cue that landed mid-word, and a clip beat whose
     commentary badly overran the footage under it. */
  function flagsFor(b) {
    var out = [];
    if (!state.env || b.redone) return out;
    var end = b.cue + b.recorded;
    var peak = peakIn(b.cue, end);
    if (peak != null && peak < 0.02) out.push({ bad: true, text: "no audio on this beat" });
    var tail = rmsIn(Math.max(b.cue, end - 0.15), end);
    if (tail != null && tail > 0.05) out.push({ text: "the take still has energy at the cue — mid-word?" });
    var media = b.plan && b.plan.duration;
    if (media && b.plan.card == null && b.recorded > media * 1.25 + 1) {
      out.push({ text: "runs " + (b.recorded - media).toFixed(1) + "s past its footage" });
    }
    return out;
  }

  // ---- render -------------------------------------------------------------
  function render() {
    var list = $("#beats");
    invalidate();
    var bs = beats();
    list.innerHTML = "";
    state.rows = [];
    if (!bs.length) {
      list.appendChild(el("div", { class: "empty-hint",
        text: "This take has no cues — the deck never moved while it was recording." }));
      return;
    }
    bs.forEach(function (b) {
      var row = el("div", { class: "row" + (b.i === state.sel ? " on" : "") });
      row.appendChild(el("span", { class: "n", text: String(b.i + 1) }));
      row.appendChild(caption(el("span", { class: "name" }), b));
      row.appendChild(el("span", { class: "dur" + (b.redone ? " redone" : ""),
                                   text: b.duration.toFixed(1) + "s" }));
      var fl = flagsFor(b);
      if (fl.length) {
        row.appendChild(el("div", { class: "flags" + (fl.some(function (f) { return f.bad; }) ? " bad" : ""),
                                    text: "⚠ " + fl.map(function (f) { return f.text; }).join(" · ") }));
      }
      // Selecting a beat is a move of the playhead — the list and the strip are two
      // views of one position — and it says nothing about whether the take is
      // rolling: it lands there paused if you were paused, and keeps playing from
      // there if you were playing.
      row.addEventListener("click", function () {
        seekTo(cueAt(b), { select: false });
        select(b.i, { force: true });   // its own cue, so the clip starts at its start
      });
      state.rows[b.i] = row;
      list.appendChild(row);
    });
    paintSel();
    paintActs();
    drawTake();
    $("#beat-count").textContent = bs.length + " beats";
  }

  // ---- the take strip -----------------------------------------------------
  /* The strip answers three questions at once — what the take sounds like, which
     part of it is the selected beat, and where the playhead is — and only the first
     of those is expensive. So the envelope is drawn once into an offscreen canvas
     and blitted; a twenty-minute take is 120k bins, and re-walking them sixty times
     a second to redraw bars that never change is the one thing that would make the
     playhead stutter. */
  function takeDur() {
    return (state.take && state.take.duration) || (state.env && state.env.dur) || 0;
  }
  /* Cue times are take times; the offset slider says how far the deck's clock sat
     from the recorder's. Everything the strip draws and everything it resolves a
     click into goes through here, so moving the slider visibly moves the beats
     against the audio rather than silently changing only the export. */
  function cueAt(b) { return b.cue + offset(); }

  function waveCache(w, h, dpr) {
    var c = state.cache, dur = takeDur();
    if (c && c.w === w && c.h === h && c.dur === dur && c.env === state.env) return c.canvas;
    var off = document.createElement("canvas");
    off.width = Math.round(w * dpr); off.height = Math.round(h * dpr);
    var x2 = off.getContext("2d");
    x2.setTransform(dpr, 0, 0, dpr, 0, 0);
    var e = state.env;
    if (!e) {
      x2.fillStyle = "rgba(180,200,228,.45)";
      x2.font = "11px Lato, Arial";
      x2.fillText("no waveform (the browser could not decode this take)", 8, h / 2);
    } else {
      var span = Math.max(1, Math.ceil((dur || e.dur) / BIN));
      x2.fillStyle = "#7fa8dd";
      for (var x = 0; x < w; x++) {
        var i0 = Math.floor(x * span / w), i1 = Math.floor((x + 1) * span / w), m = 0;
        for (var i = i0; i < Math.max(i1, i0 + 1) && i < e.max.length; i++) if (e.max[i] > m) m = e.max[i];
        var hh = Math.max(1, m * (h - 2));
        x2.fillRect(x, (h - hh) / 2, 1, hh);
      }
    }
    state.cache = { w: w, h: h, dur: dur, env: state.env, canvas: off };
    return off;
  }

  function drawTake() {
    var cv = $("#wave");
    var w = Math.round(cv.clientWidth || 300), h = Math.round(cv.clientHeight || 74);
    var dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
    if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
    var c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    var dur = takeDur() || 1;
    var xOf = function (t) { return Math.max(0, Math.min(w, (t / dur) * w)); };
    var bs = beats();
    // The selected beat is a band, not a tick. "Where in the take is this beat" is
    // the question the strip exists to answer, and a boundary line never answers it.
    var sel = bs[state.sel];
    if (sel) {
      var a = xOf(cueAt(sel)), b = xOf(cueAt(sel) + Math.max(0.1, sel.recorded));
      c.fillStyle = "rgba(212,175,55,.16)";
      c.fillRect(a, 0, Math.max(2, b - a), h);
    }
    c.drawImage(waveCache(w, h, dpr), 0, 0, w, h);
    bs.forEach(function (b) {
      c.fillStyle = b.i === state.sel ? "rgba(212,175,55,.95)" : "rgba(212,175,55,.4)";
      c.fillRect(xOf(cueAt(b)), 0, 1, h);
    });
    var at = $("#take-audio").currentTime || 0;
    c.fillStyle = "#fff";
    c.fillRect(Math.min(w - 2, xOf(at)), 0, 2, h);
    $("#take-clock").textContent = fmtT(at) + " / " + fmtT(dur);
  }

  // ---- transport ----------------------------------------------------------
  /* The playhead runs on rAF rather than `timeupdate`, which fires four times a
     second — fine for a number, visibly stepped for a line. */
  function pump() { if (!state.raf) state.raf = requestAnimationFrame(tick); }
  function tick() {
    state.raf = 0;
    var a = $("#take-audio");
    drawTake();
    follow();
    if (!a.paused || state.drag) state.raf = requestAnimationFrame(tick);
  }
  /* The playhead selects as it travels: crossing a cue is the deck moving on, and
     the table, the detail pane and the hosted deck all follow it. */
  function follow(t) {
    var at = t != null ? t : $("#take-audio").currentTime, bs = beats();
    for (var i = bs.length - 1; i >= 0; i--) {
      if (at >= cueAt(bs[i])) { if (i !== state.sel) select(i); return; }
    }
  }
  /* One playhead. Setting `currentTime` moves the element's official position
     synchronously — the seek that follows is asynchronous, the position is not —
     so the strip draws the element itself and can never show a playhead the audio
     is not at. That equivalence is a property of the take being seekable at all:
     see `withDuration` in take-store.js, without which the assignment below is
     ignored outright and every control on this page lies. */
  function seekTo(t, opts) {
    var a = $("#take-audio"), dur = takeDur();
    t = Math.max(0, dur ? Math.min(t, dur - 0.01) : t);
    if (a.src) { try { a.currentTime = t; } catch (e) {} }
    if (!opts || opts.select !== false) follow(a.src ? a.currentTime : t);
    drawTake();
  }
  function setTransport() {
    var a = $("#take-audio");
    $("#play-btn").textContent = a.paused ? "Play \u25b8" : "Pause \u2016";
  }

  function select(i, opts) {
    var b = beats()[i];
    if (!b) return;
    var moved = i !== state.sel;
    state.sel = i;
    paintSel();
    drawTake();
    paintCap();
    $("#preview-none").hidden = true;
    paintActs();
    if (moved || (opts && opts.force)) cueDeck();
  }
  /* Stand the deck where the playhead is. For a static beat that is the atom; for a
     clip it is the atom **and how far into its footage the take has got**, because
     a playhead parked halfway through a ball has to show the middle of the ball. Cue
     without the offset and Play runs the clip from its first frame while the
     commentary is already halfway through it.
     A card is a still pad with nothing to scrub, so it takes the atom alone. */
  function cueDeck() {
    var b = beats()[state.sel];
    if (!b) return;
    var msg = { action: "goto-atom", atom: b.atom };
    if (!b.atom.card) {
      var into = $("#take-audio").currentTime - cueAt(b);
      if (into > 0.05) msg.at = +into.toFixed(2);
    }
    postPlayer(msg);
    // A deck driven by a running take has to roll with it: the cue positions the
    // beat, and the play that follows is what makes this a preview of the render
    // rather than a slideshow of stills.
    if (!$("#take-audio").paused) postPlayer({ action: "play" });
  }
  function paintCap() {
    var b = beats()[state.sel], cap = $("#beat-title");
    cap.innerHTML = "";
    if (b) caption(cap, b); else cap.textContent = "Nothing selected";
  }
  /* The beat's actions live with the beat, not on every row: a nudge and a
     re-record are things you do to the one you are looking at, and thirty-five
     copies of a record button is thirty-five chances to hit the wrong one. */
  function paintActs() {
    var b = beats()[state.sel], on = state.rec && b && state.rec.beat === b.i;
    paintNudges();
    $("#redo-btn").disabled = !b;
    $("#redo-btn").textContent = on ? "■ Stop" : "⏺ Re-record";
    $("#redo-btn").classList.toggle("on", !!on);
    $("#undo-btn").hidden = !b || !b.redone;
  }
  /* Selection changes at every cue the playhead crosses, so it is a class and a
     scroll — rebuilding sixty rows at a beat boundary is what would make following
     a take feel heavy. */
  function paintSel() {
    state.rows.forEach(function (row, i) {
      if (row) row.classList.toggle("on", i === state.sel);
    });
    var r = state.rows[state.sel];
    if (r && r.scrollIntoView) r.scrollIntoView({ block: "nearest" });
  }

  // ---- editing ------------------------------------------------------------
  /* Drag a cue boundary. It moves exactly one number and therefore reflows exactly
     two beats — the one that ends at it and the one that starts. */
  function nudge(i, delta) {
    var t = state.take, cues = t.cues || [];
    if (i <= 0 || i >= cues.length) return;    // beat 0 starts where the take does
    var lo = cues[i - 1].t + MIN_BEAT;
    var hi = (i + 1 < cues.length ? cues[i + 1].t : (t.duration || cues[i].t)) - MIN_BEAT;
    if (cues[i].t0 == null) cues[i].t0 = cues[i].t;   // where the narrator cued it
    var was = cues[i].t;
    cues[i].t = Math.min(Math.max(cues[i].t + delta, lo), hi);
    WccTakeStore.save(t);
    render();
    /* The playhead comes along when it was standing on this cue — which it is
       whenever the beat was reached by selecting it — so a run of presses keeps
       moving the same boundary and the picture keeps up. Left where it is otherwise:
       a playhead parked mid-beat is a position the editor chose.
       The selection is pinned either way. Letting `follow` have it would hand the
       next press to the beat before, which is how a nudge quietly becomes a nudge of
       something else. */
    if (Math.abs($("#take-audio").currentTime - (was + offset())) < 0.05) {
      seekTo(cues[i].t + offset(), { select: false });
    }
    // A nudge you cannot see is a nudge you cannot judge: re-cue the deck for wherever
    // the playhead now stands against the moved boundary.
    select(i, { force: true });
  }

  function offset() { return (state.off || 0) / 1000; }
  /* The take's calibration: what the browser did between `MediaRecorder.start()` and
     the first chunk, which no API will answer. One number for the whole sitting, so
     it reads as an absolute — `+40 ms` IS the calibration. */
  function setOffset(ms) {
    state.off = Math.max(-OFF_MAX, Math.min(OFF_MAX, Math.round(ms)));
    var t = state.take;
    if (t) { t.offset = offset(); WccTakeStore.save(t); }
    paintNudges();
    drawTake();
    cueDeck();
  }
  /* A cue's correction reads as a DELTA, because the absolute time a beat starts at
     (`41.83s`) means nothing to an editor while "I have moved this 200ms" means
     everything — and the delta is what makes a way back possible: `t0` is where the
     narrator actually cued it, stamped on the first nudge and never overwritten. */
  /* `t0` is where the narrator actually cued it, stamped on the first nudge — the
     readout is the distance from there, which is the only number about a cue an
     editor can act on. */
  function cueDelta(i) {
    var c = ((state.take && state.take.cues) || [])[i];
    return c && c.t0 != null ? c.t - c.t0 : 0;
  }
  /* One unit for both readouts, because they are one instrument. */
  function ms(n) { return (n > 0 ? "+" : "") + Math.round(n) + "ms"; }
  function paintNudges() {
    var v = $("#take-off-val");
    v.textContent = ms(state.off);
    v.classList.toggle("zero", !state.off);

    var b = beats()[state.sel], d = b ? cueDelta(b.i) : 0;
    var cv = $("#cue-off-val");
    cv.textContent = ms(d * 1000);
    cv.classList.toggle("zero", !d);
    // Beat one starts where the take does; there is no boundary in front of it.
    var locked = !b || b.i <= 0 || !!state.rec;
    $("#cue-back").disabled = $("#cue-fwd").disabled = locked;
  }
  /* Holding a button repeats it, and accelerates: without that, crossing 300ms at a
     10ms step is thirty presses, which is the one real argument a slider had. */
  function holdRepeat(el, fn) {
    var timer = null, n = 0;
    var stop = function () { clearTimeout(timer); timer = null; n = 0; };
    // Re-scheduled rather than an interval, because the gap has to shrink as the
    // hold goes on — an interval fixes its period at the moment it is created.
    var again = function (ev) {
      if (el.disabled) return stop();
      n++;
      fn(ev);
      timer = setTimeout(function () { again(ev); }, n > 8 ? 45 : 90);
    };
    el.addEventListener("pointerdown", function (ev) {
      if (el.disabled) return;
      ev.preventDefault();
      fn(ev);
      timer = setTimeout(function () { again(ev); }, 400);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (t) {
      el.addEventListener(t, stop);
    });
  }

  // ---- re-record ----------------------------------------------------------
  /* Play that beat's video from its start while capturing a replacement segment.
     Nothing is cut from the take: the segment sits beside it and the export points
     the beat at the segment instead. */
  function toggleRecord(b) {
    if (state.rec) { stopRecord(); return; }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, autoGainControl: false } })
      .then(function (stream) {
        var mime = (state.take && state.take.mime) || "";
        var mr;
        try { mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
        catch (e) { mr = new MediaRecorder(stream); }
        var parts = [];
        mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) parts.push(ev.data); };
        mr.onstop = function () {
          var blob = new Blob(parts, { type: mr.mimeType || mime });
          var len = (performance.now() - state.rec.started) / 1000;
          stream.getTracks().forEach(function (t) { t.stop(); });
          var i = state.rec.beat;
          state.rec = null;
          WccTakeStore.putSegment(state.take.id, i, blob).then(function () {
            state.segs[i] = blob;
            var t = state.take;
            t.overrides = t.overrides || {};
            t.overrides[i] = +len.toFixed(3);
            WccTakeStore.save(t);
            status("");
            render();
          }).catch(function () { status("could not store the segment"); });
        };
        state.rec = { recorder: mr, beat: b.i, started: performance.now(), stream: stream };
        select(b.i);
        mr.start();
        postPlayer({ action: "play" });
        // Hold the last frame if the narrator runs long: the beat's own footage
        // stops where it stopped on the take, and a paused clip holds its frame.
        var media = (b.plan && b.plan.duration) || b.recorded;
        state.rec.timer = setTimeout(function () { postPlayer({ action: "pause" }); }, media * 1000);
        status("re-recording beat " + (b.i + 1) + " — press ■ to stop");
        render();
      }).catch(function (e) { status("no microphone: " + (e && e.name)); });
  }
  function stopRecord() {
    if (!state.rec) return;
    if (state.rec.timer) clearTimeout(state.rec.timer);
    postPlayer({ action: "pause" });
    try { state.rec.recorder.stop(); } catch (e) { state.rec = null; render(); }
  }
  function dropSegment(i) {
    var t = state.take;
    if (t.overrides) delete t.overrides[i];
    WccTakeStore.save(t);
    delete state.segs[i];
    WccTakeStore.dropSegment(t.id, i).catch(function () {});
    render();
  }

  // ---- the hosted player --------------------------------------------------
  function postPlayer(msg) {
    var f = $("#preview");
    if (!f || !f.contentWindow) return;
    try { f.contentWindow.postMessage(Object.assign({ type: "wcc-player" }, msg), "*"); } catch (e) {}
  }

  // ---- notices ------------------------------------------------------------
  /* Three things can have moved under a take, and all three are cheap to check and
     expensive to discover at render time. */
  function notices() {
    var box = $("#notices");
    box.innerHTML = "";
    var t = state.take;
    if (!t) return;
    var add = function (text, bad, action) {
      var n = el("div", { class: "notice" + (bad ? " bad" : "") }, [el("span", { text: text })]);
      if (action) {
        var b = el("button", { class: "btn ghost sm", text: action.label });
        b.addEventListener("click", action.fn);
        n.appendChild(b);
      }
      box.appendChild(n);
    };
    if (!t.stopped) {
      add("This take was never finished — recovered from the last cue written before the "
          + "tab went away. Everything up to that point is here.", false, {
        label: "Mark it finished",
        fn: function () {
          t.stopped = true;
          t.duration = (state.env && state.env.dur) || t.duration
                       || ((t.cues[t.cues.length - 1] || {}).t || 0);
          WccTakeStore.save(t);
          notices(); render();
        }
      });
    }
    // Curation drift. The sitting's order is curate → assemble → narrate → export:
    // re-curating after a take moves the panels underneath it, which nothing
    // downstream can detect, because the timeline addresses (slide, panel).
    var drifted = curationDrift();
    if (drifted.length) {
      add("The curation has changed since this take was recorded (" + drifted.join(", ")
          + "). The beats address clips by panel, so a re-curated reel no longer lines "
          + "up — re-record, or put the curation back.", true);
    }
    if (state.buildDrift) {
      add("The site has rebuilt since this take (" + state.buildDrift + "). Normal if the "
          + "deck holds league panels; dangerous if the team has played again, because the "
          + "rolling match slugs now name a different match.", false);
    }
  }

  function curationDrift() {
    var out = [];
    ((state.deck && state.deck.slides) || []).forEach(function (s) {
      if (!s._pc_id || s._innings == null || !s.videos) return;
      var raw = null;
      try { raw = localStorage.getItem("wcc-reel:" + s._pc_id + ":" + s._innings); } catch (e) {}
      var now = raw ? JSON.parse(raw) : null;
      if (!now) return;
      var moved = now.length !== s.videos.length || now.some(function (c, i) {
        var was = s.videos[i];
        return !was || was.url !== c.url || Math.abs(was.start - c.start) > 0.01
            || Math.abs(was.end - c.end) > 0.01;
      });
      if (moved) out.push(s.slug);
    });
    return out;
  }

  // ---- export -------------------------------------------------------------
  /* narration.zip: the deck as played, the timeline, the continuous master, and any
     re-recorded segments. The publisher's half is one command (phase 8's
     `compose.py --timeline`), so the zip is the whole hand-off. */
  function exportZip() {
    var t = state.take;
    if (!t) return;
    var ext = t.ext || "webm";
    var bs = beats();
    var off = offset();
    var timeline = {
      deck: (state.deck && state.deck.title) || t.title,
      build_version: t.build_version || null,
      source: "recorded",
      clip_audio: "duck",
      take: "take." + ext,
      // The global offset is applied here rather than carried, so nothing downstream
      // has to know it existed: cue times in the exported timeline are take times.
      offset: +off.toFixed(3),
      beats: bs.map(function (b) {
        var one = { atom: Object.assign({}, b.atom), duration: +b.duration.toFixed(3),
                    cue: +(b.cue + off).toFixed(3) };
        if (one.atom.card == null) delete one.atom.card;
        // Beats read their audio out of the take at `cue` — the compositor needs the
        // master plus the timestamps, not per-beat files. `audio` appears only where
        // a segment has replaced it.
        if (b.redone) one.audio = "segments/b" + String(b.i + 1).padStart(2, "0") + "." + ext;
        var fz = freezesFor(b.i);
        if (fz.length) one.freezes = fz.map(function (f) { return { at: f.at, hold: f.hold }; });
        return one;
      })
    };
    var deckDoc = Object.assign({}, state.deck, { source: "narrate",
                                                  build_version: t.build_version || null });
    // A reel's clips never travel: the publisher's rebuild is the authority on what
    // is in it (docs/narrated-decks.md, "Clips reach a deck by reference"). Their
    // panels are what the timeline addresses, and those the rebuild reproduces.
    (deckDoc.slides || []).forEach(function (s) { delete s.videos; });
    status("building the zip…");
    Promise.all([WccTakeStore.take(t.id, t.mime), WccTakeStore.segments(t.id)])
      .then(function (r) {
        var files = [
          { name: "deck.json", data: JSON.stringify(deckDoc, null, 2) },
          { name: "timeline.json", data: JSON.stringify(timeline, null, 2) }
        ];
        if (r[0]) files.push({ name: "take." + ext, data: r[0] });
        Object.keys(r[1]).forEach(function (i) {
          files.push({ name: "segments/b" + String(+i + 1).padStart(2, "0") + "." + ext,
                       data: r[1][i] });
        });
        return WccZip.build(files);
      })
      .then(function (zip) {
        var a = el("a", { href: URL.createObjectURL(zip), download: "narration.zip" });
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
        status("");
      })
      .catch(function (e) { status("export failed: " + e); });
  }

  // ---- boot ---------------------------------------------------------------
  function fillPicker() {
    var sel = $("#take-picker");
    sel.innerHTML = "";
    var takes = WccTakeStore.list();
    if (!takes.length) sel.appendChild(el("option", { value: "", text: "(no takes on this browser)" }));
    takes.forEach(function (t) {
      sel.appendChild(el("option", { value: t.id,
        text: (t.title || t.id) + " — " + (t.started || "").slice(0, 16).replace("T", " ")
              + (t.stopped ? "" : " · unfinished") }));
    });
    if (state.take) sel.value = state.take.id;
  }

  function loadTake(id) {
    var t = WccTakeStore.get(id);
    if (!t) { $("#beats").innerHTML = ""; return; }
    state.take = t;
    state.sel = -1;
    invalidate();
    state.env = null;
    state.deck = WccTakeStore.getDeck(id) || { title: t.title, slides: [] };
    state.off = Math.round((t.offset || 0) * 1000);
    fillPicker();
    $("#take-when").textContent = (t.started || "").slice(0, 16).replace("T", " ");
    render();
    notices();
    setTransport();

    // The deck, hosted. `local:` keeps it out of the network entirely, and the take's
    // own copy is what the narrator saw rather than whatever the draft has become.
    $("#preview").src = "/slideshow/?deck=local:" + encodeURIComponent(WccTakeStore.deckKey(id))
                      + "&interactive&hosted&ctx=archive";

    WccTakeStore.segments(id).then(function (segs) { state.segs = segs; render(); });
    WccTakeStore.take(id, t.mime).then(function (blob) {
      if (!blob) { status("no audio stored for this take"); return; }
      if (state.url) URL.revokeObjectURL(state.url);
      state.url = URL.createObjectURL(blob);
      $("#take-audio").src = state.url;
      return blob.arrayBuffer().then(function (buf) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        return new Ctx().decodeAudioData(buf);
      }).then(function (audio) {
        state.env = envelope(audio);
        if (!t.duration) { t.duration = audio.duration; WccTakeStore.save(t); }
        render();
        notices();
        // The decode is the second chance at a seekable take. A take that stopped
        // cleanly knows its own length and was patched on the way out of the store;
        // one recovered from a crash does not, so the store had nothing to write
        // into the container and the element will refuse every seek on this page.
        // Now the length is known — the envelope just measured it — so the file is
        // patched and re-attached.
        reseek(blob, audio.duration);
      }).catch(function () {
        // No waveform is a degraded page, not a broken one: the table, the nudge,
        // the re-record and the export all work without it. Only the flags need it.
        status("this browser cannot decode the take's audio — no waveform or flags");
      });
    }).catch(function () { status("could not read the take's audio"); });
  }

  /* Every control on this page is a seek, so a take the browser will not seek is a
     read-only page pretending to be an editor. Patch, re-attach, and if it still
     will not seek, say so rather than drawing a playhead that cannot move. */
  function reseek(blob, dur) {
    var au = $("#take-audio");
    if (au.seekable && au.seekable.length) return;
    WccTakeStore.withDuration(blob, dur).then(function (fixed) {
      if (fixed === blob) return said();
      if (state.url) URL.revokeObjectURL(state.url);
      state.url = URL.createObjectURL(fixed);
      var at = au.currentTime;
      au.src = state.url;
      au.addEventListener("loadedmetadata", function once() {
        au.removeEventListener("loadedmetadata", once);
        try { au.currentTime = at; } catch (e) {}
        said();
        drawTake();
      });
    }).catch(said);
    function said() {
      if (!au.seekable || !au.seekable.length) {
        status("this browser will not seek this take — see the console for why");
      }
    }
  }

  function wire() {
    $("#take-picker").addEventListener("change", function () { if (this.value) loadTake(this.value); });
    $("#export-btn").addEventListener("click", exportZip);
    $("#delete-btn").addEventListener("click", function () {
      var t = state.take;
      if (!t || !confirm("Delete this take? The audio cannot be recovered.")) return;
      WccTakeStore.remove(t.id).then(function () {
        state.take = null;
        var next = WccTakeStore.latest();
        fillPicker();
        if (next) loadTake(next.id);
        else { $("#beats").innerHTML = "<div class='empty-hint'>No takes on this browser. "
               + "Narration starts in the deck builder: assemble a deck, then Narrate ↗.</div>"; }
      });
    });
    // The beat's own actions, driven off the selection rather than off a row.
    var step = function (ev) { return STEP * (ev && ev.shiftKey ? COARSE : 1); };
    holdRepeat($("#cue-back"), function (ev) { nudge(state.sel, -step(ev) / 1000); });
    holdRepeat($("#cue-fwd"), function (ev) { nudge(state.sel, step(ev) / 1000); });
    holdRepeat($("#take-back"), function (ev) { setOffset(state.off - step(ev)); });
    holdRepeat($("#take-fwd"), function (ev) { setOffset(state.off + step(ev)); });
    $("#redo-btn").addEventListener("click", function () {
      var b = beats()[state.sel];
      if (b) toggleRecord(b);
    });
    $("#undo-btn").addEventListener("click", function () {
      if (state.sel >= 0) dropSegment(state.sel);
    });
    $("#play-btn").addEventListener("click", function () {
      var a = $("#take-audio");
      if (!a.src) return;
      if (a.paused) a.play().catch(function () {}); else a.pause();
    });
    // One place says "we are rolling", and both the deck and the button read it off
    // the audio element rather than off whoever started it.
    var au = $("#take-audio");
    au.addEventListener("play", function () { setTransport(); cueDeck(); pump(); });
    au.addEventListener("seeked", function () { drawTake(); });
    au.addEventListener("pause", function () { setTransport(); postPlayer({ action: "pause" }); drawTake(); });
    au.addEventListener("ended", function () { setTransport(); drawTake(); });

    // Scrub the take: pointer down lands the playhead, a drag carries it, and
    // letting go plays from there — landing somewhere in a take is a request to
    // hear it. The audio is paused for the duration of the drag so the scrub is a
    // position rather than a chase.
    var wave = $("#wave");
    var timeAt = function (ev) {
      var r = wave.getBoundingClientRect();
      return ((ev.clientX - r.left) / Math.max(1, r.width)) * (takeDur() || 1);
    };
    // The drag is tracked on the window rather than by capturing the pointer on the
    // canvas: a scrub that runs off the end of the strip — or off the window — is
    // the normal way to drag to the start, and it must not strand the playhead.
    var move = function (ev) { if (state.drag) seekTo(timeAt(ev)); };
    var resume = false;
    var drop = function () {
      if (!state.drag) return;
      state.drag = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", drop);
      if (resume && au.src) au.play().catch(function () {});
      else cueDeck();
      drawTake();
    };
    wave.addEventListener("pointerdown", function (ev) {
      if (!state.take) return;
      ev.preventDefault();
      state.drag = true;
      // Held for the length of the scrub so the drag is a position rather than a
      // chase, and handed back exactly as it was found.
      resume = !au.paused;
      au.pause();
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", drop);
      window.addEventListener("pointercancel", drop);
      seekTo(timeAt(ev));
      pump();
    });

    var rt = 0;
    window.addEventListener("resize", function () {
      clearTimeout(rt);
      rt = setTimeout(render, 120);
    });
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || d.type !== "wcc-player-ready") return;
      if (state.sel >= 0) {
        var b = beats()[state.sel];
        if (b) postPlayer({ action: "goto-atom", atom: b.atom });
      }
    });
  }

  function boot() {
    wire();
    var want = new URLSearchParams(location.search).get("take");
    var t = (want && WccTakeStore.get(want)) || WccTakeStore.latest();
    fillPicker();
    if (!t) {
      $("#beats").innerHTML = "<div class='empty-hint'>No takes on this browser. "
        + "Narration starts in the deck builder: assemble a deck, then Narrate ↗.</div>";
      return;
    }
    loadTake(t.id);
    // Build drift, the same guard the deck check and the compositor apply.
    fetch("/slides.json").then(function (r) { return r.json(); }).then(function (cat) {
      (cat.slides || []).forEach(function (s) { if (s.slug) state.titles[s.slug] = s.title; });
      render();
      paintCap();
      if (state.take && state.take.build_version && cat.build_version
          && cat.build_version !== state.take.build_version) {
        state.buildDrift = state.take.build_version + " → " + cat.build_version;
        notices();
      }
    }).catch(function () {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

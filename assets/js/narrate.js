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
  var NUDGE = 0.1;         // one click of the boundary drag
  var MIN_BEAT = 0.2;      // a nudge may not swallow a beat whole

  var state = {
    take: null,      // the take-store session record
    deck: null,      // the deck as played
    url: null,       // object URL for the take audio
    env: null,       // { max: Float32Array, rms: Float32Array } at BIN resolution
    segs: {},        // beat index → re-recorded Blob
    sel: -1,         // selected beat
    stop: null,      // when the current range playback should stop
    rec: null        // { recorder, beat, started, stream }
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
  function beats() {
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
    return out;
  }
  function same(p, a) {
    return p && a && p.slug === a.slide && p.panel === (a.panel || 0)
        && (p.card || null) === (a.card || null);
  }
  function atomName(b) {
    var p = b.plan;
    var name = (p && (p.label || p.phase)) || b.atom.slide;
    return name;
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

  function drawWave(canvas, from, to, marks) {
    var e = state.env;
    var w = canvas.clientWidth || 300, h = canvas.clientHeight || 60;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    var c = canvas.getContext("2d");
    c.scale(dpr, dpr);
    c.clearRect(0, 0, w, h);
    if (!e) {
      c.fillStyle = "rgba(180,200,228,.45)";
      c.font = "11px Lato, Arial";
      c.fillText("no waveform (the browser could not decode this take)", 8, h / 2);
      return;
    }
    var a = Math.floor(from / BIN), b = Math.min(e.max.length, Math.ceil(to / BIN));
    var span = Math.max(1, b - a);
    c.fillStyle = "#7fa8dd";
    for (var x = 0; x < w; x++) {
      var i0 = a + Math.floor(x * span / w), i1 = a + Math.floor((x + 1) * span / w);
      var m = 0;
      for (var i = i0; i < Math.max(i1, i0 + 1); i++) if (e.max[i] > m) m = e.max[i];
      var hh = Math.max(1, m * (h - 2));
      c.fillRect(x, (h - hh) / 2, 1, hh);
    }
    (marks || []).forEach(function (mk) {
      var x = ((mk.t - from) / (to - from)) * w;
      c.fillStyle = mk.color || "rgba(212,175,55,.75)";
      c.fillRect(x, 0, 1, h);
    });
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
    var bs = beats();
    list.innerHTML = "";
    if (!bs.length) {
      list.appendChild(el("div", { class: "empty-hint",
        text: "This take has no cues — the deck never moved while it was recording." }));
      return;
    }
    bs.forEach(function (b) {
      var row = el("div", { class: "row" + (b.i === state.sel ? " on" : "") });
      row.appendChild(el("span", { class: "n", text: String(b.i + 1) }));
      var name = el("span", { class: "name" });
      name.appendChild(el("i", { text: (b.plan && b.plan.phase ? b.plan.phase + " · " : "") }));
      name.appendChild(document.createTextNode(atomName(b)));
      if (b.atom.card) name.appendChild(el("span", { class: "card", text: b.atom.card + "-card" }));
      var fz = freezesFor(b.i);
      if (fz.length) name.appendChild(el("span", { class: "card", text: "· " + fz.length + " freeze" }));
      row.appendChild(name);
      row.appendChild(el("span", { class: "dur" + (b.redone ? " redone" : ""),
                                   text: b.duration.toFixed(1) + "s" }));
      var cv = el("canvas");
      row.appendChild(cv);
      var btns = el("div", { class: "btns" });
      var play = el("button", { title: "Play this beat", text: "▸" });
      play.addEventListener("click", function (ev) { ev.stopPropagation(); playBeat(b); });
      var back = el("button", { title: "Nudge this cue earlier", text: "◂" });
      back.addEventListener("click", function (ev) { ev.stopPropagation(); nudge(b.i, -NUDGE); });
      var fwd = el("button", { title: "Nudge this cue later", text: "▸|" });
      fwd.addEventListener("click", function (ev) { ev.stopPropagation(); nudge(b.i, NUDGE); });
      var re = el("button", { class: "rec" + (state.rec && state.rec.beat === b.i ? " on" : ""),
                              title: "Re-record this beat",
                              text: state.rec && state.rec.beat === b.i ? "■" : "⏺" });
      re.addEventListener("click", function (ev) { ev.stopPropagation(); toggleRecord(b); });
      [play, back, fwd, re].forEach(function (x) { btns.appendChild(x); });
      if (b.redone) {
        var undo = el("button", { title: "Drop the re-record and go back to the take", text: "↺" });
        undo.addEventListener("click", function (ev) { ev.stopPropagation(); dropSegment(b.i); });
        btns.appendChild(undo);
      }
      row.appendChild(btns);
      row.addEventListener("click", function () { select(b.i); });
      list.appendChild(row);
      drawWave(cv, b.cue, b.cue + Math.max(0.1, b.recorded), []);

      var fl = flagsFor(b);
      if (fl.length) {
        list.appendChild(el("div", { class: "flags" + (fl.some(function (f) { return f.bad; }) ? " bad" : ""),
                                     text: "⚠ " + fl.map(function (f) { return f.text; }).join(" · ") }));
      }
    });
    drawTake();
    $("#take-beats").textContent = bs.length + " beats";
  }

  function drawTake() {
    var bs = beats();
    var dur = (state.take && state.take.duration) || (state.env && state.env.dur) || 0;
    drawWave($("#wave"), 0, dur || 1, bs.map(function (b) {
      return { t: b.cue, color: b.i === state.sel ? "#fff" : "rgba(212,175,55,.6)" };
    }));
    $("#take-len").textContent = fmtT(dur);
  }

  function select(i) {
    state.sel = i;
    var b = beats()[i];
    render();
    if (!b) return;
    $("#beat-title").textContent = "beat " + (i + 1) + " · " + atomName(b);
    $("#preview-none").hidden = true;
    postPlayer({ action: "goto-atom", atom: b.atom });
    sidebar(b);
  }

  function sidebar(b) {
    var box = $("#sidebar-body");
    box.innerHTML = "";
    var kv = function (k, v) {
      box.appendChild(el("div", { class: "kv" }, [el("span", { text: k }), el("b", { text: v })]));
    };
    kv("Slide", b.atom.slide);
    kv("Panel", String(b.atom.panel) + (b.atom.card ? " · " + b.atom.card + "-card" : ""));
    kv("Cue", b.cue.toFixed(2) + "s");
    kv("Recorded", b.recorded.toFixed(2) + "s");
    if (b.redone) kv("Re-recorded", b.duration.toFixed(2) + "s");
    if (b.plan && b.plan.duration) kv("Footage", b.plan.duration.toFixed(2) + "s");
    freezesFor(b.i).forEach(function (f, n) {
      kv("Freeze " + (n + 1), (f.at == null ? "?" : f.at.toFixed(1) + "s in")
                              + " · held " + f.hold.toFixed(1) + "s");
    });
    if (b.plan && b.plan.info) {
      var c = b.plan.info;
      box.appendChild(el("div", { class: "kv" },
        [el("span", { text: "Card" }), el("b", { text: [c.badge, c.name, c.headline].filter(Boolean).join(" · ") })]));
    }
  }

  // ---- editing ------------------------------------------------------------
  /* Drag a cue boundary. It moves exactly one number and therefore reflows exactly
     two beats — the one that ends at it and the one that starts. */
  function nudge(i, delta) {
    var t = state.take, cues = t.cues || [];
    if (i <= 0 || i >= cues.length) return;    // beat 0 starts where the take does
    var lo = cues[i - 1].t + MIN_BEAT;
    var hi = (i + 1 < cues.length ? cues[i + 1].t : (t.duration || cues[i].t)) - MIN_BEAT;
    cues[i].t = Math.min(Math.max(cues[i].t + delta, lo), hi);
    WccTakeStore.save(t);
    render();
  }

  function playBeat(b) {
    var a = $("#take-audio");
    if (!a.src) return;
    a.currentTime = Math.max(0, b.cue + offset());
    state.stop = b.cue + offset() + b.recorded;
    a.play().catch(function () {});
    select(b.i);
    // The closest thing to a render without spending minutes on compose.py: the
    // deck, driven to the beat, with the take laid over it.
    postPlayer({ action: "play" });
  }

  function offset() { return (parseInt($("#offset").value, 10) || 0) / 1000; }

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
    state.env = null;
    state.deck = WccTakeStore.getDeck(id) || { title: t.title, slides: [] };
    fillPicker();
    $("#take-when").textContent = (t.started || "").slice(0, 16).replace("T", " ");
    render();
    notices();

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
      }).catch(function () {
        // No waveform is a degraded page, not a broken one: the table, the nudge,
        // the re-record and the export all work without it. Only the flags need it.
        status("this browser cannot decode the take's audio — no waveform or flags");
      });
    }).catch(function () { status("could not read the take's audio"); });
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
    $("#play-btn").addEventListener("click", function () {
      var a = $("#take-audio");
      if (a.paused) { state.stop = null; a.play().catch(function () {}); } else a.pause();
    });
    $("#offset").addEventListener("input", function () {
      $("#offset-val").textContent = this.value + " ms";
      var t = state.take;
      if (t) { t.offset = offset(); WccTakeStore.save(t); }
    });
    $("#take-audio").addEventListener("timeupdate", function () {
      if (state.stop != null && this.currentTime >= state.stop) {
        this.pause();
        state.stop = null;
        postPlayer({ action: "pause" });
      }
    });
    // Click the take to hear it from there, and to select the beat you landed in —
    // the fastest way to answer "what did I say over the second innings?".
    $("#wave").addEventListener("click", function (ev) {
      var t = state.take;
      if (!t) return;
      var r = this.getBoundingClientRect();
      var dur = t.duration || (state.env && state.env.dur) || 0;
      var at = ((ev.clientX - r.left) / r.width) * dur;
      var bs = beats();
      for (var i = bs.length - 1; i >= 0; i--) {
        if (at >= bs[i].cue) { select(i); break; }
      }
      var a = $("#take-audio");
      if (a.src) { a.currentTime = Math.max(0, at); state.stop = null; a.play().catch(function () {}); }
    });
    window.addEventListener("resize", function () { render(); });
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

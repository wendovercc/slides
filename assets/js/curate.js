/* Ball-events curation tool.
 *
 * Loads a match's fetched clip events, plays each against the YouTube stream,
 * and tags clips for the slide contexts that will consume them (Model A):
 *   - match / team / novelty : one-per-clip, each an include + optional pin (1-5)
 *   - players                : per-(clip, player) include + pin + optional caption
 * Plus a base narrative, the start/end trim, and optional data-driven flashcards
 * (a `cards` beat before/after the action, resolved to real figures at build time).
 * Exports a {pc_match_id}.curation.json overlay to commit into content/data/matches/.
 *
 * The working state (`edits`) IS the overlay: it holds only what differs from the
 * fetched defaults, keyed by clip id. Slide selection (newest-first, pins fixed)
 * happens later in build.py — this tool only records intent.
 */
(function () {
  "use strict";

  var CTXS = [["match", "Match highlights"], ["team", "Team reel"], ["novelty", "Club novelty"]];

  // Flashcard registry (v1). Each type is a solid full-frame beat inserted before
  // (`pre`) or after (`post`) the action; the editor only picks a type + player,
  // the figures are resolved from Play Cricket data at build time. `player(ev)`
  // is the sensible default subject for a fresh card on a given clip.
  // `dwell` = default seconds the card is on screen, which is also the lead-in
  // (pre) / lead-out (post) of footage the card overlays. Editable per clip.
  var CARD_TYPES = [
    { key: "new_batsman", at: "pre", label: "New batsman — season stats", dwell: 4,
      player: function (e) { return e.batter || ""; } },
    { key: "dismissal_summary", at: "post", label: "Dismissal — innings summary", dwell: 5,
      player: function (e) { return e.dismissed_batter || ""; } },
  ];
  function cardType(key) {
    for (var i = 0; i < CARD_TYPES.length; i++) if (CARD_TYPES[i].key === key) return CARD_TYPES[i];
    return null;
  }

  // ---- YouTube IFrame API readiness ------------------------------------
  var ytReady = false, ytWaiters = [];
  window.onYouTubeIframeAPIReady = function () {
    ytReady = true; ytWaiters.forEach(function (f) { f(); }); ytWaiters = [];
  };
  function whenYT(f) { ytReady ? f() : ytWaiters.push(f); }

  // ---- State -----------------------------------------------------------
  var LS_PREFIX = "wcc-curate:";
  var state = {
    match: null, byId: {}, edits: {}, committed: {}, selected: null, player: null, roster: [], cycle: 0,
  };

  // ---- DOM helpers -----------------------------------------------------
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function fmtTime(s) {
    if (s === null || s === undefined) return "—";
    s = Math.round(s); var m = Math.floor(s / 60), r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  // ---- Effective values (override ?? fetched default) ------------------
  function ev(id) { return state.byId[id]; }
  function baseNarrative(id) {
    var e = state.edits[id];
    if (e && e.narrative != null) return e.narrative;
    var v = ev(id); return v.narrative || v.title || "";
  }
  // Action in/out. A *stored* start/end is an absolute (drift-corrected) YouTube
  // second — you set it while watching, so it's offset-independent. The *default*
  // (untrimmed) action = the full fetched clip shifted by the cumulative offset,
  // so drift only moves the starting point you cut down from.
  function effTrim(id, key) {
    var e = state.edits[id] || {};
    return (e[key] != null) ? e[key] : (ev(id)[key] + effOffset(id));
  }

  // ---- Frogbox drift: cumulative per-clip offset --------------------------
  var r1 = function (x) { return Math.round(x * 10) / 10; };
  function chronoEvents() {
    return (state.match.events || []).slice().sort(function (a, b) {
      return (a.dt_unix || 0) - (b.dt_unix || 0);
    });
  }
  // Effective offset = running sum of offset_adjustment over clips up to and
  // including this one, in match order. One step correction carries forward.
  function effOffset(id) {
    var sum = 0, evs = chronoEvents();
    for (var i = 0; i < evs.length; i++) {
      var e = state.edits[evs[i].id];
      if (e && e.offset_adjustment) sum += e.offset_adjustment;
      if (evs[i].id === id) break;
    }
    return sum;
  }
  function clipOffsetAdj(id) { var e = state.edits[id]; return (e && e.offset_adjustment) || 0; }

  // ---- Card pads (lead-in / lead-out) -------------------------------------
  function defaultPad(id, at) {
    var c = cardsAt(id, at)[0], t = c && cardType(c.type);
    return t ? t.dwell : 0;
  }
  // A pad only exists to carry a card's overlay, so with no card there is no pad —
  // ignore any stale stored value (guards against an orphaned pad widening the clip).
  function effPre(id) {
    if (!cardsAt(id, "pre").length) return 0;
    var e = state.edits[id]; return (e && e.pre != null) ? e.pre : defaultPad(id, "pre");
  }
  function effPost(id) {
    if (!cardsAt(id, "post").length) return 0;
    var e = state.edits[id]; return (e && e.post != null) ? e.post : defaultPad(id, "post");
  }
  // The shown clip = action widened by the card pads.
  function shownStart(id) { return effTrim(id, "start") - effPre(id); }
  function shownEnd(id) { return effTrim(id, "end") + effPost(id); }

  function ctxObj(id, ctx) { var e = state.edits[id]; return (e && e[ctx]) || null; }
  function ctxIncluded(id, ctx) { var c = ctxObj(id, ctx); return !!(c && c.include); }
  function ctxPin(id, ctx) { var c = ctxObj(id, ctx); return c && c.pin != null ? c.pin : null; }

  function playerRec(id, name) { var e = state.edits[id]; return (e && e.players && e.players[name]) || null; }
  function playerIncluded(id, name) { var r = playerRec(id, name); return !!(r && r.include); }
  function playerPin(id, name) { var r = playerRec(id, name); return r && r.pin != null ? r.pin : null; }
  function playerNarrative(id, name) { var r = playerRec(id, name); return r && r.narrative != null ? r.narrative : ""; }
  function clipPlayers(id) {
    var names = (ev(id).our_players || []).slice();
    var e = state.edits[id];
    if (e && e.players) Object.keys(e.players).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
    return names;
  }
  function clipCards(id) { var e = state.edits[id]; return (e && e.cards) || []; }
  function cardsAt(id, at) { return clipCards(id).filter(function (c) { return c.at === at; }); }
  function clipTags(id) { var e = state.edits[id]; return (e && e.tags) || []; }
  function normTag(s) { return (s || "").trim().toLowerCase().replace(/\s+/g, " "); }
  function allTags() {
    var set = {};
    Object.keys(state.edits).forEach(function (id) { (state.edits[id].tags || []).forEach(function (t) { set[t] = 1; }); });
    return Object.keys(set).sort();
  }

  // ---- Mutations (keep `edits` minimal) --------------------------------
  function edit(id) { return state.edits[id] || (state.edits[id] = {}); }
  function cleanup(id) {
    var e = state.edits[id];
    if (e) {
      ["match", "team", "novelty"].forEach(function (c) {
        if (e[c] && !e[c].include && e[c].pin == null) delete e[c];
      });
      if (e.players) {
        Object.keys(e.players).forEach(function (n) { if (!Object.keys(e.players[n]).length) delete e.players[n]; });
        if (!Object.keys(e.players).length) delete e.players;
      }
      if (e.tags && !e.tags.length) delete e.tags;
      if (e.cards && !e.cards.length) delete e.cards;
      if (!Object.keys(e).length) delete state.edits[id];
    }
    persistDraft();
  }

  // ---- Local draft autosave --------------------------------------------
  function persistDraft() {
    if (!state.match) return;
    try {
      var key = LS_PREFIX + state.match.pc_match_id;
      if (Object.keys(state.edits).length) localStorage.setItem(key, JSON.stringify(state.edits));
      else localStorage.removeItem(key);
    } catch (e) { /* storage full or disabled — nothing we can do */ }
    updateDirty();
  }
  function updateDirty() {
    var dirty = JSON.stringify(state.edits) !== JSON.stringify(state.committed);
    var s = $("#save-status"), d = $("#discard-btn");
    if (s) s.textContent = dirty ? "● autosaved in browser (not yet exported)" : "✓ in sync with committed";
    if (d) d.hidden = !dirty;
  }
  function discardDraft() {
    if (!confirm("Discard your local draft for this match and revert to the last committed curation?")) return;
    try { localStorage.removeItem(LS_PREFIX + state.match.pc_match_id); } catch (e) {}
    state.edits = JSON.parse(JSON.stringify(state.committed));
    state.selected = null;
    renderList(); renderEditor(); updateDirty();
  }
  function setTrim(id, key, value) {
    var e = edit(id);
    if (value == null || isNaN(value) || value === ev(id)[key]) delete e[key];
    else e[key] = value;
    cleanup(id);
  }
  function setPad(id, key, at, value) {
    var e = edit(id), def = defaultPad(id, at);
    if (value == null || isNaN(value) || Math.abs(value - def) < 0.05) delete e[key];
    else e[key] = r1(value);
    cleanup(id);
  }
  function setOffsetAdjustment(id, value) {
    var e = edit(id);
    if (!value) delete e.offset_adjustment; else e.offset_adjustment = r1(value);
    cleanup(id);
  }
  function setBaseNarrative(id, text) {
    var e = edit(id), v = ev(id);
    if (!text || text === (v.narrative || v.title || "")) delete e.narrative; else e.narrative = text;
    cleanup(id);
  }
  function setCtxInclude(id, ctx, on) {
    var e = edit(id);
    if (on) { e[ctx] = e[ctx] || {}; e[ctx].include = true; }
    else if (e[ctx]) { delete e[ctx].include; }
    cleanup(id);
  }
  function setCtxPin(id, ctx, pin) {
    var e = edit(id); e[ctx] = e[ctx] || {};
    if (pin) e[ctx].pin = pin; else delete e[ctx].pin;
    cleanup(id);
  }
  function setPlayer(id, name, patch) {
    var e = edit(id); e.players = e.players || {};
    var r = e.players[name] || (e.players[name] = {});
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v == null || v === false || (k === "narrative" && !v)) delete r[k];
      else r[k] = v;
    });
    cleanup(id);
  }
  function addTag(id, tag) {
    if (!tag) return;
    var e = edit(id); e.tags = e.tags || [];
    if (e.tags.indexOf(tag) < 0) e.tags.push(tag);
    cleanup(id);
  }
  function removeTag(id, tag) {
    var e = state.edits[id]; if (!e || !e.tags) return;
    e.tags = e.tags.filter(function (t) { return t !== tag; });
    cleanup(id);
  }
  function addCard(id, at, key) {
    var t = cardType(key); if (!t) return;
    var e = edit(id); e.cards = e.cards || [];
    e.cards.push({ at: at, type: key, player: t.player(ev(id)) });
    cleanup(id);
  }
  function removeCard(id, card) {
    var e = state.edits[id]; if (!e || !e.cards) return;
    e.cards = e.cards.filter(function (c) { return c !== card; });
    if (!cardsAt(id, card.at).length) delete e[card.at];   // drop the now-orphaned pad
    cleanup(id);
  }
  function setCardPlayer(id, card, name) { card.player = name || ""; cleanup(id); }

  // ---- Match list ------------------------------------------------------
  function loadMatchList() {
    return Promise.all([
      fetch("matches.json").then(function (r) { return r.json(); }),
      fetch("roster.json").then(function (r) { return r.json(); }).catch(function () { return []; }),
    ]).then(function (res) {
      var matches = res[0]; state.roster = res[1] || [];
      var sel = $("#match-picker"); sel.innerHTML = "";
      if (!matches.length) { sel.appendChild(el("option", { text: "No matches available", value: "" })); return; }
      matches.forEach(function (m) {
        var opp = (m.home_name && m.home_name.toLowerCase().indexOf("wendover") >= 0) ? m.away_name : m.home_name;
        sel.appendChild(el("option", {
          text: (m.date || "?") + " — " + (m.team || "?") + " v " + (opp || "?") + " (" + m.n_events + ")",
          value: String(m.pc_match_id),
        }));
      });
      sel.addEventListener("change", function () { if (sel.value) loadMatch(sel.value); });
      loadMatch(sel.value || String(matches[0].pc_match_id));
    });
  }

  function loadMatch(id) {
    stopPlayhead(); state.scrub = null;
    return fetch("data/" + id + ".json").then(function (r) { return r.json(); }).then(function (data) {
      state.match = data; state.byId = {};
      (data.events || []).forEach(function (e) { state.byId[e.id] = e; });
      state.committed = data.curation || {};
      // Prefer a locally-saved draft (may contain unexported work) over committed.
      var draft = null;
      try { var raw = localStorage.getItem(LS_PREFIX + data.pc_match_id); if (raw) draft = JSON.parse(raw); } catch (e) {}
      state.edits = draft || JSON.parse(JSON.stringify(state.committed));
      state.selected = null;
      buildPlayer(data.video_id);
      renderList(); renderEditor(); updateDirty();
    });
  }

  // ---- YouTube player --------------------------------------------------
  function buildPlayer(videoId) {
    whenYT(function () {
      if (state.player) return;
      state.player = new YT.Player("player", {
        videoId: videoId, playerVars: { rel: 0, modestbranding: 1 },
        events: { onStateChange: function (e) { if (e.data === 0) finishPlayback(); } },  // 0 = ENDED
      });
    });
  }
  function currentTime() {
    return state.player && state.player.getCurrentTime ? Math.round(state.player.getCurrentTime()) : null;
  }

  // ---- Clip list -------------------------------------------------------
  function chipsFor(id) {
    var chips = [];
    if (ctxIncluded(id, "match")) chips.push(chip("M", ctxPin(id, "match"), "match"));
    if (ctxIncluded(id, "team")) chips.push(chip("T", ctxPin(id, "team"), "team"));
    if (ctxIncluded(id, "novelty")) chips.push(chip("N", ctxPin(id, "novelty"), "novelty"));
    var np = clipPlayers(id).filter(function (n) { return playerIncluded(id, n); }).length;
    if (np) chips.push(chip("\u{1F464}" + np, null, "player"));
    var nc = clipCards(id).length;
    if (nc) chips.push(chip("\u{1F0CF}" + nc, null, "card"));
    var nt = clipTags(id).length;
    if (nt) chips.push(chip("\u{1F3F7}" + nt, null, "tag"));
    return el("span", { class: "chips" }, chips);
  }
  function chip(label, pin, cls) {
    return el("span", { class: "chip chip-" + cls, text: pin ? label + pin : label });
  }
  function anyIncluded(id) {
    return ctxIncluded(id, "match") || ctxIncluded(id, "team") || ctxIncluded(id, "novelty") ||
      clipPlayers(id).some(function (n) { return playerIncluded(id, n); });
  }

  function renderList() {
    var list = $("#clip-list"); list.innerHTML = "";
    (state.match.events || []).forEach(function (e) {
      var row = el("div", {
        class: "clip-row" + (state.selected === e.id ? " selected" : "") + (anyIncluded(e.id) ? " included" : ""),
        onClick: function () { select(e.id); },
      }, [
        el("input", {
          type: "checkbox", class: "inc", title: "Include in match highlights",
          onClick: function ( x) { x.stopPropagation(); toggleMatch(e.id, x.target.checked); },
        }),
        el("span", { class: "badge type-" + e.type, text: e.type }),
        el("span", { class: "ov", text: (e.over != null ? e.over : "?") + "." + (e.ball != null ? e.ball : "?") }),
        el("span", { class: "ttl", text: baseNarrative(e.id) }),
        chipsFor(e.id),
        el("span", { class: "rng", text: fmtTime(effTrim(e.id, "start")) + "–" + fmtTime(effTrim(e.id, "end")) }),
      ]);
      row.querySelector(".inc").checked = ctxIncluded(e.id, "match");
      list.appendChild(row);
    });
    updateCounts();
  }

  function rowOf(id) {
    var evs = state.match.events;
    for (var i = 0; i < evs.length; i++) if (evs[i].id === id) return $("#clip-list").children[i];
    return null;
  }
  // Refresh a row's dynamic bits without rebuilding the whole list.
  function syncRow(id) {
    var row = rowOf(id); if (!row) return;
    row.querySelector(".ttl").textContent = baseNarrative(id);
    row.querySelector(".rng").textContent = fmtTime(effTrim(id, "start")) + "–" + fmtTime(effTrim(id, "end"));
    row.replaceChild(chipsFor(id), row.querySelector(".chips"));
    row.classList.toggle("included", anyIncluded(id));
    row.querySelector(".inc").checked = ctxIncluded(id, "match");
  }

  function updateCounts() { /* header tally removed; kept as a no-op hook */ }

  function toggleMatch(id, on) {
    setCtxInclude(id, "match", on);
    syncRow(id); updateCounts();
    if (state.selected === id) renderEditor();
  }
  function select(id) {
    var prev = state.selected; state.selected = id;
    // Auto-play already starts at the clip start; an untrimmed clip therefore
    // begins the cycle on "Set action start" (no replay). A trimmed clip plays
    // the shown clip and starts the cycle back at "Play from start".
    var untrimmed = !(state.edits[id] && state.edits[id].start != null);
    state.cycle = untrimmed ? 1 : 0;
    if (prev != null) { var r = rowOf(prev); if (r) r.classList.remove("selected"); }
    var row = rowOf(id); if (row) row.classList.add("selected");
    renderEditor();
    if (untrimmed) playFromStart(id); else previewShown(id);
  }

  // ---- Editor ----------------------------------------------------------
  function pinSelect(current, onChange, disabled) {
    var sel = el("select", { class: "pin" });
    [["", "–"], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"]].forEach(function (o) {
      var op = el("option", { value: o[0], text: o[1] });
      if (String(current || "") === o[0]) op.selected = true;
      sel.appendChild(op);
    });
    sel.disabled = !!disabled;
    sel.addEventListener("change", function () { onChange(sel.value ? parseInt(sel.value, 10) : null); });
    return sel;
  }

  function ctxRow(id, ctx, label) {
    var cb = el("input", { type: "checkbox" }); cb.checked = ctxIncluded(id, ctx);
    var pin = pinSelect(ctxPin(id, ctx), function (v) { setCtxPin(id, ctx, v); syncRow(id); }, !cb.checked);
    cb.addEventListener("change", function () {
      setCtxInclude(id, ctx, cb.checked);
      pin.disabled = !cb.checked; if (!cb.checked) pin.value = "";
      syncRow(id); updateCounts();
    });
    return el("div", { class: "ctx-row" }, [
      el("label", { class: "ctx-lbl" }, [cb, el("span", { text: " " + label })]),
      el("span", { class: "pin-wrap" }, [el("span", { class: "pin-lbl", text: "pin" }), pin]),
    ]);
  }

  function playerRow(id, name) {
    var included = playerIncluded(id, name);
    var cb = el("input", { type: "checkbox" }); cb.checked = included;
    var pin = pinSelect(playerPin(id, name), function (v) { setPlayer(id, name, { pin: v }); }, !included);
    var narr = el("input", {
      type: "text", class: "pnarr", placeholder: "caption for this clip (optional)",
      onInput: function (e) { setPlayer(id, name, { narrative: e.target.value }); },
    });
    narr.value = playerNarrative(id, name);
    narr.style.display = included ? "" : "none";
    cb.addEventListener("change", function () {
      setPlayer(id, name, { include: cb.checked ? true : null });
      pin.disabled = !cb.checked; if (!cb.checked) pin.value = "";
      narr.style.display = cb.checked ? "" : "none";
      syncRow(id); updateCounts();
    });
    return el("div", { class: "player-row" }, [
      el("div", { class: "player-head" }, [
        el("label", { class: "ctx-lbl" }, [cb, el("span", { text: " " + name })]),
        el("span", { class: "pin-wrap" }, [el("span", { class: "pin-lbl", text: "pin" }), pin]),
      ]),
      narr,
    ]);
  }

  function addPlayerControl(id) {
    var current = clipPlayers(id);
    var team = state.match.team;
    // Players on the match's team first, then the rest of the club.
    var onTeam = [], others = [];
    state.roster.forEach(function (p) {
      if (current.indexOf(p.name) >= 0) return;
      (team && p.teams && p.teams.indexOf(team) >= 0 ? onTeam : others).push(p.name);
    });
    var sel = el("select", { class: "add-sel" });
    sel.appendChild(el("option", { value: "", text: "＋ Add a player (e.g. fielder)…" }));
    function group(label, names) {
      if (!names.length) return;
      var og = el("optgroup", { label: label });
      names.forEach(function (n) { og.appendChild(el("option", { value: n, text: n })); });
      sel.appendChild(og);
    }
    group(team ? team + " squad" : "Squad", onTeam);
    group("Other club players", others);
    sel.addEventListener("change", function () {
      if (!sel.value) return;
      setPlayer(id, sel.value, { include: true });
      renderEditor(); syncRow(id); updateCounts();
    });
    return el("div", { class: "add-player" }, [sel]);
  }

  // Grouped roster select (squad first, then the rest of the club), preselecting
  // `selected`. Unlike addPlayerControl this offers the whole roster and keeps an
  // off-roster subject (e.g. opposition batsman) visible.
  function rosterSelect(selected, onChange) {
    var sel = el("select", { class: "card-player-sel" });
    sel.appendChild(el("option", { value: "", text: "— choose player —" }));
    if (selected && !state.roster.some(function (p) { return p.name === selected; })) {
      var op = el("option", { value: selected, text: selected }); op.selected = true; sel.appendChild(op);
    }
    var team = state.match.team, onTeam = [], others = [];
    state.roster.forEach(function (p) {
      (team && p.teams && p.teams.indexOf(team) >= 0 ? onTeam : others).push(p.name);
    });
    function group(label, names) {
      if (!names.length) return;
      var og = el("optgroup", { label: label });
      names.forEach(function (n) {
        var o = el("option", { value: n, text: n }); if (n === selected) o.selected = true; og.appendChild(o);
      });
      sel.appendChild(og);
    }
    group(team ? team + " squad" : "Squad", onTeam);
    group("Other club players", others);
    sel.addEventListener("change", function () { onChange(sel.value); });
    return sel;
  }

  function cardRow(id, card) {
    var t = cardType(card.type);
    return el("div", { class: "card-row" }, [
      el("div", { class: "card-head" }, [
        el("span", { class: "card-type", text: t ? t.label : card.type }),
        el("button", { class: "tag-x", text: "×", title: "Remove card",
          onClick: function () { removeCard(id, card); renderEditor(); syncRow(id); } }),
      ]),
      rosterSelect(card.player, function (name) { setCardPlayer(id, card, name); }),
    ]);
  }

  // One before/after list: existing cards for this `at`, plus an add-card picker.
  // v1 caps each list at a single card (one pre + one post per clip).
  function cardListFor(id, at, addLabel) {
    var wrap = el("div", { class: "card-list" });
    var existing = cardsAt(id, at);
    existing.forEach(function (c) { wrap.appendChild(cardRow(id, c)); });
    if (!existing.length) {
      var types = CARD_TYPES.filter(function (t) { return t.at === at; });
      var sel = el("select", { class: "add-sel" });
      sel.appendChild(el("option", { value: "", text: addLabel }));
      types.forEach(function (t) { sel.appendChild(el("option", { value: t.key, text: t.label })); });
      sel.addEventListener("change", function () {
        if (sel.value) { addCard(id, at, sel.value); renderEditor(); syncRow(id); }
      });
      wrap.appendChild(el("div", { class: "add-card" }, [sel]));
    }
    return wrap;
  }

  function cardsSection(id) {
    return el("div", { class: "cards-sec" }, [
      el("div", { class: "card-at-lbl", text: "Before the action" }),
      cardListFor(id, "pre", "＋ Add a pre-action card…"),
      el("div", { class: "card-at-lbl", text: "After the action" }),
      cardListFor(id, "post", "＋ Add a post-action card…"),
    ]);
  }

  function tagsSection(id) {
    var sec = el("div", { class: "tags-sec" });
    rebuildTags(sec, id);
    return sec;
  }
  function rebuildTags(sec, id) {
    sec.innerHTML = "";
    var chips = el("div", { class: "tags-edit" });
    clipTags(id).forEach(function (t) {
      chips.appendChild(el("span", { class: "tag-chip" }, [
        el("span", { text: t }),
        el("button", { class: "tag-x", text: "×", title: "Remove tag", onClick: function () { removeTag(id, t); rebuildTags(sec, id); syncRow(id); } }),
      ]));
    });
    if (!clipTags(id).length) chips.appendChild(el("span", { class: "hint", text: "No tags yet." }));
    sec.appendChild(chips);

    var dl = el("datalist", { id: "tag-suggestions" });
    allTags().forEach(function (t) { if (clipTags(id).indexOf(t) < 0) dl.appendChild(el("option", { value: t })); });
    var input = el("input", { type: "text", class: "tag-inp", placeholder: "add a tag (e.g. diving catch)…", list: "tag-suggestions" });
    function add() {
      var v = normTag(input.value); if (!v) return;
      addTag(id, v); rebuildTags(sec, id); syncRow(id);
      sec.querySelector(".tag-inp").focus();
    }
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); add(); } });
    sec.appendChild(el("div", { class: "tag-add" }, [input, dl, el("button", { class: "mini", text: "Add", onClick: add })]));
  }

  // ---- Preview + moving playhead --------------------------------------
  // `state.playEnd` is the second the current play-through stops at; the polling
  // loop pauses there, hides the playhead and reverts the cycle button to "Play
  // from start". Single source of truth for "finished" — also keeps "Play from
  // start" from running off to the end of the whole video.
  var phTimer = null;
  function stopPlayhead() { if (phTimer) { clearInterval(phTimer); phTimer = null; } }
  function finishPlayback() {
    stopPlayhead();
    if (state.player && state.player.pauseVideo) state.player.pauseVideo();
    if (state.scrub) state.scrub.playhead.style.display = "none";
    setCycle(0);
  }
  // The playhead is on screen only while the current time sits inside the track.
  function playheadVisible() {
    if (!state.scrub || !state.player || !state.player.getCurrentTime) return false;
    var x = state.scrub.pct(state.player.getCurrentTime());
    return x >= 0 && x <= 100;
  }
  function startPlayhead() {
    stopPlayhead();
    phTimer = setInterval(function () {
      if (!state.scrub || !state.player || !state.player.getCurrentTime) return;
      var t = state.player.getCurrentTime();
      if (state.playEnd != null && t >= state.playEnd) { finishPlayback(); return; }
      var x = state.scrub.pct(t);
      state.scrub.playhead.style.left = x + "%";
      state.scrub.playhead.style.display = (x >= 0 && x <= 100) ? "block" : "none";
    }, 100);
  }
  // Preview = the *shown* clip (action widened by the card pads), so you check
  // exactly what a viewer sees, lead-in and lead-out included.
  function previewShown(id) {
    if (!state.player || !state.player.loadVideoById) return;
    state.playEnd = shownEnd(id);
    state.player.loadVideoById({ videoId: state.match.video_id, startSeconds: shownStart(id) });
    startPlayhead();
  }
  // Play from the top of the *untrimmed* clip (the fetched window, offset-corrected),
  // stopping at its end. Distinct from Preview, which plays the trimmed shown clip.
  // Used by the cycle button and when auto-playing an untrimmed clip.
  function playFromStart(id) {
    if (!state.player || !state.player.loadVideoById) return;
    state.playEnd = ev(id).end + effOffset(id);
    state.player.loadVideoById({ videoId: state.match.video_id, startSeconds: ev(id).start + effOffset(id) });
    startPlayhead();
  }

  // Efficient capture stays: one button, one playthrough, tap the two ACTION
  // points on the fly. Plays from the shown-clip start so the run-up is visible.
  var CYCLE_LABELS = ["▶ Play from start", "① Set action start", "② Set action end"];
  // Update the cycle state + its button in place (used where we don't re-render
  // the whole editor — the 0→1 "playback started" transitions).
  function setCycle(n) {
    state.cycle = n;
    var cyc = $(".cycle");
    if (cyc) { cyc.textContent = CYCLE_LABELS[n]; cyc.className = "btn sm cycle cycle-" + n; }
  }
  function timingRow(id) {
    // State-coloured: ghost while just playing, solid gold (= the action bar) once
    // the next tap places an action point.
    var cyc = el("button", { class: "btn sm cycle cycle-" + state.cycle, text: CYCLE_LABELS[state.cycle] });
    cyc.addEventListener("click", function () {
      if (!state.player || !state.player.loadVideoById) return;
      if (state.cycle === 0) {
        playFromStart(id);
        setCycle(1);
      } else if (state.cycle === 1) {
        // Only capture while the playhead is live; otherwise the play-through is
        // over, so revert to "Play from start" rather than set a stray point.
        if (!playheadVisible()) { finishPlayback(); return; }
        var s = currentTime(); if (s != null) { setTrim(id, "start", s); syncRow(id); }
        state.cycle = 2; renderEditor();
      } else {
        if (!playheadVisible()) { finishPlayback(); return; }
        var e = currentTime();
        if (e != null && e > effTrim(id, "start")) {
          setTrim(id, "end", e); state.player.pauseVideo(); state.cycle = 0; syncRow(id); renderEditor();
        }
        // else: end is not after start — ignore, stay on "set end"
      }
    });
    return el("div", { class: "timing" }, [
      cyc,
      el("button", { class: "mini", text: "Reset", title: "Reset action to the full auto clip",
        onClick: function () { setTrim(id, "start", null); setTrim(id, "end", null); syncRow(id); renderEditor(); } }),
      el("button", { class: "mini", text: "Preview", title: "Play the shown clip (with card pads)",
        onClick: function () { previewShown(id); } }),
    ]);
  }

  // Visual timeline: track = the full fetched clip (offset-corrected) so context
  // is always on screen. Inner handles cut the ACTION down; the outer handles
  // set the card pads (lead-in / lead-out). Drag never ventures past what you've
  // already seen. All four also seek the player on release for a precise check.
  function buildScrubber(id) {
    var defS = ev(id).start + effOffset(id), defE = ev(id).end + effOffset(id);
    var T0 = Math.min(shownStart(id), defS) - 1, T1 = Math.max(shownEnd(id), defE) + 1;
    if (T1 - T0 < 1) T1 = T0 + 1;
    function pct(t) { return ((t - T0) / (T1 - T0)) * 100; }

    // Pad handles exist only where a card does — a lead-in/out is the card's
    // footage, so with no card there's nothing to pad (and the collapsed handle
    // would just sit on top of the action handle and hide it).
    var hasPre = cardsAt(id, "pre").length > 0, hasPost = cardsAt(id, "post").length > 0;

    var track = el("div", { class: "scrub-track" });
    var shown = el("div", { class: "scrub-shown" });
    var action = el("div", { class: "scrub-action" });
    var playhead = el("div", { class: "scrub-playhead" });
    var hAs = el("div", { class: "scrub-h scrub-act", title: "Action start" });
    var hAe = el("div", { class: "scrub-h scrub-act", title: "Action end" });
    var preZone = hasPre ? el("div", { class: "scrub-pre" }) : null;
    var hIn = hasPre ? el("div", { class: "scrub-h scrub-out", title: "Lead-in (pre-card)" }) : null;
    var postZone = hasPost ? el("div", { class: "scrub-post" }) : null;
    var hOut = hasPost ? el("div", { class: "scrub-h scrub-out", title: "Lead-out (post-card)" }) : null;
    [shown, preZone, postZone, action, playhead, hIn, hAs, hAe, hOut].forEach(function (n) { if (n) track.appendChild(n); });

    var lbl = el("div", { class: "scrub-labels" });
    function paint() {
      var a0 = effTrim(id, "start"), a1 = effTrim(id, "end"), s0 = shownStart(id), s1 = shownEnd(id);
      shown.style.left = pct(s0) + "%"; shown.style.width = (pct(s1) - pct(s0)) + "%";
      action.style.left = pct(a0) + "%"; action.style.width = (pct(a1) - pct(a0)) + "%";
      hAs.style.left = pct(a0) + "%"; hAe.style.left = pct(a1) + "%";
      if (hasPre) { preZone.style.left = pct(s0) + "%"; preZone.style.width = (pct(a0) - pct(s0)) + "%"; hIn.style.left = pct(s0) + "%"; }
      if (hasPost) { postZone.style.left = pct(a1) + "%"; postZone.style.width = (pct(s1) - pct(a1)) + "%"; hOut.style.left = pct(s1) + "%"; }
      lbl.textContent = "shown " + fmtTime(s0) + "–" + fmtTime(s1) +
        " · action " + fmtTime(a0) + "–" + fmtTime(a1) +
        (effPre(id) ? " · pre " + effPre(id) + "s" : "") +
        (effPost(id) ? " · post " + effPost(id) + "s" : "");
    }
    paint();
    state.scrub = { playhead: playhead, pct: pct };

    function drag(handle, onT, seekVal) {
      handle.addEventListener("pointerdown", function (down) {
        down.preventDefault(); try { handle.setPointerCapture(down.pointerId); } catch (e) {}
        function mv(e) {
          var r = track.getBoundingClientRect();
          var f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
          onT(T0 + f * (T1 - T0)); paint();
        }
        function up() {
          handle.removeEventListener("pointermove", mv); handle.removeEventListener("pointerup", up);
          syncRow(id);
          if (state.player && state.player.seekTo) state.player.seekTo(seekVal(), true);
        }
        handle.addEventListener("pointermove", mv); handle.addEventListener("pointerup", up);
      });
    }
    drag(hAs, function (t) { setTrim(id, "start", r1(Math.min(t, effTrim(id, "end")))); }, function () { return effTrim(id, "start"); });
    drag(hAe, function (t) { setTrim(id, "end", r1(Math.max(t, effTrim(id, "start")))); }, function () { return effTrim(id, "end"); });
    if (hasPre) drag(hIn, function (t) { setPad(id, "pre", "pre", Math.max(0, effTrim(id, "start") - t)); }, function () { return shownStart(id); });
    if (hasPost) drag(hOut, function (t) { setPad(id, "post", "post", Math.max(0, t - effTrim(id, "end"))); }, function () { return effTrim(id, "end"); });

    // Click the track (not a handle) = seek there and play from that point, to
    // audition a moment. Purely a playback convenience; touches no trim value.
    track.addEventListener("click", function (e) {
      if (e.target.classList && e.target.classList.contains("scrub-h")) return;
      if (!state.player || !state.player.seekTo) return;
      var r = track.getBoundingClientRect();
      var t = T0 + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (T1 - T0);
      state.player.seekTo(t, true);
      if (state.player.playVideo) state.player.playVideo();
      state.playEnd = defE;   // audition on to the untrimmed clip end, then stop
      playhead.style.left = pct(t) + "%"; playhead.style.display = "block";
      startPlayhead();
      // Playback has started, so mirror "Play from start" → ready to set the action.
      if (state.cycle === 0) setCycle(1);
    });

    return el("div", { class: "scrubber" }, [track, lbl]);
  }

  function timingBlock(id) {
    return el("div", { class: "timing-block" }, [timingRow(id), buildScrubber(id)]);
  }

  // Frogbox drift lives in the "Shift" box above the video (out of the way — set
  // rarely, can be large, e.g. a tea break). The box holds *this clip's* step
  // adjustment; its effect (cumulative) shows in the scrubber's default window.
  function updateShiftBar() {
    var inp = $("#shift-input"); if (!inp) return;
    var id = state.selected;
    if (id == null) { inp.value = ""; inp.disabled = true; return; }
    inp.disabled = false;
    var adj = clipOffsetAdj(id);
    inp.value = adj ? String(adj) : "";
  }

  function renderEditor() {
    var box = $("#editor"); box.innerHTML = "";
    var id = state.selected;
    updateShiftBar();
    if (id == null) { box.appendChild(el("p", { class: "hint", text: "Select a clip to tag and trim it." })); return; }

    var narr = el("textarea", {
      class: "narrative", rows: "2", placeholder: "Caption…",
      onInput: function (e) { setBaseNarrative(id, e.target.value); syncRow(id); },
    });
    narr.value = baseNarrative(id);
    box.appendChild(narr);

    box.appendChild(timingBlock(id));

    box.appendChild(el("div", { class: "sec-label", text: "Include in" }));
    CTXS.forEach(function (c) { box.appendChild(ctxRow(id, c[0], c[1])); });

    box.appendChild(el("div", { class: "sec-label", text: "Players" }));
    var wrap = el("div", { class: "players" });
    clipPlayers(id).forEach(function (n) { wrap.appendChild(playerRow(id, n)); });
    box.appendChild(wrap);
    box.appendChild(addPlayerControl(id));

    box.appendChild(el("div", { class: "sec-label", text: "Flashcards" }));
    box.appendChild(cardsSection(id));

    box.appendChild(el("div", { class: "sec-label", text: "Custom tags" }));
    box.appendChild(tagsSection(id));
  }

  // ---- Import / export -------------------------------------------------
  function exportOverlay() {
    var blob = new Blob([JSON.stringify(state.edits, null, 2) + "\n"], { type: "application/json" });
    var a = el("a", { href: URL.createObjectURL(blob), download: state.match.pc_match_id + ".curation.json" });
    document.body.appendChild(a); a.click(); a.remove();
  }
  function importOverlay(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try { state.edits = JSON.parse(reader.result) || {}; state.selected = null; renderList(); renderEditor(); persistDraft(); }
      catch (err) { alert("Could not parse curation file: " + err.message); }
    };
    reader.readAsText(file);
  }

  // ---- Wire up ---------------------------------------------------------
  document.addEventListener("DOMContentLoaded", function () {
    $("#export-btn").addEventListener("click", exportOverlay);
    $("#discard-btn").addEventListener("click", discardDraft);
    $("#shift-input").addEventListener("change", function () {
      var id = state.selected; if (id == null) return;
      var v = parseFloat(this.value);
      setOffsetAdjustment(id, isNaN(v) ? 0 : v);
      syncRow(id); renderEditor();
    });
    $("#import-input").addEventListener("change", function (e) {
      if (e.target.files[0]) importOverlay(e.target.files[0]); e.target.value = "";
    });
    loadMatchList().catch(function (err) { $("#save-status").textContent = "Failed to load: " + err.message; });
  });
})();

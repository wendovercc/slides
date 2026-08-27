/* deck.js — the deck builder (/deck). Phase 6b of docs/narrated-decks.md.
 *
 * Produces a *frozen, literal* deck: the same `{title, slides:[…]}` document the
 * player already consumes, so its output is directly playable (`?deck=local:<key>`)
 * and directly renderable (`timeline.py --data deck.json` → `compose --timeline`).
 *
 * Three things the build already does carry most of this file:
 *   - `data.json` is post-resolution, so loading a deck to customise is a fetch and
 *     nothing has to be re-resolved;
 *   - every slide has its own auto-deck *document* at /slideshow/<slug>/data.json,
 *     so *adding* a slide is a fetch too, and the entry arrives with `_atoms`
 *     already computed (there is no JS port of slide_atoms here, deliberately);
 *   - /slides.json (phase 6a) indexes every built slide, package and slideshow,
 *     which is what makes the discover pane possible at all.
 *
 * Screen shape: deck list and discover stacked down the left, a wide preview and the
 * deck check down the right. Stacked rather than tabbed so the insertion caret stays
 * visible while you choose what to put in it.
 *
 * Adding and starting-from are ONE mechanism. A slideshow is just another search
 * result, so "start from Match Highlights and customise" is "insert it into an empty
 * deck" — there is no separate load step, which leaves the picker free to mean
 * drafts and nothing else.
 */
(function () {
  "use strict";

  var CAT_URL = "/slides.json";
  var LAST_KEY = "wcc-deck-last";        // which draft the editor was last on
  // Reserved deck-store key holding whatever the preview pane is showing. Prefixed
  // so the drafts picker can tell tooling keys from the editor's own decks.
  var PREVIEW_KEY = "__preview";

  var state = {
    cat: null,          // /slides.json
    bySlug: {},         // slug → catalogue entry
    setOf: {},          // slug → set slug
    setTitle: {},       // set slug → title
    deck: null,         // { title, slides: [] }
    key: null,          // deck-store key for the draft
    caret: 0,           // insertion point, in deck-row indices
    ctx: "archive",     // preview context — archive is what a render will say
    kind: "",           // discover filter: "" | deck | set | slide
    search: "",
    // What the preview pane is showing: { where: "deck"|"find", id, … }. One pointer
    // for both panes, because they share one preview.
    pv: null
  };

  var $ = function (sel) { return document.querySelector(sel); };
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function fmtDur(s) {
    if (s == null) return "—";
    var t = Math.round(s);
    return t >= 60 ? Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0") : t + "s";
  }

  // ---- deck document ----------------------------------------------------
  // A slide entry is whatever the build wrote; the builder never invents fields.
  // The only entry it *edits* is panel_duration (static slides only, see setDur).

  function slides() { return (state.deck && state.deck.slides) || []; }
  function entryAtoms(e) { return e._atoms || null; }
  function isVideo(e) { return e._template === "video" || !!(e.videos || (e._videos && e._videos.length)); }

  /* Every slide's dwell is fixed at build time, and for a silent render that dwell
     is the only pacing control the editor has — so it is editable here. Not on a
     reel: its durations come from the clip trims, and `panel_duration` is only the
     `total + 30` safety net build_video_slide sets. */
  function canSetDur(e) { return !isVideo(e) && !e._live && !!entryAtoms(e); }

  function setDur(i, secs) {
    var e = slides()[i];
    if (!e || !canSetDur(e)) return;
    var v = Math.max(1, Math.round(Number(secs) || 0));
    e.panel_duration = v;
    // Mirror what slide_atoms computed: a static slide is one atom per panel, each
    // holding panel_duration. Keeping _atoms in step is what makes the exported
    // deck renderable — timeline.py reads durations from there, not from here.
    (e._atoms || []).forEach(function (a) { a.duration = v; });
    e.duration = v * ((e._atoms || []).length || 1);
    persist();
    render();
  }

  // ---- storage ----------------------------------------------------------

  function persist() {
    if (!state.deck || !state.key) return;
    var ok = window.WccDeckStore && WccDeckStore.put(state.key, state.deck);
    try { localStorage.setItem(LAST_KEY, state.key); } catch (e) {}
    // Every mutation writes synchronously, so a "Saved" badge would be permanently
    // lit and would tell the editor nothing. Say something only when it ISN'T true:
    // put() returns false on quota, and a deck carrying a 29-clip reel is not small.
    // The deck list redrawing is the feedback that the edit landed.
    status(ok ? "" : "NOT SAVED — browser storage is full");
  }

  // The one status channel, and it only ever carries problems.
  function status(msg) {
    $("#save-status").textContent = msg || "";
  }

  function draftKeys() {
    return (window.WccDeckStore ? WccDeckStore.list() : []).filter(function (k) {
      return k.indexOf("__") !== 0;   // reserved tooling keys, e.g. __preview
    });
  }

  /* Storage keys are opaque system IDs, never shown and never derived from the
     title. A key minted from the name goes stale the moment the deck is renamed —
     which is a thing the editor can do — and there is nothing sensible to do about
     it: re-keying on rename means a write, a delete and a re-point of `wcc-deck-last`
     for a string nobody should be looking at anyway. The title is the name; this is
     just where it lives. Existing title-derived keys keep working untouched, since a
     key is only ever compared, never parsed. */
  function newKey() {
    return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // A filename for an exported deck — from the *title*, at export time.
  function fileSlug(title) {
    return (title || "deck").toLowerCase().replace(/[^a-z0-9]+/g, "-")
             .replace(/^-|-$/g, "") || "deck";
  }

  function newDeck(title, entries) {
    state.deck = { title: title || "Untitled deck", slides: entries || [], source: "builder",
                   build_version: state.cat && state.cat.build_version };
    state.key = newKey();
    state.caret = state.deck.slides.length;
    state.pv = null;
    persist();
    fillDrafts();
    render();
  }

  function openDraft(key) {
    var d = window.WccDeckStore && WccDeckStore.get(key);
    if (!d) return false;
    state.deck = d;
    state.key = key;
    state.caret = (d.slides || []).length;
    state.pv = null;
    try { localStorage.setItem(LAST_KEY, key); } catch (e) {}
    fillDrafts();
    render();
    status("");
    return true;
  }

  // ---- fetching entries -------------------------------------------------

  var deckCache = {};
  function fetchDeck(slug) {
    if (deckCache[slug]) return Promise.resolve(deckCache[slug]);
    return fetch("/slideshow/" + slug + "/data.json").then(function (r) {
      if (!r.ok) throw new Error(slug);
      return r.json();
    }).then(function (d) { deckCache[slug] = d; return d; });
  }

  /* The slide entries behind a search result, deep-copied so the deck owns them.

     A slide comes from its own auto-deck, matched by slug rather than taken as
     slides[0]: an authored deck may own the same slug (fantasy-league is both a
     slide and a one-slide deck), in which case the fetched document is that deck.
     A package or a slideshow contributes all of its slides, in order. */
  function entriesFor(kind, slug) {
    return fetchDeck(slug).then(function (d) {
      var out = kind === "slide"
        ? (d.slides || []).filter(function (s) { return s.slug === slug; })
        : (d.slides || []);
      return JSON.parse(JSON.stringify(out));
    }).catch(function () { return []; });
  }

  // ---- insert / reorder / remove ----------------------------------------

  function insertAt(entries, at) {
    if (!entries.length) return;
    if (!state.deck) newDeck("Untitled deck", []);
    Array.prototype.splice.apply(state.deck.slides, [at, 0].concat(entries));
    state.caret = at + entries.length;
    persist();
    fillDrafts();
    render();
  }

  function move(from, to) {
    var arr = slides();
    if (to < 0 || to >= arr.length || from === to) return;
    arr.splice(to, 0, arr.splice(from, 1)[0]);
    if (state.pv && state.pv.where === "deck") state.pv.id = to;
    persist();
    render();
  }

  function removeAt(i) {
    slides().splice(i, 1);
    if (state.caret > i) state.caret--;
    if (state.pv && state.pv.where === "deck") state.pv = null;
    persist();
    fillDrafts();
    render();
  }

  // ---- deck check -------------------------------------------------------
  /* Stated, never enforced: every one of these is sometimes what the editor meant.
     The one that is nearly an error (a live slide) is coloured differently rather
     than blocked, because a deck is also a thing you play, not only render. */

  function warnings() {
    var out = [];
    var arr = slides();
    if (!arr.length) return out;

    // Set splits. Membership is baked at build time — set-nav.js renders a step
    // strip INTO each member — so a member that no longer runs contiguously still
    // shows "3 of 5" for a sequence that isn't there.
    var runs = {};
    arr.forEach(function (e, i) {
      var set = e._group || state.setOf[e.slug];
      if (set) (runs[set] = runs[set] || []).push(i);
    });
    Object.keys(runs).forEach(function (set) {
      var idx = runs[set];
      if (idx.length > 1 && idx[idx.length - 1] - idx[0] !== idx.length - 1) {
        out.push({ text: "<b>" + (state.setTitle[set] || set) + "</b> is split — its members "
          + "are no longer contiguous, so their sequence strip will still count the whole set." });
      }
    });

    var seen = {};
    arr.forEach(function (e, i) {
      var c = state.bySlug[e.slug] || {};
      var name = "<b>" + (e._title || c.title || e.slug) + "</b>";
      if (seen[e.slug]) out.push({ row: i, text: name + " appears more than once." });
      seen[e.slug] = 1;

      if (e._live || c.live) {
        out.push({ row: i, bad: true, text: name + " is a live-match slide: its panels are "
          + "whatever the feed has produced, so it can be neither narrated nor rendered." });
      } else if (!entryAtoms(e)) {
        out.push({ row: i, bad: true, text: name + " has no atom list — it cannot be rendered." });
      } else if (isVideo(e) && !(e.videos || e._videos || []).length) {
        out.push({ row: i, text: name + " has no resolved clips yet — it renders after the "
          + "publisher's rebuild syncs them to R2." });
      }
      if (e._empty || c.empty) out.push({ row: i, text: name + " had no data this build." });
      if (c.active === false) out.push({ row: i, text: name + " is marked inactive." });
      var exp = e.slide_expires || c.expires;
      if (exp) out.push({ row: i, text: name + " expires " + exp + "." });
    });

    if (state.cat && state.deck.build_version && state.deck.build_version !== state.cat.build_version) {
      out.push({ text: "This deck was assembled from build <b>" + state.deck.build_version
        + "</b>; the site is now at <b>" + state.cat.build_version + "</b>. Slides may have "
        + "moved on — rebuild the deck if it is about to be narrated or rendered." });
    }
    return out;
  }

  // ---- rendering --------------------------------------------------------

  // Per-set stripe colour: a stable hue from the slug, so a set looks the same on
  // every reload without a palette to maintain.
  function setHue(slug) {
    var h = 0;
    for (var i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) % 360;
    return h;
  }

  /* Badges say what *kind of thing* a result is — one slide, a match package, or a
     whole slideshow — which is what tells you how much a `+` will add. They no longer
     say which template a slide uses: the name is now its own header hierarchy
     ("Last Match · 1st XI · 1st Innings · Batting"), which identifies the slide far
     better than a template name did, and all 242 are distinct on it. Deck rows carry
     no badge at all — everything in a deck is a slide, so it would be one word
     repeated down the column. `live` colours the title instead, being a warning
     rather than a category. */
  function badgeClass(kind) {
    return "kind" + (kind === "set" ? " k-set" : "") + (kind === "show" ? " k-deck" : "");
  }

  function caretEl(at) {
    var n = el("div", { class: "caret" + (state.caret === at ? " active" : ""), "data-at": at });
    n.addEventListener("click", function () { state.caret = at; render(); });
    n.addEventListener("dragover", function (ev) { ev.preventDefault(); n.classList.add("drop"); });
    n.addEventListener("dragleave", function () { n.classList.remove("drop"); });
    n.addEventListener("drop", function (ev) {
      ev.preventDefault();
      n.classList.remove("drop");
      var from = Number(ev.dataTransfer.getData("text/plain"));
      if (!isNaN(from)) move(from, at > from ? at - 1 : at);
    });
    return n;
  }

  function renderDeck() {
    var list = $("#deck-list");
    list.innerHTML = "";
    var arr = slides();
    $("#play-btn").hidden = !arr.length;   // nothing to play
    $("#deck-count").textContent = arr.length
      ? arr.length + " slide" + (arr.length === 1 ? "" : "s") + " · "
        + fmtDur(arr.reduce(function (a, e) { return a + (e.duration || 0); }, 0))
      : "";
    if (!arr.length) {
      list.appendChild(el("div", { class: "empty-hint", html:
        "Nothing here yet. Search below for a slideshow to start from, a match package, "
        + "or a single slide — click a result to preview it, <b>+</b> to add it." }));
      return;
    }
    var warnRows = {};
    warnings().forEach(function (w) { if (w.row != null) warnRows[w.row] = 1; });

    list.appendChild(caretEl(0));
    arr.forEach(function (e, i) {
      var c = state.bySlug[e.slug] || {};
      var set = e._group || state.setOf[e.slug];
      var atoms = entryAtoms(e);
      var pv = state.pv && state.pv.where === "deck" && state.pv.id === i;

      var stripe = el("div", { class: "stripe" });
      if (set) stripe.style.background = "hsl(" + setHue(set) + ",55%,55%)";

      var dur = el("input", { class: "dur", type: "text", inputmode: "numeric",
                              value: e.panel_duration != null ? Math.round(e.panel_duration) : "",
                              title: canSetDur(e) ? "Seconds per panel"
                                : "Timing comes from the clip trims" });
      if (!canSetDur(e)) dur.disabled = true;
      dur.addEventListener("click", function (ev) { ev.stopPropagation(); });
      dur.addEventListener("change", function () { setDur(i, dur.value); });

      var up = el("button", { class: "iconbtn", title: "Move up", text: "▲" });
      var down = el("button", { class: "iconbtn", title: "Move down", text: "▼" });
      var del = el("button", { class: "iconbtn del", title: "Remove", text: "✕" });
      up.addEventListener("click", function (ev) { ev.stopPropagation(); move(i, i - 1); });
      down.addEventListener("click", function (ev) { ev.stopPropagation(); move(i, i + 1); });
      del.addEventListener("click", function (ev) { ev.stopPropagation(); removeAt(i); });

      var row = el("div", {
        class: "row" + (pv ? " pv" : "") + (warnRows[i] ? " warn-row" : ""), draggable: "true"
      }, [
        stripe,
        el("span", { class: "grip", text: "⠿" }),
        el("span", { class: "ttl" + (e._live || c.live ? " is-live" : ""),
                     text: e._title || c.title || e.slug }),
        el("span", { class: "meta", text: (atoms ? atoms.length + "a" : "—") + " · " + fmtDur(e.duration) }),
        dur,
        el("span", { class: "rowbtns" }, [up, down, del])
      ]);
      row.addEventListener("click", function () {
        showPreview("deck", i, e._title || c.title || e.slug, e.slug, [e]);
      });
      row.addEventListener("dragstart", function (ev) {
        ev.dataTransfer.setData("text/plain", String(i));
        ev.dataTransfer.effectAllowed = "move";
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", function () { row.classList.remove("dragging"); });
      list.appendChild(row);
      list.appendChild(caretEl(i + 1));
    });
  }

  function renderChecks() {
    var box = $("#warnings");
    box.innerHTML = "";
    var ws = warnings();
    $("#check-ok").textContent = !slides().length ? "" : (ws.length ? "" : "nothing to flag");
    ws.forEach(function (w) {
      box.appendChild(el("div", { class: "warn-line" + (w.bad ? " bad" : ""), html: w.text }));
    });
  }

  /* One flat candidate list over all three sources, because "what do I put here" is
     one question. Kind drives the badge, the group and the filter. */
  function candidates() {
    if (!state.cat) return [];
    var out = [];
    (state.cat.decks || []).forEach(function (d) {
      out.push({ kind: "deck", badge: "show", group: "Slideshows", slug: d.slug,
                 title: d.title, meta: d.slides + " slides" });
    });
    (state.cat.sets || []).forEach(function (s) {
      out.push({ kind: "set", badge: "set", group: "Match packages", slug: s.slug,
                 title: s.title, meta: s.members.length + " slides" });
    });
    (state.cat.slides || []).forEach(function (s) {
      out.push({ kind: "slide", badge: "slide", live: s.live,
                 group: s.set ? (state.setTitle[s.set] || s.set) : "Slides",
                 slug: s.slug, title: s.title,
                 meta: (s.atoms == null ? "feed" : s.atoms + "a") + " · " + fmtDur(s.duration) });
    });
    return out;
  }

  function renderResults() {
    var box = $("#results");
    box.innerHTML = "";
    var used = {};
    slides().forEach(function (e) { used[e.slug] = 1; });
    var q = state.search.toLowerCase();
    var rows = candidates().filter(function (c) {
      if (state.kind && c.kind !== state.kind) return false;
      return !q || c.title.toLowerCase().indexOf(q) >= 0 || c.slug.toLowerCase().indexOf(q) >= 0;
    });
    if (!rows.length) {
      box.appendChild(el("div", { class: "empty-hint", text: "Nothing matches that." }));
      return;
    }
    var group = null;
    rows.forEach(function (c) {
      if (c.group !== group) {
        group = c.group;
        box.appendChild(el("div", { class: "res-group", text: group }));
      }
      var add = el("button", { class: "add", title: "Add to the deck at the caret", text: "+" });
      add.addEventListener("click", function (ev) {
        ev.stopPropagation();
        entriesFor(c.kind, c.slug).then(function (entries) {
          if (entries.length) insertAt(entries, state.caret);
          else status("no built entry for " + c.slug);
        });
      });
      var pv = state.pv && state.pv.where === "find" && state.pv.id === c.slug;
      var row = el("div", { class: "res" + (pv ? " pv" : "") + (used[c.slug] ? " in-deck" : "") }, [
        el("span", { class: badgeClass(c.badge), text: c.badge }),
        el("span", { class: "ttl" + (c.live ? " is-live" : ""), text: c.title }),
        el("span", { class: "meta", text: used[c.slug] ? "in deck" : c.meta }),
        add
      ]);
      // Click previews without adding — the whole point of the discover pane.
      row.addEventListener("click", function () {
        entriesFor(c.kind, c.slug).then(function (entries) {
          if (entries.length) showPreview("find", c.slug, c.title, c.slug, entries);
          else status("no built entry for " + c.slug);
        });
      });
      box.appendChild(row);
    });
  }

  function render() {
    renderDeck();
    renderChecks();
    renderResults();
    renderPreview();
  }

  // ---- preview ----------------------------------------------------------
  /* An *injected* deck of whatever is being previewed, not the slide's own auto-deck
     page. Two reasons, both found the first time this ran locally:

     - `/slideshow/<slug>/` is not a page for a single slide. The auto-deck loop
       writes data.json + precache.json only; the shell plays them as
       `/slideshow/?deck=<slug>`. Pointing an iframe at the directory gets a 404.
     - A *built* deck runs the hard loading gate, which primes every clip into the
       cache before revealing a frame. Previewing a 29-clip reel that way would
       download the whole reel first. An injected deck skips the gate, the precache
       fetch, the version poll and (since 6b) the live feed — exactly what an editor
       preview wants.

     It is also what lets a search result be previewed *before* it is added: the
     preview deck is assembled from fetched entries, and the draft is not touched.

     `?interactive` so it starts paused and steps by hand; `?ctx=archive` because
     archive wording is what the render will say, and what a narrator would read. */

  function previewUrl(tag) {
    return "/slideshow/?deck=local:" + PREVIEW_KEY + "&interactive&ctx=" + state.ctx
         + "&s=" + encodeURIComponent(tag);
  }

  function showPreview(where, id, title, tag, entries) {
    if (window.WccDeckStore) WccDeckStore.put(PREVIEW_KEY, { title: title, slides: entries });
    state.pv = { where: where, id: id, title: title, slug: tag,
                 url: previewUrl(tag), n: entries.length };
    render();
  }

  function renderPreview() {
    var frame = $("#preview"), none = $("#preview-none");
    $("#preview-open").hidden = !state.pv;   // nothing to open
    if (!state.pv) {
      frame.hidden = true; frame.removeAttribute("src");
      none.hidden = false;
      $("#preview-title").textContent = "Nothing selected";
      return;
    }
    if (frame.getAttribute("src") !== state.pv.url) frame.setAttribute("src", state.pv.url);
    frame.hidden = false;
    none.hidden = true;
    $("#preview-title").innerHTML = state.pv.title + " <i>· " + state.pv.slug
      + (state.pv.n > 1 ? " · " + state.pv.n + " slides" : "") + "</i>";
  }

  function playDeck() {
    if (!slides().length) return;
    persist();
    window.open("/slideshow/?deck=local:" + encodeURIComponent(state.key)
                + "&interactive&ctx=" + state.ctx, "_blank");
  }

  // ---- export / import --------------------------------------------------

  function exportDeck() {
    if (!state.deck) return;
    var doc = {
      title: state.deck.title,
      slides: state.deck.slides,
      build_version: state.deck.build_version || (state.cat && state.cat.build_version),
      source: "builder"
    };
    var blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    var a = el("a", { href: URL.createObjectURL(blob),
                      download: fileSlug(state.deck.title) + ".deck.json" });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function importDeck(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var d = JSON.parse(fr.result);
        if (!d || !Array.isArray(d.slides)) throw new Error("not a deck");
        newDeck(d.title || file.name.replace(/\.(deck\.)?json$/, ""), d.slides);
      } catch (e) { status("could not read that file"); }
    };
    fr.readAsText(file);
  }

  // ---- chrome -----------------------------------------------------------

  function fillDrafts() {
    var sel = $("#draft-picker");
    sel.innerHTML = "";
    var keys = draftKeys();
    if (!keys.length) sel.appendChild(el("option", { value: "", text: "(no decks yet)" }));
    keys.forEach(function (k) {
      var d = (window.WccDeckStore && WccDeckStore.get(k)) || {};
      var n = (d.slides || []).length;
      sel.appendChild(el("option", { value: k, text: (d.title || k) + " — " + n + " slides" }));
    });
    if (state.key) sel.value = state.key;
  }

  function closeMenu() { $("#deck-menu").removeAttribute("open"); }

  function wire() {
    $("#draft-picker").addEventListener("change", function () {
      if (this.value) openDraft(this.value);
    });
    $("#m-new").addEventListener("click", function () {
      closeMenu();
      var t = prompt("Name for the new deck", "Untitled deck");
      if (t !== null) newDeck(t.trim() || "Untitled deck", []);
    });
    $("#m-rename").addEventListener("click", function () {
      closeMenu();
      if (!state.deck) return;
      var t = prompt("Deck name", state.deck.title);
      if (t === null) return;
      state.deck.title = t.trim() || "Untitled deck";
      persist();          // also re-stamps the status line with the new name
      fillDrafts();
    });
    $("#m-duplicate").addEventListener("click", function () {
      closeMenu();
      if (!state.deck) return;
      newDeck(state.deck.title + " copy", JSON.parse(JSON.stringify(state.deck.slides)));
    });
    $("#m-delete").addEventListener("click", function () {
      closeMenu();
      if (!state.key || !confirm("Delete “" + state.deck.title + "”? This cannot be undone.")) return;
      if (window.WccDeckStore) WccDeckStore.remove(state.key);
      state.key = null;
      var keys = draftKeys();
      if (keys.length) openDraft(keys[0]);
      else newDeck("Untitled deck", []);
    });
    $("#export-btn").addEventListener("click", exportDeck);
    $("#play-btn").addEventListener("click", playDeck);
    $("#import-input").addEventListener("change", function (ev) {
      if (ev.target.files && ev.target.files[0]) importDeck(ev.target.files[0]);
      ev.target.value = "";
    });
    // A <details> menu does not close on an outside click by itself.
    document.addEventListener("click", function (ev) {
      var m = $("#deck-menu");
      if (m.hasAttribute("open") && !m.contains(ev.target)) m.removeAttribute("open");
    });

    $("#preview-open").addEventListener("click", function () {
      if (state.pv) window.open(state.pv.url, "_blank");
    });
    $("#ctx-seg").addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-ctx]");
      if (!b) return;
      state.ctx = b.dataset.ctx;
      Array.prototype.forEach.call(this.querySelectorAll("button"), function (x) {
        x.classList.toggle("on", x.dataset.ctx === state.ctx);
      });
      // Force a re-load in the new context (the stored deck itself is unchanged).
      if (state.pv) {
        state.pv.url = previewUrl(state.pv.slug);
        $("#preview").removeAttribute("src");
      }
      renderPreview();
    });
    $("#find-seg").addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-kind]");
      if (!b) return;
      state.kind = b.dataset.kind;
      Array.prototype.forEach.call(this.querySelectorAll("button"), function (x) {
        x.classList.toggle("on", x.dataset.kind === state.kind);
      });
      renderResults();
    });
    $("#find-search").addEventListener("input", function () {
      state.search = this.value.trim();
      renderResults();
    });
  }

  fetch(CAT_URL).then(function (r) { return r.json(); }).then(function (cat) {
    state.cat = cat;
    (cat.slides || []).forEach(function (s) {
      state.bySlug[s.slug] = s;
      if (s.set) state.setOf[s.slug] = s.set;
    });
    (cat.sets || []).forEach(function (s) { state.setTitle[s.slug] = s.title; });
    wire();

    var last = null;
    try { last = localStorage.getItem(LAST_KEY); } catch (e) {}
    var keys = draftKeys();
    if (!(last && keys.indexOf(last) >= 0 && openDraft(last))) {
      if (keys.length) openDraft(keys[0]);
      else newDeck("Untitled deck", []);
    }
  }).catch(function () {
    status("could not load /slides.json — has the site been built?");
  });
})();

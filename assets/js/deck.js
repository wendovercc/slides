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
    open: {},           // group key → expanded? (see groupKey)
    kind: "",           // discover filter: "" | deck | slide (see kindOf)
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
  function titleOf(e) { return e._title || (state.bySlug[e.slug] || {}).title || e.slug; }

  /* ---- groups ------------------------------------------------------------
     A GROUP is the unit an editor manages: a match package, or a multi-panel
     slide. They are the same creature on the wall — both render a `.panel-tab`
     strip, one via _set_header.html and one via _panel_nav.html — so they are the
     same creature here. See docs/narrated-decks.md, "Naming the levels".

     Derived on every render, never stored. The deck document stays the flat list
     of slides the player consumes, so a deck arriving from anywhere — an authored
     slideshow, an older draft, an export — groups itself with no migration. */

  function groupOf(e) { return e._group || state.setOf[e.slug] || null; }

  // A group's identity for UI state (which rows are open). A package is its set;
  // a lone slide is its slug — not its index, so opening a row survives a reorder.
  function groupKey(g) { return g.set || slides()[g.from].slug; }

  function groups() {
    var arr = slides();
    var out = [];
    arr.forEach(function (e, i) {
      var g = groupOf(e);
      var prev = out[out.length - 1];
      // Contiguity is the test, so a split package reads as two groups — which is
      // what it will play as, and what the deck check already warns about.
      if (g && prev && prev.set === g) { prev.idx.push(i); return; }
      out.push({ set: g, idx: [i] });
    });
    out.forEach(function (g) {
      g.from = g.idx[0];
      g.title = g.set ? (state.setTitle[g.set] || g.set) : titleOf(arr[g.from]);
      g.children = childrenOf(g);
    });
    return out;
  }

  /* A child's name within its group: the slide's own title minus the group's,
     which is a prefix of it by construction — `slide_title_parts` builds both from
     the same header levels, so "Last Match · 1st XI · 1st Innings · Batting" under
     "Last Match · 1st XI" is "1st Innings · Batting". Falls back to the whole title
     when the two don't line up, which a hand-authored deck can arrange. */
  function leafOf(e, prefix) {
    var t = titleOf(e);
    return (prefix && t.indexOf(prefix + " · ") === 0) ? t.slice(prefix.length + 3) : t;
  }

  /* A group's child rows — the level the wall's tab strip steps through.

     For a package that is its member slides; for a multi-panel slide, its panels.
     A reel is ONE child however many clips it holds: it is one entry on the wall's
     strip, and its clips are curated in /curate rather than picked over here. */
  function childrenOf(g) {
    var arr = slides();
    if (g.idx.length > 1) {
      return g.idx.map(function (i) {
        return { i: i, panel: null, label: leafOf(arr[i], g.title), e: arr[i] };
      });
    }
    var i = g.idx[0], e = arr[i], atoms = entryAtoms(e);
    if (isVideo(e) || !atoms || allAtoms(e).length < 2) {
      return [{ i: i, panel: null, label: leafOf(e, g.title), e: e }];
    }
    var kept = keptPanels(e);
    return allAtoms(e).map(function (a, n) {
      return { i: i, panel: n, e: e, atom: a, on: kept.indexOf(n) >= 0,
               label: a.label || a.phase || ("Panel " + (n + 1)) };
    });
  }

  /* ---- panel subsets -----------------------------------------------------
     `_atoms` is the KEPT atoms, renumbered to ordinals — exactly what
     `_apply_panel_subset` does in build.py, because the two have to agree: the
     same deck document is rendered by timeline.py whichever produced it.

     `_atoms_all` holds the slide's full list in its own panel numbering, and
     exists only on an entry that has been subsetted. It is what makes the toggle
     reversible: without it a switched-off panel's label and dwell are simply gone,
     and turning it back on would mean re-fetching the slide. */

  function allAtoms(e) { return e._atoms_all || e._atoms || []; }

  function keptPanels(e) {
    if (e.panels) return e.panels.slice();
    return allAtoms(e).map(function (_, n) { return n; });
  }

  // Back to the whole slide. Both keys go rather than carrying a redundant list,
  // matching what the build does with a subset that turns out to be everything.
  function restoreAtoms(e) {
    if (!e.panels && !e._atoms_all) return false;
    e._atoms = allAtoms(e);
    delete e._atoms_all;
    delete e.panels;
    e.duration = e._atoms.reduce(function (a, x) { return a + (x.duration || 0); }, 0);
    return true;
  }

  function setPanels(i, kept) {
    var e = slides()[i];
    if (!e || isVideo(e)) return;
    var all = allAtoms(e);
    kept = kept.slice().sort(function (a, b) { return a - b; });
    // An empty subset is not a slide. Removing the last atom is removing the row,
    // which is what the group's own ✕ is for.
    if (!kept.length) return;
    if (kept.length === all.length) {
      restoreAtoms(e);
    } else {
      e._atoms_all = all;
      e.panels = kept;
      e._atoms = kept.map(function (p, n) {
        var a = {}; Object.keys(all[p]).forEach(function (k) { a[k] = all[p][k]; });
        a.panel = n;
        return a;
      });
    }
    e.duration = e._atoms.reduce(function (a, x) { return a + (x.duration || 0); }, 0);
    if (state.pv && state.pv.where === "deck") state.pv = null;
    persist();
    render();
  }

  function togglePanel(i, panel) {
    var e = slides()[i];
    if (!e) return;
    var kept = keptPanels(e);
    var at = kept.indexOf(panel);
    if (at >= 0) kept.splice(at, 1); else kept.push(panel);
    setPanels(i, kept);
  }

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
    // `_atoms_all` too, or a panel switched back on would return at the old dwell.
    (e._atoms || []).forEach(function (a) { a.duration = v; });
    (e._atoms_all || []).forEach(function (a) { a.duration = v; });
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

  function newDeck(title, entries, extra) {
    state.deck = Object.assign(
      { title: title || "Untitled deck", slides: entries || [], source: "builder",
        build_version: state.cat && state.cat.build_version }, extra || {});
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

  // ---- live reel clips --------------------------------------------------
  /* A reel row does not own a copy of its clips — it resolves them from whatever
     curation the editor is working on right now, every render. Flip to /curate, add
     a ball, flip back: it is already there, with nothing to attach or re-attach.
     See docs/narrated-decks.md, "Clips reach a deck by reference, not by copy" —
     including why the *export* carries none of this. */
  var REEL_PREFIX = "wcc-reel:";
  var NEAR = 0.001;   // float slack: /curate computes these bounds in JS

  function reelDraft(e) {
    if (!e || !e._pc_id || e._innings == null) return null;   // not a reel
    try {
      var raw = localStorage.getItem(REEL_PREFIX + e._pc_id + ":" + e._innings);
      var clips = raw ? JSON.parse(raw) : null;
      return (clips && clips.length) ? clips : null;
    } catch (x) { return null; }
  }

  /* The curated clips with an R2 file attached wherever one exists for exactly
     these bounds — `(url, start, end)` is the clip's identity, and what
     clip_ids.fingerprint hashes to name the object.

     If ANY clip has no exact match, the whole reel drops back to the stream. One
     source per reel is an invariant video.html rests on (it picks from clip 0, and
     mp4Source builds a <video> per clip from `_video_src`), so a mixed list would
     not play at all. The cost is that a sitting streams clips it already had — a
     preview concern, and only a comfort problem for narration. */
  function resolveReel(e) {
    var clips = reelDraft(e);
    if (!clips) return null;                      // nothing curated → the built reel
    var built = e._clips || [];
    var out = clips.map(function (c) {
      var hit = null;
      for (var i = 0; i < built.length; i++) {
        var b = built[i];
        if (b.url === c.url && Math.abs(b.start - c.start) < NEAR
                            && Math.abs(b.end - c.end) < NEAR) { hit = b; break; }
      }
      return hit ? Object.assign({}, c, { _video_src: hit.src }) : Object.assign({}, c);
    });
    if (out.some(function (c) { return !c._video_src; })) {
      out.forEach(function (c) { delete c._video_src; });
    }
    return out;
  }

  /* The entry as it should be PLAYED — a copy, never the stored entry. The deck
     document keeps naming the slide and nothing else, so an export cannot pick up
     a sitting's YouTube segments (which carry no `_atoms` and would silently drop
     the whole reel from a render). */
  function playable(e) {
    var clips = resolveReel(e);
    return clips ? Object.assign({}, e, { videos: clips }) : e;
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

  function removeAt(i) {
    slides().splice(i, 1);
    if (state.caret > i) state.caret--;
    if (state.pv && state.pv.where === "deck") state.pv = null;
    persist();
    fillDrafts();
    render();
  }

  /* Group-level reorder and remove. The group is what an editor moves — a package
     travels as a block, which is also why the split warning can no longer be
     caused from in here. Rebuilding the deck from the reordered blocks is simpler
     than index arithmetic over a run, and cannot leave a package half-moved. */

  function moveGroup(gi, delta) {
    var gs = groups();
    var to = gi + delta;
    if (to < 0 || to >= gs.length || !state.deck) return;
    var arr = slides();
    var blocks = gs.map(function (g) {
      return g.idx.map(function (i) { return arr[i]; });
    });
    blocks.splice(to, 0, blocks.splice(gi, 1)[0]);
    state.deck.slides = [].concat.apply([], blocks);
    state.caret = 0;
    state.pv = null;
    persist();
    render();
  }

  function removeGroup(gi) {
    var g = groups()[gi];
    if (!g) return;
    slides().splice(g.from, g.idx.length);
    if (state.caret > g.from) state.caret = Math.max(g.from, state.caret - g.idx.length);
    if (state.pv && state.pv.where === "deck") state.pv = null;
    persist();
    fillDrafts();
    render();
  }

  /* ---- what the deck already holds of a catalogue row --------------------
     A slug appears at most once in a deck, so `+` never inserts a second copy.
     It means **make this whole**: put back the steps that have been taken out,
     leaving the group where it already is. Restoring must not relocate a package —
     "put Result back" should not silently move the whole thing to the caret.

     `have`/`want` are counted in the same STEPS the rows are measured in, so the
     catalogue can say "7 of 9 steps · in deck" and the `+` can go dead when there
     is nothing left to restore. */

  function setMembers(slug) {
    var st = (state.cat.sets || []).filter(function (x) { return x.slug === slug; })[0];
    return st ? st.members : [];
  }

  function rowSlugs(c) {
    if (c.kind === "deck") return c.members || [];
    if (c.kind === "set") return setMembers(c.slug);
    return [c.slug];
  }

  function rowState(c) {
    var at = {};
    slides().forEach(function (e, i) { if (!(e.slug in at)) at[e.slug] = e; });
    var unit = c.kind === "deck" ? "slide" : "step";

    if (c.kind === "slide") {
      var e = at[c.slug];
      var want = e ? allAtoms(e).length : (c.atoms || 1);
      return { have: e ? keptPanels(e).length : 0, want: want, unit: unit,
               "in": !!e };
    }
    // A package, or a slideshow: one step per member slide.
    //
    // Only a package counts panel subsets against wholeness. A slideshow's `+` adds
    // the slides it does not already hold and nothing else — it has no in-place
    // restore — so letting a member's switched-off panel mark it incomplete would
    // leave a live button with nothing to do.
    var slugs = rowSlugs(c), have = 0, subset = false;
    slugs.forEach(function (m) {
      var e = at[m];
      if (!e) return;
      have++;
      if (e.panels) subset = true;
    });
    return { have: (subset && c.kind === "set") ? have - 0.5 : have,
             want: slugs.length, unit: unit, "in": have > 0 };
  }

  function isWhole(st) { return st.have >= st.want; }

  /* `+`. Three shapes, one meaning.

     A slideshow contributes only the slugs the draft does not already hold, at the
     caret: its missing slides have no group to slot back into, so "make whole" has
     no in-place sense for one. A package rebuilds its run where it stands. A slide
     just gets its panels back. */
  function addRow(c) {
    var st = rowState(c);
    if (isWhole(st)) return;
    if (c.kind === "deck" || !st["in"]) return insertMissing(c);
    return c.kind === "set" ? restoreSet(c) : restoreSlide(c);
  }

  function insertMissing(c) {
    return entriesFor(c.kind, c.slug).then(function (entries) {
      var at = {};
      slides().forEach(function (e) { at[e.slug] = 1; });
      // Only what the draft does not already hold: a slug appears at most once.
      var fresh = entries.filter(function (e) { return !at[e.slug]; });
      if (fresh.length) insertAt(fresh, state.caret);
      // Nothing fresh is not an error — the row's `+` is disabled once it is whole,
      // so reaching here means everything it offered was already in.
      else if (!entries.length) status("no built entry for " + c.slug);
    });
  }

  function restoreSlide(c) {
    var arr = slides();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].slug !== c.slug) continue;
      if (restoreAtoms(arr[i])) { persist(); }
      openGroupAt(i);
      render();
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  /* Rebuild a package's run from the set's own ordered member list, reusing the
     entries already in the deck so an edited dwell (or a kept panel subset that the
     restore then clears) is not silently reset — only the missing members arrive
     fresh. Anything in the run the set no longer lists is kept at the end rather
     than dropped: a member retired between builds is still the editor's content. */
  function restoreSet(c) {
    return entriesFor("set", c.slug).then(function (full) {
      if (!full.length) { status("no built entry for " + c.slug); return; }
      var g = groups().filter(function (x) { return x.set === c.slug; })[0];
      if (!g) { insertAt(full, state.caret); return; }
      var arr = slides();
      var mine = {};
      g.idx.forEach(function (i) { mine[arr[i].slug] = arr[i]; });
      var run = full.map(function (f) {
        var keep = mine[f.slug];
        if (!keep) return f;
        delete mine[f.slug];
        restoreAtoms(keep);
        return keep;
      });
      Object.keys(mine).forEach(function (k) { run.push(mine[k]); });
      Array.prototype.splice.apply(arr, [g.from, g.idx.length].concat(run));
      state.open[c.slug] = true;
      persist();
      fillDrafts();
      render();
    });
  }

  // Expand whichever group an entry now sits in, so a restore is visible where it
  // happened rather than announced somewhere else.
  function openGroupAt(i) {
    groups().forEach(function (g) {
      if (g.idx.indexOf(i) >= 0) state.open[groupKey(g)] = true;
    });
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
      } else if (resolveReel(e)) {
        var lv = resolveReel(e);
        out.push({ row: i, text: name + " is showing your live curation ("
          + lv.length + " clips" + (lv.some(function (x) { return !x._video_src; })
            ? ", streaming from YouTube — some are not in R2 yet" : "") + "). "
          + "The export names the slide only; the publisher's rebuild supplies the clips." });
      } else if (isVideo(e) && !(e.videos || e._videos || []).length) {
        // Checked BEFORE the atom test: an unfilled reel has an empty atom list, and
        // "no clips yet" is the useful half of that. It is the expected state during
        // the sitting, not a fault.
        out.push({ row: i, text: name + " has no clips yet — attach a curated reel, or "
          + "it renders after the publisher's rebuild syncs them to R2." });
      } else if (!entryAtoms(e)) {
        out.push({ row: i, bad: true, text: name + " has no atom list — it cannot be rendered." });
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

  /* Badges separate a whole slideshow from everything else, and nothing finer. A
     match package and a multi-panel slide both read "slide", because to an editor
     they are the same creature — the step count in the meta column is what says how
     much a `+` will add, and it says it in one unit for both.

     They no longer say which template a slide uses either: the name is now its own
     header hierarchy ("Last Match · 1st XI · 1st Innings · Batting"), which
     identifies it far better than a template name did. Deck rows carry no badge at
     all. `live` colours the title instead, being a warning rather than a category. */
  function badgeClass(kind) {
    return "kind" + (kind === "show" ? " k-deck" : "");
  }

  /* Insertion points sit BETWEEN groups, not between slides. That follows from the
     group being the unit: a package travels as a block, so there is no longer a
     caret inside one, and the "package is split" warning becomes a state this page
     cannot produce (it still fires for a deck that arrives split from elsewhere).

     `at` is the entry index the caret inserts at; `gi` is the group index it sits
     before, which is what a drag drops against. */
  function caretEl(at, gi) {
    var n = el("div", { class: "caret" + (state.caret === at ? " active" : ""), "data-at": at });
    n.addEventListener("click", function () { state.caret = at; render(); });
    n.addEventListener("dragover", function (ev) { ev.preventDefault(); n.classList.add("drop"); });
    n.addEventListener("dragleave", function () { n.classList.remove("drop"); });
    n.addEventListener("drop", function (ev) {
      ev.preventDefault();
      n.classList.remove("drop");
      var from = Number(ev.dataTransfer.getData("text/plain"));
      if (isNaN(from)) return;
      moveGroup(from, (gi > from ? gi - 1 : gi) - from);
    });
    return n;
  }

  /* One row per GROUP, expandable to its children. A package and a multi-panel
     slide render through this one path — which is the point: they look the same on
     the wall, so they look the same here. A group with a single child (an ordinary
     one-panel slide) gets no expander, because there is nothing under it to see. */
  function renderDeck() {
    var list = $("#deck-list");
    list.innerHTML = "";
    var arr = slides();
    var gs = groups();
    $("#play-btn").hidden = !arr.length;   // nothing to play
    // Steps, not slides: the same unit the group rows and the catalogue are
    // measured in, so the summary adds up to what is written down the list.
    var nSteps = gs.reduce(function (a, g) {
      return a + g.children.filter(function (c) { return c.panel === null || c.on; }).length;
    }, 0);
    $("#deck-count").textContent = arr.length
      ? nSteps + " step" + (nSteps === 1 ? "" : "s") + " · "
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

    gs.forEach(function (g, gi) {
      list.appendChild(caretEl(g.from, gi));
      list.appendChild(groupRow(g, gi, warnRows));
      if (state.open[groupKey(g)] && g.children.length > 1) {
        g.children.forEach(function (c) { list.appendChild(childRow(g, c)); });
      }
    });
    list.appendChild(caretEl(arr.length, gs.length));
  }

  // The reel-clip meta a row shows, resolved against the editor's live curation
  // rather than the build — otherwise adding a ball leaves the row saying 10.
  function clipMeta(e) {
    var live = resolveReel(e);
    if (!live) return null;
    return live.length + " clip" + (live.length === 1 ? "" : "s") + " · "
      + fmtDur(live.reduce(function (a, x) { return a + (x.end - x.start); }, 0));
  }

  function groupRow(g, gi, warnRows) {
    var arr = slides();
    var lead = arr[g.from];
    var solo = g.children.length <= 1;    // an ordinary slide: no expander, no children
    var open = !!state.open[groupKey(g)];
    var dur = g.idx.reduce(function (a, i) { return a + (arr[i].duration || 0); }, 0);
    var live = solo ? clipMeta(lead) : null;
    // Steps, not atoms: what the wall's tab strip moves through. A package counts
    // its members, a carousel its panels, and a reel counts as the one strip entry
    // it is — so "9 steps" and "4 steps" mean the same thing on both kinds of row.
    var kept = g.children.filter(function (c) { return c.panel === null || c.on; }).length;
    var meta = live || (solo ? fmtDur(dur)
      : kept + (kept === g.children.length ? "" : " of " + g.children.length)
        + " step" + (kept === 1 ? "" : "s") + " · " + fmtDur(dur));

    var stripe = el("div", { class: "stripe" });
    if (g.set) stripe.style.background = "hsl(" + setHue(g.set) + ",55%,55%)";

    var twist = el("span", { class: "twist" + (open ? " open" : ""),
                             text: solo ? "" : (open ? "▾" : "▸") });
    if (!solo) {
      twist.addEventListener("click", function (ev) {
        ev.stopPropagation();
        state.open[groupKey(g)] = !open;
        render();
      });
    }

    var up = el("button", { class: "iconbtn", title: "Move up", text: "▲" });
    var down = el("button", { class: "iconbtn", title: "Move down", text: "▼" });
    var del = el("button", { class: "iconbtn del", title: "Remove", text: "✕" });
    up.addEventListener("click", function (ev) { ev.stopPropagation(); moveGroup(gi, -1); });
    down.addEventListener("click", function (ev) { ev.stopPropagation(); moveGroup(gi, 1); });
    del.addEventListener("click", function (ev) { ev.stopPropagation(); removeGroup(gi); });

    // The dwell box sits wherever a single `panel_duration` is the honest answer:
    // on the group row when the group IS one slide, and on the child rows of a
    // package, whose members each have their own. A package's group row therefore
    // has none — there is no one number to put in it.
    // Only a solo group can be the preview target: a package's row expands rather
    // than previews, so highlighting it when its first member is previewed would
    // light two rows for one thing.
    var pv = solo && state.pv && state.pv.where === "deck" && state.pv.id === g.from;
    var warn = g.idx.some(function (i) { return warnRows[i]; });
    var row = el("div", {
      class: "row grow" + (pv ? " pv" : "") + (warn ? " warn-row" : "") + (solo ? "" : " has-kids"),
      draggable: "true"
    }, [
      stripe,
      el("span", { class: "grip", text: "⠿" }),
      twist,
      el("span", { class: "ttl" + (lead._live ? " is-live" : ""), text: g.title }),
      el("span", { class: "meta" + (live ? " curating" : ""), text: meta }),
      solo ? durBox(g.from) : el("span", { class: "dur-gap" }),
      el("span", { class: "rowbtns" }, [up, down, del])
    ]);
    row.addEventListener("click", function () {
      if (!solo) { state.open[groupKey(g)] = !open; render(); return; }
      showPreview("deck", g.from, g.title, lead.slug, [lead]);
    });
    row.addEventListener("dragstart", function (ev) {
      ev.dataTransfer.setData("text/plain", String(gi));
      ev.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", function () { row.classList.remove("dragging"); });
    return row;
  }

  /* A child row is one step of the group. Turning one off is ONE operation to the
     editor and two underneath — dropping a deck entry for a package member,
     `panels` for a carousel panel — which is the asymmetry this whole grouping
     exists to hide. */
  // A child's preview identity. A whole-entry child is its deck index; a panel is
  // "<index>:<panel>", since one entry holds several previewable steps.
  function childPv(c) { return c.panel === null ? c.i : c.i + ":" + c.panel; }

  function childRow(g, c) {
    var isPanel = c.panel !== null;
    var off = isPanel && !c.on;
    var live = isPanel ? null : clipMeta(c.e);
    var meta = live || (isPanel ? fmtDur(c.atom.duration) : fmtDur(c.e.duration));
    var pv = state.pv && state.pv.where === "deck" && state.pv.id === childPv(c);

    var del = el("button", {
      class: "iconbtn del", text: off ? "＋" : "✕",
      title: off ? "Put this step back" : "Take this step out"
    });
    del.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (isPanel) { togglePanel(c.i, c.panel); return; }
      // The last member of a package is the package: removing it removes the group,
      // which removeAt does anyway. Guarding would only strand an empty group.
      removeAt(c.i);
    });

    var row = el("div", { class: "crow" + (off ? " off" : "") + (pv ? " pv" : "") }, [
      el("span", { class: "kid-rule" }),
      el("span", { class: "ttl", text: c.label }),
      el("span", { class: "meta" + (live ? " curating" : ""), text: off ? "off" : meta }),
      isPanel ? el("span", { class: "dur-gap" }) : durBox(c.i),
      el("span", { class: "rowbtns" }, [del])
    ]);
    /* Every step previews, whichever kind it is — which is the point of the
       grouping. A package member is a slide, so it previews as one. A panel has no
       page of its own (/slide/<slug>/ always opens at panel 0, and the `&start=`
       parameter was never built) — but the preview pane injects a deck, so a
       one-panel deck IS the preview. `set-panels` does the rest, and no new player
       capability is needed: the mechanism built for subsetting a deck entry turns
       out to be exactly the mechanism for previewing one step of it. */
    row.addEventListener("click", function () {
      if (!isPanel) { showPreview("deck", c.i, c.label, c.e.slug, [c.e]); return; }
      // Shaped exactly as _apply_panel_subset would: `panels` names the slide's own
      // panel, `_atoms` is the kept one renumbered to ordinal 0.
      var one = Object.assign({}, c.e, {
        panels: [c.panel],
        _atoms: [Object.assign({}, c.atom, { panel: 0 })],
        duration: c.atom.duration
      });
      delete one._atoms_all;
      showPreview("deck", childPv(c), g.title + " · " + c.label, c.e.slug, [one]);
    });
    return row;
  }

  // Seconds-per-panel for one entry. Blank and disabled on a reel, deliberately:
  // its panels are clips with individual durations, so there is no single number,
  // and its `panel_duration` is the `total + 30` backstop build_video_slide sets —
  // which reads as a duration and is not one. The meta column carries the total.
  function durBox(i) {
    var e = slides()[i];
    var ok = canSetDur(e);
    var box = el("input", { class: "dur", type: "text", inputmode: "numeric",
                            value: ok && e.panel_duration != null ? Math.round(e.panel_duration) : "",
                            title: ok ? "Seconds per panel"
                              : "Per-clip, from the trims — see the total alongside" });
    if (!ok) box.disabled = true;
    box.addEventListener("click", function (ev) { ev.stopPropagation(); });
    box.addEventListener("change", function () { setDur(i, box.value); });
    return box;
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

  /* One flat candidate list over all three sources, because "what do I put here"
     is one question. Kind drives the badge, the group and the filter.

     The catalogue stays GROUPED: one row per group, and it never expands. A search
     result offering a single panel of a slide would be the additive UI that "Panel
     subsets" rejected — you add the whole thing and subtract in the deck, which is
     where the editor is working on something they have already chosen. So package
     members are not listed on their own: the package row is what represents them,
     and its step count says how much the `+` will add.

     That is also what keeps /slides.json thin. A collapsed row needs a title and a
     count, both already published, and never the atom NAMES — so the catalogue
     does not carry a second copy of them. */
  function candidates() {
    if (!state.cat) return [];
    var out = [];
    (state.cat.decks || []).forEach(function (d) {
      out.push({ kind: "deck", badge: "show", group: "Slideshows", slug: d.slug,
                 title: d.title, members: d.members || [], meta: d.slides + " slides" });
    });
    /* Packages and slides share one list and one heading. They are one creature to
       an editor, so a separate "Match packages" section was the last place the
       catalogue still said otherwise. `kind` stays split underneath — it is what
       entriesFor and restoreSet dispatch on — but nothing above it does.

       Sorted by title, which puts a package next to the slides it reads like
       ("Last Match · 1st XI" beside "Leaderboards · …") rather than in a block of
       its own. */
    var mixed = [];
    (state.cat.sets || []).forEach(function (s) {
      var dur = 0, tmpl = [];
      s.members.forEach(function (m) {
        var c = state.bySlug[m] || {};
        dur += c.duration || 0;
        if (c.template && tmpl.indexOf(c.template) < 0) tmpl.push(c.template);
      });
      mixed.push({ kind: "set", badge: "slide", group: "Slides", slug: s.slug,
                   title: s.title, templates: tmpl, meta: steps(s.members.length, dur) });
    });
    (state.cat.slides || []).forEach(function (s) {
      // A package member has no row of its own — see above.
      if (s.set) return;
      mixed.push({ kind: "slide", badge: "slide", live: s.live, group: "Slides",
                   slug: s.slug, title: s.title, atoms: s.atoms,
                   templates: s.template ? [s.template] : [],
                   meta: s.atoms == null ? "feed"
                       : s.template === "video"
                         ? s.atoms + " clip" + (s.atoms === 1 ? "" : "s") + " · " + fmtDur(s.duration)
                         : steps(s.atoms, s.duration) });
    });
    mixed.sort(function (a, b) { return a.title.localeCompare(b.title); });
    return out.concat(mixed);
  }

  /* What a row matches on. The template is in here but not on the badge: it names a
     CATEGORY for the repeated generic slides ("cta", "announcement", "schedule")
     and the slide's own identity for the one-offs ("fantasy-league", "sponsors"),
     so it is worth searching and not worth showing. A package matches on any of its
     members' templates, which is the only way it could — it spans five of them. */
  function searchText(c) {
    return (c.title + " " + c.slug + " " + (c.templates || []).join(" ")).toLowerCase();
  }

  // Shows are one thing; a package and a slide are the same thing. That is the only
  // split the discover filter makes.
  function kindOf(c) { return c.kind === "deck" ? "deck" : "slide"; }

  // The one unit both kinds of group are measured in — what the wall's tab strip
  // steps through. A one-step row says only its duration; "1 step" is noise.
  function steps(n, dur) {
    return (n > 1 ? n + " steps · " : "") + fmtDur(dur);
  }

  function renderResults() {
    var box = $("#results");
    box.innerHTML = "";

    var q = state.search.toLowerCase();
    var rows = candidates().filter(function (c) {
      if (state.kind && kindOf(c) !== state.kind) return false;
      return !q || searchText(c).indexOf(q) >= 0;
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
      // What the deck already holds of this row decides both the meta and whether
      // `+` has anything left to do — see rowState.
      var st = rowState(c);
      var whole = isWhole(st);
      var partial = st["in"] && !whole;
      var add = el("button", {
        class: "add", text: "+",
        title: whole ? "Already in the deck"
             : partial ? "Put the missing " + st.unit + "s back"
             : "Add to the deck at the caret"
      });
      if (whole) add.disabled = true;
      else add.addEventListener("click", function (ev) { ev.stopPropagation(); addRow(c); });

      var meta = whole ? "in deck"
               : partial ? Math.floor(st.have) + " of " + st.want + " "
                           + st.unit + "s · in deck"
               : c.meta;
      var pv = state.pv && state.pv.where === "find" && state.pv.id === c.slug;
      var row = el("div", { class: "res" + (pv ? " pv" : "")
                            + (whole ? " in-deck" : "") + (partial ? " part" : "") }, [
        el("span", { class: badgeClass(c.badge), text: c.badge }),
        el("span", { class: "ttl" + (c.live ? " is-live" : ""), text: c.title }),
        el("span", { class: "meta", text: meta }),
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

  /* The frame boots ONCE off the injected deck, and its URL says nothing about the
     clips inside it — so re-injecting alone would leave a stale reel on screen and
     renderPreview's src check would agree. This nonce is what makes a reload
     expressible. It only moves when the injected clips actually changed, so
     re-selecting the same row still doesn't restart playback. */
  var pvNonce = 0;
  var pvDoc = null;      // the deck currently injected, as JSON — see inject()

  function previewUrl(tag) {
    return "/slideshow/?deck=local:" + PREVIEW_KEY + "&interactive&ctx=" + state.ctx
         + "&s=" + encodeURIComponent(tag) + (pvNonce ? "&r=" + pvNonce : "");
  }

  // What is injected right now, as far as live curation goes: the clips, and nothing
  // else. The entries themselves only change when the editor changes them, and that
  // path already re-previews.
  function reelSig(resolved) {
    return JSON.stringify(resolved.map(function (e) { return e.videos || 0; }));
  }

  /* Replace what the preview frame plays.

     The nonce is bumped HERE and ONLY ON A REAL CHANGE, which is the whole subtlety.
     The frame reloads exactly when its `src` string differs, so the URL has to track
     what is injected:

       - keying it on the SLUG is too coarse. That was enough while a slide had one
         previewable thing in it; a slide now has one per step, so two steps of the
         same slide produced an identical URL and the frame sat on the first one.
       - bumping on every inject is too eager, and not harmlessly so. It re-navigates
         the frame on every click, including re-previewing what is already showing —
         and a reel's first clip is fragile to exactly that churn: `ensurePlayable`
         only raises `preload` when nothing is in flight, so a clip re-shown while its
         own fetch is being torn down can sit with no data until the stall watchdog
         skips it 15s later. Re-navigating for no reason re-rolls that race.

     Comparing the injected document itself is the honest test, and it is cheap —
     `put` serialises the same object anyway. */
  function inject(title, resolved) {
    var doc = { title: title, slides: resolved };
    if (window.WccDeckStore) WccDeckStore.put(PREVIEW_KEY, doc);
    var sig = JSON.stringify(doc);
    if (sig === pvDoc) return;
    pvDoc = sig;
    pvNonce++;
  }

  function showPreview(where, id, title, tag, entries) {
    var resolved = entries.map(playable);
    inject(title, resolved);
    state.pv = { where: where, id: id, title: title, slug: tag,
                 url: previewUrl(tag), n: resolved.length,
                 // The unresolved entries, so a refresh can re-run `playable` against
                 // whatever /curate has published since.
                 entries: entries,
                 sig: reelSig(resolved),
                 // Kept for the pane's actions: only a single slide has a curation
                 // behind it, so a package or slideshow preview offers none.
                 entry: resolved.length === 1 ? resolved[0] : null };
    render();
  }

  /* Re-resolve what the pane is showing. Returns true only if the clips moved — the
     caller reloads the frame on that, and a reload restarts the reel under the
     editor's hands, so it must not fire on a preview that is already correct. */
  function refreshPreview() {
    var pv = state.pv;
    if (!pv || !pv.entries) return false;
    var resolved = pv.entries.map(playable);
    var sig = reelSig(resolved);
    if (sig === pv.sig) return false;
    pv.sig = sig;
    pv.entry = resolved.length === 1 ? resolved[0] : null;
    inject(pv.title, resolved);   // bumps the nonce
    pv.url = previewUrl(pv.slug);
    return true;
  }

  /* The curation behind a previewed reel, if it is one. `_pc_id` is stamped on a
     reel's slide_meta by emit_reel; a slide that isn't a reel has none, which is
     exactly the test for whether curating it means anything. */
  function curateUrl() {
    var e = state.pv && state.pv.entry;
    return e && e._pc_id ? "/curate/?match=" + encodeURIComponent(e._pc_id) : null;
  }

  function renderPreview() {
    var frame = $("#preview"), none = $("#preview-none");
    $("#preview-open").hidden = !state.pv;   // nothing to open
    $("#curate-btn").hidden = !curateUrl();  // not a reel
    if (!state.pv) {
      frame.hidden = true; frame.removeAttribute("src");
      none.hidden = false;
      $("#preview-title").textContent = "Nothing selected";
      return;
    }
    // Reveal BEFORE navigating: the player measures its stage on boot, and a
    // display:none frame would have it lay out against 0x0.
    frame.hidden = false;
    none.hidden = true;
    if (frame.getAttribute("src") !== state.pv.url) frame.setAttribute("src", state.pv.url);
    $("#preview-title").innerHTML = state.pv.title + " <i>· " + state.pv.slug
      + (state.pv.n > 1 ? " · " + state.pv.n + " slides" : "") + "</i>";
  }

  function playDeck() {
    if (!slides().length) return;
    persist();
    // Play a resolved copy, so reels carry the sitting's clips without the draft
    // itself ever holding them.
    if (window.WccDeckStore) {
      WccDeckStore.put(PREVIEW_KEY, { title: state.deck.title, slides: slides().map(playable) });
      window.open("/slideshow/?deck=local:" + PREVIEW_KEY
                  + "&interactive&ctx=" + state.ctx, "_blank");
      return;
    }
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
    // Provenance the publisher can check the landed curation against. Also the reason
    // the export is assembled field-by-field rather than copied: `source_match` is the
    // builder's own bookkeeping and everything else here is deliberate.
    if (state.deck.source_match) doc.source_match = state.deck.source_match;
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
    $("#curate-btn").addEventListener("click", function () {
      var u = curateUrl();
      if (u) window.open(u, "_blank");
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

    /* Returning to this tab is the moment a sitting's curation lands. /curate
       publishes its reels to storage as the editor works, and everything here
       resolves them at render time — the rows for free, the preview frame only when
       its clips actually moved. It closes the loop in both directions: adding a ball
       shows up, and so does discarding the draft that added it. */
    function onReturn() {
      if (document.hidden) return;
      refreshPreview();
      render();
    }
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
  }

  /* `?match=<pc_id>` — the hand-off from /curate. Opens that match's package as a
     deck, and is **idempotent**: a deck built this way is stamped `source_match`, and
     a second visit re-opens the same one rather than minting a duplicate. That
     matters because the sitting is a loop, so the editor will press it repeatedly.

     Returns a promise resolving true when it took the deck, so boot only falls back
     to the last-used draft otherwise. */
  function openForMatch(pc) {
    var existing = draftKeys().filter(function (k) {
      var d = WccDeckStore.get(k);
      return d && String(d.source_match) === String(pc);
    })[0];
    if (existing) { openDraft(existing); return Promise.resolve(true); }

    var set = (state.cat.sets || []).filter(function (s) {
      return String(s.pc_id) === String(pc);
    })[0];
    if (!set) {
      // The package has rolled out of fixtures.json, or this match never had one.
      status("no match package for " + pc + " — it may have rolled out of the window");
      return Promise.resolve(false);
    }
    return entriesFor("set", set.slug).then(function (entries) {
      if (!entries.length) return false;
      newDeck(set.title, entries, { source_match: String(pc) });
      return true;
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

    var want = new URLSearchParams(location.search).get("match");
    Promise.resolve(want ? openForMatch(want) : false).then(function (took) {
      // Consume the parameter: the deck is now the one in the picker, and a later
      // reload should not drag the editor back off whatever they switched to.
      if (want) {
        try { history.replaceState(null, "", location.pathname); } catch (e) {}
      }
      if (took) return;
      var last = null;
      try { last = localStorage.getItem(LAST_KEY); } catch (e) {}
      var keys = draftKeys();
      if (!(last && keys.indexOf(last) >= 0 && openDraft(last))) {
        if (keys.length) openDraft(keys[0]);
        else newDeck("Untitled deck", []);
      }
    });
  }).catch(function () {
    status("could not load /slides.json — has the site been built?");
  });
})();

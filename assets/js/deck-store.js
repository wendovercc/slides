/* deck-store.js — browser-held decks, for tooling that has no build behind it.
 *
 * A deck is pure data — `{title, slides:[…]}` — and the player normally fetches it
 * from `/slideshow/<slug>/data.json`. The editor surfaces (narration preview, the
 * deck builder) hold a deck they have just assembled in the browser, with no build
 * in between: the whole point of the one-sitting constraint in
 * docs/narrated-decks.md. This is the handover between them.
 *
 * localStorage rather than a postMessage handshake, for three reasons: the player
 * is a separate document (opened in a tab or an iframe), so it cannot be handed a
 * JS object directly; a stored deck survives the reloads a preview session is made
 * of; and `/curate` already persists its drafts this way, so there is one storage
 * convention on this origin rather than two.
 *
 * The player addresses a stored deck as `?deck=local:<key>` — see templates/player.html.
 */
(function () {
  "use strict";
  var PREFIX = "wcc-deck:";

  window.WccDeckStore = {
    prefix: PREFIX,

    /* Store a deck document under `key`. Returns false if it wouldn't fit (a deck
       with many slides plus a curated clip list can approach the ~5MB quota). */
    put: function (key, deck) {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(deck));
        return true;
      } catch (e) {
        try { console.warn("[deck-store] could not store deck " + key, e); } catch (e2) {}
        return false;
      }
    },

    /* The deck document stored under `key`, or null. Never throws: a malformed or
       missing entry reads as "no deck", which the player treats as nothing to play. */
    get: function (key) {
      try {
        var raw = localStorage.getItem(PREFIX + key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },

    remove: function (key) {
      try { localStorage.removeItem(PREFIX + key); } catch (e) {}
    },

    /* Every stored deck key on this origin, for a picker or a cleanup. */
    list: function () {
      var out = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(PREFIX) === 0) out.push(k.slice(PREFIX.length));
        }
      } catch (e) {}
      return out.sort();
    }
  };
})();

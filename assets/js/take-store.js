/* take-store.js — where a narration take lives while it is being made.
 *
 * Phase 7 of docs/narrated-decks.md. Two writers and one reader: record mode
 * (inside the player) appends audio and stamps cues as the narrator plays the
 * deck; `/narrate` reads the lot back, and may add re-recorded segments.
 *
 * Losing a twenty-minute take to a reload is a re-do across a whole sitting, so
 * the split between the two stores is a crash-safety decision rather than a
 * capacity one:
 *
 *   - **The session record is localStorage**, written synchronously on every cue.
 *     A cue is ~80 bytes; the whole log of a 61-beat deck is a few kB. Synchronous
 *     is the point — an IndexedDB write in flight when the tab dies is a lost cue,
 *     and the cue log is what makes the audio addressable at all.
 *   - **The audio is IndexedDB**, appended a chunk at a time as MediaRecorder
 *     produces them (~1s timeslice). Blobs of that size have no business in a 5MB
 *     localStorage quota shared with /curate's drafts and the deck store.
 *
 * The deck itself is neither: it is a deck, so it goes in the deck store under a
 * reserved `__take:<id>` key (`WccDeckStore` already filters `__` keys out of the
 * drafts picker). One storage convention per kind of thing, as phase 4 intended.
 */
(function () {
  "use strict";

  var SESSION_PREFIX = "wcc-take:";
  var DB_NAME = "wcc-takes";
  var DB_VERSION = 1;
  var CHUNKS = "chunks";      // { take, seq, blob } — the continuous master, in order
  var SEGMENTS = "segments";  // { take, beat, blob } — re-records, one per beat

  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(CHUNKS)) {
          d.createObjectStore(CHUNKS, { keyPath: ["take", "seq"] });
        }
        if (!d.objectStoreNames.contains(SEGMENTS)) {
          d.createObjectStore(SEGMENTS, { keyPath: ["take", "beat"] });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(store, mode);
        var out = fn(t.objectStore(store));
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  /* Every record in `store` belonging to this take, in key order. The keyPath is
     [take, seq] / [take, beat], so one bound range is the whole take and the
     ordering falls out of the index rather than a sort. */
  function allFor(store, id) {
    return tx(store, "readonly", function (os) {
      var box = {};
      var range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
      os.openCursor(range).onsuccess = function (e) {
        var c = e.target.result;
        if (!c) return;
        (box.rows = box.rows || []).push(c.value);
        c.continue();
      };
      return box;
    }).then(function (box) { return box.rows || []; });
  }

  function readSession(id) {
    try {
      var raw = localStorage.getItem(SESSION_PREFIX + id);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  window.WccTakeStore = {
    sessionPrefix: SESSION_PREFIX,
    deckKey: function (id) { return "__take:" + id; },

    /* Mint a session. The id is a timestamp because takes are read newest-first
       and never looked up by name; `meta` carries whatever the recorder knows up
       front (deck title, mime type, build_version, source_match). */
    create: function (meta) {
      var id = "t" + Date.now().toString(36);
      var s = Object.assign({
        id: id,
        started: new Date().toISOString(),
        cues: [],
        freezes: [],
        stopped: false
      }, meta || {});
      this.save(s);
      return s;
    },

    /* Write the session record. Returns false when it would not fit, which the
       caller must surface: a take whose cue log cannot be written is a take that
       cannot be reviewed, and finding that out at the end is the worst case. */
    save: function (s) {
      try {
        localStorage.setItem(SESSION_PREFIX + s.id, JSON.stringify(s));
        return true;
      } catch (e) {
        try { console.warn("[take-store] could not write session " + s.id, e); } catch (e2) {}
        return false;
      }
    },

    get: readSession,

    /* Every session on this origin, newest first. */
    list: function () {
      var out = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(SESSION_PREFIX) === 0) {
            var s = readSession(k.slice(SESSION_PREFIX.length));
            if (s) out.push(s);
          }
        }
      } catch (e) {}
      return out.sort(function (a, b) { return (b.started || "").localeCompare(a.started || ""); });
    },

    latest: function () { return this.list()[0] || null; },

    /* The deck as it was played, stored where decks are stored. */
    putDeck: function (id, deck) {
      return window.WccDeckStore ? WccDeckStore.put(this.deckKey(id), deck) : false;
    },
    getDeck: function (id) {
      return window.WccDeckStore ? WccDeckStore.get(this.deckKey(id)) : null;
    },

    appendChunk: function (id, seq, blob) {
      return tx(CHUNKS, "readwrite", function (os) { os.put({ take: id, seq: seq, blob: blob }); });
    },

    /* The continuous master, reassembled. Chunks are only playable in order and
       from the first one — a WebM/MP4 stream's header is in chunk 0 — so this is
       a concatenation, never a random-access read. */
    take: function (id, mime) {
      return allFor(CHUNKS, id).then(function (rows) {
        if (!rows.length) return null;
        return new Blob(rows.map(function (r) { return r.blob; }), { type: mime || rows[0].blob.type });
      });
    },

    putSegment: function (id, beat, blob) {
      return tx(SEGMENTS, "readwrite", function (os) { os.put({ take: id, beat: beat, blob: blob }); });
    },
    dropSegment: function (id, beat) {
      return tx(SEGMENTS, "readwrite", function (os) { os.delete([id, beat]); });
    },
    /* Re-recorded beats, as `{ <beat index>: Blob }`. */
    segments: function (id) {
      return allFor(SEGMENTS, id).then(function (rows) {
        var out = {};
        rows.forEach(function (r) { out[r.beat] = r.blob; });
        return out;
      });
    },

    remove: function (id) {
      try { localStorage.removeItem(SESSION_PREFIX + id); } catch (e) {}
      if (window.WccDeckStore) WccDeckStore.remove(this.deckKey(id));
      return Promise.all([
        tx(CHUNKS, "readwrite", function (os) {
          os.delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
        }),
        tx(SEGMENTS, "readwrite", function (os) {
          os.delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
        })
      ]).catch(function () {});
    }
  };
})();

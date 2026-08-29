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

  // ---- making a recorded take seekable -----------------------------------
  /* A MediaRecorder file is written as it is captured, so its container says how
     long it is nowhere: the Segment has an unknown size and the Info block carries
     no Duration. An <audio> element fed one reports `duration: Infinity` and an
     empty `seekable` range, and **refuses to seek at all** — which in /narrate
     means a playhead that can be dragged but never lands, and a Play that starts
     from wherever the element happened to be. (Chrome can be coaxed into scanning
     for the length by seeking past the end; Firefox cannot, and a review workbench
     that only seeks in one browser is not built.)
     The take knows its own length — the cue log measured it — so the honest fix is
     to write that length into the bytes. One Duration element, appended to Info,
     and the file becomes an ordinary seekable WebM for the player and for ffmpeg
     downstream. */
  var EBML = { SEGMENT: 0x18538067, INFO: 0x1549A966, SCALE: 0x2AD7B1, DURATION: 0x4489 };

  /* EBML's variable-length integers: the first set bit gives the width, and the
     bits after it the value. `unknown` is every value bit set — how a streamed
     Segment says "size to be discovered". */
  function vint(b, at) {
    var first = b[at], w = 1;
    if (!first) return null;
    while (!(first & (0x80 >> (w - 1)))) w++;
    var v = first & (0xff >> w), all = v === (0xff >> w);
    for (var i = 1; i < w; i++) { v = v * 256 + b[at + i]; all = all && b[at + i] === 0xff; }
    return { w: w, v: v, unknown: all };
  }
  function elem(b, at) {
    var id = vint(b, at);
    if (!id) return null;
    var idv = 0;
    for (var i = 0; i < id.w; i++) idv = idv * 256 + b[at + i];
    var sz = vint(b, at + id.w);
    if (!sz) return null;
    var head = id.w + sz.w;
    return { id: idv, at: at, head: head, size: sz.unknown ? null : sz.v,
             body: at + head, end: sz.unknown ? null : at + head + sz.v };
  }
  /* Always eight bytes. EBML allows a size to be written wider than it needs to
     be, and a fixed width means Info can grow without every offset after it
     moving — which is what makes this a patch rather than a re-mux. */
  function size8(n) {
    var out = new Uint8Array(8);
    out[0] = 0x01;
    for (var i = 7; i >= 1; i--) { out[i] = n % 256; n = Math.floor(n / 256); }
    return out;
  }
  function children(b, from, to) {
    var out = [], at = from;
    while (at < to) {
      var e = elem(b, at);
      if (!e) break;
      out.push(e);
      at = e.end != null ? e.end : to;
    }
    return out;
  }

  /* Returns the same blob with a Duration in it, or the blob untouched if it is
     not a WebM, already has one, or is shaped in a way this does not understand —
     a take that will not seek is a degraded page, never a lost one. */
  function withDuration(blob, seconds) {
    // Declining is normal — an MP4 take, a file that already says how long it is —
    // but declining *silently* is what made this hard to find the first time, so
    // every route out says which one it took.
    var no = function (why) { if (why) console.warn("take-store: no duration written — " + why); return blob; };
    if (!blob || !blob.arrayBuffer) return Promise.resolve(no(""));
    if (!seconds || !isFinite(seconds)) return Promise.resolve(no("the take has no length yet"));
    return blob.arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf);
      // Sniffed, not trusted from the mime type: a take reassembled from chunks can
      // reach here with an empty type, and the first four bytes are the truth.
      if (!(b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)) {
        return no((blob.type || "this take") + " is not WebM");
      }
      var seg = null, at = 0;
      while (at < b.length) {
        var e = elem(b, at);
        if (!e) return no("the EBML would not parse");
        if (e.id === EBML.SEGMENT) { seg = e; break; }
        if (e.end == null) return no("an unsized element above Segment");
        at = e.end;
      }
      if (!seg) return no("no Segment");
      // A streamed Segment has no size of its own, which is the case that matters:
      // its children run to the end of the file and nothing above Info has a length
      // that appending to Info would invalidate.
      if (seg.size != null) return no("the Segment already has a size");
      var info = null, sawInfo = false;
      children(b, seg.body, b.length).some(function (c) {
        if (c.id !== EBML.INFO) return false;
        sawInfo = true;
        if (c.end != null) { info = c; return true; }
        return false;
      });
      if (!info) return no(sawInfo ? "Info has no size of its own" : "no Info block");
      var scale = 1000000, durEl = null;
      children(b, info.body, info.end).forEach(function (c) {
        if (c.id === EBML.DURATION) durEl = c;
        if (c.id === EBML.SCALE && c.size) {
          var v = 0;
          for (var i = 0; i < c.size; i++) v = v * 256 + b[c.body + i];
          if (v) scale = v;
        }
      });
      // Duration is a float, in TimecodeScale units — milliseconds, at the 1ms scale
      // everything here is muxed at.
      var val = seconds * 1e9 / scale;
      /* Firefox's recorder writes the element and leaves it at zero: the file is
         streamed, so the length was not known when the header went out. That is the
         easy case — the number is overwritten where it lies, the same width, and
         nothing in the file after it moves. (It is also the case that cost the most
         to find, because "it already has a Duration" and "it has a Duration that
         says nothing" look identical until you read the bytes.) */
      if (durEl && (durEl.size === 4 || durEl.size === 8)) {
        var read = new DataView(b.buffer, b.byteOffset);
        var now = durEl.size === 4 ? read.getFloat32(durEl.body) : read.getFloat64(durEl.body);
        if (now > 0) return no("");
        var copy = b.slice(0);
        var write = new DataView(copy.buffer);
        if (durEl.size === 4) write.setFloat32(durEl.body, val);
        else write.setFloat64(durEl.body, val);
        return new Blob([copy], { type: blob.type });
      }
      if (durEl) return no("its Duration is " + durEl.size + " bytes wide");
      // No Duration at all — Chrome's shape. One is built and appended to Info.
      var dur = new Uint8Array(11);
      dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88;
      new DataView(dur.buffer).setFloat64(3, val);

      // Info is rewritten with its size in the fixed eight-byte form and the new
      // element on the end; everything before and after it is copied through.
      var idw = vint(b, info.at).w;
      var payload = b.subarray(info.body, info.end);
      var out = new Uint8Array(info.at + idw + 8 + payload.length + dur.length
                               + (b.length - info.end));
      var o = 0;
      out.set(b.subarray(0, info.at + idw), o); o += info.at + idw;
      out.set(size8(payload.length + dur.length), o); o += 8;
      out.set(payload, o); o += payload.length;
      out.set(dur, o); o += dur.length;
      out.set(b.subarray(info.end), o);
      return new Blob([out], { type: blob.type });
    }).catch(function () { return blob; });
  }

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
      var secs = (this.get(id) || {}).duration;
      return allFor(CHUNKS, id).then(function (rows) {
        if (!rows.length) return null;
        var blob = new Blob(rows.map(function (r) { return r.blob; }),
                            { type: mime || rows[0].blob.type });
        // Patched on the way out, so the seekable file is what /narrate plays and
        // what the export ships — one master, not two.
        return withDuration(blob, secs);
      });
    },
    /* Exposed for a take whose length is known later than its bytes. */
    withDuration: withDuration,

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

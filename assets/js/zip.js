/* zip.js — a minimal, store-only ZIP writer.
 *
 * `/narrate` hands the publisher one file (`narration.zip`: the deck, the timeline,
 * the take and any re-recorded segments), and a browser has no way to write an
 * archive on its own. Everything in it is either already compressed (WebM/MP4 audio)
 * or a few kB of JSON, so deflate would buy nothing and cost a compression library —
 * hence STORE only, which is a CRC and two fixed headers per entry.
 *
 *   WccZip.build([{ name: "timeline.json", data: <string|Blob|ArrayBuffer> }])
 *     → Promise<Blob>
 *
 * No date is written (DOS time zero). The zip is a transport between two people on
 * the same day, not an archive, and a stable byte-for-byte output is worth more than
 * a timestamp nobody reads.
 */
(function () {
  "use strict";

  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function bytesOf(data) {
    if (typeof data === "string") return Promise.resolve(new TextEncoder().encode(data));
    if (data instanceof Uint8Array) return Promise.resolve(data);
    if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data));
    return data.arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function w(view, off, size, value) {
    if (size === 2) view.setUint16(off, value, true);
    else view.setUint32(off, value, true);
  }

  window.WccZip = {
    build: function (entries) {
      return Promise.all(entries.map(function (e) {
        return bytesOf(e.data).then(function (bytes) {
          return { name: new TextEncoder().encode(e.name), bytes: bytes, crc: crc32(bytes) };
        });
      })).then(function (files) {
        var parts = [], central = [], offset = 0;
        files.forEach(function (f) {
          var head = new Uint8Array(30 + f.name.length);
          var v = new DataView(head.buffer);
          w(v, 0, 4, 0x04034b50);      // local file header
          w(v, 4, 2, 20);              // version needed
          w(v, 6, 2, 0);               // flags
          w(v, 8, 2, 0);               // method: store
          w(v, 10, 2, 0); w(v, 12, 2, 0);              // mod time / date
          w(v, 14, 4, f.crc);
          w(v, 18, 4, f.bytes.length); w(v, 22, 4, f.bytes.length);
          w(v, 26, 2, f.name.length); w(v, 28, 2, 0);
          head.set(f.name, 30);
          parts.push(head, f.bytes);

          var cen = new Uint8Array(46 + f.name.length);
          var cv = new DataView(cen.buffer);
          w(cv, 0, 4, 0x02014b50);     // central directory header
          w(cv, 4, 2, 20); w(cv, 6, 2, 20);
          w(cv, 8, 2, 0); w(cv, 10, 2, 0);
          w(cv, 12, 2, 0); w(cv, 14, 2, 0);
          w(cv, 16, 4, f.crc);
          w(cv, 20, 4, f.bytes.length); w(cv, 24, 4, f.bytes.length);
          w(cv, 28, 2, f.name.length);
          w(cv, 30, 2, 0); w(cv, 32, 2, 0); w(cv, 34, 2, 0); w(cv, 36, 2, 0);
          w(cv, 38, 4, 0);
          w(cv, 42, 4, offset);
          cen.set(f.name, 46);
          central.push(cen);
          offset += head.length + f.bytes.length;
        });
        var cenSize = central.reduce(function (a, c) { return a + c.length; }, 0);
        var end = new Uint8Array(22);
        var ev = new DataView(end.buffer);
        w(ev, 0, 4, 0x06054b50);       // end of central directory
        w(ev, 8, 2, files.length); w(ev, 10, 2, files.length);
        w(ev, 12, 4, cenSize); w(ev, 16, 4, offset);
        return new Blob(parts.concat(central, [end]), { type: "application/zip" });
      });
    }
  };
})();

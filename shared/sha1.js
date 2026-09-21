'use strict';

// SHA-1, synchronously, in about sixty lines.
//
// The dedup fingerprint is `sha1(account | date | amount | description)` and
// it is computed inside the row-mapping loop, which is synchronous all the
// way up through `markDuplicates` and the whole parse pipeline. Node has
// `crypto.createHash('sha1')`, which is synchronous; the browser has
// `crypto.subtle.digest`, which is **async**. Making the fingerprint async
// would reach into the code least worth destabilising, so instead the hash
// comes from here and is the same in both places.
//
// This is exactly the case CLAUDE.md's zero-dependency rule describes: write
// the forty lines rather than take the package. Correctness is not a matter
// of opinion — `test/sha1.test.js` hashes a corpus with this and with
// `node:crypto` and asserts the two agree byte for byte, which is also what
// protects the dedup contract: the definition may not change, because every
// fingerprint already stored was computed under the old one.
//
// Not a general-purpose crypto primitive and not here for security. SHA-1 is
// broken for signatures and is fine for what this does, which is telling two
// rows of a bank statement apart.

(function (root) {
  const rotl = (n, b) => ((n << b) | (n >>> (32 - b))) >>> 0;

  const K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];

  // Takes the bytes, not the string. The caller decides the encoding, and
  // `sha1Hex` below picks UTF-8 so it matches what Node's
  // `hash.update(string)` does by default.
  function sha1Bytes(bytes) {
    const len = bytes.length;
    // The message is padded with a 1 bit, then zeros, then its length in bits
    // as a 64-bit big-endian integer, to a multiple of 64 bytes.
    const total = (((len + 8) >> 6) + 1) << 6;
    const msg = new Uint8Array(total);
    msg.set(bytes);
    msg[len] = 0x80;

    const view = new DataView(msg.buffer);
    const bits = len * 8;
    view.setUint32(total - 8, Math.floor(bits / 0x100000000));
    view.setUint32(total - 4, bits >>> 0);

    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Uint32Array(80);

    for (let chunk = 0; chunk < total; chunk += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(chunk + i * 4);
      for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f;
        if (i < 20) f = (b & c) | (~b & d);
        else if (i < 40) f = b ^ c ^ d;
        else if (i < 60) f = (b & c) | (b & d) | (c & d);
        else f = b ^ c ^ d;
        // Each term is at most 2^32, five of them stay well under 2^53, so
        // the sum is exact before it is truncated back to 32 bits.
        const t = (rotl(a, 5) + (f >>> 0) + e + K[(i / 20) | 0] + w[i]) >>> 0;
        e = d;
        d = c;
        c = rotl(b, 30);
        b = a;
        a = t;
      }

      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
    }

    // Five 32-bit words as forty hex digits. Joining hex, not markup — the
    // frontend's no-bare-join rule is about collapsing html`` templates.
    return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('');
  }

  // UTF-8, because that is what `crypto.createHash('sha1').update(str)` uses
  // when no encoding is given — and a description can hold 玉山銀行 as easily
  // as it can hold STARBUCKS. `TextEncoder` is a global in Node 22 and in
  // every browser, so there is nothing to branch on.
  function sha1Hex(input) {
    return sha1Bytes(typeof input === 'string' ? new TextEncoder().encode(input) : input);
  }

  // Dual-environment, the same three lines `web/html.js` ends with: onto the
  // global for the browser's classic scripts, onto module.exports for Node.
  const api = { sha1Hex, sha1Bytes };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

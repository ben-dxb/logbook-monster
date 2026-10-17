'use strict';
/* public/qr.js – the QR code of the two-step set-up link. Its output was checked against an independent decoder (jsQR) for
   texts of 1 to 400 bytes (versions 1–15); these keep it that way: the symbol's fixed parts, the format bits (level M, a valid
   mask, BCH-correct), a pinned matrix for a set-up link, and an SVG with no style attributes. */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const QR = require('../public/qr.js');

const URI = 'otpauth://totp/Logbook%20Monster:someone%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Logbook%20Monster';
const hash = m => crypto.createHash('sha256').update(m.map(r => r.map(b => (b ? 1 : 0)).join('')).join('\n')).digest('hex');

test('a symbol has its finder patterns, timing lines and dark module, and grows with the text', () => {
  for (const [t, size] of [['HELLO', 21], [URI, 45], ['x'.repeat(300), 69]]) {
    const m = QR.matrix(t);
    assert.strictEqual(m.length, size, t.slice(0, 10));
    for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) for (let d = 0; d < 7; d++) {
      for (const [x, y] of [[x0 + d, y0], [x0 + d, y0 + 6], [x0, y0 + d], [x0 + 6, y0 + d]]) assert.ok(m[y][x], `finder ring at ${x},${y}`);
      assert.ok(m[y0 + 3][x0 + 3], 'finder centre');
    }
    for (let i = 8; i < size - 8; i++) { assert.strictEqual(m[6][i], i % 2 === 0, 'timing row'); assert.strictEqual(m[i][6], i % 2 === 0, 'timing column'); }
    assert.ok(m[size - 8][8], 'dark module');
  }
  assert.throws(() => QR.matrix('x'.repeat(3000)), /Too long/);
});

test('the format bits say level M and a mask, with a correct BCH code, the same in both copies', () => {
  const m = QR.matrix(URI), n = m.length;
  const a = [], b = [];
  for (let i = 0; i <= 5; i++) a.push(m[i][8]);
  a.push(m[7][8], m[8][8], m[8][7]);
  for (let i = 9; i < 15; i++) a.push(m[8][14 - i]);
  for (let i = 0; i < 8; i++) b.push(m[8][n - 1 - i]);
  for (let i = 8; i < 15; i++) b.push(m[n - 15 + i][8]);
  const val = bits => bits.reduce((v, x, i) => v | ((x ? 1 : 0) << i), 0);
  assert.strictEqual(val(a), val(b), 'both copies agree');
  const f = val(a) ^ 0x5412, data = f >>> 10;
  assert.strictEqual(data >>> 3, 0, 'level M');
  let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  assert.strictEqual(f & 0x3ff, rem & 0x3ff, 'BCH remainder');
});

test('a set-up link always draws the same symbol (checked with a QR decoder when written)', () => {
  assert.strictEqual(hash(QR.matrix(URI)), 'c9c5640245e688241dd40618769c4479bb176d974e4d5c6b3f4ba349f6d3afe3');
});

test('the SVG is one path on a white quiet zone, labelled, with no style attribute or script', () => {
  const s = QR.svg(URI, { label: 'Scan "this" <now>' });
  assert.match(s, /^<svg [^>]*viewBox="0 0 53 53"[^>]*role="img"[^>]*aria-label="Scan &quot;this&quot; &lt;now>"/);
  assert.strictEqual((s.match(/<path /g) || []).length, 1);
  assert.match(s, /<rect width="53" height="53" fill="#fff"\/>/);
  assert.doesNotMatch(s, /style=|<script|on[a-z]+=/i);
});

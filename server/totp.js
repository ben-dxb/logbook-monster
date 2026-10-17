'use strict';
/* Authenticator-app codes: TOTP (RFC 6238) over HOTP (RFC 4226) – HMAC-SHA-1, 6 digits, 30-second steps, ±1 step.
   node:crypto only. The account side (stored secret, recovery codes, sign-in step) is in twostep.js. */
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function fromBase32(s) {
  let bits = 0, val = 0; const out = [];
  for (const ch of String(s).toUpperCase().replace(/[\s=]/g, '')) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    val = (val << 5) | v; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const STEP = 30;
const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);
function hotp(key, counter, digits = 6, algo = 'sha1') {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algo, key).update(c).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
const totp = (key, ms = Date.now(), digits = 6, algo = 'sha1') => hotp(key, stepAt(ms), digits, algo);

/* The step (now – 1, now or now + 1) a 6-digit code belongs to, or -1. */
function match(key, code, ms = Date.now()) {
  code = String(code == null ? '' : code).replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(code)) return -1;
  const now = stepAt(ms);
  let hit = -1;
  for (const s of [now - 1, now, now + 1]) if (crypto.timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(code)) && hit < 0) hit = s;
  return hit;
}

const newKey = () => crypto.randomBytes(20);
const uri = (key, account, issuer = 'Logbook Monster') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${base32(key)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

module.exports = { base32, fromBase32, hotp, totp, match, stepAt, newKey, uri, STEP };

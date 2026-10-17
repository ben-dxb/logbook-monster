'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

/* scrypt, OWASP-recommended cost (N=2^15, r=8, p=3). Stored as scrypt$N$r$p$salt$hash */
const N = 32768, R = 8, P = 3, KEYLEN = 64;
const opts = (n, r, p) => ({ N: n, r, p, maxmem: 128 * n * r * 2 });

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw.normalize('NFKC'), salt, KEYLEN, opts(N, R, P));
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, opts(+n, +r, +p));
  return crypto.timingSafeEqual(key, expected);
}

/* Burn the same time on unknown emails so response timing doesn't reveal which accounts exist. */
let dummy;
async function dummyVerify(pw) {
  dummy = dummy || await hashPassword('not-a-real-password');
  await verifyPassword(pw, dummy);
  return false;
}

/* NIST 800-63B: a length rule and a check against passwords known to be in use, no composition rules. The list holds only
   ones of 10+ characters, lowercased; it is read the first time a password is checked. */
let COMMON = null;
const common = () => COMMON || (COMMON = new Set(require('fs').readFileSync(require('path').join(__dirname, 'common-passwords.txt'), 'utf8')
  .split(/\r?\n/).filter(l => l && !l.startsWith('#'))));
/* email: the account's, so a password built on its name ("annsmith123" for annsmith@…) is refused – for a name of 4+ letters */
function passwordProblem(pw, email) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  const low = pw.normalize('NFKC').toLowerCase();
  if (/^(.)\1*$/su.test(low)) return 'That password is one character over and over – pick something harder to guess.';
  if (common().has(low)) return 'That password is one of the most used ones, so it’s easy to guess – pick another.';
  const name = String(email || '').toLowerCase().split('@')[0].split('+')[0];
  if (name.length >= 4 && low.includes(name)) return 'Your password can’t contain your email address – pick something else.';
  return null;
}

module.exports = { hashPassword, verifyPassword, dummyVerify, passwordProblem };

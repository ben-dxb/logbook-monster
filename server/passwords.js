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

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

module.exports = { hashPassword, verifyPassword, dummyVerify, passwordProblem };

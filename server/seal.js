'use strict';
/* Secrets kept in the database (the TOTP keys, the OpenRouter key, the SMTP password) are sealed with AES-256-GCM under a key
   derived (HKDF) from SEAL_KEY – or SESSION_SECRET while SEAL_KEY isn't set – one key per purpose. A copy of the database alone
   doesn't give them away. They also open under SESSION_SECRET (once SEAL_KEY is set) and SESSION_SECRET_OLD (after a rotation);
   stale() says a value opens only that way, and each module reseals such values on start (README › Rotating secrets). */
const crypto = require('crypto');
const config = require('./config');

const derive = (secret, purpose) => Buffer.from(crypto.hkdfSync('sha256', secret, 'logbook-monster', purpose, 32));

module.exports = function sealer(purpose) {
  const KEY = derive(config.sealKey || config.sessionSecret, purpose);
  const OLD = [config.sealKey && config.sessionSecret, config.sessionSecretOld].filter(Boolean).map(s => derive(s, purpose));
  function seal(buf) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const ct = Buffer.concat([c.update(buf), c.final()]);
    return ['v1', iv, c.getAuthTag(), ct].map(x => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
  }
  function open(s, key) {
    try {
      const [v, iv, tag, ct] = String(s).split('.');
      if (v !== 'v1') return null;
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
    } catch { return null; }
  }
  /* null when it can't be opened */
  function unseal(s) {
    for (const k of [KEY, ...OLD]) { const b = open(s, k); if (b) return b; }
    return null;
  }
  /* opens, but not under the current key: to be sealed again */
  const stale = s => !!s && !open(s, KEY) && !!unseal(s);
  const sealText = s => seal(Buffer.from(String(s), 'utf8'));
  const unsealText = s => { const b = unseal(s); return b ? b.toString('utf8') : null; };
  return { seal, unseal, stale, sealText, unsealText };
};

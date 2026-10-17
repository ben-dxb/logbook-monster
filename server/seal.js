'use strict';
/* Secrets kept in the database (the TOTP keys, the OpenRouter key, the SMTP password) are sealed with AES-256-GCM under a key
   derived (HKDF) from SESSION_SECRET, one key per purpose. A copy of the database alone doesn't give them away. If SESSION_SECRET
   changes they can't be opened any more and have to be entered again. */
const crypto = require('crypto');
const config = require('./config');

module.exports = function sealer(purpose) {
  const KEY = Buffer.from(crypto.hkdfSync('sha256', config.sessionSecret, 'logbook-monster', purpose, 32));
  function seal(buf) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const ct = Buffer.concat([c.update(buf), c.final()]);
    return ['v1', iv, c.getAuthTag(), ct].map(x => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
  }
  /* null when it can't be opened */
  function unseal(s) {
    try {
      const [v, iv, tag, ct] = String(s).split('.');
      if (v !== 'v1') return null;
      const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
    } catch { return null; }
  }
  const sealText = s => seal(Buffer.from(String(s), 'utf8'));
  const unsealText = s => { const b = unseal(s); return b ? b.toString('utf8') : null; };
  return { seal, unseal, sealText, unsealText };
};

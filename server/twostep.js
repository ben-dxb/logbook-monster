'use strict';
/* The optional second sign-in step: codes from an authenticator app (totp.js) plus 10 one-time recovery codes.
   The secret is kept sealed (AES-256-GCM, key derived from SESSION_SECRET), recovery codes only as SHA-256 hashes.
   Wrong codes count per account in login_failures (key '2fa:<id>', ACCOUNT_FAIL_LIMIT every 15 minutes, like passwords),
   and a code is taken once: only a step newer than the last one used is accepted.
   Routes here are under /api/totp (signed in); the sign-in step itself is in auth.js. */
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const db = require('./db');
const totp = require('./totp');
const users = require('./users');
const { verifyPassword } = require('./passwords');
const audit = require('./audit');

const q = {
  get: db.prepare('SELECT secret, enabled, last_step, recovery FROM totp WHERE user_id = ?'),
  start: db.prepare(`INSERT INTO totp (user_id, secret) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled = 0, last_step = 0, recovery = '[]', created_at = datetime('now')`),
  enable: db.prepare('UPDATE totp SET enabled = 1, last_step = ?, recovery = ? WHERE user_id = ? AND enabled = 0'),
  step: db.prepare('UPDATE totp SET last_step = ? WHERE user_id = ? AND last_step < ?'),
  recovery: db.prepare('UPDATE totp SET recovery = ? WHERE user_id = ? AND recovery = ?'),
  remove: db.prepare('DELETE FROM totp WHERE user_id = ?'),
  failCount: db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?'),
  failAdd: db.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)'),
  failClear: db.prepare('DELETE FROM login_failures WHERE email = ?'),
};

/* ---------- the secret, sealed at rest ---------- */
const KEY = Buffer.from(crypto.hkdfSync('sha256', config.sessionSecret, 'logbook-monster', 'totp-secret-v1', 32));
function seal(buf) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map(x => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
}
/* null when it can't be opened (SESSION_SECRET changed): only recovery codes work then */
function unseal(s) {
  try {
    const [v, iv, tag, ct] = String(s).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
  } catch { return null; }
}

const row = id => q.get.get(id);
const isOn = id => { const r = row(id); return !!(r && r.enabled); };
const recoveryLeft = r => { try { return JSON.parse(r.recovery).length; } catch { return 0; } };
const hashCode = (id, code) => crypto.createHash('sha256').update(`${id}:${code}`).digest('hex');
const cleanRecovery = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z2-7]/g, '');
function newRecovery() {
  return Array.from({ length: 10 }, () => totp.base32(crypto.randomBytes(7)).slice(0, 10).replace(/^(.{5})/, '$1-'));
}

/* ---------- wrong codes per account ---------- */
const WINDOW = 15 * 60 * 1000;
const failKey = id => '2fa:' + id;
const locked = key => q.failCount.get(key, Date.now() - WINDOW).n >= config.accountFailLimit;
const noteFail = key => q.failAdd.run(key, Date.now());

/* A code for an account that has the step on: 'totp', 'recovery', or null. Each is taken once. */
function take(id, code, { recovery = true } = {}) {
  const r = row(id);
  if (!r || !r.enabled) return null;
  const key = unseal(r.secret);
  const step = key ? totp.match(key, code) : -1;
  if (step >= 0) return q.step.run(step, id, step).changes ? 'totp' : null;
  if (!recovery) return null;
  const h = hashCode(id, cleanRecovery(code)), list = JSON.parse(r.recovery || '[]');
  if (cleanRecovery(code).length !== 10 || !list.includes(h)) return null;
  return q.recovery.run(JSON.stringify(list.filter(x => x !== h)), id, r.recovery).changes ? 'recovery' : null;
}
/* take() behind the per-account limit: { ok, kind } or { locked } */
function attempt(id, code, opts) {
  if (locked(failKey(id))) return { locked: true };
  const kind = take(id, code, opts);
  if (!kind) { noteFail(failKey(id)); return { ok: false }; }
  q.failClear.run(failKey(id));
  return { ok: true, kind };
}

/* Password or code, for turning the step off and for re-checking before a sensitive change. Wrong passwords count
   against the account's email like a wrong sign-in; wrong codes against its code limit. */
async function confirm(user, { password, code } = {}) {
  if (password != null && password !== '') {
    if (!user.password_hash || locked(user.email)) return { ok: false, locked: !!user.password_hash };
    if (await verifyPassword(String(password), user.password_hash)) return { ok: true };
    noteFail(user.email);
    return { ok: false };
  }
  if (code != null && code !== '') return attempt(user.id, code);
  return { ok: false };
}
const LOCKED = 'Too many wrong tries. Wait 15 minutes and try again.';

/* ---------- re-check before sensitive changes ---------- */
const RECHECK = 15 * 60 * 1000;
const lastCheck = req => Math.max(req.session.at || 0, req.session.checked || 0);
function fresh(req, res, next) {
  if (Date.now() - lastCheck(req) < RECHECK) return next();
  const can = !!req.user.password_hash || isOn(req.user.id);
  res.status(403).json({ recheck: can, error: can ? 'Confirm it’s you: enter your password or a code from your authenticator app.'
    : 'You signed in more than 15 minutes ago. Sign out and in again, then try once more.' });
}
/* the security log: a recovery code taken, and the outcome of a re-check */
function note(req, r, event) {
  if (r.kind === 'recovery') audit.log(req, 'recovery.used', { for: event });
  audit.log(req, r.ok ? event + '.ok' : event + '.failed', r.ok ? { by: r.kind ? 'code' : 'password' } : { locked: !!r.locked });
}
async function recheck(req, res) {
  const r = await confirm(req.user, req.body || {});
  note(req, r, 'recheck');
  if (r.locked) return res.status(429).json({ error: LOCKED });
  if (!r.ok) return res.status(400).json({ error: 'That password or code didn’t work.' });
  req.session.checked = Date.now();
  res.json({ ok: true });
}

/* ---------- /api/totp: setting it up and switching it off ---------- */
const router = express.Router();
router.get('/', (req, res) => {
  const r = row(req.user.id);
  res.json({ on: !!(r && r.enabled), recoveryLeft: r && r.enabled ? recoveryLeft(r) : 0, readable: !r || !!unseal(r.secret) });
});
/* a new secret, not in use until a code from it is confirmed */
router.post('/setup', (req, res) => {
  if (isOn(req.user.id)) return res.status(409).json({ error: 'The second step is already on. Switch it off first to set up a new app.' });
  const key = totp.newKey();
  q.start.run(req.user.id, seal(key));
  res.json({ secret: totp.base32(key), uri: totp.uri(key, req.user.email) });
});
router.post('/enable', (req, res) => {
  const r = row(req.user.id);
  if (!r || r.enabled) return res.status(409).json({ error: r ? 'The second step is already on.' : 'Start the set-up first.' });
  if (locked(failKey(req.user.id))) return res.status(429).json({ error: LOCKED });
  const key = unseal(r.secret), step = key ? totp.match(key, (req.body || {}).code) : -1;
  if (step < 0) { noteFail(failKey(req.user.id)); return res.status(400).json({ error: 'That code didn’t match. Check the time on your phone and try the newest code.' }); }
  const codes = newRecovery();
  if (!q.enable.run(step, JSON.stringify(codes.map(c => hashCode(req.user.id, cleanRecovery(c)))), req.user.id).changes) {
    return res.status(409).json({ error: 'The second step is already on.' });
  }
  q.failClear.run(failKey(req.user.id));
  audit.log(req, 'twostep.on');
  /* other sessions signed in with the password alone end; this one counts as just checked */
  const signedOut = users.endSessions(req.user.id, req.sessionID);
  req.session.checked = Date.now();
  res.json({ ok: true, codes, signedOut });
});
router.post('/disable', async (req, res) => {
  if (!row(req.user.id)) return res.json({ ok: true });
  if (isOn(req.user.id)) {
    const r = await confirm(req.user, req.body || {});
    note(req, r, 'recheck');
    if (r.locked) return res.status(429).json({ error: LOCKED });
    if (!r.ok) return res.status(400).json({ error: 'Enter your password or a code to switch the second step off.' });
    audit.log(req, 'twostep.off');
  }
  q.remove.run(req.user.id);
  res.json({ ok: true });
});

module.exports = { router, isOn, attempt, fresh, recheck, seal, unseal, LOCKED };

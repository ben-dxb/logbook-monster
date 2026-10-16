'use strict';
/* Outgoing email (invites, notifications) over SMTP. The settings live in app_config and are edited
   on the Admin page; SMTP_* values in .env are the fallback. The password never leaves the server. */
const nodemailer = require('nodemailer');
const db = require('./db');

const q = {
  get: db.prepare("SELECT data FROM app_config WHERE key = 'email'"),
  put: db.prepare(`INSERT INTO app_config (key, data, updated_by) VALUES ('email', ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = datetime('now')`),
};

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
const bool = v => /^(1|true|yes|on)$/i.test(String(v || ''));

function stored() { const r = q.get.get(); return r ? JSON.parse(r.data) : {}; }
function fromEnv() {
  const e = process.env;
  return { host: e.SMTP_HOST || '', port: +e.SMTP_PORT || 0, secure: e.SMTP_SECURE == null ? null : bool(e.SMTP_SECURE),
    user: e.SMTP_USER || '', pass: e.SMTP_PASS || '', from: e.MAIL_FROM || '', fromName: e.MAIL_FROM_NAME || '' };
}
/* Settings saved on the Admin page win over .env, field by field. */
function current() {
  const s = stored(), env = fromEnv();
  const pick = k => (s[k] != null && s[k] !== '' ? s[k] : env[k]);
  const port = +pick('port') || 587;
  const secure = s.secure != null ? !!s.secure : env.secure != null ? env.secure : port === 465;
  const pass = pick('pass') || '';
  const from = pick('from') || (EMAIL_RE.test(pick('user') || '') ? pick('user') : '');
  /* Gmail and most providers sign in as the address you send from, so a blank username means that. */
  const user = pick('user') || (pass ? from : '');
  return { host: pick('host') || '', port, secure, user, pass, from, fromName: pick('fromName') || 'Logbook Monster',
    source: s.host ? 'admin' : env.host ? 'env' : null, passSource: s.pass ? 'admin' : env.pass ? 'env' : null };
}
const configured = () => { const c = current(); return !!(c.host && c.from); };

/* What the browser may see: never the password itself. */
function status() {
  const c = current();
  return { configured: !!(c.host && c.from), source: c.source, host: c.host, port: c.port, secure: c.secure, user: stored().user || process.env.SMTP_USER || '',
    hasPassword: !!c.pass, passwordSource: c.passSource, from: c.from, fromName: c.fromName };
}

function save(body, user) {
  const s = stored();
  const str = (k, max) => { if (body[k] === undefined) return; const v = String(body[k] || '').trim().slice(0, max); if (v) s[k] = v; else delete s[k]; };
  str('host', 253); str('user', 254); str('from', 254); str('fromName', 100);
  if (s.host && !HOST_RE.test(s.host)) throw new Error('Server should be a host name like smtp.gmail.com');
  if (s.from && !EMAIL_RE.test(s.from)) throw new Error('Enter a valid “send from” email address');
  if (s.fromName && /[\r\n<>"]/.test(s.fromName)) throw new Error('Sender name can’t contain < > or quotes');
  if (body.port !== undefined) {
    const p = body.port === '' || body.port == null ? 0 : +body.port;
    if (p && !(Number.isInteger(p) && p > 0 && p < 65536)) throw new Error('Port should be a number like 465 or 587');
    if (p) s.port = p; else delete s.port;
  }
  if (body.secure !== undefined) { if (body.secure === null || body.secure === '') delete s.secure; else s.secure = !!body.secure; }
  if (body.pass !== undefined) {
    const p = String(body.pass || '');
    if (p.length > 500) throw new Error('Password is too long');
    if (p) s.pass = p; else delete s.pass;
  }
  /* Google shows app passwords in groups of four ("abcd efgh ijkl mnop"); the spaces aren't part of it. */
  if (s.pass && /(^|\.)(gmail|googlemail)\.com$/i.test(s.host || fromEnv().host)) s.pass = s.pass.replace(/\s+/g, '');
  q.put.run(JSON.stringify(s), user.email);
  return status();
}

function transport(c) {
  return nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
  });
}

/* Send one email. Throws with a readable message if email isn't set up or the server refuses it. */
async function send({ to, subject, text, replyTo }) {
  const c = current();
  if (!c.host || !c.from) { const e = new Error('Email isn’t set up yet – add the sending account on the Admin page.'); e.status = 409; throw e; }
  if (!EMAIL_RE.test(String(to || ''))) { const e = new Error('That isn’t a valid email address'); e.status = 400; throw e; }
  try {
    await transport(c).sendMail({ from: { name: c.fromName, address: c.from }, to, subject, text, replyTo });
  } catch (err) {
    const e = new Error(`The mail server didn’t accept it: ${String(err.response || err.message || err).slice(0, 200)}`);
    e.status = 502; throw e;
  }
}

/* For notifications nobody is waiting on: log and carry on if it fails. */
function notify(msg) {
  if (!configured()) return;
  send(msg).catch(e => console.error('Email notification failed:', e.message));
}

module.exports = { status, save, send, notify, configured, EMAIL_RE };

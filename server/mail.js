'use strict';
/* Outgoing email (invites, notifications) over SMTP. The settings live in app_config and are edited
   on the Admin page; SMTP_* values in .env are the fallback. The password never leaves the server. */
const net = require('node:net');
const dns = require('node:dns').promises;
const nodemailer = require('nodemailer');
const db = require('./db');
const config = require('./config');

const q = {
  get: db.prepare("SELECT data FROM app_config WHERE key = 'email'"),
  put: db.prepare(`INSERT INTO app_config (key, data) VALUES ('email', ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`),
  reseal: db.prepare("UPDATE app_config SET data = ? WHERE key = 'email'"),
};

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
const bool = v => /^(1|true|yes|on)$/i.test(String(v || ''));

/* The mail server must be on the internet: no loopback, private, link-local (cloud metadata), CGNAT, Docker or unique-local
   addresses – unless .env lists the host in SMTP_ALLOW_HOSTS (a local relay, the tests). Checked on the resolved addresses. */
const INTERNAL = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) INTERNAL.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]]) INTERNAL.addSubnet(a, n, 'ipv6');
const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4'); LOOPBACK.addAddress('::1', 'ipv6');
function internal(ip) {
  const v = net.isIP(ip);
  if (v === 6) { const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); if (m) return internal(m[1]); }
  return !v || INTERNAL.check(ip, v === 6 ? 'ipv6' : 'ipv4');
}
const allowed = host => config.smtpAllowHosts.includes(String(host).toLowerCase());
const refuse = (msg, status) => Object.assign(new Error(msg), { status });
/* The address to connect to. Throws (400) on an internal one; `soft` lets a name that doesn't resolve through (checked again at send). */
async function resolve(host, soft) {
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await dns.lookup(host, { all: true, verbatim: true })).map(a => a.address); }
    catch { if (soft) return null; throw refuse('Couldn’t find that mail server – check the server name', 502); }
  }
  const ok = allowed(host);
  if (!addrs.length || (!ok && addrs.some(internal))) throw refuse('That mail server is on a private or internal network address, which isn’t allowed', 400);
  const addr = addrs.find(a => net.isIP(a) === 4) || addrs[0];
  return { addr, loopback: ok && LOOPBACK.check(addr, net.isIP(addr) === 6 ? 'ipv6' : 'ipv4') };
}
/* The password is kept sealed (passSealed, server/seal.js); stored() hands it back opened as pass. One kept from before is sealed on start. */
const box = require('./seal')('smtp-pass-v1');
function stored() {
  const r = q.get.get(), s = r ? JSON.parse(r.data) : {};
  if (s.passSealed) { const p = box.unsealText(s.passSealed); if (p) { s.pass = p; delete s.passSealed; } }
  return s;
}
const sealed = ({ pass, ...s }) => JSON.stringify(pass ? { ...s, passSealed: box.sealText(pass) } : s);
{ const r = q.get.get(), s = r && JSON.parse(r.data); if (s && (s.pass || box.stale(s.passSealed))) q.reseal.run(sealed(stored())); }   /* plain, or sealed under an older key */
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
  /* where each value in use comes from: saved on the Admin page, .env, or neither (a default) */
  const from1 = k => (s[k] != null && s[k] !== '' ? 'admin' : env[k] != null && env[k] !== '' && env[k] !== 0 ? 'env' : null);
  const sources = Object.fromEntries(['host', 'port', 'secure', 'user', 'pass', 'from', 'fromName'].map(k => [k, from1(k)]));
  return { host: pick('host') || '', port, secure, user, pass, from, fromName: pick('fromName') || 'Logbook Monster', sources,
    source: Object.values(sources).includes('admin') ? 'admin' : env.host ? 'env' : null, passSource: sources.pass };
}
const configured = () => { const c = current(); return !!(c.host && c.from); };

/* What the browser may see: never the password itself. */
function status() {
  const c = current();
  return { configured: !!(c.host && c.from), source: c.source, host: c.host, port: c.port, secure: c.secure, user: stored().user || process.env.SMTP_USER || '',
    hasPassword: !!c.pass, passwordSource: c.passSource, from: c.from, fromName: c.fromName, sources: c.sources };
}

async function save(body) {
  const s = stored();
  const str = (k, max) => { if (body[k] === undefined) return; const v = String(body[k] || '').trim().slice(0, max); if (v) s[k] = v; else delete s[k]; };
  str('host', 253); str('user', 254); str('from', 254); str('fromName', 100);
  if (s.host && !HOST_RE.test(s.host)) throw new Error('Server should be a host name like smtp.gmail.com');
  if (s.host) await resolve(s.host, true);
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
    if (p) s.pass = p; else { delete s.pass; delete s.passSealed; }
  }
  /* Google shows app passwords in groups of four ("abcd efgh ijkl mnop"); the spaces aren't part of it. */
  if (s.pass && /(^|\.)(gmail|googlemail)\.com$/i.test(s.host || fromEnv().host)) s.pass = s.pass.replace(/\s+/g, '');
  q.put.run(sealed(s));
  return status();
}

/* Connects to the address that was checked (no second lookup), naming the server for TLS. Without implicit TLS, STARTTLS is
   required – except to a loopback relay listed in SMTP_ALLOW_HOSTS, where nothing crosses a network. */
function transportOptions(c, to) {
  return {
    host: to.addr, port: c.port, secure: c.secure, requireTLS: !c.secure && !to.loopback, tls: { minVersion: 'TLSv1.2' },
    ...(net.isIP(c.host) ? {} : { servername: c.host }),
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
  };
}
/* A short reason for the browser; the server's own reply only goes to the log. */
function reason(err) {
  const code = err && err.code;
  if (/missing credentials/i.test(String(err && err.message))) return 'there’s a username but no password – add the password on the Email tab';
  if (code === 'EAUTH') return 'it refused the username or password';
  if (code === 'ETLS' || /STARTTLS|TLS|certificate/i.test(String(err && err.message))) return 'a secure (TLS) connection couldn’t be made';
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED'].includes(code)) return 'couldn’t connect – check the server and port';
  if (code === 'EENVELOPE') return 'it refused the sender or recipient address';
  return 'it refused the message';
}

/* Send one email. Throws with a readable message if email isn't set up or the server refuses it. */
async function send({ to, subject, text, replyTo }) {
  const c = current();
  if (!c.host || !c.from) { const e = new Error('Email isn’t set up yet – add the sending account on the Admin page.'); e.status = 409; throw e; }
  if (!EMAIL_RE.test(String(to || ''))) { const e = new Error('That isn’t a valid email address'); e.status = 400; throw e; }
  const at = await resolve(c.host);
  try {
    await nodemailer.createTransport(transportOptions(c, at)).sendMail({ from: { name: c.fromName, address: c.from }, to, subject, text, replyTo });
  } catch (err) {
    console.error('Email sending failed:', String(err.response || err.message || err).slice(0, 300));
    throw refuse(`The mail server didn’t accept it: ${reason(err)}.`, 502);
  }
}

/* For notifications nobody is waiting on: log and carry on if it fails. */
function notify(msg) {
  if (!configured()) return;
  send(msg).catch(e => console.error('Email notification failed:', e.message));
}

module.exports = { reason, status, save, send, notify, configured, current, EMAIL_RE, internal, transportOptions };

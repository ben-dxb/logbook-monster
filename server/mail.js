'use strict';
/* Outgoing email (invites, notifications) over SMTP. The settings live in app_config and are edited
   on the Admin page; SMTP_* values in .env are the fallback. The password never leaves the server. */
const net = require('node:net');
const dns = require('node:dns');
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
const refuse = (msg, status, code) => Object.assign(new Error(msg), { status, code });

/* How long sending may take (ms): the name lookup, each read from the server, and the whole send (queue, connect and message). */
const LIMITS = { dns: 5000, socket: 15000, send: 30000, dnsKeep: 5 * 60 * 1000, authWait: 30 * 60 * 1000 };
/* A name is looked up over DNS with a time limit (c-ares: not on the thread pool, so a dead DNS server can't block file reads);
   one DNS doesn't know (a hosts-file name such as localhost) goes through the system's lookup, also timed. Kept 5 minutes. */
const resolver = new dns.promises.Resolver({ timeout: LIMITS.dns, tries: 1 });
const looked = new Map();   /* host -> { at, addrs } */
const timed = (p, ms) => {
  let t;
  return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), ms); })]).finally(() => clearTimeout(t));
};
async function lookup(host) {
  const hit = looked.get(host);
  if (hit && Date.now() - hit.at < LIMITS.dnsKeep) return hit.addrs;
  const both = await timed(Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]), LIMITS.dns + 500);
  let addrs = both.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  if (!addrs.length) {
    if (both.some(r => r.reason && ['ETIMEOUT', 'ECONNREFUSED', 'ESERVFAIL'].includes(r.reason.code))) throw Object.assign(new Error('DNS didn’t answer'), { code: 'ETIMEOUT' });
    addrs = (await timed(dns.promises.lookup(host, { all: true, verbatim: true }), LIMITS.dns)).map(a => a.address);
  }
  if (looked.size > 100) looked.clear();
  looked.set(host, { at: Date.now(), addrs });
  return addrs;
}
/* The address to connect to. Throws (400) on an internal one; `soft` lets a name that doesn't resolve through (checked again at send). */
async function resolve(host, soft) {
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = await lookup(host); }
    catch { if (soft) return null; throw refuse('Couldn’t find that mail server – check the server name', 502, 'EDNS'); }
  }
  const ok = allowed(host);
  if (!addrs.length || (!ok && addrs.some(internal))) throw refuse('That mail server is on a private or internal network address, which isn’t allowed', 400);
  const addr = addrs.find(a => net.isIP(a) === 4) || addrs[0];
  return { addr, loopback: ok && LOOPBACK.check(addr, net.isIP(addr) === 6 ? 'ipv6' : 'ipv4') };
}
/* The password is kept sealed (passSealed, server/seal.js); stored() hands it back opened as pass. Like the OpenRouter key
   (ai.js) it has a next slot (saved and tested before it takes over) and an old one (kept OVERLAP after a promote for
   "Test old"); passId / nextId / oldId are random ids for credentials.js. One kept in plain text from before is sealed on start. */
const box = require('./seal')('smtp-pass-v1');
const creds = require('./credentials');
const OVERLAP = 60 * 60 * 1000;
const SLOTS = [['pass', 'passSealed'], ['next', 'nextSealed'], ['old', 'oldSealed']];
function sealed(s) {
  const out = { ...s };
  for (const [k, f] of SLOTS) { delete out[k]; if (s[k]) out[f] = box.sealText(s[k]); }
  return JSON.stringify(out);
}
function stored() {
  const r = q.get.get(), s = r ? JSON.parse(r.data) : {};
  let plain = false;
  for (const [k, f] of SLOTS) {
    if (s[k]) {   /* plain text, written by an older version after a rollback: it wins over a sealed one left from before */
      plain = true;
      if (s[f] && box.unsealText(s[f]) !== s[k]) { s[k + 'Id'] = creds.newKid(); if (k === 'pass') creds.record('SMTP', s[k + 'Id']); }
      delete s[f];
    } else if (s[f]) { const v = box.unsealText(s[f]); if (v) { s[k] = v; delete s[f]; } }
  }
  if (s.oldUntil && Date.now() > s.oldUntil) {   /* its hour is up: dropped for good */
    for (const k of ['old', 'oldSealed', 'oldId', 'oldUntil']) delete s[k];
    plain = true;
  }
  if (plain) q.put.run(sealed(s));
  return s;
}
{ const r = q.get.get(), s = r && JSON.parse(r.data); if (s && SLOTS.some(([k]) => s[k])) q.reseal.run(sealed(stored())); }   /* plain from before */
function fromEnv() {
  const e = process.env;
  return { host: e.SMTP_HOST || '', port: +e.SMTP_PORT || 0, secure: e.SMTP_SECURE == null ? null : bool(e.SMTP_SECURE),
    user: e.SMTP_USER || '', pass: config.envSecret('SMTP_PASS').value, from: e.MAIL_FROM || '', fromName: e.MAIL_FROM_NAME || '' };
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
    hasPassword: !!c.pass, passwordSource: c.passSource, slots: slots(), from: c.from, fromName: c.fromName, sources: c.sources };
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
    const p = passOf(body.pass, s);
    if (p) {
      if (p !== s.pass) setActive(s, p);
      else if (!aged('SMTP', s.passId)) { s.passId = s.passId || creds.newKid(); creds.record('SMTP', s.passId, new Date().toISOString()); }   /* the same password saved again: its age starts now if none was recorded */
    }
    else { for (const k of ['pass', 'passSealed', 'passId', 'old', 'oldSealed', 'oldId', 'oldUntil']) delete s[k]; creds.forget('SMTP'); }
  }
  q.put.run(sealed(s));
  looked.clear(); breaker.reset();   /* new settings get a fresh look */
  return status();
}
/* Google shows app passwords in groups of four ("abcd efgh ijkl mnop"); the spaces aren't part of it. */
function passOf(v, s) {
  const p = String(v || '');
  if (p.length > 500) throw new Error('Password is too long');
  return p && /(^|\.)(gmail|googlemail)\.com$/i.test(s.host || fromEnv().host) ? p.replace(/\s+/g, '') : p;
}
/* has this password (id) a recorded age? One moved over from before the ages were kept has none */
const aged = (name, id) => { const r = creds.recorded(name); return !!(r && r.set_at && r.kid === id); };
/* the active password changes: the one it replaces stays as old for OVERLAP */
function setActive(s, pass, id) {
  if (s.pass && s.pass !== pass) Object.assign(s, { old: s.pass, oldId: s.passId, oldUntil: Date.now() + OVERLAP });
  s.pass = pass; s.passId = id || creds.newKid();
  creds.record('SMTP', s.passId);
}
function saveNext(v) {
  const s = stored(), p = passOf(v, s);
  if (!p) { delete s.next; delete s.nextId; } else { s.next = p; s.nextId = creds.newKid(); }
  q.put.run(sealed(s));
  return status();
}
function promote() {
  const s = stored();
  if (!s.next) throw Object.assign(new Error('Save a next password first'), { status: 409 });
  setActive(s, s.next, s.nextId);
  delete s.next; delete s.nextId;
  q.put.run(sealed(s));
  return status();
}
/* which slots hold a password (never the passwords), for the Keys panel */
function slots() {
  const s = stored(), c = current();
  return { source: c.pass ? c.passSource : null, next: !!s.next, old: !!s.old, oldUntil: s.old ? s.oldUntil : null };
}
/* One real sign-in with a slot's password and the saved settings: connect, TLS, AUTH, then quit – no email is sent. */
async function verify(slot) {
  const s = stored(), c = current();
  const pass = slot === 'active' ? c.pass : s[slot];
  if (!pass) throw refuse(slot === 'old' ? 'There’s no old password any more – it was dropped an hour after the promote' : `There’s no ${slot} password`, 404);
  if (!c.host || !c.from) throw refuse('Email isn’t set up yet – add the sending account first.', 409);
  const at = await resolve(c.host);
  try {
    await nodemailer.createTransport(transportOptions({ ...c, pass, user: c.user || c.from }, at)).verify();
    return { slot, ok: true, dead: false };
  } catch (err) {
    console.error(`SMTP check of the ${slot} password failed:`, String(err.response || err.message || err).slice(0, 300));
    return { slot, ok: false, dead: err && err.code === 'EAUTH', error: `The mail server didn’t accept it: ${reason(err)}.` };
  }
}

/* Connects to the address that was checked (no second lookup), naming the server for TLS. Without implicit TLS, STARTTLS is
   required – except to a loopback relay listed in SMTP_ALLOW_HOSTS, where nothing crosses a network. */
function transportOptions(c, to) {
  return {
    host: to.addr, port: c.port, secure: c.secure, requireTLS: !c.secure && !to.loopback, tls: { minVersion: 'TLSv1.2' },
    ...(net.isIP(c.host) ? {} : { servername: c.host }),
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: LIMITS.socket,
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

/* a refusal sending again won't change: the sender or recipient refused, or a 5xx answer to the message (not a sign-in) */
const permanent = err => !!err && err.code !== 'EAUTH' && (err.code === 'EENVELOPE' || (err.responseCode >= 500 && err.responseCode < 600));

/* One connection per send, over a socket of our own (nodemailer connects it and adds TLS): a send cut at LIMITS.send destroys
   it, so the server can't carry on and deliver it after the retry has (a pool's close() leaves a busy connection running). */
const sockets = new Set();
function transport(opts) {
  const socket = new net.Socket();
  sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  return { t: nodemailer.createTransport({ ...opts, socket }), socket };
}

/* A mail server that can't be reached (3 sends in a row that couldn't connect, timed out or whose name didn't resolve) is
   left alone for 2 minutes, doubling to 30 while the one test send let through after that fails too: meanwhile sends fail at
   once (503) – the test email says so straight away, an invite returns its link, notifications wait in the outbox. A refused
   username or password (EAUTH) leaves it alone for LIMITS.authWait at once, so a wrong password isn't tried again and again at the
   provider; saving the email settings gives it a fresh try. */
const DOWN = ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ETIMEOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'];
const breaker = {
  fails: 0, until: 0, wait: 2 * 60 * 1000, probing: false,
  auth: false,
  open() { return this.until > Date.now() || (this.fails >= 3 && this.probing); },
  /* true for the one send let through to see whether it's back */
  enter() {
    if (this.open()) {
      throw refuse(this.auth ? 'The mail server refused the app’s username or password – check them on Super admin › Email'
        : 'The mail server isn’t answering – try again in a few minutes', 503);
    }
    if (this.fails >= 3) { this.probing = true; return true; }
    return false;
  },
  result(err, probe) {
    if (probe) this.probing = false;
    if (err && err.code === 'EAUTH') {
      Object.assign(this, { fails: 3, auth: true, until: Date.now() + LIMITS.authWait });
      console.error(`Mail server refused the username or password: leaving it ${Math.round(LIMITS.authWait / 60000)} min – check them on Super admin › Email`);
      return;
    }
    this.auth = false;
    if (!err || !DOWN.includes(err.code)) { if (this.fails >= 3) console.log('Mail server answering again'); this.fails = 0; this.until = 0; this.wait = 2 * 60 * 1000; return; }
    this.fails++;
    if (probe) this.wait = Math.min(this.wait * 2, 30 * 60 * 1000);
    if (this.fails >= 3) { this.until = Date.now() + this.wait; console.error(`Mail server not answering (${err.code}): leaving it ${Math.round(this.wait / 60000)} min`); }
  },
  reset() { Object.assign(this, { fails: 0, until: 0, wait: 2 * 60 * 1000, probing: false, auth: false }); },
};

/* Send one email. Throws with a readable message if email isn't set up or the server refuses it. */
async function send({ to, subject, text, replyTo }) {
  const c = current();
  if (!c.host || !c.from) { const e = new Error('Email isn’t set up yet – add the sending account on the Admin page.'); e.status = 409; throw e; }
  if (!EMAIL_RE.test(String(to || ''))) { const e = new Error('That isn’t a valid email address'); e.status = 400; throw e; }
  const probe = breaker.enter();
  let at;
  try { at = await resolve(c.host); } catch (e) { breaker.result(e.code ? e : null, probe); throw e; }
  const { t, socket } = transport(transportOptions(c, at));
  let timer;
  try {
    await Promise.race([
      t.sendMail({ from: { name: c.fromName, address: c.from }, to, subject, text, replyTo }),
      new Promise((_, no) => { timer = setTimeout(() => { socket.destroy(); no(Object.assign(new Error(`no answer within ${LIMITS.send / 1000} s`), { code: 'ETIMEDOUT' })); }, LIMITS.send); }),
    ]);
    breaker.result(null, probe);
  } catch (err) {
    breaker.result(err, probe);
    socket.destroy();
    console.error('Email sending failed:', String(err.response || err.message || err).slice(0, 300));
    throw Object.assign(refuse(`The mail server didn’t accept it: ${reason(err)}.`, 502, err.code), { permanent: permanent(err) });
  } finally { clearTimeout(timer); }
}

/* For notifications nobody is waiting on: kept in the outbox table and sent there, 2 at a time, tried again after 1, 5, 15 and
   then every 60 minutes until sent or `keep` ms old (24 hours: security notices; JOB_KEEP for an AI read being ready); one the
   server refuses for good (a bad recipient, a 5xx answer – `permanent`) is dropped at once, logged. Ones left from before a
   restart go out after it. */
const MIN = 60 * 1000, KEEP = 24 * 60 * MIN, JOB_KEEP = 6 * 60 * MIN, RETRY = [1, 5, 15, 60].map(m => m * MIN);
const qo = {
  add: db.prepare('INSERT INTO outbox (msg, next_at, expires_at) VALUES (?, ?, ?)'),
  due: db.prepare('SELECT id, msg, tries, expires_at FROM outbox WHERE next_at <= ? ORDER BY next_at, id LIMIT 8'),
  done: db.prepare('DELETE FROM outbox WHERE id = ?'),
  later: db.prepare('UPDATE outbox SET tries = ?, next_at = ? WHERE id = ?'),
  old: db.prepare('DELETE FROM outbox WHERE expires_at <= ?'),
  all: db.prepare('SELECT id, tries, next_at, expires_at FROM outbox ORDER BY id'),
};
const sending = new Set();
function notify(msg, { keep = KEEP } = {}) {
  if (!configured()) return;
  const now = Date.now(), { to, subject, text, replyTo } = msg;
  try { qo.add.run(JSON.stringify({ to, subject, text, replyTo }), now, now + keep); }
  catch (e) { console.error('Email notification couldn’t be queued:', e.message); return; }
  drain();
}
function drain() {
  try {
    const now = Date.now(), gone = qo.old.run(now).changes;
    if (gone) console.error(`Dropped ${gone} email notification${gone === 1 ? '' : 's'} that couldn’t be sent in time`);
    if (breaker.open() || !configured()) return;
    for (const row of qo.due.all(now)) {
      if (sending.size >= (breaker.fails >= 3 ? 1 : 2)) break;
      if (sending.has(row.id)) continue;
      sending.add(row.id);
      let m;
      try { m = JSON.parse(row.msg); } catch { m = null; }
      let next = true;   /* a write here that fails (a full disk) waits for the timer rather than send the same row again at once */
      Promise.resolve(m ? send(m) : Promise.reject(refuse('unreadable', 400))).then(() => qo.done.run(row.id), e => {
        const when = Date.now();
        if (e.status === 400 || e.status === 409 || e.permanent) { console.error('Email notification dropped:', e.message); return qo.done.run(row.id); }
        if (e.status === 503) return qo.later.run(row.tries, Math.max(breaker.until, when + MIN), row.id);   /* not tried: the breaker is open */
        const tries = row.tries + 1, next = when + RETRY[Math.min(tries, RETRY.length) - 1];
        if (next >= row.expires_at) { console.error('Email notification dropped after', tries, 'tries:', e.message); return qo.done.run(row.id); }
        qo.later.run(tries, next, row.id);
      }).catch(e => { next = false; console.error('Email outbox:', e.message); }).finally(() => { sending.delete(row.id); if (next) setImmediate(drain); });
    }
  } catch (e) { console.error('Email outbox:', e.message); }
}
setInterval(drain, 30 * 1000).unref();
setTimeout(drain, 2000).unref();   /* what was left from before a restart */
const outbox = { drain, rows: () => qo.all.all(), sending };
const _test = { resolver, looked, sockets };

module.exports = { reason, status, save, saveNext, promote, verify, slots, send, notify, configured, current, EMAIL_RE, internal, transportOptions, LIMITS, breaker, outbox, JOB_KEEP, RETRY, _test };

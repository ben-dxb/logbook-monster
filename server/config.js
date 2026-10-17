'use strict';
require('dotenv').config({ quiet: true });

/* A secret from .env and the day it was set (server/credentials.js counts its age from that): an optional "YYYY-MM-DD:" in
   front of the value, e.g. SEAL_KEY=2026-10-17:abc…, or <NAME>_SET=YYYY-MM-DD beside it. The prefix is never part of the key. */
const DATED = /^(\d{4}-\d\d-\d\d):([\s\S]*)$/;
const dayOk = d => /^\d{4}-\d\d-\d\d$/.test(d || '') && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
function dated(raw, companion) {
  const m = DATED.exec(String(raw || '')), value = m && dayOk(m[1]) ? m[2] : String(raw || '');
  return { value, set: m && dayOk(m[1]) ? m[1] : dayOk(companion) ? companion : '' };
}
const envSecret = name => dated(process.env[name], process.env[name + '_SET']);

const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const list = v => (v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const isProd = process.env.NODE_ENV === 'production';
const port = +process.env.PORT || 3000;
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');

// Keep using the database from before the rename (data/mealswap.db) if that's the one that exists.
function defaultDbPath() {
  const path = require('path'), fs = require('fs');
  const dir = path.join(__dirname, '..', 'data');
  const current = path.join(dir, 'logbook-monster.db'), legacy = path.join(dir, 'mealswap.db');
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

const config = {
  isProd,
  port,
  host: process.env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
  baseUrl,
  /* absolute, so a relative DB_PATH / PHOTO_DIR doesn't depend on the working directory (res.sendFile needs absolute paths) */
  dbPath: require('path').resolve(process.env.DB_PATH || defaultDbPath()),
  /* progress photos are files, kept next to the database unless PHOTO_DIR says otherwise */
  photoDir: process.env.PHOTO_DIR || '',
  /* SESSION_SECRETS=newest,current,previous (docs/rotation.md): the first signs session cookies (and the CSRF pre-cookie and AI-fill
     signatures), all of them are accepted. Without it, SESSION_SECRET and SESSION_SECRET_OLD as before. Filled in below. */
  sessionSecrets: [],
  sessionSecretDates: [],
  sessionSecretSource: '',
  sessionSecret: '',
  /* the key-encrypting key for the secrets sealed in the database (seal.js); without it, the first session secret.
     SEAL_KEY_OLD: the one before a rotation, only for unwrapping (rewrapped with SEAL_KEY on start) */
  sealKey: envSecret('SEAL_KEY').value,
  sealKeyOld: envSecret('SEAL_KEY_OLD').value,
  /* keys the masked-email hash in the security log (audit.js); without it, the first session secret – so rotating those
     doesn't stop new rows linking with old ones, set this once */
  auditHashKey: envSecret('AUDIT_HASH_KEY').value,
  sessionDays: +process.env.SESSION_DAYS || 30,
  cookieSecure: bool(process.env.COOKIE_SECURE, baseUrl.startsWith('https://')),
  /* off unless set: only behind a proxy that overwrites X-Forwarded-For (docker-compose.yml sets 1 for Caddy/nginx) */
  trustProxy: process.env.TRUST_PROXY || '',
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, false),
  allowedEmails: list(process.env.ALLOWED_EMAILS),
  /* Sign-in and invite attempts allowed per IP every 15 minutes. Only the tests raise it. */
  authRateLimit: Math.max(1, +process.env.AUTH_RATE_LIMIT || 20),
  /* Wrong passwords allowed per account (email) every 15 minutes, from any address. */
  accountFailLimit: Math.max(1, +process.env.ACCOUNT_FAIL_LIMIT || 10),
  adminEmails: list(process.env.ADMIN_EMAILS),
  /* Saves (any POST/PUT/DELETE under /api) per account every 10 minutes, and data exports per account an hour. */
  writeRateLimit: Math.max(1, +process.env.WRITE_RATE_LIMIT || 1000),
  exportRateLimit: Math.max(1, +process.env.EXPORT_RATE_LIMIT || 10),
  /* Timeline trend reads (heavy: every day, set and weight in the range) per account or coach link every 10 minutes, and
     answers to one coach link every 10 minutes. */
  trendsRateLimit: Math.max(1, +process.env.TRENDS_RATE_LIMIT || 120),
  coachRateLimit: Math.max(1, +process.env.COACH_RATE_LIMIT || 600),
  /* What one account can store, in bytes: saved days' JSON, its plan history, and photo files (thumbnails included).
     Only the tests lower them. */
  quota: {
    days: Math.max(1, +process.env.QUOTA_DAYS_BYTES || 50 * 1024 * 1024),
    plan: Math.max(1, +process.env.QUOTA_PLAN_BYTES || 10 * 1024 * 1024),
    photos: Math.max(1, +process.env.QUOTA_PHOTO_BYTES || 5 * 1024 * 1024 * 1024),
  },
  /* mail servers allowed on internal addresses (a local relay, the tests); any other must be on the internet */
  smtpAllowHosts: list(process.env.SMTP_ALLOW_HOSTS),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: envSecret('GOOGLE_CLIENT_SECRET').value,
  },
};
config.photoDir = require('path').resolve(config.photoDir || require('path').join(require('path').dirname(config.dbPath), 'photos'));
config.google.enabled = !!(config.google.clientId && config.google.clientSecret);
/* Over https the session cookie is __Host- (Secure, whole site, this host only); the http laptop setup can't use the prefix. */
config.sessionCookie = config.cookieSecure ? '__Host-logbookmonster.sid' : 'logbookmonster.sid';

{
  const bad = name => {
    console.error(`${name} must be a random string of at least 32 characters${name === 'SESSION_SECRETS' ? ' each' : ' (or not set)'}.`);
    if (isProd) process.exit(1);
  };
  const list = process.env.SESSION_SECRETS;
  if (list) {
    const items = list.split(',').map(x => x.trim()).filter(Boolean).map((x, i) => dated(x, i === 0 ? process.env.SESSION_SECRETS_SET : ''));
    if (items.some(x => x.value.length < 32)) bad('SESSION_SECRETS');
    const ok = items.filter(x => x.value.length >= 32);
    config.sessionSecrets = ok.map(x => x.value); config.sessionSecretDates = ok.map(x => x.set); config.sessionSecretSource = 'SESSION_SECRETS';
    if (process.env.SESSION_SECRET || process.env.SESSION_SECRET_OLD) console.warn('SESSION_SECRETS is set, so SESSION_SECRET and SESSION_SECRET_OLD are ignored – remove them from .env.');
  } else {
    const cur = envSecret('SESSION_SECRET'), old = envSecret('SESSION_SECRET_OLD');
    if (old.value && old.value.length < 32) { bad('SESSION_SECRET_OLD'); old.value = ''; }
    if (cur.value.length >= 32) {
      config.sessionSecrets = [cur.value, old.value].filter(Boolean); config.sessionSecretDates = [cur.set, old.set].slice(0, config.sessionSecrets.length);
      config.sessionSecretSource = 'SESSION_SECRET';
    }
  }
  if (!config.sessionSecrets.length) {
    if (isProd) {
      console.error('SESSION_SECRETS (or SESSION_SECRET) must be set to a random string of at least 32 characters in production.');
      process.exit(1);
    }
    /* Local testing: keep a random secret next to the database so restarts don't sign you out. Its age is the file's. */
    const fs = require('fs'), path = require('path');
    const file = path.join(path.dirname(config.dbPath), '.session-secret');
    let s = '';
    try { s = fs.readFileSync(file, 'utf8').trim(); } catch {}
    if (s.length < 32) {
      s = require('crypto').randomBytes(32).toString('hex');
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, s, { mode: 0o600 }); } catch {}
    }
    let set = '';
    try { set = fs.statSync(file).mtime.toISOString().slice(0, 10); } catch {}
    config.sessionSecrets = [s]; config.sessionSecretDates = [set]; config.sessionSecretSource = 'file';
  }
  config.sessionSecret = config.sessionSecrets[0];
  for (const [k, name] of [['sealKey', 'SEAL_KEY'], ['sealKeyOld', 'SEAL_KEY_OLD'], ['auditHashKey', 'AUDIT_HASH_KEY']]) {
    if (config[k] && config[k].length < 32) { bad(name); config[k] = ''; }
  }
}
config.envSecret = envSecret;
config.dayOk = dayOk;

/* Without ADMIN_EMAILS the first account created becomes super admin – fine on a laptop, not on a server. */
if (isProd && !config.adminEmails.length) {
  console.error('ADMIN_EMAILS must be set in production (comma-separated addresses of the super admins), e.g. ADMIN_EMAILS=you@example.com');
  process.exit(1);
}

/* Invite links, emails and the Google redirect are built from BASE_URL; on a server localhost links reach nobody. */
if (isProd && !process.env.BASE_URL) {
  console.warn(`BASE_URL isn’t set: invite links, emails and Google sign-in will point at ${baseUrl}. Set BASE_URL to the address people open, e.g. BASE_URL=https://logbook.example.com`);
}

/* Who may hold an account. With ALLOWED_EMAILS set, only those addresses can sign in at all. */
config.emailAllowed = email => !config.allowedEmails.length || config.allowedEmails.includes(String(email).toLowerCase());
config.mayCreateAccount = email => config.emailAllowed(email) && (config.allowRegistration || config.allowedEmails.includes(String(email).toLowerCase()));

module.exports = config;

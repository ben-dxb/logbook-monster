'use strict';
require('dotenv').config({ quiet: true });

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
  dbPath: process.env.DB_PATH || defaultDbPath(),
  /* progress photos are files, kept next to the database unless PHOTO_DIR says otherwise */
  photoDir: process.env.PHOTO_DIR || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionDays: +process.env.SESSION_DAYS || 30,
  cookieSecure: bool(process.env.COOKIE_SECURE, baseUrl.startsWith('https://')),
  trustProxy: process.env.TRUST_PROXY || (isProd ? '1' : ''),
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, false),
  allowedEmails: list(process.env.ALLOWED_EMAILS),
  /* Sign-in and invite attempts allowed per IP every 15 minutes. Only the tests raise it. */
  authRateLimit: Math.max(1, +process.env.AUTH_RATE_LIMIT || 20),
  /* Wrong passwords allowed per account (email) every 15 minutes, from any address. */
  accountFailLimit: Math.max(1, +process.env.ACCOUNT_FAIL_LIMIT || 10),
  adminEmails: list(process.env.ADMIN_EMAILS),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
};
if (!config.photoDir) config.photoDir = require('path').join(require('path').dirname(config.dbPath), 'photos');
config.google.enabled = !!(config.google.clientId && config.google.clientSecret);

if (!config.sessionSecret || config.sessionSecret.length < 32) {
  if (isProd) {
    console.error('SESSION_SECRET must be set to a random string of at least 32 characters in production.');
    process.exit(1);
  }
  /* Local testing: keep a random secret next to the database so restarts don't sign you out. */
  const fs = require('fs'), path = require('path');
  const file = path.join(path.dirname(config.dbPath), '.session-secret');
  try { config.sessionSecret = fs.readFileSync(file, 'utf8').trim(); } catch {}
  if (config.sessionSecret.length < 32) {
    config.sessionSecret = require('crypto').randomBytes(32).toString('hex');
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, config.sessionSecret, { mode: 0o600 }); } catch {}
  }
}

/* Who may hold an account. With ALLOWED_EMAILS set, only those addresses can sign in at all. */
config.emailAllowed = email => !config.allowedEmails.length || config.allowedEmails.includes(String(email).toLowerCase());
config.mayCreateAccount = email => config.emailAllowed(email) && (config.allowRegistration || config.allowedEmails.includes(String(email).toLowerCase()));

module.exports = config;

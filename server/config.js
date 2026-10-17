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
  /* absolute, so a relative DB_PATH / PHOTO_DIR doesn't depend on the working directory (res.sendFile needs absolute paths) */
  dbPath: require('path').resolve(process.env.DB_PATH || defaultDbPath()),
  /* progress photos are files, kept next to the database unless PHOTO_DIR says otherwise */
  photoDir: process.env.PHOTO_DIR || '',
  sessionSecret: process.env.SESSION_SECRET || '',
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
  /* mail servers allowed on internal addresses (a local relay, the tests); any other must be on the internet */
  smtpAllowHosts: list(process.env.SMTP_ALLOW_HOSTS),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
};
config.photoDir = require('path').resolve(config.photoDir || require('path').join(require('path').dirname(config.dbPath), 'photos'));
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

/* Without ADMIN_EMAILS the first account created becomes super admin – fine on a laptop, not on a server. */
if (isProd && !config.adminEmails.length) {
  console.error('ADMIN_EMAILS must be set in production (comma-separated addresses of the super admins), e.g. ADMIN_EMAILS=you@example.com');
  process.exit(1);
}

/* Who may hold an account. With ALLOWED_EMAILS set, only those addresses can sign in at all. */
config.emailAllowed = email => !config.allowedEmails.length || config.allowedEmails.includes(String(email).toLowerCase());
config.mayCreateAccount = email => config.emailAllowed(email) && (config.allowRegistration || config.allowedEmails.includes(String(email).toLowerCase()));

module.exports = config;

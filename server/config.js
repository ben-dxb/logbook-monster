'use strict';
require('dotenv').config({ quiet: true });

const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const list = v => (v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const isProd = process.env.NODE_ENV === 'production';
const port = +process.env.PORT || 3000;
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');

const config = {
  isProd,
  port,
  host: process.env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
  baseUrl,
  dbPath: process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'mealswap.db'),
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionDays: +process.env.SESSION_DAYS || 30,
  cookieSecure: bool(process.env.COOKIE_SECURE, baseUrl.startsWith('https://')),
  trustProxy: process.env.TRUST_PROXY || (isProd ? '1' : ''),
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, false),
  allowedEmails: list(process.env.ALLOWED_EMAILS),
  adminEmails: list(process.env.ADMIN_EMAILS),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
};
config.google.enabled = !!(config.google.clientId && config.google.clientSecret);

if (!config.sessionSecret || config.sessionSecret.length < 32) {
  if (isProd) {
    console.error('SESSION_SECRET must be set to a random string of at least 32 characters in production.');
    process.exit(1);
  }
  config.sessionSecret = require('crypto').randomBytes(32).toString('hex');
  console.warn('[dev] SESSION_SECRET not set - using a random one, so sessions reset on every restart.');
}

/* Who may hold an account. With ALLOWED_EMAILS set, only those addresses can sign in at all. */
config.emailAllowed = email => !config.allowedEmails.length || config.allowedEmails.includes(String(email).toLowerCase());
config.mayCreateAccount = email => config.emailAllowed(email) && (config.allowRegistration || config.allowedEmails.includes(String(email).toLowerCase()));

module.exports = config;

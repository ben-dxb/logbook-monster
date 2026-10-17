'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const config = require('./config');
const db = require('./db');
const SqliteStore = require('./sessionStore');
const auth = require('./auth');
const api = require('./api');
const shares = require('./shares');
const audit = require('./audit');

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? +config.trustProxy : config.trustProxy);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'form-action': ["'self'"],
      'base-uri': ["'none'"],
      'frame-ancestors': ["'none'"],
      'upgrade-insecure-requests': config.cookieSecure ? [] : null,
    },
  },
  strictTransportSecurity: config.cookieSecure ? undefined : false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));
/* No powerful browser features the app doesn't use (it does use Web Share, clipboard and notifications).
   API and auth answers carry health data and the CSRF token: never cached (photos set their own). */
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=()');
  if (/^\/(api|auth)\//.test(req.path)) res.set('Cache-Control', 'no-store');
  next();
});

app.use(session({
  name: 'logbookmonster.sid',
  secret: config.sessionSecret,
  store: new SqliteStore(db, { maxAge: config.sessionDays * 24 * 60 * 60 * 1000 }),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: !!config.trustProxy,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionDays * 24 * 60 * 60 * 1000,
  },
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/auth', auth.router);
app.use('/api', api);
/* Coach links: read only, no sign-in – the secret in the path is the key (server/shares.js). */
app.use('/coach/:token/api', shares.coach);

const pub = path.join(__dirname, '..', 'public');
const page = file => (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(pub, file));
const signedIn = req => !!(req.session && req.session.userId);

app.get('/login', (req, res, next) => (signedIn(req) ? res.redirect('/') : page('login.html')(req, res, next)));
app.get('/invite', page('invite.html'));
app.get('/coach/:token', (req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); page('coach.html')(req, res, next); });
app.get(['/', '/index.html'], (req, res, next) => (signedIn(req) ? page('index.html')(req, res, next) : res.redirect('/login')));
app.use(express.static(pub, { index: false, maxAge: config.isProd ? '1h' : 0 }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
  console.error(`${req.method} ${audit.redact(req.originalUrl)}:`, err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(config.port, config.host, () => {
  console.log(`Logbook Monster listening on ${config.baseUrl} (bound to ${config.host}:${config.port})`);
  if (!config.google.enabled) console.log('Google sign-in is off - set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to turn it on.');
});

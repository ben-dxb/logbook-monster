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
      'frame-ancestors': ["'none'"],
      'upgrade-insecure-requests': config.cookieSecure ? [] : null,
    },
  },
  strictTransportSecurity: config.cookieSecure ? undefined : false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));

app.use(session({
  name: 'mealswap.sid',
  secret: config.sessionSecret,
  store: new SqliteStore(db),
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

const pub = path.join(__dirname, '..', 'public');
const page = file => (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(pub, file));
const signedIn = req => !!(req.session && req.session.userId);

app.get('/login', (req, res, next) => (signedIn(req) ? res.redirect('/') : page('login.html')(req, res, next)));
app.get('/invite', page('invite.html'));
app.get(['/', '/index.html'], (req, res, next) => (signedIn(req) ? page('index.html')(req, res, next) : res.redirect('/login')));
app.use(express.static(pub, { index: false, maxAge: config.isProd ? '1h' : 0 }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(config.port, config.host, () => {
  console.log(`Meal Swap listening on ${config.baseUrl} (bound to ${config.host}:${config.port})`);
  if (!config.google.enabled) console.log('Google sign-in is off - set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to turn it on.');
});

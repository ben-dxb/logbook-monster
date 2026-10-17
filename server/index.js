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
  /* two years; preload is left to the owner (it binds every subdomain for good). No page relies on a popup keeping its opener
     (Google sign-in is a full-page redirect), so the opener policy is plain same-origin. */
  strictTransportSecurity: config.cookieSecure ? { maxAge: 63072000, includeSubDomains: true } : false,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
}));
/* No powerful browser features the app doesn't use (it does use Web Share, clipboard and notifications).
   API and auth answers carry health data and the CSRF token: never cached (photos set their own). */
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=()');
  if (/^\/(api|auth)\//.test(req.path)) res.set('Cache-Control', 'no-store');
  next();
});

/* Moving to the __Host- cookie name keeps people signed in: a cookie under the old name is read as the new one, and dropped –
   only for 30 days from the first start that had this (kept in app_config), so after that a cookie tossed in under the old name
   from a sibling subdomain does nothing (NEW-SEC-05). */
const OLD_COOKIE = 'logbookmonster.sid', SHIM_DAYS = 30;
const shimUntil = (() => {
  db.prepare("INSERT OR IGNORE INTO app_config (key, data) VALUES ('cookieMigration', ?)").run(JSON.stringify({ start: Date.now() }));
  try { return JSON.parse(db.prepare("SELECT data FROM app_config WHERE key = 'cookieMigration'").get().data).start + SHIM_DAYS * 86400000; } catch { return 0; }
})();
if (config.sessionCookie !== OLD_COOKIE) {
  app.use((req, res, next) => {
    const h = req.headers.cookie;
    if (h && /(?:^|;\s*)logbookmonster\.sid=/.test(h)) {
      if (Date.now() >= shimUntil) {   /* ignored: taken out of the header so nothing reads it */
        req.headers.cookie = h.replace(/(^|;\s*)logbookmonster\.sid=[^;]*/g, '').replace(/^;\s*/, '');
        res.clearCookie(OLD_COOKIE, { path: '/', secure: true });
        return next();
      }
      if (!h.includes(config.sessionCookie + '=')) req.headers.cookie = h.replace(/(^|;\s*)logbookmonster\.sid=/, `$1${config.sessionCookie}=`);
      res.clearCookie(OLD_COOKIE, { path: '/', secure: true });
    }
    next();
  });
}
app.use(session({
  name: config.sessionCookie,
  /* SESSION_SECRET_OLD: the one before a rotation, still accepted on cookies signed with it (README › Rotating secrets) */
  secret: [config.sessionSecret, config.sessionSecretOld].filter(Boolean),
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

/* a session for an account that can no longer sign in is ended here, and /login says why */
const gone = (req, res) => req.session.destroy(() => res.redirect('/login?error=gone'));
app.get('/login', (req, res, next) => (auth.refused(req) ? gone(req, res) : signedIn(req) ? res.redirect('/') : page('login.html')(req, res, next)));
app.get('/invite', page('invite.html'));
app.get('/coach/:token', (req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); page('coach.html')(req, res, next); });
app.get(['/', '/index.html'], (req, res, next) => (auth.refused(req) ? gone(req, res) : signedIn(req) ? page('index.html')(req, res, next) : res.redirect('/login')));
/* The HTML pages are served only by the routes above (sign-in check, no-store). A copy reached through the static files –
   /login.html, or /%69ndex.html, which the routes above don't match but the file server decodes – goes to its route instead. */
const PAGES = { 'index.html': '/', 'login.html': '/login', 'invite.html': '/invite' };
app.use((req, res, next) => {
  let p;
  try { p = decodeURIComponent(req.path); } catch { return res.status(400).json({ error: 'Bad path' }); }
  if (!/\.html?$/i.test(p.replace(/\/+$/, ''))) return next();
  const to = PAGES[path.posix.basename(p).toLowerCase()];
  return to ? res.redirect(to) : res.status(404).json({ error: 'Not found' });
});
app.use(express.static(pub, { index: false, maxAge: config.isProd ? '1h' : 0 }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
  if (err instanceof URIError || (err.status === 400 && /decode/i.test(err.message))) {   /* a broken %-escape in a route id */
    /* a garbled coach link opens the coach page, which says the link doesn't work (its API answers 404 for the token) */
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/coach\/[^/]+\/?$/.test(req.path)) { res.set('X-Robots-Tag', 'noindex, nofollow'); return page('coach.html')(req, res, next); }
    return res.status(400).json({ error: 'Bad address' });
  }
  console.error(`${req.method} ${audit.redact(req.originalUrl)}:`, err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(config.port, config.host, () => {
  console.log(`Logbook Monster listening on ${config.baseUrl} (bound to ${config.host}:${config.port})`);
  if (!config.google.enabled) console.log('Google sign-in is off - set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to turn it on.');
});

'use strict';
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const db = require('./db');
const { hashPassword, verifyPassword, dummyVerify, passwordProblem } = require('./passwords');
const users = require('./users');
const mail = require('./mail');

const q = {
  byId: db.prepare('SELECT id, email, name, password_hash, google_sub, invited_by FROM users WHERE id = ?'),
  byEmail: db.prepare('SELECT id, email, name, password_hash, google_sub, invited_by FROM users WHERE email = ?'),
  bySub: db.prepare('SELECT id, email, name, password_hash, google_sub, invited_by FROM users WHERE google_sub = ?'),
  create: db.prepare('INSERT INTO users (email, name, password_hash, google_sub) VALUES (?, ?, ?, ?)'),
  linkGoogle: db.prepare('UPDATE users SET google_sub = ?, name = COALESCE(name, ?) WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),
};

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const b64url = buf => buf.toString('base64url');
const randomToken = () => b64url(crypto.randomBytes(32));
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = randomToken();
  return req.session.csrf;
}

/* Every state-changing request must echo the session's CSRF token in a header. */
function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!safeEqual(req.get('x-csrf-token'), req.session && req.session.csrf)) {
    return res.status(403).json({ error: 'Your session expired. Reload the page and try again.' });
  }
  next();
}

/* ALLOWED_EMAILS limits who may sign in, but an account an admin invited is always let in. */
const accountAllowed = user => !!user && (!!user.invited_by || config.emailAllowed(user.email));

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const user = q.byId.get(req.session.userId);
    if (accountAllowed(user)) { req.user = user; return next(); }
  }
  res.status(401).json({ error: 'Not signed in' });
}

/* New session id on login stops session fixation. */
function logIn(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.csrf = randomToken();
      q.touchLogin.run(user.id);
      users.clearInvites(user.id);
      req.session.save(e => (e ? reject(e) : resolve()));
    });
  });
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});

const router = express.Router();
router.use(express.json({ limit: '10kb' }));

router.get('/config', (req, res) => {
  res.json({
    google: config.google.enabled,
    registration: config.allowRegistration || config.allowedEmails.length > 0,
    csrf: csrfToken(req),
    signedIn: !!req.session.userId,
  });
});

router.post('/login', limiter, csrfProtect, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = EMAIL_RE.test(email) ? q.byEmail.get(email) : null;
  const ok = user && user.password_hash ? await verifyPassword(password, user.password_hash) : await dummyVerify(password);
  if (!ok || !accountAllowed(user)) {
    return res.status(401).json({ error: 'That email and password don’t match an account.' });
  }
  await logIn(req, user);
  res.json({ ok: true });
});

router.post('/register', limiter, csrfProtect, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim().slice(0, 100) || null;
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  if (!config.mayCreateAccount(email)) return res.status(403).json({ error: 'New accounts aren’t open for this email.' });
  if (q.byEmail.get(email)) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
  const info = q.create.run(email, name, await hashPassword(password), null);
  await logIn(req, q.byId.get(info.lastInsertRowid));
  res.json({ ok: true });
});

/* ---------- accepting an invite: the link is /invite#<token> ---------- */
router.post('/invite/check', limiter, csrfProtect, (req, res) => {
  const inv = users.findInvite(String(req.body.token || ''));
  if (!inv) return res.status(404).json({ error: 'This invite link has expired or was already used. Ask for a new one.' });
  res.json({ email: inv.email, name: inv.name, google: config.google.enabled });
});

router.post('/invite/accept', limiter, csrfProtect, async (req, res) => {
  const inv = users.findInvite(String(req.body.token || ''));
  if (!inv) return res.status(404).json({ error: 'This invite link has expired or was already used. Ask for a new one.' });
  const password = String(req.body.password || '');
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  const name = String(req.body.name || '').trim().slice(0, 100);
  q.setPassword.run(await hashPassword(password), inv.user_id);
  if (name) q.setName.run(name, inv.user_id);
  await logIn(req, q.byId.get(inv.user_id));
  if (inv.created_by) {
    mail.notify({ to: inv.created_by, subject: `${inv.email} joined Meal Swap`,
      text: `${name || inv.email} accepted your invite and has signed in to Meal Swap.\n\n${config.baseUrl}/#admin\n` });
  }
  res.json({ ok: true });
});

router.post('/logout', csrfProtect, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('mealswap.sid', { path: '/' });
    res.json({ ok: true });
  });
});

router.post('/password', csrfProtect, requireAuth, limiter, async (req, res) => {
  const { current, next } = req.body || {};
  if (req.user.password_hash && !(await verifyPassword(String(current || ''), req.user.password_hash))) {
    return res.status(400).json({ error: 'Current password is wrong.' });
  }
  const problem = passwordProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  q.setPassword.run(await hashPassword(next), req.user.id);
  res.json({ ok: true });
});

/* ---------- Google sign-in (OpenID Connect authorization-code flow with PKCE) ---------- */
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const redirectUri = `${config.baseUrl}/auth/google/callback`;
const fail = (res, code) => res.redirect(`/login?error=${encodeURIComponent(code)}`);

router.get('/google', limiter, (req, res) => {
  if (!config.google.enabled) return fail(res, 'google_off');
  const verifier = randomToken();
  req.session.oauth = { state: randomToken(), nonce: randomToken(), verifier, at: Date.now() };
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: req.session.oauth.state,
    nonce: req.session.oauth.nonce,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  req.session.save(() => res.redirect(`${GOOGLE_AUTH}?${params}`));
});

router.get('/google/callback', limiter, async (req, res) => {
  const pending = req.session.oauth;
  delete req.session.oauth;
  if (!config.google.enabled || !pending) return fail(res, 'google_state');
  if (req.query.error) return fail(res, 'google_cancelled');
  if (!safeEqual(req.query.state, pending.state) || Date.now() - pending.at > 10 * 60 * 1000) return fail(res, 'google_state');

  let claims;
  try {
    const r = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code || ''),
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: pending.verifier,
      }),
    });
    const tok = await r.json();
    if (!r.ok || !tok.id_token) throw new Error(tok.error_description || tok.error || 'no id_token');
    /* The ID token came straight from Google's token endpoint over TLS, which OIDC Core 3.1.3.7 accepts
       in place of a signature check. Its claims are still checked below. */
    claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
  } catch (e) {
    console.error('Google token exchange failed:', e.message);
    return fail(res, 'google_failed');
  }

  const now = Math.floor(Date.now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || claims.aud !== config.google.clientId
      || !(claims.exp > now) || !safeEqual(claims.nonce, pending.nonce) || !claims.sub) {
    return fail(res, 'google_failed');
  }
  const email = String(claims.email || '').toLowerCase();
  if (!email || claims.email_verified !== true) return fail(res, 'google_unverified');

  let user = q.bySub.get(claims.sub);
  const existing = user ? null : q.byEmail.get(email);
  if (!config.emailAllowed(email) && !accountAllowed(user || existing)) return fail(res, 'not_allowed');
  if (!user) {
    if (existing) {
      if (existing.google_sub && existing.google_sub !== claims.sub) return fail(res, 'google_failed');
      q.linkGoogle.run(claims.sub, claims.name || null, existing.id);
      user = q.byId.get(existing.id);
    } else {
      if (!config.mayCreateAccount(email)) return fail(res, 'not_allowed');
      const info = q.create.run(email, claims.name || null, null, claims.sub);
      user = q.byId.get(info.lastInsertRowid);
    }
  }
  try { await logIn(req, user); } catch { return fail(res, 'google_failed'); }
  res.redirect('/');
});

module.exports = { router, requireAuth, csrfProtect, csrfToken, q, accountAllowed };

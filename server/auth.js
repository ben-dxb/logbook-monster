'use strict';
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const db = require('./db');
const { hashPassword, verifyPassword, dummyVerify, passwordProblem } = require('./passwords');
const users = require('./users');
const mail = require('./mail');
const audit = require('./audit');
const twostep = require('./twostep');
const fails = require('./failures');
const { fetchJson } = require('./fetchjson');

const q = {
  byId: db.prepare('SELECT id, email, name, password_hash, google_sub, invited_by FROM users WHERE id = ?'),
  byEmail: db.prepare('SELECT id, email, name, password_hash, google_sub, invited_by FROM users WHERE email = ?'),
  bySub: db.prepare('SELECT id, email, name, password_hash, google_sub, invited_by FROM users WHERE google_sub = ?'),
  create: db.prepare('INSERT INTO users (email, name, password_hash, google_sub) VALUES (?, ?, ?, ?)'),
  linkGoogle: db.prepare('UPDATE users SET google_sub = ?, name = COALESCE(name, ?) WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),
  endShares: db.prepare('DELETE FROM shares WHERE user_id = ? AND expires_at > ?'),
};

const { EMAIL_RE } = mail;
const b64url = buf => buf.toString('base64url');
const randomToken = () => b64url(crypto.randomBytes(32));
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/* Signed out, the CSRF token is an HMAC of a random cookie (signed double-submit), so visiting the
   sign-in page stores nothing on the server. Signed in, it lives in the session. */
const PRE = 'logbookmonster.pre';
const preCookie = req => { const m = /(?:^|;\s*)logbookmonster\.pre=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; };
/* signed with the first session secret; one signed with any secret in SESSION_SECRETS is still taken (docs/rotation.md) */
const preTokenWith = (key, v) => (v ? b64url(crypto.createHmac('sha256', key).update('csrf:' + v).digest()) : '');
const preToken = v => preTokenWith(config.sessionSecrets[0], v);
function csrfToken(req, res) {
  if (req.session.userId || req.session.csrf) {
    if (!req.session.csrf) req.session.csrf = randomToken();
    return req.session.csrf;
  }
  let v = preCookie(req);
  if (!v) {
    v = randomToken();
    res.cookie(PRE, v, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
  }
  return preToken(v);
}

/* Every state-changing request must echo the CSRF token in a header. */
function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const got = req.get('x-csrf-token'), pre = preCookie(req);
  const ok = req.session && req.session.csrf ? safeEqual(got, req.session.csrf) : config.sessionSecrets.some(k => safeEqual(got, preTokenWith(k, pre)));
  if (!ok) {
    return res.status(403).json({ error: 'Your session expired. Reload the page and try again.' });
  }
  next();
}

/* ALLOWED_EMAILS limits who may sign in, but an account an admin invited is always let in. */
const accountAllowed = user => !!user && (!!user.invited_by || config.emailAllowed(user.email));

/* A session for an account that may no longer sign in (removed, or left out of ALLOWED_EMAILS) is ended, not kept: otherwise the
   pages see it as signed in and the API doesn't, and the browser goes round between / and /login. */
const GONE = 'This account can’t sign in here any more.';
const refused = req => !!(req.session && req.session.userId) && !accountAllowed(q.byId.get(req.session.userId));
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const user = q.byId.get(req.session.userId);
    if (accountAllowed(user)) { req.user = user; return next(); }
    return req.session.destroy(() => res.status(401).json({ error: GONE, gone: true }));
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
      req.session.at = Date.now();
      q.touchLogin.run(user.id);
      users.clearInvites(user.id);
      req.session.save(e => (e ? reject(e) : resolve()));
    });
  });
}

/* Half signed in: the password (or Google) was right and the account has a second step on. The session holds only who is
   asking and since when – no userId, so no /api route and no page treats it as signed in – until POST /auth/second. */
const HALF = 5 * 60 * 1000;
function halfIn(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) return reject(err);
      req.session.half = { uid: user.id, at: Date.now() };
      req.session.csrf = randomToken();
      req.session.save(e => (e ? reject(e) : resolve()));
    });
  });
}
const halfOf = req => { const h = req.session && req.session.half; return h && Date.now() - h.at < HALF ? h : null; };

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.authRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});

/* A new session id for the same sign-in (after a password change). */
function renew(req) {
  const { userId, csrf, at } = req.session;
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) return reject(err);
      Object.assign(req.session, { userId, csrf, at });
      req.session.save(e => (e ? reject(e) : resolve()));
    });
  });
}

/* A body-less or non-JSON POST is a bad request, not a crash. */
const needBody = (req, res, next) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body)
  ? next() : res.status(400).json({ error: 'Send the form as JSON.' }));

/* Invite links get their own budget so opening one doesn't use up sign-in attempts (and the reverse). */
const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.authRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});

const router = express.Router();
router.use(express.json({ limit: '10kb' }));

/* Carries the CSRF token: never echo request text into this answer (with proxy compression that would open it to BREACH). */
router.get('/config', (req, res) => {
  res.json({
    google: config.google.enabled,
    registration: config.allowRegistration || config.allowedEmails.length > 0,
    csrf: csrfToken(req, res),
    signedIn: !!req.session.userId && !refused(req),
    second: !req.session.userId && !!halfOf(req),
  });
});

const LOCKED = 'Too many tries from here – wait 15 minutes and try again.';
router.post('/login', limiter, csrfProtect, needBody, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const valid = EMAIL_RE.test(email);
  /* On top of the per-IP limit: ACCOUNT_FAIL_LIMIT wrong passwords for one email from one address every 15 minutes lock that
     address out for that email (even the right password is refused, with LOCKED); from many addresses they only slow the answers (failures.js). */
  if (valid) await fails.wait(email);
  const locked = valid && fails.locked(email, req.ip);
  const user = valid ? q.byEmail.get(email) : null;
  const ok = user && user.password_hash ? await verifyPassword(password, user.password_hash) : await dummyVerify(password);
  if (!ok || locked || !accountAllowed(user)) {
    if (!ok && valid && !locked) fails.note(email, req.ip);
    audit.log(req, locked ? 'signin.locked' : 'signin.failed', { email }, user ? user.id : null);
    /* the lock is per address and counts tries for any email, known or not, so saying so tells nothing about the account */
    if (locked) return res.status(429).json({ error: LOCKED });
    return res.status(401).json({ error: 'That email and password don’t match an account.' });
  }
  fails.clear(email, req.ip);
  if (twostep.isOn(user.id)) {
    await halfIn(req, user);
    audit.log(req, 'second.asked', { via: 'password' }, user.id);
    return res.json({ ok: true, second: true, csrf: req.session.csrf });
  }
  await logIn(req, user);
  audit.log(req, 'signin.ok', { via: 'password' });
  res.json({ ok: true });
});

/* The second step: a code from the authenticator app, or a recovery code. */
router.post('/second', limiter, csrfProtect, needBody, async (req, res) => {
  const h = halfOf(req);
  const user = h ? q.byId.get(h.uid) : null;
  if (!user || !accountAllowed(user)) return res.status(401).json({ error: 'That sign-in took too long. Start again.', restart: true });
  const r = await twostep.attempt(user.id, req.body.code, { ip: req.ip });
  if (!r.ok) audit.log(req, r.locked ? 'second.locked' : 'second.failed', {}, user.id);
  if (r.locked) return res.status(429).json({ error: twostep.LOCKED });
  if (!r.ok) return res.status(401).json({ error: 'That code didn’t work. Use the newest code from your app, or a recovery code.' });
  await logIn(req, user);
  audit.log(req, r.kind === 'recovery' ? 'recovery.used' : 'signin.ok', { via: 'second' });
  res.json({ ok: true, recovery: r.kind === 'recovery' });
});

router.post('/register', limiter, csrfProtect, needBody, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim().slice(0, 100) || null;
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  if (!config.mayCreateAccount(email)) return res.status(403).json({ error: 'New accounts aren’t open for this email.' });
  const exists = () => {
    const u = q.byEmail.get(email);
    /* invited but not joined yet: the invite email has the link that sets the password */
    if (u && users.isPending(u.id)) return res.status(409).json({ error: 'This email has been invited – check your email for the invite and use its link to set your password.' });
    return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
  };
  if (q.byEmail.get(email)) return exists();
  const hash = await hashPassword(password);
  let info;
  /* two sign-ups for one email at once: the second finds it taken (users.email is unique) */
  try { info = q.create.run(email, name, hash, null); } catch (e) { if (/UNIQUE/i.test(e.message)) return exists(); throw e; }
  await logIn(req, q.byId.get(info.lastInsertRowid));
  audit.log(req, 'signin.ok', { via: 'register' });
  res.json({ ok: true });
});

/* ---------- accepting an invite: the link is /invite#<token> ---------- */
/* An invite only works while its account is still waiting: no password, no Google link, never signed in. */
function liveInvite(token) {
  const inv = users.findInvite(String(token || ''));
  if (inv && !users.isPending(inv.user_id)) { users.clearInvites(inv.user_id); return null; }
  return inv;
}

router.post('/invite/check', inviteLimiter, csrfProtect, needBody, (req, res) => {
  const inv = liveInvite(req.body.token);
  if (!inv) return res.status(404).json({ error: 'This invite link has expired or was already used. Ask for a new one.' });
  res.json({ email: inv.email, name: inv.name, google: config.google.enabled });
});

/* The invitee types their own name, so in the admin's email it is one short line with no links or markup (auth-code-014). */
const mailName = n => String(n || '').replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*|\S+\.[a-z]{2,}\S*/gi, '').replace(/[^\p{L}\p{M}\p{N} '.-]/gu, '')
  .replace(/\s+/g, ' ').trim().slice(0, 40).trim();

router.post('/invite/accept', inviteLimiter, csrfProtect, needBody, async (req, res) => {
  const inv = liveInvite(req.body.token);
  if (!inv) return res.status(404).json({ error: 'This invite link has expired or was already used. Ask for a new one.' });
  const password = String(req.body.password || '');
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  const name = String(req.body.name || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!users.claimInvite(String(req.body.token || ''), inv.user_id)) {
    return res.status(404).json({ error: 'This invite link has expired or was already used. Ask for a new one.' });
  }
  q.setPassword.run(await hashPassword(password), inv.user_id);
  if (name) q.setName.run(name, inv.user_id);
  await logIn(req, q.byId.get(inv.user_id));
  audit.log(req, 'invite.accepted');
  if (inv.created_by) {
    mail.notify({ to: inv.created_by, subject: `${inv.email} joined Logbook Monster`,
      text: `${mailName(name) ? `${mailName(name)} (${inv.email})` : inv.email} accepted your invite and has signed in to Logbook Monster.\n\n${config.baseUrl}/#admin\n` });
  }
  res.json({ ok: true });
});

router.post('/logout', csrfProtect, (req, res) => {
  if (req.session.userId) audit.log(req, 'signout');
  req.session.destroy(() => {
    /* Drops cached photos and pages; the app puts back its unsaved-changes stash itself (app.js). */
    res.set('Clear-Site-Data', '"cache", "storage"');
    res.clearCookie(config.sessionCookie, { path: '/', secure: config.cookieSecure });
    res.json({ ok: true });
  });
});

/* Changing the password signs the account out everywhere else and, unless endLinks is false, switches off
   its live coach links. A Google-only account adding a first password must have signed in in the last 10 minutes. */
const FRESH = 10 * 60 * 1000;
router.post('/password', csrfProtect, requireAuth, limiter, async (req, res) => {
  const { current, next, endLinks } = req.body || {};
  if (req.user.password_hash) {
    if (!(await verifyPassword(String(current || ''), req.user.password_hash))) {
      return res.status(400).json({ error: 'Current password is wrong.' });
    }
  } else if (!(Date.now() - (req.session.at || 0) < FRESH)) {
    return res.status(403).json({ error: 'To add a password, sign out, sign in with Google again and add it within 10 minutes.' });
  }
  const problem = passwordProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  q.setPassword.run(await hashPassword(next), req.user.id);
  const signedOut = users.endSessions(req.user.id, req.sessionID);
  const linksOff = endLinks === false ? 0 : q.endShares.run(req.user.id, new Date().toISOString()).changes;
  await renew(req);
  audit.log(req, 'password.changed', { signedOut, linksOff });
  res.json({ ok: true, signedOut, linksOff });
});

/* ---------- Google sign-in (OpenID Connect authorization-code flow with PKCE) ---------- */
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const redirectUri = `${config.baseUrl}/auth/google/callback`;
const fail = (res, code) => res.redirect(`/login?error=${encodeURIComponent(code)}`);

/* Google's routes are pages the browser opens, so too many tries go back to the sign-in page with a message, not raw JSON. */
const googleLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.authRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => fail(res, 'rate'),
});

router.get('/google', googleLimiter, (req, res) => {
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

router.get('/google/callback', googleLimiter, async (req, res) => {
  const pending = req.session.oauth;
  delete req.session.oauth;
  if (!config.google.enabled) return fail(res, 'google_off');
  if (!pending) return fail(res, 'google_state');
  if (req.query.error) return fail(res, 'google_cancelled');
  if (!safeEqual(req.query.state, pending.state) || Date.now() - pending.at > 10 * 60 * 1000) return fail(res, 'google_state');

  let claims;
  try {
    /* 10 s and 64 KB at most: a stalled Google can't hold sign-ins open (auth-code-010) */
    const { ok, body: tok } = await fetchJson(GOOGLE_TOKEN, {
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
    }, { timeout: 10000, max: 64 * 1024 });
    if (!ok || !tok.id_token) throw new Error(tok.error_description || tok.error || 'no id_token');
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
      audit.log(req, 'google.linked', {}, existing.id);
      user = q.byId.get(existing.id);
    } else {
      if (!config.mayCreateAccount(email)) return fail(res, 'not_allowed');
      const info = q.create.run(email, claims.name || null, null, claims.sub);
      user = q.byId.get(info.lastInsertRowid);
    }
  }
  try {
    if (twostep.isOn(user.id)) { await halfIn(req, user); return res.redirect('/login?second=1'); }
    await logIn(req, user);
  } catch { return fail(res, 'google_failed'); }
  audit.log(req, 'signin.ok', { via: 'google' });
  res.redirect('/#dash');
});

module.exports = { router, requireAuth, csrfProtect, csrfToken, q, accountAllowed, refused };

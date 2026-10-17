'use strict';
/* Coach links: an account makes a link that shows its data read only – no password, no sign-in – until a
   time it picks (an hour to a year), or until it switches the link off. The link carries a random secret;
   only its SHA-256 is stored, so the link is shown once, when it's made.
   The coach's page (/coach/<secret>, public/coach.js) only reads, through GET routes under
   /coach/<secret>/api: the account's name, its defaults (food names and its week), day summaries, weights,
   the Timeline (trends and day cards) and the progress photos those show. */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { isDate } = require('./dates');
const config = require('./config');
const auth = require('./auth');
const defaults = require('./defaults');
const timeline = require('./timeline');
const photos = require('./photos');
const audit = require('./audit');

const q = {
  /* the account behind a link, without its password hash or Google id: nothing under the coach mount can hand those out (coach-code-005) */
  owner: db.prepare('SELECT id, email, name, invited_by FROM users WHERE id = ?'),
  list: db.prepare('SELECT id, token_hash, label, expires_at, created_at, used_at FROM shares WHERE user_id = ? ORDER BY expires_at DESC, id DESC'),
  get: db.prepare('SELECT id, token_hash, label, expires_at, created_at, used_at FROM shares WHERE user_id = ? AND id = ?'),
  live: db.prepare('SELECT COUNT(*) AS n FROM shares WHERE user_id = ? AND expires_at > ?'),
  add: db.prepare('INSERT INTO shares (user_id, token_hash, label, expires_at) VALUES (?, ?, ?, ?)'),
  byHash: db.prepare('SELECT id, user_id, label, expires_at FROM shares WHERE token_hash = ?'),
  used: db.prepare("UPDATE shares SET used_at = datetime('now') WHERE id = ?"),
  del: db.prepare('DELETE FROM shares WHERE user_id = ? AND id = ?'),
  delKey: db.prepare('DELETE FROM shares WHERE user_id = ? AND id = ? AND substr(token_hash, 1, 12) = ?'),
  purge: db.prepare('DELETE FROM shares WHERE user_id = ? AND expires_at < ?'),
  sums: db.prepare('SELECT date, summary FROM days WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date'),
  weights: db.prepare('SELECT date, kg FROM weights WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date'),
};

const MAX_LIVE = 20, MAX_DAYS = 366, KEEP_EXPIRED_DAYS = 30;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
const nowIso = () => new Date().toISOString();
const sqlIso = s => (s ? s.replace(' ', 'T') + 'Z' : null);
const idOf = v => (/^\d{1,12}$/.test(String(v)) ? +v : 0);
const send = (res, e) => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); };

/* key: a piece of the secret's hash, which a reused id doesn't share – switching off sends it, so a stale tab can't
   switch off a newer link that took the same id */
function view(r) {
  return { id: r.id, key: r.token_hash.slice(0, 12), label: r.label, expires: r.expires_at, created: sqlIso(r.created_at), used: sqlIso(r.used_at), live: r.expires_at > nowIso() };
}

/* ---------- the account's own links (under /api, signed in) ---------- */
function list(user) {
  q.purge.run(user.id, new Date(Date.now() - KEEP_EXPIRED_DAYS * 86400000).toISOString());
  return q.list.all(user.id).map(view);
}

/* { label, expires: an ISO time } – the link (with its secret) is in the reply, and only in this one. */
function create(user, b) {
  const o = b && typeof b === 'object' ? b : {};
  const label = String(o.label == null ? '' : o.label).replace(/\s+/g, ' ').trim();
  if (label.length > 60) throw fail('Name the link in 60 characters or fewer');
  const t = Date.parse(typeof o.expires === 'string' ? o.expires : '');
  if (!Number.isFinite(t)) throw fail('Pick how long the link stays live');
  if (t <= Date.now() + 60000) throw fail('Pick a time in the future for the link to run out');
  if (t > Date.now() + MAX_DAYS * 86400000) throw fail('A link can stay live for a year at most');
  if (q.live.get(user.id, nowIso()).n >= MAX_LIVE) throw fail(`You have ${MAX_LIVE} live links – switch one off first`);
  const token = crypto.randomBytes(32).toString('base64url');
  const info = q.add.run(user.id, hash(token), label, new Date(t).toISOString());
  return { ...view(q.get.get(user.id, info.lastInsertRowid)), url: `${config.baseUrl}/coach/${token}` };
}

const mine = express.Router();
mine.get('/', (req, res) => res.json({ shares: list(req.user) }));
mine.post('/', (req, res) => {
  try { const r = create(req.user, req.body); audit.log(req, 'coach.created', { id: r.id, expires: r.expires }); res.json(r); } catch (e) { send(res, e); }
});
/* Switching a link off deletes it: the next request with it finds nothing. */
mine.delete('/:id', (req, res) => {
  const id = idOf(req.params.id), key = req.query.key;
  if (key === undefined) { if (q.del.run(req.user.id, id).changes) audit.log(req, 'coach.off', { id }); return res.json({ ok: true }); }
  if (!q.delKey.run(req.user.id, id, String(key)).changes) return res.status(404).json({ error: 'That link was switched off already – reload to see your links.' });
  audit.log(req, 'coach.off', { id });
  res.json({ ok: true });
});

/* ---------- the coach's side (under /coach/<secret>/api, no sign-in, read only) ---------- */
/* The secret is 256 random bits, so guessing is hopeless; this only slows anyone trying, and never a working link. */
const badLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: Math.max(30, config.authRateLimit), standardHeaders: 'draft-7', legacyHeaders: false,
  skipSuccessfulRequests: true, requestWasSuccessful: (req, res) => res.statusCode !== 404 || !!req.share,
  message: { error: 'Too many tries. Wait a few minutes and try again.' },
});

function resolve(req, res, next) {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  const token = String(req.params.token || '');
  const row = TOKEN_RE.test(token) ? q.byHash.get(hash(token)) : null;
  const user = row && row.expires_at > nowIso() ? q.owner.get(row.user_id) : null;
  if (!user || !auth.accountAllowed(user)) return res.status(404).json({ error: 'This link has run out or been switched off. Ask for a new one.', gone: true });
  req.user = user; req.share = row;
  audit.once(req, 'coach.used', { id: row.id }, row.user_id);
  next();
}
/* Only reads get through, whatever the routes mounted below would otherwise take. */
const readOnly = (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : res.status(405).json({ error: 'This link is read only' }));
const range = o => [isDate(o.from) ? o.from : '0000-01-01', isDate(o.to) ? o.to : '9999-12-31'];

const coach = express.Router({ mergeParams: true });
/* a working link is limited too, so a leaked one can't keep the server busy */
const linkLimit = rateLimit({
  windowMs: 10 * 60 * 1000, limit: config.coachRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => 's' + req.share.id, message: { error: 'Too many requests on this link. Wait a few minutes and try again.' },
});
coach.use(badLimit, resolve, linkLimit, readOnly);
coach.get('/info', (req, res) => {
  q.used.run(req.share.id);
  res.json({ name: req.user.name || req.user.email.split('@')[0], label: req.share.label, expires: req.share.expires_at });
});
coach.get('/defaults', (req, res) => res.json(defaults.forUser(req.user)));
coach.get('/days', (req, res) => res.json(q.sums.all(req.user.id, ...range(req.query)).map(r => ({ date: r.date, ...JSON.parse(r.summary) }))));
coach.get('/weights', (req, res) => res.json(q.weights.all(req.user.id, ...range(req.query))));
coach.use('/timeline', timeline.router);
coach.use('/photos', photos.router);
coach.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = { mine, coach };

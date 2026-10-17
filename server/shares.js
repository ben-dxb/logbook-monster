'use strict';
/* Coach links: an account makes a link that shows its data read only – no password, no sign-in – until a
   time it picks (an hour to a year, DEFAULT_DAYS unless it says), or until it switches the link off. The secret is held by a
   third party (the coach), so it isn't rotated on a schedule; instead the account is emailed REMIND_DAYS before a link runs
   out, and Renew makes a new link (new secret, same name) and switches the old one off – the person sends the new one
   themselves. A live link nobody opened for IDLE_DAYS is flagged on Account admin. The link carries a random secret;
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
  ending: db.prepare(`SELECT s.id, s.user_id, s.label, s.expires_at, u.email FROM shares s JOIN users u ON u.id = s.user_id
    WHERE s.reminded_at IS NULL AND s.expires_at > ? AND s.expires_at <= ? AND datetime(s.created_at) < datetime(s.expires_at, ?)`),
  reminded: db.prepare("UPDATE shares SET reminded_at = datetime('now') WHERE id = ? AND reminded_at IS NULL"),
  sums: db.prepare('SELECT date, summary FROM days WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date'),
  weights: db.prepare('SELECT date, kg FROM weights WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date'),
};

const MAX_LIVE = 20, MAX_DAYS = 366, KEEP_EXPIRED_DAYS = 30, DEFAULT_DAYS = 90, REMIND_DAYS = 7, IDLE_DAYS = 30;
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
  const live = r.expires_at > nowIso(), last = Date.parse(sqlIso(r.used_at || r.created_at));
  return { id: r.id, key: r.token_hash.slice(0, 12), label: r.label, expires: r.expires_at, created: sqlIso(r.created_at), used: sqlIso(r.used_at), live,
    idle: live && Date.now() - last >= IDLE_DAYS * 86400000 };
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
  const t = o.expires == null || o.expires === '' ? Date.now() + DEFAULT_DAYS * 86400000 : Date.parse(typeof o.expires === 'string' ? o.expires : '');
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
  try { const r = create(req.user, req.body); audit.log(req, 'coach.created', { id: r.id, name: r.label || undefined, expires: r.expires }); res.json(r); } catch (e) { send(res, e); }
});
/* Renew: a new link (new secret, same name, DEFAULT_DAYS unless expires says) in place of a live one, which is switched off in
   the same transaction. The new link is in the reply only, like a new one. key: as for switching off. */
mine.post('/:id/renew', (req, res) => {
  const id = idOf(req.params.id), o = req.body && typeof req.body === 'object' ? req.body : {};
  const old = q.get.get(req.user.id, id);
  if (!old || (o.key !== undefined && old.token_hash.slice(0, 12) !== String(o.key))) return res.status(404).json({ error: 'That link was switched off already – reload to see your links.' });
  if (old.expires_at <= nowIso()) return res.status(409).json({ error: 'That link has run out – make a new one instead.' });
  db.exec('BEGIN IMMEDIATE');
  let r;
  try {
    q.del.run(req.user.id, id);
    r = create(req.user, { label: old.label, expires: o.expires });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return send(res, e); }
  audit.log(req, 'coach.renewed', { id: r.id, was: id, name: old.label || undefined, expires: r.expires });
  res.json(r);
});
/* Switching a link off deletes it: the next request with it finds nothing. */
mine.delete('/:id', (req, res) => {
  const id = idOf(req.params.id), key = req.query.key;
  /* the log keeps the link's name: the row itself is gone */
  const was = q.get.get(req.user.id, id), name = (was && was.label) || undefined;
  if (key === undefined) { if (q.del.run(req.user.id, id).changes) audit.log(req, 'coach.off', { id, name }); return res.json({ ok: true }); }
  if (!q.delKey.run(req.user.id, id, String(key)).changes) return res.status(404).json({ error: 'That link was switched off already – reload to see your links.' });
  audit.log(req, 'coach.off', { id, name });
  res.json({ ok: true });
});

/* ---------- the coach's side (under /coach/<secret>/api, no sign-in, read only) ---------- */
/* the live link a request names, or null (looked up once per request) */
function lookup(req) {
  if (req.shareFound !== undefined) return req.shareFound;
  const token = String(req.params.token || '');
  const row = TOKEN_RE.test(token) ? q.byHash.get(hash(token)) : null;
  const user = row && row.expires_at > nowIso() ? q.owner.get(row.user_id) : null;
  return (req.shareFound = user && auth.accountAllowed(user) ? { row, user } : null);
}
/* The secret is 256 random bits, so guessing is hopeless; this only slows anyone trying. Only links that don't work count,
   and a working link is never held back by them – a coach behind the same address as someone mistyping still gets in. */
const badLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: Math.max(30, config.authRateLimit), standardHeaders: 'draft-7', legacyHeaders: false,
  skip: req => !!lookup(req),
  message: { error: 'Too many tries. Wait a few minutes and try again.' },
});

function resolve(req, res, next) {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  const found = lookup(req);
  if (!found) return res.status(404).json({ error: 'This link has run out or been switched off. Ask for a new one.', gone: true });
  const { row, user } = found;
  req.user = user; req.share = row;
  audit.once(req, 'coach.used', { id: row.id, name: row.label || undefined }, row.user_id);
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
  /* the account's own name, or '' (the page says "Logbook") – never a piece of its email */
  res.json({ name: req.user.name || '', label: req.share.label, expires: req.share.expires_at });
});
coach.get('/defaults', (req, res) => res.json(defaults.forUser(req.user)));
coach.get('/days', (req, res) => res.json(q.sums.all(req.user.id, ...range(req.query)).map(r => ({ date: r.date, ...JSON.parse(r.summary) }))));
coach.get('/weights', (req, res) => res.json(q.weights.all(req.user.id, ...range(req.query))));
coach.use('/timeline', timeline.router);
coach.use('/photos', photos.router);
coach.use((req, res) => res.status(404).json({ error: 'Not found' }));

/* Daily (and on start): an email to the account for each link that runs out within REMIND_DAYS – once per link, and only for
   links made to last longer than that (mail.notify does nothing while email isn't set up). */
function remind() {
  const mail = require('./mail');
  if (!mail.configured()) return 0;
  const rows = q.ending.all(nowIso(), new Date(Date.now() + REMIND_DAYS * 86400000).toISOString(), `-${REMIND_DAYS} days`);
  for (const r of rows) {
    if (!q.reminded.run(r.id).changes) continue;
    const when = new Date(r.expires_at).toUTCString().replace(/:\d\d GMT$/, ' UTC');
    mail.notify({ to: r.email, subject: `Logbook Monster: your coach link ${r.label ? `“${r.label}” ` : ''}runs out soon`,
      text: `Your coach link ${r.label ? `“${r.label}” ` : ''}stops working on ${when}.\n\n`
        + `To keep sharing, open Account admin › Sharing and press Renew on it. You get a new link to send your coach yourself; `
        + `the old one stops working straight away.\n${config.baseUrl}/#account/sharing\n\nIf you no longer want to share, do nothing – it runs out by itself.\n` });
    audit.log(null, 'coach.reminded', { id: r.id, name: r.label || undefined }, r.user_id);
  }
  return rows.length;
}
function schedule() {
  try { remind(); } catch (e) { console.error('Coach link reminders failed:', e.message); }
  setInterval(() => { try { remind(); } catch (e) { console.error('Coach link reminders failed:', e.message); } }, 24 * 60 * 60 * 1000).unref();
}

module.exports = { mine, coach, remind, schedule, DEFAULT_DAYS };

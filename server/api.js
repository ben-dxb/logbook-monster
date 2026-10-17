'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { requireAuth, csrfProtect, csrfToken } = require('./auth');
const defaults = require('./defaults');
const ai = require('./ai');
const config = require('./config');
const mail = require('./mail');
const users = require('./users');
const gym = require('./gym');
const foods = require('./foods');
const supps = require('./supps');
const checklist = require('./checklist');
const photos = require('./photos');
const timeline = require('./timeline');
const shares = require('./shares');
const jobs = require('./jobs');

const q = {
  getSettings: db.prepare('SELECT data FROM settings WHERE user_id = ?'),
  putSettings: db.prepare(`INSERT INTO settings (user_id, data) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`),
  getDay: db.prepare('SELECT data, updated_at FROM days WHERE user_id = ? AND date = ?'),
  listDays: db.prepare('SELECT date, summary, updated_at FROM days WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date'),
  putDay: db.prepare(`INSERT INTO days (user_id, date, data, summary) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET data = excluded.data, summary = excluded.summary, updated_at = datetime('now')`),
  delDay: db.prepare('DELETE FROM days WHERE user_id = ? AND date = ?'),
  listWeights: db.prepare('SELECT date, kg FROM weights WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date'),
  putWeight: db.prepare(`INSERT INTO weights (user_id, date, kg) VALUES (?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET kg = excluded.kg, updated_at = datetime('now')`),
  delWeight: db.prepare('DELETE FROM weights WHERE user_id = ? AND date = ?'),
  allDays: db.prepare('SELECT date, data FROM days WHERE user_id = ? ORDER BY date'),
  getOptions: db.prepare("SELECT data FROM app_config WHERE key = 'options'"),
  putOptions: db.prepare(`INSERT INTO app_config (key, data, updated_by) VALUES ('options', ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = datetime('now')`),
};
/* App-wide switches the super admin sets. planFiles: the CSV / JSON plan upload and download buttons. */
const OPTIONS = { planFiles: true };
function options() {
  const r = q.getOptions.get();
  let o = {};
  try { o = r ? JSON.parse(r.data) : {}; } catch { o = {}; }
  const out = {};
  for (const k of Object.keys(OPTIONS)) out[k] = typeof o[k] === 'boolean' ? o[k] : OPTIONS[k];
  return out;
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isDate = s => typeof s === 'string' && DATE_RE.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const MAX_JSON = 256 * 1024;

function bad(res, msg) { return res.status(400).json({ error: msg }); }
function range(req) {
  const from = isDate(req.query.from) ? req.query.from : '0000-01-01';
  const to = isDate(req.query.to) ? req.query.to : '9999-12-31';
  return [from, to];
}
/* Only the numbers the calendar needs are kept in the summary. */
function cleanSummary(s) {
  const num = v => (Number.isFinite(+v) ? Math.round(+v * 10) / 10 : 0);
  const out = {};
  for (const k of ['k', 'p', 'c', 'f', 'd']) out[k] = num(s && s[k]);
  out.targets = {};
  for (const k of ['k', 'p', 'c', 'f']) out.targets[k] = num(s && s.targets && s.targets[k]);
  out.type = s && typeof s.type === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(s.type) ? s.type : null;
  out.tname = s && typeof s.tname === 'string' ? s.tname.trim().slice(0, 40) : '';
  return out;
}

const router = express.Router();
router.use(requireAuth);
router.use(express.json({ limit: '300kb' }));
router.use(csrfProtect);

router.get('/me', (req, res) => {
  res.json({ email: req.user.email, name: req.user.name, hasPassword: !!req.user.password_hash,
    google: !!req.user.google_sub, admin: defaults.isAdmin(req.user), ai: ai.status().configured, ...options(), csrf: csrfToken(req, res) });
});

/* Each account's own meal plan (foods, day templates, week, targets), as dated changes. There are no app-wide defaults. */
router.get('/defaults', (req, res) => res.json(defaults.forUser(req.user)));
/* Account admin: anyone keeps their own plan. */
router.put('/my/defaults', (req, res) => {
  try { res.json(defaults.putMine(req.body, req.user)); } catch (e) { bad(res, e.message); }
});
router.delete('/my/defaults', (req, res) => res.json(defaults.delMine(req.user)));
router.delete('/my/defaults/:from', (req, res) => {
  try { res.json(defaults.delMine(req.user, req.params.from)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

/* AI: the OpenRouter key and models (super admin), and reading a plan PDF into an account's plan format. */
const adminOnly = (req, res, next) => (defaults.isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only the super admin can do this' }));
/* ?bg=1 runs it in the background (server/jobs.js) */
const readPlan = (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null, type = String(req.get('content-type') || '').split(';')[0].trim();
  return jobs.respond(req, res, 'plan', () => ai.check(buf, type), () => ai.importPlan(buf, type, req.user));
};
router.get('/admin/ai', adminOnly, (req, res) => res.json(ai.status()));
router.put('/admin/ai', adminOnly, (req, res) => {
  if (!isObj(req.body)) return bad(res, 'Settings must be an object');
  try { res.json(ai.save(req.body, req.user)); } catch (e) { bad(res, e.message); }
});
/* The OpenRouter key is the super admin's, so each account gets a handful of reads an hour. */
const aiLimit = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => 'u' + req.user.id, skip: req => defaults.isAdmin(req.user),
  message: { error: 'That’s a lot of AI reads – wait a while and try again.' },
});
router.post('/my/ai-import', aiLimit, express.raw({ type: ai.TYPES_IN, limit: '10mb' }), readPlan);

/* Accounts: the list, inviting someone (emailed if email is set up) and removing an account. */
const fail = (res, e) => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); };
const userId = req => (/^\d{1,12}$/.test(req.params.id) ? +req.params.id : 0);
router.get('/admin/users', adminOnly, (req, res) => res.json({ users: users.list(req.user, defaults.isAdmin), email: mail.configured() }));
router.post('/admin/users', adminOnly, async (req, res) => {
  if (!isObj(req.body)) return bad(res, 'Send an email address');
  try { res.json(await users.invite(req.body, req.user)); } catch (e) { fail(res, e); }
});
router.post('/admin/users/:id/invite', adminOnly, async (req, res) => {
  try { res.json(await users.resend(userId(req), req.user)); } catch (e) { fail(res, e); }
});
router.delete('/admin/users/:id', adminOnly, (req, res) => {
  try {
    const files = photos.filesOf(userId(req));
    res.json(users.remove(userId(req), req.user, defaults.isAdmin));
    photos.removeFiles(files);
  } catch (e) { fail(res, e); }
});

router.get('/admin/options', adminOnly, (req, res) => res.json(options()));
router.put('/admin/options', adminOnly, (req, res) => {
  if (!isObj(req.body)) return bad(res, 'Options must be an object');
  const o = options();
  for (const [k, v] of Object.entries(req.body)) {
    if (!Object.hasOwn(OPTIONS, k)) return bad(res, `Unknown option "${k}"`);
    if (typeof v !== 'boolean') return bad(res, `"${k}" must be true or false`);
    o[k] = v;
  }
  q.putOptions.run(JSON.stringify(o), req.user.email);
  res.json(o);
});

/* The account the app sends email from (SMTP). */
router.get('/admin/email', adminOnly, (req, res) => res.json(mail.status()));
router.put('/admin/email', adminOnly, async (req, res) => {
  if (!isObj(req.body)) return bad(res, 'Settings must be an object');
  try { res.json(await mail.save(req.body, req.user)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
router.post('/admin/email/test', adminOnly, async (req, res) => {
  const to = String((req.body && req.body.to) || req.user.email).trim();
  try {
    await mail.send({ to, subject: 'Logbook Monster test email',
      text: `This is a test from Logbook Monster at ${config.baseUrl}.\n\nIf you can read this, invites and notifications will reach people.\n` });
    res.json({ ok: true, to });
  } catch (e) { fail(res, e); }
});

router.get('/settings', (req, res) => {
  const row = q.getSettings.get(req.user.id);
  res.json(row ? JSON.parse(row.data) : {});
});
router.put('/settings', (req, res) => {
  if (!isObj(req.body)) return bad(res, 'Settings must be an object');
  const json = JSON.stringify(req.body);
  if (json.length > MAX_JSON) return bad(res, 'Settings too large');
  q.putSettings.run(req.user.id, json);
  res.json({ ok: true });
});

router.get('/days', (req, res) => {
  const rows = q.listDays.all(req.user.id, ...range(req));
  res.json(rows.map(r => ({ date: r.date, updated: r.updated_at, ...JSON.parse(r.summary) })));
});
router.get('/days/:date', (req, res) => {
  if (!isDate(req.params.date)) return bad(res, 'Bad date');
  const row = q.getDay.get(req.user.id, req.params.date);
  if (!row) return res.status(404).json({ error: 'No entry for this day' });
  res.json({ date: req.params.date, updated: row.updated_at, data: JSON.parse(row.data) });
});
router.put('/days/:date', (req, res) => {
  if (!isDate(req.params.date)) return bad(res, 'Bad date');
  const { data, summary } = req.body || {};
  if (!isObj(data) || !Array.isArray(data.meals)) return bad(res, 'Day data is missing its meals');
  const json = JSON.stringify(data);
  if (json.length > MAX_JSON) return bad(res, 'Day data too large');
  q.putDay.run(req.user.id, req.params.date, json, JSON.stringify(cleanSummary(summary)));
  res.json({ ok: true });
});
router.delete('/days/:date', (req, res) => {
  if (!isDate(req.params.date)) return bad(res, 'Bad date');
  q.delDay.run(req.user.id, req.params.date);
  res.json({ ok: true });
});

router.get('/weights', (req, res) => {
  res.json(q.listWeights.all(req.user.id, ...range(req)));
});
router.put('/weights/:date', (req, res) => {
  if (!isDate(req.params.date)) return bad(res, 'Bad date');
  const kg = +(req.body && req.body.kg);
  if (!Number.isFinite(kg) || kg < 20 || kg > 400) return bad(res, 'Weight must be between 20 and 400 kg');
  q.putWeight.run(req.user.id, req.params.date, Math.round(kg * 100) / 100);
  res.json({ ok: true });
});
router.delete('/weights/:date', (req, res) => {
  if (!isDate(req.params.date)) return bad(res, 'Bad date');
  q.delWeight.run(req.user.id, req.params.date);
  res.json({ ok: true });
});

router.use('/gym', gym.router);
router.use('/foods', foods.router);
router.use('/supps', supps.router);
router.use('/checklist', checklist.router);
router.use('/photos', photos.router);
router.use('/timeline', timeline.router);
router.use('/shares', shares.mine);
router.use('/jobs', jobs.router);

/* Everything you've stored, as one JSON file. */
router.get('/export', (req, res) => {
  const s = q.getSettings.get(req.user.id);
  res.attachment(`logbook-monster-${new Date().toISOString().slice(0, 10)}.json`);
  res.json({
    exported: new Date().toISOString(),
    email: req.user.email,
    settings: s ? JSON.parse(s.data) : {},
    defaults: defaults.mine(req.user),
    planChanges: defaults.myVersions(req.user),
    days: q.allDays.all(req.user.id).map(r => ({ date: r.date, data: JSON.parse(r.data) })),
    weights: q.listWeights.all(req.user.id, '0000-01-01', '9999-12-31'),
    gym: gym.exportFor(req.user),
    foods: foods.exportFor(req.user),
    supplements: supps.exportFor(req.user),
    checklist: checklist.exportFor(req.user),
    photos: photos.exportFor(req.user),
  });
});

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;

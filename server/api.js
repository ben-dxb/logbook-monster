'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { requireAuth, csrfProtect, csrfToken, q: authQ } = require('./auth');
const audit = require('./audit');
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
const { isDate, writeError } = require('./dates');
const { isNum } = require('./num');
const version = require('./version');
const twostep = require('./twostep');

const q = {
  getSettings: db.prepare('SELECT data FROM settings WHERE user_id = ?'),
  putSettings: db.prepare(`INSERT INTO settings (user_id, data) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`),
  getDay: db.prepare('SELECT data, updated_at FROM days WHERE user_id = ? AND date = ?'),
  listDays: db.prepare('SELECT date, summary, updated_at FROM days WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date'),
  putDay: db.prepare(`INSERT INTO days (user_id, date, data, summary, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET data = excluded.data, summary = excluded.summary, updated_at = excluded.updated_at`),
  dayVersion: db.prepare('SELECT updated_at FROM days WHERE user_id = ? AND date = ?'),
  delDay: db.prepare('DELETE FROM days WHERE user_id = ? AND date = ?'),
  listWeights: db.prepare('SELECT date, kg FROM weights WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date'),
  putWeight: db.prepare(`INSERT INTO weights (user_id, date, kg) VALUES (?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET kg = excluded.kg, updated_at = datetime('now')`),
  delWeight: db.prepare('DELETE FROM weights WHERE user_id = ? AND date = ?'),
  daysSize: db.prepare('SELECT COALESCE(SUM(length(data)), 0) AS n FROM days WHERE user_id = ?'),   /* covered by days_size */
  daySize: db.prepare('SELECT length(data) AS n FROM days WHERE user_id = ? AND date = ?'),
  daysAfter: db.prepare('SELECT date, data FROM days WHERE user_id = ? AND date > ? ORDER BY date LIMIT ?'),
  getOptions: db.prepare("SELECT data FROM app_config WHERE key = 'options'"),
  putOptions: db.prepare(`INSERT INTO app_config (key, data, updated_by) VALUES ('options', ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = datetime('now')`),
};
/* App-wide switches the super admin sets. planFiles: the CSV / JSON plan upload and download buttons. aiPrivate: ask
   OpenRouter for providers that don't store or train on what they're sent. aiDailyUser / aiDailyAll: AI calls a day per
   account / for the whole app (0 = no limit; server/ai.js). adminTotp: super admins must have the second sign-in step on
   before any /api/admin route answers them (off by default so turning it on can't lock the owner out). */
const OPTIONS = { planFiles: true, aiPrivate: true, aiDailyUser: 100, aiDailyAll: 1000, adminTotp: false };
const MAX_CAP = 1000000;
const optionOk = (k, v) => (typeof OPTIONS[k] === 'number' ? Number.isInteger(v) && v >= 0 && v <= MAX_CAP : typeof v === 'boolean');
function options() {
  const r = q.getOptions.get();
  let o = {};
  try { o = r ? JSON.parse(r.data) : {}; } catch { o = {}; }
  const out = {};
  for (const k of Object.keys(OPTIONS)) out[k] = optionOk(k, o[k]) ? o[k] : OPTIONS[k];
  return out;
}

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

/* Settings and a day's targets hold numbers: a typo the browser couldn't read is refused, not stored as 0. Only the keys the
   app uses are kept (the rice pudding batch, snack values, the protein basis); anything else in the body is dropped. */
const PUD_KEYS = ['rice', 'almond', 'oat', 'custard', 'casein', 'weight'];
const SNACK_ID = /^[a-z][a-z0-9_]{0,31}$/;
function cleanSettings(b) {
  const out = {};
  if (b.pud != null) {
    if (!isObj(b.pud)) throw new Error('The rice pudding batch must be an object');
    out.pud = {};
    for (const [k, v] of Object.entries(b.pud)) {
      if (!PUD_KEYS.includes(k)) throw new Error(`Unknown rice pudding value "${k.slice(0, 40)}"`);
      if (!isNum(v) || +v < 0) throw new Error(`Rice pudding ${k} must be a number of 0 or more`);
      if (k === 'weight' && +v < 1) throw new Error('The finished weight of the rice pudding must be 1 g or more');
      out.pud[k] = +v;
    }
  }
  if (b.snackOv != null) {
    if (!isObj(b.snackOv)) throw new Error('Snack values must be an object');
    out.snackOv = {};
    for (const [id, o] of Object.entries(b.snackOv)) {
      if (!SNACK_ID.test(id) || id in Object.prototype) throw new Error(`Unknown snack "${id.slice(0, 40)}"`);
      if (!isObj(o)) throw new Error(`Snack values for ${id} must be an object`);
      out.snackOv[id] = {};
      for (const [k, v] of Object.entries(o)) {
        if (!['k', 'p', 'c', 'f'].includes(k)) throw new Error(`Unknown snack value "${k.slice(0, 40)}" for ${id}`);
        if (!isNum(v) || +v < 0) throw new Error(`Snack value ${k} for ${id} must be a number of 0 or more`);
        out.snackOv[id][k] = +v;
      }
    }
  }
  if (b.pBasis != null) {
    if (b.pBasis !== 'total' && b.pBasis !== 'direct') throw new Error('Protein basis must be "total" or "direct"');
    out.pBasis = b.pBasis;
  }
  return out;
}
const targetsError = t => (t == null ? '' : !isObj(t) ? 'Day targets must be an object'
  : ['k', 'p', 'c', 'f'].some(k => t[k] !== undefined && !isNum(t[k])) ? 'Day targets must be numbers' : '');

const router = express.Router();
router.use(requireAuth);
router.use(express.json({ limit: '300kb' }));
router.use(csrfProtect);
router.use(ai.scope);
/* Every account's saves, whatever the route: the tracker saves a changed day 0.6 s after the last edit, so even nonstop
   editing stays far below this; a script hammering saves doesn't. Photo uploads have their own byte, count and rate caps. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const photoUpload = req => (req.method === 'POST' && req.path === '/photos') || (req.method === 'PUT' && /^\/photos\/\d+\/thumb$/.test(req.path));
router.use(rateLimit({
  windowMs: 10 * 60 * 1000, limit: config.writeRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => 'u' + req.user.id, skip: req => SAFE.has(req.method) || photoUpload(req),
  message: { error: 'That’s a lot of saving in a short time – wait a few minutes and try again.' },
}));

router.get('/me', (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, name: req.user.name, hasPassword: !!req.user.password_hash,
    google: !!req.user.google_sub, totp: twostep.isOn(req.user.id), admin: defaults.isAdmin(req.user), ai: ai.status().configured, ...options(), csrf: csrfToken(req, res) });
});

/* Each account's own meal plan (foods, day templates, week, targets), as dated changes. There are no app-wide defaults. */
router.get('/defaults', (req, res) => res.json(defaults.forUser(req.user)));
/* Account admin: anyone keeps their own plan. */
/* a change to one dated plan change is checked against that change's updatedAt (server/version.js) */
router.put('/my/defaults', (req, res) => {
  try {
    if (isObj(req.body) && Object.hasOwn(req.body, 'from')) {
      const from = req.body.from != null && req.body.from !== '' ? req.body.from : null;
      const cur = defaults.myVersions(req.user).find(v => (v.from || null) === from);
      version.check(req, (cur && cur.updatedAt) || null);
    }
    res.json(defaults.putMine(req.body, req.user));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
router.delete('/my/defaults', (req, res) => res.json(defaults.delMine(req.user)));
router.delete('/my/defaults/:from', (req, res) => {
  try { res.json(defaults.delMine(req.user, req.params.from)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

/* AI: the OpenRouter key and models (super admin), and reading a plan PDF into an account's plan format. */
const adminOnly = (req, res, next) => {
  if (!defaults.isAdmin(req.user)) return res.status(403).json({ error: 'Only the super admin can do this' });
  if (options().adminTotp && !twostep.isOn(req.user.id)) {
    return res.status(403).json({ setup2fa: true, error: 'Super admins must use a second sign-in step. Set it up under Two-step sign-in on the account menu first.' });
  }
  next();
};
/* changing the AI key, the email account or removing an account: password or code again if the sign-in is over 15 minutes old */
const fresh = twostep.fresh;
/* ?bg=1 runs it in the background (server/jobs.js); ?date= is the plan change being edited, whose foods the AI is told */
const readPlan = (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null, type = String(req.get('content-type') || '').split(';')[0].trim();
  return jobs.respond(req, res, 'plan', () => ai.check(buf, type), () => ai.importPlan(buf, type, req.user, isDate(req.query.date) ? req.query.date : undefined));
};
router.get('/admin/ai', adminOnly, (req, res) => res.json(ai.status()));
router.put('/admin/ai', adminOnly, (req, res, next) => (isObj(req.body) && Object.hasOwn(req.body, 'key') ? fresh(req, res, next) : next()), (req, res) => {
  if (!isObj(req.body)) return bad(res, 'Settings must be an object');
  try {
    const out = ai.save(req.body, req.user), b = req.body;
    audit.log(req, 'ai.settings', { apiKey: b.key === undefined ? undefined : String(b.key || '').trim() ? 'set' : 'cleared',
      model: b.model === undefined ? undefined : true, tasks: isObj(b.models) ? Object.keys(b.models) : undefined });
    res.json(out);
  } catch (e) { bad(res, e.message); }
});
/* The OpenRouter key is the super admin's, so each account gets a handful of reads an hour. */
const aiLimit = ai.limiter(12, 'That’s a lot of AI reads – wait a while and try again.', { skip: req => defaults.isAdmin(req.user) });
router.post('/my/ai-import', aiLimit, express.raw({ type: ai.TYPES_IN, limit: '10mb' }), ai.scope, readPlan);

/* Accounts: the list, inviting someone (emailed if email is set up) and removing an account. */
const fail = (res, e) => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); };
const userId = req => (/^\d{1,12}$/.test(req.params.id) ? +req.params.id : 0);
router.get('/admin/users', adminOnly, (req, res) => res.json({ users: users.list(req.user, defaults.isAdmin), email: mail.configured() }));
router.post('/admin/users', adminOnly, async (req, res) => {
  if (!isObj(req.body)) return bad(res, 'Send an email address');
  try { const r = await users.invite(req.body, req.user); audit.log(req, 'invite.created', { email: r.email }, r.id); res.json(r); } catch (e) { fail(res, e); }
});
router.post('/admin/users/:id/invite', adminOnly, async (req, res) => {
  try { const r = await users.resend(userId(req), req.user); audit.log(req, 'invite.created', { email: r.email, resent: true }, r.id); res.json(r); } catch (e) { fail(res, e); }
});
router.delete('/admin/users/:id', adminOnly, fresh, (req, res) => {
  try {
    const id = userId(req), files = photos.filesOf(id), target = authQ.byId.get(id);
    const out = users.remove(id, req.user, defaults.isAdmin);
    audit.log(req, 'account.removed', { email: target && target.email }, id);
    res.json(out);
    photos.removeFiles(files);
  } catch (e) { fail(res, e); }
});

/* The security log (server/audit.js): everything for the super admin, your own sign-ins and the like for anyone. */
router.get('/admin/log', adminOnly, (req, res) => res.json(audit.list(req.query)));
router.get('/my/log', (req, res) => res.json(audit.mine(req.user, req.query)));

router.get('/admin/options', adminOnly, (req, res) => res.json(options()));
router.put('/admin/options', adminOnly, (req, res) => {
  if (!isObj(req.body)) return bad(res, 'Options must be an object');
  const o = options();
  for (const [k, v] of Object.entries(req.body)) {
    if (!Object.hasOwn(OPTIONS, k)) return bad(res, `Unknown option "${k}"`);
    if (!optionOk(k, v)) return bad(res, typeof OPTIONS[k] === 'number' ? `"${k}" must be a whole number from 0 to ${MAX_CAP}` : `"${k}" must be true or false`);
    if (k === 'adminTotp' && v && !o.adminTotp && !twostep.isOn(req.user.id)) return bad(res, 'Set up your own second sign-in step (account menu) before requiring it.');
    o[k] = v;
  }
  q.putOptions.run(JSON.stringify(o), req.user.email);
  audit.log(req, 'options.changed', req.body);
  res.json(o);
});

/* The account the app sends email from (SMTP). Only the names of the fields changed go in the security log. */
const MAIL_FIELDS = ['host', 'port', 'secure', 'user', 'pass', 'from', 'fromName'];
router.get('/admin/email', adminOnly, (req, res) => res.json(mail.status()));
router.put('/admin/email', adminOnly, fresh, async (req, res) => {
  if (!isObj(req.body)) return bad(res, 'Settings must be an object');
  try {
    const out = await mail.save(req.body, req.user);
    audit.log(req, 'email.settings', { fields: Object.keys(req.body).filter(k => MAIL_FIELDS.includes(k)) });
    res.json(out);
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
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
  let json;
  try { json = JSON.stringify(cleanSettings(req.body)); } catch (e) { return bad(res, e.message); }
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
/* all of an account's saved days together (a day is a few KB; 50 MB is decades of them) */
const MAX_DAYS_TOTAL = config.quota.days;
router.put('/days/:date', (req, res) => {
  const err = writeError(req.params.date);
  if (err) return bad(res, err);
  const { data, summary } = req.body || {};
  if (!isObj(data) || !Array.isArray(data.meals)) return bad(res, 'Day data is missing its meals');
  if (targetsError(data.targets)) return bad(res, targetsError(data.targets));
  const json = JSON.stringify(data);
  if (json.length > MAX_JSON) return bad(res, 'Day data too large');
  const cur = q.dayVersion.get(req.user.id, req.params.date);
  if (version.stale(req, cur && cur.updated_at)) return res.status(409).json({ error: version.MSG });
  const old = q.daySize.get(req.user.id, req.params.date);
  if (q.daysSize.get(req.user.id).n - (old ? old.n : 0) + json.length > MAX_DAYS_TOTAL) {
    return res.status(413).json({ error: `Your saved days have reached the ${Math.round(MAX_DAYS_TOTAL / 1048576)} MB an account can keep – delete some old days first` });
  }
  const updated = version.stamp();
  q.putDay.run(req.user.id, req.params.date, json, JSON.stringify(cleanSummary(summary)), updated);
  res.json({ ok: true, updated });
});
router.delete('/days/:date', (req, res) => {
  if (!isDate(req.params.date)) return bad(res, 'Bad date');
  if (q.delDay.run(req.user.id, req.params.date).changes) audit.log(req, 'day.deleted', { date: req.params.date });
  res.json({ ok: true });
});

router.get('/weights', (req, res) => {
  res.json(q.listWeights.all(req.user.id, ...range(req)));
});
router.put('/weights/:date', (req, res) => {
  const err = writeError(req.params.date);
  if (err) return bad(res, err);
  const kg = +(req.body && req.body.kg);
  if (!isNum(req.body && req.body.kg) || kg < 20 || kg > 400) return bad(res, 'Weight must be between 20 and 400 kg');
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
router.use('/totp', twostep.router);
/* password or code again before a sensitive change (twostep.fresh) */
router.post('/recheck', twostep.recheck);

/* Everything you've stored, as one JSON file. Written a section (and a few hundred days) at a time, letting other
   requests run in between, and only a few times an hour per account. */
const exportLimit = rateLimit({
  windowMs: 60 * 60 * 1000, limit: config.exportRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => 'u' + req.user.id, message: { error: 'You’ve downloaded your data a lot this hour – try again later.' },
});
const EXPORT_DAYS = 200;
const breathe = () => new Promise(r => setImmediate(r));
router.get('/export', exportLimit, async (req, res) => {
  const user = req.user;
  const write = str => (res.write(str) ? null : new Promise(r => {
    const go = () => { res.off('drain', go); res.off('close', go); r(); };
    res.on('drain', go); res.on('close', go);
  }));
  const field = async (name, value, first) => { await write(`${first ? '{' : ','}${JSON.stringify(name)}:${JSON.stringify(value)}`); await breathe(); };
  const sections = [
    ['settings', () => { const s = q.getSettings.get(user.id); return s ? JSON.parse(s.data) : {}; }],
    ['defaults', () => defaults.mine(user)],
    ['planChanges', () => defaults.myVersions(user)],
    ['days', null],
    ['weights', () => q.listWeights.all(user.id, '0000-01-01', '9999-12-31')],
    ['gym', () => gym.exportFor(user)],
    ['foods', () => foods.exportFor(user)],
    ['supplements', () => supps.exportFor(user)],
    ['checklist', () => checklist.exportFor(user)],
    ['photos', () => photos.exportFor(user)],
  ];
  audit.log(req, 'export');
  res.attachment(`logbook-monster-${new Date().toISOString().slice(0, 10)}.json`);
  res.type('json');
  try {
    await field('exported', new Date().toISOString(), true);
    await field('email', user.email);
    for (const [name, get] of sections) {
      if (res.destroyed) return;
      if (get) { await field(name, get()); continue; }
      /* days are stored as JSON already: copied as they are, a batch at a time */
      await write(',"days":[');
      for (let after = '', n = 0; ;) {
        const rows = q.daysAfter.all(user.id, after, EXPORT_DAYS);
        for (const r of rows) await write(`${n++ ? ',' : ''}{"date":${JSON.stringify(r.date)},"data":${r.data}}`);
        if (rows.length < EXPORT_DAYS || res.destroyed) break;
        after = rows[rows.length - 1].date;
        await breathe();
      }
      await write(']');
    }
    res.end('}');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong' }); else res.destroy();
  }
});

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

router.appOptions = options;   /* for server/ai.js (daily caps, aiPrivate) */
module.exports = router;

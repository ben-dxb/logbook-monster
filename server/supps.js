'use strict';
/* Supplements: a library (yours plus everything someone has shared, like the food library) and a log of
   what you took each day. A log entry is picked from the library or typed in free text, with an amount
   and a unit (g, mg, mcg, IU, capsules…). Only the owner changes a library entry; an admin can also
   remove a shared one. */
const express = require('express');
const db = require('./db');
const defaults = require('./defaults');

const COLS = 's.id, s.user_id, s.name, s.amount, s.unit, s.notes, s.public, s.updated_at, u.name AS owner';
const LOG = 'id, date, supplement_id AS sid, name, amount, unit, note, created_at AS created';
const q = {
  list: db.prepare(`SELECT ${COLS} FROM supplements s JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ? OR s.public = 1 ORDER BY s.name COLLATE NOCASE, s.id`),
  get: db.prepare(`SELECT ${COLS} FROM supplements s JOIN users u ON u.id = s.user_id WHERE s.id = ?`),
  count: db.prepare('SELECT COUNT(*) AS n FROM supplements WHERE user_id = ?'),
  add: db.prepare('INSERT INTO supplements (user_id, name, amount, unit, notes, public) VALUES (?, ?, ?, ?, ?, ?)'),
  put: db.prepare(`UPDATE supplements SET name = ?, amount = ?, unit = ?, notes = ?, public = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`),
  del: db.prepare('DELETE FROM supplements WHERE id = ?'),
  mine: db.prepare('SELECT id, name, amount, unit, notes, public FROM supplements WHERE user_id = ? ORDER BY id'),

  logRange: db.prepare(`SELECT ${LOG} FROM supplement_log WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date, id`),
  logGet: db.prepare(`SELECT ${LOG} FROM supplement_log WHERE user_id = ? AND id = ?`),
  logCount: db.prepare('SELECT COUNT(*) AS n FROM supplement_log WHERE user_id = ?'),
  logAdd: db.prepare('INSERT INTO supplement_log (user_id, date, supplement_id, name, amount, unit, note) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  logPut: db.prepare('UPDATE supplement_log SET date = ?, supplement_id = ?, name = ?, amount = ?, unit = ?, note = ? WHERE user_id = ? AND id = ?'),
  logDel: db.prepare('DELETE FROM supplement_log WHERE user_id = ? AND id = ?'),
  logAll: db.prepare(`SELECT ${LOG} FROM supplement_log WHERE user_id = ? ORDER BY date, id`),

  trends: db.prepare('SELECT name FROM supplement_trends WHERE user_id = ? ORDER BY name'),
  trendCount: db.prepare('SELECT COUNT(*) AS n FROM supplement_trends WHERE user_id = ?'),
  trendAdd: db.prepare('INSERT OR IGNORE INTO supplement_trends (user_id, name) VALUES (?, ?)'),
  trendDel: db.prepare('DELETE FROM supplement_trends WHERE user_id = ? AND name = ?'),
};
const trendsOf = user => q.trends.all(user.id).map(r => r.name);

const MAX_SUPPS = 300, MAX_LOG = 50000, MAX_TRENDS = 30;
const UNITS = ['g', 'mg', 'mcg', 'IU', 'ml', 'drops', 'capsules', 'tablets', 'softgels', 'scoops', 'servings'];
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isDate = s => typeof s === 'string' && DATE_RE.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const idOf = v => (/^\d{1,12}$/.test(String(v)) ? +v : 0);
const line = (v, max, what) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (s.length > max) throw fail(`${what} is too long (${max} characters at most)`);
  return s;
};
const unitOf = v => {
  if (!UNITS.includes(v)) throw fail(`Pick a unit: ${UNITS.join(', ')}`);
  return v;
};
/* amounts keep up to three decimals (0.125 mg); blank is allowed only where the amount is optional */
function amountOf(v, optional) {
  if (optional && (v === '' || v == null)) return null;
  const n = +v;
  if (v === '' || v == null || !Number.isFinite(n) || n <= 0 || n > 1e6) throw fail('Amount must be a number above 0');
  return Math.round(n * 1000) / 1000;
}

function clean(b) {
  if (!isObj(b)) throw fail('Supplement must be an object');
  const name = line(b.name, 80, 'Name');
  if (!name) throw fail('Give the supplement a name');
  const notes = String(b.notes == null ? '' : b.notes).replace(/\r\n?/g, '\n').trim();
  if (notes.length > 2000) throw fail('Notes are too long (2000 characters at most)');
  return { name, amount: amountOf(b.amount, true), unit: unitOf(b.unit), notes, public: b.public ? 1 : 0 };
}

const visible = (row, user) => row && (row.user_id === user.id || row.public);

/* A log entry from the library takes its name from there unless you typed one; a free-text entry needs a
   description. keep is the entry being edited: its own link stays even if that supplement has since gone private. */
function cleanLog(b, user, keep) {
  if (!isObj(b)) throw fail('Entry must be an object');
  if (!isDate(b.date)) throw fail('Pick a day');
  let sid = null, name = line(b.name, 200, 'Description');
  if (b.supplement != null && b.supplement !== '') {
    const id = idOf(b.supplement);
    if (keep && keep.sid && id === keep.sid) { sid = id; if (!name) name = keep.name; }
    else {
      const row = q.get.get(id);
      if (!visible(row, user)) throw fail('That supplement isn’t in the library', 404);
      sid = row.id; if (!name) name = row.name;
    }
  }
  if (!name) throw fail('Pick a supplement or describe it');
  return { date: b.date, sid, name, amount: amountOf(b.amount), unit: unitOf(b.unit), note: line(b.note, 200, 'Note') };
}

/* Other people's supplements show their name, never their email. */
function view(r, user) {
  const mine = r.user_id === user.id;
  return { id: r.id, name: r.name, amount: r.amount, unit: r.unit, notes: r.notes,
    public: !!r.public, mine, by: mine ? null : r.owner || null, updated: r.updated_at };
}

const router = express.Router();
const send = (res, e) => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); };

router.get('/', (req, res) => res.json({ supplements: q.list.all(req.user.id).map(r => view(r, req.user)), units: UNITS, trends: trendsOf(req.user) }));

/* "Trend" box: follow a supplement (by name) on the Timeline's chart. Declared before /:id. */
router.put('/trend', (req, res) => {
  try {
    if (!isObj(req.body)) throw fail('Send a name');
    const name = line(req.body.name, 200, 'Name');
    if (!name) throw fail('Send a name');
    if (req.body.on) {
      if (q.trendCount.get(req.user.id).n >= MAX_TRENDS) throw fail(`You can follow ${MAX_TRENDS} supplements on the trend chart at most`);
      q.trendAdd.run(req.user.id, name);
    } else q.trendDel.run(req.user.id, name);
    res.json({ trends: trendsOf(req.user) });
  } catch (e) { send(res, e); }
});

router.post('/', (req, res) => {
  try {
    const d = clean(req.body);
    if (q.count.get(req.user.id).n >= MAX_SUPPS) throw fail(`Your supplement library is full (${MAX_SUPPS})`);
    const { lastInsertRowid } = q.add.run(req.user.id, d.name, d.amount, d.unit, d.notes, d.public);
    res.json(view(q.get.get(Number(lastInsertRowid)), req.user));
  } catch (e) { send(res, e); }
});

/* the log: GET /log?date=… for one day, or ?from=…&to=… for a range */
router.get('/log', (req, res) => {
  const { date, from, to } = req.query;
  if (date !== undefined && !isDate(date)) return res.status(400).json({ error: 'Bad date' });
  const a = date || (isDate(from) ? from : '0000-01-01'), z = date || (isDate(to) ? to : '9999-12-31');
  res.json({ entries: q.logRange.all(req.user.id, a, z) });
});
router.post('/log', (req, res) => {
  try {
    const d = cleanLog(req.body, req.user);
    if (q.logCount.get(req.user.id).n >= MAX_LOG) throw fail('Your supplement log is full');
    const { lastInsertRowid } = q.logAdd.run(req.user.id, d.date, d.sid, d.name, d.amount, d.unit, d.note);
    res.json(q.logGet.get(req.user.id, Number(lastInsertRowid)));
  } catch (e) { send(res, e); }
});
router.put('/log/:id', (req, res) => {
  try {
    const row = q.logGet.get(req.user.id, idOf(req.params.id));
    if (!row) throw fail('No such entry', 404);
    const d = cleanLog(req.body, req.user, row);
    q.logPut.run(d.date, d.sid, d.name, d.amount, d.unit, d.note, req.user.id, row.id);
    res.json(q.logGet.get(req.user.id, row.id));
  } catch (e) { send(res, e); }
});
router.delete('/log/:id', (req, res) => {
  q.logDel.run(req.user.id, idOf(req.params.id));
  res.json({ ok: true });
});

router.put('/:id', (req, res) => {
  try {
    const row = q.get.get(idOf(req.params.id));
    if (!visible(row, req.user)) throw fail('No such supplement', 404);
    if (row.user_id !== req.user.id) throw fail('Only the person who added this supplement can change it', 403);
    const d = clean(req.body);
    q.put.run(d.name, d.amount, d.unit, d.notes, d.public, row.id, req.user.id);
    res.json(view(q.get.get(row.id), req.user));
  } catch (e) { send(res, e); }
});

router.delete('/:id', (req, res) => {
  try {
    const row = q.get.get(idOf(req.params.id));
    if (!visible(row, req.user)) throw fail('No such supplement', 404);
    if (row.user_id !== req.user.id && !defaults.isAdmin(req.user)) throw fail('Only the person who added this supplement can remove it', 403);
    q.del.run(row.id);
    res.json({ ok: true });
  } catch (e) { send(res, e); }
});

const exportFor = user => ({
  library: q.mine.all(user.id).map(r => ({ ...r, public: !!r.public })),
  log: q.logAll.all(user.id),
  trends: trendsOf(user),
});

module.exports = { router, exportFor, trendsOf, UNITS };

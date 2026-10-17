'use strict';
/* The Dashboard's daily checklist. Each account keeps its own list of items (set on Account admin; until it
   changes anything it has DEFAULTS) and ticks them off day by day.
   An item is {id, label, show, auto}:
   - show: 'all' (every day), 'training' (days whose day template is a training one – the browser decides, see
     dIsTraining in public/dash.js) or 'tpl:<template id>' (only days on that template);
   - auto: '' or 'weight' | 'supps' | 'gym' – the item also counts as done on a day a weight, a supplement or a gym
     set is logged, so nobody has to tick what the app already knows. */
const express = require('express');
const db = require('./db');
const { isDate, writeError } = require('./dates');

const DEFAULTS = [
  { id: 'weigh', label: 'Weigh in', show: 'all', auto: 'weight' },
  { id: 'meals', label: 'Meals planned/prepped', show: 'all', auto: '' },
  { id: 'supps', label: 'Supplements taken', show: 'all', auto: 'supps' },
  { id: 'water', label: 'Water intake hit', show: 'all', auto: '' },
  { id: 'steps', label: 'Step count hit', show: 'all', auto: '' },
  { id: 'training', label: 'Training done', show: 'training', auto: 'gym' },
  { id: 'cardio', label: 'Cardio done', show: 'all', auto: '' },
];
const AUTOS = ['', 'weight', 'supps', 'gym'];
const MAX_ITEMS = 20;
const ID_RE = /^[a-z][a-z0-9_]{0,15}$/;
const SHOW_RE = /^(all|training|tpl:[A-Za-z][A-Za-z0-9_]{0,15})$/;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const fail = msg => Object.assign(new Error(msg), { status: 400 });

const q = {
  get: db.prepare('SELECT items FROM checklists WHERE user_id = ?'),
  put: db.prepare(`INSERT INTO checklists (user_id, items) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET items = excluded.items, updated_at = datetime('now')`),
  del: db.prepare('DELETE FROM checklists WHERE user_id = ?'),
  range: db.prepare('SELECT date, item FROM checklist_log WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date, item'),
  tick: db.prepare('INSERT OR IGNORE INTO checklist_log (user_id, date, item) VALUES (?, ?, ?)'),
  untick: db.prepare('DELETE FROM checklist_log WHERE user_id = ? AND date = ? AND item = ?'),
  all: db.prepare('SELECT date, item, done_at FROM checklist_log WHERE user_id = ? ORDER BY date, item'),
};

const itemsOf = user => { const r = q.get.get(user.id); return r ? JSON.parse(r.items) : DEFAULTS; };

function clean(list) {
  if (!Array.isArray(list)) throw fail('Send a list of checklist items');
  if (list.length > MAX_ITEMS) throw fail(`A checklist can have ${MAX_ITEMS} items at most`);
  const seen = new Set();
  return list.map((b, i) => {
    if (!isObj(b)) throw fail(`Item ${i + 1} isn’t an object`);
    const label = String(b.label == null ? '' : b.label).replace(/\s+/g, ' ').trim();
    if (!label) throw fail(`Item ${i + 1} needs a name`);
    if (label.length > 60) throw fail(`“${label.slice(0, 20)}…” is too long (60 characters at most)`);
    const id = String(b.id || '');
    if (!ID_RE.test(id)) throw fail(`${label}: bad id`);
    if (seen.has(id)) throw fail(`${label}: the same id is used twice`);
    seen.add(id);
    const show = b.show == null || b.show === '' ? 'all' : String(b.show);
    if (!SHOW_RE.test(show)) throw fail(`${label}: pick which days it shows on`);
    const auto = b.auto == null ? '' : String(b.auto);
    if (!AUTOS.includes(auto)) throw fail(`${label}: unknown automatic tick`);
    return { id, label, show, auto };
  });
}

/* { date: [ticked item ids] } for a range of days */
function ticks(user, from, to) {
  const out = {};
  for (const r of q.range.all(user.id, from, to)) (out[r.date] = out[r.date] || []).push(r.item);
  return out;
}

const router = express.Router();
const send = fn => (req, res) => {
  try { res.json(fn(req)); }
  catch (e) { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); }
};

router.get('/', send(req => ({ items: itemsOf(req.user), custom: !!q.get.get(req.user.id), defaults: DEFAULTS })));
/* Account admin: the list itself. Sending the default list back (or DELETE) goes back to following the defaults. */
router.put('/', send(req => {
  const items = clean(isObj(req.body) ? req.body.items : null);
  q.put.run(req.user.id, JSON.stringify(items));
  return { items, custom: true, defaults: DEFAULTS };
}));
router.delete('/', send(req => { q.del.run(req.user.id); return { items: DEFAULTS, custom: false, defaults: DEFAULTS }; }));

/* GET /days?from=…&to=… (at most a year) → { days: { date: [ids] } } */
router.get('/days', send(req => {
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to) || from > to) throw fail('Send from and to dates');
  if (Date.parse(to) - Date.parse(from) > 366 * 864e5) throw fail('A year at most at a time');
  return { days: ticks(req.user, from, to) };
}));
/* PUT /days/2026-10-16 {item, done} ticks or unticks one item; only items on your list can be ticked. */
router.put('/days/:date', send(req => {
  const date = req.params.date, b = isObj(req.body) ? req.body : {};
  const bad = writeError(date);
  if (bad) throw fail(bad);
  const item = String(b.item || '');
  if (b.done) {
    if (!itemsOf(req.user).some(i => i.id === item)) throw fail('That isn’t on your checklist');
    q.tick.run(req.user.id, date, item);
  } else q.untick.run(req.user.id, date, item);
  return { date, done: ticks(req.user, date, date)[date] || [] };
}));

const exportFor = user => ({ items: itemsOf(user), ticks: q.all.all(user.id) });

module.exports = { router, exportFor, DEFAULTS };

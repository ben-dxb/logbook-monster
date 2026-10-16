'use strict';
/* The food library: foods you enter yourself (macros per 100 g, per 100 ml or per item) with an
   optional recipe. You see your own foods plus every food someone has shared; only the owner can
   change a food, and an admin can also remove a shared one. Adding a food to a day happens in the browser. */
const express = require('express');
const db = require('./db');
const defaults = require('./defaults');

const COLS = 'f.id, f.user_id, f.name, f.unit, f.k, f.p, f.c, f.f, f.recipe, f.public, f.updated_at, u.name AS owner';
const q = {
  list: db.prepare(`SELECT ${COLS} FROM foods f JOIN users u ON u.id = f.user_id
    WHERE f.user_id = ? OR f.public = 1 ORDER BY f.name COLLATE NOCASE, f.id`),
  get: db.prepare(`SELECT ${COLS} FROM foods f JOIN users u ON u.id = f.user_id WHERE f.id = ?`),
  count: db.prepare('SELECT COUNT(*) AS n FROM foods WHERE user_id = ?'),
  add: db.prepare('INSERT INTO foods (user_id, name, unit, k, p, c, f, recipe, public) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  put: db.prepare(`UPDATE foods SET name = ?, unit = ?, k = ?, p = ?, c = ?, f = ?, recipe = ?, public = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`),
  del: db.prepare('DELETE FROM foods WHERE id = ?'),
  mine: db.prepare('SELECT id, name, unit, k, p, c, f, recipe, public FROM foods WHERE user_id = ? ORDER BY id'),
};

const MAX_FOODS = 500;
const UNITS = ['g', 'ml', 'each'];
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const idOf = v => (/^\d{1,12}$/.test(String(v)) ? +v : 0);

function clean(b) {
  if (!isObj(b)) throw fail('Food must be an object');
  const name = String(b.name == null ? '' : b.name).replace(/\s+/g, ' ').trim();
  if (!name) throw fail('Give the food a name');
  if (name.length > 80) throw fail('Name is too long (80 characters at most)');
  const unit = UNITS.includes(b.unit) ? b.unit : 'g';
  const per = unit === 'each' ? 'an item' : `100 ${unit}`;
  const num = (v, hi, what) => {
    const n = v === '' || v == null ? 0 : +v;
    if (!Number.isFinite(n) || n < 0 || n > hi) throw fail(`${what} must be a number from 0 to ${hi} (per ${per})`);
    return Math.round(n * 10) / 10;
  };
  /* per 100 g no macro can pass 100 g; an item (a whole portion) can */
  const mhi = unit === 'each' ? 1000 : 100;
  const out = { name, unit, k: num(b.k, unit === 'each' ? 10000 : 1000, 'Calories'),
    p: num(b.p, mhi, 'Protein'), c: num(b.c, mhi, 'Carbs'), f: num(b.f, mhi, 'Fat') };
  if (!out.k && !out.p && !out.c && !out.f) throw fail('Enter the calories or macros');
  out.recipe = String(b.recipe == null ? '' : b.recipe).replace(/\r\n?/g, '\n').trim();
  if (out.recipe.length > 4000) throw fail('Recipe is too long (4000 characters at most)');
  out.public = b.public ? 1 : 0;
  return out;
}

/* Other people's foods show their name, never their email. */
function view(r, user) {
  const mine = r.user_id === user.id;
  return { id: r.id, name: r.name, unit: r.unit, k: r.k, p: r.p, c: r.c, f: r.f, recipe: r.recipe,
    public: !!r.public, mine, by: mine ? null : r.owner || null, updated: r.updated_at };
}

const router = express.Router();
const send = (res, e) => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); };

router.get('/', (req, res) => res.json({ foods: q.list.all(req.user.id).map(r => view(r, req.user)) }));

router.post('/', (req, res) => {
  try {
    const d = clean(req.body);
    if (q.count.get(req.user.id).n >= MAX_FOODS) throw fail(`Your library is full (${MAX_FOODS} foods)`);
    const { lastInsertRowid } = q.add.run(req.user.id, d.name, d.unit, d.k, d.p, d.c, d.f, d.recipe, d.public);
    res.json(view(q.get.get(Number(lastInsertRowid)), req.user));
  } catch (e) { send(res, e); }
});

router.put('/:id', (req, res) => {
  try {
    const row = q.get.get(idOf(req.params.id));
    if (!row || (row.user_id !== req.user.id && !row.public)) throw fail('No such food', 404);
    if (row.user_id !== req.user.id) throw fail('Only the person who added this food can change it', 403);
    const d = clean(req.body);
    q.put.run(d.name, d.unit, d.k, d.p, d.c, d.f, d.recipe, d.public, row.id, req.user.id);
    res.json(view(q.get.get(row.id), req.user));
  } catch (e) { send(res, e); }
});

router.delete('/:id', (req, res) => {
  try {
    const row = q.get.get(idOf(req.params.id));
    if (!row || (row.user_id !== req.user.id && !row.public)) throw fail('No such food', 404);
    if (row.user_id !== req.user.id && !defaults.isAdmin(req.user)) throw fail('Only the person who added this food can remove it', 403);
    q.del.run(row.id);
    res.json({ ok: true });
  } catch (e) { send(res, e); }
});

const exportFor = user => q.mine.all(user.id).map(r => ({ ...r, public: !!r.public }));

module.exports = { router, exportFor, clean };

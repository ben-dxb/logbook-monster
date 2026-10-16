'use strict';
/* The food library: foods you enter yourself (macros per 100 g, per 100 ml or per item) with an
   optional recipe. You see your own foods plus every food someone has shared; only the owner can
   change a food, and an admin can also remove a shared one. Adding a food to a day happens in the browser.
   Each food is a whole meal or a single ingredient. AI can fill in values left blank; those values are
   flagged (food.ai) with the source the AI gave, so anyone can see which numbers are estimates. */
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const defaults = require('./defaults');
const ai = require('./ai');

const COLS = 'f.id, f.user_id, f.name, f.unit, f.kind, f.k, f.p, f.c, f.f, f.recipe, f.public, f.ai, f.state, f.yield, f.free, f.updated_at, u.name AS owner';
const q = {
  list: db.prepare(`SELECT ${COLS} FROM foods f JOIN users u ON u.id = f.user_id
    WHERE f.user_id = ? OR f.public = 1 ORDER BY f.name COLLATE NOCASE, f.id`),
  get: db.prepare(`SELECT ${COLS} FROM foods f JOIN users u ON u.id = f.user_id WHERE f.id = ?`),
  count: db.prepare('SELECT COUNT(*) AS n FROM foods WHERE user_id = ?'),
  add: db.prepare('INSERT INTO foods (user_id, name, unit, kind, k, p, c, f, recipe, public, ai, state, yield, free) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  put: db.prepare(`UPDATE foods SET name = ?, unit = ?, kind = ?, k = ?, p = ?, c = ?, f = ?, recipe = ?, public = ?, ai = ?, state = ?, yield = ?, free = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`),
  del: db.prepare('DELETE FROM foods WHERE id = ?'),
  mine: db.prepare('SELECT id, name, unit, kind, k, p, c, f, recipe, public, ai, state, yield, free FROM foods WHERE user_id = ? ORDER BY id'),
};

const MAX_FOODS = 500;
const UNITS = ['g', 'ml', 'each'];
const KINDS = ['meal', 'ingredient'];
const FREE = ['sauce', 'veg'];   /* free foods: sauce or green veg, see engine.js */
const MACROS = ['k', 'p', 'c', 'f'];
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const idOf = v => (/^\d{1,12}$/.test(String(v)) ? +v : 0);

const oneLine = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function name_(b) {
  const name = oneLine(b.name, 200);
  if (!name) throw fail('Give the food a name');
  if (name.length > 80) throw fail('Name is too long (80 characters at most)');
  return name;
}
const unitOf = b => (UNITS.includes(b.unit) ? b.unit : 'g');
/* per 100 g no macro can pass 100 g; an item (a whole portion) can */
const limits = unit => ({ k: unit === 'each' ? 10000 : 1000, p: unit === 'each' ? 1000 : 100, c: unit === 'each' ? 1000 : 100, f: unit === 'each' ? 1000 : 100 });
const LABEL = { k: 'Calories', p: 'Protein', c: 'Carbs', f: 'Fat' };

function clean(b) {
  if (!isObj(b)) throw fail('Food must be an object');
  const name = name_(b), unit = unitOf(b), hi = limits(unit);
  const per = unit === 'each' ? 'an item' : `100 ${unit}`;
  const num = (v, m) => {
    const n = v === '' || v == null ? 0 : +v;
    if (!Number.isFinite(n) || n < 0 || n > hi[m]) throw fail(`${LABEL[m]} must be a number from 0 to ${hi[m]} (per ${per})`);
    return Math.round(n * 10) / 10;
  };
  const out = { name, unit, k: num(b.k, 'k'), p: num(b.p, 'p'), c: num(b.c, 'c'), f: num(b.f, 'f') };
  if (!out.k && !out.p && !out.c && !out.f) throw fail('Enter the calories or macros');
  out.recipe = String(b.recipe == null ? '' : b.recipe).replace(/\r\n?/g, '\n').trim();
  if (out.recipe.length > 4000) throw fail('Recipe is too long (4000 characters at most)');
  out.public = b.public ? 1 : 0;
  /* no kind given (e.g. saved from the Day page): a recipe or a whole portion makes it a meal */
  out.kind = KINDS.includes(b.kind) ? b.kind : out.recipe || unit === 'each' ? 'meal' : 'ingredient';
  out.ai = cleanAi(b.ai);
  out.free = FREE.includes(b.free) ? b.free : '';
  Object.assign(out, cleanState(b, unit));
  return out;
}

/* Raw or cooked: only for foods weighed in grams. The yield (cooked weight as % of raw, e.g. 75 for
   chicken, 280 for rice) lets the library show the values the other way round. */
function cleanState(b, unit) {
  const state = unit === 'g' && ['raw', 'cooked'].includes(b.state) ? b.state : '';
  if (!state || b.yield === '' || b.yield == null) return { state, yield: null };
  const y = +b.yield;
  if (!Number.isFinite(y) || y < 10 || y > 1000) throw fail('Cooked weight must be from 10 to 1000 % of the raw weight');
  return { state, yield: Math.round(y) };
}

/* Which values AI estimated and where it says they come from. Kept as given by the fill endpoint;
   the browser drops a field from the list when someone types their own value over it. */
function cleanAi(a) {
  if (!isObj(a)) return null;
  const fields = MACROS.filter(m => Array.isArray(a.fields) && a.fields.includes(m));
  if (!fields.length) return null;
  const url = oneLine(a.url, 300);
  return {
    fields,
    source: oneLine(a.source, 300) || 'AI estimate',
    basis: (Array.isArray(a.basis) ? a.basis : []).map(x => oneLine(x, 200)).filter(Boolean).slice(0, 20),
    url: /^https:\/\/[^\s<>"']+$/.test(url) ? url : '',
    confidence: ['high', 'medium', 'low'].includes(a.confidence) ? a.confidence : '',
    model: oneLine(a.model, 100),
    at: /^\d{4}-\d\d-\d\d/.test(String(a.at || '')) ? String(a.at).slice(0, 10) : new Date().toISOString().slice(0, 10),
  };
}
const aiOf = r => { try { return r.ai ? cleanAi(JSON.parse(r.ai)) : null; } catch { return null; } };

/* Other people's foods show their name, never their email. */
function view(r, user) {
  const mine = r.user_id === user.id;
  return { id: r.id, name: r.name, unit: r.unit, kind: r.kind, k: r.k, p: r.p, c: r.c, f: r.f, recipe: r.recipe,
    public: !!r.public, ai: aiOf(r), state: r.state || '', yield: r.yield == null ? null : r.yield, free: r.free || '', mine, by: mine ? null : r.owner || null, updated: r.updated_at };
}

/* ---------- AI fill ---------- */
const PROMPT = `You estimate nutrition values for foods in a meal planning app.
You get a food's name, whether it is a whole meal or a single ingredient, what the values are measured per
(100 g, 100 ml, or one item / portion), an optional recipe or notes, and the values the person already knows.
Estimate ONLY the missing values, consistent with the known ones (kcal ≈ 4×protein + 4×carbs + 9×fat).
For a single ingredient use standard nutrition database values (e.g. USDA FoodData Central, McCance and Widdowson's / CoFID, or the brand's label if a brand is named); say raw or cooked.
For a whole meal with a recipe, add up the ingredients and divide by the portions or weight the recipe gives; list each ingredient's contribution in "basis".
For a meal per 100 g, work out the total cooked weight. If you have to guess a portion size, say so in "basis".

Reply with only this JSON object:
{"k": kcal, "p": protein g, "c": carbs g, "f": fat g,
 "source": "one line naming the database / label / method, e.g. 'USDA FoodData Central – Chicken breast, raw, skinless (SR Legacy)'",
 "basis": ["short lines showing how you got the numbers"],
 "url": "https:// link to the database entry or label page if you are confident it exists, else empty",
 "confidence": "high" | "medium" | "low",
 "yield": cooked weight as a % of raw weight (e.g. 75 for chicken breast, 280 for white rice), only if the food is weighed raw or cooked}
Give numbers for all four values; only the missing ones are used.`;

function fillRequest(b) {
  if (!isObj(b)) throw fail('Food must be an object');
  const name = name_(b), unit = unitOf(b), kind = KINDS.includes(b.kind) ? b.kind : 'ingredient', hi = limits(unit);
  const state = unit === 'g' && ['raw', 'cooked'].includes(b.state) ? b.state : '';
  const known = {}, blank = [];
  for (const m of MACROS) {
    const v = b[m];
    if (v === '' || v == null) { blank.push(m); continue; }
    const n = +v;
    if (!Number.isFinite(n) || n < 0 || n > hi[m]) throw fail(`${LABEL[m]} must be a number from 0 to ${hi[m]}`);
    known[m] = n;
  }
  if (!blank.length) throw fail('Every value is filled in – clear the ones you want AI to estimate');
  const recipe = String(b.recipe == null ? '' : b.recipe).slice(0, 4000);
  return { name, unit, kind, recipe, known, blank, hi, state };
}

async function fill(b) {
  const r = fillRequest(b);
  const per = r.unit === 'each' ? 'one item / portion' : `100 ${r.unit}`;
  const text = [`Food: ${r.name}`, `Type: ${r.kind === 'meal' ? 'whole meal' : 'single ingredient'}`, `Values are per: ${per}${r.state ? ` – weighed ${r.state === 'raw' ? 'raw (dry for rice, pasta, grains)' : 'cooked'}` : ''}`,
    r.recipe ? `${r.kind === 'meal' ? 'Recipe' : 'Notes'}:\n${r.recipe}` : '',
    `Known values: ${Object.keys(r.known).length ? Object.entries(r.known).map(([m, v]) => `${LABEL[m]} ${v}${m === 'k' ? ' kcal' : ' g'}`).join(', ') : 'none'}`,
    `Missing: ${r.blank.map(m => LABEL[m]).join(', ')}`].filter(Boolean).join('\n');
  const { reply, model } = await ai.askText(PROMPT, text, { task: 'food' });
  const values = {};
  for (const m of r.blank) {
    const n = Number(reply[m]);
    if (!Number.isFinite(n) || n < 0 || n > r.hi[m]) throw fail('The AI didn’t give a usable number – add more detail (brand, raw or cooked, recipe) and try again', 502);
    values[m] = Math.round(n * 10) / 10;
  }
  const y = Number(reply.yield);
  return { values, ai: cleanAi({ ...reply, fields: r.blank, model }), ...(r.state && y >= 10 && y <= 1000 ? { yield: Math.round(y) } : {}) };
}

/* The OpenRouter key is the admin's, so each account gets a limited number of estimates an hour. */
const fillLimit = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => 'u' + req.user.id,
  message: { error: 'That’s a lot of AI estimates – wait a while and try again.' },
});

const router = express.Router();
const send = (res, e) => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); };

router.get('/', (req, res) => res.json({ foods: q.list.all(req.user.id).map(r => view(r, req.user)), ai: ai.status().configured }));

/* Estimate the blank values of a food that is being entered. Nothing is saved here. */
router.post('/ai-fill', fillLimit, async (req, res) => {
  try { res.json(await fill(req.body)); } catch (e) { send(res, e); }
});

router.post('/', (req, res) => {
  try {
    const d = clean(req.body);
    if (q.count.get(req.user.id).n >= MAX_FOODS) throw fail(`Your library is full (${MAX_FOODS} foods)`);
    const { lastInsertRowid } = q.add.run(req.user.id, d.name, d.unit, d.kind, d.k, d.p, d.c, d.f, d.recipe, d.public, d.ai && JSON.stringify(d.ai), d.state, d.yield, d.free);
    res.json(view(q.get.get(Number(lastInsertRowid)), req.user));
  } catch (e) { send(res, e); }
});

router.put('/:id', (req, res) => {
  try {
    const row = q.get.get(idOf(req.params.id));
    if (!row || (row.user_id !== req.user.id && !row.public)) throw fail('No such food', 404);
    if (row.user_id !== req.user.id) throw fail('Only the person who added this food can change it', 403);
    const d = clean(req.body);
    q.put.run(d.name, d.unit, d.kind, d.k, d.p, d.c, d.f, d.recipe, d.public, d.ai && JSON.stringify(d.ai), d.state, d.yield, d.free, row.id, req.user.id);
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

const exportFor = user => q.mine.all(user.id).map(r => ({ ...r, public: !!r.public, ai: aiOf(r) }));

module.exports = { router, exportFor, clean };

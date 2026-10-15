'use strict';
/* App-wide defaults the admin sets: food values, which weekdays are training/rest, day targets
   and an uploaded meal plan. Stored as one JSON document and layered over engine.js in the browser. */
const config = require('./config');
const db = require('./db');
const { FOODS } = require('../public/engine.js');

const q = {
  get: db.prepare("SELECT data, updated_by, updated_at FROM app_config WHERE key = 'defaults'"),
  put: db.prepare(`INSERT INTO app_config (key, data, updated_by) VALUES ('defaults', ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = datetime('now')`),
  firstUser: db.prepare('SELECT MIN(id) AS id FROM users'),
};

/* ADMIN_EMAILS decides; without it the first account created is the admin. */
function isAdmin(user) {
  if (!user) return false;
  if (config.adminEmails.length) return config.adminEmails.includes(String(user.email).toLowerCase());
  return q.firstUser.get().id === user.id;
}

const TYPES = ['T', 'R', 'S'];
const FOOD_ID = /^[a-z][a-z0-9_]{0,31}$/;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/* Throws a readable message on anything that would break the calculator. */
function clean(input) {
  if (!isObj(input)) throw new Error('Defaults must be an object');
  const num = (v, lo, hi, what) => {
    const n = +v;
    if (v === '' || v == null || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`${what} must be a number from ${lo} to ${hi}`);
    return Math.round(n * 100) / 100;
  };
  const opt = (v, lo, hi, what) => (v === '' || v == null ? null : num(v, lo, hi, what));
  const text = (v, max, what, required) => {
    const s = String(v == null ? '' : v).trim().slice(0, max);
    if (required && !s) throw new Error(`${what} is missing`);
    return s;
  };
  const out = { foods: {}, schedule: null, targets: {}, plan: null };

  const foods = input.foods == null ? {} : input.foods;
  if (!isObj(foods)) throw new Error('Foods must be an object');
  if (Object.keys(foods).length > 300) throw new Error('Too many foods');
  for (const [id, r] of Object.entries(foods)) {
    if (!FOOD_ID.test(id)) throw new Error(`Food id "${String(id).slice(0, 40)}" must be lowercase letters, digits or _`);
    if (!isObj(r)) throw new Error(`Food ${id} must be an object`);
    const w = `Food "${id}"`;
    out.foods[id] = {
      n: text(r.n, 80, `${w} name`, true),
      k: num(r.k, 0, 1000, `${w} kcal`), p: num(r.p, 0, 100, `${w} protein`), c: num(r.c, 0, 100, `${w} carbs`),
      f: num(r.f, 0, 100, `${w} fat`), d: num(r.d == null ? 0 : r.d, 0, 100, `${w} direct protein`),
      step: num(r.step, 1, 500, `${w} step`),
      unit: r.unit === 'ml' ? 'ml' : 'g',
      min: opt(r.min, 0, 5000, `${w} min`), max: opt(r.max, 1, 5000, `${w} max`), order: opt(r.order, 1, 10000, `${w} order`),
      group: ['p', 'c', 'x'].includes(r.group) ? r.group : '',
    };
  }
  const known = id => Object.prototype.hasOwnProperty.call(FOODS, id) || Object.prototype.hasOwnProperty.call(out.foods, id);

  if (input.schedule != null) {
    if (!Array.isArray(input.schedule) || input.schedule.length !== 7 || !input.schedule.every(t => TYPES.includes(t))) {
      throw new Error('The week needs 7 days, each T (training), R (rest) or S (Saturday training)');
    }
    out.schedule = [...input.schedule];
  }

  const targets = input.targets == null ? {} : input.targets;
  if (!isObj(targets)) throw new Error('Targets must be an object');
  for (const t of TYPES) {
    if (targets[t] == null) continue;
    if (!isObj(targets[t])) throw new Error(`Targets for ${t} must be an object`);
    out.targets[t] = {};
    for (const m of ['k', 'p', 'c', 'f']) out.targets[t][m] = num(targets[t][m], 0, 10000, `${t} target ${m}`);
  }

  if (input.plan != null) {
    if (!isObj(input.plan)) throw new Error('Plan must be an object');
    out.plan = {};
    for (const t of TYPES) {
      const meals = input.plan[t];
      if (meals == null) continue;
      if (!Array.isArray(meals) || !meals.length || meals.length > 12) throw new Error(`Plan for ${t} needs 1 to 12 meals`);
      out.plan[t] = meals.map((m, mi) => {
        if (!isObj(m)) throw new Error(`Plan ${t} meal ${mi + 1} must be an object`);
        const w = `Plan ${t} meal ${mi + 1}`;
        const meal = { id: text(m.id == null ? mi + 1 : m.id, 8, `${w} number`, true), name: text(m.name, 100, `${w} name`, true) };
        const note = text(m.note, 200);
        if (note) meal.note = note;
        for (const b of ['p', 'c', 'x']) {
          const items = m[b] == null ? [] : m[b];
          if (!Array.isArray(items) || items.length > 20) throw new Error(`${w} has too many items`);
          meal[b] = items.map(i => {
            if (!isObj(i) || !known(i.f)) throw new Error(`${w}: unknown food "${String(isObj(i) ? i.f : i).slice(0, 40)}"`);
            return { f: i.f, g: num(i.g, 0, 5000, `${w} amount`), lock: !!i.lock };
          });
        }
        return meal;
      });
    }
    if (!Object.keys(out.plan).length) out.plan = null;
  }
  return out;
}

function get() {
  const row = q.get.get();
  if (!row) return { foods: {}, schedule: null, targets: {}, plan: null };
  return { ...JSON.parse(row.data), updatedBy: row.updated_by, updatedAt: row.updated_at };
}
function put(input, user) {
  const data = clean(input);
  q.put.run(JSON.stringify(data), user.email);
  return get();
}

module.exports = { isAdmin, clean, get, put };

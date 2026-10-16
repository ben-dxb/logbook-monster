'use strict';
/* App-wide defaults the admin sets: food values, which weekdays are training/rest, day targets
   and an uploaded meal plan. Layered over engine.js in the browser.
   Each save is a version that takes effect from a date (from: 'YYYY-MM-DD'; null = from the start),
   so days before a change keep the plan they had. Stored as one JSON document: {versions:[…]}. */
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
    if (!FOOD_ID.test(id) || id in Object.prototype) throw new Error(`Food id "${String(id).slice(0, 40)}" must be lowercase letters, digits or _`);
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

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isDate = v => typeof v === 'string' && DATE_RE.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'));
const MAX_VERSIONS = 100;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/* every version, oldest first; a document from before versions is one version from the start */
function versions() {
  const row = q.get.get();
  if (!row) return [];
  const doc = JSON.parse(row.data);
  if (!Array.isArray(doc.versions)) return [{ from: null, ...doc, updatedBy: row.updated_by, updatedAt: row.updated_at }];
  return doc.versions;
}
function store(list, user) {
  list.sort((a, b) => (a.from || '').localeCompare(b.from || ''));
  q.put.run(JSON.stringify({ versions: list }), user.email);
}
/* the version in effect on a date (today by default), or the built-in values */
function on(list, date) {
  let v = null;
  for (const x of list) if (!x.from || x.from <= date) v = x;
  return v;
}
const EMPTY = { from: null, foods: {}, schedule: null, targets: {}, plan: null };
/* The defaults in effect today, plus every version for the browser to pick per day. */
function get() {
  const list = versions();
  return { ...(on(list, today()) || EMPTY), versions: list };
}
/* The newest defaults, whatever their date (food ids the AI may use). */
function latest() {
  const list = versions();
  return list.length ? list[list.length - 1] : EMPTY;
}
/* With a from date (or null for "from the start") this saves the version taking effect then,
   replacing one with the same date; versions dated later still apply from their dates.
   Without one it replaces everything, as before versions existed. */
function put(input, user) {
  const data = clean(input);
  const has = isObj(input) && Object.prototype.hasOwnProperty.call(input, 'from');
  const from = has && input.from != null && input.from !== '' ? input.from : null;
  if (from !== null && !isDate(from)) throw new Error('The date it takes effect from must be a date');
  const v = { from, ...data, updatedBy: user.email, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) };
  const list = has ? versions().filter(x => x.from !== from) : [];
  if (list.length >= MAX_VERSIONS) throw new Error('Too many plan changes – delete some old ones first');
  list.push(v);
  store(list, user);
  return get();
}
/* Delete the version taking effect on a date ('start' for the first one): the one before it applies again. */
function remove(from, user) {
  const key = from === 'start' ? null : from;
  if (key !== null && !isDate(key)) throw new Error('Bad date');
  const list = versions();
  const rest = list.filter(x => x.from !== key);
  if (rest.length === list.length) throw Object.assign(new Error('There is no change from that date'), { status: 404 });
  store(rest, user);
  return get();
}

module.exports = { isAdmin, clean, get, latest, put, remove };

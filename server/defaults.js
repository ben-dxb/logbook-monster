'use strict';
/* App-wide defaults the super admin sets: food values, which weekdays are training/rest, day targets
   and an uploaded meal plan. Stored as one JSON document and layered over engine.js in the browser.
   Each account can keep its own version of any of these (user_defaults), layered over the app's.
   An account's own plan changes each take effect from a date (from: 'YYYY-MM-DD', null = from the start),
   so days before a change keep the plan they had: user_defaults holds {versions:[…]}, oldest first. */
const config = require('./config');
const db = require('./db');
const { FOODS, layerDefaults } = require('../public/engine.js');

const q = {
  get: db.prepare("SELECT data, updated_by, updated_at FROM app_config WHERE key = 'defaults'"),
  put: db.prepare(`INSERT INTO app_config (key, data, updated_by) VALUES ('defaults', ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = datetime('now')`),
  firstUser: db.prepare('SELECT MIN(id) AS id FROM users'),
  mine: db.prepare('SELECT data, updated_at FROM user_defaults WHERE user_id = ?'),
  putMine: db.prepare(`INSERT INTO user_defaults (user_id, data) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`),
  delMine: db.prepare('DELETE FROM user_defaults WHERE user_id = ?'),
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

/* Throws a readable message on anything that would break the calculator.
   baseFoods: foods from a lower layer (the app's) that a plan may also use. */
function clean(input, baseFoods = {}) {
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
  const has = (o, id) => Object.prototype.hasOwnProperty.call(o, id);
  const known = id => has(FOODS, id) || has(baseFoods, id) || has(out.foods, id);

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
  return forUser(user);
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isDate = v => typeof v === 'string' && DATE_RE.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'));
const MAX_VERSIONS = 100;
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isEmpty = d => !Object.keys(d.foods || {}).length && !d.schedule && !Object.keys(d.targets || {}).length && !d.plan;

/* The account's own plan changes, oldest first. A layer saved before versions is one version from the start. */
function myVersions(user) {
  const row = q.mine.get(user.id);
  if (!row) return [];
  const doc = JSON.parse(row.data);
  if (!Array.isArray(doc.versions)) return [{ from: null, ...doc, updatedAt: row.updated_at }];
  return doc.versions;
}
/* the version in effect on a date */
function versionOn(list, date) {
  let v = null;
  for (const x of list) if (!x.from || x.from <= date) v = x;
  return v;
}
/* The account's own layer in effect on a date (today by default), or null when it uses the app defaults as they are. */
function mine(user, date = ymd(new Date())) {
  const v = versionOn(myVersions(user), date);
  return v && !isEmpty(v) ? v : null;
}
function storeMine(user, list) {
  list.sort((a, b) => (a.from || '').localeCompare(b.from || ''));
  if (list.every(isEmpty)) q.delMine.run(user.id);
  else q.putMine.run(user.id, JSON.stringify({ versions: list }));
}
/* With a from date (null = from the start) this saves the change taking effect then, replacing one with the
   same date; changes dated later still apply from their dates. An empty change means "the app defaults from
   then on". Without a date it replaces everything, as before versions existed. */
function putMine(input, user) {
  const data = clean(input, get().foods || {});
  const has = isObj(input) && Object.prototype.hasOwnProperty.call(input, 'from');
  const from = has && input.from != null && input.from !== '' ? input.from : null;
  if (from !== null && !isDate(from)) throw new Error('The date it takes effect from must be a date');
  const list = has ? myVersions(user).filter(x => x.from !== from) : [];
  if (list.length >= MAX_VERSIONS) throw new Error('Too many plan changes – delete some old ones first');
  list.push({ from, ...data, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) });
  storeMine(user, list);
  return forUser(user);
}
/* Without a date: back to the app defaults for every day. With one ('start' for the first): delete that change,
   so the one before it applies again. */
function delMine(user, from) {
  if (from === undefined) { q.delMine.run(user.id); return forUser(user); }
  const key = from === 'start' ? null : from;
  if (key !== null && !isDate(key)) throw new Error('Bad date');
  const list = myVersions(user);
  const rest = list.filter(x => x.from !== key);
  if (rest.length === list.length) throw Object.assign(new Error('There is no plan change from that date'), { status: 404 });
  storeMine(user, rest);
  return forUser(user);
}
/* What the browser gets: the app defaults, the account's own layer in effect today, and all its dated changes. */
function forUser(user) { return { ...get(), mine: mine(user), myVersions: myVersions(user) }; }
/* What the account's days start from on a date (today by default). */
function effective(user, date) { return layerDefaults(get(), mine(user, date)); }

module.exports = { isAdmin, clean, get, put, mine, myVersions, putMine, delMine, forUser, effective };

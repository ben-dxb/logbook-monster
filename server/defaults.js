'use strict';
/* Each account's own meal plan: its foods, day templates (named day types, each with its meals and targets),
   which template each weekday uses, and whether sauces / green veg count. There are no app-wide defaults – a new
   account starts with no plan and makes one (upload, AI read or by hand) on its Account admin page.
   A plan is kept as dated changes (from: 'YYYY-MM-DD', null = from the start), so days before a change keep the
   plan they had: user_defaults holds {versions:[…]}, oldest first. */
const config = require('./config');
const db = require('./db');
const { isDate, writeError } = require('./dates');
const { isNum } = require('./num');
const { FREE_KINDS } = require('../public/engine.js');
const legacy = require('./legacy');
const { stamp } = require('./version');

const q = {
  appGet: db.prepare("SELECT data FROM app_config WHERE key = 'defaults'"),
  appDel: db.prepare("DELETE FROM app_config WHERE key = 'defaults'"),
  flag: db.prepare("SELECT 1 AS x FROM app_config WHERE key = 'plans_own'"),
  setFlag: db.prepare("INSERT OR IGNORE INTO app_config (key, data) VALUES ('plans_own', '{}')"),
  users: db.prepare('SELECT id, (SELECT COUNT(*) FROM days WHERE days.user_id = users.id) AS days FROM users'),
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

const TEMPLATE_ID = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
const MAX_TEMPLATES = 12;
const LEGACY_NAMES = { T: 'Training', R: 'Rest', S: 'Saturday training' };
const FOOD_ID = /^[a-z][a-z0-9_]{0,31}$/;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/* Throws a readable message on anything that would break the calculator. */
function clean(input) {
  if (!isObj(input)) throw new Error('Defaults must be an object');
  const num = (v, lo, hi, what) => {
    const n = +v;
    if (!isNum(v) || n < lo || n > hi) throw new Error(`${what} must be a number from ${lo} to ${hi}`);
    return Math.round(n * 100) / 100;
  };
  const opt = (v, lo, hi, what) => (v === '' || v == null ? null : num(v, lo, hi, what));
  const text = (v, max, what, required) => {
    const s = String(v == null ? '' : v).trim().slice(0, max);
    if (required && !s) throw new Error(`${what} is missing`);
    return s;
  };
  const out = { foods: {}, templates: [], schedule: null, targets: {}, plan: {}, free: {} };

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
      free: FREE_KINDS.includes(r.free) ? r.free : '',
    };
    const o = out.foods[id];
    if (o.min != null && o.max != null && o.min > o.max) throw new Error(`${o.n}: the min serving (${o.min}) is more than the max serving (${o.max})`);
    if (o.d > o.p) throw new Error(`${o.n}: direct protein (${o.d}) is more than its protein (${o.p})`);
  }

  /* day templates: named day types (training, rest, high carb…). Without a list, the old day types T/R/S a file uses. */
  let templates = input.templates;
  if (templates == null) {
    const used = new Set([...(isObj(input.plan) ? Object.keys(input.plan) : []), ...(isObj(input.targets) ? Object.keys(input.targets) : []),
      ...(Array.isArray(input.schedule) ? input.schedule : [])]);
    templates = Object.keys(LEGACY_NAMES).filter(t => used.has(t)).map(id => ({ id, name: LEGACY_NAMES[id] }));
  }
  if (!Array.isArray(templates) || templates.length > MAX_TEMPLATES) throw new Error(`Keep to ${MAX_TEMPLATES} day templates or fewer`);
  for (const t of templates) {
    if (!isObj(t) || typeof t.id !== 'string' || !TEMPLATE_ID.test(t.id) || t.id in Object.prototype) throw new Error('A day template id must be letters, digits or _ (starting with a letter)');
    if (out.templates.some(x => x.id === t.id)) throw new Error(`Day template "${t.id}" is listed twice`);
    out.templates.push({ id: t.id, name: text(t.name, 40, 'A day template name', true) });
  }
  const isTemplate = id => out.templates.some(t => t.id === id);
  const tname = id => (out.templates.find(t => t.id === id) || { name: id }).name;

  if (input.schedule != null) {
    if (!Array.isArray(input.schedule) || input.schedule.length !== 7 || !input.schedule.every(isTemplate)) {
      throw new Error('The week needs 7 days, each one of your day templates');
    }
    out.schedule = [...input.schedule];
  }

  /* free foods: whether sauces / green veg count no macros */
  const free = input.free == null ? {} : input.free;
  if (!isObj(free)) throw new Error('Free foods must be an object');
  for (const x of FREE_KINDS) if (free[x] != null) out.free[x] = !!free[x];

  const targets = input.targets == null ? {} : input.targets;
  if (!isObj(targets)) throw new Error('Targets must be an object');
  for (const [t, v] of Object.entries(targets)) {
    if (!isTemplate(t)) throw new Error(`Targets for "${String(t).slice(0, 20)}", which isn't one of your day templates`);
    if (!isObj(v)) throw new Error(`Targets for ${tname(t)} must be an object`);
    out.targets[t] = {};
    for (const m of ['k', 'p', 'c', 'f']) out.targets[t][m] = num(v[m], 0, 10000, `${tname(t)} target ${m}`);
  }

  const has = (o, id) => Object.prototype.hasOwnProperty.call(o, id);
  const known = id => id === 'pudding' || has(out.foods, id);   /* rice pudding: values from the batch on the Daily Tracker */

  if (input.plan != null) {
    if (!isObj(input.plan)) throw new Error('Plan must be an object');
    for (const [t, meals] of Object.entries(input.plan)) {
      if (meals == null) continue;
      if (!isTemplate(t)) throw new Error(`Meals for "${String(t).slice(0, 20)}", which isn't one of your day templates`);
      if (!Array.isArray(meals) || meals.length > 12) throw new Error(`${tname(t)} can have up to 12 meals`);
      out.plan[t] = meals.map((m, mi) => {
        if (!isObj(m)) throw new Error(`${tname(t)} meal ${mi + 1} must be an object`);
        const w = `${tname(t)} meal ${mi + 1}`;
        const meal = { id: text(m.id == null ? mi + 1 : m.id, 8, `${w} number`, true), name: text(m.name, 100, `${w} name`, true) };
        const note = text(m.note, 200);
        if (note) meal.note = note;
        for (const b of ['p', 'c', 'x']) {
          const items = m[b] == null ? [] : m[b];
          if (!Array.isArray(items) || items.length > 20) throw new Error(`${w} has too many items`);
          meal[b] = items.map(i => {
            if (!isObj(i) || !known(i.f)) throw new Error(`${w}: unknown food "${String(isObj(i) ? i.f : i).slice(0, 40)}" – add it to your foods first`);
            return { f: i.f, g: num(i.g, 0, 5000, `${w} amount`), lock: !!i.lock };
          });
        }
        return meal;
      });
    }
  }
  /* every template has meals (maybe none yet) and targets */
  for (const t of out.templates) {
    if (!out.plan[t.id]) out.plan[t.id] = [];
    if (!out.targets[t.id]) out.targets[t.id] = { k: 0, p: 0, c: 0, f: 0 };
  }
  return out;
}

const MAX_VERSIONS = 100;
/* the whole plan history together: a plan is tens of KB, so this is many versions of a large one */
const MAX_PLAN_BYTES = config.quota.plan;
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/* no plan at all from that date: no foods and no day templates (sauces / green veg ticked as free mean nothing on their own) */
const isEmpty = d => !Object.keys(d.foods || {}).length && !(d.templates || []).length;

/* The account's own plan changes, oldest first. A layer saved before versions is one version from the start. */
const DAMAGED = 'Your saved meal plan couldn’t be read – ask the person who runs this app to look at it';
function myVersions(user) {
  const row = q.mine.get(user.id);
  if (!row) return [];
  let doc;
  try { doc = JSON.parse(row.data); if (!isObj(doc)) throw new Error('not an object'); }
  catch (e) { console.error(`The plan of account ${user.id} couldn’t be read: ${e.message}`); throw Object.assign(new Error(DAMAGED), { status: 500 }); }
  if (!Array.isArray(doc.versions)) return [{ from: null, ...doc, updatedAt: row.updated_at }];
  return doc.versions;
}
/* the version in effect on a date */
function versionOn(list, date) {
  let v = null;
  for (const x of list) if (!x.from || x.from <= date) v = x;
  return v;
}
/* The account's plan in effect on a date (today by default), or null when it has none then. */
function mine(user, date = ymd(new Date())) {
  const v = versionOn(myVersions(user), date);
  return v && !isEmpty(v) ? v : null;
}
function storeMine(user, list, grow) {
  list.sort((a, b) => (a.from || '').localeCompare(b.from || ''));
  if (list.every(isEmpty)) return q.delMine.run(user.id);
  const json = JSON.stringify({ versions: list });
  if (grow && json.length > MAX_PLAN_BYTES) {
    throw Object.assign(new Error(`Your plan history has reached the ${Math.round(MAX_PLAN_BYTES / 1048576)} MB an account can keep – delete some old plan changes first`), { status: 413 });
  }
  q.putMine.run(user.id, json);
}
/* With a from date (null = from the start) this saves the change taking effect then, replacing one with the
   same date; changes dated later still apply from their dates. An empty change means "no plan from then on".
   Without a date it replaces everything. */
function putMine(input, user) {
  const data = clean(input);
  const has = isObj(input) && Object.prototype.hasOwnProperty.call(input, 'from');
  const from = has && input.from != null && input.from !== '' ? input.from : null;
  if (from !== null && writeError(from)) throw new Error(writeError(from, 'The date it takes effect from must be a date'));
  const list = has ? myVersions(user).filter(x => x.from !== from) : [];
  if (list.length >= MAX_VERSIONS) throw new Error('Too many plan changes – delete some old ones first');
  list.push({ from, ...data, updatedAt: stamp() });
  storeMine(user, list, true);
  return forUser(user);
}
/* Without a date: no plan for any day. With one ('start' for the first): delete that change,
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
/* What the browser (and a coach link) gets: every dated change of the plan. The one in effect on a date is the last one from on or
   before it (mineOn in admin.js / coach.js); it isn't sent a second time. */
function forUser(user) { return { myVersions: myVersions(user) }; }
/* What the account's days start from on a date (today by default). */
function effective(user, date) { return mine(user, date) || clean({}); }

/* Once: app defaults used to sit under every account's own changes. Every account that has used the app (saved a
   day or a plan of its own) gets what it was using as its own plan – each dated change folded over the app defaults
   and the built-in plan – so nothing changes for it. Accounts that never used it start with no plan, like new ones. */
/* A part that doesn't pass (a bad food, targets, a template's meals, the week) is left out with a log line – never the whole
   own layer, which would leave the account on the built-in plan alone. Returns undefined when even what's left won't pass. */
function carry(app, v, who) {
  const e = legacy.effective(app, v);
  try { return clean(e); } catch (err) { console.error(`Plan carry-over (${who}): ${err.message} – leaving out what doesn’t pass`); }
  const keep = (what, fn) => { try { fn(); return true; } catch (err) { console.error(`Plan carry-over (${who}): left out ${what}: ${err.message}`); return false; } };
  const foods = {};
  for (const [id, r] of Object.entries(e.foods)) if (keep(`food ${String(id).slice(0, 40)}`, () => clean({ foods: { [id]: r } }))) foods[id] = r;
  const base = { foods, templates: e.templates, free: e.free }, targets = {}, plan = {};
  for (const { id } of e.templates) {
    if (keep(`the ${id} targets`, () => clean({ ...base, targets: { [id]: e.targets[id] } }))) targets[id] = e.targets[id];
    const meals = (e.plan[id] || []).map(m => ({ ...m, ...Object.fromEntries(['p', 'c', 'x'].map(b => [b, (m[b] || []).filter(i => i.f === 'pudding' || Object.hasOwn(foods, i.f))])) }));
    if (keep(`the ${id} meals`, () => clean({ ...base, plan: { [id]: meals } }))) plan[id] = meals;
  }
  const schedule = keep('the week', () => clean({ ...base, schedule: e.schedule })) ? e.schedule : null;
  try { return clean({ ...base, targets, plan, schedule }); } catch (err) { console.error(`Plan carry-over (${who}): skipped: ${err.message}`); }
}
/* a damaged row (not JSON, a version that won't pass) is skipped with a log line and left as it was: it never stops the start */
function migrate() {
  if (q.flag.get()) return;
  const row = q.appGet.get();
  let app = {};
  try { app = row ? JSON.parse(row.data) : {}; } catch (e) { console.error(`Plan carry-over: the old app defaults couldn’t be read (${e.message}) – carried over without them`); }
  db.exec('BEGIN');
  try {
    for (const u of q.users.all()) {
      try {
        const r = q.mine.get(u.id);
        if (!r && !u.days) continue;
        const doc = r ? JSON.parse(r.data) : null;
        const list = !doc ? [{ from: null }] : Array.isArray(doc.versions) ? doc.versions : [{ from: null, ...doc }];
        const versions = [];
        for (const v of list) {
          const who = `account ${u.id}, from ${(v && v.from) || 'the start'}`;
          const data = carry(app, v, who);
          if (!data) { console.error(`Plan carry-over (${who}): this plan change was skipped`); continue; }
          versions.push({ from: (v && v.from) || null, ...data, updatedAt: (v && v.updatedAt) || (r && r.updated_at) || new Date().toISOString().replace('T', ' ').slice(0, 19) });
        }
        if (versions.length) q.putMine.run(u.id, JSON.stringify({ versions }));
        else if (r) console.error(`Plan carry-over: account ${u.id} kept its saved plan as it was – none of it could be carried over`);
      } catch (e) { console.error(`Plan carry-over: account ${u.id} skipped – its saved plan couldn’t be read: ${e.message}`); }
    }
    q.appDel.run();
    q.setFlag.run();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); console.error('Plan carry-over failed – it will run again on the next start:', e); }
}
migrate();

module.exports = { isAdmin, clean, mine, myVersions, putMine, delMine, forUser, effective, migrate };

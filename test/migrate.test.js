'use strict';
/* App defaults are gone: on first start each account that used the app gets what it was using as its own plan. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-migrate-'));
process.env.DB_PATH = path.join(dir, 'm.db');
const db = require('../server/db');
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const OATS = { n: 'Oats', k: 380, p: 13, c: 60, f: 7, d: 0, step: 5, unit: 'g', group: 'c' };
const user = email => Number(db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid);
const logDay = id => db.prepare("INSERT INTO days (user_id, date, data, summary) VALUES (?, '2026-01-05', '{\"meals\":[]}', '{}')").run(id);
const own = (id, doc) => db.prepare('INSERT INTO user_defaults (user_id, data) VALUES (?, ?)').run(id, JSON.stringify(doc));

/* the old world: app defaults set by the super admin, accounts with and without their own changes */
db.prepare("INSERT INTO app_config (key, data, updated_by) VALUES ('defaults', ?, 'boss@example.com')").run(JSON.stringify({
  schedule: ['T', 'T', 'T', 'R', 'R', 'S', 'R'], targets: { T: { k: 3100, p: 240, c: 380, f: 65 } },
  foods: { chicken: { n: 'Chicken (app)', k: 170, p: 31, c: 4, f: 3, d: 31, step: 5, unit: 'g', group: 'p' } }, plan: null, free: { sauce: true } }));
const owner = user('owner@example.com'); logDay(owner);
own(owner, { foods: { oats: OATS }, schedule: null, targets: { R: { k: 2500, p: 220, c: 280, f: 60 } },
  plan: { R: [{ id: '1', name: 'Oat bowl', p: [], c: [{ f: 'oats', g: 80 }], x: [] }] } });         /* saved before dated changes */
const plain = user('plain@example.com'); logDay(plain);                                               /* followed the app defaults */
const invited = user('invited@example.com');                                                          /* never used the app */
const dated = user('dated@example.com');
own(dated, { versions: [{ from: null, foods: {}, schedule: ['R', 'R', 'R', 'R', 'R', 'R', 'R'], targets: {}, plan: null, free: {} },
  { from: '2030-01-07', foods: {}, schedule: null, targets: {}, plan: null, free: {} }] });            /* then back to the app defaults */

/* PR-PL-046: a bad food in an own layer leaves out that food only; a row that isn't JSON is skipped – neither stops the start */
const badFood = user('badfood@example.com'); logDay(badFood);
own(badFood, { foods: { 'BAD ID': { n: 'Bad', k: 1, p: 1, c: 1, f: 1, step: 1 }, oats: OATS }, targets: { T: { k: 2500, p: 200, c: 250, f: 70 } } });
const broken = user('broken@example.com'); logDay(broken);
db.prepare('INSERT INTO user_defaults (user_id, data) VALUES (?, ?)').run(broken, 'not json');
const logged = [], log = console.error;
console.error = (...a) => logged.push(a.join(' '));
const defaults = require('../server/defaults');                                                        /* carries everyone over */
console.error = log;
const versions = id => defaults.myVersions({ id });

test('an own layer is folded over the app defaults and the built-in plan', () => {
  const [v] = versions(owner);
  assert.strictEqual(v.from, null);
  assert.deepStrictEqual(v.templates.map(t => t.name), ['Training', 'Rest', 'Saturday training', 'Saturday – lemon pie']);
  assert.deepStrictEqual(v.schedule, ['T', 'T', 'T', 'R', 'R', 'S', 'R']);       /* the app's week */
  assert.strictEqual(v.targets.T.k, 3100);                                        /* the app's target */
  assert.strictEqual(v.targets.R.k, 2500);                                        /* its own */
  assert.strictEqual(v.plan.R[0].name, 'Oat bowl');                               /* its own plan for rest days */
  assert.strictEqual(v.plan.T[1].name, 'Health Road chicken – BBQ');              /* the built-in one for the rest */
  assert.strictEqual(v.foods.chicken.n, 'Chicken (app)');
  assert.ok(v.foods.oats && v.foods.banana && v.foods.pudding);
  assert.strictEqual(v.free.sauce, true);
});

test('an account that followed the app defaults keeps them as its own; one that never used the app starts with none', () => {
  const [v] = versions(plain);
  assert.strictEqual(v.targets.T.k, 3100);
  assert.strictEqual(v.plan.P[2].name, 'Lemon meringue cream of rice pie');
  assert.deepStrictEqual(versions(invited), []);
  assert.strictEqual(defaults.mine({ id: invited }), null);
});

test('each dated change is carried over on its own; "back to the app defaults" becomes them', () => {
  const vs = versions(dated);
  assert.deepStrictEqual(vs.map(v => v.from), [null, '2030-01-07']);
  assert.deepStrictEqual(vs[0].schedule, ['R', 'R', 'R', 'R', 'R', 'R', 'R']);
  assert.deepStrictEqual(vs[1].schedule, ['T', 'T', 'T', 'R', 'R', 'S', 'R']);
});

test('a bad part of an own layer is left out, not the layer; a damaged row is skipped and kept', () => {
  const [v] = versions(badFood);
  assert.strictEqual(v.targets.T.k, 2500, 'its own targets, not the built-in plan');
  assert.ok(v.foods.oats && v.foods.banana && !v.foods['BAD ID']);
  assert.ok(logged.some(l => /left out food BAD ID/.test(l)), logged.join('\n'));
  assert.strictEqual(db.prepare('SELECT data FROM user_defaults WHERE user_id = ?').get(broken).data, 'not json');
  assert.ok(logged.some(l => new RegExp(`account ${broken} skipped`).test(l)), logged.join('\n'));
  assert.throws(() => versions(broken), e => e.status === 500 && /couldn’t be read/.test(e.message) && !/JSON|token/.test(e.message));
});

test('the app defaults are gone and it only runs once', () => {
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM app_config WHERE key = 'defaults'").get().n, 0);
  db.prepare('DELETE FROM user_defaults WHERE user_id = ?').run(plain);
  defaults.migrate();
  assert.deepStrictEqual(versions(plain), []);
});

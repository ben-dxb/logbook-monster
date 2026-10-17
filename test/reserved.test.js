'use strict';
/* Ids that are also names on Object.prototype ("constructor", "toString"…) are refused or never looked up through the prototype
   (admin-code-009, library-code-010). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-reserved-'));
process.env.DB_PATH = path.join(dir, 'r.db');
const defaults = require('../server/defaults');
const { aiUnit } = require('../server/supps');
const db = require('../server/db');
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const oats = { n: 'Oats', k: 379, p: 13, c: 68, f: 6.5, step: 5, group: 'c' };

test('a plan cannot have a day template called constructor, toString or valueOf', () => {
  for (const id of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
    assert.throws(() => defaults.clean({ foods: { oats }, templates: [{ id, name: 'Day' }], plan: { [id]: [] } }), /day template id/, id);
  }
  assert.throws(() => defaults.clean({ foods: { constructor: oats } }), /Food id/);
  assert.strictEqual(defaults.clean({ foods: { oats }, templates: [{ id: 'T', name: 'Training' }] }).templates[0].id, 'T');
});

test('a supplement unit named after an Object.prototype key is not a unit', () => {
  for (const u of ['constructor', 'toString', '__proto__', 'valueOf']) assert.strictEqual(aiUnit(u), null, u);
  assert.strictEqual(aiUnit('caps'), 'capsules');
  assert.strictEqual(aiUnit('IU'), 'IU');
});

test('the engine reads only a plan\'s own templates (a "constructor" one stored before the check still opens)', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/engine.js'), 'utf8') + ';this.E = { applyDefaults, freshDay, planOf, COACH };', ctx);
  const E = ctx.E;
  E.applyDefaults({ foods: { oats }, templates: [{ id: 'constructor', name: 'Odd' }], schedule: Array(7).fill('constructor'), plan: {}, targets: {} });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(E.planOf('constructor'))), []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(E.COACH.constructor)), { k: 0, p: 0, c: 0, f: 0 });
  const D = E.freshDay(0);
  assert.strictEqual(D.type, 'constructor');
  assert.strictEqual(D.meals.length, 0);
});

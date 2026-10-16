'use strict';
/* An account's own plan over the app defaults, run through engine.js as the browser does. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function engine() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/engine.js'), 'utf8')
    + ';this.E = { applyDefaults, layerDefaults, planData, planFor, TYPE, COACH };', ctx);
  return ctx.E;
}

test('own layer wins where set, the app defaults fill in the rest', () => {
  const E = engine();
  const app = { schedule: ['T', 'T', 'T', 'T', 'T', 'S', 'R'], targets: { T: { k: 3000, p: 250, c: 370, f: 60 } },
    foods: { skyr: { n: 'Skyr', k: 63, p: 11, c: 4, f: 0.2, d: 11, step: 5, unit: 'g', group: 'p' } } };
  const mine = { targets: { R: { k: 2000, p: 180, c: 200, f: 55 } },
    plan: { R: [{ id: '1', name: 'Skyr bowl', p: [{ f: 'skyr', g: 200 }], c: [{ f: 'banana', g: 60 }], x: [] }] } };
  E.applyDefaults(E.layerDefaults(app, mine));
  assert.strictEqual(E.TYPE.join(), app.schedule.join());
  assert.strictEqual(E.COACH.T.k, 3000);
  assert.strictEqual(E.COACH.R.k, 2000);
  assert.strictEqual(E.planFor(6, 'omelette', false)[0].name, 'Skyr bowl');
});

test('an own plan still loads after the super admin deletes an app food it used', () => {
  const E = engine();
  const mine = { plan: { R: [{ id: '1', name: 'Skyr bowl', p: [{ f: 'skyr', g: 200 }], c: [{ f: 'banana', g: 60 }], x: [] }] } };
  E.applyDefaults(E.layerDefaults({ foods: {} }, mine));   /* skyr is gone from the app's foods */
  const meal = E.planFor(6, 'omelette', false)[0];
  assert.strictEqual(meal.name, 'Skyr bowl');
  assert.strictEqual(meal.p.length, 0);
  assert.strictEqual(JSON.stringify(E.planData().R[0].c), JSON.stringify([{ f: 'banana', g: 60, lock: false }]));
});

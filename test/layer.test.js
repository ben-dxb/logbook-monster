'use strict';
/* An account's own plan – day templates, week, targets, foods – run through engine.js as the browser does. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const plan = require('./_plan');

function engine() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/engine.js'), 'utf8')
    + ';this.E = { applyDefaults, planData, planOf, freshDay, warnings, TYPE, COACH, TEMPLATES, FOODS, PROTEIN_SWAPS };', ctx);
  return ctx.E;
}
const skyr = { n: 'Skyr', k: 63, p: 11, c: 4, f: 0.2, d: 11, step: 5, unit: 'g', group: 'p' };
const oats = { n: 'Oats', k: 379, p: 13, c: 68, f: 6.5, d: 0, step: 5, unit: 'g', group: 'c' };

test('no plan: no foods but rice pudding, no templates, a day with no meals and no targets', () => {
  const E = engine();
  E.applyDefaults(null);
  assert.deepStrictEqual(Object.keys(E.FOODS), ['pudding']);
  assert.strictEqual(E.TEMPLATES.length, 0);
  assert.strictEqual(E.TYPE[0], null);
  const D = E.freshDay(0);
  assert.strictEqual(D.meals.length, 0);
  assert.strictEqual(D.type, null);
  assert.deepStrictEqual({ ...D.targets }, { k: 0, p: 0, c: 0, f: 0 });
});

test('day templates: each weekday starts from its own, and a day can start from another one', () => {
  const E = engine();
  E.applyDefaults({
    foods: { skyr, oats },
    templates: [{ id: 'T', name: 'Training' }, { id: 'HC', name: 'High carb' }],
    schedule: ['T', 'T', 'HC', 'T', 'T', 'HC', 'T'],
    targets: { T: { k: 2500, p: 200, c: 250, f: 70 }, HC: { k: 3200, p: 200, c: 450, f: 60 } },
    plan: { T: [{ id: '1', name: 'Skyr bowl', p: [{ f: 'skyr', g: 300 }], c: [{ f: 'oats', g: 60 }], x: [] }],
      HC: [{ id: '1', name: 'Oat bowl', p: [{ f: 'skyr', g: 200 }], c: [{ f: 'oats', g: 150 }], x: [] }] },
  });
  assert.deepStrictEqual([...E.TEMPLATES].map(t => t.name), ['Training', 'High carb']);
  assert.strictEqual(E.TYPE[2], 'HC');
  assert.strictEqual(E.COACH.HC.c, 450);
  const wed = E.freshDay(2);
  assert.strictEqual(wed.type, 'HC');
  assert.strictEqual(wed.meals[0].name, 'Oat bowl');
  assert.strictEqual(wed.targets.k, 3200);
  const mon = E.freshDay(0, 'HC');                     /* Monday switched to the high carb template */
  assert.strictEqual(mon.type, 'HC');
  assert.strictEqual(mon.meals[0].name, 'Oat bowl');
  assert.strictEqual(E.freshDay(0, 'nope').type, 'T'); /* a template that's gone: the weekday's */
  assert.deepStrictEqual([...E.PROTEIN_SWAPS], ['skyr']);
  assert.ok(!E.FOODS.chicken, 'only the plan’s own foods');
});

test('a plan still loads after one of its foods is deleted', () => {
  const E = engine();
  E.applyDefaults({ foods: { oats }, templates: [{ id: 'R', name: 'Rest' }],
    plan: { R: [{ id: '1', name: 'Skyr bowl', p: [{ f: 'skyr', g: 200 }], c: [{ f: 'oats', g: 60 }], x: [] }] } });
  const meal = E.planOf('R')[0];
  assert.strictEqual(meal.p.length, 0);
  assert.strictEqual(JSON.stringify(E.planData().R[0].c), JSON.stringify([{ f: 'oats', g: 60, lock: false }]));
  assert.strictEqual(E.TYPE.join(), 'R,R,R,R,R,R,R');   /* no week: every day uses the first template */
});

test('the old built-in plan, carried over, has its three day types plus the lemon pie Saturday', () => {
  const E = engine();
  E.applyDefaults(plan());
  assert.deepStrictEqual([...E.TEMPLATES].map(t => t.id), ['T', 'R', 'S', 'P']);
  assert.strictEqual(E.TYPE.join(), 'T,T,R,T,R,S,R');
  assert.match(E.planOf('P')[2].name, /Lemon meringue/);
  assert.strictEqual(E.planOf('T')[2].x[0].f, 'biscoff');   /* spreads in the fats box */
  const D = E.freshDay(1);
  assert.strictEqual(D.meals.length, 5);
  assert.ok(Array.isArray(E.warnings(D)));
});

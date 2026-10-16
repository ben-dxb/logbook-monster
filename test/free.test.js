'use strict';
/* Free foods: sauces and green veg count no macros for an account that sets them free, and the balancing leaves them alone. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function engine() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/engine.js'), 'utf8')
    + ';this.E = { applyDefaults, layerDefaults, macOf, dayTotals, solve, it, FOODS, FREE };', ctx);
  return ctx.E;
}
const day = (E, meals, off = []) => ({ auto: true, targets: { k: 2000, p: 150, c: 200, f: 60 }, meals, off });

test('a sauce counts only while sauces are free', () => {
  const E = engine();
  E.applyDefaults({});
  assert.strictEqual(E.FOODS.passata.free, 'sauce');
  assert.ok(E.macOf('passata', 200).k > 60);
  E.applyDefaults({ free: { sauce: true } });
  assert.deepStrictEqual({ ...E.macOf('passata', 200) }, { k: 0, p: 0, c: 0, f: 0, d: 0 });
  assert.ok(E.macOf('potato', 100).k > 0);            /* untagged foods still count */
});

test('the account layer wins over the app default, kind by kind', () => {
  const E = engine();
  const cfg = E.layerDefaults({ free: { sauce: true, veg: true } }, { free: { veg: false } });
  E.applyDefaults(cfg);
  assert.strictEqual(E.FREE.sauce, true);
  assert.strictEqual(E.FREE.veg, false);
});

test('a food can be tagged in the defaults, and free foods are left out of the totals and the balancing', () => {
  const E = engine();
  E.applyDefaults({ free: { veg: true },
    foods: { brocc: { n: 'Broccoli', k: 34, p: 2.8, c: 6.6, f: 0.4, d: 0, step: 5, group: 'c', free: 'veg' } } });
  const veg = E.it('brocc', 150), pot = E.it('potato', 300);
  const D = day(E, [{ id: '1', name: 'x', p: [E.it('chicken', 200, true)], c: [pot, veg], x: [] }],
    [{ n: 'Hot sauce', k: 50, p: 0, c: 10, f: 0, free: 'sauce' }, { n: 'Spinach', k: 23, p: 3, c: 4, f: 0, free: 'veg' }]);
  const t = E.dayTotals(D);
  assert.strictEqual(Math.round(t.k), Math.round(E.macOf('chicken', 200).k + E.macOf('potato', 300).k + 50));
  E.solve(D, new Set());
  assert.strictEqual(veg.g, 150);                      /* the solver never moves a free food */
  assert.notStrictEqual(pot.g, 300);
});

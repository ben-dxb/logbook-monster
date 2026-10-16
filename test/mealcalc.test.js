'use strict';
/* 'Balance inside a meal while editing': the meal's other foods move to keep its calories (public/engine.js). */
const test = require('node:test');
const assert = require('node:assert');
const { balanceMeal, macOf, sum, it } = require('../public/engine.js');

const kcal = m => sum(['p', 'c', 'x'].flatMap(b => m[b]).map(i => macOf(i.f, i.g))).k;
function meal() {
  const m = { id: '1', name: 'Lunch', p: [it('chicken', 150)], c: [it('potato', 300)], x: [it('lurpak', 10)] };
  m._snap = JSON.parse(JSON.stringify({ p: m.p, c: m.c, x: m.x }));
  return m;
}

test('more protein: carbs and fats in the meal give way, calories stay put', () => {
  const m = meal(), before = kcal(m);
  Object.assign(m.p[0], { g: 200, a: 200, ed: true });
  balanceMeal(m);
  assert.strictEqual(m.p[0].g, 200);
  assert.ok(m.c[0].g < 300, `potato ${m.c[0].g}`);
  assert.ok(Math.abs(kcal(m) - before) < 15, `kcal ${kcal(m)} vs ${before}`);
});

test('more fat: what you set stays, locked foods never move', () => {
  const m = meal();
  m.p[0].lock = true;
  Object.assign(m.x[0], { g: 15, a: 15, ed: true });
  balanceMeal(m);
  assert.strictEqual(m.x[0].g, 15);
  assert.strictEqual(m.p[0].g, 150);
  assert.ok(m.c[0].g < 300);
});

test('nothing happens outside an edit', () => {
  const m = meal(); delete m._snap;
  m.p[0].g = 200;
  balanceMeal(m);
  assert.strictEqual(m.c[0].g, 300);
});

'use strict';
/* Starter foods: every entry is complete, and its calories roughly match its macros (catches typos). */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/starter.js'), 'utf8') + ';this.STARTER = STARTER;this.FOOD_GROUPS = FOOD_GROUPS;this.guessGroup = guessGroup;', ctx);
const { STARTER, FOOD_GROUPS, guessGroup } = ctx;

test('starter foods are complete and add up', () => {
  assert.ok(STARTER.length >= 25);
  const ids = new Set();
  for (const f of STARTER) {
    assert.ok(/^[a-z-]+$/.test(f.id) && !ids.has(f.id), `bad or repeated id ${f.id}`); ids.add(f.id);
    assert.ok(f.n && f.g, `${f.id} needs a name and a group`);
    for (const m of ['k', 'p', 'c', 'f']) assert.ok(typeof f[m] === 'number' && f[m] >= 0, `${f.id}.${m}`);
    assert.ok(f.p + f.c + f.f <= 100.5, `${f.id}: more than 100 g of macros per 100 g`);
    /* Atwater: 4 kcal per g protein and carbs, 9 per g fat; fibre in the carbs lets it read a little high */
    const est = 4 * f.p + 4 * f.c + 9 * f.f;
    assert.ok(Math.abs(est - f.k) <= Math.max(25, f.k * 0.15), `${f.id}: ${f.k} kcal but macros give ${Math.round(est)}`);
    assert.ok(['raw', ''].includes(f.s), `${f.id}: s is raw or empty`);
    if (f.s) assert.ok(f.y >= 50 && f.y <= 400, `${f.id}: a raw food needs a cooked yield`);
    else assert.strictEqual(f.y, undefined, `${f.id}: no yield without raw`);
  }
});

/* The library's group filter: starter foods use their own group, other ingredients a guess from the name. */
test('food groups are guessed from names', () => {
  for (const f of STARTER) {
    assert.ok(FOOD_GROUPS.includes(f.g), `${f.id}: unknown group ${f.g}`);
    assert.strictEqual(guessGroup(f.n), f.g, `${f.n} should be guessed as ${f.g}`);
  }
  const want = {
    'Health Road chicken breast': 'Meat and fish', 'Chicken livers (raw)': 'Meat and fish', 'Egg (50g each)': 'Eggs and dairy',
    'Amix whey isolate': 'Eggs and dairy', 'Alpro unsweetened almond': 'Eggs and dairy', 'Cream of rice (dry)': 'Grains and potatoes',
    'Boiled potatoes (Health Road)': 'Grains and potatoes', 'Coco Pops': 'Grains and potatoes', 'Rice pudding (batch)': 'Grains and potatoes',
    'Passata': 'Fruit and veg', 'Tomato paste': 'Fruit and veg', 'Dates': 'Fruit and veg', 'Lurpak Lighter': 'Fats',
    'Strawberry jam': '', 'Biscoff spread': '', 'Turkey mince, 7% fat': 'Meat and fish', 'Mixed nuts': 'Fats', 'Chickpeas': 'Plant protein',
  };
  for (const [n, g] of Object.entries(want)) assert.strictEqual(guessGroup(n), g, n);
});

'use strict';
/* Starter foods: every entry is complete, and its calories roughly match its macros (catches typos). */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/starter.js'), 'utf8') + ';this.STARTER = STARTER;', ctx);
const STARTER = ctx.STARTER;

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

'use strict';
/* Portioning a Health Road pack (meat + sauce) from the meat in your plan (public/engine.js). */
const { test } = require('node:test');
const assert = require('node:assert');
const { packPortion, FOODS } = require('../public/engine.js');

test('pack portion is your share of the meat applied to the whole pack', () => {
  assert.ok(Math.abs(packPortion(230, 320, 250) - 294.4) < 1e-9);   /* 230 of 250g chicken in a 320g pack */
  assert.strictEqual(packPortion(250, 320, 250), 320);
  assert.strictEqual(packPortion(300, 320, 250), 384);     /* more than the pack holds */
});

test('no portion until the pack is weighed', () => {
  assert.strictEqual(packPortion(230, 0, 250), null);
  assert.strictEqual(packPortion(230, NaN, 250), null);
  assert.strictEqual(packPortion(230, 320, 0), null);
  assert.strictEqual(packPortion(0, 320, 250), null);
});

test('delivered meats default to their daily order as the meat in the pack', () => {
  assert.strictEqual(FOODS.chicken.order, 250);
  assert.strictEqual(FOODS.mince.order, 250);
});

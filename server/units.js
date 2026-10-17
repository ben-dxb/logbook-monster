'use strict';
/* Supplement amounts in another unit, for the Timeline's trend lines (no database: tests load it directly). */
/* an amount in another unit: g / mg / mcg between themselves, and vitamin D's IU (40 IU = 1 mcg); null when it can't be */
const MCG = { g: 1e6, mg: 1e3, mcg: 1 };
const isVitD = name => /\bvit(?:amin)?\.?\s*d[23]?\b|calciferol|\bd3\b/i.test(name);
function inUnit(name, amount, from, to) {
  if (from === to) return amount;
  const iu = isVitD(name) ? 40 : 0;
  const mcg = MCG[from] ? amount * MCG[from] : from === 'IU' && iu ? amount / iu : null;
  if (mcg == null) return null;
  return MCG[to] ? mcg / MCG[to] : to === 'IU' && iu ? mcg * iu : null;
}

module.exports = { inUnit, isVitD };

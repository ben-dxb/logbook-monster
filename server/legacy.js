'use strict';
/* The plan the app used to ship with, and the app-wide defaults the super admin used to set. Neither exists any
   more: every account keeps its own meal plan (foods, day templates, week, targets). This file only carries
   accounts over once – whatever an account was using (built-in plan, then the app defaults, then its own
   changes) becomes its own plan, so nobody's days change. See migrate() in defaults.js. */

/* food values per 100g (100ml for almond milk), as the calculator shipped them */
const FOODS = {
  chicken:  { n: 'Health Road chicken breast', k: 171, p: 31, c: 4, f: 3.4, d: 31, step: 5, order: 250 },
  mince:    { n: 'Health Road breast mince', k: 165, p: 31.5, c: 2, f: 3.4, d: 31.5, step: 5, order: 250 },
  livers:   { n: 'Chicken livers (raw)', k: 119, p: 16.9, c: 0.7, f: 4.8, d: 16.9, step: 5, max: 175 },
  rawmince: { n: 'Chicken breast mince (raw)', k: 116, p: 23.3, c: 0, f: 2.5, d: 23.3, step: 5 },
  egg:      { n: 'Egg (50g each)', k: 143, p: 12.6, c: 0.6, f: 9.6, d: 12.6, step: 50 },
  whites:   { n: 'Egg whites', k: 52, p: 10.9, c: 0.7, f: 0.2, d: 10.9, step: 5 },
  cheese:   { n: 'Cathedral City Lighter', k: 310, p: 29.1, c: 0.1, f: 21.5, d: 29.1, step: 5 },
  whey:     { n: 'Amix whey isolate', k: 371, p: 87.1, c: 2, f: 1.1, d: 87.1, step: 1 },
  passata:  { n: 'Passata', k: 31, p: 1.5, c: 6, f: 0.1, d: 0, step: 5, free: 'sauce' },
  paste:    { n: 'Tomato paste', k: 82, p: 4.3, c: 15, f: 0.5, d: 0, step: 5, free: 'sauce' },
  potato:   { n: 'Boiled potatoes (Health Road)', k: 77, p: 1.8, c: 17, f: 0.1, d: 0, step: 5, order: 400 },
  pasta:    { n: 'Pasta (Health Road, cooked)', k: 158, p: 5.8, c: 30.9, f: 0.9, d: 0, step: 5, order: 300 },
  dates:    { n: 'Dates', k: 280, p: 2.5, c: 75, f: 0.4, d: 0, step: 1, max: 45 },
  pudding:  { n: 'Rice pudding (batch)', k: 0, p: 0, c: 0, f: 0, d: 0, step: 5 },
  bakedpot: { n: 'Potato, raw (baked at home)', k: 77, p: 1.8, c: 17, f: 0.1, d: 0, step: 5 },
  sour:     { n: 'Sourdough', k: 270, p: 10.8, c: 51.9, f: 2.4, d: 0, step: 5 },
  cor:      { n: 'Cream of rice (dry)', k: 360, p: 6.5, c: 80, f: 1, d: 0, step: 5 },
  banana:   { n: 'Banana (peeled)', k: 89, p: 1.1, c: 23, f: 0.3, d: 0, step: 5 },
  coco:     { n: 'Coco Pops', k: 386, p: 6.3, c: 84, f: 1.9, d: 0, step: 5 },
  almond:   { n: 'Alpro unsweetened almond', k: 13, p: 0.4, c: 0, f: 1.1, d: 0, step: 10, unit: 'ml' },
  syrup:    { n: 'Date syrup', k: 300, p: 1, c: 74, f: 0.1, d: 0, step: 1 },
  jam:      { n: 'Strawberry jam', k: 242, p: 0.4, c: 60, f: 0.1, d: 0, step: 1 },
  biscoff:  { n: 'Biscoff spread', k: 570, p: 3, c: 57.3, f: 38, d: 0, step: 1 },
  malties:  { n: 'Malties hazelnut spread', k: 523, p: 5.5, c: 59.6, f: 28.5, d: 0, step: 1 },
  digest:   { n: 'Digestive biscuits', k: 478, p: 7.1, c: 62.6, f: 20.9, d: 0, step: 1 },
  lurpak:   { n: 'Lurpak Lighter', k: 516, p: 0.3, c: 0.4, f: 57, d: 0, step: 1, max: 15 },
  avocado:  { n: 'Avocado', k: 160, p: 2, c: 1.8, f: 14.7, d: 0, step: 5, min: 100 },
};
const SWAPS = {
  p: ['chicken', 'mince', 'livers', 'rawmince', 'egg', 'whites', 'cheese', 'whey'],
  c: ['potato', 'pasta', 'dates', 'pudding', 'bakedpot', 'sour', 'cor', 'banana', 'coco', 'syrup', 'jam'],
  x: ['lurpak', 'avocado', 'biscoff', 'malties'],
};
const SCHEDULE = ['T', 'T', 'R', 'T', 'R', 'S', 'R'];
const SAUCE = ['BBQ', 'Piri-piri', 'Curry', 'BBQ', 'Piri-piri', 'Curry', 'BBQ'];
const TARGETS = { T: { k: 2980, p: 250, c: 360, f: 60 }, R: { k: 2740, p: 250, c: 300, f: 60 }, S: { k: 2980, p: 250, c: 360, f: 60 } };
const PIE_TARGETS = { k: 2980, p: 250, c: 360, f: 60 };
const NAMES = { T: 'Training', R: 'Rest', S: 'Saturday training', P: 'Saturday – lemon pie' };

const groupOf = id => Object.keys(SWAPS).find(g => SWAPS[g].includes(id)) || '';
/* a food as an editable record (the shape defaults.clean() keeps) */
function record(id) {
  const F = FOODS[id];
  return { n: F.n, k: F.k, p: F.p, c: F.c, f: F.f, d: F.d, step: F.step, unit: F.unit || 'g',
    min: F.min == null ? null : F.min, max: F.max == null ? null : F.max, order: F.order == null ? null : F.order,
    group: groupOf(id), free: F.free || '' };
}

/* the built-in plan for a day type, as plain data; spreads and fats in their own box */
const it = (f, g, lock = false) => ({ f, g, lock });
function plan(t, pie) {
  const sauce = SAUCE[Math.max(0, SCHEDULE.indexOf(t))];
  const breakfast = lurpak => ({ id: '1', name: 'Breakfast – chicken mince omelette',
    p: [it('rawmince', 150, true), it('egg', 50, true), it('cheese', 30, true)], c: [it('sour', 120, true)], x: lurpak ? [it('lurpak', lurpak)] : [] });
  const hrc = (g, pg) => ({ id: '2', name: 'Health Road chicken – ' + sauce, p: [it('chicken', g)], c: [it('potato', pg)], x: [] });
  const hrm = (g, pg) => ({ id: '4', name: 'Health Road mince', p: [it('mince', g)], c: [it('pasta', pg)], x: [] });
  const cor = () => ({ id: '3', name: 'Cream of rice bowl', p: [], c: [it('cor', 80), it('banana', 100)], x: [it('biscoff', 17)] });
  const m5 = (w = 30) => ({ id: '5', name: 'Coco Pops protein bowl', note: 'Swap the Coco Pops to rice pudding if you like',
    p: [it('whey', w)], c: [it('coco', 70), it('almond', 300)], x: [] });
  if (t === 'T') return [breakfast(15), hrc(230, 300), cor(), hrm(220, 250), m5()];
  if (t === 'S' && pie) {
    return [breakfast(0), hrc(210, 300),
      { id: '3', name: 'Lemon meringue cream of rice pie', note: 'Recipe items are locked', p: [],
        c: [it('digest', 75, true), it('banana', 40, true), it('almond', 20, true), it('cor', 50, true), it('whites', 66, true)], x: [] },
      hrm(180, 250), m5()];
  }
  if (t === 'S') return [breakfast(15), hrc(230, 300), cor(), hrm(200, 250), m5()];
  return [breakfast(15), hrc(185, 200),
    { id: '3', name: 'Chicken livers (cook fresh)', note: 'Livers capped at 175g raw',
      p: [it('livers', 175, true), it('passata', 200, true), it('paste', 25, true)], c: [it('bakedpot', 300)], x: [] },
    hrm(190, 170), m5(25)];
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
/* What an account was using: the built-in plan, the app defaults over it, then its own layer over that – the way
   the browser used to put them together – as one standalone plan with named day templates. */
function effective(app, mine) {
  app = isObj(app) ? app : {}; mine = isObj(mine) ? mine : {};
  const foods = {};
  for (const id of Object.keys(FOODS)) foods[id] = record(id);
  for (const layer of [app, mine]) {
    for (const [id, r] of Object.entries(isObj(layer.foods) ? layer.foods : {})) if (isObj(r)) foods[id] = { ...(foods[id] || {}), ...r };
  }
  const custom = { ...(isObj(app.plan) ? app.plan : {}), ...(isObj(mine.plan) ? mine.plan : {}) };
  const ids = ['T', 'R', 'S'];
  const out = {
    foods,
    templates: ids.map(id => ({ id, name: NAMES[id] })),
    schedule: [...(Array.isArray(mine.schedule) ? mine.schedule : Array.isArray(app.schedule) ? app.schedule : SCHEDULE)],
    targets: {}, plan: {},
    free: { ...(isObj(app.free) ? app.free : {}), ...(isObj(mine.free) ? mine.free : {}) },
  };
  for (const t of ids) {
    out.targets[t] = { ...TARGETS[t], ...((isObj(app.targets) && app.targets[t]) || {}), ...((isObj(mine.targets) && mine.targets[t]) || {}) };
    out.plan[t] = Array.isArray(custom[t]) ? custom[t] : plan(t, false);
  }
  /* the built-in Saturday came with a lemon pie option: it becomes a template of its own */
  if (!Array.isArray(custom.S)) {
    out.templates.push({ id: 'P', name: NAMES.P });
    out.targets.P = { ...PIE_TARGETS };
    out.plan.P = plan('S', true);
  }
  /* a meal can only use foods the plan has */
  for (const t of Object.keys(out.plan)) {
    out.plan[t] = out.plan[t].map(m => ({ ...m, ...Object.fromEntries(['p', 'c', 'x'].map(b =>
      [b, (Array.isArray(m[b]) ? m[b] : []).filter(i => isObj(i) && Object.prototype.hasOwnProperty.call(foods, i.f))])) }));
  }
  return out;
}

module.exports = { effective };

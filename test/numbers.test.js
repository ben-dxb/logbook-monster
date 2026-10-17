'use strict';
/* A typo the browser can't read as a number ("80e", "abc") reaches the server as "" or as the text itself: every route refuses it
   with 400 instead of storing 0 or deleting something. And a regime import line with no amount keeps the usual amount stored. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-numbers-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
const DAY = new Date().toISOString().slice(0, 10);
let srv, ann;

before(async () => {
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'ann@example.com'],
    { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  let cookie = '', csrf = '';
  ann = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j };
  };
  await ann('GET', '/auth/config');
  assert.strictEqual((await ann('POST', '/auth/login', { email: 'ann@example.com', password: 'long-password-1' })).status, 200);
  await ann('GET', '/api/me');
});
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const BAD = ['', '80e', 'abc', null, true, [82], {}];

test('a weight that is not a number is refused and the saved one stays', async () => {
  assert.strictEqual((await ann('PUT', `/api/weights/${DAY}`, { kg: 82.4 })).status, 200);
  for (const kg of BAD) assert.strictEqual((await ann('PUT', `/api/weights/${DAY}`, { kg })).status, 400, JSON.stringify(kg));
  assert.strictEqual((await ann('PUT', `/api/weights/${DAY}`, { kg: '82.1' })).status, 200, 'a numeric string is still a number');
  assert.deepStrictEqual((await ann('GET', '/api/weights')).body, [{ date: DAY, kg: 82.1 }]);
});

test('settings: the pudding batch and snack values must be numbers of 0 or more (finished weight 1 g or more)', async () => {
  const ok = { pud: { rice: 110, almond: 900, oat: 300, custard: 30, casein: 50, weight: 1300 }, snackOv: { reese: { k: 160, p: 1, c: 35, f: 2 } }, pBasis: 'total' };
  assert.strictEqual((await ann('PUT', '/api/settings', ok)).status, 200);
  for (const v of BAD) {
    assert.strictEqual((await ann('PUT', '/api/settings', { ...ok, pud: { ...ok.pud, rice: v } })).status, 400, 'pud ' + JSON.stringify(v));
    assert.strictEqual((await ann('PUT', '/api/settings', { ...ok, snackOv: { reese: { ...ok.snackOv.reese, k: v } } })).status, 400, 'snack ' + JSON.stringify(v));
  }
  assert.strictEqual((await ann('PUT', '/api/settings', { ...ok, pud: { ...ok.pud, weight: 0 } })).status, 400, 'finished weight 0');
  assert.strictEqual((await ann('PUT', '/api/settings', { ...ok, snackOv: { reese: { k: -50 } } })).status, 400, 'negative snack value');
  assert.deepStrictEqual((await ann('GET', '/api/settings')).body, ok);
});

test('a day with a target that is not a number is refused', async () => {
  const day = t => ({ data: { meals: [], off: [], targets: t }, summary: { k: 0, p: 0, c: 0, f: 0, targets: t } });
  assert.strictEqual((await ann('PUT', `/api/days/${DAY}`, day({ k: 2000, p: 180, c: 150, f: 60 }))).status, 200);
  for (const k of BAD) assert.strictEqual((await ann('PUT', `/api/days/${DAY}`, day({ k, p: 180, c: 150, f: 60 }))).status, 400, JSON.stringify(k));
  assert.strictEqual((await ann('GET', `/api/days/${DAY}`)).body.data.targets.k, 2000);
});

test('plan targets, amounts and food values: not numbers → 400', async () => {
  const plan = v => ({ foods: { oats: { n: 'Oats', k: 389, p: 13, c: 66, f: 7, step: 5, group: 'c' } }, templates: [{ id: 'T', name: 'Training' }],
    schedule: Array(7).fill('T'), targets: { T: { k: 'k' in v ? v.k : 2000, p: 180, c: 200, f: 60 } }, plan: { T: [{ id: '1', name: 'Breakfast', p: [], c: [{ f: 'oats', g: 'g' in v ? v.g : 80 }], x: [] }] } });
  assert.strictEqual((await ann('PUT', '/api/my/defaults', plan({}))).status, 200);
  for (const v of BAD) {
    assert.strictEqual((await ann('PUT', '/api/my/defaults', plan({ k: v }))).status, 400, 'target ' + JSON.stringify(v));
    assert.strictEqual((await ann('PUT', '/api/my/defaults', plan({ g: v }))).status, 400, 'grams ' + JSON.stringify(v));
  }
});

test('gym sets: blank or letters for reps or weight are refused, not logged as 0', async () => {
  const ex = (await ann('POST', '/api/gym/exercises', { name: 'Leg press' })).body.id;
  const set = (reps, kg) => ({ exercise: ex, reps, kg, note: '', at: `${DAY}T10:00:00` });
  assert.strictEqual((await ann('POST', '/api/gym/sets', set(10, 100))).status, 200);
  for (const v of BAD) {
    assert.strictEqual((await ann('POST', '/api/gym/sets', set(v, 100))).status, 400, 'reps ' + JSON.stringify(v));
    assert.strictEqual((await ann('POST', '/api/gym/sets', set(10, v))).status, 400, 'kg ' + JSON.stringify(v));
  }
  const r = await ann('POST', '/api/gym/import-sets', { sets: [{ name: 'Leg press', reps: '', kg: 90, note: 'bad reps', at: `${DAY}T11:00:00` }] });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await ann('GET', `/api/gym/sets?exercise=${ex}`)).body.length, 1, 'only the good set is stored');
});

test('foods and supplements: letters are refused', async () => {
  assert.strictEqual((await ann('POST', '/api/foods', { name: 'Bar', unit: 'each', k: '20e', p: 10 })).status, 400);
  assert.strictEqual((await ann('POST', '/api/foods', { name: 'Bar', unit: 'each', k: true, p: 10 })).status, 400);
  assert.strictEqual((await ann('POST', '/api/supps', { name: 'Zinc', amount: '5e', unit: 'mg' })).status, 400);
});

test('a regime import line with no amount keeps the usual amount (and unit) you had', async () => {
  const id = (await ann('POST', '/api/supps', { name: 'PR Zinc', amount: 15, unit: 'mg' })).body.id;
  const r = await ann('POST', '/api/supps/import', { items: [{ name: 'PR Zinc', amount: null, unit: 'g', notes: 'with dinner' }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.updated, 1);
  const z = r.body.supplements.find(s => s.id === id);
  assert.deepStrictEqual([z.amount, z.unit, z.notes], [15, 'mg', 'with dinner']);
  const r2 = await ann('POST', '/api/supps/import', { items: [{ name: 'PR Zinc', amount: 25, unit: 'mg' }] });
  assert.strictEqual(r2.body.supplements.find(s => s.id === id).amount, 25, 'an amount given still replaces it');
});

test('settings: only the keys the app uses are stored, and markup is refused (tracker-code-006)', async () => {
  const ok = { pud: { rice: 100 }, snackOv: { reese: { k: '50' } }, pBasis: 'direct' };
  assert.strictEqual((await ann('PUT', '/api/settings', { ...ok, junk: 1, theme: '<b>x</b>' })).status, 200);
  assert.deepStrictEqual((await ann('GET', '/api/settings')).body, { pud: { rice: 100 }, snackOv: { reese: { k: 50 } }, pBasis: 'direct' });
  for (const bad of [
    { snackOv: { reese: { k: '1"><b id=prsv>PR-PROBE-tracker-006</b>' } } },
    { snackOv: { reese: { n: 5 } } },
    { snackOv: { 'x"><b>': { k: 1 } } },
    { snackOv: { constructor: { k: 1 } } },
    { pud: { evil: 1 } },
    { pBasis: '<b>' },
  ]) assert.strictEqual((await ann('PUT', '/api/settings', bad)).status, 400, JSON.stringify(bad));
});

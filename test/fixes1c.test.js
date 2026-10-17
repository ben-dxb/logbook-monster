'use strict';
/* Phase 1C bugs: supplement trend units, tiny amounts, the remove-account counts, the default checklist,
   broken %-escapes, day-card pose flags, and the gym CSV unit and byte-sized batches. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const GymCsv = require('../public/gymcsv');
const { inUnit } = require('../server/units');

const [PORT, AI_PORT] = require('./_ports').freePorts(2);
/* Stands in for OpenRouter: records what it was asked and answers with a summary. */
const aiSeen = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    aiSeen.push(JSON.parse(body));
    const reply = { headline: 'Calories and weight move together.', insights: [{ title: 'Calories vs weight', text: 'Higher weeks gained.' }, { title: '', text: '' }],
      caveats: ['Only a few weeks of data.'] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: '```json\n' + JSON.stringify(reply) + '\n```' } }] }));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-fixes1c-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'), PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: 'sk-test-key-1234', OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}` };
let srv;

before(async () => {
  await new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r));
  for (const who of ['ann', 'bob', 'admin']) {
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', `${who}@example.com`],
      { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  }
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { srv.kill(); fakeAi.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function signIn(email) {
  let cookie = '', csrf = '';
  const req = async (method, url, body, type) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': raw ? type : 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j };
  };
  await req('GET', '/auth/config');
  assert.strictEqual((await req('POST', '/auth/login', { email, password: 'long-password-1' })).status, 200);
  await req('GET', '/api/me');
  return req;
}

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);

test('units: g/mg/mcg convert, IU only for vitamin D', () => {
  assert.strictEqual(inUnit('Vitamin D3', 25, 'mcg', 'IU'), 1000);
  assert.strictEqual(inUnit('Vitamin D', 2000, 'IU', 'mcg'), 50);
  assert.strictEqual(inUnit('Creatine', 5, 'g', 'mg'), 5000);
  assert.strictEqual(inUnit('Vitamin E', 400, 'IU', 'mg'), null);
  assert.strictEqual(inUnit('Creatine', 2, 'capsules', 'g'), null);
});

test('a supplement trend counts doses logged in another unit (vitamin D mcg on an IU trend)', async () => {
  const ann = await signIn('ann@example.com');
  for (const [date, amount, unit] of [['2026-09-12', 1000, 'IU'], ['2026-09-13', 25, 'mcg'], ['2026-09-14', 1000, 'IU'], ['2026-09-15', 2, 'capsules']]) {
    assert.strictEqual((await ann('POST', '/api/supps/log', { date, name: 'Vitamin D3', amount, unit })).status, 200);
  }
  assert.strictEqual((await ann('PUT', '/api/supps/trend', { name: 'Vitamin D3', on: true })).status, 200);
  const r = await ann('GET', '/api/timeline/trends?from=2026-09-10&to=2026-09-20');
  const s = r.body.series.find(x => x.key === 'sup:vitamin d3');
  assert.strictEqual(s.unit, 'IU');
  assert.deepStrictEqual(s.points, [['2026-09-12', 1000], ['2026-09-13', 1000], ['2026-09-14', 1000]]);
  assert.strictEqual(s.left, 1, 'the capsules dose is counted as left out');
});

test('a supplement amount too small to keep is refused, not stored as 0', async () => {
  const ann = await signIn('ann@example.com');
  const r = await ann('POST', '/api/supps', { name: 'Tiny dose', amount: 0.0004, unit: 'g' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /too small/);
  assert.strictEqual((await ann('POST', '/api/supps', { name: 'Tiny dose', amount: 0.4, unit: 'mg' })).status, 200);
});

test('the account list says how many photos and shared foods or supplements removing an account deletes', async () => {
  const bob = await signIn('bob@example.com'), admin = await signIn('admin@example.com');
  assert.strictEqual((await bob('POST', '/api/foods', { name: 'Bob shared bar', unit: 'g', k: 400, p: 20, c: 50, f: 10, public: true })).status, 200);
  assert.strictEqual((await bob('POST', '/api/supps', { name: 'Bob shared zinc', amount: 15, unit: 'mg', public: true })).status, 200);
  assert.strictEqual((await bob('POST', '/api/photos?date=2026-09-01&pose=front', jpeg, 'image/jpeg')).status, 200);
  const u = (await admin('GET', '/api/admin/users')).body.users.find(x => x.email === 'bob@example.com');
  assert.strictEqual(u.photos, 1);
  assert.strictEqual(u.shared, 2);
});

test('saving the default checklist goes back to following the defaults', async () => {
  const ann = await signIn('ann@example.com');
  const d = (await ann('GET', '/api/checklist')).body;
  const r = await ann('PUT', '/api/checklist', { items: d.items });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.custom, false);
  assert.strictEqual((await ann('GET', '/api/checklist')).body.custom, false);
});

test('a broken %-escape in a route id answers 400, not 500', async () => {
  const ann = await signIn('ann@example.com');
  for (const url of ['/api/days/%E0%A4', '/api/photos/%E0%A4', '/api/foods/%E0%A4']) {
    const r = await ann('GET', url);
    assert.strictEqual(r.status === 400 || r.status === 404, true, `${url} → ${r.status}`);
  }
  assert.strictEqual((await fetch(BASE + '/coach/%E0%A4/api/info')).status < 500, true);
});

test('a day card photo keeps its "set by AI" flag', async () => {
  const ann = await signIn('ann@example.com');
  assert.strictEqual((await ann('POST', '/api/photos?date=2026-09-03&pose=other&ai=1', jpeg, 'image/jpeg')).status, 200);
  const c = (await ann('GET', '/api/timeline/day/2026-09-03')).body;
  assert.strictEqual(c.photos.find(p => p.pose === 'other').poseAi, true);
});

test('gym CSV: an unknown weight unit leaves the row out, stone converts', () => {
  const r = GymCsv.readHistory('Exercise,Date,Reps,Weight,Unit\nSquat,2026-10-01 10:00,5,10,st\nSquat,2026-10-01 10:05,5,10,furlongs\nSquat,2026-10-01 10:10,5,100,kg\n');
  assert.deepStrictEqual(r.sets.map(s => s.kg), [63.5, 100]);
  assert.strictEqual(r.skipped.length, 1);
  assert.match(r.skipped[0].why, /unit/);
});

test('gym CSV import batches are sized in bytes, so non-Latin text stays under the limit', () => {
  const sets = Array.from({ length: 2000 }, (_, i) => ({ name: 'تمرين الضغط', reps: 5, kg: 50, note: 'ملاحظة '.repeat(20), at: `2026-01-01T10:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}` }));
  const enc = new TextEncoder();
  for (const b of GymCsv.importBatches(sets)) assert.ok(enc.encode(JSON.stringify({ sets: b })).length < 300 * 1024, 'every batch fits the 300 kB request limit');
});

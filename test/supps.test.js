'use strict';
/* Supplements: the library (private or shared, like foods) and the daily log, from the library or free text. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-supps-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
let srv;

before(async () => {
  for (const who of ['admin', 'ann', 'bob']) {
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', `${who}@example.com`],
      { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  }
  const db = new DatabaseSync(env.DB_PATH);
  db.prepare("UPDATE users SET name = 'Ann' WHERE email = 'ann@example.com'").run();
  db.close();
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

async function signIn(email) {
  let cookie = '', csrf = '';
  const req = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body ? JSON.stringify(body) : undefined });
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

test('supplement library: private until shared, only the owner changes it, units are checked', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com'), admin = await signIn('admin@example.com');
  let r = await ann('GET', '/api/supps');
  assert.ok(r.body.units.includes('mcg') && r.body.units.includes('IU'));

  const creatine = { name: '  Creatine   monohydrate ', amount: 5, unit: 'g', notes: 'Any time of day', public: false };
  r = await ann('POST', '/api/supps', creatine);
  assert.strictEqual(r.status, 200);
  const id = r.body.id;
  assert.deepStrictEqual({ name: r.body.name, amount: r.body.amount, unit: r.body.unit, mine: r.body.mine },
    { name: 'Creatine monohydrate', amount: 5, unit: 'g', mine: true });

  assert.strictEqual((await ann('POST', '/api/supps', { ...creatine, unit: 'bucket' })).status, 400);
  assert.strictEqual((await ann('POST', '/api/supps', { ...creatine, name: ' ' })).status, 400);
  assert.strictEqual((await ann('POST', '/api/supps', { ...creatine, amount: -1 })).status, 400);
  r = await ann('POST', '/api/supps', { name: 'Vitamin D3', amount: '', unit: 'IU' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.amount, null, 'usual amount is optional');

  assert.strictEqual((await bob('GET', '/api/supps')).body.supplements.length, 0);
  assert.strictEqual((await bob('PUT', `/api/supps/${id}`, creatine)).status, 404);
  assert.strictEqual((await bob('POST', '/api/supps/log', { date: '2026-10-15', supplement: id, amount: 5, unit: 'g' })).status, 404);

  r = await ann('PUT', `/api/supps/${id}`, { ...creatine, public: true });
  assert.strictEqual(r.body.public, true);
  r = await bob('GET', '/api/supps');
  assert.strictEqual(r.body.supplements.length, 1);
  assert.strictEqual(r.body.supplements[0].by, 'Ann');
  assert.ok(!JSON.stringify(r.body).includes('ann@example.com'));
  assert.strictEqual((await bob('PUT', `/api/supps/${id}`, { ...creatine, name: 'Mine' })).status, 403);
  assert.strictEqual((await bob('DELETE', `/api/supps/${id}`)).status, 403);

  /* Bob logs Ann's shared supplement; it keeps its name after an admin removes it from the library */
  r = await bob('POST', '/api/supps/log', { date: '2026-10-15', supplement: id, amount: 3, unit: 'g' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual({ name: r.body.name, sid: r.body.sid, amount: r.body.amount }, { name: 'Creatine monohydrate', sid: id, amount: 3 });
  assert.strictEqual((await admin('DELETE', `/api/supps/${id}`)).status, 200);
  r = await bob('GET', '/api/supps/log?date=2026-10-15');
  assert.strictEqual(r.body.entries.length, 1);
  assert.deepStrictEqual({ name: r.body.entries[0].name, sid: r.body.entries[0].sid }, { name: 'Creatine monohydrate', sid: null });
});

test('supplement log: free text, amounts and units, per day and per account', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com');
  const day = '2026-09-01';
  let r = await ann('POST', '/api/supps/log', { date: day, name: ' Magnesium  glycinate ', amount: 0.25, unit: 'g', note: 'before bed' });
  assert.strictEqual(r.status, 200);
  const e = r.body;
  assert.deepStrictEqual({ name: e.name, amount: e.amount, unit: e.unit, note: e.note, sid: e.sid },
    { name: 'Magnesium glycinate', amount: 0.25, unit: 'g', note: 'before bed', sid: null });
  r = await ann('POST', '/api/supps/log', { date: day, name: 'Vitamin B12', amount: 1000, unit: 'mcg' });
  assert.strictEqual(r.status, 200);

  for (const bad of [{ date: day, amount: 1, unit: 'mg' }, { date: day, name: 'X', amount: 0, unit: 'mg' },
    { date: day, name: 'X', amount: 1, unit: 'spoon' }, { date: '2026-13-01', name: 'X', amount: 1, unit: 'mg' },
    { date: day, name: 'X'.repeat(201), amount: 1, unit: 'mg' }]) {
    assert.strictEqual((await ann('POST', '/api/supps/log', bad)).status, 400, JSON.stringify(bad));
  }

  r = await ann('GET', `/api/supps/log?date=${day}`);
  assert.deepStrictEqual(r.body.entries.map(x => x.name), ['Magnesium glycinate', 'Vitamin B12']);
  assert.strictEqual((await ann('GET', '/api/supps/log?date=nope')).status, 400);
  assert.strictEqual((await ann('GET', '/api/supps/log?from=2026-09-02&to=2026-09-30')).body.entries.length, 0);

  r = await ann('PUT', `/api/supps/log/${e.id}`, { date: '2026-09-02', name: 'Magnesium', amount: 400, unit: 'mg' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual({ date: r.body.date, amount: r.body.amount, unit: r.body.unit }, { date: '2026-09-02', amount: 400, unit: 'mg' });

  /* Bob can't see, change or delete Ann's entries */
  assert.strictEqual((await bob('GET', `/api/supps/log?date=${day}`)).body.entries.length, 0);
  assert.strictEqual((await bob('PUT', `/api/supps/log/${e.id}`, { date: day, name: 'X', amount: 1, unit: 'mg' })).status, 404);
  await bob('DELETE', `/api/supps/log/${e.id}`);
  assert.strictEqual((await ann('GET', '/api/supps/log?date=2026-09-02')).body.entries.length, 1);

  r = await ann('GET', '/api/export');
  assert.ok(r.body.supplements.log.some(x => x.name === 'Vitamin B12'));
  assert.ok(Array.isArray(r.body.supplements.library));

  assert.strictEqual((await ann('DELETE', `/api/supps/log/${e.id}`)).status, 200);
  assert.strictEqual((await ann('GET', '/api/supps/log?date=2026-09-02')).body.entries.length, 0);
});

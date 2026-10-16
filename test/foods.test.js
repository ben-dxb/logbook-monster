'use strict';
/* The food library: your own foods, sharing them with everyone, and who may change or remove them. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-foods-'));
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

test('foods are private until shared, and only the owner can change them', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com'), admin = await signIn('admin@example.com');

  const pancakes = { name: '  Protein   pancakes ', unit: 'each', k: 420, p: 38, c: 45, f: 9, recipe: '60g oats\r\n30g whey\r\n2 eggs', public: false };
  let r = await ann('POST', '/api/foods', pancakes);
  assert.strictEqual(r.status, 200);
  const id = r.body.id;
  assert.deepStrictEqual({ name: r.body.name, unit: r.body.unit, recipe: r.body.recipe, mine: r.body.mine, public: r.body.public },
    { name: 'Protein pancakes', unit: 'each', recipe: '60g oats\n30g whey\n2 eggs', mine: true, public: false });

  /* private: Bob can't see, change or delete it */
  assert.strictEqual((await bob('GET', '/api/foods')).body.foods.length, 0);
  assert.strictEqual((await bob('PUT', `/api/foods/${id}`, pancakes)).status, 404);
  assert.strictEqual((await bob('DELETE', `/api/foods/${id}`)).status, 404);

  /* shared: Bob sees it with Ann's name (never her email) but still can't change it */
  r = await ann('PUT', `/api/foods/${id}`, { ...pancakes, public: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.public, true);
  r = await bob('GET', '/api/foods');
  assert.strictEqual(r.body.foods.length, 1);
  assert.strictEqual(r.body.foods[0].by, 'Ann');
  assert.strictEqual(r.body.foods[0].mine, false);
  assert.ok(!JSON.stringify(r.body).includes('ann@example.com'));
  assert.strictEqual((await bob('PUT', `/api/foods/${id}`, { ...pancakes, name: 'Mine now' })).status, 403);
  assert.strictEqual((await bob('DELETE', `/api/foods/${id}`)).status, 403);

  /* Bob's own private food stays out of Ann's list */
  r = await bob('POST', '/api/foods', { name: 'Overnight oats', unit: 'g', k: 150, p: 8, c: 22, f: 3 });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await ann('GET', '/api/foods')).body.foods.map(f => f.name), ['Protein pancakes']);

  /* it comes with Ann's data download */
  r = await ann('GET', '/api/export');
  assert.strictEqual(r.body.foods.length, 1);
  assert.strictEqual(r.body.foods[0].public, true);

  /* an admin can take a shared food down */
  assert.strictEqual((await admin('DELETE', `/api/foods/${id}`)).status, 200);
  assert.strictEqual((await ann('GET', '/api/foods')).body.foods.length, 0);
});

test('food values are checked', async () => {
  const ann = await signIn('ann@example.com');
  const bad = async (body, re) => { const r = await ann('POST', '/api/foods', body); assert.strictEqual(r.status, 400); assert.match(r.body.error, re); };
  await bad({ name: '', k: 100 }, /name/);
  await bad({ name: 'x'.repeat(81), k: 100 }, /too long/);
  await bad({ name: 'Nothing', k: 0, p: 0, c: 0, f: 0 }, /calories or macros/);
  await bad({ name: 'Too much protein', unit: 'g', k: 400, p: 120 }, /Protein/);
  await bad({ name: 'Negative', k: -5 }, /Calories/);
  await bad({ name: 'Long recipe', k: 100, recipe: 'x'.repeat(4001) }, /Recipe/);
  await bad([], /object/);
  /* a whole portion can have more than 100 g of a macro */
  const r = await ann('POST', '/api/foods', { name: 'Big bowl', unit: 'each', k: 1200, p: 110, c: 150, f: 20, unit2: 'ignored' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.unit, 'each');
  assert.strictEqual((await ann('PUT', '/api/foods/abc', { name: 'x', k: 1 })).status, 404);
});

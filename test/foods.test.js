'use strict';
/* The food library: your own foods, sharing them with everyone, and who may change or remove them. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const http = require('node:http');

const [PORT, AI_PORT] = require('./_ports').freePorts(2);
/* Stands in for OpenRouter: records what it was asked and answers with an estimate (or junk for "Mystery"). */
const aiSeen = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body); aiSeen.push(j);
    const est = /Mystery/.test(j.messages[1].content) ? { k: 'lots' }
      : { k: 165, p: 31, c: 0, f: 3.6, source: 'USDA FoodData Central – Chicken breast, raw', basis: ['100 g raw breast'],
        url: 'javascript:alert(1)', confidence: 'high', fields: ['k', 'p', 'c', 'f'], yield: 74.6 };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: JSON.stringify(est) } }] }));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-foods-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: 'sk-test-key-1234', OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}` };
let srv;

before(async () => {
  await new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r));
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
after(() => { srv.kill(); fakeAi.close(); fs.rmSync(dir, { recursive: true, force: true }); });

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

test('foods are a meal or an ingredient', async () => {
  const bob = await signIn('bob@example.com');
  let r = await bob('POST', '/api/foods', { name: 'Chilli', unit: 'g', k: 120, p: 9, c: 10, f: 4, recipe: '500g mince\n1 tin beans' });
  assert.strictEqual(r.body.kind, 'meal');                                 /* a recipe makes it a meal */
  r = await bob('POST', '/api/foods', { name: 'Cereal bar', unit: 'each', k: 190, p: 3, c: 30, f: 6 });
  assert.strictEqual(r.body.kind, 'meal');                                 /* so does a whole portion */
  r = await bob('POST', '/api/foods', { name: 'Rice (dry)', unit: 'g', k: 360, p: 7, c: 79, f: 1 });
  assert.strictEqual(r.body.kind, 'ingredient');
  r = await bob('PUT', `/api/foods/${r.body.id}`, { ...r.body, kind: 'meal' });
  assert.strictEqual(r.body.kind, 'meal');
  r = await bob('POST', '/api/foods', { name: 'Odd', k: 1, kind: 'snack' });
  assert.strictEqual(r.body.kind, 'ingredient');
});

test('AI fills in only the blank values, and saved foods keep the flag and source', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com');
  assert.strictEqual((await ann('GET', '/api/foods')).body.ai, true);
  let r = await ann('POST', '/api/foods/ai-fill', { name: 'Chicken breast', unit: 'g', kind: 'ingredient', k: '', p: 30, c: '', f: '', recipe: 'raw, skinless' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.values, { k: 165, c: 0, f: 3.6 });         /* protein was given, so it isn't touched */
  assert.deepStrictEqual(r.body.ai.fields, ['k', 'c', 'f']);
  assert.strictEqual(r.body.ai.source, 'USDA FoodData Central – Chicken breast, raw');
  assert.strictEqual(r.body.ai.url, '');                                   /* only https links get through */
  assert.strictEqual(r.body.ai.model, 'test/model');
  const asked = aiSeen.at(-1).messages[1].content;
  assert.match(asked, /Protein 30 g/); assert.match(asked, /Missing: Calories, Carbs, Fat/); assert.match(asked, /raw, skinless/);

  r = await ann('POST', '/api/foods', { name: 'Chicken breast', unit: 'g', kind: 'ingredient', p: 30, ...r.body.values, public: true,
    ai: { ...r.body.ai, fields: ['k', 'c', 'f', 'nope'], url: 'https://fdc.nal.usda.gov/food-details/171077' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.ai.fields, ['k', 'c', 'f']);
  assert.strictEqual(r.body.ai.url, 'https://fdc.nal.usda.gov/food-details/171077');
  const id = r.body.id;
  /* other people see the flag too */
  const seen = (await bob('GET', '/api/foods')).body.foods.find(f => f.id === id);
  assert.deepStrictEqual(seen.ai.fields, ['k', 'c', 'f']);
  /* typing over every estimate drops the flag */
  r = await ann('PUT', `/api/foods/${id}`, { name: 'Chicken breast', unit: 'g', k: 160, p: 30, c: 0, f: 3, ai: { fields: [] } });
  assert.strictEqual(r.body.ai, null);
  assert.strictEqual((await ann('GET', '/api/export')).body.foods.find(f => f.id === id).ai, null);

  /* nothing blank, no name, or an unusable reply */
  r = await ann('POST', '/api/foods/ai-fill', { name: 'Egg', k: 70, p: 6, c: 0, f: 5 });
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /Every value/);
  r = await ann('POST', '/api/foods/ai-fill', { name: ' ', k: '' });
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /name/);
  r = await ann('POST', '/api/foods/ai-fill', { name: 'Mystery stew', kind: 'meal', unit: 'each' });
  assert.strictEqual(r.status, 502); assert.match(r.body.error, /usable number/);
});

test('foods can be weighed raw or cooked, with a cooked yield', async () => {
  const bob = await signIn('bob@example.com');
  let r = await bob('POST', '/api/foods', { name: 'Basmati (dry)', unit: 'g', k: 350, p: 8, c: 78, f: 1, state: 'raw', yield: '280' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.state, r.body.yield], ['raw', 280]);
  r = await bob('PUT', `/api/foods/${r.body.id}`, { ...r.body, state: 'cooked', yield: '' });
  assert.deepStrictEqual([r.body.state, r.body.yield], ['cooked', null]);
  /* only for foods in grams, and the yield has to make sense */
  r = await bob('POST', '/api/foods', { name: 'Shake', unit: 'ml', k: 60, p: 10, c: 3, f: 1, state: 'raw', yield: 50 });
  assert.deepStrictEqual([r.body.state, r.body.yield], ['', null]);
  r = await bob('POST', '/api/foods', { name: 'Odd chicken', unit: 'g', k: 120, p: 22, c: 0, f: 3, state: 'raw', yield: 5000 });
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /Cooked weight/);
  r = await bob('POST', '/api/foods', { name: 'Plain', unit: 'g', k: 100, p: 1, c: 1, f: 1, state: 'boiled' });
  assert.strictEqual(r.body.state, '');
  /* AI is told how the food is weighed and suggests a yield */
  r = await bob('POST', '/api/foods/ai-fill', { name: 'Chicken thigh', unit: 'g', state: 'raw', k: '', p: '', c: '', f: '' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.yield, 75);
  assert.match(aiSeen.at(-1).messages[1].content, /weighed raw/);
  r = await bob('POST', '/api/foods/ai-fill', { name: 'Chicken thigh', unit: 'g', k: '', p: '', c: '', f: '' });
  assert.strictEqual(r.body.yield, undefined);
});

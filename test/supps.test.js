'use strict';
/* Supplements: the library (private or shared, like foods) and the daily log, from the library or free text. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');

const [PORT, AI_PORT] = require('./_ports').freePorts(2);
/* Stands in for OpenRouter: records what it was asked and reads every "regime" into the same line items. */
const aiSeen = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    aiSeen.push(JSON.parse(body));
    const reply = { items: [
      { name: 'Vitamin D3', amount: 5000, unit: 'iu', notes: 'Morning with food' },
      { name: '  Omega-3   fish oil ', amount: 2, unit: 'caps', notes: '1 g EPA+DHA per 2 caps' },
      { name: 'Methyl B12', amount: 1000, unit: 'µg', notes: '' },
      { name: 'Greens powder', amount: null, unit: 'scoop', notes: 'Most days' },
      { name: 'Mystery', amount: 3, unit: 'spoonful' },
      { name: '', amount: 1, unit: 'g' }, 'junk',
    ], notes: ['Guessed the fish oil strength'] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: '```json\n' + JSON.stringify(reply) + '\n```' } }] }));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-supps-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: 'sk-test-key-1234', OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}` };
let srv;

before(async () => {
  await new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r));
  for (const who of ['admin', 'ann', 'bob', 'cara', 'dan']) {
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
    if (Buffer.isBuffer(body)) {   /* a file upload: sent as it is, with its own type */
      const r = await fetch(BASE + url, { method, headers: { cookie, 'content-type': 'application/pdf', 'x-csrf-token': csrf }, body });
      return { status: r.status, body: await r.json().catch(() => null) };
    }
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

test('a supplement regime read with AI: line items to check, then added to the library and logged for a day', async () => {
  const cara = await signIn('cara@example.com'), bob = await signIn('bob@example.com');
  let r = await cara('POST', '/api/supps', { name: 'vitamin d3', amount: 1000, unit: 'IU', notes: 'Old note', public: true });
  const mine = r.body.id;
  assert.strictEqual((await cara('GET', '/api/supps')).body.ai, true);

  r = await cara('POST', '/api/supps/ai-import', Buffer.from('%PDF-1.4 regime'));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const sent = aiSeen.at(-1);
  assert.ok(sent.messages[0].content.includes('- vitamin d3'), 'the model is told the names already in the library');
  assert.strictEqual(sent.messages[1].content[1].type, 'file');
  assert.deepStrictEqual(r.body.items.map(x => [x.name, x.amount, x.unit, !!x.existing]), [
    ['Vitamin D3', 5000, 'IU', true], ['Omega-3 fish oil', 2, 'capsules', false], ['Methyl B12', 1000, 'mcg', false],
    ['Greens powder', null, 'scoops', false], ['Mystery', null, 'mg', false]]);
  assert.ok(r.body.notes.includes('Guessed the fish oil strength'));
  assert.ok(r.body.notes.some(n => /^Mystery: “3 spoonful” isn’t in a unit the app knows – kept in its notes/.test(n)), 'an unknown unit is flagged to set by hand, its amount kept');
  assert.strictEqual(r.body.items.find(x => x.name === 'Mystery').notes, 'Amount: 3 spoonful');
  assert.ok(r.body.notes.includes('1 line with no name was left out.'));
  assert.strictEqual(r.body.model, 'test/model');
  assert.strictEqual((await cara('GET', '/api/supps')).body.supplements.length, 1, 'nothing is saved by reading');

  /* add four of them and log the ones with an amount; the one already in the library is updated, not doubled */
  const items = r.body.items.slice(0, 4);
  assert.strictEqual((await cara('POST', '/api/supps/import', { items, log: 'nope' })).status, 400);
  assert.strictEqual((await cara('POST', '/api/supps/import', { items: [] })).status, 400);
  assert.strictEqual((await cara('POST', '/api/supps/import', { items: [...items, { name: 'X', amount: 1, unit: 'spoon' }] })).status, 400);
  assert.strictEqual((await cara('GET', '/api/supps')).body.supplements.length, 1, 'a bad line adds nothing');
  r = await cara('POST', '/api/supps/import', { items, log: '2026-10-01' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.added, r.body.updated], [3, 1]);
  assert.deepStrictEqual(r.body.entries.map(e => [e.name, e.amount, e.unit]), [['Vitamin D3', 5000, 'IU'], ['Omega-3 fish oil', 2, 'capsules'], ['Methyl B12', 1000, 'mcg']]);
  const lib = r.body.supplements.filter(s => s.mine);
  assert.strictEqual(lib.length, 4);
  const d3 = lib.find(s => s.id === mine);
  assert.deepStrictEqual([d3.name, d3.amount, d3.notes, d3.public], ['Vitamin D3', 5000, 'Morning with food', true], 'keeps it shared');
  assert.ok(lib.filter(s => s.id !== mine).every(s => !s.public), 'new ones are private');
  assert.strictEqual(lib.find(s => s.name === 'Greens powder').amount, null);
  assert.strictEqual((await cara('GET', '/api/supps/log?date=2026-10-01')).body.entries.length, 3);

  /* without a date nothing is logged; Bob's import doesn't touch Cara's library */
  r = await bob('POST', '/api/supps/import', { items: [{ name: 'Vitamin D3', amount: 2000, unit: 'IU' }] });
  assert.deepStrictEqual([r.body.added, r.body.updated, r.body.entries.length], [1, 0, 0]);
  assert.strictEqual((await cara('GET', '/api/supps')).body.supplements.find(s => s.id === mine).amount, 5000);

  assert.strictEqual((await cara('POST', '/api/supps/ai-import', {})).status, 400, 'JSON is not a file');
});

test('supplement import: the same name twice is one line; an amount too big names the maximum', async () => {
  const dan = await signIn('dan@example.com');
  const r = await dan('POST', '/api/supps/import', { items: [{ name: 'Dup Thing', unit: 'g' }, { name: 'dup  thing', amount: 5, unit: 'g', notes: 'later' }], log: '2026-10-01' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.added, r.body.updated, r.body.entries.length], [1, 0, 1]);
  const lib = r.body.supplements.filter(s => s.mine);
  assert.deepStrictEqual(lib.map(s => [s.name, s.amount, s.notes]), [['Dup Thing', 5, 'later']]);
  const big = await dan('POST', '/api/supps', { name: 'Huge', amount: 2e6, unit: 'mg' });
  assert.strictEqual(big.status, 400);
  assert.match(big.body.error, /1,000,000 at most/);
});

test('supplement library: one name per supplement in your own library, whatever the case (PR-FS-042)', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com');
  const first = await ann('POST', '/api/supps', { name: 'Dup Magnesium', amount: 200, unit: 'mg' });
  assert.strictEqual(first.status, 200);
  let r = await ann('POST', '/api/supps', { name: '  dup   MAGNESIUM ', amount: 400, unit: 'mg' });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /already have a supplement called Dup Magnesium/);
  const other = (await ann('POST', '/api/supps', { name: 'Dup Zinc', amount: 15, unit: 'mg' })).body;
  assert.strictEqual((await ann('PUT', '/api/supps/' + other.id, { name: 'DUP magnesium', amount: 15, unit: 'mg' })).status, 409, 'nor renamed onto one');
  assert.strictEqual((await ann('PUT', '/api/supps/' + first.body.id, { name: 'Dup magnesium', amount: 250, unit: 'mg' })).status, 200, 'its own name, new case');
  assert.strictEqual((await bob('POST', '/api/supps', { name: 'Dup Magnesium', amount: 1, unit: 'g' })).status, 200, 'another account has its own');
  const mine = (await ann('GET', '/api/supps')).body.supplements.filter(s => s.mine && /^dup magnesium$/i.test(s.name));
  assert.strictEqual(mine.length, 1);
});

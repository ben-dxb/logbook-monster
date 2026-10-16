'use strict';
/* End-to-end checks of auth, CSRF and the data API against a throwaway server and database. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const http = require('node:http');

const PORT = 3900 + Math.floor(Math.random() * 90);
const AI_PORT = PORT + 100;
/* Stands in for OpenRouter: records the request and replies with a canned plan. */
const aiSeen = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    aiSeen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    if (/workout tracking app/.test(aiSeen.at(-1).body.messages[0].content)) {
      const program = { workouts: [{ name: 'Monday — Upper', description: '18 working sets.', exercises: [{ name: 'HACK SQUAT', target: '1 × 5–8 heavy' }, { name: 'Panatta high row', target: '2 × 8–15' }, { name: '' }] },
        { name: 'Nothing here', exercises: [] }], notes: ['Guessed the row machine'] };
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: JSON.stringify(program) } }] }));
    }
    const plan = { plan: { T: [{ id: '1', name: 'Oats & skyr', p: [{ f: 'skyr_0', g: 250 }, { f: 'dragonfruit', g: 10 }], c: [{ f: 'banana', g: '120' }], x: [] }] },
      foods: { skyr_0: { n: 'Skyr 0%', k: 63, p: 11, c: 4, f: 0.2, d: 11, step: 5, unit: 'g', group: 'p' }, chicken: { n: 'hijack', k: 1, p: 1, c: 1, f: 1, step: 1 } },
      targets: { T: { k: 2900, p: 240, c: 350, f: 65 } }, schedule: ['T', 'R'], notes: ['Estimated the banana'] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: '```json\n' + JSON.stringify(plan) + '\n```' } }] }));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mealswap-test-'));
let srv;

before(async () => {
  await new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'),
      SESSION_SECRET: 'x'.repeat(40), ALLOWED_EMAILS: 'me@example.com,friend@example.com', ADMIN_EMAILS: 'me@example.com', ALLOW_REGISTRATION: 'false',
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '', OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { fakeAi.close(); srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

/* Minimal cookie-keeping client */
function client() {
  let cookie = '', csrf = '';
  const req = async (method, url, body, extra = {}) => {
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf, ...extra },
      body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j, headers: r.headers };
  };
  return { req, setCsrf: v => { csrf = v; }, cookie: () => cookie };
}

test('pages and API need a session', async () => {
  const c = client();
  assert.strictEqual((await c.req('GET', '/')).status, 302);
  assert.strictEqual((await c.req('GET', '/api/me')).status, 401);
  assert.strictEqual((await c.req('GET', '/api/days')).status, 401);
});

test('registration is limited to allowed emails and needs CSRF', async () => {
  const c = client();
  await c.req('GET', '/auth/config');
  c.setCsrf('wrong');
  assert.strictEqual((await c.req('POST', '/auth/register', { email: 'me@example.com', password: 'longenough1' })).status, 403);
  await c.req('GET', '/auth/config');
  assert.strictEqual((await c.req('POST', '/auth/register', { email: 'other@example.com', password: 'longenough1' })).status, 403);
  assert.strictEqual((await c.req('POST', '/auth/register', { email: 'me@example.com', password: 'short' })).status, 400);
  assert.strictEqual((await c.req('POST', '/auth/register', { email: 'me@example.com', password: 'longenough1' })).status, 200);
});

test('login, save a day and a weight, read them back, logout', async () => {
  const c = client();
  await c.req('GET', '/auth/config');
  assert.strictEqual((await c.req('POST', '/auth/login', { email: 'me@example.com', password: 'nope-nope-nope' })).status, 401);
  assert.strictEqual((await c.req('POST', '/auth/login', { email: 'ME@example.com', password: 'longenough1' })).status, 200);
  const me = await c.req('GET', '/api/me');
  assert.strictEqual(me.body.email, 'me@example.com');

  const data = { meals: [{ id: '1', p: [], c: [], x: [] }], targets: { k: 2980 }, off: [] };
  assert.strictEqual((await c.req('PUT', '/api/days/2026-10-15', { data, summary: { k: 2975.33, p: 250, c: 360, f: 60, targets: { k: 2980 }, type: 'T', evil: 1 } })).status, 200);
  assert.strictEqual((await c.req('PUT', '/api/days/2026-13-01', { data, summary: {} })).status, 400);
  assert.strictEqual((await c.req('PUT', '/api/days/2026-10-16', { data: { nope: 1 }, summary: {} })).status, 400);
  const day = await c.req('GET', '/api/days/2026-10-15');
  assert.deepStrictEqual(day.body.data, data);
  const list = await c.req('GET', '/api/days?from=2026-10-01&to=2026-10-31');
  assert.strictEqual(list.body.length, 1);
  assert.strictEqual(list.body[0].k, 2975.3);
  assert.strictEqual(list.body[0].evil, undefined);
  assert.strictEqual((await c.req('GET', '/api/days/2026-10-14')).status, 404);

  assert.strictEqual((await c.req('PUT', '/api/weights/2026-10-15', { kg: 82.4 })).status, 200);
  assert.strictEqual((await c.req('PUT', '/api/weights/2026-10-15', { kg: 5 })).status, 400);
  assert.deepStrictEqual((await c.req('GET', '/api/weights')).body, [{ date: '2026-10-15', kg: 82.4 }]);

  /* another user can't see it */
  const c2 = client();
  await c2.req('GET', '/auth/config');
  assert.strictEqual((await c2.req('GET', '/api/days/2026-10-15')).status, 401);

  assert.strictEqual((await c.req('POST', '/auth/logout', {})).status, 200);
  assert.strictEqual((await c.req('GET', '/api/me')).status, 401);
});

test('only the admin can change the defaults, everyone reads them', async () => {
  const admin = client();
  await admin.req('GET', '/auth/config');
  assert.strictEqual((await admin.req('POST', '/auth/login', { email: 'me@example.com', password: 'longenough1' })).status, 200);
  assert.strictEqual((await admin.req('GET', '/api/me')).body.admin, true);
  assert.deepStrictEqual((await admin.req('GET', '/api/defaults')).body.plan, null);

  const good = {
    schedule: ['T', 'R', 'T', 'R', 'T', 'S', 'R'],
    targets: { T: { k: 3000, p: 250, c: 370, f: 60 } },
    foods: { chicken: { n: 'Chicken', k: 170, p: 31, c: 4, f: 3, d: 31, step: 5, order: 300, group: 'p' },
      skyr: { n: 'Skyr', k: 63, p: 11, c: 4, f: 0.2, d: 11, step: 5, group: 'p' } },
    plan: { R: [{ id: '1', name: 'Skyr bowl', p: [{ f: 'skyr', g: 300, lock: true }], c: [{ f: 'banana', g: 100 }], x: [] }] },
  };
  const saved = await admin.req('PUT', '/api/admin/defaults', good);
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.body.updatedBy, 'me@example.com');
  assert.strictEqual(saved.body.foods.skyr.unit, 'g');
  assert.strictEqual(saved.body.foods.skyr.max, null);
  assert.deepStrictEqual(saved.body.plan.R[0].c, [{ f: 'banana', g: 100, lock: false }]);

  for (const bad of [
    { schedule: ['T', 'R'] },
    { plan: { T: [{ id: '1', name: 'x', p: [{ f: 'unicorn', g: 10 }] }] } },
    { foods: { 'Bad Id': { n: 'x', k: 1, p: 1, c: 1, f: 1, step: 1 } } },
    { foods: { constructor: { n: 'x', k: 1, p: 1, c: 1, f: 1, step: 1 } } },
    { foods: { chicken: { n: 'Chicken', k: -5, p: 31, c: 4, f: 3, step: 5 } } },
    { targets: { T: { k: 'lots', p: 1, c: 1, f: 1 } } },
  ]) assert.strictEqual((await admin.req('PUT', '/api/admin/defaults', bad)).status, 400, JSON.stringify(bad));

  const friend = client();
  await friend.req('GET', '/auth/config');
  assert.strictEqual((await friend.req('POST', '/auth/register', { email: 'friend@example.com', password: 'longenough2' })).status, 200);
  assert.strictEqual((await friend.req('GET', '/api/me')).body.admin, false);
  assert.strictEqual((await friend.req('PUT', '/api/admin/defaults', good)).status, 403);
  const seen = await friend.req('GET', '/api/defaults');
  assert.deepStrictEqual(seen.body.schedule, good.schedule);
  assert.strictEqual(seen.body.plan.R[0].name, 'Skyr bowl');
});

test('AI import: admin-only key that is never shown, and the reply is tidied', async () => {
  const admin = client();
  await admin.req('GET', '/auth/config');
  await admin.req('POST', '/auth/login', { email: 'me@example.com', password: 'longenough1' });
  await admin.req('GET', '/api/me');
  const pdf = async (c, body = '%PDF-1.4 fake') => {
    const r = await c.req('GET', '/api/me');
    return fetch(BASE + '/api/admin/ai-import', { method: 'POST', body,
      headers: { 'content-type': 'application/pdf', 'x-csrf-token': r.body.csrf, cookie: c.cookie() } });
  };
  assert.strictEqual((await admin.req('GET', '/api/admin/ai')).body.configured, false);
  assert.strictEqual((await pdf(admin)).status, 400);
  assert.strictEqual((await admin.req('PUT', '/api/admin/ai', { key: 'short' })).status, 400);
  const st = await admin.req('PUT', '/api/admin/ai', { key: 'sk-or-v1-secret-1234abcd', model: 'test/model' });
  assert.deepStrictEqual([st.status, st.body.configured, st.body.hint, st.body.model], [200, true, '…abcd', 'test/model']);
  assert.ok(!JSON.stringify((await admin.req('GET', '/api/admin/ai')).body).includes('secret'));

  const r = await pdf(admin);
  const j = await r.json();
  assert.strictEqual(r.status, 200, JSON.stringify(j));
  const sent = aiSeen.at(-1);
  assert.strictEqual(sent.auth, 'Bearer sk-or-v1-secret-1234abcd');
  assert.strictEqual(sent.body.model, 'test/model');
  assert.match(sent.body.messages[1].content[1].file.file_data, /^data:application\/pdf;base64,/);
  assert.match(sent.body.messages[0].content, /chicken \| Chicken \| per 100g: 170 kcal[\s\S]*skyr \| Skyr/);   /* the admin's edited and added foods */
  assert.deepStrictEqual(j.plan.T[0].p, [{ f: 'skyr_0', g: 250, lock: false }]);   /* unknown food dropped */
  assert.deepStrictEqual(j.plan.T[0].c, [{ f: 'banana', g: 120, lock: false }]);
  assert.deepStrictEqual(Object.keys(j.foods), ['skyr_0']);                         /* can't overwrite a built-in */
  assert.strictEqual(j.targets.T.k, 2900);
  assert.strictEqual(j.schedule, null);
  assert.ok(j.notes.some(n => /dragonfruit/.test(n)) && j.notes.includes('Estimated the banana'));

  const friend = client();
  await friend.req('GET', '/auth/config');
  await friend.req('POST', '/auth/login', { email: 'friend@example.com', password: 'longenough2' });
  assert.strictEqual((await friend.req('GET', '/api/admin/ai')).status, 403);
  assert.strictEqual((await friend.req('PUT', '/api/admin/ai', { key: 'sk-or-v1-other-key-0000' })).status, 403);
  assert.strictEqual((await pdf(friend)).status, 403);
  assert.strictEqual(aiSeen.length, 1);

  assert.strictEqual((await admin.req('PUT', '/api/admin/ai', { key: '' })).body.configured, false);
});

test('gym: exercises, workouts and sets belong to one account and are checked', async () => {
  const me = client();
  await me.req('GET', '/auth/config');
  await me.req('POST', '/auth/login', { email: 'friend@example.com', password: 'longenough2' });
  await me.req('GET', '/api/me');
  const ex = await me.req('POST', '/api/gym/exercises', { name: '  Hack   squat ' });
  assert.deepStrictEqual([ex.status, ex.body.name], [200, 'Hack squat']);
  assert.strictEqual((await me.req('POST', '/api/gym/exercises', { name: 'hack squat' })).body.id, ex.body.id);   /* same name, same exercise */
  assert.strictEqual((await me.req('POST', '/api/gym/exercises', { name: '' })).status, 400);
  const w = await me.req('POST', '/api/gym/workouts', { name: 'Legs', description: 'Heavy', items: [{ e: ex.body.id, target: '2 × 8–15' }] });
  assert.strictEqual(w.status, 200);
  assert.strictEqual((await me.req('POST', '/api/gym/workouts', { name: 'Bad', items: [{ e: 99999 }] })).status, 400);

  const set = { exercise: ex.body.id, reps: 12, kg: 160, note: 'PR', at: '2026-10-15T17:43:38' };
  const s1 = await me.req('POST', '/api/gym/sets', set);
  assert.deepStrictEqual([s1.status, s1.body.reps, s1.body.kg, s1.body.at], [200, 12, 160, '2026-10-15T17:43:38']);
  assert.strictEqual((await me.req('POST', '/api/gym/sets', { ...set, at: '2026-10-15T18:50' })).body.at, '2026-10-15T18:50:00');
  for (const bad of [{ reps: 1.5 }, { reps: -1 }, { kg: 'heavy' }, { at: '2026-13-01T10:00' }, { at: 'yesterday' }, { exercise: 123456 }])
    assert.strictEqual((await me.req('POST', '/api/gym/sets', { ...set, ...bad })).status, 400, JSON.stringify(bad));
  assert.strictEqual((await me.req('PUT', '/api/gym/sets/' + s1.body.id, { ...set, reps: 10 })).body.reps, 10);
  assert.strictEqual((await me.req('GET', '/api/gym/sets?exercise=' + ex.body.id)).body.length, 2);
  assert.strictEqual((await me.req('GET', '/api/gym/sets?date=2026-10-15')).body.length, 2);
  assert.strictEqual((await me.req('GET', '/api/gym/sets?date=2026-10-16')).body.length, 0);
  const sessions = (await me.req('GET', '/api/gym/sessions')).body;
  assert.deepStrictEqual([sessions[0].date, sessions[0].sets, sessions[0].volume, sessions[0].ex], ['2026-10-15', 2, 3520, [ex.body.id]]);
  const all = (await me.req('GET', '/api/gym')).body;
  assert.deepStrictEqual([all.exercises[0].sets, all.exercises[0].last, all.workouts[0].items], [2, '2026-10-15T18:50:00', [{ e: ex.body.id, target: '2 × 8–15' }]]);

  /* someone else sees none of it and can't touch it */
  const other = client();
  await other.req('GET', '/auth/config');
  await other.req('POST', '/auth/login', { email: 'me@example.com', password: 'longenough1' });
  await other.req('GET', '/api/me');
  assert.deepStrictEqual((await other.req('GET', '/api/gym')).body.exercises.length, 0);
  assert.strictEqual((await other.req('GET', '/api/gym/sets/' + s1.body.id)).status, 404);
  assert.strictEqual((await other.req('PUT', '/api/gym/sets/' + s1.body.id, set)).status, 404);
  assert.strictEqual((await other.req('POST', '/api/gym/sets', set)).status, 400);
  await other.req('DELETE', '/api/gym/sets/' + s1.body.id);
  await other.req('DELETE', '/api/gym/exercises/' + ex.body.id);
  assert.strictEqual((await me.req('GET', '/api/gym/sets?exercise=' + ex.body.id)).body.length, 2);

  /* AI: read a plan (uses the admin's key), check the result, then import it */
  assert.strictEqual((await other.req('PUT', '/api/admin/ai', { key: 'sk-or-v1-secret-1234abcd' })).status, 200);
  const csrf = (await me.req('GET', '/api/me')).body.csrf;
  const r = await fetch(BASE + '/api/gym/ai-import', { method: 'POST', body: Buffer.from([0xff, 0xd8, 0xff]),
    headers: { 'content-type': 'image/jpeg', 'x-csrf-token': csrf, cookie: me.cookie() } });
  const plan = await r.json();
  assert.strictEqual(r.status, 200, JSON.stringify(plan));
  assert.match(aiSeen.at(-1).body.messages[0].content, /Hack squat/);                 /* knows your exercises */
  assert.match(aiSeen.at(-1).body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.strictEqual(plan.workouts.length, 1);                                          /* empty workout dropped */
  assert.deepStrictEqual(plan.workouts[0].exercises, [{ name: 'Hack squat', target: '1 × 5–8 heavy', existing: ex.body.id },
    { name: 'Panatta high row', target: '2 × 8–15', existing: null }]);
  assert.deepStrictEqual(plan.notes, ['Guessed the row machine']);
  const imp = await me.req('POST', '/api/gym/import', { workouts: plan.workouts });
  assert.strictEqual(imp.status, 200);
  assert.deepStrictEqual(imp.body.workouts.map(x => x.name), ['Legs', 'Monday — Upper']);
  assert.deepStrictEqual(imp.body.exercises.map(x => x.name), ['Hack squat', 'Panatta high row']);
  assert.strictEqual(imp.body.workouts[1].items[0].e, ex.body.id);
  assert.strictEqual((await me.req('POST', '/api/gym/import', { workouts: [{ name: 'x'.repeat(81), exercises: [] }] })).status, 400);
  assert.strictEqual((await me.req('GET', '/api/gym')).body.workouts.length, 2);       /* a failed import adds nothing */
  await other.req('PUT', '/api/admin/ai', { key: '' });

  /* deleting an exercise takes its sets and drops it from workouts */
  await me.req('PUT', '/api/gym/order', { ids: [imp.body.workouts[1].id, w.body.id] });
  assert.strictEqual((await me.req('DELETE', '/api/gym/exercises/' + ex.body.id)).status, 200);
  const after = (await me.req('GET', '/api/gym')).body;
  assert.deepStrictEqual(after.workouts.map(x => [x.name, x.items.length]), [['Monday — Upper', 1], ['Legs', 0]]);
  assert.strictEqual((await me.req('GET', '/api/gym/sessions')).body.length, 0);
  assert.ok(Array.isArray((await me.req('GET', '/api/export')).body.gym.sets));
});

test('security headers are set', async () => {
  const r = await fetch(BASE + '/login');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.strictEqual(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.strictEqual(r.headers.get('x-powered-by'), null);
});

test('Google sign-in is refused when not configured', async () => {
  const r = await fetch(BASE + '/auth/google', { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.match(r.headers.get('location'), /error=google_off/);
});

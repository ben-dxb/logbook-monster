'use strict';
/* End-to-end checks of auth, CSRF and the data API against a throwaway server and database. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const http = require('node:http');

const [PORT, AI_PORT, SMTP_PORT] = require('./_ports').freePorts(3);
/* Stands in for OpenRouter: records the request and replies with a canned plan. */
const aiSeen = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    aiSeen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    if (/tag gym exercises with the body parts/.test(aiSeen.at(-1).body.messages[0].content)) {
      /* "<id>: <name>" lines; names with "row" train back + biceps, "mystery" gets nothing, plus an id that wasn't asked about */
      const lines = aiSeen.at(-1).body.messages[1].content.split('\n').map(l => l.split(': '));
      const exercises = lines.map(([id, n]) => ({ id: +id, parts: /row/i.test(n) ? ['back', 'BICEPS', 'nope', 'back'] : /mystery/i.test(n) ? [] : ['quads', 'glutes'] }));
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: JSON.stringify({ exercises: [...exercises, { id: 999999, parts: ['chest'] }] }) } }] }));
    }
    if (/workout tracking app/.test(aiSeen.at(-1).body.messages[0].content)) {
      const program = { workouts: [{ name: 'Monday — Upper', description: '18 working sets.', exercises: [{ name: 'HACK SQUAT', target: '1 × 5–8 heavy', parts: ['chest'] }, { name: 'Panatta high row', target: '2 × 8–15', parts: ['back', 'biceps'] }, { name: '' }] },
        { name: 'Nothing here', exercises: [] }], notes: ['Guessed the row machine'] };
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: JSON.stringify(program) } }] }));
    }
    /* a file saying BAD:<kind> gets back a reply the app can't use */
    const file = aiSeen.at(-1).body.messages[1].content[1];
    const bad = file && file.file && /BAD:(\w+)/.exec(Buffer.from(file.file.file_data.split(',')[1], 'base64').toString());
    if (bad) {
      const choice = { cut: { message: { content: '{"plan": {"T": [{"id": "1", "na' }, finish_reason: 'length' },
        empty: { message: { content: null }, finish_reason: 'stop' },
        noplan: { message: { content: '{"plan": {}, "notes": ["Not a meal plan"]}' }, finish_reason: 'stop' } }[bad[1]];
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ model: 'test/model', choices: [choice] }));
    }
    const plan = { plan: { T: [{ id: '1', name: 'Oats & skyr', p: [{ f: 'skyr_0', g: 250 }, { f: 'dragonfruit', g: 10 }], c: [{ f: 'banana', g: '120' }], x: [] }] },
      foods: { skyr_0: { n: 'Skyr 0%', k: 63, p: 11, c: 4, f: 0.2, d: 11, step: 5, unit: 'g', group: 'p' }, chicken: { n: 'hijack', k: 1, p: 1, c: 1, f: 1, step: 1 } },
      targets: { T: { k: 2900, p: 240, c: 350, f: 65 } }, schedule: ['T', 'R'], notes: ['Estimated the banana'] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: '```json\n' + JSON.stringify(plan) + '\n```' } }] }));
  });
});
/* Stands in for the SMTP server (e.g. Gmail): accepts AUTH PLAIN and keeps each message. */
const net = require('node:net');
const mails = [];
const fakeSmtp = net.createServer(sock => {
  let data = null, msg = {};
  sock.write('220 fake ESMTP\r\n');
  let buf = '';
  sock.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data !== null) {
        if (line === '.') { msg.data = data.join('\n'); mails.push(msg); msg = {}; data = null; sock.write('250 queued\r\n'); }
        else data.push(line.replace(/^\./, ''));
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
      else if (cmd === 'AUTH') { msg.auth = Buffer.from(line.split(' ')[2] || '', 'base64').toString().split('\0'); sock.write(msg.auth[2] === 'apppassword123' ? '235 ok\r\n' : '535 bad credentials\r\n'); }
      else if (cmd === 'MAIL') { msg.from = line; sock.write('250 ok\r\n'); }
      else if (cmd === 'RCPT') { msg.to = line; sock.write('250 ok\r\n'); }
      else if (cmd === 'DATA') { data = []; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); }
      else sock.write('250 ok\r\n');
    }
  });
  sock.on('error', () => {});
});
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-test-'));
let srv;

before(async () => {
  await new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r));
  await new Promise(r => fakeSmtp.listen(SMTP_PORT, '127.0.0.1', r));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'),
      SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: 'me@example.com,friend@example.com', ADMIN_EMAILS: 'me@example.com', ALLOW_REGISTRATION: 'false',
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '', SMTP_HOST: '', SMTP_PASS: '', MAIL_FROM: '', OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { fakeAi.close(); fakeSmtp.close(); srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

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

const SKYR = { n: 'Skyr', k: 63, p: 11, c: 4, f: 0.2, d: 11, step: 5, group: 'p' };
const OATS = { n: 'Oats', k: 380, p: 13, c: 60, f: 7, d: 0, step: 5, group: 'c' };

test('no app defaults: every account starts with no meal plan, and a plan is checked before it is kept', async () => {
  const admin = client();
  await admin.req('GET', '/auth/config');
  assert.strictEqual((await admin.req('POST', '/auth/login', { email: 'me@example.com', password: 'longenough1' })).status, 200);
  assert.strictEqual((await admin.req('GET', '/api/me')).body.admin, true);
  assert.deepStrictEqual((await admin.req('GET', '/api/defaults')).body, { mine: null, myVersions: [] });
  /* the super admin can't set a plan for everyone any more */
  assert.strictEqual((await admin.req('PUT', '/api/admin/defaults', { schedule: null })).status, 404);

  const tpl = [{ id: 'T', name: 'Training' }, { id: 'R', name: 'Rest' }];
  for (const bad of [
    { templates: tpl, schedule: ['T', 'R'] },
    { templates: tpl, schedule: ['T', 'R', 'T', 'R', 'T', 'X', 'R'] },                   /* not one of the templates */
    { templates: tpl, foods: { skyr: SKYR }, plan: { X: [{ id: '1', name: 'x', p: [{ f: 'skyr', g: 10 }] }] } },
    { templates: tpl, plan: { T: [{ id: '1', name: 'x', p: [{ f: 'chicken', g: 10 }] }] } },   /* no built-in foods: it must be one of yours */
    { templates: tpl, targets: { X: { k: 1, p: 1, c: 1, f: 1 } } },
    { templates: [{ id: '1T', name: 'x' }] },
    { templates: [{ id: 'T', name: 'a' }, { id: 'T', name: 'b' }] },
    { templates: [{ id: 'T', name: '' }] },
    { templates: Array.from({ length: 13 }, (_, i) => ({ id: 'D' + i, name: 'd' + i })) },
    { foods: { 'Bad Id': { n: 'x', k: 1, p: 1, c: 1, f: 1, step: 1 } } },
    { foods: { constructor: { n: 'x', k: 1, p: 1, c: 1, f: 1, step: 1 } } },
    { foods: { chicken: { n: 'Chicken', k: -5, p: 31, c: 4, f: 3, step: 5 } } },
    { templates: tpl, targets: { T: { k: 'lots', p: 1, c: 1, f: 1 } } },
  ]) assert.strictEqual((await admin.req('PUT', '/api/my/defaults', bad)).status, 400, JSON.stringify(bad));

  const friend = client();
  await friend.req('GET', '/auth/config');
  assert.strictEqual((await friend.req('POST', '/auth/register', { email: 'friend@example.com', password: 'longenough2' })).status, 200);
  assert.strictEqual((await friend.req('GET', '/api/me')).body.admin, false);
  assert.strictEqual((await friend.req('GET', '/api/defaults')).body.mine, null);
});

test('the super admin can switch the CSV / JSON plan files off for everyone', async () => {
  const admin = client();
  await admin.req('GET', '/auth/config');
  assert.strictEqual((await admin.req('POST', '/auth/login', { email: 'me@example.com', password: 'longenough1' })).status, 200);
  assert.strictEqual((await admin.req('GET', '/api/me')).body.planFiles, true);
  for (const bad of [{ planFiles: 'no' }, { unknown: true }, []])
    assert.strictEqual((await admin.req('PUT', '/api/admin/options', bad)).status, 400, JSON.stringify(bad));
  const friend = client();
  await friend.req('GET', '/auth/config');
  assert.strictEqual((await friend.req('POST', '/auth/login', { email: 'friend@example.com', password: 'longenough2' })).status, 200);
  assert.strictEqual((await friend.req('PUT', '/api/admin/options', { planFiles: false })).status, 403);
  assert.deepStrictEqual((await admin.req('PUT', '/api/admin/options', { planFiles: false })).body, { planFiles: false });
  assert.strictEqual((await friend.req('GET', '/api/me')).body.planFiles, false);
  assert.deepStrictEqual((await admin.req('PUT', '/api/admin/options', { planFiles: true })).body, { planFiles: true });
  assert.strictEqual((await friend.req('GET', '/api/me')).body.planFiles, true);
});

test('account admin: day templates, foods and week of your own, only for yourself', async () => {
  const friend = client();
  await friend.req('GET', '/auth/config');
  assert.strictEqual((await friend.req('POST', '/auth/login', { email: 'friend@example.com', password: 'longenough2' })).status, 200);
  assert.strictEqual((await friend.req('GET', '/api/me')).body.ai, false);
  const mine = {
    templates: [{ id: 'R', name: 'Rest' }, { id: 'HC', name: '  High carb day  ' }],
    schedule: ['R', 'R', 'HC', 'R', 'R', 'R', 'HC'],
    targets: { R: { k: 2000, p: 180, c: 200, f: 55 } },
    foods: { oats: OATS, skyr: SKYR },
    plan: { R: [{ id: '1', name: 'Oat bowl', p: [{ f: 'skyr', g: 200 }], c: [{ f: 'oats', g: 60 }], x: [] }] },
  };
  const saved = await friend.req('PUT', '/api/my/defaults', mine);
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.deepStrictEqual(saved.body.mine.templates, [{ id: 'R', name: 'Rest' }, { id: 'HC', name: 'High carb day' }]);
  assert.deepStrictEqual(saved.body.mine.schedule, mine.schedule);
  assert.strictEqual(saved.body.mine.plan.R[0].name, 'Oat bowl');
  assert.deepStrictEqual(saved.body.mine.plan.HC, []);                              /* a new template: no meals yet */
  assert.deepStrictEqual(saved.body.mine.targets.HC, { k: 0, p: 0, c: 0, f: 0 });
  assert.strictEqual(saved.body.mine.foods.skyr.unit, 'g');
  assert.strictEqual(saved.body.mine.foods.skyr.max, null);
  assert.strictEqual((await friend.req('POST', '/api/my/ai-import', {})).status, 400);   /* no key yet: open to accounts, but nothing to read with */
  assert.deepStrictEqual((await friend.req('GET', '/api/export')).body.defaults.foods.oats.n, 'Oats');
  /* a plan file from before templates (T / R / S keys) still loads, with those names */
  const old = await friend.req('PUT', '/api/my/defaults', { foods: { oats: OATS }, plan: { R: [{ id: '1', name: 'Oats', p: [], c: [{ f: 'oats', g: 80 }], x: [] }] } });
  assert.deepStrictEqual(old.body.mine.templates, [{ id: 'R', name: 'Rest' }]);

  const admin = client();
  await admin.req('GET', '/auth/config');
  await admin.req('POST', '/auth/login', { email: 'me@example.com', password: 'longenough1' });
  await admin.req('GET', '/api/me');
  assert.strictEqual((await admin.req('GET', '/api/defaults')).body.mine, null);   /* someone else's plan stays theirs */

  assert.strictEqual((await friend.req('DELETE', '/api/my/defaults')).body.mine, null);
  await friend.req('PUT', '/api/my/defaults', mine);
  assert.strictEqual((await friend.req('PUT', '/api/my/defaults', {})).body.mine, null);   /* nothing at all = no plan */
  /* free foods: only the kinds set are kept, as true/false */
  const fr = await friend.req('PUT', '/api/my/defaults', { free: { sauce: 1, veg: false, pizza: true } });
  assert.deepStrictEqual(fr.body.mine.free, { sauce: true, veg: false });
  assert.strictEqual((await friend.req('PUT', '/api/my/defaults', { free: 'yes' })).status, 400);
  await friend.req('DELETE', '/api/my/defaults');
});

test('account admin: plan changes take effect from a date, earlier days keep the plan they had', async () => {
  const friend = client();
  await friend.req('GET', '/auth/config');
  await friend.req('POST', '/auth/login', { email: 'friend@example.com', password: 'longenough2' });
  await friend.req('GET', '/api/me');
  const plan = name => ({ foods: { oats: OATS }, templates: [{ id: 'R', name: 'Rest' }],
    plan: { R: [{ id: '1', name, p: [], c: [{ f: 'oats', g: 100 }], x: [] }] } });
  const names = r => r.body.myVersions.map(v => [v.from, v.plan && v.plan.R ? v.plan.R[0].name : null]);
  let r = await friend.req('PUT', '/api/my/defaults', plan('Old bowl'));
  assert.deepStrictEqual(names(r), [[null, 'Old bowl']]);
  assert.strictEqual(r.body.mine.plan.R[0].name, 'Old bowl');

  r = await friend.req('PUT', '/api/my/defaults', { ...plan('Future bowl'), from: '2999-01-04' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(names(r), [[null, 'Old bowl'], ['2999-01-04', 'Future bowl']]);
  assert.strictEqual(r.body.mine.plan.R[0].name, 'Old bowl', 'today still uses the plan in effect now');
  r = await friend.req('PUT', '/api/my/defaults', { ...plan('Past bowl'), from: '2020-03-02' });
  assert.strictEqual(r.body.mine.plan.R[0].name, 'Past bowl');
  r = await friend.req('PUT', '/api/my/defaults', { ...plan('Past bowl 2'), from: '2020-03-02' });   /* same date replaces it */
  assert.deepStrictEqual(names(r), [[null, 'Old bowl'], ['2020-03-02', 'Past bowl 2'], ['2999-01-04', 'Future bowl']]);
  /* nothing from a date = no plan from then on */
  r = await friend.req('PUT', '/api/my/defaults', { from: '2021-01-01' });
  assert.strictEqual(r.body.mine, null);
  assert.strictEqual(r.body.myVersions.length, 4);
  for (const from of ['2020-13-01', 'soon']) assert.strictEqual((await friend.req('PUT', '/api/my/defaults', { from })).status, 400);

  /* the export has every change; someone else's stay theirs */
  assert.strictEqual((await friend.req('GET', '/api/export')).body.planChanges.length, 4);
  const admin = client();
  await admin.req('GET', '/auth/config');
  await admin.req('POST', '/auth/login', { email: 'me@example.com', password: 'longenough1' });
  await admin.req('GET', '/api/me');
  assert.deepStrictEqual((await admin.req('GET', '/api/defaults')).body.myVersions, []);
  assert.strictEqual((await admin.req('DELETE', '/api/my/defaults/2999-01-04')).status, 404);

  assert.strictEqual((await friend.req('DELETE', '/api/my/defaults/2998-01-01')).status, 404);
  r = await friend.req('DELETE', '/api/my/defaults/2021-01-01');
  assert.strictEqual(r.body.mine.plan.R[0].name, 'Past bowl 2');
  r = await friend.req('DELETE', '/api/my/defaults/start');
  assert.deepStrictEqual(names(r), [['2020-03-02', 'Past bowl 2'], ['2999-01-04', 'Future bowl']]);
  /* without a date, a save replaces every change */
  r = await friend.req('PUT', '/api/my/defaults', plan('Only bowl'));
  assert.deepStrictEqual(names(r), [[null, 'Only bowl']]);
  assert.strictEqual((await friend.req('DELETE', '/api/my/defaults')).body.myVersions.length, 0);
});

test('AI: the key and models are the super admin’s, a plan is read against your own foods and the reply is tidied', async () => {
  const admin = client();
  await admin.req('GET', '/auth/config');
  await admin.req('POST', '/auth/login', { email: 'me@example.com', password: 'longenough1' });
  await admin.req('GET', '/api/me');
  const pdf = async (c, body = '%PDF-1.4 fake') => {
    const r = await c.req('GET', '/api/me');
    return fetch(BASE + '/api/my/ai-import', { method: 'POST', body,
      headers: { 'content-type': 'application/pdf', 'x-csrf-token': r.body.csrf, cookie: c.cookie() } });
  };
  /* the reading works from the account's own foods */
  assert.strictEqual((await admin.req('PUT', '/api/my/defaults', { templates: [{ id: 'T', name: 'Training' }], foods: {
    chicken: { n: 'Chicken', k: 170, p: 31, c: 4, f: 3, d: 31, step: 5, group: 'p' }, skyr: SKYR,
    banana: { n: 'Banana', k: 89, p: 1.1, c: 23, f: 0.3, d: 0, step: 5, group: 'c' } } })).status, 200);
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
  assert.match(sent.body.messages[0].content, /chicken \| Chicken \| per 100g: 170 kcal[\s\S]*skyr \| Skyr/);   /* your own foods */
  assert.doesNotMatch(sent.body.messages[0].content, /Health Road/);                                       /* and no one else's */
  assert.deepStrictEqual(j.templates, [{ id: 'T', name: 'Training' }]);              /* a plan key without a listed template */
  assert.deepStrictEqual(j.plan.T[0].p, [{ f: 'skyr_0', g: 250, lock: false }]);   /* unknown food dropped */
  assert.deepStrictEqual(j.plan.T[0].c, [{ f: 'banana', g: 120, lock: false }]);
  assert.deepStrictEqual(Object.keys(j.foods), ['skyr_0']);                         /* can't overwrite one of yours */
  assert.strictEqual(j.targets.T.k, 2900);
  assert.strictEqual(j.schedule, null);
  assert.ok(j.notes.some(n => /dragonfruit/.test(n)) && j.notes.includes('Estimated the banana'));
  assert.strictEqual((await admin.req('POST', '/api/admin/ai-import', {})).status, 404);   /* no app-wide plan to read into */

  const friend = client();
  await friend.req('GET', '/auth/config');
  await friend.req('POST', '/auth/login', { email: 'friend@example.com', password: 'longenough2' });
  assert.strictEqual((await friend.req('GET', '/api/admin/ai')).status, 403);
  assert.strictEqual((await friend.req('PUT', '/api/admin/ai', { key: 'sk-or-v1-other-key-0000' })).status, 403);
  assert.strictEqual((await friend.req('PUT', '/api/admin/ai', { models: { plan: 'x/y' } })).status, 403);
  assert.strictEqual(aiSeen.length, 1);

  /* a model per task: plan import uses its own, a task left blank falls back to the default */
  assert.strictEqual((await admin.req('PUT', '/api/admin/ai', { models: { nope: 'x/y' } })).status, 400);
  assert.strictEqual((await admin.req('PUT', '/api/admin/ai', { models: { plan: 'bad model!' } })).status, 400);
  let ms = await admin.req('PUT', '/api/admin/ai', { models: { plan: 'plan/model', food: 'food/model' } });
  assert.deepStrictEqual(ms.body.tasks.map(t => [t.id, t.model, t.uses]), [['plan', 'plan/model', 'plan/model'], ['workout', '', 'test/model'], ['supps', '', 'test/model'],
    ['food', 'food/model', 'food/model'], ['pose', '', 'test/model'], ['exercise', '', 'test/model'], ['summary', '', 'test/model']]);
  await pdf(admin);
  assert.strictEqual(aiSeen.at(-1).body.model, 'plan/model');
  ms = await admin.req('PUT', '/api/admin/ai', { models: { plan: '' } });
  assert.deepStrictEqual(ms.body.tasks.filter(t => t.model).map(t => t.id), ['food']);   /* only the one changed */
  await pdf(admin);
  assert.strictEqual(aiSeen.at(-1).body.model, 'test/model');
  assert.ok(!('max_tokens' in aiSeen.at(-1).body), 'imports send no output cap');
  await admin.req('PUT', '/api/admin/ai', { models: { food: '' } });

  /* a reply the app can't use says why, instead of "Something went wrong" */
  for (const [kind, msg] of [['cut', /got cut off/], ['empty', /empty reply/], ['noplan', /couldn’t find a meal plan/]]) {
    const b = await pdf(admin, `%PDF-1.4 BAD:${kind}`);
    const e = await b.json();
    assert.ok(b.status >= 400 && b.status < 600, kind);
    assert.match(e.error, msg);
  }

  assert.strictEqual((await admin.req('PUT', '/api/admin/ai', { key: '' })).body.configured, false);
  await admin.req('DELETE', '/api/my/defaults');
});

test('email settings: admin-only, password never shown, test email goes out', async () => {
  const admin = client();
  await admin.req('GET', '/auth/config');
  await admin.req('POST', '/auth/login', { email: 'me@example.com', password: 'longenough1' });
  await admin.req('GET', '/api/me');
  assert.strictEqual((await admin.req('GET', '/api/admin/email')).body.configured, false);
  assert.strictEqual((await admin.req('POST', '/api/admin/email/test', {})).status, 409);
  assert.strictEqual((await admin.req('PUT', '/api/admin/email', { from: 'not-an-email' })).status, 400);
  assert.strictEqual((await admin.req('PUT', '/api/admin/email', { host: 'bad host!' })).status, 400);
  const st = await admin.req('PUT', '/api/admin/email', { from: 'sender@gmail.example', host: '127.0.0.1', port: SMTP_PORT, secure: false, pass: 'apppassword123' });
  assert.strictEqual(st.status, 200);
  assert.deepStrictEqual([st.body.configured, st.body.hasPassword, st.body.from], [true, true, 'sender@gmail.example']);
  assert.ok(!JSON.stringify((await admin.req('GET', '/api/admin/email')).body).includes('apppassword'));

  const t = await admin.req('POST', '/api/admin/email/test', { to: 'me@example.com' });
  assert.strictEqual(t.status, 200, JSON.stringify(t.body));
  const m = mails.at(-1);
  assert.deepStrictEqual(m.auth.slice(1), ['sender@gmail.example', 'apppassword123']);   /* blank username signs in as the from address */
  assert.match(m.to, /me@example\.com/);
  assert.match(m.data, /Subject: Logbook Monster test email/);

  const friend = client();
  await friend.req('GET', '/auth/config');
  await friend.req('POST', '/auth/login', { email: 'friend@example.com', password: 'longenough2' });
  assert.strictEqual((await friend.req('GET', '/api/admin/email')).status, 403);
  assert.strictEqual((await friend.req('PUT', '/api/admin/email', { host: 'evil.example' })).status, 403);
  assert.strictEqual((await friend.req('GET', '/api/admin/users')).status, 403);
  assert.strictEqual((await friend.req('POST', '/api/admin/users', { email: 'x@example.com' })).status, 403);
});

test('invites: admin invites someone not in ALLOWED_EMAILS, they set a password and sign in', async () => {
  const admin = client();
  await admin.req('GET', '/auth/config');
  await admin.req('POST', '/auth/login', { email: 'me@example.com', password: 'longenough1' });
  await admin.req('GET', '/api/me');
  assert.strictEqual((await admin.req('POST', '/api/admin/users', { email: 'nope' })).status, 400);
  assert.strictEqual((await admin.req('POST', '/api/admin/users', { email: 'friend@example.com' })).status, 409);

  const before = mails.length;
  const inv = await admin.req('POST', '/api/admin/users', { email: 'New.Person@example.com', name: 'Newbie' });
  assert.strictEqual(inv.status, 200, JSON.stringify(inv.body));
  assert.strictEqual(inv.body.emailed, true);
  assert.match(inv.body.link, new RegExp(`^${BASE}/invite#[\\w-]{40,}$`));
  const sent = mails.at(-1);
  assert.strictEqual(mails.length, before + 1);
  assert.match(sent.to, /new\.person@example\.com/);
  assert.ok(sent.data.replace(/=\n/g, '').includes(inv.body.link.split('#')[1]), 'email should carry the link');

  /* a second invite replaces the first link */
  const again = await admin.req('POST', `/api/admin/users/${inv.body.id}/invite`, {});
  assert.strictEqual(again.status, 200);
  const oldToken = inv.body.link.split('#')[1], token = again.body.link.split('#')[1];
  let list = (await admin.req('GET', '/api/admin/users')).body;
  assert.strictEqual(list.users.find(u => u.email === 'new.person@example.com').status, 'invited');

  const guest = client();
  await guest.req('GET', '/auth/config');
  assert.strictEqual((await guest.req('POST', '/auth/login', { email: 'new.person@example.com', password: 'whatever-123' })).status, 401);
  assert.strictEqual((await guest.req('POST', '/auth/invite/check', { token: oldToken })).status, 404);
  const chk = await guest.req('POST', '/auth/invite/check', { token });
  assert.deepStrictEqual([chk.status, chk.body.email, chk.body.name], [200, 'new.person@example.com', 'Newbie']);
  assert.strictEqual((await guest.req('POST', '/auth/invite/accept', { token, password: 'short' })).status, 400);
  assert.strictEqual((await guest.req('POST', '/auth/invite/accept', { token, password: 'invited-pass-1' })).status, 200);
  assert.strictEqual((await guest.req('GET', '/api/me')).body.email, 'new.person@example.com');
  assert.strictEqual((await guest.req('GET', '/api/admin/users')).status, 403);
  assert.strictEqual((await guest.req('POST', '/auth/invite/check', { token })).status, 404);   /* used up */

  for (let i = 0; i < 20 && !mails.slice(before).some(x => /joined Logbook Monster/.test(x.data)); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(mails.slice(before).some(x => /me@example\.com/.test(x.to) && /joined Logbook Monster/.test(x.data)), 'inviter is notified');

  list = (await admin.req('GET', '/api/admin/users')).body;
  const np = list.users.find(u => u.email === 'new.person@example.com');
  assert.deepStrictEqual([np.status, np.password, np.invitedBy], ['active', true, 'me@example.com']);
  assert.strictEqual((await admin.req('POST', `/api/admin/users/${np.id}/invite`, {})).status, 409);
  assert.strictEqual((await admin.req('DELETE', `/api/admin/users/${list.users.find(u => u.you).id}`)).status, 400);

  /* removing an account signs it out and deletes its data */
  assert.strictEqual((await admin.req('DELETE', `/api/admin/users/${np.id}`)).status, 200);
  assert.strictEqual((await guest.req('GET', '/api/me')).status, 401);
  assert.ok(!(await admin.req('GET', '/api/admin/users')).body.users.some(u => u.email === 'new.person@example.com'));

  /* without email set up, the admin still gets a link to pass on */
  await admin.req('PUT', '/api/admin/email', { host: '', from: '', pass: '', port: '', secure: null });
  const nomail = await admin.req('POST', '/api/admin/users', { email: 'later@example.com' });
  assert.deepStrictEqual([nomail.status, nomail.body.emailed], [200, false]);
  assert.match(nomail.body.emailError, /isn’t set up/);
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

  /* body parts: set by hand, unknown ids dropped, other accounts can't */
  let px = await me.req('PUT', '/api/gym/exercises/' + ex.body.id, { name: 'Hack squat', notes: '', parts: ['quads', 'Glutes', 'wings', 'quads'] });
  assert.deepStrictEqual(px.body.parts, ['quads', 'glutes']);
  assert.deepStrictEqual((await me.req('PUT', '/api/gym/exercises/' + ex.body.id, { name: 'Hack squat', notes: 'x' })).body.parts, ['quads', 'glutes']);   /* kept when not sent */
  assert.strictEqual((await me.req('PUT', '/api/gym/exercises/' + ex.body.id, { name: 'Hack squat', parts: 'quads' })).status, 400);
  assert.strictEqual((await other.req('PUT', '/api/gym/exercises/' + ex.body.id, { name: 'Hack squat', parts: [] })).status, 404);
  const gy = (await me.req('GET', '/api/gym')).body;
  assert.ok(gy.parts.some(p => p.id === 'quads' && p.name === 'Quads'));
  assert.deepStrictEqual(gy.exercises.find(x => x.id === ex.body.id).parts, ['quads', 'glutes']);
  assert.strictEqual((await me.req('POST', '/api/gym/exercises/ai-parts', { ids: [ex.body.id] })).status, 400);   /* no AI key yet */

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
  assert.deepStrictEqual(plan.workouts[0].exercises, [{ name: 'Hack squat', target: '1 × 5–8 heavy', existing: ex.body.id, parts: ['chest'] },
    { name: 'Panatta high row', target: '2 × 8–15', existing: null, parts: ['back', 'biceps'] }]);
  assert.deepStrictEqual(plan.notes, ['Guessed the row machine']);
  const imp = await me.req('POST', '/api/gym/import', { workouts: plan.workouts });
  assert.strictEqual(imp.status, 200);
  assert.deepStrictEqual(imp.body.workouts.map(x => x.name), ['Legs', 'Monday — Upper']);
  assert.deepStrictEqual(imp.body.exercises.map(x => x.name), ['Hack squat', 'Panatta high row']);
  assert.deepStrictEqual(imp.body.exercises.map(x => x.parts), [['quads', 'glutes'], ['back', 'biceps']]);   /* the import tags only untagged exercises */
  assert.strictEqual(imp.body.workouts[1].items[0].e, ex.body.id);
  assert.strictEqual((await me.req('POST', '/api/gym/import', { workouts: [{ name: 'x'.repeat(81), exercises: [] }] })).status, 400);
  assert.strictEqual((await me.req('GET', '/api/gym')).body.workouts.length, 2);       /* a failed import adds nothing */

  /* AI: tag exercises with body parts – only yours, only known parts, nothing for an unclear name */
  const myst = (await me.req('POST', '/api/gym/exercises', { name: 'Mystery machine' })).body;
  const row = imp.body.exercises.find(x => x.name === 'Panatta high row');
  await me.req('PUT', '/api/gym/exercises/' + row.id, { name: row.name, parts: [] });
  let tg = await me.req('POST', '/api/gym/exercises/ai-parts', { ids: [row.id, myst.id] });
  assert.strictEqual(tg.status, 200, JSON.stringify(tg.body));
  assert.strictEqual(tg.body.tagged, 1);
  assert.match(aiSeen.at(-1).body.messages[1].content, /Panatta high row/);
  assert.deepStrictEqual(tg.body.exercises.map(x => [x.name, x.parts]), [['Hack squat', ['quads', 'glutes']], ['Mystery machine', []], ['Panatta high row', ['back', 'biceps']]]);
  assert.strictEqual((await other.req('POST', '/api/gym/exercises/ai-parts', { ids: [row.id] })).status, 400);   /* not theirs */
  assert.strictEqual((await me.req('POST', '/api/gym/exercises/ai-parts', { ids: [] })).status, 400);
  assert.strictEqual((await me.req('POST', '/api/gym/exercises/ai-parts', { ids: Array.from({ length: 41 }, (_, i) => i + 1) })).status, 400);
  await me.req('DELETE', '/api/gym/exercises/' + myst.id);
  await other.req('PUT', '/api/admin/ai', { key: '' });

  /* deleting an exercise takes its sets and drops it from workouts */
  await me.req('PUT', '/api/gym/order', { ids: [imp.body.workouts[1].id, w.body.id] });
  assert.strictEqual((await me.req('DELETE', '/api/gym/exercises/' + ex.body.id)).status, 200);
  const after = (await me.req('GET', '/api/gym')).body;
  assert.deepStrictEqual(after.workouts.map(x => [x.name, x.items.length]), [['Monday — Upper', 1], ['Legs', 0]]);
  assert.strictEqual((await me.req('GET', '/api/gym/sessions')).body.length, 0);
  assert.ok(Array.isArray((await me.req('GET', '/api/export')).body.gym.sets));
});

test('gym: history import matches exercises by name, keeps set order and skips sets already there', async () => {
  const me = client();
  await me.req('GET', '/auth/config');
  await me.req('POST', '/auth/login', { email: 'friend@example.com', password: 'longenough2' });
  await me.req('GET', '/api/me');
  const mine = await me.req('POST', '/api/gym/exercises', { name: 'Leg press' });
  const sets = [
    { name: 'leg press', reps: 10, kg: 200, note: '', at: '2026-01-02T10:00:00' },
    { name: 'leg press', reps: 8, kg: 200, note: '', at: '2026-01-02T10:00:00' },
    { name: 'leg press', reps: 10, kg: 200, note: 'last', at: '2026-01-02T10:00:00' },
    { name: 'Chest fly', reps: 12, kg: 30.5, note: '', at: '2026-01-02T10:20:00' },
  ];
  const r = await me.req('POST', '/api/gym/import-sets', { sets });
  assert.deepStrictEqual(r.body, { added: 4, skipped: 0, newExercises: 1 });
  const lp = (await me.req('GET', '/api/gym/sets?exercise=' + mine.body.id)).body;
  assert.deepStrictEqual(lp.map(s => [s.reps, s.note]), [[10, ''], [8, ''], [10, 'last']]);   /* same order as the file */
  assert.deepStrictEqual((await me.req('POST', '/api/gym/import-sets', { sets })).body, { added: 0, skipped: 4, newExercises: 0 });
  assert.deepStrictEqual((await me.req('POST', '/api/gym/import-sets', { sets: [...sets, { ...sets[0], at: '2026-01-03T09:00:00' }] })).body,
    { added: 1, skipped: 4, newExercises: 0 });
  /* one bad set and nothing in the batch is saved */
  const bad = await me.req('POST', '/api/gym/import-sets', { sets: [{ ...sets[0], at: '2026-01-04T09:00:00' }, { ...sets[0], reps: 2.5 }] });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /leg press/);
  assert.strictEqual((await me.req('GET', '/api/gym/sets?date=2026-01-04')).body.length, 0);
  assert.strictEqual((await me.req('POST', '/api/gym/import-sets', { sets: [] })).status, 400);
  /* the other account's history is untouched */
  const other = client();
  await other.req('GET', '/auth/config');
  await other.req('POST', '/auth/login', { email: 'me@example.com', password: 'longenough1' });
  await other.req('GET', '/api/me');
  assert.strictEqual((await other.req('GET', '/api/gym/sets?date=2026-01-02')).body.length, 0);
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

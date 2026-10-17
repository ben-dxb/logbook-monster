'use strict';
/* Storage caps: dates only within the window (and real ones), per-account byte caps on days, plan history and photos,
   a per-account write limit on the signed-in API and a limited, streamed data export. The caps are lowered here
   through the environment so the test stays small; the defaults are in server/config.js. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-quotas-'));
const DB = path.join(dir, 't.db');
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: DB,
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '',
  QUOTA_DAYS_BYTES: '20000', QUOTA_PLAN_BYTES: '6000', QUOTA_PHOTO_BYTES: '600', WRITE_RATE_LIMIT: '80', EXPORT_RATE_LIMIT: '3' };
let srv;

before(async () => {
  for (const who of ['ann', 'bob', 'cat', 'dan']) {
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
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

async function signIn(email) {
  let cookie = '', csrf = '';
  const req = async (method, url, body) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': raw ? 'image/jpeg' : 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j, text, headers: r.headers };
  };
  await req('GET', '/auth/config');
  assert.strictEqual((await req('POST', '/auth/login', { email, password: 'long-password-1' })).status, 200);
  await req('GET', '/api/me');
  return req;
}
const ymd = d => d.toISOString().slice(0, 10);
const TODAY = ymd(new Date());
const day = (pad = 0) => ({ data: { meals: [], pad: 'x'.repeat(pad) }, summary: { k: 1 } });
const jpeg = n => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 32), Buffer.from([0xff, 0xd9])]);

test('the shared date check: real dates only, and stored dates only from 2000 to a year ahead', () => {
  const { isDate, inWindow, writeError, lastDate } = require('../server/dates');
  for (const s of ['2026-02-29', '2026-02-31', '2026-13-01', '2026-04-31', '2026-1-01', '', null, 20260101, '2026-01-01T00:00']) {
    assert.strictEqual(isDate(s), false, String(s));
  }
  for (const s of ['2024-02-29', '1999-12-31', '2999-01-01']) assert.strictEqual(isDate(s), true, s);
  assert.strictEqual(inWindow('1999-12-31'), false);
  assert.strictEqual(inWindow('2000-01-01'), true);
  assert.strictEqual(inWindow(TODAY), true);
  assert.strictEqual(inWindow(ymd(new Date(Date.now() + 360 * 864e5))), true);
  assert.strictEqual(inWindow(ymd(new Date(Date.now() + 370 * 864e5))), false);
  assert.ok(lastDate() > TODAY);
  assert.strictEqual(writeError('2026-02-31', 'Pick a day'), 'Pick a day');
  assert.match(writeError('2100-01-01'), /2000 to a year from today/);
  assert.strictEqual(writeError(TODAY), '');
});

test('every route that stores a date refuses impossible dates and dates outside the window', async () => {
  const ann = await signIn('ann@example.com');
  const far = ymd(new Date(Date.now() + 400 * 864e5));
  for (const d of ['2026-02-31', '1999-12-31', far]) {
    assert.strictEqual((await ann('PUT', `/api/days/${d}`, day())).status, 400, `day ${d}`);
    assert.strictEqual((await ann('PUT', `/api/weights/${d}`, { kg: 80 })).status, 400, `weight ${d}`);
    assert.strictEqual((await ann('PUT', `/api/checklist/days/${d}`, { item: 'water', done: true })).status, 400, `tick ${d}`);
    assert.strictEqual((await ann('POST', '/api/supps/log', { date: d, name: 'Creatine', amount: 5, unit: 'g' })).status, 400, `supps ${d}`);
    assert.strictEqual((await ann('POST', `/api/photos?date=${d}&pose=front`, jpeg(10))).status, 400, `photo ${d}`);
    assert.strictEqual((await ann('PUT', '/api/my/defaults', { from: d })).status, 400, `plan ${d}`);
  }
  const ex = (await ann('POST', '/api/gym/exercises', { name: 'Squat' })).body;
  for (const at of ['2026-02-31T10:00', '1999-06-01T10:00', far + 'T10:00']) {
    assert.strictEqual((await ann('POST', '/api/gym/sets', { exercise: ex.id, reps: 5, kg: 50, at })).status, 400, at);
  }
  assert.strictEqual((await ann('GET', '/api/gym/sets?date=2026-02-31')).status, 400, 'a gym day query needs a real date');
  assert.strictEqual((await ann('GET', '/api/days/2026-02-31')).status, 400);

  /* in the window: fine */
  assert.strictEqual((await ann('PUT', `/api/days/${TODAY}`, day())).status, 200);
  assert.strictEqual((await ann('PUT', '/api/weights/2000-01-01', { kg: 80 })).status, 200);
  assert.strictEqual((await ann('POST', '/api/gym/sets', { exercise: ex.id, reps: 5, kg: 50, at: TODAY + 'T10:00' })).status, 200);

  /* a day stored before the window existed can still be opened and deleted */
  const db = new DatabaseSync(DB);
  const id = db.prepare("SELECT id FROM users WHERE email = 'ann@example.com'").get().id;
  db.prepare("INSERT INTO days (user_id, date, data, summary) VALUES (?, '1990-01-01', '{\"meals\":[]}', '{}')").run(id);
  db.close();
  assert.strictEqual((await ann('GET', '/api/days/1990-01-01')).status, 200);
  assert.strictEqual((await ann('DELETE', '/api/days/1990-01-01')).status, 200);
  assert.strictEqual((await ann('GET', '/api/days/1990-01-01')).status, 404);
});

test('per-account caps: saved days, plan history and photo bytes', async () => {
  const bob = await signIn('bob@example.com'), cat = await signIn('cat@example.com');
  const d = n => ymd(new Date(Date.now() - n * 864e5));
  /* days: 20 000 characters of day JSON in all; resaving a day counts it once */
  assert.strictEqual((await bob('PUT', `/api/days/${d(1)}`, day(9000))).status, 200);
  assert.strictEqual((await bob('PUT', `/api/days/${d(2)}`, day(9000))).status, 200);
  assert.strictEqual((await bob('PUT', `/api/days/${d(2)}`, day(9500))).status, 200, 'replacing a day only counts the difference');
  let r = await bob('PUT', `/api/days/${d(3)}`, day(3000));
  assert.strictEqual(r.status, 413);
  assert.match(r.body.error, /saved days have reached/);
  assert.strictEqual((await cat('PUT', `/api/days/${d(3)}`, day(3000))).status, 200, 'the cap is per account');
  await bob('DELETE', `/api/days/${d(1)}`);
  assert.strictEqual((await bob('PUT', `/api/days/${d(3)}`, day(3000))).status, 200, 'room again after a delete');

  /* plan history: 6000 characters of plan changes in all */
  const plan = (from, name) => ({ from, foods: { oats: { n: 'Oats', k: 380, p: 13, c: 60, f: 7, d: 0, step: 5, group: 'c' } },
    templates: [{ id: 'R', name: 'Rest' }], plan: { R: [{ id: '1', name, p: [], c: [{ f: 'oats', g: 100 }], x: [] }] } });
  let n = 0;
  for (; n < 40; n++) {
    r = await bob('PUT', '/api/my/defaults', plan(d(10 + n), 'Bowl ' + n));
    if (r.status !== 200) break;
  }
  assert.ok(n > 2 && n < 40, `saved ${n} plan changes`);
  assert.strictEqual(r.status, 413);
  assert.match(r.body.error, /plan history has reached/);
  assert.strictEqual((await bob('DELETE', `/api/my/defaults/${d(10)}`)).status, 200, 'deleting a change is always fine');

  /* photos: 600 bytes of files in all, thumbnails included */
  const p1 = await bob('POST', `/api/photos?date=${TODAY}&pose=front`, jpeg(200));
  assert.strictEqual(p1.status, 200);
  assert.strictEqual((await bob('PUT', `/api/photos/${p1.body.id}/thumb`, jpeg(100))).status, 200);
  r = await bob('POST', `/api/photos?date=${TODAY}&pose=back`, jpeg(300));
  assert.strictEqual(r.status, 413);
  assert.match(r.body.error, /photos have reached/);
  assert.strictEqual((await bob('POST', `/api/photos?date=${TODAY}&pose=back`, jpeg(150))).status, 200);
  assert.strictEqual((await bob('PUT', `/api/photos/${p1.body.id}/thumb`, jpeg(300))).status, 413, 'a bigger thumbnail counts too');
  assert.strictEqual((await cat('POST', `/api/photos?date=${TODAY}&pose=back`, jpeg(300))).status, 200, 'the cap is per account');
});

test('saves are rate limited per account; reads are not', async () => {
  const dan = await signIn('dan@example.com'), cat = await signIn('cat@example.com');
  let r, i = 0;
  for (; i < 100; i++) {
    r = await dan('PUT', '/api/weights/' + TODAY, { kg: 80 + i / 10 });
    if (r.status !== 200) break;
  }
  assert.strictEqual(r.status, 429);
  assert.ok(i >= 70 && i <= 80, `limited after ${i} saves`);
  assert.match(r.body.error, /a lot of saving/);
  assert.strictEqual((await dan('GET', '/api/weights')).status, 200, 'reads still work');
  assert.strictEqual((await cat('PUT', '/api/weights/' + TODAY, { kg: 70 })).status, 200, 'another account still saves');
});

test('the export is streamed as one JSON document and limited per hour', async () => {
  const cat = await signIn('cat@example.com');
  await cat('PUT', '/api/weights/2001-02-03', { kg: 71 });
  const r = await cat('GET', '/api/export');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="?logbook-monster-/);
  const exp = JSON.parse(r.text);
  assert.deepStrictEqual(Object.keys(exp), ['exported', 'email', 'settings', 'defaults', 'planChanges', 'days', 'weights', 'gym', 'foods',
    'supplements', 'checklist', 'photos']);
  assert.strictEqual(exp.email, 'cat@example.com');
  assert.strictEqual(exp.days.length, 1);
  assert.strictEqual(exp.days[0].data.pad.length, 3000);
  assert.ok(exp.weights.some(w => w.date === '2001-02-03' && w.kg === 71));
  assert.strictEqual(exp.photos.length, 1);
  assert.strictEqual((await cat('GET', '/api/export')).status, 200);
  assert.strictEqual((await cat('GET', '/api/export')).status, 200);
  const four = await cat('GET', '/api/export');
  assert.strictEqual(four.status, 429);
  assert.match(four.body.error, /downloaded your data a lot/);
});

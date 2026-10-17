'use strict';
/* Two tabs or devices: a save made on an older copy (x-version, server/version.js) is refused with 409 and changes nothing,
   for days, plan changes, the checklist, library foods, photo details and workouts. A save without x-version (an older
   client) isn't checked. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-versions-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'), PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
let srv, A, B;

before(async () => {
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'ann@example.com'],
    { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  A = await tab(); B = await tab();   /* two tabs of the same account */
});
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

/* one signed-in browser tab; ver (undefined: none sent, null: 'none') goes in x-version */
async function tab() {
  let cookie = '', csrf = '';
  const req = async (method, url, body, ver) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': raw ? 'image/jpeg' : 'application/json' } : {}), 'x-csrf-token': csrf,
        ...(ver !== undefined ? { 'x-version': ver === null ? 'none' : ver } : {}) },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j };
  };
  await req('GET', '/auth/config');
  assert.strictEqual((await req('POST', '/auth/login', { email: 'ann@example.com', password: 'long-password-1' })).status, 200);
  await req('GET', '/api/me');
  return req;
}
const CONFLICT = /changed in another tab or device/;

test('days: a save over a newer copy is refused; a new day another tab saved first too', async () => {
  const day = note => ({ data: { meals: [], off: [{ n: note }] }, summary: { k: 1 } });
  let r = await A('PUT', '/api/days/2026-10-13', day('first'), null);
  assert.strictEqual(r.status, 200);
  assert.match(r.body.updated, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
  const v1 = (await A('GET', '/api/days/2026-10-13')).body.updated;
  assert.strictEqual(v1, r.body.updated);
  const b = await B('PUT', '/api/days/2026-10-13', day('from B'), v1);   /* B loaded v1 too and saves first */
  assert.strictEqual(b.status, 200);
  assert.notStrictEqual(b.body.updated, v1);
  r = await A('PUT', '/api/days/2026-10-13', day('from A'), v1);
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, CONFLICT);
  assert.strictEqual((await A('GET', '/api/days/2026-10-13')).body.data.off[0].n, 'from B');
  /* this tab's own saves follow each other */
  r = await B('PUT', '/api/days/2026-10-13', day('B again'), b.body.updated);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await B('PUT', '/api/days/2026-10-13', day('B thrice'), r.body.updated)).status, 200);
  /* a day this tab thought wasn't saved yet */
  assert.strictEqual((await A('PUT', '/api/days/2026-10-13', day('fresh in A'), null)).status, 409);
  /* an older client sends no version and isn't checked */
  assert.strictEqual((await A('PUT', '/api/days/2026-10-13', day('old client'))).status, 200);
  assert.strictEqual((await A('GET', '/api/days/2026-10-13')).body.data.off[0].n, 'old client');
});

test('plan changes: checked against the change with the same date', async () => {
  const plan = name => ({ from: '2026-12-01', templates: [{ id: 'R', name }], schedule: ['R', 'R', 'R', 'R', 'R', 'R', 'R'], targets: { R: { k: 2000, p: 150, c: 200, f: 60 } } });
  let r = await A('PUT', '/api/my/defaults', plan('Rest'), null);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const v1 = r.body.myVersions.find(v => v.from === '2026-12-01').updatedAt;
  assert.strictEqual((await B('PUT', '/api/my/defaults', plan('Rest from B'), v1)).status, 200);
  r = await A('PUT', '/api/my/defaults', plan('Rest from A'), v1);
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, CONFLICT);
  assert.strictEqual((await A('GET', '/api/defaults')).body.myVersions.find(v => v.from === '2026-12-01').templates[0].name, 'Rest from B');
  /* another date is another change: no clash */
  assert.strictEqual((await A('PUT', '/api/my/defaults', { ...plan('Later'), from: '2027-01-01' }, null)).status, 200);
  assert.strictEqual((await A('PUT', '/api/my/defaults', plan('Rest from A, no check'))).status, 200);
});

test('checklist: a stale list neither replaces nor resets a newer one', async () => {
  const items = label => [{ id: 'water', label, show: 'all', auto: '' }];
  const got = (await A('GET', '/api/checklist')).body;
  assert.strictEqual(got.updated, null);   /* the default list */
  let r = await A('PUT', '/api/checklist', { items: items('Alpha') }, got.updated);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await B('PUT', '/api/checklist', { items: items('Beta') }, got.updated)).status, 409);   /* B still had the defaults */
  const v2 = r.body.updated;
  assert.strictEqual((await B('PUT', '/api/checklist', { items: items('Beta') }, v2)).status, 200);
  assert.strictEqual((await A('PUT', '/api/checklist', { items: items('Alpha 2') }, v2)).status, 409);
  assert.strictEqual((await A('DELETE', '/api/checklist', undefined, v2)).status, 409);
  assert.strictEqual((await A('GET', '/api/checklist')).body.items[0].label, 'Beta');
});

test('library foods: an edit made on an older copy is refused', async () => {
  const food = k => ({ name: 'Oats', unit: 'g', k, p: 13, c: 60, f: 7 });
  const f = (await A('POST', '/api/foods', food(380))).body;
  const b = await B('PUT', '/api/foods/' + f.id, food(222), f.updated);
  assert.strictEqual(b.status, 200);
  const r = await A('PUT', '/api/foods/' + f.id, { ...food(380), recipe: 'from A' }, f.updated);
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, CONFLICT);
  assert.strictEqual((await A('GET', '/api/foods')).body.foods.find(x => x.id === f.id).k, 222);
  assert.strictEqual((await A('PUT', '/api/foods/' + f.id, food(300), b.body.updated)).status, 200);
});

test('photo details: a note saved from a stale tab doesn’t undo a newer pose', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('versions-jpeg-'.repeat(4)), Buffer.from([0xff, 0xd9])]);
  const p = (await A('POST', '/api/photos?date=2026-10-01&pose=front&note=first', jpeg)).body;
  assert.ok(p.updated);
  const b = await B('PUT', '/api/photos/' + p.id, { date: p.date, pose: 'back', style: '', note: 'first' }, p.updated);
  assert.strictEqual(b.status, 200);
  assert.notStrictEqual(b.body.updated, p.updated);
  const r = await A('PUT', '/api/photos/' + p.id, { date: p.date, pose: 'front', style: '', note: 'from A' }, p.updated);
  assert.strictEqual(r.status, 409);
  const now = (await A('GET', '/api/photos')).body.photos.find(x => x.id === p.id);
  assert.deepStrictEqual([now.pose, now.note], ['back', 'first']);
});

test('workouts: an edit made on an older copy is refused', async () => {
  const e = (await A('POST', '/api/gym/exercises', { name: 'Squat' })).body;
  const body = target => ({ name: 'Legs', description: '', items: [{ e: e.id, target }] });
  const { id } = (await A('POST', '/api/gym/workouts', body('5 × 5'))).body;
  const w = (await A('GET', '/api/gym')).body.workouts.find(x => x.id === id);
  assert.ok(w.updated);
  assert.strictEqual((await B('PUT', '/api/gym/workouts/' + id, body('5 × 3 from B'), w.updated)).status, 200);
  const r = await A('PUT', '/api/gym/workouts/' + id, body('3 × 8 from A'), w.updated);
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, CONFLICT);
  assert.strictEqual((await A('GET', '/api/gym')).body.workouts.find(x => x.id === id).items[0].target, '5 × 3 from B');
});

test('gym sets: an edit made on an older copy is refused (NEW-gym-foods-photos-01)', async () => {
  const ex = (await A('POST', '/api/gym/exercises', { name: 'Version row' })).body;
  const set = (await A('POST', '/api/gym/sets', { exercise: ex.id, reps: 5, kg: 50, note: 'Z', at: '2026-10-14T10:00' })).body;
  assert.strictEqual(set.updated, null);
  const edit = b => ({ exercise: ex.id, reps: 5, kg: 50, note: 'Z', at: '2026-10-14T10:00', ...b });
  /* tab A saves first (on the copy it loaded, never changed: 'none'), tab B's save on the same copy is refused */
  const a = await A('PUT', '/api/gym/sets/' + set.id, edit({ note: 'A note' }), null);
  assert.strictEqual(a.status, 200);
  assert.match(a.body.updated, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
  const r = await B('PUT', '/api/gym/sets/' + set.id, edit({ reps: 9 }), null);
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, CONFLICT);
  assert.deepStrictEqual((({ reps, note }) => ({ reps, note }))((await A('GET', '/api/gym/sets/' + set.id)).body), { reps: 5, note: 'A note' });
  /* on the copy it has now, it goes through */
  assert.strictEqual((await B('PUT', '/api/gym/sets/' + set.id, edit({ reps: 9, note: 'A note' }), a.body.updated)).status, 200);
  assert.strictEqual((await B('PUT', '/api/gym/sets/' + set.id, edit({ reps: 8 }))).status, 200, 'no x-version: not checked');
});

test('workouts: a refused workout makes none of the new exercises named in it (PR-GY-003)', async () => {
  const count = async () => (await A('GET', '/api/gym')).body.exercises.length;
  const n = await count();
  const items = [{ name: 'Atomic incline', target: '3 × 10' }];
  assert.strictEqual((await A('POST', '/api/gym/workouts', { name: 'x'.repeat(300), items })).status, 400);
  assert.strictEqual((await A('POST', '/api/gym/workouts', { name: 'Ok', description: 'd'.repeat(1001), items })).status, 400);
  assert.strictEqual((await A('POST', '/api/gym/workouts', { name: 'Ok', items: [...items, { e: 999999 }] })).status, 400);
  assert.strictEqual(await count(), n, 'no exercise left behind');
  const ok = await A('POST', '/api/gym/workouts', { name: 'Atomic', items: [...items, { name: 'atomic INCLINE' }] });
  assert.strictEqual(ok.status, 200);
  const g = (await A('GET', '/api/gym')).body, w = g.workouts.find(x => x.id === ok.body.id), e = g.exercises.find(x => x.name === 'Atomic incline');
  assert.strictEqual(g.exercises.length, n + 1);
  assert.deepStrictEqual(w.items, [{ e: e.id, target: '3 × 10' }, { e: e.id }]);
  /* an edit adding a new one, refused for an old version, makes none either */
  const r = await A('PUT', '/api/gym/workouts/' + w.id, { name: 'Atomic', items: [{ name: 'Atomic face pull' }] }, '2000-01-01 00:00:00.000');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(await count(), n + 1);
});

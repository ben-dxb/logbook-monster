'use strict';
/* Coach links: an account makes a passwordless link that shows its data read only until a time it picks,
   and can switch it off. The link only reads, only that account's data, and stops at once when it runs out. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-shares-'));
const root = path.join(__dirname, '..');
const DB = path.join(dir, 't.db');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: DB, PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
let srv;

before(async () => {
  for (const who of ['ann', 'bob']) {
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
/* the coach: no cookie, no CSRF token, just the link */
async function open(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: type.includes('json') ? await r.json() : await r.arrayBuffer() };
}
const inDays = n => new Date(Date.now() + n * 86400000).toISOString();
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const day = k => ({ data: { meals: [{ id: '1', name: 'Oats', p: [{ f: 'whey', g: 40 }], c: [], x: [] }], off: [] },
  summary: { k, p: 180, c: 250, f: 70, d: 180, targets: { k: 2500, p: 180, c: 250, f: 70 }, type: 'T' } });

test('a coach link shows the account’s data read only, with no sign-in', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com');
  await ann('PUT', '/api/days/2026-09-10', day(2400));
  await ann('PUT', '/api/weights/2026-09-10', { kg: 81.5 });
  const photo = (await ann('POST', '/api/photos?date=2026-09-10&pose=front', jpeg, 'image/jpeg')).body;
  await bob('PUT', '/api/days/2026-09-10', day(3100));
  const bobPhoto = (await bob('POST', '/api/photos?date=2026-09-10&pose=front', jpeg, 'image/jpeg')).body;

  const made = await ann('POST', '/api/shares', { label: 'Coach Sam', expires: inDays(7) });
  assert.strictEqual(made.status, 200);
  assert.match(made.body.url, new RegExp(`^${BASE}/coach/[A-Za-z0-9_-]{43}$`));
  assert.strictEqual(made.body.live, true);
  const link = made.body.url, api = link + '/api';

  /* the owner sees the link listed, without its secret; nobody else does */
  const list = (await ann('GET', '/api/shares')).body.shares;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].label, 'Coach Sam');
  assert.ok(!JSON.stringify(list).includes(link.split('/').pop()), 'the secret is only shown when the link is made');
  assert.deepStrictEqual((await bob('GET', '/api/shares')).body.shares, []);
  const db = new DatabaseSync(DB);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM shares').all()).includes(link.split('/').pop()), 'only a hash of the secret is stored');

  /* the page and its reads, with no cookie */
  const page = await fetch(link);
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /coach\.js/);
  const info = await open(api + '/info');
  assert.strictEqual(info.status, 200);
  assert.strictEqual(info.body.name, 'ann');
  assert.strictEqual(info.body.label, 'Coach Sam');
  assert.strictEqual(info.headers.get('cache-control'), 'no-store');
  assert.ok((await ann('GET', '/api/shares')).body.shares[0].used, 'opening it is shown to the owner');
  const days = (await open(api + '/days?from=2026-09-01&to=2026-09-30')).body;
  assert.deepStrictEqual(days.map(d => [d.date, d.k]), [['2026-09-10', 2400]]);
  assert.deepStrictEqual((await open(api + '/weights')).body, [{ date: '2026-09-10', kg: 81.5 }]);
  const defs = (await open(api + '/defaults')).body;
  assert.ok(defs.myVersions && !('updatedBy' in defs) && !('updatedAt' in defs), 'the coach sees no admin details');
  const card = (await open(api + '/timeline/day/2026-09-10')).body;
  assert.strictEqual(card.food.summary.k, 2400);
  assert.strictEqual(card.photos[0].id, photo.id);
  assert.ok((await open(api + '/timeline/trends?from=2026-09-01&to=2026-09-30')).body.series.some(s => s.key === 'kg'));
  const thumb = await open(`${api}/photos/${photo.id}/thumb`);
  assert.strictEqual(thumb.status, 200);
  assert.strictEqual(thumb.headers.get('cache-control'), 'no-store', 'a coach’s browser keeps no pictures');
  assert.strictEqual((await open(`${api}/photos/${bobPhoto.id}/file`)).status, 404, 'only the owner’s photos');

  /* nothing can be changed through it, and nothing beyond what it shows can be read */
  assert.strictEqual((await open(api + '/timeline/summary', 'POST', { metrics: ['k'] })).status, 405);
  assert.strictEqual((await open(`${api}/photos/${photo.id}`, 'DELETE')).status, 405);
  assert.strictEqual((await open(api + '/weights/2026-09-11', 'PUT', { kg: 90 })).status, 405);
  /* the account loaded for a link carries no password hash (coach-code-005) */
  for (const p of ['/info', '/defaults', '/days', '/weights', '/timeline/day/2026-09-10', '/timeline/trends']) {
    assert.ok(!JSON.stringify((await open(api + p)).body).includes('scrypt$'), p);
  }
  assert.doesNotMatch(require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'shares.js'), 'utf8'), /auth\.q\.byId/);
  for (const p of ['/me', '/export', '/settings', '/shares', '/gym', '/supps', '/foods', '/admin/users']) {
    assert.strictEqual((await open(api + p)).status, 404, p);
  }
  assert.strictEqual((await ann('GET', '/api/weights')).body.length, 1);
  assert.strictEqual((await ann('GET', '/api/photos')).body.photos.length, 1);

  /* switched off: it stops at once */
  assert.strictEqual((await ann('DELETE', '/api/shares/' + list[0].id)).status, 200);
  const off = await open(api + '/info');
  assert.strictEqual(off.status, 404);
  assert.strictEqual(off.body.gone, true);
  assert.strictEqual((await open(`${api}/photos/${photo.id}/thumb`)).status, 404);
  db.close();
});

test('a link runs out at the time picked, and the owner picks it within limits', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com');
  for (const [expires, why] of [['soon', 'not a time'], [inDays(-1), 'in the past'], [inDays(400), 'over a year']]) {
    assert.strictEqual((await ann('POST', '/api/shares', { expires })).status, 400, why);
  }
  /* none picked: 90 days (Phase 4 – a link is a key held by someone else, so it shouldn't live longer than it needs to) */
  const dflt = await ann('POST', '/api/shares', {});
  assert.strictEqual(dflt.status, 200);
  assert.ok(Math.abs(Date.parse(dflt.body.expires) - Date.now() - 90 * 86400000) < 60000);
  assert.strictEqual((await ann('DELETE', '/api/shares/' + dflt.body.id)).status, 200);
  assert.strictEqual((await ann('POST', '/api/shares', { label: 'x'.repeat(61), expires: inDays(1) })).status, 400);
  const hour = await ann('POST', '/api/shares', { expires: new Date(Date.now() + 3600000).toISOString() });
  assert.strictEqual(hour.status, 200);
  assert.ok(Math.abs(Date.parse(hour.body.expires) - Date.now() - 3600000) < 60000);
  const api = hour.body.url + '/api';
  assert.strictEqual((await open(api + '/info')).status, 200);

  /* bob can't switch ann's link off */
  await bob('DELETE', '/api/shares/' + hour.body.id);
  assert.strictEqual((await open(api + '/info')).status, 200);

  /* the time passes */
  const db = new DatabaseSync(DB);
  db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), hour.body.id);
  db.close();
  const r = await open(api + '/info');
  assert.strictEqual(r.status, 404);
  assert.match(r.body.error, /run out/);
  const listed = (await ann('GET', '/api/shares')).body.shares.find(s => s.id === hour.body.id);
  assert.strictEqual(listed.live, false, 'the owner sees it ran out');

  /* made-up links find nothing */
  assert.strictEqual((await open(`${BASE}/coach/${'A'.repeat(43)}/api/info`)).status, 404);
  assert.strictEqual((await open(`${BASE}/coach/nope/api/days`)).status, 404);
});

test('switching off from a stale tab leaves a newer link that took the same id alone', async () => {
  const ann = await signIn('ann@example.com');
  const sam = (await ann('POST', '/api/shares', { label: 'Sam', expires: inDays(7) })).body;
  assert.match(sam.key, /^[0-9a-f]{12}$/);
  assert.strictEqual((await ann('DELETE', `/api/shares/${sam.id}?key=${sam.key}`)).status, 200);
  const alex = (await ann('POST', '/api/shares', { label: 'Alex', expires: inDays(7) })).body;
  /* the stale tab still has Sam: same id when SQLite reuses it, and Sam's key either way */
  const stale = await ann('DELETE', `/api/shares/${alex.id}?key=${sam.key}`);
  assert.strictEqual(stale.status, 404);
  assert.match(stale.body.error, /switched off already/);
  assert.strictEqual((await open(alex.url + '/api/info')).status, 200, 'Alex’s link still works');
  assert.strictEqual((await ann('DELETE', `/api/shares/${alex.id}?key=${alex.key}`)).status, 200);
  assert.strictEqual((await open(alex.url + '/api/info')).status, 404);
});

test('a coach link’s day card holds only what the card shows (coach-code-002)', async () => {
  const ann = await signIn('ann@example.com');
  const data = { meals: [{ id: '1', name: 'Bowl', eaten: true, note: 'private meal note', lock: 1, p: [{ f: 'L:7:ab', g: 120, lk: 1 }, { f: 'rice', g: 0 }], c: [], x: [] }],
    off: [{ n: 'Cookie', k: 90, p: 1, c: 12, f: 4, why: 'private' }], journal: 'private day note', targets: { k: 2500 },
    lib: { 'L:7:ab': { n: 'Ann’s secret stew', unit: 'g', k: 150, p: 12, c: 10, f: 6, recipe: 'private recipe' }, 'L:9:cd': { n: 'Unused library food', unit: 'g' } } };
  assert.strictEqual((await ann('PUT', '/api/days/2026-07-01', { data, summary: { k: 1000 } })).status, 200);
  const link = (await ann('POST', '/api/shares', { expires: inDays(1) })).body.url;
  const card = (await open(link + '/api/timeline/day/2026-07-01')).body;
  assert.deepStrictEqual(card.food.data, {
    meals: [{ id: '1', name: 'Bowl', eaten: true, p: [{ f: 'L:7:ab', g: 120 }], c: [], x: [] }],
    off: [{ n: 'Cookie', k: 90, p: 1, c: 12, f: 4 }],
    lib: { 'L:7:ab': { n: 'Ann’s secret stew', unit: 'g' } } });
  assert.strictEqual(card.food.summary.k, 1000);
  /* the owner's own card still has the whole day */
  assert.strictEqual((await ann('GET', '/api/timeline/day/2026-07-01')).body.food.data.journal, 'private day note');
});

test('a coach link serves only the photos the Timeline shows: the latest of each pose on each day', async () => {
  const ann = await signIn('ann@example.com');
  const up = async (date, pose) => {
    const id = (await ann('POST', `/api/photos?date=${date}&pose=${pose}`, jpeg, 'image/jpeg')).body.id;
    assert.strictEqual((await ann('PUT', `/api/photos/${id}`, { date, pose, note: 'private note' })).status, 200);
    return id;
  };
  const early = await up('2026-08-01', 'back'), late = await up('2026-08-01', 'back'), side = await up('2026-08-01', 'left');
  const link = (await ann('POST', '/api/shares', { expires: inDays(1) })).body.url, api = link + '/api';
  const code = async (id, w = 'thumb') => (await open(`${api}/photos/${id}/${w}`)).status;
  assert.deepStrictEqual([await code(early), await code(late), await code(side), await code(early, 'file')], [404, 200, 200, 404]);
  const card = await open(api + '/timeline/day/2026-08-01');
  assert.ok(card.body.photos.some(p => p.id === late) && !card.body.photos.some(p => p.id === early));
  assert.ok(card.body.photos.every(p => !('note' in p)), 'photo notes stay private');
  assert.strictEqual((await open(api + '/photos')).status, 404, 'no list of every photo');
  /* moved to another day, the earlier one is the latest of its own day and shows again */
  await ann('PUT', `/api/photos/${late}`, { date: '2026-08-02', pose: 'back' });
  assert.strictEqual(await code(early), 200);
  assert.strictEqual((await ann('GET', `/api/photos/${early}/thumb`)).status, 200, 'the owner gets every one');
});

test('making links needs a signed-in account and its CSRF token', async () => {
  assert.strictEqual((await open(BASE + '/api/shares', 'POST', { expires: inDays(1) })).status, 401);
  assert.strictEqual((await open(BASE + '/api/shares')).status, 401);
});

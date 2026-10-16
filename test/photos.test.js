'use strict';
/* Progress photos: upload (only real pictures), dated and posed, only ever seen by their owner, files gone on delete. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-photos-'));
const PHOTO_DIR = path.join(dir, 'pics');
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'), PHOTO_DIR,
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
let srv;

before(async () => {
  for (const who of ['admin', 'ann', 'bob']) {
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
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': type || (raw ? 'image/jpeg' : 'application/json') } : {}), 'x-csrf-token': csrf },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    const j = /json/.test(ct) ? await r.json().catch(() => null) : null;
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j, type: ct, bytes: j ? null : Buffer.from(await r.arrayBuffer()), headers: r.headers };
  };
  await req('GET', '/auth/config');
  assert.strictEqual((await req('POST', '/auth/login', { email, password: 'long-password-1' })).status, 200);
  await req('GET', '/api/me');
  return req;
}

/* enough of a JPEG and a PNG for the server's check of the first bytes */
const jpeg = tag => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('smoke-jpeg-' + tag + '-'.repeat(40)), Buffer.from([0xff, 0xd9])]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const files = () => fs.readdirSync(PHOTO_DIR);

test('progress photos: upload, catalog by date, edit, private to their owner, files removed on delete', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com');
  let r = await ann('GET', '/api/photos');
  assert.deepStrictEqual(r.body.photos, []);
  assert.deepStrictEqual(r.body.poses, ['front', 'side', 'back', 'other']);

  r = await ann('POST', '/api/photos?date=2026-09-01&pose=front&note=%20%20fasted%20%20', jpeg('a'));
  assert.strictEqual(r.status, 200);
  const a = r.body;
  assert.deepStrictEqual({ date: a.date, pose: a.pose, note: a.note, tv: a.tv }, { date: '2026-09-01', pose: 'front', note: 'fasted', tv: null });
  r = await ann('POST', '/api/photos?date=2026-10-01&pose=side', png, 'image/png');
  assert.strictEqual(r.status, 200);
  const b = r.body;
  assert.strictEqual(files().length, 2);

  /* only pictures, a real date and a known pose */
  assert.strictEqual((await ann('POST', '/api/photos?date=2026-10-01', Buffer.from('<script>alert(1)</script>' + ' '.repeat(20)))).status, 400);
  assert.strictEqual((await ann('POST', '/api/photos?date=2026-10-01', Buffer.from('not a picture'), 'application/octet-stream')).status, 400);
  assert.strictEqual((await ann('POST', '/api/photos?date=2026-02-30', jpeg('x'))).status, 400);
  assert.strictEqual((await ann('POST', '/api/photos?date=2026-10-01&pose=sideways', jpeg('x'))).status, 400);
  assert.strictEqual((await ann('POST', '/api/photos?date=2026-10-01', Buffer.alloc(11 * 1024 * 1024, 0xff))).status, 413);
  assert.strictEqual(files().length, 2, 'refused uploads leave no files behind');

  /* the catalog is newest day first */
  r = await ann('GET', '/api/photos');
  assert.deepStrictEqual(r.body.photos.map(p => p.id), [b.id, a.id]);
  assert.deepStrictEqual((await ann('GET', '/api/photos?from=2026-09-15')).body.photos.map(p => p.id), [b.id]);

  /* the picture comes back as it went in, typed by its bytes; the thumbnail falls back to it until one is sent */
  r = await ann('GET', `/api/photos/${a.id}/file`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.type, 'image/jpeg');
  assert.ok(r.bytes.equals(jpeg('a')));
  assert.match(r.headers.get('cache-control'), /private/);
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await ann('GET', `/api/photos/${b.id}/file`)).type, 'image/png');
  assert.ok((await ann('GET', `/api/photos/${a.id}/thumb`)).bytes.equals(jpeg('a')));

  assert.strictEqual((await ann('PUT', `/api/photos/${a.id}/thumb`, png, 'image/png')).status, 400, 'thumbnails are JPEGs');
  r = await ann('PUT', `/api/photos/${a.id}/thumb`, jpeg('thumb'));
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.tv);
  assert.ok((await ann('GET', `/api/photos/${a.id}/thumb`)).bytes.equals(jpeg('thumb')));
  r = await ann('PUT', `/api/photos/${a.id}/thumb`, jpeg('thumb2'));
  assert.strictEqual(files().length, 3, 'a replaced thumbnail is removed');

  /* someone else can't see, fetch, change or delete it */
  assert.deepStrictEqual((await bob('GET', '/api/photos')).body.photos, []);
  assert.strictEqual((await bob('GET', `/api/photos/${a.id}/file`)).status, 404);
  assert.strictEqual((await bob('GET', `/api/photos/${a.id}/thumb`)).status, 404);
  assert.strictEqual((await bob('PUT', `/api/photos/${a.id}`, { date: '2026-01-01', pose: 'back' })).status, 404);
  assert.strictEqual((await bob('PUT', `/api/photos/${a.id}/thumb`, jpeg('evil'))).status, 404);
  assert.strictEqual((await bob('DELETE', `/api/photos/${a.id}`)).status, 200);
  assert.strictEqual((await ann('GET', `/api/photos/${a.id}/file`)).status, 200, 'still there after someone else tried to delete it');

  /* change the date, pose and note */
  r = await ann('PUT', `/api/photos/${b.id}`, { date: '2026-08-15', pose: 'back', note: 'holiday' });
  assert.deepStrictEqual({ date: r.body.date, pose: r.body.pose, note: r.body.note }, { date: '2026-08-15', pose: 'back', note: 'holiday' });
  assert.strictEqual((await ann('PUT', `/api/photos/${b.id}`, { date: 'soon', pose: 'back' })).status, 400);
  assert.strictEqual((await ann('PUT', `/api/photos/${b.id}`, { date: '2026-08-15', note: 'x'.repeat(201) })).status, 400);
  assert.deepStrictEqual((await ann('GET', '/api/photos')).body.photos.map(p => p.id), [a.id, b.id]);

  /* the export lists them */
  r = await ann('GET', '/api/export');
  assert.deepStrictEqual(r.body.photos.map(p => p.id), [b.id, a.id]);
  assert.ok(!('file' in r.body.photos[0]), 'file names stay on the server');

  /* deleting takes the picture and its thumbnail off the disk */
  assert.strictEqual((await ann('DELETE', `/api/photos/${a.id}`)).status, 200);
  await new Promise(res => setTimeout(res, 100));
  assert.strictEqual(files().length, 1);
  assert.strictEqual((await ann('GET', `/api/photos/${a.id}/file`)).status, 404);
});

test('progress photos: removing an account removes its pictures', async () => {
  const admin = await signIn('admin@example.com'), bob = await signIn('bob@example.com');
  const before = files().length;
  assert.strictEqual((await bob('POST', '/api/photos?date=2026-10-10', jpeg('bob'))).status, 200);
  assert.strictEqual(files().length, before + 1);
  const db = new DatabaseSync(env.DB_PATH);
  const { id } = db.prepare("SELECT id FROM users WHERE email = 'bob@example.com'").get();
  db.close();
  assert.strictEqual((await admin('DELETE', `/api/admin/users/${id}`)).status, 200);
  await new Promise(res => setTimeout(res, 100));
  assert.strictEqual(files().length, before);
});

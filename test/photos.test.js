'use strict';
/* Progress photos: upload (only real pictures), dated and posed, only ever seen by their owner, files gone on delete. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const [PORT, AI_PORT] = require('./_ports').freePorts(2);
/* Stands in for OpenRouter: answers with the pose written in the picture's bytes ("pose:back"), or junk */
const aiSeen = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body); aiSeen.push(j);
    const img = Buffer.from(j.messages[1].content[1].image_url.url.split(',')[1], 'base64').toString('latin1');
    const m = /pose:(\w+)/.exec(img);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/vision', choices: [{ message: { content: JSON.stringify({ pose: m ? m[1] : 'upside-down' }) } }] }));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-photos-'));
const PHOTO_DIR = path.join(dir, 'pics');
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'), PHOTO_DIR,
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: 'sk-test-key-1234',
  OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}` };
let srv;

before(async () => {
  await new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r));
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
after(() => { srv.kill(); fakeAi.close(); fs.rmSync(dir, { recursive: true, force: true }); });

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
  const up = await bob('POST', '/api/photos?date=2026-10-10', jpeg('bob'));
  assert.strictEqual(up.status, 200);
  assert.strictEqual(up.body.pose, 'other', 'no pose given goes in as other, not front');
  assert.strictEqual(files().length, before + 1);
  const db = new DatabaseSync(env.DB_PATH);
  const { id } = db.prepare("SELECT id FROM users WHERE email = 'bob@example.com'").get();
  db.close();
  assert.strictEqual((await admin('DELETE', `/api/admin/users/${id}`)).status, 200);
  await new Promise(res => setTimeout(res, 100));
  assert.strictEqual(files().length, before);
});

test('progress photos: the AI tags the pose, from the thumbnail, only when asked to save', async () => {
  const ann = await signIn('ann@example.com'), other = await signIn('admin@example.com');
  assert.strictEqual((await ann('GET', '/api/photos')).body.ai, true);
  const p = (await ann('POST', '/api/photos?date=2026-10-05&pose=other&note=gym', jpeg('pose:front'))).body;
  aiSeen.length = 0;

  /* just asking: the answer comes back, nothing is saved */
  let r = await ann('POST', `/api/photos/${p.id}/ai-pose`, {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.pose, 'front');
  assert.strictEqual(r.body.photo.pose, 'other');
  assert.match(aiSeen[0].messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.match(aiSeen[0].messages[0].content, /"front" \| "back" \| "side" \| "other"/);

  /* the thumbnail is what is sent once there is one */
  await ann('PUT', `/api/photos/${p.id}/thumb`, jpeg('pose:back'));
  r = await ann('POST', `/api/photos/${p.id}/ai-pose`, { save: true });
  assert.deepStrictEqual({ pose: r.body.pose, saved: r.body.photo.pose, note: r.body.photo.note, date: r.body.photo.date },
    { pose: 'back', saved: 'back', note: 'gym', date: '2026-10-05' });
  assert.strictEqual((await ann('GET', '/api/photos')).body.photos.find(x => x.id === p.id).pose, 'back');

  /* an answer that isn't a pose counts as other */
  await ann('PUT', `/api/photos/${p.id}/thumb`, jpeg('no-hint'));
  r = await ann('POST', `/api/photos/${p.id}/ai-pose`, { save: true });
  assert.strictEqual(r.body.pose, 'other');

  /* whose pose it is: the AI's once it tags it (keeping it on an edit), the person's once they change it, and
     a photo uploaded for the AI to tag counts as the AI's even before it answers */
  assert.strictEqual(r.body.photo.poseAi, true);
  assert.strictEqual(p.poseAi, false);
  r = await ann('PUT', `/api/photos/${p.id}`, { date: '2026-10-05', pose: 'other', note: 'gym 2' });
  assert.strictEqual(r.body.poseAi, true);
  r = await ann('PUT', `/api/photos/${p.id}`, { date: '2026-10-05', pose: 'side', note: 'gym 2' });
  assert.strictEqual(r.body.poseAi, false);
  assert.strictEqual((await ann('POST', '/api/photos?date=2026-10-06&pose=other&ai=1', jpeg('x'))).body.poseAi, true);

  /* nobody else can have someone's photo read */
  const n = aiSeen.length;
  assert.strictEqual((await other('POST', `/api/photos/${p.id}/ai-pose`, { save: true })).status, 404);
  assert.strictEqual((await ann('POST', '/api/photos/999999/ai-pose', {})).status, 404);
  assert.strictEqual(aiSeen.length, n, 'nothing was sent to the AI');
});

test('progress photos: delete every photo between two dates, only your own, files and all', async () => {
  const me = await signIn('admin@example.com'), ann = await signIn('ann@example.com');
  const ids = {};
  for (const d of ['2025-12-31', '2026-01-01', '2026-01-15', '2026-01-31', '2026-02-01']) {
    const r = await me('POST', `/api/photos?date=${d}&pose=front`, jpeg('range-' + d));
    assert.strictEqual(r.status, 200);
    ids[d] = r.body.id;
    await me('PUT', `/api/photos/${r.body.id}/thumb`, jpeg('range-thumb-' + d));
  }
  const annPhoto = (await ann('POST', '/api/photos?date=2026-01-10', jpeg('ann-range'))).body;
  const before = files().length;

  /* both dates are needed and must make sense */
  for (const qs of ['', '?from=2026-01-01', '?to=2026-01-31', '?from=2026-01-01&to=soon', '?from=2026-02-01&to=2026-01-01']) {
    assert.strictEqual((await me('DELETE', '/api/photos' + qs)).status, 400, qs);
  }
  assert.strictEqual(files().length, before, 'a refused delete leaves everything');

  const r = await me('DELETE', '/api/photos?from=2026-01-01&to=2026-01-31');
  assert.deepStrictEqual(r.body, { deleted: 3 }, 'both ends are included');
  await new Promise(res => setTimeout(res, 100));
  assert.strictEqual(files().length, before - 6, 'pictures and thumbnails both go');
  const left = (await me('GET', '/api/photos?from=2025-12-01&to=2026-02-28')).body.photos.map(p => p.id);
  assert.deepStrictEqual(left.sort(), [ids['2025-12-31'], ids['2026-02-01']].sort());
  assert.strictEqual((await ann('GET', `/api/photos/${annPhoto.id}/file`)).status, 200, 'someone else’s photos in the range stay');
  assert.deepStrictEqual((await me('DELETE', '/api/photos?from=2026-01-01&to=2026-01-31')).body, { deleted: 0 });
});

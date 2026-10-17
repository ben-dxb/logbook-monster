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
/* Stands in for OpenRouter: answers with the pose and pose type written in the picture's bytes ("pose:back style:back_relaxed"), or junk */
const aiSeen = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body); aiSeen.push(j);
    const img = Buffer.from(j.messages[1].content[1].image_url.url.split(',')[1], 'base64').toString('latin1');
    const m = /pose:(\w+)/.exec(img), st = /style:(\w+)/.exec(img);
    res.setHeader('content-type', 'application/json');
    setTimeout(() => res.end(JSON.stringify({ model: 'test/vision', choices: [{ message: { content: JSON.stringify({ pose: m ? m[1] : 'upside-down', style: st ? st[1] : 'flexy' }) } }] })), /slow/.test(img) ? 500 : 0);   /* "slow": answers after half a second */
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
  const req = async (method, url, body, type, more = {}) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': type || (raw ? 'image/jpeg' : 'application/json') } : {}), 'x-csrf-token': csrf, ...more },
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
  assert.deepStrictEqual(r.body.poses, ['front', 'left', 'right', 'back', 'other']);
  assert.deepStrictEqual(r.body.styles, ['relaxed', 'front_relaxed', 'back_relaxed', 'front_double_biceps', 'back_double_biceps', 'most_muscular']);

  r = await ann('POST', '/api/photos?date=2026-09-01&pose=front&note=%20%20fasted%20%20', jpeg('a'));
  assert.strictEqual(r.status, 200);
  const a = r.body;
  assert.deepStrictEqual({ date: a.date, pose: a.pose, note: a.note, tv: a.tv }, { date: '2026-09-01', pose: 'front', note: 'fasted', tv: null });
  /* the app sends the note in a header, so it never sits in a URL an access log would keep (photos-code-007) */
  r = await ann('POST', '/api/photos?date=2026-09-02&pose=front', jpeg('h'), undefined, { 'x-photo-note': encodeURIComponent('after the cut – 80 kg') });
  assert.strictEqual(r.body.note, 'after the cut – 80 kg');
  assert.strictEqual((await ann('POST', '/api/photos?date=2026-09-02&pose=front', jpeg('h'), undefined, { 'x-photo-note': '%E0%A4%A' })).status, 400);
  assert.strictEqual((await ann('DELETE', `/api/photos/${r.body.id}`)).status, 200);
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
  assert.strictEqual(r.headers.get('cache-control'), 'private, no-cache', 'checked with the server on every use, never kept for a year');
  assert.ok(r.headers.get('etag'), 'so an unchanged picture comes back as a 304');
  assert.strictEqual((await ann('GET', `/api/photos/${a.id}/thumb`)).headers.get('cache-control'), 'private, no-cache');
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
  const p = (await ann('POST', '/api/photos?date=2026-10-05&pose=other&note=gym', jpeg('pose:back'))).body;
  assert.strictEqual(p.style, '', 'no pose type until one is set');
  aiSeen.length = 0;

  /* only ever the thumbnail: without one nothing is sent */
  let r = await ann('POST', `/api/photos/${p.id}/ai-pose`, {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual(aiSeen.length, 0, 'the full-size photo never goes to the AI');
  await ann('PUT', `/api/photos/${p.id}/thumb`, jpeg('pose:front style:most_muscular'));

  /* just asking: the answer comes back, nothing is saved */
  r = await ann('POST', `/api/photos/${p.id}/ai-pose`, {});
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.pose, r.body.style], ['front', 'most_muscular']);
  assert.deepStrictEqual([r.body.photo.pose, r.body.photo.style], ['other', '']);
  assert.match(aiSeen[0].messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.match(aiSeen[0].messages[0].content, /"front" \| "back" \| "left" \| "right" \| "other"/);
  assert.match(aiSeen[0].messages[0].content, /"front_double_biceps" \| "back_double_biceps" \| "most_muscular"/);

  /* a new thumbnail is what is sent next */
  await ann('PUT', `/api/photos/${p.id}/thumb`, jpeg('pose:back style:back_double_biceps'));
  r = await ann('POST', `/api/photos/${p.id}/ai-pose`, { save: true });
  assert.deepStrictEqual({ pose: r.body.pose, saved: r.body.photo.pose, style: r.body.photo.style, note: r.body.photo.note, date: r.body.photo.date },
    { pose: 'back', saved: 'back', style: 'back_double_biceps', note: 'gym', date: '2026-10-05' });
  const got = (await ann('GET', '/api/photos')).body.photos.find(x => x.id === p.id);
  assert.deepStrictEqual([got.pose, got.style], ['back', 'back_double_biceps']);

  /* left and right side */
  await ann('PUT', `/api/photos/${p.id}/thumb`, jpeg('pose:left style:relaxed'));
  r = await ann('POST', `/api/photos/${p.id}/ai-pose`, {});
  assert.deepStrictEqual([r.body.pose, r.body.style], ['left', 'relaxed']);
  await ann('PUT', `/api/photos/${p.id}/thumb`, jpeg('pose:right style:relaxed'));
  assert.strictEqual((await ann('POST', `/api/photos/${p.id}/ai-pose`, {})).body.pose, 'right');

  /* an answer that isn't a pose counts as other; one that isn't a pose type, as none – and the old "side" isn't an answer */
  await ann('PUT', `/api/photos/${p.id}/thumb`, jpeg('pose:side'));
  assert.strictEqual((await ann('POST', `/api/photos/${p.id}/ai-pose`, {})).body.pose, 'other');
  await ann('PUT', `/api/photos/${p.id}/thumb`, jpeg('no-hint'));
  r = await ann('POST', `/api/photos/${p.id}/ai-pose`, { save: true });
  assert.deepStrictEqual([r.body.pose, r.body.style, r.body.photo.style], ['other', '', '']);

  /* whose pose it is: the AI's once it tags it (keeping it on an edit), the person's once they change it, and
     a photo uploaded for the AI to tag counts as the AI's even before it answers */
  assert.strictEqual(r.body.photo.poseAi, true);
  assert.strictEqual(p.poseAi, false);
  r = await ann('PUT', `/api/photos/${p.id}`, { date: '2026-10-05', pose: 'other', note: 'gym 2' });
  assert.strictEqual(r.body.poseAi, true);
  r = await ann('PUT', `/api/photos/${p.id}`, { date: '2026-10-05', pose: 'other', style: 'most_muscular', note: 'gym 2' });
  assert.deepStrictEqual([r.body.style, r.body.poseAi], ['most_muscular', false], 'changing the pose type makes it the person\'s');
  await ann('PUT', `/api/photos/${p.id}/thumb`, jpeg('no-hint'));
  assert.strictEqual((await ann('POST', `/api/photos/${p.id}/ai-pose`, { save: true })).body.photo.poseAi, true);
  r = await ann('PUT', `/api/photos/${p.id}`, { date: '2026-10-05', pose: 'right', note: 'gym 2' });
  assert.deepStrictEqual([r.body.pose, r.body.style, r.body.poseAi], ['right', '', false], 'a pose type left out keeps the one there is');
  r = await ann('PUT', `/api/photos/${p.id}`, { date: '2026-10-05', pose: 'side', style: 'relaxed', note: 'gym 2' });
  assert.deepStrictEqual([r.body.pose, r.body.style], ['side', 'relaxed'], 'older photos may keep "side"');
  assert.strictEqual((await ann('PUT', `/api/photos/${p.id}`, { date: '2026-10-05', pose: 'left', style: 'side_chest' })).status, 400);
  assert.strictEqual((await ann('POST', '/api/photos?date=2026-10-06&pose=other&ai=1', jpeg('x'))).body.poseAi, true);

  /* nobody else can have someone's photo read */
  const n = aiSeen.length;
  assert.strictEqual((await other('POST', `/api/photos/${p.id}/ai-pose`, { save: true })).status, 404);
  assert.strictEqual((await ann('POST', '/api/photos/999999/ai-pose', {})).status, 404);
  assert.strictEqual(aiSeen.length, n, 'nothing was sent to the AI');

  /* refused pose requests (no such photo, no thumbnail) don't use up the hourly limit; one the AI answers does */
  const left = async (url = '/api/photos/999999/ai-pose') => {
    const r = await ann('POST', url, {});
    return [r.status, +/remaining=(\d+)/.exec(r.headers.get('ratelimit'))[1]];
  };
  const bare = (await ann('POST', '/api/photos?date=2026-10-07&pose=other', jpeg('nothumb'))).body;
  const [, start] = await left();
  for (let i = 0; i < 5; i++) assert.deepStrictEqual(await left(), [404, start]);
  assert.deepStrictEqual(await left(`/api/photos/${bare.id}/ai-pose`), [409, start]);
  assert.deepStrictEqual(await left(`/api/photos/${p.id}/ai-pose`), [200, start]);
  assert.deepStrictEqual(await left(), [404, start - 1]);
});

test('progress photos: an AI pose is saved only over the pose it was asked about, never over one set by hand meanwhile', async () => {
  const ann = await signIn('ann@example.com');
  const p = (await ann('POST', '/api/photos?date=2026-10-08&pose=other&ai=1', jpeg('x'))).body;
  await ann('PUT', `/api/photos/${p.id}/thumb`, jpeg('pose:front style:front_relaxed slow'));
  /* set by hand while the AI looks: the answer comes back but the hand edit stays */
  const asking = ann('POST', `/api/photos/${p.id}/ai-pose`, { save: true });
  await new Promise(ok => setTimeout(ok, 150));
  assert.strictEqual((await ann('PUT', `/api/photos/${p.id}`, { date: '2026-10-08', pose: 'back', style: 'back_relaxed', note: '' })).body.poseAi, false);
  let r = await asking;
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.pose, r.body.saved, r.body.photo.pose, r.body.photo.style, r.body.photo.poseAi], ['front', false, 'back', 'back_relaxed', false]);
  /* the app sends the pose it saw when the run started: one set by hand since (in another tab) is kept too */
  r = await ann('POST', `/api/photos/${p.id}/ai-pose`, { save: true, if: { pose: 'other', style: '' } });
  assert.deepStrictEqual([r.body.saved, r.body.photo.pose, r.body.photo.poseAi], [false, 'back', false]);
  /* asked about the pose the photo has (the person said redo it): saved, and the AI's now */
  r = await ann('POST', `/api/photos/${p.id}/ai-pose`, { save: true, if: { pose: 'back', style: 'back_relaxed' } });
  assert.deepStrictEqual([r.body.saved, r.body.photo.pose, r.body.photo.style, r.body.photo.poseAi], [true, 'front', 'front_relaxed', true]);
  /* still the AI's: a later answer replaces it whatever the app saw */
  await ann('PUT', `/api/photos/${p.id}/thumb`, jpeg('pose:left style:relaxed'));
  r = await ann('POST', `/api/photos/${p.id}/ai-pose`, { save: true, if: { pose: 'other', style: '' } });
  assert.deepStrictEqual([r.body.saved, r.body.photo.pose, r.body.photo.poseAi], [true, 'left', true]);
  /* without save nothing is written, as before */
  r = await ann('POST', `/api/photos/${p.id}/ai-pose`, {});
  assert.strictEqual(r.body.saved, false);
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

/* A camera JPEG with a GPS block in its EXIF (APP1), an XMP block (APP1) and IPTC (APP13); a PNG with eXIf and text chunks;
   a WebP with EXIF and XMP chunks. None of it may reach the disk, whatever the client sent. */
test('progress photos: camera data (GPS included) is stripped on upload, even from an un-shrunk picture', async () => {
  const ann = await signIn('ann@example.com');
  const seg = (m, body) => Buffer.concat([Buffer.from([0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  /* TIFF, little-endian: IFD0 with one GPSInfo pointer → GPS IFD with GPSLatitudeRef 'N' */
  const gpsTiff = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x25, 0x88, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0,
    1, 0, 1, 0, 2, 0, 2, 0, 0, 0, 0x4e, 0, 0, 0, 0, 0, 0, 0]);
  const exif = seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0GPS-SECRET', 'latin1'), gpsTiff]));
  const xmp = seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude="25,12.5N"/>', 'latin1'));
  const iptc = seg(0xed, Buffer.from('Photoshop 3.0\0IPTC-SECRET', 'latin1'));
  const app0 = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
  const icc = seg(0xe2, Buffer.from('ICC_PROFILE\0keep-me', 'latin1'));
  const scan = Buffer.concat([seg(0xdb, Buffer.alloc(65, 1)), seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from('image-data'), Buffer.from([0xff, 0xd9])]);
  const camera = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, exif, xmp, icc, iptc, scan]);
  const want = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, icc, scan]);
  const ondisk = async id => fs.readFileSync(path.join(PHOTO_DIR, new DatabaseSync(env.DB_PATH).prepare('SELECT file FROM photos WHERE id = ?').get(id).file));

  let r = await ann('POST', '/api/photos?date=2026-07-01&pose=front', camera);
  assert.strictEqual(r.status, 200);
  const disk = await ondisk(r.body.id);
  assert.ok(disk.equals(want), 'EXIF, XMP and IPTC gone; JFIF, colour profile and the image itself kept as they were');
  for (const x of ['Exif', 'GPS-SECRET', 'IPTC-SECRET', '25,12.5N']) assert.ok(!disk.toString('latin1').includes(x), x);
  assert.strictEqual(r.body.size, want.length);
  assert.ok((await ann('GET', `/api/photos/${r.body.id}/file`)).bytes.equals(want));
  /* the thumbnail too */
  r = await ann('PUT', `/api/photos/${r.body.id}/thumb`, camera);
  assert.strictEqual(r.status, 200);
  assert.ok((await ann('GET', `/api/photos/${r.body.id}/thumb`)).bytes.equals(want));

  /* PNG: eXIf, tEXt, zTXt and iTXt chunks go; the rest stays */
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunk('IHDR', Buffer.alloc(13, 1)), idat = chunk('IDAT', Buffer.from('pixels')), iend = chunk('IEND', Buffer.alloc(0));
  const pngIn = Buffer.concat([sig, ihdr, chunk('eXIf', gpsTiff), chunk('tEXt', Buffer.from('GPS\0secret')), chunk('iTXt', Buffer.from('XML:com.adobe.xmp\0GPS')), idat, iend]);
  r = await ann('POST', '/api/photos?date=2026-07-02&pose=front', pngIn, 'image/png');
  assert.strictEqual(r.status, 200);
  assert.ok((await ondisk(r.body.id)).equals(Buffer.concat([sig, ihdr, idat, iend])));

  /* WebP: EXIF and XMP chunks go, the VP8X flags for them are cleared and the RIFF size fixed */
  const wchunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32LE(data.length); return Buffer.concat([Buffer.from(type, 'latin1'), len, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const riff = body => { const h = Buffer.from('RIFF0000WEBP', 'latin1'); h.writeUInt32LE(body.length + 4, 4); return Buffer.concat([h, body]); };
  const vp8x = flags => wchunk('VP8X', Buffer.from([flags, 0, 0, 0, 9, 0, 0, 9, 0, 0]));
  const frame = wchunk('VP8 ', Buffer.from('frame-data'));
  const webpIn = riff(Buffer.concat([vp8x(0x2c), frame, wchunk('EXIF', gpsTiff), wchunk('XMP ', Buffer.from('<x:xmpmeta GPS/>'))]));
  r = await ann('POST', '/api/photos?date=2026-07-03&pose=front', webpIn, 'image/webp');
  assert.strictEqual(r.status, 200);
  assert.ok((await ondisk(r.body.id)).equals(riff(Buffer.concat([vp8x(0x20), frame]))));
});

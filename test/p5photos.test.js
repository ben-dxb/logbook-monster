'use strict';
/* Phase 5 photos (p5-photos): an upload sent again with its key isn't stored twice, each photo's size is kept (also for older
   photos, filled in at start-up), the middle size is stored, cleaned, counted and shown to a coach only for a photo a day card
   shows, and "Download my photos" is a ZIP of exactly the account's own pictures – limited like the export and logged. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { writeZip } = require('../server/zip');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-p5photos-'));
const PHOTO_DIR = path.join(dir, 'pics'), DB = path.join(dir, 't.db');
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: DB, PHOTO_DIR,
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '', EXPORT_RATE_LIMIT: '4' };
let srv;
async function start() {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}
const stop = () => new Promise(r => { srv.once('exit', r); srv.kill(); });

before(async () => {
  for (const who of ['ann', 'bob']) {
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', `${who}@example.com`],
      { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  }
  await start();
});
after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });

async function signIn(email) {
  let cookie = '', csrf = '';
  const req = async (method, url, body, more = {}) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': raw ? (more.type || 'image/jpeg') : 'application/json' } : {}), 'x-csrf-token': csrf, ...more.headers },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    const j = /json/.test(ct) ? await r.json().catch(() => null) : null;
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j, type: ct, headers: r.headers, bytes: j ? null : Buffer.from(await r.arrayBuffer()) };
  };
  await req('GET', '/auth/config');
  assert.strictEqual((await req('POST', '/auth/login', { email, password: 'long-password-1' })).status, 200);
  await req('GET', '/api/me');
  return req;
}
const open = async url => { const r = await fetch(url); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }; };

/* a JPEG header with a frame of w × h (enough for the server's checks), and an EXIF block when asked */
function jpeg(w, h, tag, exif) {
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const app1 = exif ? Buffer.concat([Buffer.from([0xff, 0xe1, 0, 2 + 6 + 10]), Buffer.from('Exif\0\0GPS-SECRET', 'latin1').subarray(0, 16)]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0' + tag.padEnd(9, '-').slice(0, 9), 'latin1'), sof, Buffer.from([0xff, 0xda, 0, 2]), Buffer.from('scan-' + tag), Buffer.from([0xff, 0xd9])]);
}
const png = (w, h) => { const b = Buffer.alloc(40); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

/* Every entry of a ZIP, read the way an unzipper does: the end record (ZIP64 when it says so) → the central directory → each local header */
function unzip(b) {
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  assert.ok(e >= 0, 'an end of central directory record');
  let n = b.readUInt16LE(e + 10), cd = b.readUInt32LE(e + 16);
  if (cd === 0xffffffff) {
    const loc = e - 20;
    assert.strictEqual(b.readUInt32LE(loc), 0x07064b50, 'a ZIP64 locator');
    const rec = Number(b.readBigUInt64LE(loc + 8));
    assert.strictEqual(b.readUInt32LE(rec), 0x06064b50, 'a ZIP64 end record');
    n = Number(b.readBigUInt64LE(rec + 32)); cd = Number(b.readBigUInt64LE(rec + 48));
  }
  const out = [];
  for (let i = 0, at = cd; i < n; i++) {
    assert.strictEqual(b.readUInt32LE(at), 0x02014b50);
    const crc = b.readUInt32LE(at + 16), size = b.readUInt32LE(at + 24), nl = b.readUInt16LE(at + 28), xl = b.readUInt16LE(at + 30);
    let off = b.readUInt32LE(at + 42);
    if (off === 0xffffffff) { assert.strictEqual(b.readUInt16LE(at + 46 + nl), 1); off = Number(b.readBigUInt64LE(at + 46 + nl + 4)); }
    const name = b.toString('utf8', at + 46, at + 46 + nl);
    assert.strictEqual(b.readUInt32LE(off), 0x04034b50);
    assert.strictEqual(b.readUInt16LE(off + 8), 0, 'stored, not compressed');
    const data = b.subarray(off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28)).subarray(0, size);
    assert.strictEqual(require('zlib').crc32(data), crc, 'the CRC matches ' + name);
    out.push({ name, data });
    at += 46 + nl + xl + b.readUInt16LE(at + 32);
  }
  return out;
}
/* and the system's unzip agrees, where there is one */
function unzipT(file) {
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { return; }
  execFileSync('unzip', ['-tq', file], { stdio: 'pipe' });
}

test('an upload sent again with its key comes back as the photo it made – once, not twice', async () => {
  const ann = await signIn('ann@example.com');
  const before = fs.readdirSync(PHOTO_DIR).length;
  const key = { headers: { 'x-photo-key': 'k-0123456789abcdef' } };
  const a = await ann('POST', '/api/photos?date=2026-09-01&pose=front', jpeg(1500, 2000, 'key'), key);
  assert.strictEqual(a.status, 200);
  assert.ok(!a.body.again);
  assert.deepStrictEqual([a.body.w, a.body.h, a.body.mv, a.body.tv], [1500, 2000, null, null], 'width and height read from the picture');
  const b = await ann('POST', '/api/photos?date=2026-09-02&pose=back', jpeg(1500, 2000, 'key'), key);
  assert.strictEqual(b.status, 200);
  assert.strictEqual(b.body.id, a.body.id);
  assert.strictEqual(b.body.again, true);
  assert.strictEqual(b.body.date, '2026-09-01', 'the photo as it went in the first time');
  assert.strictEqual(fs.readdirSync(PHOTO_DIR).length, before + 1, 'one file, not two');
  /* the same key from someone else is theirs: a new photo */
  const bob = await signIn('bob@example.com');
  const c = await bob('POST', '/api/photos?date=2026-09-01&pose=front', jpeg(10, 20, 'bob'), key);
  assert.notStrictEqual(c.body.id, a.body.id);
  assert.ok(!c.body.again);
  assert.strictEqual((await ann('POST', '/api/photos?date=2026-09-01', jpeg(1, 1, 'x'), { headers: { 'x-photo-key': 'no good!' } })).status, 400);
  const p = await ann('POST', '/api/photos?date=2026-09-03', png(640, 480), { type: 'image/png' });
  assert.deepStrictEqual([p.body.w, p.body.h], [640, 480]);
  for (const id of [a.body.id, p.body.id]) await ann('DELETE', '/api/photos/' + id);
  await bob('DELETE', '/api/photos/' + c.body.id);
});

test('the middle size: stored cleaned, served, counted, deleted with the photo; a coach gets it only for a photo a day card shows', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com');
  const old = (await ann('POST', '/api/photos?date=2026-08-01&pose=front', jpeg(1500, 2000, 'old'))).body;
  const neu = (await ann('POST', '/api/photos?date=2026-08-01&pose=front', jpeg(1500, 2000, 'new'))).body;
  /* the full picture until a middle size is in */
  let r = await ann('GET', `/api/photos/${neu.id}/mid`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.bytes.equals(jpeg(1500, 2000, 'new')));
  r = await ann('PUT', `/api/photos/${neu.id}/mid`, jpeg(750, 1000, 'mid', true));
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.mv && r.body.mv !== r.body.v);
  r = await ann('GET', `/api/photos/${neu.id}/mid?v=${r.body.mv}`);
  assert.strictEqual(r.type, 'image/jpeg');
  assert.strictEqual(r.headers.get('cache-control'), 'private, no-cache');
  assert.ok(!r.bytes.includes(Buffer.from('Exif')) && !r.bytes.includes(Buffer.from('GPS-SECRET')), 'camera data taken out of the middle size too');
  assert.ok(r.bytes.includes(Buffer.from('scan-mid')));
  await ann('PUT', `/api/photos/${old.id}/mid`, jpeg(750, 1000, 'oldmid'));
  assert.strictEqual((await ann('PUT', `/api/photos/${neu.id}/mid`, Buffer.from('not a jpeg at all'), { type: 'image/png' })).status, 400);
  assert.strictEqual((await bob('PUT', `/api/photos/${neu.id}/mid`, jpeg(1, 1, 'b'))).status, 404, 'not someone else’s');
  assert.strictEqual((await bob('GET', `/api/photos/${neu.id}/mid`)).status, 404);

  /* counted with the rest of the account's photo files */
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db.prepare('SELECT size, mid, mid_size FROM photos WHERE id = ?').get(neu.id);
  assert.strictEqual(row.mid_size, fs.statSync(path.join(PHOTO_DIR, row.mid)).size);
  db.close();

  /* through a coach link: the latest of its pose on its date only, as for the file and the thumbnail */
  const link = (await ann('POST', '/api/shares', { label: 'Coach', expires: new Date(Date.now() + 86400000).toISOString() })).body.url;
  const card = await open(`${link}/api/timeline/day/2026-08-01`);
  assert.strictEqual(card.status, 200);
  assert.deepStrictEqual(JSON.parse(card.bytes).photos.map(p => [p.id, !!p.mv, p.w, p.h]), [[neu.id, true, 1500, 2000]]);
  assert.strictEqual((await open(`${link}/api/photos/${neu.id}/mid`)).status, 200);
  assert.strictEqual((await open(`${link}/api/photos/${old.id}/mid`)).status, 404, 'an older photo of the same pose and day is not on the card');
  assert.strictEqual((await open(`${link}/api/photos/zip`)).status, 404, 'no download through a coach link');

  /* gone with the photo */
  await ann('DELETE', `/api/photos/${neu.id}`);
  await new Promise(ok => setTimeout(ok, 100));
  assert.ok(!fs.existsSync(path.join(PHOTO_DIR, row.mid)));
  await ann('DELETE', `/api/photos/${old.id}`);
});

test('photos stored before sizes were kept get theirs at start-up', async () => {
  const ann = await signIn('ann@example.com');
  const p = (await ann('POST', '/api/photos?date=2026-07-01&pose=back', jpeg(1200, 1600, 'older'))).body;
  const gone = (await ann('POST', '/api/photos?date=2026-07-02&pose=back', jpeg(1200, 1600, 'gone'))).body;
  await stop();
  const db = new DatabaseSync(DB);
  db.prepare('UPDATE photos SET width = NULL, height = NULL WHERE id IN (?, ?)').run(p.id, gone.id);
  fs.unlinkSync(path.join(PHOTO_DIR, db.prepare('SELECT file FROM photos WHERE id = ?').get(gone.id).file));
  db.close();
  await start();
  const again = await signIn('ann@example.com');
  let list = [];
  for (let i = 0; i < 30; i++) {
    list = (await again('GET', '/api/photos')).body.photos;
    if (list.every(x => x.id !== p.id || x.w)) break;
    await new Promise(ok => setTimeout(ok, 100));
  }
  const by = id => list.find(x => x.id === id);
  assert.deepStrictEqual([by(p.id).w, by(p.id).h], [1200, 1600]);
  assert.deepStrictEqual([by(gone.id).w, by(gone.id).h], [null, null], 'a missing file: size unknown (and not looked for again)');
  const check = new DatabaseSync(DB, { readOnly: true });
  assert.strictEqual(check.prepare('SELECT COUNT(*) AS n FROM photos WHERE width IS NULL').get().n, 0);
  check.close();
  await again('DELETE', '/api/photos/' + p.id); await again('DELETE', '/api/photos/' + gone.id);
});

test('Download my photos: a ZIP of exactly the account’s own pictures, named by date, limited and logged', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com');
  const mine = [], pics = { };
  for (const [d, pose, tag] of [['2026-06-01', 'front', 'one'], ['2026-06-01', 'back', 'two'], ['2026-06-20', 'left', 'three']]) {
    const body = jpeg(30, 40, tag, true), p = (await ann('POST', `/api/photos?date=${d}&pose=${pose}`, body)).body;
    await ann('PUT', `/api/photos/${p.id}/thumb`, jpeg(3, 4, 'thumb-' + tag));
    await ann('PUT', `/api/photos/${p.id}/mid`, jpeg(15, 20, 'mid-' + tag));
    mine.push(p); pics[`${d}-${pose}-${p.id}.jpg`] = (await ann('GET', `/api/photos/${p.id}/file`)).bytes;
  }
  const theirs = (await bob('POST', '/api/photos?date=2026-06-01&pose=front', jpeg(30, 40, 'bobs'))).body;

  let r = await ann('GET', '/api/photos/zip');
  assert.strictEqual(r.status, 200);
  assert.match(r.type, /^application\/zip/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="?logbook-monster-photos-\d{4}-\d\d-\d\d\.zip"?$/);
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  const files = unzip(r.bytes);
  assert.deepStrictEqual(files.map(f => f.name).sort(), Object.keys(pics).sort(), 'every one of the account’s photos, no thumbnails or middle sizes, nobody else’s');
  for (const f of files) assert.ok(f.data.equals(pics[f.name]), f.name + ' is the stored picture');
  assert.ok(!r.bytes.includes(Buffer.from('GPS-SECRET')) && !r.bytes.includes(Buffer.from('bobs')));
  const zipFile = path.join(dir, 'mine.zip');
  fs.writeFileSync(zipFile, r.bytes); unzipT(zipFile);

  /* a date range */
  r = await ann('GET', '/api/photos/zip?from=2026-06-10&to=2026-06-30');
  assert.deepStrictEqual(unzip(r.bytes).map(f => f.name), [`2026-06-20-left-${mine[2].id}.jpg`]);
  /* an account with none: an empty ZIP, still a ZIP */
  const none = await bob('GET', '/api/photos/zip?from=2020-01-01&to=2020-01-02');
  assert.deepStrictEqual(unzip(none.bytes), []);

  /* logged for the account (Account admin's own log) */
  const log = (await ann('GET', '/api/my/log')).body;
  const rows = (log.rows || log).filter(x => x.event === 'photos.downloaded');
  assert.strictEqual(rows.length, 2);
  /* limited like the export: 4 an hour here (EXPORT_RATE_LIMIT) */
  assert.strictEqual((await ann('GET', '/api/photos/zip')).status, 200);
  assert.strictEqual((await ann('GET', '/api/photos/zip')).status, 200);
  assert.strictEqual((await ann('GET', '/api/photos/zip')).status, 429, 'the fifth this hour');
  assert.strictEqual((await bob('GET', '/api/photos/zip')).status, 200, 'per account');
  for (const p of mine) await ann('DELETE', '/api/photos/' + p.id);
  await bob('DELETE', '/api/photos/' + theirs.id);
});

test('the ZIP writer: ZIP64 records read back, by this reader and by unzip', async () => {
  const parts = [];
  const entries = [{ name: 'a-1.jpg', when: new Date(2026, 8, 1, 12), read: async () => Buffer.from('first') },
    { name: 'missing.jpg', read: async () => null }, { name: 'b.jpg', when: new Date(2026, 8, 2), read: async () => Buffer.alloc(70000, 7) }];
  const n = await writeZip(entries, b => { parts.push(b); }, { zip64: true });
  assert.strictEqual(n, 2);
  const zip = Buffer.concat(parts), files = unzip(zip);
  assert.deepStrictEqual(files.map(f => [f.name, f.data.length]), [['a-1.jpg', 5], ['b.jpg', 70000]]);
  const file = path.join(dir, 'z64.zip');
  fs.writeFileSync(file, zip); unzipT(file);
});

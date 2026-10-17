'use strict';
/* Phase 8: a full or read-only disk. The server runs in this process so the test can make its database refuse writes
   (PRAGMA query_only / max_page_count on the app's own connection) and make photo file writes and deletes fail. */
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-diskfull-'));
const PHOTOS = path.join(dir, 'photos');
const PASSWORD = 'long-password-1';
Object.assign(process.env, { PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'), PHOTO_DIR: PHOTOS,
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '', SMTP_PASS: '', MAIL_FROM: '', OPENROUTER_API_KEY: '' });
execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'ann@example.com'],
  { cwd: root, env: { ...process.env, NEW_PASSWORD: PASSWORD }, stdio: 'ignore' });

/* what the server logs, to check for "headers already sent" */
const logged = [];
const realError = console.error;
console.error = (...a) => { logged.push(a.map(x => (x instanceof Error ? `${x.code} ${x.message}` : String(x))).join(' ')); };
require('../server/index');
const db = require('../server/db');
const storage = require('../server/storage');
const photos = require('../server/photos');

function browser() {
  let cookie = '', csrf = '';
  return async (method, url, body, raw) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) };
    if (body !== undefined) headers['content-type'] = raw ? 'image/jpeg' : 'application/json';
    const r = await fetch(BASE + url, { method, redirect: 'manual', headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j };
  };
}
async function signIn() {
  const c = browser();
  await c('GET', '/auth/config');
  assert.strictEqual((await c('POST', '/auth/login', { email: 'ann@example.com', password: PASSWORD })).status, 200);
  assert.strictEqual((await c('GET', '/api/me')).status, 200);   /* its CSRF token */
  return c;
}
const jpeg = tag => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-' + tag + '-'.repeat(40)), Buffer.from([0xff, 0xd9])]);
const files = () => fs.readdirSync(PHOTOS);
const health = async () => { await new Promise(r => setTimeout(r, 5100)); const r = await fetch(BASE + '/healthz'); return { status: r.status, body: await r.json() }; };

test.before(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server did not start');
});
test.after(() => { console.error = realError; db.close(); fs.rmSync(dir, { recursive: true, force: true }); setImmediate(() => process.exit(0)); });

test('a read-only database: reads still answer once, sign-in says storage is full, /healthz says not ok', async () => {
  const ann = await signIn();
  db.exec(`UPDATE sessions SET expires = ${Date.now() + 60000}`);   /* so the next request's touch has to write */
  const other = browser();
  await other('GET', '/auth/config');   /* its CSRF token, from before */
  db.exec('PRAGMA query_only = ON');
  try {
    logged.length = 0;
    for (let i = 0; i < 3; i++) assert.strictEqual((await ann('GET', '/api/me')).status, 200);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(!logged.some(l => /HEADERS_SENT|after the answer/.test(l)), logged.join('\n'));
    assert.strictEqual(logged.filter(l => /Session touch failed/.test(l)).length, 1, 'logged once a minute at most');
    const r = await other('POST', '/auth/login', { email: 'ann@example.com', password: PASSWORD });
    assert.deepStrictEqual([r.status, r.body && r.body.error], [507, 'The server’s storage is full – tell the person who runs this app'], 'sign-in');
    const h = await health();
    assert.deepStrictEqual([h.status, h.body.ok, h.body.db], [503, false, 'not writable']);
  } finally { db.exec('PRAGMA query_only = OFF'); }
  const h = await health();
  assert.deepStrictEqual([h.status, h.body], [200, { ok: true }]);
});

test('a full database disk is a 507 with a plain message, not "Something went wrong"', async () => {
  const ann = await signIn();
  db.exec(`PRAGMA max_page_count = ${db.prepare('PRAGMA page_count').get().page_count}`);
  try {
    const r = await ann('PUT', '/api/days/2026-09-01', { data: { meals: [], note: 'x'.repeat(60000) }, summary: {} });
    assert.deepStrictEqual([r.status, r.body.error], [507, 'The server’s storage is full – tell the person who runs this app']);
  } finally { db.exec('PRAGMA max_page_count = 1073741823'); }
});

test('/healthz says not ok when a disk it writes to has under 200 MB free', async () => {
  const was = storage.limits.low;
  storage.limits.low = Number.MAX_SAFE_INTEGER;
  try {
    const h = await health();
    assert.deepStrictEqual([h.status, h.body.ok, h.body.dbDisk, h.body.photoDisk], [503, false, 'low', 'low']);
  } finally { storage.limits.low = was; }
});

test('a photo write that fails part-way leaves no file and says storage is full; a delete that fails is tried again', async () => {
  const ann = await signIn();
  const write = fs.promises.writeFile;
  fs.promises.writeFile = async (file, bytes, opts) => {   /* writes half, then the disk is full */
    await write(file, bytes.subarray(0, bytes.length >> 1), opts);
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  };
  try {
    const r = await ann('POST', '/api/photos?date=2026-09-01&pose=front', jpeg('a'), true);
    assert.deepStrictEqual([r.status, r.body.error], [507, 'The server’s storage is full – tell the person who runs this app']);
  } finally { fs.promises.writeFile = write; }
  await new Promise(r => setTimeout(r, 100));
  assert.deepStrictEqual(files(), [], 'the partial file is removed');

  const p = (await ann('POST', '/api/photos?date=2026-09-01&pose=front', jpeg('b'), true)).body;
  assert.strictEqual(files().length, 1);
  const unlink = fs.promises.unlink;
  fs.promises.unlink = async () => { throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }); };
  try {
    assert.strictEqual((await ann('DELETE', `/api/photos/${p.id}`)).status, 200);
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(files().length, 1, 'still there');
    assert.strictEqual(photos.undeleted.size, 1, 'kept to try again');
  } finally { fs.promises.unlink = unlink; }
  photos.retryDeletes();
  await new Promise(r => setTimeout(r, 100));
  assert.deepStrictEqual([files(), photos.undeleted.size], [[], 0], 'gone on the next try');
});

test('storage.full knows the codes', () => {
  for (const e of [{ code: 'ENOSPC' }, { code: 'EROFS' }, { errcode: 13 }, { errcode: 8 }, { message: 'database or disk is full' }]) assert.ok(storage.full(e), JSON.stringify(e));
  for (const e of [{ code: 'ENOENT' }, { errcode: 19 }, null, new Error('x')]) assert.ok(!storage.full(e), JSON.stringify(e));
});

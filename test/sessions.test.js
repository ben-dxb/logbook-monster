'use strict';
/* Sessions and sign-in: signed-out visits store nothing, a session ends SESSION_DAYS after sign-in, a Google-only
   account adds a first password only soon after signing in, invites only work for accounts still waiting,
   create-user resets sign the account out, bad bodies get 400, and sign-out clears the site's data. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-sess-'));
const DB = path.join(dir, 't.db');
const PASSWORD = 'long-password-1';
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: DB, PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '', SMTP_PASS: '', MAIL_FROM: '', OPENROUTER_API_KEY: '' };
const createUser = (email, pw = PASSWORD) => execFileSync(process.execPath,
  ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', email], { cwd: root, env: { ...env, NEW_PASSWORD: pw }, stdio: 'ignore' });

let srv;
before(async () => {
  for (const who of ['adm', 'ann', 'bob']) createUser(`${who}@example.com`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { if (srv) srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const sql = (q, ...args) => { const db = new DatabaseSync(DB); try { return db.prepare(q)[/^\s*select/i.test(q) ? 'all' : 'run'](...args); } finally { db.close(); } };
const sessions = () => sql('SELECT COUNT(*) AS n FROM sessions')[0].n;
const userId = email => sql('SELECT id FROM users WHERE email = ?', email)[0].id;

/* a browser: keeps its cookie and CSRF token */
function browser() {
  let cookie = '', csrf = '';
  const c = async (method, url, body, { type, raw } = {}) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) };
    if (body !== undefined) headers['content-type'] = type || 'application/json';
    const r = await fetch(BASE + url, { method, redirect: 'manual', headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j, headers: r.headers };
  };
  c.raw = () => decodeURIComponent(cookie.split('=')[1] || '').replace(/^s:/, '').split('.')[0];
  c.sid = () => require('node:crypto').createHash('sha256').update(c.raw()).digest('hex');   /* the store keeps sha256(sid) */
  return c;
}
async function signIn(email, password = PASSWORD) {
  const c = browser();
  await c('GET', '/auth/config');
  assert.strictEqual((await c('POST', '/auth/login', { email, password })).status, 200, `sign in ${email}`);
  assert.strictEqual((await c('GET', '/api/me')).status, 200);
  return c;
}
const setSess = (c, path, v) => sql(`UPDATE sessions SET sess = json_set(sess, '${path}', ?) WHERE sid = ?`, v, c.sid());

test('signed-out visits store no session rows, and the sign-in page still works', async () => {
  const n = sessions();
  for (let i = 0; i < 40; i++) {
    await fetch(BASE + ['/auth/config', '/login', '/', '/api/me'][i % 4], { redirect: 'manual' });
  }
  const c = browser();
  for (let i = 0; i < 5; i++) await c('GET', '/auth/config');   /* the same browser coming back */
  assert.strictEqual(sessions(), n, 'no rows added');
  assert.strictEqual((await c('POST', '/auth/login', { email: 'ann@example.com', password: PASSWORD })).status, 200);
  assert.strictEqual(sessions(), n + 1);
  assert.strictEqual((await c('GET', '/api/me')).body.email, 'ann@example.com');
});

test('a signed-out CSRF token only works with its own cookie', async () => {
  const a = browser(), b = browser();
  const ta = (await a('GET', '/auth/config')).body.csrf;
  await b('GET', '/auth/config');
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': ta },
    body: JSON.stringify({ email: 'ann@example.com', password: PASSWORD }) });
  assert.strictEqual(r.status, 403, 'no cookie');
  const forged = browser();
  await forged('GET', '/auth/config');
  const r2 = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': ta,
    cookie: 'logbookmonster.pre=' + 'A'.repeat(43) }, body: JSON.stringify({ email: 'ann@example.com', password: PASSWORD }) });
  assert.strictEqual(r2.status, 403, 'someone else’s cookie');
});

test('a missing or non-JSON body answers 400', async () => {
  const c = browser();
  await c('GET', '/auth/config');
  for (const url of ['/auth/login', '/auth/register', '/auth/invite/check', '/auth/invite/accept']) {
    assert.strictEqual((await c('POST', url)).status, 400, url + ' with no body');
    assert.strictEqual((await c('POST', url, 'email=a', { type: 'text/plain', raw: true })).status, 400, url + ' as text');
    assert.strictEqual((await c('POST', url, '[1]', { raw: true })).status, 400, url + ' as an array');
  }
});

test('a session ends SESSION_DAYS (30) after sign-in, however often it is used', async () => {
  const c = await signIn('bob@example.com');
  setSess(c, '$.at', Date.now() - 29 * 86400000);
  assert.strictEqual((await c('GET', '/api/me')).status, 200, '29 days in');
  setSess(c, '$.at', Date.now() - 31 * 86400000);
  assert.strictEqual((await c('GET', '/api/me')).status, 401, '31 days in');
  assert.strictEqual(sql('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?', c.sid())[0].n, 0, 'the row is gone');
  const old = await signIn('bob@example.com');
  sql("UPDATE sessions SET sess = json_remove(sess, '$.at') WHERE sid = ?", old.sid());
  assert.strictEqual((await old('GET', '/api/me')).status, 401, 'a session from before sign-in times were kept');
});

test('sessions carry their account', async () => {
  const c = await signIn('bob@example.com');
  assert.strictEqual(sql('SELECT user_id FROM sessions WHERE sid = ?', c.sid())[0].user_id, userId('bob@example.com'));
});

test('a Google-only account adds a first password only within 10 minutes of signing in', async () => {
  sql("INSERT INTO users (email, google_sub, last_login_at) VALUES ('goo@example.com', 'sub-goo', datetime('now'))");
  const gid = userId('goo@example.com');
  /* stands in for a Google sign-in: a session moved onto the account */
  const c = await signIn('bob@example.com');
  sql("UPDATE sessions SET sess = json_set(sess, '$.userId', ?), user_id = ? WHERE sid = ?", gid, gid, c.sid());
  assert.strictEqual((await c('GET', '/api/me')).body.email, 'goo@example.com');
  setSess(c, '$.at', Date.now() - 11 * 60000);
  const late = await c('POST', '/auth/password', { next: 'google-password-1' });
  assert.strictEqual(late.status, 403);
  assert.match(late.body.error, /sign in with Google again/);
  assert.strictEqual(sql('SELECT password_hash FROM users WHERE id = ?', gid)[0].password_hash, null);
  setSess(c, '$.at', Date.now() - 2 * 60000);
  assert.strictEqual((await c('POST', '/auth/password', { next: 'google-password-1' })).status, 200);
  await signIn('goo@example.com', 'google-password-1');
});

const addInvite = (uid, token) => sql("INSERT INTO invites (token_hash, user_id, created_by, expires_at) VALUES (?, ?, 'adm@example.com', datetime('now', '+7 days'))",
  crypto.createHash('sha256').update(token).digest('hex'), uid);

test('an invite works only while its account is still waiting', async () => {
  const c = browser();
  await c('GET', '/auth/config');
  /* an account with a password already: the old link is refused and dropped */
  const tok = crypto.randomBytes(32).toString('base64url');
  addInvite(userId('ann@example.com'), tok);
  assert.strictEqual((await c('POST', '/auth/invite/check', { token: tok })).status, 404);
  assert.strictEqual((await c('POST', '/auth/invite/accept', { token: tok, password: 'taken-over-pw-1' })).status, 404);
  assert.strictEqual(sql('SELECT COUNT(*) AS n FROM invites WHERE user_id = ?', userId('ann@example.com'))[0].n, 0);
  await signIn('ann@example.com');   /* her password still works */
  /* a Google-linked account that never signed in is not waiting either */
  sql("INSERT INTO users (email, google_sub, invited_by) VALUES ('gl@example.com', 'sub-gl', 'adm@example.com')");
  const t2 = crypto.randomBytes(32).toString('base64url');
  addInvite(userId('gl@example.com'), t2);
  assert.strictEqual((await c('POST', '/auth/invite/accept', { token: t2, password: 'taken-over-pw-1' })).status, 404);
  /* a waiting account accepts */
  sql("INSERT INTO users (email, invited_by) VALUES ('new@example.com', 'adm@example.com')");
  const t3 = crypto.randomBytes(32).toString('base64url');
  addInvite(userId('new@example.com'), t3);
  assert.strictEqual((await c('POST', '/auth/invite/check', { token: t3 })).status, 200);
  assert.strictEqual((await c('POST', '/auth/invite/accept', { token: t3, password: 'new-password-1' })).status, 200);
  assert.strictEqual((await c('GET', '/api/me')).body.email, 'new@example.com');
});

test('an invite is taken once even when two accepts race (auth-code-011)', async () => {
  sql("INSERT INTO users (email, invited_by) VALUES ('race@example.com', 'adm@example.com')");
  const tok = crypto.randomBytes(32).toString('base64url');
  addInvite(userId('race@example.com'), tok);
  const a = browser(), b = browser();
  await a('GET', '/auth/config'); await b('GET', '/auth/config');
  const r = await Promise.all([a('POST', '/auth/invite/accept', { token: tok, password: 'rival-password-a' }),
    b('POST', '/auth/invite/accept', { token: tok, password: 'rival-password-b' })]);
  assert.deepStrictEqual(r.map(x => x.status).sort(), [200, 404]);
  const won = r[0].status === 200 ? a : b;
  assert.strictEqual((await won('GET', '/api/me')).body.email, 'race@example.com');
  assert.strictEqual((await (r[0].status === 200 ? b : a)('GET', '/api/me')).status, 401);
  await signIn('race@example.com', r[0].status === 200 ? 'rival-password-a' : 'rival-password-b');
});

test('create-user resetting a password signs the account out everywhere and drops its invites', async () => {
  createUser('rst@example.com');
  const a = await signIn('rst@example.com'), b = await signIn('rst@example.com');
  addInvite(userId('rst@example.com'), crypto.randomBytes(32).toString('base64url'));
  createUser('rst@example.com', 'reset-password-2');
  assert.strictEqual((await a('GET', '/api/me')).status, 401);
  assert.strictEqual((await b('GET', '/api/me')).status, 401);
  assert.strictEqual(sql('SELECT COUNT(*) AS n FROM invites WHERE user_id = ?', userId('rst@example.com'))[0].n, 0);
  await signIn('rst@example.com', 'reset-password-2');
});

test('sign-out clears the site’s cache and storage', async () => {
  const c = await signIn('bob@example.com');
  const r = await c('POST', '/auth/logout', {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('clear-site-data'), '"cache", "storage"');
  assert.strictEqual((await c('GET', '/api/me')).status, 401);
});

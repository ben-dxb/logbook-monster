'use strict';
/* Phase 2C admin, email and sign-in fixes: email settings keep .env values unless changed, account removal is one step,
   invited people trying to register, racing registrations, the per-address lock message, Google over the rate limit,
   and sessions of accounts that can no longer sign in. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [PORT, PORT2] = require('./_ports').freePorts(2);
const BASE = `http://127.0.0.1:${PORT}`, BASE2 = `http://127.0.0.1:${PORT2}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-fixes2c-admin-'));
const root = path.join(__dirname, '..');
const PHOTOS = path.join(dir, 'photos');
const common = { ...process.env, HOST: '127.0.0.1', SESSION_SECRET: 'x'.repeat(40), ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '', SMTP_HOST: '', SMTP_PORT: '', SMTP_SECURE: '', SMTP_USER: '', SMTP_PASS: '',
  MAIL_FROM: '', MAIL_FROM_NAME: '', SMTP_ALLOW_HOSTS: '' };
const env = { ...common, PORT: String(PORT), BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'), PHOTO_DIR: PHOTOS, AUTH_RATE_LIMIT: '1000',
  ACCOUNT_FAIL_LIMIT: '2', ALLOW_REGISTRATION: 'true', SMTP_HOST: '127.0.0.1', SMTP_ALLOW_HOSTS: '127.0.0.1', SMTP_PORT: '3125', SMTP_SECURE: 'true',
  MAIL_FROM: 'env-one@example.com' };
const env2 = { ...common, PORT: String(PORT2), BASE_URL: BASE2, DB_PATH: path.join(dir, 't2.db'), PHOTO_DIR: path.join(dir, 'photos2'), AUTH_RATE_LIMIT: '3',
  ALLOW_REGISTRATION: 'false', GOOGLE_CLIENT_ID: 'fake-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fake-secret' };
const servers = {};

async function start(e, name) {
  servers[name] = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env: e, stdio: 'ignore' });
  const base = `http://127.0.0.1:${e.PORT}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}
const stop = name => new Promise(r => { servers[name].once('exit', r); servers[name].kill(); });
const createUser = (e, email) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', email],
  { cwd: root, env: { ...e, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });

before(async () => {
  for (const who of ['admin', 'ann', 'locky']) createUser(env, `${who}@example.com`);
  createUser(env2, 'gone@example.com');
  await start(env, 'a'); await start(env2, 'b');
});
after(async () => { for (const n of Object.keys(servers)) servers[n].kill(); fs.rmSync(dir, { recursive: true, force: true }); });

/* a browser: keeps its cookie and CSRF token */
function client(base = BASE) {
  let cookie = '', csrf = '';
  const req = async (method, url, body) => {
    const r = await fetch(base + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j, location: r.headers.get('location') };
  };
  req.ready = () => req('GET', '/auth/config');
  return req;
}
async function signIn(email, base) {
  const c = client(base); await c.ready();
  assert.strictEqual((await c('POST', '/auth/login', { email, password: 'long-password-1' })).status, 200);
  await c('GET', '/api/me');
  return c;
}

test('email: saving one field keeps the others from .env, and the status says where each value comes from', async () => {
  let adm = await signIn('admin@example.com');
  let s = (await adm('GET', '/api/admin/email')).body;
  assert.deepStrictEqual([s.source, s.from, s.secure, s.sources.host, s.sources.from, s.sources.secure, s.sources.pass], ['env', 'env-one@example.com', true, 'env', 'env', 'env', null]);
  s = (await adm('PUT', '/api/admin/email', { pass: 'only-a-password' })).body;
  assert.deepStrictEqual([s.source, s.sources.pass, s.sources.host, s.sources.port, s.sources.secure, s.sources.from, s.secure],
    ['admin', 'admin', 'env', 'env', 'env', 'env', true]);
  /* a saved "from" with the server from .env is a saved setting (Remove saved settings shows) */
  s = (await adm('PUT', '/api/admin/email', { from: 'over@example.com' })).body;
  assert.deepStrictEqual([s.source, s.from, s.sources.from, s.sources.host], ['admin', 'over@example.com', 'admin', 'env']);
  s = (await adm('PUT', '/api/admin/email', { from: '' })).body;
  /* a later .env change is used for every field that wasn't saved */
  await stop('a'); env.MAIL_FROM = 'env-two@example.com'; env.SMTP_SECURE = 'false'; await start(env, 'a');
  adm = await signIn('admin@example.com');
  s = (await adm('GET', '/api/admin/email')).body;
  assert.deepStrictEqual([s.from, s.secure, s.sources.pass], ['env-two@example.com', false, 'admin']);
  /* the TLS choice is saved as given, whatever the port */
  s = (await adm('PUT', '/api/admin/email', { port: 2465, secure: true })).body;
  assert.deepStrictEqual([s.port, s.secure, s.sources.secure], [2465, true, 'admin']);
  await adm('PUT', '/api/admin/email', { from: '', fromName: '', host: '', port: '', secure: null, user: '', pass: '' });
});

test('removing an account: all its rows or none, files deleted after, a file that won’t delete is only logged', async () => {
  const adm = await signIn('admin@example.com');
  assert.strictEqual((await adm('POST', '/api/admin/users', { email: 'gone-photos@example.com' })).status, 200);
  const db = new DatabaseSync(env.DB_PATH);
  const id = db.prepare('SELECT id FROM users WHERE email = ?').get('gone-photos@example.com').id;
  fs.mkdirSync(PHOTOS, { recursive: true });
  fs.writeFileSync(path.join(PHOTOS, 'p1.jpg'), 'x'); fs.writeFileSync(path.join(PHOTOS, 'p1t.jpg'), 'x');
  fs.mkdirSync(path.join(PHOTOS, 'p2.jpg')); fs.writeFileSync(path.join(PHOTOS, 'p2.jpg', 'keep'), 'x');   /* a directory: unlink fails */
  const add = db.prepare("INSERT INTO photos (user_id, date, file, type, size, thumb) VALUES (?, '2026-01-01', ?, 'image/jpeg', 1, ?)");
  add.run(id, 'p1.jpg', 'p1t.jpg'); add.run(id, 'p2.jpg', null);
  /* a step after the account row fails: nothing is removed, files stay */
  db.exec("CREATE TRIGGER no_sess BEFORE DELETE ON sessions BEGIN SELECT RAISE(FAIL, 'boom'); END");
  db.prepare("INSERT INTO sessions (sid, sess, expires, user_id) VALUES (?, '{}', ?, ?)").run('f'.repeat(64), Date.now() + 1e6, id);
  assert.strictEqual((await adm('DELETE', `/api/admin/users/${id}`)).status, 500);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(id), 'the account is still there');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM photos WHERE user_id = ?').get(id).n, 2);
  assert.ok(fs.existsSync(path.join(PHOTOS, 'p1.jpg')));
  db.exec('DROP TRIGGER no_sess');
  /* then it goes through: 200 although one file can't be deleted */
  assert.strictEqual((await adm('DELETE', `/api/admin/users/${id}`)).status, 200);
  assert.ok(!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
  assert.ok(!db.prepare('SELECT 1 FROM sessions WHERE user_id = ?').get(id));
  for (let i = 0; i < 30 && fs.existsSync(path.join(PHOTOS, 'p1.jpg')); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(!fs.existsSync(path.join(PHOTOS, 'p1.jpg')) && !fs.existsSync(path.join(PHOTOS, 'p1t.jpg')));
  assert.strictEqual((await adm('DELETE', `/api/admin/users/${id}`)).status, 404);
  db.close();
});

test('register: an invited address is told to use the invite, and racing sign-ups for one email get 409, not 500', async () => {
  const adm = await signIn('admin@example.com');
  assert.strictEqual((await adm('POST', '/api/admin/users', { email: 'invited@example.com' })).status, 200);
  const c = client(); await c.ready();
  const r = await c('POST', '/auth/register', { email: 'invited@example.com', password: 'long-password-1' });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /invited – check your email for the invite/);
  assert.match((await c('POST', '/auth/register', { email: 'ann@example.com', password: 'long-password-1' })).body.error, /Sign in instead/);
  const cs = await Promise.all(Array.from({ length: 5 }, async () => { const x = client(); await x.ready(); return x; }));
  const out = await Promise.all(cs.map(x => x('POST', '/auth/register', { email: 'race@example.com', password: 'long-password-1' })));
  assert.deepStrictEqual(out.map(o => o.status).sort(), [200, 409, 409, 409, 409]);
});

test('a locked-out address is told to wait, even with the right password', async () => {
  const c = client(); await c.ready();
  for (let i = 0; i < 2; i++) assert.strictEqual((await c('POST', '/auth/login', { email: 'locky@example.com', password: 'wrong-password-1' })).status, 401);
  const r = await c('POST', '/auth/login', { email: 'locky@example.com', password: 'long-password-1' });
  assert.strictEqual(r.status, 429);
  assert.match(r.body.error, /Too many tries from here – wait 15 minutes/);
});

test('Google sign-in over the rate limit goes back to /login with a message', async () => {
  const c = client(BASE2); await c.ready();
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await c('GET', '/auth/google')).location);
  assert.ok(codes.slice(0, 3).every(l => l.startsWith('https://accounts.google.com/')), codes.join(' '));
  assert.strictEqual(codes[3], '/login?error=rate');
});

test('a session for an account no longer allowed is ended, and /login says why', async () => {
  const c = await signIn('gone@example.com', BASE2);
  await stop('b'); await start({ ...env2, ALLOWED_EMAILS: 'someone-else@example.com' }, 'b');
  const page = await c('GET', '/');
  assert.deepStrictEqual([page.status, page.location], [302, '/login?error=gone']);
  assert.strictEqual((await c('GET', '/login')).status, 200, 'no loop back to /');
  assert.strictEqual((await c('GET', '/auth/config')).body.signedIn, false);
  const c2 = await (async () => { await stop('b'); await start(env2, 'b'); const x = await signIn('gone@example.com', BASE2); await stop('b'); await start({ ...env2, ALLOWED_EMAILS: 'someone-else@example.com' }, 'b'); return x; })();
  const me = await c2('GET', '/api/me');
  assert.deepStrictEqual([me.status, me.body.gone], [401, true]);
  assert.match(me.body.error, /can’t sign in here any more/);
  assert.strictEqual((await c2('GET', '/login')).status, 200);
});

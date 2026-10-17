'use strict';
/* The legal minimum in the account area (Phase 5): deleting your own account (rows, photo files, sessions, the security log
   row, nobody else touched, the last super admin refused), the privacy page signed out with and without a contact, and the
   password rules (common, one repeated character, the email's name) on register, invite accept and password change. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { passwordProblem } = require('../server/passwords');

const [PORT, PORT2] = require('./_ports').freePorts(2);
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-account-'));
const DB = path.join(dir, 't.db'), PHOTO_DIR = path.join(dir, 'photos');
const PASSWORD = 'long-password-1';
const base = { ...process.env, HOST: '127.0.0.1', SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '',
  ALLOW_REGISTRATION: 'true', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '', SMTP_PASS: '', MAIL_FROM: '',
  OPENROUTER_API_KEY: '', PRIVACY_CONTACT: '', OPERATOR_NAME: '', SHOW_ADMIN_CONTACT: '' };
/* the main server: two super admins, a contact and an operator name */
const env = { ...base, PORT: String(PORT), BASE_URL: `http://127.0.0.1:${PORT}`, DB_PATH: DB, PHOTO_DIR,
  ADMIN_EMAILS: 'adm@example.com,adm2@example.com', PRIVACY_CONTACT: 'privacy@example.com', OPERATOR_NAME: 'Jo <Bloggs>' };
/* a second one with no contact set and a single super admin */
const dir2 = path.join(dir, 'two');
const env2 = { ...base, PORT: String(PORT2), BASE_URL: `http://127.0.0.1:${PORT2}`, DB_PATH: path.join(dir2, 't.db'), PHOTO_DIR: path.join(dir2, 'photos'),
  ADMIN_EMAILS: 'solo@example.com' };

const createUser = (e, email) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', email],
  { cwd: root, env: { ...e, NEW_PASSWORD: PASSWORD }, stdio: 'ignore' });
const start = async e => {
  const s = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env: e, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(e.BASE_URL + '/healthz')).ok) return s; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
};
let srv, srv2;
before(async () => {
  fs.mkdirSync(dir2, { recursive: true });
  for (const who of ['adm', 'adm2', 'ann', 'bob']) createUser(env, `${who}@example.com`);
  createUser(env2, 'solo@example.com');
  [srv, srv2] = await Promise.all([start(env), start(env2)]);
});
after(() => { for (const s of [srv, srv2]) if (s) s.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const sql = (q, ...args) => { const db = new DatabaseSync(DB); try { return db.prepare(q)[/^\s*select/i.test(q) ? 'all' : 'run'](...args); } finally { db.close(); } };
const userId = email => (sql('SELECT id FROM users WHERE email = ?', email)[0] || {}).id;

function browser(url = env.BASE_URL) {
  let cookie = '', csrf = '';
  const c = async (method, p, body, o = {}) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(csrf && o.csrf !== false ? { 'x-csrf-token': csrf } : {}) };
    if (body !== undefined) headers['content-type'] = o.type || 'application/json';
    const r = await fetch(url + p, { method, redirect: 'manual', headers, body: body === undefined ? undefined : o.raw ? body : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc && !/=;/.test(sc.split(';')[0])) cookie = sc.split(';')[0];
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j, text, headers: r.headers };
  };
  c.sid = () => crypto.createHash('sha256').update(decodeURIComponent(cookie.split('=')[1] || '').replace(/^s:/, '').split('.')[0]).digest('hex');
  return c;
}
async function signIn(email, url) {
  const c = browser(url);
  await c('GET', '/auth/config');
  assert.strictEqual((await c('POST', '/auth/login', { email, password: PASSWORD })).status, 200, 'sign in ' + email);
  await c('GET', '/api/me');
  return c;
}
const jpeg = tag => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('account-jpeg-' + tag + '-'.repeat(40)), Buffer.from([0xff, 0xd9])]);
const upload = (c, tag) => c('POST', '/api/photos?date=2026-09-10&pose=front', jpeg(tag), { type: 'image/jpeg', raw: true });

/* every table with a user_id column: how many rows the account has there */
function rowsOf(id) {
  const db = new DatabaseSync(DB);
  try {
    const out = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      if (name === 'audit') continue;
      if (db.prepare(`PRAGMA table_info("${name}")`).all().some(c => c.name === 'user_id')) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE user_id = ?`).get(id).n;
        if (n) out[name] = n;
      }
    }
    out.users = db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(id).n;
    return out;
  } finally { db.close(); }
}

test('deleting your own account: everything goes, the session ends, it is logged, nobody else is touched', async () => {
  const ann = await signIn('ann@example.com'), other = await signIn('ann@example.com'), bob = await signIn('bob@example.com');
  const ok = async (p, what) => { const r = await p; assert.strictEqual(r.status, 200, what + ': ' + r.text.slice(0, 200)); return r.body; };
  await ok(ann('PUT', '/api/weights/2026-09-10', { kg: 81 }), 'weight');
  await ok(ann('PUT', '/api/days/2026-09-10', { data: { meals: [], off: [] }, summary: { k: 1 } }), 'day');
  await ok(ann('POST', '/api/foods', { name: 'ann shared food', unit: 'g', k: 100, p: 1, c: 1, f: 1, public: true }), 'food');
  await ok(ann('POST', '/api/supps', { name: 'ann supp', amount: 1, unit: 'g' }), 'supp');
  await ok(ann('POST', '/api/gym/exercises', { name: 'ann squat' }), 'exercise');
  await ok(ann('POST', '/api/shares', { label: 'coach', expires: new Date(Date.now() + 86400000).toISOString() }), 'share');
  const p = await ok(upload(ann, 'a'), 'photo');
  await ok(ann('PUT', `/api/photos/${p.id}/thumb`, jpeg('t'), { type: 'image/jpeg', raw: true }), 'thumb');
  await ok(bob('PUT', '/api/weights/2026-09-10', { kg: 90 }), 'bob weight');
  await ok(upload(bob, 'b'), 'bob photo');
  const A = userId('ann@example.com'), B = userId('bob@example.com');
  const files = sql('SELECT file, thumb FROM photos WHERE user_id = ?', A).flatMap(r => [r.file, r.thumb]).filter(Boolean);
  assert.ok(files.length >= 2 && files.every(f => fs.existsSync(path.join(PHOTO_DIR, f))));
  const bobBefore = JSON.stringify(rowsOf(B)), bobFiles = fs.readdirSync(PHOTO_DIR).filter(f => !files.includes(f)).sort();
  assert.ok(Object.keys(rowsOf(A)).length > 5);

  /* refused: no CSRF token, the wrong email, an old sign-in without the re-check */
  assert.strictEqual((await ann('DELETE', '/api/my/account', { email: 'ann@example.com' }, { csrf: false })).status, 403);
  assert.strictEqual((await ann('DELETE', '/api/my/account', { email: 'bob@example.com' })).status, 400);
  assert.strictEqual((await ann('DELETE', '/api/my/account', {})).status, 400);
  sql("UPDATE sessions SET sess = json_set(sess, '$.at', ?) WHERE sid = ?", Date.now() - 16 * 60 * 1000, ann.sid());
  let r = await ann('DELETE', '/api/my/account', { email: 'ann@example.com' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.recheck, true);
  assert.strictEqual(rowsOf(A).users, 1, 'still there');
  assert.strictEqual((await ann('POST', '/api/recheck', { password: PASSWORD })).status, 200);

  r = await ann('DELETE', '/api/my/account', { email: ' ANN@example.com ' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.headers.get('clear-site-data'), '"cache", "storage"');
  assert.deepStrictEqual(rowsOf(A), { users: 0 }, 'no row of the account is left');
  /* the files are removed just after the answer (fire-and-forget unlinks): give them a moment under a loaded test run */
  for (let i = 0; i < 40 && files.some(f => fs.existsSync(path.join(PHOTO_DIR, f))); i++) await new Promise(r => setTimeout(r, 50));
  for (const f of files) assert.ok(!fs.existsSync(path.join(PHOTO_DIR, f)), 'photo file gone: ' + f);
  assert.strictEqual((await ann('GET', '/api/me')).status, 401, 'this session is dead');
  assert.strictEqual((await other('GET', '/api/me')).status, 401, 'and every other one');
  const log = sql("SELECT * FROM audit WHERE event = 'account.deleted' AND user_id = ?", A);
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].actor_id, A);
  assert.strictEqual(JSON.parse(log[0].detail).email, 'a***@example.com');
  assert.strictEqual(JSON.stringify(rowsOf(B)), bobBefore, 'bob untouched');
  assert.deepStrictEqual(fs.readdirSync(PHOTO_DIR).sort(), bobFiles, 'bob’s files untouched');
  assert.strictEqual((await bob('GET', '/api/me')).status, 200);
  assert.ok(!(await bob('GET', '/api/foods')).text.includes('ann shared food'), 'her shared food left bob’s library');
  const cfg = browser(); await cfg('GET', '/auth/config');
  assert.strictEqual((await cfg('POST', '/auth/login', { email: 'ann@example.com', password: PASSWORD })).status, 401);
});

test('a super admin may delete their account only while another super admin has one', async () => {
  const adm = await signIn('adm@example.com');
  assert.strictEqual((await adm('DELETE', '/api/my/account', { email: 'adm@example.com' })).status, 200, 'adm2 is still there');
  const adm2 = await signIn('adm2@example.com');
  const r = await adm2('DELETE', '/api/my/account', { email: 'adm2@example.com' });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /only super admin.*ADMIN_EMAILS/);
  assert.strictEqual(rowsOf(userId('adm2@example.com')).users, 1);
  assert.strictEqual((await adm2('GET', '/api/me')).status, 200);
  const solo = await signIn('solo@example.com', env2.BASE_URL);
  assert.strictEqual((await solo('DELETE', '/api/my/account', { email: 'solo@example.com' })).status, 409);
});

test('the privacy page opens signed out, names the operator and the contact, or says to ask', async () => {
  let r = await fetch(env.BASE_URL + '/privacy', { redirect: 'manual' });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('cache-control'), /no-cache/);
  let html = await r.text();
  assert.match(html, /run by Jo &#60;Bloggs&#62;\./, 'the name, escaped');
  assert.match(html, /<a href="mailto:privacy@example\.com">privacy@example\.com<\/a>/);
  assert.match(html, /180 days/);
  assert.doesNotMatch(html, /<script|style=/);
  assert.strictEqual((await fetch(env.BASE_URL + '/privacy.html', { redirect: 'manual' })).headers.get('location'), '/privacy');
  const c = browser(); assert.strictEqual((await c('GET', '/auth/config')).body.contact, 'privacy@example.com');
  for (const p of ['/login', '/invite']) assert.match(await (await fetch(env.BASE_URL + p)).text(), /href="\/privacy"/, p);

  r = await fetch(env2.BASE_URL + '/privacy');
  html = await r.text();
  assert.strictEqual(r.status, 200);
  assert.match(html, /run by the person who runs this app/);
  assert.match(html, /Ask the person who runs this app/);
  assert.doesNotMatch(html, /mailto:/);
  const c2 = browser(env2.BASE_URL); assert.strictEqual((await c2('GET', '/auth/config')).body.contact, '');
});

test('passwords: common ones, one repeated character and the email’s name are refused; length 10–200 stays', async () => {
  assert.match(passwordProblem('aaaaaaaaaa'), /one character over and over/);
  assert.match(passwordProblem('ZZZZZZZZZZZZ'), /one character over and over/);
  assert.match(passwordProblem('1234567890'), /most used/);
  assert.match(passwordProblem('Basketball'), /most used/, 'any case');
  assert.match(passwordProblem('qwertyuiop'), /most used/);
  assert.match(passwordProblem('jamesbond-2026', 'jamesbond@example.com'), /email/);
  assert.match(passwordProblem('my-Jamesbond!', 'jamesbond+gym@example.com'), /email/);
  assert.strictEqual(passwordProblem('plan-ann-meals', 'ann@example.com'), null, 'a short name of 3 letters is not checked');
  assert.match(passwordProblem('short'), /at least 10/);
  assert.match(passwordProblem('x'.repeat(199) + 'y'.repeat(2)), /too long/);
  assert.strictEqual(passwordProblem('correct horse battery'), null);

  const reg = browser(); await reg('GET', '/auth/config');
  for (const pw of ['aaaaaaaaaa', 'password123', 'newperson-is-me']) {
    const r = await reg('POST', '/auth/register', { email: 'newperson@example.com', password: pw });
    assert.strictEqual(r.status, 400, pw);
  }
  assert.strictEqual(userId('newperson@example.com'), undefined);

  const adm2 = await signIn('adm2@example.com');
  const inv = await adm2('POST', '/api/admin/users', { email: 'invitee@example.com' });
  assert.strictEqual(inv.status, 200, inv.text);
  const token = inv.body.link.split('#')[1], ic = browser(); await ic('GET', '/auth/config');
  for (const pw of ['bbbbbbbbbbbb', 'iloveyou12', 'invitee-password']) {
    assert.strictEqual((await ic('POST', '/auth/invite/accept', { token, password: pw })).status, 400, pw);
  }
  assert.strictEqual((await ic('POST', '/auth/invite/accept', { token, password: 'a fine pass phrase' })).status, 200);

  const bob = await signIn('bob@example.com');
  for (const pw of ['cccccccccc', 'qwertyuiop', '1q2w3e4r5t']) {
    assert.strictEqual((await bob('POST', '/auth/password', { current: PASSWORD, next: pw })).status, 400, pw);
  }
});

test('a password change ends coach links only when asked (endLinks: true)', async () => {
  const c = browser(); await c('GET', '/auth/config');
  assert.strictEqual((await c('POST', '/auth/register', { email: 'links@example.com', password: PASSWORD })).status, 200);
  await c('GET', '/api/me');
  const link = (await c('POST', '/api/shares', { label: 'Coach Sam', expires: new Date(Date.now() + 86400000).toISOString() })).body.url;
  let r = await c('POST', '/auth/password', { current: PASSWORD, next: 'second-long-pass' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.linksOff, 0, 'field left out: links kept');
  assert.strictEqual((await fetch(link + '/api/info')).status, 200);
  r = await c('POST', '/auth/password', { current: 'second-long-pass', next: 'third-long-pass', endLinks: 'yes' });
  assert.strictEqual(r.body.linksOff, 0, 'only true ends them');
  r = await c('POST', '/auth/password', { current: 'third-long-pass', next: 'fourth-long-pass', endLinks: true });
  assert.strictEqual(r.body.linksOff, 1);
  assert.strictEqual((await fetch(link + '/api/info')).status, 404);
  assert.strictEqual((await c('POST', '/auth/password', { current: 'fourth-long-pass', next: 'my-LINKS-pass' })).status, 400, 'the email’s name');
});

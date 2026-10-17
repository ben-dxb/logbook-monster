'use strict';
/* The security log (server/audit.js): each security event writes one row, no row holds a password, key, token, cookie or
   full email, only the super admin reads the whole log, each account reads its own, old rows are pruned and each
   account's rows are capped. Also redact() for anything that logs a URL. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [PORT, DEAD_PORT] = require('./_ports').freePorts(2);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-audit-'));
const DB = path.join(dir, 't.db');
const PASSWORD = 'long-password-1', NEW_PASSWORD = 'audit-new-password-7';
const ENV_KEY = 'sk-or-env-audit-key-5555', AI_KEY = 'sk-or-audit-secret-key-1234', SMTP_PASS = 'smtp-secret-pass-99';
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: DB, PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '', SMTP_PASS: '', MAIL_FROM: '', ACCOUNT_FAIL_LIMIT: '3',
  AUDIT_ALERT_FAILS: '2', AUDIT_PER_ACCOUNT: '40', OPENROUTER_API_KEY: ENV_KEY, OPENROUTER_BASE_URL: `http://127.0.0.1:${DEAD_PORT}` };
let srv, logs = '';
const secrets = [PASSWORD, NEW_PASSWORD, ENV_KEY, AI_KEY, SMTP_PASS, 'wrong-password-3'];

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
before(async () => {
  /* adm first: with ADMIN_EMAILS empty the first account is the super admin */
  for (const who of ['adm', 'ann', 'bob', 'cat']) {
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', `${who}@example.com`],
      { cwd: root, env: { ...env, NEW_PASSWORD: PASSWORD }, stdio: 'ignore' });
  }
  /* rows from before this start: one past the 180 days, one inside them */
  const w = new DatabaseSync(DB);
  const add = w.prepare("INSERT INTO audit (at, user_id, actor_id, event, detail) VALUES (?, 2, 2, ?, '{}')");
  add.run(daysAgo(200), 'signin.ok');
  add.run(daysAgo(10), 'signout');
  /* cat (id 4) already has 45 rows; AUDIT_PER_ACCOUNT is 40, so cat's next event trims them */
  for (let i = 0; i < 45; i++) w.prepare("INSERT INTO audit (at, user_id, actor_id, event, detail) VALUES (?, 4, 4, 'signout', '{}')").run(daysAgo(5));
  w.close();
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { logs += d; });
  srv.stderr.on('data', d => { logs += d; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const cookies = [], csrfs = [];
function client() {
  let cookie = '', csrf = '';
  const c = async (method, url, body) => {
    const raw = body && Buffer.isBuffer(body.raw);
    const r = await fetch(url.startsWith('http') ? url : BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': raw ? body.type : 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body ? (raw ? body.raw : JSON.stringify(body)) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) { cookie = sc.split(';')[0]; cookies.push(cookie.split('=')[1]); }
    const j = await r.json().catch(() => null);
    if (j && j.csrf) { csrf = j.csrf; csrfs.push(csrf); }
    return { status: r.status, body: j };
  };
  return c;
}
async function signIn(email, password = PASSWORD) {
  const c = client();
  await c('GET', '/auth/config');
  const r = await c('POST', '/auth/login', { email, password });
  assert.strictEqual(r.status, 200, `sign in ${email}`);
  await c('GET', '/api/me');
  return c;
}
async function tryLogin(email, password) {
  const c = client();
  await c('GET', '/auth/config');
  return (await c('POST', '/auth/login', { email, password })).status;
}
const rows = (where = '1', ...args) => {
  const db = new DatabaseSync(DB, { readOnly: true });
  const out = db.prepare(`SELECT * FROM audit WHERE ${where} ORDER BY id`).all(...args).map(r => ({ ...r, detail: JSON.parse(r.detail) }));
  db.close();
  return out;
};
const idOf = email => { const db = new DatabaseSync(DB, { readOnly: true }); const r = db.prepare('SELECT id FROM users WHERE email = ?').get(email); db.close(); return r && r.id; };
const last = (event, uid) => rows(uid === undefined ? 'event = ?' : 'event = ? AND user_id IS ?', ...(uid === undefined ? [event] : [event, uid])).pop();
const jpeg = { raw: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40), Buffer.from([0xff, 0xd9])]), type: 'image/jpeg' };

let adm, ann, ADM, ANN, BOB, coachToken;

test('rows past 180 days are pruned on start; newer ones stay', () => {
  ANN = idOf('ann@example.com');
  assert.strictEqual(ANN, 2);
  assert.deepStrictEqual(rows('user_id = 2').map(r => r.event), ['signout']);
});

test('sign-ins: ok, failed (email masked), locked; sign-out; password change', async () => {
  ADM = idOf('adm@example.com'); BOB = idOf('bob@example.com');
  ann = await signIn('ann@example.com');
  let r = last('signin.ok', ANN);
  assert.strictEqual(r.actor_id, ANN);
  assert.deepStrictEqual(r.detail, { via: 'password' });
  assert.strictEqual(r.ip, '127.0.0.1');

  assert.strictEqual(await tryLogin('ann@example.com', 'wrong-password-3'), 401);
  r = last('signin.failed', ANN);
  assert.strictEqual(r.actor_id, null);
  assert.strictEqual(r.detail.email, 'a***@example.com');
  assert.match(r.detail.eh, /^[0-9a-f]{12}$/);

  assert.strictEqual(await tryLogin('nobody-here@example.com', 'wrong-password-3'), 401);
  r = last('signin.failed', null);
  assert.strictEqual(r.detail.email, 'n***@example.com');

  /* ACCOUNT_FAIL_LIMIT=3: two more wrong passwords for bob, then even the right one is refused and logged as locked */
  for (let i = 0; i < 3; i++) await tryLogin('bob@example.com', 'wrong-password-3');
  assert.strictEqual(await tryLogin('bob@example.com', PASSWORD), 401);
  assert.strictEqual(rows('event = ? AND user_id = ?', 'signin.failed', BOB).length, 3);
  assert.strictEqual(last('signin.locked', BOB).detail.email, 'b***@example.com');
  assert.match(logs, /Sign-in failed for a\*\*\*@example\.com from 127\.0\.0\.1/);
  assert.match(logs, /Sign-in refused \(account locked\) for b\*\*\*@example\.com/);

  const s2 = await signIn('ann@example.com');
  await s2('POST', '/api/shares', { label: 'pw', expires: daysAgo(-7) });
  const p = await ann('POST', '/auth/password', { current: PASSWORD, next: NEW_PASSWORD });
  assert.strictEqual(p.status, 200);
  r = last('password.changed', ANN);
  assert.deepStrictEqual(r.detail, { signedOut: 1, linksOff: 1 });
  assert.strictEqual(r.actor_id, ANN);

  const out = await signIn('ann@example.com', NEW_PASSWORD);
  assert.strictEqual((await out('POST', '/auth/logout', {})).status, 200);
  assert.strictEqual(last('signout', ANN).actor_id, ANN);
});

test('invites, account removal and super admin settings', async () => {
  adm = await signIn('adm@example.com');
  const inv = await adm('POST', '/api/admin/users', { email: 'dee@example.com', name: 'Dee' });
  assert.strictEqual(inv.status, 200);
  const DEE = inv.body.id;
  let r = last('invite.created', DEE);
  assert.strictEqual(r.actor_id, ADM);
  assert.strictEqual(r.detail.email, 'd***@example.com');
  assert.strictEqual((await adm('POST', `/api/admin/users/${DEE}/invite`)).status, 200);
  const link = (await adm('POST', `/api/admin/users/${DEE}/invite`)).body.link;
  assert.strictEqual(last('invite.created', DEE).detail.resent, true);

  const dee = client();
  await dee('GET', '/auth/config');
  assert.strictEqual((await dee('POST', '/auth/invite/accept', { token: link.split('#')[1], password: PASSWORD })).status, 200);
  assert.strictEqual(last('invite.accepted', DEE).actor_id, DEE);

  assert.strictEqual((await adm('DELETE', `/api/admin/users/${DEE}`)).status, 200);
  r = last('account.removed', DEE);
  assert.strictEqual(r.actor_id, ADM, 'who removed it');
  assert.strictEqual(r.detail.email, 'd***@example.com');

  assert.strictEqual((await adm('PUT', '/api/admin/ai', { key: AI_KEY })).status, 200);
  assert.deepStrictEqual(last('ai.settings').detail, { apiKey: 'set' });
  assert.strictEqual((await adm('PUT', '/api/admin/ai', { key: '', model: 'x/y', models: { food: 'a/b' } })).status, 200);
  assert.deepStrictEqual(last('ai.settings').detail, { apiKey: 'cleared', model: true, tasks: ['food'] });

  assert.strictEqual((await adm('PUT', '/api/admin/email', { host: 'smtp.example.com', user: 'u@example.com', pass: SMTP_PASS, from: 'u@example.com' })).status, 200);
  assert.deepStrictEqual(last('email.settings').detail, { fields: ['host', 'user', 'pass', 'from'] });
  assert.strictEqual((await adm('PUT', '/api/admin/email', { host: '', user: '', pass: '', from: '' })).status, 200);

  assert.strictEqual((await adm('PUT', '/api/admin/options', { planFiles: false, aiDailyUser: 1 })).status, 200);
  assert.deepStrictEqual(last('options.changed').detail, { planFiles: false, aiDailyUser: 1 });
});

test('export, day / checklist / photo deletes, shared items removed by the super admin, AI cap', async () => {
  ann = await signIn('ann@example.com', NEW_PASSWORD);
  assert.strictEqual((await ann('GET', '/api/export')).status, 200);
  assert.ok(last('export', ANN));

  const day = { data: { meals: [], off: [] }, summary: { k: 1 } };
  assert.strictEqual((await ann('PUT', '/api/days/2026-09-10', day)).status, 200);
  assert.strictEqual((await ann('DELETE', '/api/days/2026-09-10')).status, 200);
  assert.deepStrictEqual(last('day.deleted', ANN).detail, { date: '2026-09-10' });
  await ann('DELETE', '/api/days/2026-09-11');
  assert.strictEqual(rows("event = 'day.deleted'").length, 1, 'deleting nothing logs nothing');

  assert.strictEqual((await ann('PUT', '/api/checklist', { items: [{ id: 'a', label: 'A', show: 'all', auto: '' }] })).status, 200);
  assert.strictEqual((await ann('DELETE', '/api/checklist')).status, 200);
  assert.ok(last('checklist.reset', ANN));

  assert.strictEqual((await ann('POST', '/api/photos?date=2026-09-10&pose=front&note=audit%20private%20note', jpeg)).status, 200);
  assert.strictEqual((await ann('DELETE', '/api/photos?from=2026-09-01&to=2026-09-30')).status, 200);
  assert.deepStrictEqual(last('photos.deleted', ANN).detail, { from: '2026-09-01', to: '2026-09-30', n: 1 });

  const food = (await ann('POST', '/api/foods', { name: 'audit shared oats', unit: 'g', k: 380, p: 13, c: 60, f: 7, public: true })).body;
  const supp = (await ann('POST', '/api/supps', { name: 'audit shared creatine', amount: 5, unit: 'g', public: true })).body;
  assert.strictEqual((await adm('DELETE', `/api/foods/${food.id}`)).status, 200);
  assert.strictEqual((await adm('DELETE', `/api/supps/${supp.id}`)).status, 200);
  let r = last('food.removed', ANN);
  assert.strictEqual(r.actor_id, ADM);
  assert.deepStrictEqual(r.detail, { id: food.id, name: 'audit shared oats' });
  assert.strictEqual(last('supp.removed', ANN).actor_id, ADM);
  const own = (await ann('POST', '/api/foods', { name: 'audit own', unit: 'g', k: 1, p: 1, c: 1, f: 1 })).body;
  await ann('DELETE', `/api/foods/${own.id}`);
  assert.strictEqual(rows("event = 'food.removed'").length, 1, 'removing your own food is not a security event');

  /* aiDailyUser is 1 (set above) and ann has used it today */
  const w = new DatabaseSync(DB);
  w.prepare('INSERT INTO ai_usage (user_id, day, calls) VALUES (?, ?, 1)').run(ANN, new Date().toISOString().slice(0, 10));
  w.close();
  for (let i = 0; i < 2; i++) assert.strictEqual((await ann('POST', '/api/foods/ai-fill', { name: 'oats', unit: 'g', kind: 'ingredient' })).status, 429);
  assert.deepStrictEqual(rows("event = 'ai.cap'").map(x => [x.user_id, x.detail.cap]), [[ANN, 'account']], 'once a day');
});

test('coach links: made, first use each day, switched off', async () => {
  const made = (await ann('POST', '/api/shares', { label: 'Coach', expires: daysAgo(-7) })).body;
  coachToken = made.url.split('/').pop();
  assert.deepStrictEqual(last('coach.created', ANN).detail, { id: made.id, expires: made.expires });
  for (let i = 0; i < 3; i++) assert.strictEqual((await fetch(made.url + '/api/info')).status, 200);
  await fetch(made.url + '/api/weights');
  const used = rows("event = 'coach.used'");
  assert.strictEqual(used.length, 1, 'one row a day');
  assert.strictEqual(used[0].user_id, ANN);
  assert.strictEqual(used[0].actor_id, null);
  assert.deepStrictEqual(used[0].detail, { id: made.id });
  assert.strictEqual((await ann('DELETE', `/api/shares/${made.id}?key=${made.key}`)).status, 200);
  assert.deepStrictEqual(last('coach.off', ANN).detail, { id: made.id });
});

test('failed sign-ins on a super admin account raise one alert', async () => {
  for (let i = 0; i < 2; i++) await tryLogin('adm@example.com', 'wrong-password-3');
  const a = rows("event = 'signin.alert'");
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].user_id, ADM);
  assert.strictEqual(a[0].detail.n, 2);
  await tryLogin('adm@example.com', 'wrong-password-3');
  assert.strictEqual(rows("event = 'signin.alert'").length, 1, 'not again within the 15 minutes');
  assert.strictEqual(rows("event = 'signin.alert' AND user_id = ?", ANN).length, 0);
});

test('only the super admin reads the whole log; everyone reads their own account’s', async () => {
  assert.strictEqual((await ann('GET', '/api/admin/log')).status, 403);
  const all = await adm('GET', '/api/admin/log');
  assert.strictEqual(all.status, 200);
  assert.ok(all.body.rows.length > 10);
  assert.ok(all.body.rows[0].id > all.body.rows[1].id, 'newest first');
  const rem = all.body.rows.find(r => r.event === 'account.removed');
  assert.deepStrictEqual([rem.actor.email, rem.user.email], ['adm@example.com', null]);

  const f = (await adm('GET', `/api/admin/log?event=signin.failed&user=${BOB}`)).body.rows;
  assert.strictEqual(f.length, 3);
  assert.ok(f.every(r => r.event === 'signin.failed' && r.user.id === BOB));

  const mine = (await ann('GET', '/api/my/log')).body.rows;
  assert.ok(mine.length > 5);
  const ids = new Set(rows('user_id = ?', ANN).map(r => r.id));
  assert.ok(mine.every(r => ids.has(r.id)), 'only ann’s rows');
  for (const ev of ['signin.ok', 'signin.failed', 'password.changed', 'coach.used', 'export']) assert.ok(mine.some(r => r.event === ev), ev);
  assert.ok(!mine.some(r => ['food.removed', 'ai.cap', 'day.deleted'].includes(r.event)), 'own view shows the sign-in and link events only');
  const cat = await signIn('cat@example.com');
  const catRows = (await cat('GET', '/api/my/log')).body.rows;
  assert.strictEqual(catRows[0].event, 'signin.ok');
  assert.ok(!catRows.some(r => ids.has(r.id)), 'none of ann’s');
});

test('pages: 50 at a time, with a cursor', async () => {
  const p1 = (await adm('GET', '/api/admin/log')).body;
  assert.strictEqual(p1.rows.length, 50);
  const p2 = (await adm('GET', `/api/admin/log?before=${p1.next}`)).body;
  assert.ok(p2.rows.length > 0 && p2.rows[0].id < p1.rows[49].id);
});

test('each account keeps at most AUDIT_PER_ACCOUNT rows, dropping the oldest', () => {
  assert.strictEqual(idOf('cat@example.com'), 4);
  const cat = rows('user_id = 4');
  assert.strictEqual(cat.length, 40);
  assert.strictEqual(cat[cat.length - 1].event, 'signin.ok');
});

test('two-step sign-in: on, code asked, wrong / right code, recovery code, re-check, off', async () => {
  const totp = require('../server/totp');
  const CAT = idOf('cat@example.com'), ev = () => rows('user_id = ? AND id > ?', CAT, mark).map(r => r.event);
  const mark = rows().pop().id;
  const cat = await signIn('cat@example.com');
  const key = totp.fromBase32((await cat('POST', '/api/totp/setup', {})).body.secret), code = n => totp.totp(key, Date.now() + n * 30000);
  const on = await cat('POST', '/api/totp/enable', { code: code(-1) });
  assert.strictEqual(on.status, 200);
  const half = async () => { const c = client(); await c('GET', '/auth/config'); assert.strictEqual((await c('POST', '/auth/login', { email: 'cat@example.com', password: PASSWORD })).body.second, true); return c; };
  let c = await half();
  assert.strictEqual((await c('POST', '/auth/second', { code: '000000' })).status, 401);
  assert.strictEqual((await c('POST', '/auth/second', { code: code(0) })).status, 200);
  c = await half();
  assert.strictEqual((await c('POST', '/auth/second', { code: on.body.codes[0] })).status, 200);
  await c('GET', '/api/me');
  assert.strictEqual((await c('POST', '/api/recheck', { password: 'wrong-password-3' })).status, 400);
  assert.strictEqual((await c('POST', '/api/recheck', { password: PASSWORD })).status, 200);
  assert.strictEqual((await c('POST', '/api/totp/disable', { password: PASSWORD })).status, 200);
  assert.deepStrictEqual(ev(), ['signin.ok', 'twostep.on', 'second.asked', 'second.failed', 'signin.ok', 'second.asked', 'recovery.used',
    'recheck.failed', 'recheck.ok', 'recheck.ok', 'twostep.off']);
  assert.deepStrictEqual(rows("event = 'signin.ok' AND user_id = ? AND id > ?", CAT, mark).pop().detail, { via: 'second' });
  secrets.push(on.body.codes[0], totp.base32(key));
});

test('no row holds a password, key, token, cookie, photo note or full email', () => {
  const dump = JSON.stringify(rows());
  for (const s of [...secrets, coachToken, ...cookies, ...csrfs, 'audit private note'].filter(Boolean)) assert.ok(!dump.includes(s), 'leaked: ' + s.slice(0, 12));
  for (const e of ['adm', 'ann', 'bob', 'cat', 'dee', 'nobody-here']) assert.ok(!dump.includes(`${e}@example.com`), e);
  for (const s of [...secrets, coachToken]) assert.ok(!logs.includes(s), 'in the server log: ' + s.slice(0, 12));
});

test('redact() drops coach secrets and query strings from logged URLs', () => {
  process.env.DB_PATH = path.join(dir, 'unit.db');
  process.env.SESSION_SECRET = 'y'.repeat(40);
  const { redact } = require('../server/audit');
  assert.strictEqual(redact('/coach/AbC_-123/api/photos/4/file?x=1'), '/coach/REDACTED/api/photos/4/file');
  assert.strictEqual(redact('https://h.example/coach/AbC'), 'https://h.example/coach/REDACTED');
  assert.strictEqual(redact('/api/photos?date=2026-01-01&note=private'), '/api/photos');
  assert.strictEqual(redact('/invite#token'), '/invite');
  assert.strictEqual(redact(undefined), '');
});

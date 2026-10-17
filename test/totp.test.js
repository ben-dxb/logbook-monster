'use strict';
/* The second sign-in step: RFC 6238 vectors, setting it up, the two-step sign-in (the half-signed-in session reaches no
   /api route), recovery codes work once, a code can't be replayed, wrong codes are limited per account, the
   "super admins must use a second step" option, and the password-or-code re-check before sensitive admin changes. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const totp = require('../server/totp');

const [PORT, SMTP_PORT] = require('./_ports').freePorts(2);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-totp-'));
const DB = path.join(dir, 't.db');
const PASSWORD = 'long-password-1';
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: DB, PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: 'y'.repeat(40), AUTH_RATE_LIMIT: '1000', ACCOUNT_FAIL_LIMIT: '10', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_USER: '', SMTP_PASS: '', SMTP_SECURE: 'false', MAIL_FROM: 'app@example.com',
  SMTP_ALLOW_HOSTS: '127.0.0.1', OPENROUTER_API_KEY: '' };
/* a mail server that keeps what it's sent: { to, data } */
const mails = [];
const fakeSmtp = require('node:net').createServer(sock => {
  let data = null, msg = {}, buf = '';
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', chunk => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data !== null) { if (line === '.') { msg.data = data.join('\n'); mails.push(msg); msg = {}; data = null; sock.write('250 queued\r\n'); } else data.push(line); continue; }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') sock.write('250 fake\r\n');
      else if (cmd === 'RCPT') { msg.to = line; sock.write('250 ok\r\n'); }
      else if (cmd === 'DATA') { data = []; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') sock.end('221 bye\r\n');
      else sock.write('250 ok\r\n');
    }
  });
  sock.on('error', () => {});
});
async function mailTo(email, re) {
  for (let i = 0; i < 60; i++) { const m = mails.find(x => x.to.includes(email) && re.test(x.data)); if (m) return m; await new Promise(r => setTimeout(r, 50)); }
  return null;
}
const createUser = (email, pw = PASSWORD) => execFileSync(process.execPath,
  ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', email], { cwd: root, env: { ...env, NEW_PASSWORD: pw }, stdio: 'ignore' });

let srv;
before(async () => {
  await new Promise(r => fakeSmtp.listen(SMTP_PORT, '127.0.0.1', r));
  for (const who of ['adm', 'ann', 'bob', 'cat', 'dan']) createUser(`${who}@example.com`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { if (srv) srv.kill(); fakeSmtp.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const sql = (q, ...args) => { const db = new DatabaseSync(DB); try { return db.prepare(q)[/^\s*select/i.test(q) ? 'all' : 'run'](...args); } finally { db.close(); } };
const userId = email => sql('SELECT id FROM users WHERE email = ?', email)[0].id;

function browser() {
  let cookie = '', csrf = '';
  const c = async (method, url, body) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(BASE + url, { method, redirect: 'manual', headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const r = await c('POST', '/auth/login', { email, password });
  assert.strictEqual(r.status, 200, `sign in ${email}`);
  c.second = !!r.body.second;
  if (!c.second) assert.strictEqual((await c('GET', '/api/me')).status, 200);   /* picks up the signed-in CSRF token */
  return c;
}
const setSess = (c, p, v) => sql(`UPDATE sessions SET sess = json_set(sess, '${p}', ?) WHERE sid = ?`, v, c.sid());

const unbase32 = totp.fromBase32;
/* the code an app holding this secret shows, steps from now */
const codeOf = (secret, steps = 0) => totp.totp(unbase32(secret), Date.now() + steps * 30000);

/* set up and switch on the second step for a signed-in browser: { secret, codes } */
async function enable(c) {
  const s = await c('POST', '/api/totp/setup', {});
  assert.strictEqual(s.status, 200);
  const r = await c('POST', '/api/totp/enable', { code: codeOf(s.body.secret) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return { secret: s.body.secret, codes: r.body.codes };
}

test('RFC 6238 Appendix B test vectors (8 digits; SHA-1, SHA-256, SHA-512) and RFC 4648 base32', () => {
  const seed = { sha1: '12345678901234567890', sha256: '12345678901234567890123456789012', sha512: '1234567890'.repeat(6) + '1234' };
  const table = [[59, '94287082', '46119246', '90693936'], [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'], [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'], [20000000000, '65353130', '77737706', '47863826']];
  for (const [t, ...want] of table) {
    ['sha1', 'sha256', 'sha512'].forEach((a, i) => assert.strictEqual(totp.totp(Buffer.from(seed[a]), t * 1000, 8, a), want[i], `${a} at ${t}`));
  }
  assert.strictEqual(totp.totp(Buffer.from(seed.sha1), 59000), '287082', '6 digits are the last six');
  for (const [i, o] of [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]) {
    assert.strictEqual(totp.base32(Buffer.from(i)), o);
    assert.strictEqual(totp.fromBase32(o).toString(), i);
  }
  const k = Buffer.from(seed.sha1), now = 1111111111000, s = totp.stepAt(now);
  for (const d of [-1, 0, 1]) assert.strictEqual(totp.match(k, totp.hotp(k, s + d), now), s + d, `±1 step: ${d}`);
  for (const d of [-2, 2]) assert.strictEqual(totp.match(k, totp.hotp(k, s + d), now), -1, `outside the window: ${d}`);
  assert.strictEqual(totp.match(k, 'abcdef', now), -1);
  assert.strictEqual(totp.match(k, totp.hotp(k, s).slice(0, 3) + ' ' + totp.hotp(k, s).slice(3), now), s, 'spaces are ignored');
});

let ann, annKeys;
test('setting it up: a key and otpauth URI, confirmed with one code, 10 recovery codes; the secret is sealed at rest', async () => {
  ann = await signIn('ann@example.com');
  const other = await signIn('ann@example.com');
  assert.deepStrictEqual((await ann('GET', '/api/totp')).body, { on: false, recoveryLeft: 0, readable: true });
  const s = await ann('POST', '/api/totp/setup', {});
  assert.strictEqual(s.status, 200);
  assert.match(s.body.secret, /^[A-Z2-7]{32}$/);
  assert.strictEqual(s.body.uri, `otpauth://totp/Logbook%20Monster:ann%40example.com?secret=${s.body.secret}&issuer=Logbook%20Monster&algorithm=SHA1&digits=6&period=30`);
  const stored = sql('SELECT secret, enabled FROM totp WHERE user_id = ?', userId('ann@example.com'))[0];
  assert.strictEqual(stored.enabled, 0, 'not on until a code is confirmed');
  assert.match(stored.secret, /^v2\.[0-9a-f]{12}\.[\w-]{16}\.[\w-]{22}\.[\w-]+$/, 'AES-256-GCM: version, data key id, iv, tag, ciphertext');
  for (const plain of [s.body.secret, unbase32(s.body.secret).toString('hex'), unbase32(s.body.secret).toString('base64url')]) assert.ok(!stored.secret.includes(plain));
  assert.strictEqual((await ann('GET', '/api/me')).body.totp, false);

  assert.strictEqual((await ann('POST', '/api/totp/enable', { code: '000000' === codeOf(s.body.secret) ? '111111' : '000000' })).status, 400);
  assert.strictEqual((await ann('POST', '/api/totp/enable', {})).status, 400);
  const r = await ann('POST', '/api/totp/enable', { code: codeOf(s.body.secret) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.codes.length, 10);
  assert.strictEqual(new Set(r.body.codes).size, 10);
  for (const c of r.body.codes) assert.match(c, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  const rec = sql('SELECT recovery FROM totp WHERE user_id = ?', userId('ann@example.com'))[0].recovery;
  for (const c of r.body.codes) assert.ok(!rec.includes(c) && !rec.includes(c.replace('-', '')), 'only hashes are stored');
  assert.strictEqual(JSON.parse(rec).length, 10);
  annKeys = { secret: s.body.secret, codes: r.body.codes };

  assert.strictEqual(r.body.signedOut, 0, 'other sessions stay unless asked to end');
  assert.strictEqual((await other('GET', '/api/me')).status, 200);
  const told = await mailTo('ann@example.com', /switched on/);
  assert.ok(told, 'the account is told by email');
  /* pointing at the part of Account admin that lists sign-ins, by the name it has there (quoted-printable undone) */
  const text = Buffer.from(told.data.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
  assert.match(text, /Account admin › Security & data › Sign-ins and security/);
  assert.match(text, /\/#account\/security/);
  assert.deepStrictEqual((await ann('GET', '/api/totp')).body, { on: true, recoveryLeft: 10, readable: true });
  assert.strictEqual((await ann('GET', '/api/me')).body.totp, true);
  assert.strictEqual((await ann('POST', '/api/totp/setup', {})).status, 409, 'no new key while it is on');
});

test('two-step sign-in: the password alone gives a half-signed-in session that reaches nothing; the code finishes it; no replay', async () => {
  const c = await signIn('ann@example.com');
  assert.strictEqual(c.second, true);
  const cfg = (await c('GET', '/auth/config')).body;
  assert.strictEqual(cfg.signedIn, false);
  assert.strictEqual(cfg.second, true);
  for (const [m, u, b] of [['GET', '/api/me'], ['GET', '/api/days'], ['GET', '/api/totp'], ['GET', '/api/export'], ['PUT', '/api/settings', { x: 1 }],
    ['POST', '/api/totp/disable', { password: PASSWORD }], ['POST', '/api/recheck', { password: PASSWORD }], ['GET', '/api/admin/users']]) {
    assert.strictEqual((await c(m, u, b)).status, 401, `${m} ${u}`);
  }
  assert.strictEqual((await c('POST', '/auth/password', { current: PASSWORD, next: 'another-password-2' })).status, 401);
  const page = await c('GET', '/');
  assert.strictEqual(page.status, 302);
  assert.strictEqual(page.headers.get('location'), '/login');
  assert.strictEqual(sql('SELECT user_id FROM sessions WHERE sid = ?', c.sid())[0].user_id, userId('ann@example.com'), 'kept as the account’s, so a password change ends it');

  assert.strictEqual((await c('POST', '/auth/second', { code: 'nope' })).status, 401);
  const code = codeOf(annKeys.secret, 1);   /* the next step's code: the one used to switch it on can't come back */
  const ok = await c('POST', '/auth/second', { code });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual((await c('GET', '/api/me')).body.email, 'ann@example.com');
  assert.strictEqual((await c('GET', '/auth/config')).body.signedIn, true);

  const again = await signIn('ann@example.com');
  assert.strictEqual((await again('POST', '/auth/second', { code })).status, 401, 'the same code is refused the second time');
  assert.strictEqual((await again('GET', '/api/me')).status, 401);
  /* nor an older code from the window */
  assert.strictEqual((await again('POST', '/auth/second', { code: codeOf(annKeys.secret) })).status, 401);
  ann = c;
});

test('a half-signed-in session runs out after 5 minutes and asks to start again', async () => {
  const c = await signIn('ann@example.com');
  setSess(c, '$.half.at', Date.now() - 6 * 60 * 1000);
  assert.strictEqual((await c('GET', '/auth/config')).body.second, false);
  const r = await c('POST', '/auth/second', { code: annKeys.codes[9] });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.restart, true);
  assert.strictEqual((await c('GET', '/api/me')).status, 401);
});

test('a password change ends a half-signed-in session too: it can’t be finished with a code afterwards', async () => {
  const half = await signIn('ann@example.com');
  assert.strictEqual(half.second, true);
  assert.strictEqual(sql('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?', half.sid())[0].n, 1);
  for (const [from, to] of [[PASSWORD, 'another-password-2'], ['another-password-2', PASSWORD]]) {
    const r = await ann('POST', '/auth/password', { current: from, next: to });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  }
  assert.strictEqual(sql('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?', half.sid())[0].n, 0, 'the half session is gone');
  const r = await half('POST', '/auth/second', { code: codeOf(annKeys.secret, 2) });
  assert.ok([401, 403].includes(r.status), `refused (${r.status}: the session and its CSRF token are gone)`);
  assert.strictEqual((await half('GET', '/api/me')).status, 401);
  assert.strictEqual((await ann('GET', '/api/me')).status, 200, 'the session that changed it stays');
});

test('recovery codes: each signs in once, in any case and with or without the dash', async () => {
  const c = await signIn('ann@example.com');
  const r = await c('POST', '/auth/second', { code: annKeys.codes[0] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.recovery, true);
  assert.strictEqual((await c('GET', '/api/me')).status, 200);
  const d = await signIn('ann@example.com');
  assert.strictEqual((await d('POST', '/auth/second', { code: annKeys.codes[0] })).status, 401, 'used once already');
  assert.strictEqual((await d('POST', '/auth/second', { code: annKeys.codes[1].toLowerCase().replace('-', ' ') })).status, 200);
  assert.strictEqual((await d('GET', '/api/totp')).body.recoveryLeft, 8);
  assert.strictEqual((await (await signIn('bob@example.com'))('POST', '/auth/second', { code: annKeys.codes[2] })).status, 401,
    'an account without the step has no half-signed-in session');
});

test('wrong codes are limited per account (ACCOUNT_FAIL_LIMIT in 15 minutes), and a right password doesn’t reset that', async () => {
  const b = await signIn('bob@example.com');
  assert.strictEqual(b.second, false);
  const keys = await enable(b);
  const c = await signIn('bob@example.com');
  for (let i = 0; i < 10; i++) assert.strictEqual((await c('POST', '/auth/second', { code: String(100000 + i) === codeOf(keys.secret) ? '999999' : String(100000 + i) })).status, 401);
  const r = await c('POST', '/auth/second', { code: keys.codes[0] });
  assert.strictEqual(r.status, 429, 'even a right code waits');
  const d = await signIn('bob@example.com');
  assert.strictEqual((await d('POST', '/auth/second', { code: keys.codes[0] })).status, 429, 'signing in with the password again doesn’t clear it');
  const a = await signIn('ann@example.com');
  assert.strictEqual((await a('POST', '/auth/second', { code: annKeys.codes[3] })).status, 200, 'other accounts are not affected');
  sql("DELETE FROM login_failures WHERE email = ?", '2fa:' + userId('bob@example.com'));
  assert.strictEqual((await d('POST', '/auth/second', { code: keys.codes[0] })).status, 200);
});

test('switching it off needs the password or a code', async () => {
  const c = await signIn('cat@example.com');
  const keys = await enable(c);
  assert.strictEqual((await c('POST', '/api/totp/disable', {})).status, 400);
  assert.strictEqual((await c('POST', '/api/totp/disable', { password: 'wrong-password-9' })).status, 400);
  assert.strictEqual((await c('POST', '/api/totp/disable', { code: 'AAAAA-AAAAA' })).status, 400);
  assert.strictEqual((await c('GET', '/api/totp')).body.on, true);
  assert.strictEqual((await c('POST', '/api/totp/disable', { code: keys.codes[4] })).status, 200);
  assert.strictEqual((await c('GET', '/api/totp')).body.on, false);
  assert.strictEqual(sql('SELECT COUNT(*) AS n FROM totp WHERE user_id = ?', userId('cat@example.com'))[0].n, 0);
  assert.strictEqual((await signIn('cat@example.com')).second, false, 'one step again');
  const d = await signIn('cat@example.com');
  await enable(d);
  assert.strictEqual((await d('POST', '/api/totp/disable', { password: PASSWORD })).status, 200);
  assert.strictEqual((await signIn('cat@example.com')).second, false);
});

test('setting up and switching on need a recent sign-in or re-check, end other sessions only when asked, and are no re-check (NEW-SEC-01/02)', async () => {
  const d = await signIn('dan@example.com'), other = await signIn('dan@example.com'), old = Date.now() - 16 * 60 * 1000;
  setSess(d, '$.at', old);
  let r = await d('POST', '/api/totp/setup', {});
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.recheck, true);
  assert.strictEqual(sql('SELECT COUNT(*) AS n FROM totp WHERE user_id = ?', userId('dan@example.com'))[0].n, 0, 'no key made');
  assert.strictEqual((await d('POST', '/api/recheck', { password: PASSWORD })).status, 200);
  const s = await d('POST', '/api/totp/setup', {});
  assert.strictEqual(s.status, 200);
  setSess(d, '$.checked', old);
  r = await d('POST', '/api/totp/enable', { code: codeOf(s.body.secret) });
  assert.strictEqual(r.status, 403, 'switching on needs it too');
  assert.strictEqual(r.body.recheck, true);
  assert.strictEqual((await d('GET', '/api/totp')).body.on, false);
  assert.strictEqual((await d('POST', '/api/recheck', { password: PASSWORD })).status, 200);
  const checked = () => JSON.parse(sql('SELECT sess FROM sessions WHERE sid = ?', d.sid())[0].sess).checked;
  const before = checked();
  r = await d('POST', '/api/totp/enable', { code: codeOf(s.body.secret), signOutOthers: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.signedOut, 1, 'asked: the other session ends');
  assert.strictEqual((await other('GET', '/api/me')).status, 401);
  assert.strictEqual(checked(), before, 'switching it on doesn’t count as a re-check');
  assert.ok(await mailTo('dan@example.com', /switched on/));
  assert.strictEqual((await d('POST', '/api/totp/disable', { code: r.body.codes[0] })).status, 200);
  assert.ok(await mailTo('dan@example.com', /switched off/), 'and when it is switched off');
});

let adm, admKeys;
test('option: "Super admins must use a second step" keeps a super admin without it out of /api/admin', async () => {
  adm = await signIn('adm@example.com');
  assert.strictEqual((await adm('GET', '/api/admin/options')).body.adminTotp, false, 'off by default');
  const r = await adm('PUT', '/api/admin/options', { adminTotp: true });
  assert.strictEqual(r.status, 400, 'can’t require it before setting up your own');
  assert.strictEqual((await adm('PUT', '/api/admin/options', { adminTotp: 'yes' })).status, 400);
  admKeys = await enable(adm);
  assert.strictEqual((await adm('PUT', '/api/admin/options', { adminTotp: true })).body.adminTotp, true);
  assert.strictEqual((await adm('GET', '/api/admin/users')).status, 200);
  assert.strictEqual((await adm('GET', '/api/me')).body.adminTotp, true);

  /* the super admin's step goes off: every admin route sends them to set it up, the rest of the app still works */
  assert.strictEqual((await adm('POST', '/api/totp/disable', { password: PASSWORD })).status, 200);
  for (const [m, u, b] of [['GET', '/api/admin/users'], ['GET', '/api/admin/ai'], ['GET', '/api/admin/options'], ['GET', '/api/admin/email'],
    ['PUT', '/api/admin/options', { adminTotp: false }], ['PUT', '/api/admin/ai', { model: 'x/y' }], ['POST', '/api/admin/users', { email: 'z@example.com' }],
    ['DELETE', `/api/admin/users/${userId('bob@example.com')}`]]) {
    const res = await adm(m, u, b);
    assert.strictEqual(res.status, 403, `${m} ${u}`);
    assert.strictEqual(res.body.setup2fa, true, `${m} ${u}`);
  }
  assert.strictEqual((await adm('GET', '/api/me')).status, 200);
  assert.strictEqual(sql('SELECT COUNT(*) AS n FROM users WHERE email = ?', 'z@example.com')[0].n, 0);
  /* nor the super admin powers outside /api/admin: removing someone else's shared food or supplement (NEW-SEC-09) */
  const food = (await ann('POST', '/api/foods', { name: 'ann shared oats', unit: 'g', k: 380, p: 13, c: 60, f: 7, public: true })).body;
  const supp = (await ann('POST', '/api/supps', { name: 'ann shared creatine', amount: 5, unit: 'g', public: true })).body;
  assert.strictEqual((await adm('DELETE', `/api/foods/${food.id}`)).status, 403);
  assert.strictEqual((await adm('DELETE', `/api/supps/${supp.id}`)).status, 403);
  admKeys = await enable(adm);
  assert.strictEqual((await adm('GET', '/api/admin/users')).status, 200, 'set up again: back in');
  assert.strictEqual((await adm('DELETE', `/api/foods/${food.id}`)).status, 200);
  assert.strictEqual((await adm('DELETE', `/api/supps/${supp.id}`)).status, 200);
  /* a normal account is still just refused */
  const bob = await signIn('bob@example.com');
  assert.strictEqual(bob.second, true);
  assert.strictEqual((await bob('POST', '/auth/second', { code: '' })).status, 401);
  assert.strictEqual((await adm('PUT', '/api/admin/options', { adminTotp: false })).body.adminTotp, false);
});

test('re-check: the AI key, the email settings and removing an account need the password or a code on a sign-in over 15 minutes old', async () => {
  createUser('gone@example.com');
  const gone = userId('gone@example.com');
  setSess(adm, '$.at', Date.now() - 16 * 60 * 1000);
  setSess(adm, '$.checked', Date.now() - 16 * 60 * 1000);
  const sensitive = [['PUT', '/api/admin/ai', { key: 'sk-or-new-key-1234' }], ['PUT', '/api/admin/email', { from: '', fromName: '', host: '', port: '', secure: null, user: '', pass: '' }],
    ['DELETE', `/api/admin/users/${gone}`]];
  for (const [m, u, b] of sensitive) {
    const r = await adm(m, u, b);
    assert.strictEqual(r.status, 403, `${m} ${u}`);
    assert.strictEqual(r.body.recheck, true, `${m} ${u}`);
  }
  assert.strictEqual(sql('SELECT COUNT(*) AS n FROM users WHERE id = ?', gone)[0].n, 1, 'nobody was removed');
  assert.strictEqual(sql("SELECT COUNT(*) AS n FROM app_config WHERE key = 'openrouter'")[0].n, 0, 'no key was saved');
  assert.notStrictEqual((await adm('PUT', '/api/admin/ai', { model: 'x/y' })).status, 403, 'changing only the models needs no re-check');
  /* Options: tightening needs no re-check, loosening does (NEW-SEC-09) */
  for (const b of [{ aiDailyUser: 50 }, { aiDailyAll: 500 }, { planFiles: false }, { planFiles: true }, { aiPrivate: true }]) {
    assert.strictEqual((await adm('PUT', '/api/admin/options', b)).status, 200, JSON.stringify(b));
  }
  for (const b of [{ aiDailyUser: 0 }, { aiDailyUser: 60 }, { aiDailyAll: 0 }, { aiPrivate: false }, { planFiles: true, aiDailyAll: 501 }]) {
    const r = await adm('PUT', '/api/admin/options', b);
    assert.strictEqual(r.status, 403, JSON.stringify(b));
    assert.strictEqual(r.body.recheck, true);
  }
  assert.deepStrictEqual((await adm('GET', '/api/admin/options')).body, { planFiles: true, aiPrivate: true, aiDailyUser: 50, aiDailyAll: 500, adminTotp: false });
  assert.strictEqual((await adm('GET', '/api/admin/users')).status, 200, 'reading needs no re-check');

  assert.strictEqual((await adm('POST', '/api/recheck', { password: 'wrong-password-9' })).status, 400);
  assert.strictEqual((await adm('POST', '/api/recheck', { code: '12345' })).status, 400);
  assert.strictEqual((await adm('POST', '/api/recheck', {})).status, 400);
  assert.strictEqual((await adm('POST', '/api/recheck', { password: PASSWORD })).status, 200);
  for (const [m, u, b] of sensitive) assert.strictEqual((await adm(m, u, b)).status, 200, `${m} ${u} after the re-check`);
  assert.strictEqual((await adm('PUT', '/api/admin/options', { adminTotp: true })).status, 200);
  assert.strictEqual((await adm('PUT', '/api/admin/options', { aiDailyUser: 100, aiDailyAll: 1000, aiPrivate: false })).status, 200, 'after the re-check');
  setSess(adm, '$.checked', Date.now() - 16 * 60 * 1000);
  assert.strictEqual((await adm('PUT', '/api/admin/options', { adminTotp: false })).body.recheck, true, 'switching the second-step rule off needs it');
  assert.strictEqual((await adm('POST', '/api/recheck', { password: PASSWORD })).status, 200);
  assert.strictEqual((await adm('PUT', '/api/admin/options', { adminTotp: false, aiPrivate: true })).status, 200);
  assert.strictEqual(sql('SELECT COUNT(*) AS n FROM users WHERE id = ?', gone)[0].n, 0);

  /* 15 minutes after the re-check it's asked again; a code does too */
  setSess(adm, '$.checked', Date.now() - 16 * 60 * 1000);
  assert.strictEqual((await adm(...sensitive[0])).body.recheck, true);
  assert.strictEqual((await adm('POST', '/api/recheck', { code: admKeys.codes[0] })).status, 200);
  assert.strictEqual((await adm(...sensitive[0])).status, 200);

  /* a fresh sign-in needs none */
  const fresh = await signIn('adm@example.com');
  assert.strictEqual((await fresh('POST', '/auth/second', { code: admKeys.codes[1] })).status, 200);
  await fresh('GET', '/api/me');
  assert.strictEqual((await fresh(...sensitive[1])).status, 200);
});

test('create-user --no-2fa switches the second step off (the way back in after losing the phone and the codes)', async () => {
  const c = await signIn('cat@example.com');
  await enable(c);
  assert.strictEqual((await signIn('cat@example.com')).second, true);
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'cat@example.com', '--no-2fa'],
    { cwd: root, env: { ...env, NEW_PASSWORD: 'reset-password-5' }, stdio: 'ignore' });
  assert.strictEqual((await signIn('cat@example.com', 'reset-password-5')).second, false);
  assert.strictEqual((await c('GET', '/api/me')).status, 401, 'and signs the account out everywhere');
});

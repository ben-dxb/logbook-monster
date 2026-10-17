'use strict';
/* Rotating secrets (NEW-SEC-06): SEAL_KEY takes over sealing from SESSION_SECRET (values resealed on start), SESSION_SECRET_OLD
   keeps cookies and sealed values from before a SESSION_SECRET change working, and without either the values can't be opened. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-seal-'));
const DB = path.join(dir, 't.db');
const A = 'a'.repeat(40), B = 'b'.repeat(40), K = 'k'.repeat(40), K2 = 'm'.repeat(40);
const AI_KEY = 'sk-or-v1-rotate-me-0123456789', PASS = 'smtp pass to keep', TOTP = 'totp-secret-bytes';
const base = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: DB, PHOTO_DIR: path.join(dir, 'photos'),
  AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
  SMTP_HOST: '', SMTP_PASS: '', MAIL_FROM: '', OPENROUTER_API_KEY: '', SEAL_KEY: '', SESSION_SECRET_OLD: '' };
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/* runs in a fresh process with these secrets: loads the modules (which reseal on start) and says what opens */
const PROBE = `
const db = require('./server/db'), ai = require('./server/ai'), mail = require('./server/mail'), twostep = require('./server/twostep');
const cmd = process.argv[1];
if (cmd === 'save') {
  ai.save({ key: ${JSON.stringify(AI_KEY)} });
  db.prepare("INSERT INTO app_config (key, data) VALUES ('email', ?)").run(JSON.stringify({ host: 'smtp.example.com', from: 'a@example.com', pass: ${JSON.stringify(PASS)} }));
  db.prepare("INSERT INTO totp (user_id, secret, enabled) VALUES (1, ?, 1)").run(twostep.seal(Buffer.from(${JSON.stringify(TOTP)})));
}
const t = db.prepare('SELECT secret FROM totp WHERE user_id = 1').get();
console.log(JSON.stringify({ ai: ai.status().hint, mail: mail.current().pass || null, totp: t ? (twostep.unseal(t.secret) || '').toString() || null : null }));`;
const probe = (env, cmd = 'read') => JSON.parse(execFileSync(process.execPath,
  ['--disable-warning=ExperimentalWarning', '-e', PROBE, cmd], { cwd: root, env: { ...base, ...env } }).toString().trim().split('\n').pop());
const raw = () => {
  const db = new DatabaseSync(DB);
  try {
    return JSON.stringify([db.prepare("SELECT data FROM app_config WHERE key IN ('openrouter', 'email') ORDER BY key").all(), db.prepare('SELECT secret FROM totp').all()]);
  } finally { db.close(); }
};
const ALL = { ai: '…' + AI_KEY.slice(-4), mail: PASS, totp: TOTP };
const NONE = { ai: '', mail: null, totp: null };

test('SEAL_KEY: values sealed under SESSION_SECRET are resealed with it on start, and then no longer hang on SESSION_SECRET', () => {
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'ann@example.com'],
    { cwd: root, env: { ...base, SESSION_SECRET: A, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  assert.deepStrictEqual(probe({ SESSION_SECRET: A }, 'save'), ALL);
  assert.deepStrictEqual(probe({ SESSION_SECRET: A }), ALL);   /* the plain SMTP password put in is sealed on this start */
  const sealedA = raw();
  assert.ok(!sealedA.includes(AI_KEY) && !sealedA.includes(PASS), 'sealed at rest');
  assert.deepStrictEqual(probe({ SESSION_SECRET: B }), NONE, 'another SESSION_SECRET alone opens nothing');
  assert.strictEqual(raw(), sealedA, 'and changes nothing');

  assert.deepStrictEqual(probe({ SESSION_SECRET: A, SEAL_KEY: K }), ALL, 'SEAL_KEY set: still opens');
  const sealedK = raw();
  assert.notStrictEqual(sealedK, sealedA, 'resealed on that start');
  assert.deepStrictEqual(probe({ SESSION_SECRET: B, SEAL_KEY: K }), ALL, 'now SESSION_SECRET can change freely');
  assert.strictEqual(raw(), sealedK, 'nothing more to reseal');
  assert.deepStrictEqual(probe({ SESSION_SECRET: A }), NONE, 'without SEAL_KEY they don’t open');
  /* a new SEAL_KEY, with the old one as SESSION_SECRET_OLD for one start */
  assert.deepStrictEqual(probe({ SESSION_SECRET: B, SEAL_KEY: K2, SESSION_SECRET_OLD: K }), ALL);
  assert.deepStrictEqual(probe({ SESSION_SECRET: B, SEAL_KEY: K2 }), ALL);
});

test('SESSION_SECRET_OLD: values sealed under the old SESSION_SECRET are resealed under the new one', () => {
  fs.rmSync(DB); for (const x of ['-wal', '-shm']) fs.rmSync(DB + x, { force: true });
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'ann@example.com'],
    { cwd: root, env: { ...base, SESSION_SECRET: A, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  probe({ SESSION_SECRET: A }, 'save');
  assert.deepStrictEqual(probe({ SESSION_SECRET: B, SESSION_SECRET_OLD: A }), ALL);
  assert.deepStrictEqual(probe({ SESSION_SECRET: B }), ALL, 'resealed under the new one');
});

async function serve(env) {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env: { ...base, ...env }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return srv; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  srv.kill();
  throw new Error('server did not start');
}
const stop = srv => { const gone = new Promise(r => srv.once('exit', r)); srv.kill(); return gone; };

test('SESSION_SECRET_OLD: a cookie signed with the old secret still signs in; once it is removed it doesn’t', async () => {
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'bob@example.com'],
    { cwd: root, env: { ...base, SESSION_SECRET: A, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });   /* ann has the second step on */
  let srv = await serve({ SESSION_SECRET: A });
  let cookie;
  try {
    const c = await fetch(BASE + '/auth/config');
    const pre = c.headers.get('set-cookie').split(';')[0], { csrf } = await c.json();
    const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { cookie: pre, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ email: 'bob@example.com', password: 'long-password-1' }) });
    assert.strictEqual(r.status, 200);
    cookie = r.headers.getSetCookie().find(x => x.startsWith('logbookmonster.sid=')).split(';')[0];
    assert.strictEqual((await fetch(BASE + '/api/me', { headers: { cookie } })).status, 200);
  } finally { await stop(srv); }
  const me = async () => (await fetch(BASE + '/api/me', { headers: { cookie } })).status;
  srv = await serve({ SESSION_SECRET: B, SESSION_SECRET_OLD: A });
  try { assert.strictEqual(await me(), 200); } finally { await stop(srv); }
  srv = await serve({ SESSION_SECRET: B });
  try { assert.strictEqual(await me(), 401); } finally { await stop(srv); }
});

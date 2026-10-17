'use strict';
/* Sealed secrets and the session secrets through rotation (Phase 4, docs/rotation.md):
   - values sealed by the version before (v1: straight under a key derived from SESSION_SECRET) become v2 envelope values on start;
   - SEAL_KEY takes over wrapping the data keys, after which the session secrets open nothing (sealKeyOnly);
   - a full SEAL_KEY cycle: new key with SEAL_KEY_OLD for one start (rewrapped), OLD dropped, the old key opens nothing;
   - the SESSION_SECRET / SESSION_SECRET_OLD pair from before still works. The SESSION_SECRETS cycle is in rotation.test.js. */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { spawn, execFileSync, spawnSync } = require('node:child_process');
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
  SMTP_HOST: '', SMTP_PASS: '', MAIL_FROM: '', OPENROUTER_API_KEY: '', SEAL_KEY: '', SEAL_KEY_OLD: '', SESSION_SECRET_OLD: '', SESSION_SECRETS: '' };
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const fresh = () => { for (const x of ['', '-wal', '-shm']) fs.rmSync(DB + x, { force: true }); };
const mkUser = (email, env) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', email],
  { cwd: root, env: { ...base, ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });

/* runs in a fresh process with these secrets: loads the modules (which rewrap and reseal on start) and says what opens –
   including whether a code from the authenticator key is taken */
const PROBE = `
const db = require('./server/db'), ai = require('./server/ai'), mail = require('./server/mail'), twostep = require('./server/twostep'), totp = require('./server/totp');
if (process.argv[1] === 'save') {
  ai.save({ key: ${JSON.stringify(AI_KEY)} });
  db.prepare("INSERT INTO app_config (key, data) VALUES ('email', ?)").run(JSON.stringify({ host: 'smtp.example.com', from: 'a@example.com', pass: ${JSON.stringify(PASS)} }));
  db.prepare("INSERT INTO totp (user_id, secret, enabled) VALUES (1, ?, 1)").run(twostep.seal(Buffer.from(${JSON.stringify(TOTP)})));
}
const t = db.prepare('SELECT secret FROM totp WHERE user_id = 1').get(), k = t && twostep.unseal(t.secret);
console.log(JSON.stringify({ ai: ai.status().hint, mail: mail.current().pass || null, totp: k ? k.toString() : null,
  code: k ? totp.match(k, totp.totp(k)) >= 0 : false }));`;
function probe(env, cmd = 'read') {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', PROBE, cmd], { cwd: root, env: { ...base, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const lines = r.stdout.trim().split('\n');
  return { ...JSON.parse(lines.pop()), log: lines.join('\n'), err: r.stderr };
}
const opens = r => ({ ai: r.ai, mail: r.mail, totp: r.totp, code: r.code });
const sql = (s, ...a) => { const db = new DatabaseSync(DB); try { return db.prepare(s).all(...a); } finally { db.close(); } };
const values = () => JSON.stringify([sql("SELECT data FROM app_config WHERE key IN ('openrouter', 'email') ORDER BY key"), sql('SELECT secret FROM totp')]);
const keysRow = () => JSON.parse((sql("SELECT data FROM app_config WHERE key = 'keys'")[0] || { data: '{}' }).data);
const ALL = { ai: '…' + AI_KEY.slice(-4), mail: PASS, totp: TOTP, code: true };
const NONE = { ai: '', mail: null, totp: null, code: false };
/* can this secret, as a KEK, unwrap any data key in the database? */
const hk = (s, info) => Buffer.from(crypto.hkdfSync('sha256', s, 'logbook-monster', info, 32));
function unwraps(secret) {
  return keysRow().keys.some(e => {
    const [iv, tag, ct] = e.wrapped.split('.');
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', hk(secret, 'kek-v2'), Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from(`${e.kid}|${e.purpose}`)); d.setAuthTag(Buffer.from(tag, 'base64url'));
      Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]); return true;
    } catch { return false; }
  });
}
/* v1, exactly as the version before envelope encryption sealed (server/seal.js on main c9822eb) */
function sealV1(secret, purpose, text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', hk(secret, purpose), iv);
  const ct = Buffer.concat([c.update(Buffer.from(text)), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map(x => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
}

test('v1 → v2: a database sealed by the version before is resealed as envelope values on the first start, in one go', () => {
  fresh();
  mkUser('ann@example.com', { SESSION_SECRET: A });
  const db = new DatabaseSync(DB);
  db.prepare("DELETE FROM app_config WHERE key = 'keys'").run();   /* as the version before left it: no data keys */
  db.prepare("INSERT INTO app_config (key, data) VALUES ('openrouter', ?)").run(JSON.stringify({ keySealed: sealV1(A, 'openrouter-key-v1', AI_KEY) }));
  db.prepare("INSERT INTO app_config (key, data) VALUES ('email', ?)").run(JSON.stringify({ host: 'smtp.example.com', from: 'a@example.com', passSealed: sealV1(A, 'smtp-pass-v1', PASS) }));
  db.prepare('INSERT INTO totp (user_id, secret, enabled) VALUES (1, ?, 1)').run(sealV1(A, 'totp-secret-v1', TOTP));
  db.close();
  const r = probe({ SESSION_SECRET: A });
  assert.deepStrictEqual(opens(r), ALL);
  assert.match(r.log, /^sealed keys: rewrapped 0, resealed \{totp: 1, openrouter: 1, smtp: 1\}$/m);
  assert.ok(!values().includes('"v1.') && !values().includes(':"v1.') && sql('SELECT secret FROM totp')[0].secret.startsWith('v2.'), values());
  assert.strictEqual(keysRow().keys.length, 3, 'one data key per purpose');
  assert.strictEqual(keysRow().sealKeyOnly, false, 'no SEAL_KEY yet');
  const after = values();
  const again = probe({ SESSION_SECRET: A });
  assert.deepStrictEqual(opens(again), ALL);
  assert.doesNotMatch(again.log, /sealed keys/, 'nothing left to do');
  assert.strictEqual(values(), after);
  assert.ok(!after.includes(AI_KEY) && !after.includes(PASS), 'sealed at rest');
});

test('SEAL_KEY: the data keys are rewrapped with it, values stay as they are, and then the session secrets open nothing', () => {
  const before = values();
  assert.deepStrictEqual(opens(probe({ SESSION_SECRET: B })), NONE, 'another session secret alone opens nothing');
  assert.strictEqual(values(), before, 'and changes nothing');
  const r = probe({ SESSION_SECRET: A, SEAL_KEY: K });
  assert.deepStrictEqual(opens(r), ALL);
  assert.match(r.log, /^sealed keys: rewrapped 3, resealed \{totp: 0, openrouter: 0, smtp: 0\}$/m);
  assert.strictEqual(values(), before, 'envelope: only the wrapping changed');
  assert.strictEqual(keysRow().sealKeyOnly, true, 'everything v2 and wrapped by SEAL_KEY: recorded');
  assert.ok(unwraps(K) && !unwraps(A));
  assert.deepStrictEqual(opens(probe({ SESSION_SECRET: B, SEAL_KEY: K })), ALL, 'now the session secret can change freely');
  const lost = probe({ SESSION_SECRET: A });
  assert.deepStrictEqual(opens(lost), NONE, 'without SEAL_KEY they don’t open – not even under the session secret that wrapped them once');
  assert.match(lost.err, /SEALED SECRETS DON’T OPEN \(totp ×1, openrouter ×1, smtp ×1\)/, 'a loud error, not an exit');
  assert.strictEqual(values(), before);
});

test('SEAL_KEY cycle: provision a new one with SEAL_KEY_OLD, verify, drop OLD, and the old key is dead', () => {
  /* provision + verify: one start with both */
  const r = probe({ SESSION_SECRET: B, SEAL_KEY: K2, SEAL_KEY_OLD: K });
  assert.deepStrictEqual(opens(r), ALL, 'TOTP codes, the AI key and the SMTP password all still work');
  assert.match(r.log, /rewrapped 3/);
  assert.ok(unwraps(K2) && !unwraps(K), 'rewrapped in that start');
  /* overlap shortened to that one start: OLD removed */
  assert.deepStrictEqual(opens(probe({ SESSION_SECRET: B, SEAL_KEY: K2 })), ALL);
  /* revoke = the old key is gone from .env; prove it dead: as SEAL_KEY it opens nothing (and as SEAL_KEY_OLD it isn't needed) */
  const dead = probe({ SESSION_SECRET: B, SEAL_KEY: K });
  assert.deepStrictEqual(opens(dead), NONE);
  assert.match(dead.err, /SEALED SECRETS DON’T OPEN/);
  assert.ok(!unwraps(K) && !unwraps(A) && !unwraps(B));
  assert.deepStrictEqual(opens(probe({ SESSION_SECRET: B, SEAL_KEY: K2 })), ALL, 'and the failed start changed nothing');
});

test('a data key older than 30 days is replaced on start and its values resealed; the old one goes', () => {
  const db = new DatabaseSync(DB);
  const k = JSON.parse(db.prepare("SELECT data FROM app_config WHERE key = 'keys'").get().data);
  const kid = k.keys.find(e => e.purpose === 'smtp-pass-v1').kid;
  k.keys.find(e => e.kid === kid).created_at = new Date(Date.now() - 31 * 86400000).toISOString();
  db.prepare("UPDATE app_config SET data = ? WHERE key = 'keys'").run(JSON.stringify(k));
  db.close();
  const r = probe({ SESSION_SECRET: B, SEAL_KEY: K2 });
  assert.deepStrictEqual(opens(r), ALL);
  assert.match(r.log, /resealed \{totp: 0, openrouter: 0, smtp: 1\}/);
  assert.ok(!keysRow().keys.some(e => e.kid === kid), 'the replaced data key is dropped');
  assert.strictEqual(keysRow().keys.length, 3);
});

test('save → read with plain SESSION_SECRET / SESSION_SECRET_OLD (no SEAL_KEY): the session secret wraps, and rotates with OLD', () => {
  fresh();
  mkUser('ann@example.com', { SESSION_SECRET: A });
  probe({ SESSION_SECRET: A }, 'save');
  assert.deepStrictEqual(opens(probe({ SESSION_SECRET: A })), ALL);
  const r = probe({ SESSION_SECRET: B, SESSION_SECRET_OLD: A });
  assert.deepStrictEqual(opens(r), ALL);
  assert.match(r.log, /rewrapped 3/);
  assert.deepStrictEqual(opens(probe({ SESSION_SECRET: B })), ALL, 'rewrapped under the new one');
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
  mkUser('bob@example.com', { SESSION_SECRET: A });   /* ann has the second step on */
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

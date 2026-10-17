'use strict';
/* Session ids are stored only as SHA-256 hashes (rows from before are rehashed on start, nobody signed out), and over https the
   cookie is __Host-logbookmonster.sid, an old logbookmonster.sid cookie still working once and being replaced (all-config-014). */
const test = require('node:test');
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-cookie-'));
const DB = path.join(dir, 't.db'), SECRET = 'y'.repeat(40);
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: 'https://logbook.example', DB_PATH: DB, PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: SECRET, AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false', TRUST_PROXY: '1',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '', SMTP_PASS: '', MAIL_FROM: '', OPENROUTER_API_KEY: '' };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const signed = sid => 's:' + sid + '.' + crypto.createHmac('sha256', SECRET).update(sid).digest('base64').replace(/=+$/, '');
const HTTPS = { 'x-forwarded-proto': 'https' };   /* as Caddy passes it on */
const RAW = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';   /* an express-session id stored as it was before */

let srv;
test.before(async () => {
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'ann@example.com'],
    { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  const db = new DatabaseSync(DB);
  const id = db.prepare("SELECT id FROM users WHERE email = 'ann@example.com'").get().id, exp = Date.now() + 86400000;
  db.prepare('INSERT INTO sessions (sid, sess, expires, user_id) VALUES (?, ?, ?, ?)').run(RAW,
    JSON.stringify({ cookie: { originalMaxAge: 86400000, expires: new Date(exp).toISOString(), httpOnly: true, secure: true, sameSite: 'lax', path: '/' }, userId: id, csrf: 'c'.repeat(43), at: Date.now() }), exp, id);
  db.close();
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
test.after(() => { if (srv) srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
const sids = () => { const db = new DatabaseSync(DB); try { return db.prepare('SELECT sid FROM sessions').all().map(r => r.sid); } finally { db.close(); } };

test('a session from before is rehashed in place and an old-name cookie still signs in, then moves to __Host-', async () => {
  assert.deepStrictEqual(sids(), [sha(RAW)]);
  const r = await fetch(BASE + '/api/me', { headers: { ...HTTPS, cookie: 'logbookmonster.sid=' + encodeURIComponent(signed(RAW)) } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).email, 'ann@example.com');
  const set = r.headers.getSetCookie();
  assert.ok(set.some(c => /^__Host-logbookmonster\.sid=s%3A/.test(c) && /; Path=\//.test(c) && /; Secure/.test(c) && !/Domain=/i.test(c)), set.join('\n'));
  assert.ok(set.some(c => /^logbookmonster\.sid=;/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c)), 'old cookie cleared');
  const r2 = await fetch(BASE + '/api/me', { headers: { ...HTTPS, cookie: '__Host-logbookmonster.sid=' + encodeURIComponent(signed(RAW)) } });
  assert.strictEqual(r2.status, 200);
});

test('a new sign-in stores only the hash of its id', async () => {
  const c = await fetch(BASE + '/auth/config', { headers: HTTPS });
  const pre = c.headers.getSetCookie()[0].split(';')[0], { csrf } = await c.json();
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { ...HTTPS, cookie: pre, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ email: 'ann@example.com', password: 'long-password-1' }) });
  assert.strictEqual(r.status, 200);
  const cookie = r.headers.getSetCookie().find(x => x.startsWith('__Host-logbookmonster.sid='));
  const sid = decodeURIComponent(cookie.split(';')[0].split('=')[1]).replace(/^s:/, '').split('.')[0];
  assert.ok(sids().includes(sha(sid)), 'hash stored');
  assert.ok(!sids().includes(sid), 'raw id not stored');
});

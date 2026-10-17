'use strict';
/* Final server round, a real server process: in production with an https BASE_URL and no TRUST_PROXY it warns at start-up, a
   sign-in whose secure cookie couldn't be set (plain http reached the app) is logged once an hour, and SIGTERM (docker compose
   stop) shuts it down cleanly in well under Docker's 10 s. docker-compose.yml runs it with init and keeps the hardening. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-finalproc-'));
const env = { ...process.env, NODE_ENV: 'production', PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: 'https://logbook.example', DB_PATH: path.join(dir, 't.db'),
  PHOTO_DIR: path.join(dir, 'photos'), SESSION_SECRET: 'y'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'ann@example.com',
  ALLOW_REGISTRATION: 'false', TRUST_PROXY: '', COOKIE_SECURE: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '', SMTP_PASS: '', MAIL_FROM: '', OPENROUTER_API_KEY: '' };

let srv, err = '', exited = null;
test.before(async () => {
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'ann@example.com'],
    { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { err += d; });
  srv.stderr.on('data', d => { err += d; });
  srv.on('exit', (code, signal) => { exited = { code, signal, at: Date.now() }; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start:\n' + err);
});
test.after(() => { if (srv && !exited) srv.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });

async function signIn() {
  const c = await fetch(BASE + '/auth/config');
  const pre = c.headers.getSetCookie()[0].split(';')[0], { csrf } = await c.json();
  return fetch(BASE + '/auth/login', { method: 'POST', headers: { cookie: pre, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ email: 'ann@example.com', password: 'long-password-1' }) });
}

test('an https BASE_URL without TRUST_PROXY warns at start-up, saying what to set', () => {
  assert.match(err, /BASE_URL is https but TRUST_PROXY isn’t set.*TRUST_PROXY=1/);
});

test('a sign-in that answers ok but couldn’t set its secure cookie is logged, once an hour', async () => {
  const r = await signIn();
  assert.strictEqual(r.status, 200);
  assert.ok(!r.headers.getSetCookie().some(c => c.includes('logbookmonster.sid=')), 'no session cookie over plain http');
  await new Promise(res => setTimeout(res, 100));
  const said = () => err.split('couldn’t set the session cookie').length - 1;
  assert.strictEqual(said(), 1, err);
  assert.match(err, /TRUST_PROXY=1/);
  assert.strictEqual((await signIn()).status, 200);
  await new Promise(res => setTimeout(res, 100));
  assert.strictEqual(said(), 1, 'not again within the hour');
});

test('SIGTERM shuts the server down cleanly in well under 10 s, even with a connection held open', async () => {
  const held = await fetch(BASE + '/healthz', { headers: { connection: 'keep-alive' } });
  await held.text();
  const t = Date.now();
  srv.kill('SIGTERM');
  for (let i = 0; i < 80 && !exited; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(exited, 'exited');
  assert.strictEqual(exited.code, 0, err);
  assert.ok(exited.at - t < 6000, `${exited.at - t} ms`);
  assert.match(err, /SIGTERM: shutting down/);
});

test('docker-compose.yml runs node under init and keeps the hardening', () => {
  const y = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(y, /^\s+init: true/m);
  assert.match(y, /^\s+read_only: true/m);
  assert.match(y, /^\s+cap_drop: \[ALL\]/m);
  assert.match(y, /no-new-privileges:true/);
  assert.match(fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'), /^USER /m, 'runs as a non-root user');
});

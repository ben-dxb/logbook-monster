'use strict';
/* The other tests raise AUTH_RATE_LIMIT; this one checks the real default still stops guessing. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3700 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-rl-'));
let srv;

before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'),
    SESSION_SECRET: 'x'.repeat(40), GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' };
  delete env.AUTH_RATE_LIMIT;
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('sign-in attempts are limited to 20 per 15 minutes by default', async () => {
  const cfg = await fetch(BASE + '/auth/config');
  const cookie = cfg.headers.get('set-cookie').split(';')[0];
  const { csrf } = await cfg.json();
  const login = () => fetch(BASE + '/auth/login', { method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password-1' }) }).then(r => r.status);
  for (let i = 0; i < 20; i++) assert.strictEqual(await login(), 401, `attempt ${i + 1}`);
  assert.strictEqual(await login(), 429);
});

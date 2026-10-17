'use strict';
/* The other tests raise AUTH_RATE_LIMIT; this one checks the real defaults still stop guessing:
   20 sign-ins per IP and 10 wrong passwords per account every 15 minutes. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-rl-'));
const DB = path.join(dir, 't.db');
const PASSWORD = 'right-password-1';
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: DB,
  SESSION_SECRET: 'x'.repeat(40), GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', TRUST_PROXY: '1' };
delete env.AUTH_RATE_LIMIT;
delete env.ACCOUNT_FAIL_LIMIT;
let srv;

async function start() {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server', 'index.js')], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}
async function restart() {
  const gone = new Promise(r => srv.once('exit', r));
  srv.kill(); await gone;
  await start();
}
before(async () => {
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'real@example.com'],
    { cwd: root, env: { ...env, NEW_PASSWORD: PASSWORD }, stdio: 'ignore' });
  await start();
});
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

/* a signed-out browser at address ip (sent as X-Forwarded-For; the server trusts one proxy) */
async function browser(ip) {
  const cfg = await fetch(BASE + '/auth/config', { headers: { 'x-forwarded-for': ip } });
  const cookie = cfg.headers.get('set-cookie').split(';')[0];
  const { csrf } = await cfg.json();
  return (email, password) => fetch(BASE + '/auth/login', { method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password }) }).then(async r => ({ status: r.status, body: await r.json() }));
}

test('sign-in attempts are limited to 20 per 15 minutes by default', async () => {
  const login = await browser('10.0.0.1');
  for (let i = 0; i < 20; i++) assert.strictEqual((await login('nobody@example.com', 'wrong-password-1')).status, 401, `attempt ${i + 1}`);
  assert.strictEqual((await login('nobody@example.com', 'wrong-password-1')).status, 429);
});

test('10 wrong passwords for one account, from any addresses, lock it for 15 minutes – across a restart', async () => {
  const a = await browser('10.0.1.1'), b = await browser('10.0.2.1'), c = await browser('10.0.3.1');
  const wrong = await a('real@example.com', 'wrong-password-1');
  assert.strictEqual(wrong.status, 401);
  for (let i = 1; i < 10; i++) assert.strictEqual((await (i % 2 ? b : a)('real@example.com', 'wrong-password-1')).status, 401, `attempt ${i + 1}`);
  /* the right password, from a third address, gets exactly the wrong-password answer */
  assert.deepStrictEqual(await c('real@example.com', PASSWORD), wrong);
  assert.deepStrictEqual(await c('REAL@example.com', PASSWORD), wrong);
  await restart();
  assert.deepStrictEqual(await (await browser('10.0.4.1'))('real@example.com', PASSWORD), wrong, 'still locked after a restart');
  /* 15 minutes later it signs in again */
  const db = new DatabaseSync(DB);
  db.prepare('UPDATE login_failures SET at = at - 16 * 60 * 1000').run();
  db.close();
  assert.strictEqual((await (await browser('10.0.4.1'))('real@example.com', PASSWORD)).status, 200);
});

test('without TRUST_PROXY a forged X-Forwarded-For is ignored: every address shares one bucket', async () => {
  env.TRUST_PROXY = '';
  await restart();
  for (let i = 0; i < 20; i++) assert.strictEqual((await (await browser(`203.0.113.${i + 1}`))('nobody@example.com', 'wrong-password-1')).status, 401, `attempt ${i + 1}`);
  assert.strictEqual((await (await browser('198.51.100.7'))('nobody@example.com', 'wrong-password-1')).status, 429);
});

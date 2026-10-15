'use strict';
/* End-to-end checks of auth, CSRF and the data API against a throwaway server and database. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mealswap-test-'));
let srv;

before(async () => {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'),
      SESSION_SECRET: 'x'.repeat(40), ALLOWED_EMAILS: 'me@example.com', ALLOW_REGISTRATION: 'false',
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

/* Minimal cookie-keeping client */
function client() {
  let cookie = '', csrf = '';
  const req = async (method, url, body, extra = {}) => {
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf, ...extra },
      body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j, headers: r.headers };
  };
  return { req, setCsrf: v => { csrf = v; } };
}

test('pages and API need a session', async () => {
  const c = client();
  assert.strictEqual((await c.req('GET', '/')).status, 302);
  assert.strictEqual((await c.req('GET', '/api/me')).status, 401);
  assert.strictEqual((await c.req('GET', '/api/days')).status, 401);
});

test('registration is limited to allowed emails and needs CSRF', async () => {
  const c = client();
  await c.req('GET', '/auth/config');
  c.setCsrf('wrong');
  assert.strictEqual((await c.req('POST', '/auth/register', { email: 'me@example.com', password: 'longenough1' })).status, 403);
  await c.req('GET', '/auth/config');
  assert.strictEqual((await c.req('POST', '/auth/register', { email: 'other@example.com', password: 'longenough1' })).status, 403);
  assert.strictEqual((await c.req('POST', '/auth/register', { email: 'me@example.com', password: 'short' })).status, 400);
  assert.strictEqual((await c.req('POST', '/auth/register', { email: 'me@example.com', password: 'longenough1' })).status, 200);
});

test('login, save a day and a weight, read them back, logout', async () => {
  const c = client();
  await c.req('GET', '/auth/config');
  assert.strictEqual((await c.req('POST', '/auth/login', { email: 'me@example.com', password: 'nope-nope-nope' })).status, 401);
  assert.strictEqual((await c.req('POST', '/auth/login', { email: 'ME@example.com', password: 'longenough1' })).status, 200);
  const me = await c.req('GET', '/api/me');
  assert.strictEqual(me.body.email, 'me@example.com');

  const data = { meals: [{ id: '1', p: [], c: [], x: [] }], targets: { k: 2980 }, off: [] };
  assert.strictEqual((await c.req('PUT', '/api/days/2026-10-15', { data, summary: { k: 2975.33, p: 250, c: 360, f: 60, targets: { k: 2980 }, type: 'T', evil: 1 } })).status, 200);
  assert.strictEqual((await c.req('PUT', '/api/days/2026-13-01', { data, summary: {} })).status, 400);
  assert.strictEqual((await c.req('PUT', '/api/days/2026-10-16', { data: { nope: 1 }, summary: {} })).status, 400);
  const day = await c.req('GET', '/api/days/2026-10-15');
  assert.deepStrictEqual(day.body.data, data);
  const list = await c.req('GET', '/api/days?from=2026-10-01&to=2026-10-31');
  assert.strictEqual(list.body.length, 1);
  assert.strictEqual(list.body[0].k, 2975.3);
  assert.strictEqual(list.body[0].evil, undefined);
  assert.strictEqual((await c.req('GET', '/api/days/2026-10-14')).status, 404);

  assert.strictEqual((await c.req('PUT', '/api/weights/2026-10-15', { kg: 82.4 })).status, 200);
  assert.strictEqual((await c.req('PUT', '/api/weights/2026-10-15', { kg: 5 })).status, 400);
  assert.deepStrictEqual((await c.req('GET', '/api/weights')).body, [{ date: '2026-10-15', kg: 82.4 }]);

  /* another user can't see it */
  const c2 = client();
  await c2.req('GET', '/auth/config');
  assert.strictEqual((await c2.req('GET', '/api/days/2026-10-15')).status, 401);

  assert.strictEqual((await c.req('POST', '/auth/logout', {})).status, 200);
  assert.strictEqual((await c.req('GET', '/api/me')).status, 401);
});

test('security headers are set', async () => {
  const r = await fetch(BASE + '/login');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.strictEqual(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.strictEqual(r.headers.get('x-powered-by'), null);
});

test('Google sign-in is refused when not configured', async () => {
  const r = await fetch(BASE + '/auth/google', { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.match(r.headers.get('location'), /error=google_off/);
});

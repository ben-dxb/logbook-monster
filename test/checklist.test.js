'use strict';
/* The Dashboard's daily checklist: each account's own list (defaults until changed) and its ticks per day. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-checklist-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
let srv;

before(async () => {
  for (const who of ['ann', 'bob']) {
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', `${who}@example.com`],
      { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  }
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

async function signIn(email) {
  let cookie = '', csrf = '';
  const req = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j };
  };
  await req('GET', '/auth/config');
  assert.strictEqual((await req('POST', '/auth/login', { email, password: 'long-password-1' })).status, 200);
  await req('GET', '/api/me');
  return req;
}

test('the checklist starts as the default list; your own list is checked and kept per account', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com');
  let r = await ann('GET', '/api/checklist');
  assert.deepStrictEqual(r.body.items.map(i => i.label), ['Weigh in', 'Meals planned/prepped', 'Supplements taken', 'Water intake hit',
    'Step count hit', 'Training done', 'Cardio done']);
  assert.strictEqual(r.body.custom, false);
  assert.strictEqual(r.body.items.find(i => i.id === 'training').show, 'training', 'training only shows on training days');
  assert.strictEqual(r.body.items.find(i => i.id === 'weigh').auto, 'weight');

  const mine = [{ id: 'water', label: '  3 litres   of water ', show: 'all', auto: '' }, { id: 'c1', label: 'Stretch', show: 'tpl:R', auto: '' },
    { id: 'training', label: 'Training done', show: 'training', auto: 'gym' }];
  for (const bad of [[{ ...mine[0], label: ' ' }], [{ ...mine[0], id: 'Bad id' }], [mine[0], mine[0]], [{ ...mine[0], show: 'sometimes' }],
    [{ ...mine[0], auto: 'steps' }], [{ ...mine[0], label: 'x'.repeat(61) }], Array.from({ length: 21 }, (_, i) => ({ id: 'c' + i, label: 'x' })), 'nope']) {
    assert.strictEqual((await ann('PUT', '/api/checklist', { items: bad })).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  r = await ann('PUT', '/api/checklist', { items: mine });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.items.map(i => i.label), ['3 litres of water', 'Stretch', 'Training done']);
  assert.strictEqual((await ann('GET', '/api/checklist')).body.custom, true);
  assert.strictEqual((await bob('GET', '/api/checklist')).body.items.length, 7, 'Bob keeps the defaults');

  /* ticks: only items on your list, per day, per account; unticking is always fine */
  assert.strictEqual((await ann('PUT', '/api/checklist/days/2026-10-16', { item: 'cardio', done: true })).status, 400, 'not on Ann’s list any more');
  assert.strictEqual((await ann('PUT', '/api/checklist/days/2026-13-01', { item: 'water', done: true })).status, 400);
  r = await ann('PUT', '/api/checklist/days/2026-10-16', { item: 'water', done: true });
  assert.deepStrictEqual(r.body, { date: '2026-10-16', done: ['water'] });
  await ann('PUT', '/api/checklist/days/2026-10-16', { item: 'water', done: true });   /* twice is the same as once */
  await ann('PUT', '/api/checklist/days/2026-10-16', { item: 'c1', done: true });
  await ann('PUT', '/api/checklist/days/2026-10-15', { item: 'training', done: true });
  await bob('PUT', '/api/checklist/days/2026-10-16', { item: 'cardio', done: true });
  r = await ann('GET', '/api/checklist/days?from=2026-10-10&to=2026-10-16');
  assert.deepStrictEqual(r.body.days, { '2026-10-15': ['training'], '2026-10-16': ['c1', 'water'] });
  assert.strictEqual((await ann('GET', '/api/checklist/days?from=2026-10-16&to=2026-10-10')).status, 400);
  assert.strictEqual((await ann('GET', '/api/checklist/days?from=2020-01-01&to=2026-10-10')).status, 400, 'a year at most');
  r = await ann('PUT', '/api/checklist/days/2026-10-16', { item: 'water', done: false });
  assert.deepStrictEqual(r.body.done, ['c1']);
  assert.deepStrictEqual((await bob('GET', '/api/checklist/days?from=2026-10-16&to=2026-10-16')).body.days, { '2026-10-16': ['cardio'] });

  r = await ann('GET', '/api/export');
  assert.strictEqual(r.body.checklist.items.length, 3);
  assert.strictEqual(r.body.checklist.ticks.length, 2);

  /* back to the defaults; ticks already made stay */
  r = await ann('DELETE', '/api/checklist');
  assert.strictEqual(r.body.items.length, 7);
  assert.strictEqual((await ann('GET', '/api/checklist')).body.custom, false);
  assert.strictEqual(Object.keys((await ann('GET', '/api/checklist/days?from=2026-10-10&to=2026-10-16')).body.days).length, 2);
});

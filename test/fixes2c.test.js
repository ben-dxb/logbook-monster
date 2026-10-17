'use strict';
/* Phase 2C tracker leftovers: rows stored under impossible dates before #69 are moved to their real date at start (or, when
   that date is taken, kept and deletable as stored), the export is named by the browser's date, and a garbled coach link
   opens the coach page (which says the link doesn't work) instead of raw JSON. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-fixes2c-'));
const root = path.join(__dirname, '..');
const DB = path.join(dir, 't.db');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: DB, PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
let srv, log = '';

before(async () => {
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'ann@example.com'],
    { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  /* what a database from before #69 can hold */
  const db = new DatabaseSync(DB);
  const uid = db.prepare("SELECT id FROM users WHERE email = 'ann@example.com'").get().id;
  const sum = JSON.stringify({ k: 1234, p: 100, c: 100, f: 40, targets: {} });
  for (const d of ['2026-02-30', '2026-02-31', '2026-03-03']) db.prepare('INSERT INTO days (user_id, date, data, summary) VALUES (?, ?, ?, ?)').run(uid, d, '{"meals":[],"off":[]}', sum);
  db.prepare('INSERT INTO weights (user_id, date, kg) VALUES (?, ?, ?)').run(uid, '2026-02-31', 81.5);
  db.prepare('INSERT INTO weights (user_id, date, kg) VALUES (?, ?, ?)').run(uid, '2026-02-30', 82);
  db.prepare('INSERT INTO weights (user_id, date, kg) VALUES (?, ?, ?)').run(uid, '2026-03-02', 82.2);
  const ex = db.prepare("INSERT INTO exercises (user_id, name, notes) VALUES (?, 'Squat', '')").run(uid).lastInsertRowid;
  db.prepare("INSERT INTO sets (user_id, exercise_id, reps, kg, at) VALUES (?, ?, 5, 100, '2026-02-31T10:00')").run(uid, ex);
  db.prepare("INSERT INTO supplement_log (user_id, date, name, amount, unit) VALUES (?, '2026-02-31', 'Creatine', 5, 'g')").run(uid);
  db.close();
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'] });
  srv.stdout.on('data', c => { log += c; });
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
    return { status: r.status, body: j, headers: r.headers };
  };
  await req('GET', '/auth/config');
  assert.strictEqual((await req('POST', '/auth/login', { email, password: 'long-password-1' })).status, 200);
  await req('GET', '/api/me');
  return req;
}

test('rows on impossible dates move to their real date at start; one whose date is taken stays, listed and deletable as stored (NEW-02)', async () => {
  const ann = await signIn('ann@example.com');
  const days = (await ann('GET', '/api/days?from=2026-02-01&to=2026-03-31')).body.map(d => d.date);
  assert.deepStrictEqual(days, ['2026-02-31', '2026-03-02', '2026-03-03'], '02-30 moved to 03-02; 02-31 kept, 03-03 was taken');
  const wts = (await ann('GET', '/api/weights?from=2026-02-01&to=2026-03-31')).body;
  assert.deepStrictEqual(wts.map(w => [w.date, w.kg]), [['2026-02-30', 82], ['2026-03-02', 82.2], ['2026-03-03', 81.5]]);
  assert.ok((await ann('GET', '/api/gym/sessions')).body.some(s => s.date === '2026-03-03'), 'the gym set is on 2026-03-03');
  assert.deepStrictEqual((await ann('GET', '/api/supps/log?from=2026-03-03&to=2026-03-03')).body.entries.map(e => e.name), ['Creatine']);
  assert.match(log, /days user \d+ 2026-02-30 → 2026-03-02/);
  assert.match(log, /days user \d+ 2026-02-31: kept – 2026-03-03 already has one/);
  assert.match(log, /sets user \d+ 2026-02-31 → 2026-03-03/);
  /* the leftovers can be deleted as stored; a made-up impossible date is still refused, and so is any write to one */
  assert.strictEqual((await ann('GET', '/api/days/2026-02-31')).status, 400);
  assert.strictEqual((await ann('DELETE', '/api/days/2026-02-31')).status, 200);
  assert.strictEqual((await ann('DELETE', '/api/weights/2026-02-30')).status, 200);
  assert.strictEqual((await ann('DELETE', '/api/days/2026-02-31')).status, 400, 'once gone, the key is a bad date again');
  assert.strictEqual((await ann('DELETE', '/api/weights/2026-04-31')).status, 400);
  assert.strictEqual((await ann('PUT', '/api/weights/2026-02-31', { kg: 80 })).status, 400);
  assert.deepStrictEqual((await ann('GET', '/api/days?from=2026-02-01&to=2026-03-31')).body.map(d => d.date), ['2026-03-02', '2026-03-03']);
});

test('the export file is named by the browser’s date (within a day of the server’s), else the server’s (PR-TR-047)', async () => {
  const ann = await signIn('ann@example.com');
  const name = r => /filename="?([^";]+)/.exec(r.headers.get('content-disposition'))[1];
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10), today = new Date().toISOString().slice(0, 10);
  assert.strictEqual(name(await ann('GET', '/api/export?date=' + tomorrow)), `logbook-monster-${tomorrow}.json`);
  assert.strictEqual(name(await ann('GET', '/api/export?date=2020-01-01')), `logbook-monster-${today}.json`);
  assert.strictEqual(name(await ann('GET', '/api/export?date=nonsense')), `logbook-monster-${today}.json`);
});

test('a garbled coach link opens the coach page, not raw JSON (PR-TL-029)', async () => {
  const r = await fetch(BASE + '/coach/abc%E0%A4');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /html/);
  assert.match(await r.text(), /id="c-gone"/);
  assert.strictEqual((await fetch(BASE + '/coach/abc%25E0%25A4/api/info')).status, 404, 'its API says the link doesn’t work');
});

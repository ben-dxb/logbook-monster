'use strict';
/* Phase 7 (writes): every foreign key column has an index a cascade can use, the impossible-dates fix runs once, a session's
   expiry is written only when it moves by an hour or more (not on every request), AI usage is pruned on start rather than on
   every call, and the database runs WAL with synchronous = NORMAL. */
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-writes-'));
const DB = path.join(dir, 't.db');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: DB, PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '', SMTP_PASS: '', MAIL_FROM: '', OPENROUTER_API_KEY: '' };
Object.assign(process.env, { DB_PATH: DB, SESSION_SECRET: env.SESSION_SECRET, OPENROUTER_API_KEY: '' });
const PASSWORD = 'long-password-1';
const node = args => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args],
  { cwd: root, env: { ...env, NEW_PASSWORD: PASSWORD }, encoding: 'utf8' });

const db = require('../server/db');
let srv;
before(async () => {
  node(['scripts/create-user.js', 'ann@example.com']);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { if (srv) srv.kill(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const plan = (sql, ...args) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(r => r.detail).join(' | ');

test('the lookups a cascade makes use an index, not a scan of the table', () => {
  /* what SQLite runs for ON DELETE CASCADE / SET NULL when an exercise, a supplement or an account goes */
  assert.match(plan('SELECT 1 FROM sets WHERE exercise_id = ?', 1), /USING (COVERING )?INDEX sets_exercise_id/);
  assert.match(plan('SELECT 1 FROM supplement_log WHERE supplement_id = ?', 1), /USING (COVERING )?INDEX supplement_log_supp/);
  assert.match(plan('SELECT 1 FROM workouts WHERE user_id = ?', 1), /USING (COVERING )?INDEX workouts_user/);
  assert.match(plan('SELECT 1 FROM invites WHERE user_id = ?', 1), /USING (COVERING )?INDEX invites_user/);
  assert.match(plan('SELECT id FROM workouts WHERE user_id = ? ORDER BY position, id', 1), /workouts_user/);
  assert.doesNotMatch(plan('SELECT id FROM workouts WHERE user_id = ? ORDER BY position, id', 1), /TEMP B-TREE FOR ORDER BY/);
});

test('every foreign key column starts an index (or is the rowid), so no cascade scans a whole table', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  const missing = [];
  for (const t of tables) {
    const fks = db.prepare('SELECT DISTINCT "from" AS col FROM pragma_foreign_key_list(?)').all(t).map(r => r.col);
    if (!fks.length) continue;
    const firsts = new Set(db.prepare('SELECT name FROM pragma_index_list(?)').all(t)
      .map(i => (db.prepare('SELECT name FROM pragma_index_info(?) WHERE seqno = 0').get(i.name) || {}).name));
    const cols = db.prepare('SELECT name, type, pk FROM pragma_table_info(?)').all(t);
    const rowid = cols.filter(c => c.pk).length === 1 && cols.find(c => c.pk && /^INTEGER$/i.test(c.type));
    for (const c of fks) if (!firsts.has(c) && !(rowid && rowid.name === c)) missing.push(`${t}.${c}`);
  }
  assert.deepStrictEqual(missing, []);
});

test('WAL with synchronous = NORMAL', () => {
  assert.strictEqual(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.strictEqual(db.prepare('PRAGMA synchronous').get().synchronous, 1);
});

test('the impossible-dates fix runs once: a clean run is recorded and later starts skip the scan', () => {
  assert.ok(db.prepare("SELECT 1 FROM app_config WHERE key = 'dates_fixed'").get());
  const uid = db.prepare("SELECT id FROM users WHERE email = 'ann@example.com'").get().id;
  db.prepare("INSERT INTO weights (user_id, date, kg) VALUES (?, '2025-02-30', 80)").run(uid);
  const out = node(['-e', "require('./server/db')"]);
  assert.doesNotMatch(out, /dates that don't exist/);
  assert.ok(db.prepare("SELECT 1 FROM weights WHERE user_id = ? AND date = '2025-02-30'").get(uid), 'not scanned again');
  /* without the flag (a database from before) it runs, logs and records it */
  db.prepare("DELETE FROM app_config WHERE key = 'dates_fixed'").run();
  assert.match(node(['-e', "require('./server/db')"]), /weights user \d+ 2025-02-30 → 2025-03-02/);
  assert.ok(db.prepare("SELECT 1 FROM weights WHERE user_id = ? AND date = '2025-03-02'").get(uid));
  assert.ok(db.prepare("SELECT 1 FROM app_config WHERE key = 'dates_fixed'").get());
});

test('session store: touch writes the expiry only when it moves by an hour or more; set always writes', () => {
  const SqliteStore = require('../server/sessionStore');
  const store = new SqliteStore(db, { maxAge: 30 * 86400000 });
  clearInterval(store.timer);
  const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
  const sess = (ms = 0) => ({ cookie: { expires: new Date(Date.now() + 30 * 86400000 + ms).toISOString() }, userId: 1, at: Date.now() });
  const stored = () => db.prepare('SELECT expires FROM sessions WHERE sid = ?').get(SqliteStore.key('unit-sid')).expires;
  store.set('unit-sid', sess());
  const first = stored(), n = changes();
  for (let i = 0; i < 50; i++) { store.get('unit-sid', () => {}); store.touch('unit-sid', sess()); }
  assert.ok(changes() - n <= 1, `${changes() - n} writes for 50 touches`);
  assert.strictEqual(stored(), first);
  store.touch('unit-sid', sess(SqliteStore.TOUCH + 1000));
  assert.ok(stored() > first + SqliteStore.TOUCH, 'an hour on, it is written');
  const m = changes();
  store.set('unit-sid', { ...sess(), note: 'changed' });
  assert.strictEqual(changes() - m, 1, 'set is never skipped');
  store.destroy('unit-sid');
  assert.strictEqual(store.stored.has(SqliteStore.key('unit-sid')), false);
});

test('50 signed-in requests on one session write its row at most once', async () => {
  let cookie = '', csrf = '';
  const c = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { ...(cookie ? { cookie } : {}), 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null); if (j && j.csrf) csrf = j.csrf;
    return r.status;
  };
  await c('GET', '/auth/config');
  assert.strictEqual(await c('POST', '/auth/login', { email: 'ann@example.com', password: PASSWORD }), 200);
  const sid = require('node:crypto').createHash('sha256')
    .update(decodeURIComponent(cookie.split('=')[1]).replace(/^s:/, '').split('.')[0]).digest('hex');
  const row = () => db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
  assert.strictEqual(await c('GET', '/api/me'), 200);
  const was = row();
  for (let i = 0; i < 50; i++) assert.strictEqual(await c('GET', '/api/me'), 200);
  assert.deepStrictEqual(row(), was, 'neither the expiry nor the session was written again');
});

test('AI usage older than 30 days is pruned on start, not by each call', () => {
  const day = d => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  db.prepare('INSERT INTO ai_usage (user_id, day, calls) VALUES (99, ?, 3), (99, ?, 2)').run(day(40), day(1));
  require('../server/ai');
  assert.deepStrictEqual(db.prepare('SELECT day FROM ai_usage WHERE user_id = 99').all().map(r => r.day), [day(1)]);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'server/ai.js'), 'utf8').match(/function allow[\s\S]*?\n}/)[0], /q\.old/);
});

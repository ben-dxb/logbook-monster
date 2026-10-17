'use strict';
/* Ids are never reused: a database made by the schema before AUTOINCREMENT is upgraded in place on start – every row, id,
   index and foreign key kept – and from then on a deleted record's id never comes back for a new one. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-ids-'));
const file = path.join(dir, 'old.db');
const root = path.join(__dirname, '..');
const TABLES = ['users', 'exercises', 'workouts', 'sets', 'foods', 'supplements', 'supplement_log', 'photos', 'shares', 'ai_jobs'];

/* the schema as it was: db.js's tables without AUTOINCREMENT, and photos without updated_at */
const src = fs.readFileSync(path.join(root, 'server/db.js'), 'utf8');
const schema = src.match(/db\.exec\(`\n(CREATE TABLE IF NOT EXISTS users[\s\S]*?)`\);/)[1]
  .replace(/ AUTOINCREMENT/g, '').replace(/,\n {2}updated_at TEXT\n\);\nCREATE INDEX IF NOT EXISTS photos_day/, '\n);\nCREATE INDEX IF NOT EXISTS photos_day');
assert.ok(!/AUTOINCREMENT/.test(schema) && /CREATE TABLE IF NOT EXISTS checklist_log/.test(schema));

const old = new DatabaseSync(file);
old.exec('PRAGMA foreign_keys = ON;' + schema);
old.exec("ALTER TABLE exercises ADD COLUMN trend INTEGER NOT NULL DEFAULT 0; ALTER TABLE exercises ADD COLUMN parts TEXT NOT NULL DEFAULT ''");
const run = (sql, ...a) => Number(old.prepare(sql).run(...a).lastInsertRowid);
const ann = run("INSERT INTO users (email, name, password_hash) VALUES ('ann@example.com', 'Ann', 'h1')");
const bob = run("INSERT INTO users (email, name) VALUES ('bob@example.com', 'Bob')");
const gone = run("INSERT INTO users (email) VALUES ('gone@example.com')");
old.prepare('DELETE FROM users WHERE id = ?').run(gone);   /* reused before the upgrade – nothing can be done about that one */
for (const u of [ann, bob]) {
  const ex = run("INSERT INTO exercises (user_id, name, trend, parts) VALUES (?, 'Squat', 1, 'quads,glutes')", u);
  run("INSERT INTO exercises (user_id, name) VALUES (?, 'Bench')", u);
  run('INSERT INTO workouts (user_id, name, items) VALUES (?, ?, ?)', u, 'Legs', JSON.stringify([{ e: ex, target: '5 × 5' }]));
  for (let i = 0; i < 3; i++) run("INSERT INTO sets (user_id, exercise_id, reps, kg, at) VALUES (?, ?, 5, ?, '2026-10-0' || ?)", u, ex, 100 + i, String(i + 1));
  run("INSERT INTO foods (user_id, name, k, p, c, f, public) VALUES (?, 'Oats', 380, 13, 60, 7, 1)", u);
  const s = run("INSERT INTO supplements (user_id, name, amount, unit) VALUES (?, 'Zinc', 15, 'mg')", u);
  run("INSERT INTO supplement_log (user_id, date, supplement_id, name, amount, unit) VALUES (?, '2026-10-01', ?, 'Zinc', 15, 'mg')", u, s);
  run("INSERT INTO photos (user_id, date, pose, note, file, type, size) VALUES (?, '2026-10-01', 'front', 'n', 'a.jpg', 'image/jpeg', 10)", u);
  run("INSERT INTO shares (user_id, token_hash, expires_at) VALUES (?, ?, '2027-01-01')", u, 'hash' + u);
  run("INSERT INTO ai_jobs (user_id, kind) VALUES (?, 'plan')", u);
  run("INSERT INTO days (user_id, date, data, summary) VALUES (?, '2026-10-01', '{\"meals\":[]}', '{}')", u);
}
const rows = t => old.prepare(`SELECT * FROM ${t} ORDER BY id`).all();
const before = Object.fromEntries(TABLES.map(t => [t, rows(t)]));
const indexes = d => d.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name").all();
const idxBefore = indexes(old);
old.close();

process.env.DB_PATH = file;
const db = require('../server/db');
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('every user-facing table is rebuilt with AUTOINCREMENT, its rows and ids as they were', () => {
  for (const t of TABLES) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /\bid\s+INTEGER PRIMARY KEY AUTOINCREMENT/, t);
    assert.match(sql, new RegExp(`^CREATE TABLE "?${t}"? \\(`), t);
    const now = db.prepare(`SELECT * FROM ${t} ORDER BY id`).all();
    assert.strictEqual(now.length, before[t].length, t);
    /* columns added on start (photos.updated_at, style…) are new; the rest is the same */
    now.forEach((r, i) => { for (const [k, v] of Object.entries(before[t][i])) assert.deepStrictEqual(r[k], v, `${t}.${k}`); });
  }
  assert.deepStrictEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%seq%'").all().map(r => r.name), ['sqlite_sequence']);
  assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.strictEqual(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const names = new Set(indexes(db).map(i => i.name));
  for (const i of idxBefore) assert.ok(names.has(i.name), i.name);
  assert.ok(names.has('sqlite_autoindex_users_1') && names.has('sqlite_autoindex_exercises_1'));   /* UNIQUE email, (user, name) */
});

test('a deleted record\'s id is never handed out again', () => {
  let n = 0;
  for (const t of TABLES) {
    const row = before[t][0], cols = Object.keys(row).filter(k => k !== 'id');
    const add = () => {
      const vals = cols.map(k => (k === 'email' ? `new${++n}@example.com` : k === 'token_hash' ? `newhash${++n}` : k === 'name' && t === 'exercises' ? `Lift ${++n}` : row[k]));
      return Number(db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid);
    };
    const top = add();
    db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(top);
    const id = add();
    assert.ok(id > top, `${t}: new id ${id} after deleting ${top}`);
  }
});

test('foreign keys still cascade after the rebuild', () => {
  const sets = () => db.prepare('SELECT COUNT(*) AS n FROM sets WHERE user_id = ?').get(ann).n;
  assert.ok(sets() > 0);
  db.prepare('DELETE FROM exercises WHERE user_id = ? AND name = ?').run(ann, 'Squat');
  assert.strictEqual(sets(), 0);
  db.prepare('DELETE FROM users WHERE id = ?').run(ann);
  for (const t of TABLES.slice(1).concat('days')) assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(ann).n, 0, t);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM photos WHERE user_id = ?').get(bob).n > 0);
  assert.throws(() => db.prepare("INSERT INTO foods (user_id, name, k, p, c, f) VALUES (999, 'x', 1, 1, 1, 1)").run(), /FOREIGN KEY/);
});

test('it runs once: starting again changes nothing', () => {
  const snap = () => JSON.stringify([db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(), db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()]);
  const was = snap();
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', "require('./server/db').close()"], { cwd: root, env: { ...process.env, DB_PATH: file } });
  assert.strictEqual(snap(), was);
});

'use strict';
/* Housekeeping (server/upkeep.js): an older database is switched to incremental auto_vacuum and compacted once, the daily job hands
   free pages back to the disk, photo files no row refers to are swept after an hour, old thumbnails get their size, and the data
   folders and files are made private. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-upkeep-'));
const DB = path.join(dir, 'data', 'u.db'), PICS = path.join(dir, 'data', 'photos');
fs.mkdirSync(PICS, { recursive: true, mode: 0o755 });
fs.chmodSync(path.dirname(DB), 0o755); fs.chmodSync(PICS, 0o755);

/* a database as an older version left it: auto_vacuum off, and most of its pages free after a big delete */
const old = new DatabaseSync(DB);
old.exec('PRAGMA auto_vacuum = NONE; PRAGMA journal_mode = WAL; CREATE TABLE junk (b BLOB)');
const fill = (d, mb) => { const ins = d.prepare('INSERT INTO junk (b) VALUES (?)'); for (let i = 0; i < mb * 16; i++) ins.run(Buffer.alloc(65536, i)); };
fill(old, 8);
old.exec("DELETE FROM junk WHERE rowid > 16; PRAGMA wal_checkpoint(TRUNCATE)");
old.close();
fs.chmodSync(DB, 0o644);

process.env.DB_PATH = DB;
process.env.PHOTO_DIR = PICS;
process.env.SESSION_SECRET = 'x'.repeat(40);
const logs = [], log = console.log;
console.log = (...a) => logs.push(a.join(' '));
const db = require('../server/db');
const upkeep = require('../server/upkeep');
test.after(() => { console.log = log; db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const size = () => fs.statSync(DB).size + (fs.existsSync(DB + '-wal') ? fs.statSync(DB + '-wal').size : 0);
const one = sql => Object.values(db.prepare(sql).get())[0];

test('an older database switches to incremental auto_vacuum with one VACUUM, logged with sizes', () => {
  assert.strictEqual(one('PRAGMA auto_vacuum'), 0);
  const before = fs.statSync(DB).size;
  assert.ok(before > 7 * 1048576, String(before));
  assert.strictEqual(upkeep.vacuumAtStart(), true);
  assert.strictEqual(one('PRAGMA auto_vacuum'), 2, 'INCREMENTAL');
  assert.ok(fs.statSync(DB).size < 2 * 1048576, `${before} → ${fs.statSync(DB).size}`);
  assert.ok(logs.some(l => /Database compacted: .* MB → .* MB/.test(l)), logs.join('\n'));
  assert.strictEqual(upkeep.vacuumAtStart(), false, 'nothing to do the next time');
});

test('the daily job gives the pages of a big delete back to the disk', async () => {
  fill(db, 8);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const full = size();
  db.exec('DELETE FROM junk WHERE rowid > 16');
  assert.ok(size() >= full * 0.9, 'a delete alone leaves the file as big');
  await upkeep.daily();
  assert.ok(size() < full / 3, `${full} → ${size()}`);
  assert.strictEqual(fs.existsSync(DB + '-wal') ? fs.statSync(DB + '-wal').size : 0, 0, 'the -wal file is emptied');
});

const uid = Number(db.prepare("INSERT INTO users (email) VALUES ('ann@example.com')").run().lastInsertRowid);
const name = n => n.toString(16).padStart(32, '0');
const put = (f, bytes, hoursOld) => {
  const p = path.join(PICS, f);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1), { mode: 0o644 });
  if (hoursOld) { const t = new Date(Date.now() - hoursOld * 3600000); fs.utimesSync(p, t, t); }
};

test('photo files no row refers to are removed once they are over an hour old; other files are left alone', async () => {
  put(name(1) + '.jpg', 100, 3); put(name(2) + '.jpg', 50, 3);                       /* a photo and its thumbnail */
  db.prepare("INSERT INTO photos (user_id, date, file, type, size, thumb) VALUES (?, '2026-10-01', ?, 'image/jpeg', 100, ?)").run(uid, name(1) + '.jpg', name(2) + '.jpg');
  put(name(3) + '.png', 10, 3);                       /* an orphan from a crash */
  put(name(4) + '.webp', 10, 0);                      /* an upload being saved right now */
  put('notes.txt', 10, 3);                            /* not one of the app's names */
  logs.length = 0;
  assert.strictEqual(await upkeep.sweep(false), 1);
  assert.deepStrictEqual(fs.readdirSync(PICS).sort(), [name(1) + '.jpg', name(2) + '.jpg', name(4) + '.webp', 'notes.txt']);
  assert.ok(logs.some(l => /Removed 1 photo file/.test(l)), logs.join('\n'));
});

test('older thumbnails stored with size 0 get their size from the file, once', () => {
  assert.strictEqual(one('SELECT thumb_size FROM photos'), 0);
  assert.strictEqual(upkeep.thumbSizes(), 1);
  assert.strictEqual(one('SELECT thumb_size FROM photos'), 50);
  assert.strictEqual(upkeep.thumbSizes(), 0);
});

test('the data folders and files are made private (0700 / 0600)', { skip: process.platform === 'win32' }, async () => {
  const mode = p => fs.statSync(p).mode & 0o777;
  upkeep.permissions();
  await upkeep.sweep(true);
  assert.deepStrictEqual([mode(path.dirname(DB)), mode(PICS), mode(DB)], [0o700, 0o700, 0o600]);
  assert.deepStrictEqual([mode(path.join(PICS, name(1) + '.jpg')), mode(path.join(PICS, name(2) + '.jpg'))], [0o600, 0o600]);
  assert.strictEqual(mode(path.join(PICS, 'notes.txt')), 0o644, 'a file that isn’t the app’s is left as it is');
});

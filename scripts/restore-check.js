'use strict';
/* npm run restore-check -- <backup folder>
   Opens a backup made by npm run backup read-only (nothing in it is changed) and reports what is in it: the database's own check,
   rows per table, and photo rows against the files in its photos folder – rows whose file is missing (pictures that would be
   broken after a restore) and files no row refers to (harmless; the app removes them an hour after it starts).
   Given the folder the backups are made in, it checks the newest one. Exits with 1 when the database or a photo file is missing. */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const arg = process.argv[2];
if (!arg || arg.startsWith('-')) { console.error('Usage: npm run restore-check -- <backup folder>'); process.exit(1); }
const isDb = f => /\.db$/.test(f);
let dir = path.resolve(arg);
if (!fs.existsSync(dir)) { console.error(`There is no folder ${dir}`); process.exit(1); }
if (!fs.readdirSync(dir).some(isDb)) {
  const sub = fs.readdirSync(dir).filter(n => /^logbook-monster-/.test(n) && fs.statSync(path.join(dir, n)).isDirectory()).sort().pop();
  if (sub) dir = path.join(dir, sub);
}
const dbName = fs.readdirSync(dir).find(isDb);
if (!dbName) { console.error(`No database (.db file) in ${dir}`); process.exit(1); }

const db = new DatabaseSync(path.join(dir, dbName), { readOnly: true });
const ok = db.prepare('PRAGMA quick_check').all().map(r => Object.values(r)[0]);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const counts = tables.map(t => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]);

const photoDir = path.join(dir, 'photos');
const files = new Set(fs.existsSync(photoDir) ? fs.readdirSync(photoDir) : []);
/* mid (the middle size) only in a database the app has started on since it was added – an older backup has none */
const mid = tables.includes('photos') && db.prepare("SELECT 1 FROM pragma_table_info('photos') WHERE name = 'mid'").get();
const rows = tables.includes('photos') ? db.prepare(`SELECT id, user_id, file, thumb${mid ? ', mid' : ''} FROM photos`).all() : [];
db.close();
const used = new Set(), missing = [];
for (const r of rows) {
  for (const [what, name] of [['photo', r.file], ['thumbnail', r.thumb], ['middle size', r.mid]]) {
    if (!name) continue;
    used.add(name);
    if (!files.has(name)) missing.push(`photo ${r.id} (account ${r.user_id}): ${what} ${name}`);
  }
}
const extra = [...files].filter(f => !used.has(f));
const bytes = [...files].reduce((a, f) => a + fs.statSync(path.join(photoDir, f)).size, 0);

console.log(`Backup ${dir}
  database  ${dbName}  ${(fs.statSync(path.join(dir, dbName)).size / 1048576).toFixed(1)} MB – check: ${ok.join('; ')}
  rows      ${counts.map(([t, n]) => `${t} ${n}`).join(', ')}
  photos    ${rows.length} rows, ${files.size} files (${(bytes / 1048576).toFixed(1)} MB): ${missing.length} missing, ${extra.length} with no row
  secret    ${fs.existsSync(path.join(dir, '.session-secret')) ? '.session-secret included' : 'no .session-secret (fine when SESSION_SECRET is set in .env)'}`);
if (missing.length) console.log(`Missing files:\n  ${missing.slice(0, 20).join('\n  ')}${missing.length > 20 ? `\n  … and ${missing.length - 20} more` : ''}`);
process.exit(ok.join() === 'ok' && !missing.length ? 0 : 1);

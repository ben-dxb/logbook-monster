'use strict';
/* npm run backup -- <folder>
   A copy of everything the app keeps, made while it runs, with Node alone (no sqlite3 tool; works the same on Windows):
   <folder>/logbook-monster-<date>T<time>/ with the database (VACUUM INTO: one consistent file, no -wal), the photos folder and,
   when SESSION_SECRET isn't set, the .session-secret file the app's sealed secrets depend on. Only this user can read it
   (folders 0700, files 0600). Reads DB_PATH / PHOTO_DIR / SESSION_SECRET from .env like the app.

   Order: photos, then the database, then the photos again (only files not copied yet). A photo deleted while the backup runs was
   already copied by the first pass, so no row in the database copy is left without its file; one added before the database copy
   is picked up by the second pass. A file with no row (added after the database copy) is only an extra file – the app removes
   such files an hour after it starts on the restored copy. Check a backup with npm run restore-check -- <its folder>. */
process.umask(0o077);
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const out = process.argv[2];
if (!out || out.startsWith('-')) {
  console.error('Usage: npm run backup -- <folder>   (a new folder for this backup is made inside it)');
  process.exit(1);
}
const config = require('../server/config');                      /* loads .env */
const hadSecret = (process.env.SESSION_SECRET || '').length >= 32;   /* otherwise the app uses .session-secret beside the database */
const t0 = Date.now();
const mb = n => `${(n / 1048576).toFixed(1)} MB`;
const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
const dest = path.resolve(out, `logbook-monster-${stamp}`);
const photos = path.join(dest, 'photos');

if (!fs.existsSync(config.dbPath)) { console.error(`No database at ${config.dbPath} – set DB_PATH (in .env) to the app's database.`); process.exit(1); }
fs.mkdirSync(path.resolve(out), { recursive: true, mode: 0o700 });
fs.mkdirSync(dest, { mode: 0o700 });
fs.mkdirSync(photos, { mode: 0o700 });

/* every regular file of the photos folder not copied yet; returns [files, bytes] */
function copyPhotos() {
  let n = 0, bytes = 0, names = [];
  try { names = fs.readdirSync(config.photoDir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const name of names) {
    const from = path.join(config.photoDir, name), to = path.join(photos, name);
    let st;
    try { st = fs.lstatSync(from); } catch { continue; }                     /* deleted meanwhile */
    if (!st.isFile() || fs.existsSync(to)) continue;
    try { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    fs.chmodSync(to, 0o600);
    n++; bytes += st.size;
  }
  return [n, bytes];
}

const [n1, b1] = copyPhotos();
const dbFile = path.join(dest, path.basename(config.dbPath));
const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
db.close();
fs.chmodSync(dbFile, 0o600);
const [n2, b2] = copyPhotos();

let secretNote = 'SESSION_SECRET is set (in .env or the environment): keep a copy of .env – it isn’t in this backup.';
if (!hadSecret) {
  const file = path.join(path.dirname(config.dbPath), '.session-secret');
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, path.join(dest, '.session-secret'));
    fs.chmodSync(path.join(dest, '.session-secret'), 0o600);
    secretNote = 'SESSION_SECRET isn’t set, so .session-secret was copied too: the saved AI key, email password and authenticator keys are sealed with it. Put it back beside the database when restoring.';
  } else secretNote = 'SESSION_SECRET isn’t set and there is no .session-secret file beside the database.';
}
if (process.env.SEAL_KEY) secretNote += ' SEAL_KEY is set: keep it (it is in .env) – the sealed secrets need it.';

const dbSize = fs.statSync(dbFile).size;
console.log(`Backup in ${dest}
  database  ${path.basename(dbFile)}  ${mb(dbSize)}
  photos    ${n1 + n2} files  ${mb(b1 + b2)}${n2 ? ` (${n2} added while the backup ran)` : ''}
  total     ${mb(dbSize + b1 + b2)} in ${((Date.now() - t0) / 1000).toFixed(1)} s
${secretNote}
Only this user can open it (folders 0700, files 0600 – on Windows, the folder's own permissions apply). Copy it off this machine.`);

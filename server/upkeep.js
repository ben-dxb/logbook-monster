'use strict';
/* Housekeeping, at start and once a day: the database file gives its free pages back to the disk, photo files no row refers to
   are deleted, and the data folders and files are kept to the app's own user. */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');

const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
/* the names photos.js gives files: nothing else in the folder is ever touched */
const NAME = /^[0-9a-f]{32}\.(jpg|png|webp)$/;
const posix = process.platform !== 'win32';
/* chmod only what this user owns (on Windows modes mean nothing): anything else is left quietly as it is */
const owned = st => posix && typeof process.getuid === 'function' && st.uid === process.getuid();
const one = sql => Object.values(db.prepare(sql).get())[0];
const sizeOf = f => { try { return fs.statSync(f).size; } catch { return 0; } };
const mb = n => `${(n / 1048576).toFixed(1)} MB`;

function tighten(p, mode) {
  try { const st = fs.statSync(p); if (owned(st) && (st.mode & 0o777 & ~mode)) fs.chmodSync(p, mode); } catch {}
}
/* Folders and files made before they were created private (0700 / 0600) stay as they were made otherwise. */
function permissions() {
  tighten(path.dirname(config.dbPath), 0o700);
  tighten(config.photoDir, 0o700);
  for (const f of ['', '-wal', '-shm']) tighten(config.dbPath + f, 0o600);
}

/* An older database (auto_vacuum NONE) switches to incremental with one VACUUM, and one whose free pages are over a quarter of
   the file is compacted the same way. Quick at this app's size (22.6 MB with 89 % free pages → 2.4 MB in under 0.1 s). */
function vacuumAtStart() {
  try {
    const pages = one('PRAGMA page_count'), free = one('PRAGMA freelist_count');
    if (one('PRAGMA auto_vacuum') === 2 && !(pages && free / pages > 0.25)) return false;
    const before = sizeOf(config.dbPath), t = Date.now();
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    console.log(`Database compacted: ${mb(before)} → ${mb(sizeOf(config.dbPath))} (${free} of ${pages} pages were free) in ${Date.now() - t} ms`);
    return true;
  } catch (e) { console.error('Couldn’t compact the database:', e.message); return false; }
}
/* Daily: free pages go back to the disk, and the -wal file is emptied into the database. */
function shrink() {
  try {
    const before = sizeOf(config.dbPath) + sizeOf(config.dbPath + '-wal');
    db.exec('PRAGMA incremental_vacuum');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const after = sizeOf(config.dbPath) + sizeOf(config.dbPath + '-wal');
    if (after < before) console.log(`Database: ${mb(before)} → ${mb(after)} (free pages given back)`);
  } catch (e) { console.error('Database upkeep failed:', e.message); }
}

/* Thumbnails uploaded before thumb_size existed count as 0 toward the photo quota: their size, from the file. */
function thumbSizes() {
  const put = db.prepare('UPDATE photos SET thumb_size = ? WHERE id = ? AND thumb = ? AND thumb_size = 0');
  let n = 0;
  for (const r of db.prepare('SELECT id, thumb FROM photos WHERE thumb IS NOT NULL AND thumb_size = 0').all()) {
    const size = sizeOf(path.join(config.photoDir, path.basename(r.thumb)));
    if (size) n += put.run(size, r.id, r.thumb).changes;
  }
  if (n) console.log(`Counted the size of ${n} older thumbnail${n === 1 ? '' : 's'} in their accounts’ photo storage`);
  return n;
}

/* Photo files no row refers to (left by a crash between writing a file and saving its row, or by older versions) and older than
   an hour, so an upload being saved right now is never one of them. fix: also make older files private (0600). */
async function sweep(fix) {
  let names;
  try { names = await fs.promises.readdir(config.photoDir); } catch { return 0; }
  const used = new Set();
  for (const r of db.prepare('SELECT file, thumb, mid FROM photos').all()) { used.add(r.file); if (r.thumb) used.add(r.thumb); if (r.mid) used.add(r.mid); }
  const now = Date.now();
  let n = 0, bytes = 0;
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const p = path.join(config.photoDir, name);
    let st;
    try { st = await fs.promises.lstat(p); } catch { continue; }
    if (!st.isFile()) continue;
    if (!used.has(name)) {
      if (now - st.mtimeMs < HOUR) continue;
      try { await fs.promises.unlink(p); n++; bytes += st.size; } catch (e) { if (e.code !== 'ENOENT') console.error(`Couldn’t delete photo file ${name}:`, e.code || e.message); }
    } else if (fix && owned(st) && st.mode & 0o077) await fs.promises.chmod(p, 0o600).catch(() => {});
  }
  if (n) console.log(`Removed ${n} photo file${n === 1 ? '' : 's'} no photo refers to (${mb(bytes)})`);
  return n;
}

function daily() { shrink(); return sweep(false).catch(e => console.error('Photo file sweep failed:', e.message)); }
function start() {
  permissions();
  vacuumAtStart();
  thumbSizes();
  sweep(true).catch(e => console.error('Photo file sweep failed:', e.message));
  setInterval(daily, DAY).unref();
}

module.exports = { start, daily, sweep, shrink, vacuumAtStart, thumbSizes, permissions };

'use strict';
/* A full or read-only disk – for the photo files (ENOSPC, EROFS) or the database (SQLITE_FULL) – is told to the person as
   such (507), not as "Something went wrong". health() is /healthz's look at the database and the disks it writes to. */
const fs = require('node:fs');
const path = require('node:path');

const FULL = 'The server’s storage is full – tell the person who runs this app';
const SQLITE_FULL = 13, SQLITE_READONLY = 8;
function full(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.code === 'ENOSPC' || e.code === 'EROFS' || e.code === 'EDQUOT') return true;
  const primary = typeof e.errcode === 'number' ? e.errcode & 0xff : null;
  return primary === SQLITE_FULL || primary === SQLITE_READONLY || /database or disk is full/i.test(String(e.message || ''));
}

/* free bytes for whoever runs the app on the volume holding dir (null if it can't be read) */
function free(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
}

const limits = { low: 200 * 1024 * 1024 };
let last = null;
/* At most one real look every 5 s: /healthz needs no sign-in, so it can be asked often. */
function health(db, { dbPath, photoDir }, now = Date.now()) {
  if (last && now - last.at < 5000) return last.out;
  const out = { ok: true };
  try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); }
  catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('Health check: the database can’t be written to:', e.message);
    out.ok = false; out.db = 'not writable';
  }
  for (const [k, dir] of [['dbDisk', path.dirname(dbPath)], ['photoDisk', photoDir]]) {
    const n = free(dir);
    if (n != null && n < limits.low) { out.ok = false; out[k] = 'low'; }
  }
  last = { at: now, out };
  return out;
}

module.exports = { full, free, health, FULL, limits };

'use strict';
/* Progress photos: each account uploads its own pictures, dated and tagged with a pose (which way the body
   faces: front, left side, right side, back, other) and a pose type (relaxed, front double biceps…), and only
   ever sees its own. The browser shrinks a picture to a JPEG before upload (which
   also drops its EXIF data, location included) and sends a small thumbnail after it; the server
   checks the bytes really are a JPEG, PNG or WebP, strips any camera data left in them (clean) and stores them on disk under random names. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const config = require('./config');
const ai = require('./ai');
const rateLimit = require('express-rate-limit');
const { isDate, writeError } = require('./dates');
const version = require('./version');
const audit = require('./audit');

fs.mkdirSync(config.photoDir, { recursive: true, mode: 0o700 });

/* updated: the version a change is checked against (server/version.js) – when it was last changed, or uploaded */
const COLS = 'id, date, pose, style, pose_ai, note, size, created_at AS created, COALESCE(updated_at, created_at) AS updated, file, thumb';
const q = {
  list: db.prepare(`SELECT ${COLS} FROM photos WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC`),
  get: db.prepare(`SELECT ${COLS} FROM photos WHERE user_id = ? AND id = ?`),
  /* the newest of each pose up to a date (the Dashboard's card) */
  latest: db.prepare(`SELECT ${COLS} FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY pose ORDER BY date DESC, id DESC) AS n
    FROM photos WHERE user_id = ? AND date <= ?) WHERE n = 1 ORDER BY date DESC, id DESC`),
  files: db.prepare('SELECT file, type, thumb, thumb_size FROM photos WHERE user_id = ? AND id = ?'),
  /* through a coach link: only a photo some Timeline day card shows – the latest (highest id) of its pose on its date */
  shown: db.prepare(`SELECT file, type, thumb FROM photos p WHERE user_id = ? AND id = ?
    AND NOT EXISTS (SELECT 1 FROM photos o WHERE o.user_id = p.user_id AND o.pose = p.pose AND o.date = p.date AND o.id > p.id)`),
  allFiles: db.prepare('SELECT file, thumb FROM photos WHERE user_id = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM photos WHERE user_id = ?'),
  bytes: db.prepare('SELECT COALESCE(SUM(size + thumb_size), 0) AS n FROM photos WHERE user_id = ?'),
  add: db.prepare('INSERT INTO photos (user_id, date, pose, style, pose_ai, note, file, type, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  put: db.prepare('UPDATE photos SET date = ?, pose = ?, style = ?, pose_ai = ?, note = ?, updated_at = ? WHERE user_id = ? AND id = ?'),
  /* the AI's pose: only while the pose is still the one the request was asked about, or still the AI's – never over a hand edit made meanwhile */
  aiPose: db.prepare('UPDATE photos SET pose = ?, style = ?, pose_ai = 2, updated_at = ? WHERE user_id = ? AND id = ? AND (pose_ai > 0 OR (pose = ? AND style = ?))'),
  thumb: db.prepare('UPDATE photos SET thumb = ?, thumb_size = ? WHERE user_id = ? AND id = ?'),
  del: db.prepare('DELETE FROM photos WHERE user_id = ? AND id = ?'),
  delRange: db.prepare('DELETE FROM photos WHERE user_id = ? AND date BETWEEN ? AND ? RETURNING file, thumb'),
  all: db.prepare('SELECT id, date, pose, style, pose_ai, note, size, created_at AS created FROM photos WHERE user_id = ? ORDER BY date, id'),
};

const MAX_PHOTOS = 3000, MAX_BYTES = 10 * 1024 * 1024, MAX_THUMB = 512 * 1024;
/* all of an account's photo files together, thumbnails included */
const MAX_TOTAL = config.quota.photos;
const GB = n => `${Math.round(n / 1073741824 * 10) / 10} GB`;
const full = () => fail(`Your photos have reached the ${GB(MAX_TOTAL)} an account can keep – delete some first`, 413);
/* uploads (a photo and its thumbnail are two) per account an hour: a bulk upload of the most photos an account keeps fits */
const uploadLimit = rateLimit({
  windowMs: 60 * 60 * 1000, limit: MAX_PHOTOS * 2, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => 'u' + req.user.id, message: { error: 'That’s a lot of photo uploads this hour – wait a while and try again.' },
});
/* left / right: that side of the body toward the camera. 'side' (either) is from before photos had left and right,
   kept for those – POSES is what a photo may have, PICK what the app offers. */
const POSES = ['front', 'left', 'right', 'side', 'back', 'other'];
const PICK = POSES.filter(p => p !== 'side');
/* the pose type; '' when not set */
const STYLES = ['relaxed', 'front_relaxed', 'back_relaxed', 'front_double_biceps', 'back_double_biceps', 'most_muscular'];
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const idOf = v => (/^\d{1,12}$/.test(String(v)) ? +v : 0);

/* What the bytes are, whatever the request claimed. */
function sniff(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
/* Camera data (EXIF with GPS, XMP, IPTC, text chunks) taken out, whatever the client did. Segments are walked by their
   lengths; anything that doesn't parse is left as it is from that point (a decoder walking it would stop there too). */
const JPEG_DROP = new Set([0xe1, 0xed]);                  /* APP1 (EXIF, XMP), APP13 (IPTC) */
function cleanJpeg(b) {
  const out = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }                    /* fill byte */
    if (m === 0xda || m === 0xd9) break;                  /* image data (or the end) from here on */
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) break;
    if (!JPEG_DROP.has(m)) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  out.push(b.subarray(i));
  return Buffer.concat(out);
}
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);
function cleanPng(b) {
  const out = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8), end = i + 12 + len;
    if (end > b.length) break;
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  out.push(b.subarray(i));
  return Buffer.concat(out);
}
function cleanWebp(b) {
  const out = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = b.toString('latin1', i, i + 4), len = b.readUInt32LE(i + 4), end = i + 8 + len + (len & 1);
    if (end > b.length) break;
    if (type === 'VP8X') { const c = Buffer.from(b.subarray(i, end)); c[8] &= ~0x0c; out.push(c); }   /* no EXIF / XMP flags */
    else if (type !== 'EXIF' && type !== 'XMP ') out.push(b.subarray(i, end));
    i = end;
  }
  out.push(b.subarray(i));
  const body = Buffer.concat(out), head = Buffer.from(b.subarray(0, 12));
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}
const clean = (b, type) => (type === 'image/jpeg' ? cleanJpeg(b) : type === 'image/png' ? cleanPng(b) : cleanWebp(b));
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

function meta(b) {
  const o = b || {};
  const bad = writeError(o.date, 'Pick the date the photo was taken');
  if (bad) throw fail(bad);
  const pose = o.pose == null || o.pose === '' ? 'other' : o.pose;
  if (!POSES.includes(pose)) throw fail(`Pick a pose: ${POSES.join(', ')}`);
  const style = o.style == null ? '' : o.style;
  if (style !== '' && !STYLES.includes(style)) throw fail(`Pick a pose type: ${STYLES.join(', ')}`);
  const note = String(o.note == null ? '' : o.note).replace(/\s+/g, ' ').trim();
  if (note.length > 200) throw fail('Note is too long (200 characters at most)');
  return { date: o.date, pose, style, note };
}

/* File names are random and never come from the request, so they can't point outside the folder. */
const newName = ext => crypto.randomBytes(16).toString('hex') + ext;
const fileAt = name => path.join(config.photoDir, path.basename(name));
/* a file that can't be deleted is logged, not an error for the person – its row is gone already */
const unlink = name => { if (name) fs.promises.unlink(fileAt(name)).catch(e => { if (e.code !== 'ENOENT') console.error(`Couldn’t delete photo file ${path.basename(name)}:`, e.code || e.message); }); };

const router = express.Router();
const send = (res, e) => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); };
const rawImage = limit => express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit });

router.get('/', (req, res) => {
  if (req.share) return res.status(404).json({ error: 'Not found' });   /* a coach sees only the photos on the Timeline's day cards */
  const from = isDate(req.query.from) ? req.query.from : '0000-01-01', to = isDate(req.query.to) ? req.query.to : '9999-12-31';
  /* ?latest=1(&to=): only the newest photo of each pose on or before `to` – or, if every photo is dated after it, the newest of
     each overall – and how many there are in all, for the Dashboard's card */
  if (req.query.latest === '1') {
    const count = q.count.get(req.user.id).n;
    let rows = count ? q.latest.all(req.user.id, to) : [];
    if (count && !rows.length) rows = q.latest.all(req.user.id, '9999-12-31');
    return res.json({ photos: rows.map(view), count });
  }
  res.json({ photos: q.list.all(req.user.id, from, to).map(view), poses: PICK, styles: STYLES, ai: ai.status().configured });
});

/* POST /api/photos?date=…&pose=…&style=… with the image itself as the body; ai=1 when the AI is to pick the pose
   (the pose sent is a stand-in until it does, and counts as not set by hand). The note comes URI-encoded in x-photo-note,
   never in the query, so it doesn't land in an access log (README's Caddy filter drops the header too). */
const noteOf = req => { const h = req.get('x-photo-note'); if (h == null) return ''; try { return decodeURIComponent(h); } catch { throw fail('Bad note'); } };
/* Uploads still being written, per account ({ n, bytes }): counted against the caps at check time, in the same synchronous
   step as the check, so parallel uploads can't all pass it (NEW-SEC-08). release() when the row is in (or the upload failed). */
const busy = new Map();
function reserve(uid, n, bytes) {
  const b = busy.get(uid) || { n: 0, bytes: 0 };
  if (n && q.count.get(uid).n + b.n + n > MAX_PHOTOS) throw fail(`You have the most photos an account can keep (${MAX_PHOTOS})`);
  if (q.bytes.get(uid).n + b.bytes + bytes > MAX_TOTAL) throw full();
  b.n += n; b.bytes += bytes; busy.set(uid, b);
  let done = false;
  return () => {
    if (done) return;
    done = true; b.n -= n; b.bytes -= bytes;
    if (!b.n && !b.bytes) busy.delete(uid);
  };
}
router.post('/', uploadLimit, rawImage(MAX_BYTES), async (req, res) => {
  try {
    const m = meta({ ...req.query, note: noteOf(req) });
    const type = sniff(req.body);
    if (!type) throw fail('That isn’t a JPEG, PNG or WebP picture');
    const file = newName(EXT[type]), bytes = clean(req.body, type);
    const release = reserve(req.user.id, 1, bytes.length);
    try {
      await fs.promises.writeFile(fileAt(file), bytes, { flag: 'wx', mode: 0o600 });
      try {
        const { lastInsertRowid } = q.add.run(req.user.id, m.date, m.pose, m.style, req.query.ai === '1' ? 1 : 0, m.note, file, type, bytes.length);
        release();
        res.json(view(q.get.get(req.user.id, Number(lastInsertRowid))));
      } catch (e) { unlink(file); throw e; }
    } finally { release(); }
  } catch (e) { send(res, e); }
});

/* the small version for the catalog, made in the browser; a JPEG */
router.put('/:id/thumb', uploadLimit, rawImage(MAX_THUMB), async (req, res) => {
  try {
    const id = idOf(req.params.id), row = q.files.get(req.user.id, id);
    if (!row) throw fail('No such photo', 404);
    if (sniff(req.body) !== 'image/jpeg') throw fail('The thumbnail must be a JPEG');
    const file = newName('.jpg'), bytes = cleanJpeg(req.body);
    const release = reserve(req.user.id, 0, bytes.length - row.thumb_size);
    try {
      await fs.promises.writeFile(fileAt(file), bytes, { flag: 'wx', mode: 0o600 });
      if (!q.thumb.run(file, bytes.length, req.user.id, id).changes) { unlink(file); throw fail('No such photo', 404); }   /* deleted meanwhile */
    } finally { release(); }
    unlink(row.thumb);
    res.json(view(q.get.get(req.user.id, id)));
  } catch (e) { send(res, e); }
});

router.put('/:id', (req, res) => {
  try {
    const id = idOf(req.params.id);
    const old = q.get.get(req.user.id, id);
    if (!old) throw fail('No such photo', 404);
    const m = meta(req.body);
    version.check(req, old.updated);
    /* a pose (or pose type) the person changes is theirs; keeping the AI's (e.g. only the note changed) leaves it the AI's, and so does
       saving the answer "Ask AI" gave (ai: true – the app sends it only when the pose and type saved are the AI's answer).
       An older client that doesn't send a pose type keeps the one there is. */
    if ((req.body || {}).style === undefined) m.style = old.style;
    const same = m.pose === old.pose && m.style === old.style;
    q.put.run(m.date, m.pose, m.style, same ? old.pose_ai : (req.body || {}).ai === true ? 2 : 0, m.note, version.stamp(), req.user.id, id);
    res.json(view(q.get.get(req.user.id, id)));
  } catch (e) { send(res, e); }
});

/* DELETE /api/photos?from=2026-01-01&to=2026-03-31: every one of your photos dated in that range (both days
   included), from Account admin. Both dates are needed, so a missing one can't wipe the lot. */
router.delete('/', (req, res) => {
  try {
    const { from, to } = req.query;
    if (!isDate(from) || !isDate(to)) throw fail('Pick the first and last dates of the photos to delete');
    if (from > to) throw fail('The first date is after the last one');
    const rows = q.delRange.all(req.user.id, from, to);
    removeFiles(rows);
    audit.log(req, 'photos.deleted', { from, to, n: rows.length });
    res.json({ deleted: rows.length });
  } catch (e) { send(res, e); }
});

router.delete('/:id', (req, res) => {
  const id = idOf(req.params.id), row = q.files.get(req.user.id, id);
  if (row) { q.del.run(req.user.id, id); unlink(row.file); unlink(row.thumb); }
  res.json({ ok: true });
});

/* Ask the AI which pose a photo shows. It is sent only the thumbnail (the app makes one first for a photo without), and
   only when the person asks: on upload with "Let AI tell", "Tag with AI" in the catalog or "Ask AI" on one photo.
   POST /api/photos/12/ai-pose {save: true} also stores the answer (marked as the AI's); without it the answer is only returned.
   {if: {pose, style}} is the pose the app saw when it asked (default: the one when the request came in); the answer is saved
   only if the photo still has it or its pose is still the AI's, so a pose set by hand meanwhile stays (saved: false). */
const POSE_PROMPT = `You sort fitness progress photos. Look at the picture and give two things.

"pose" – which way the person's body faces the camera:
- "front": the chest and face (or front of the body) toward the camera
- "back": the back toward the camera
- "left": side-on, with the person's own LEFT side (left shoulder, arm and hip) nearest the camera
- "right": side-on, with the person's own RIGHT side (right shoulder, arm and hip) nearest the camera
- "other": anything else – no person, only part of the body (e.g. just arms or legs), a face close-up, a pose in between, or you can't tell
Mirror selfies show the person reversed: judge by which of the person's own sides is toward the mirror/camera.

"style" – the pose type:
- "front_relaxed": facing the camera, standing relaxed (arms down, not flexing hard)
- "back_relaxed": back to the camera, standing relaxed
- "front_double_biceps": facing the camera, both arms raised with the upper arms out to the sides at or above shoulder height, elbows bent, flexing the biceps
- "back_double_biceps": back to the camera, both arms raised with the upper arms at or above shoulder height, elbows bent, flexing the biceps and back
- "most_muscular": facing the camera and flexing hard with the arms held LOW – below shoulder height, in front of the body or hands on hips (crab or hands-on-hips most muscular). A front flexed shot with the arms below shoulder height is always "most_muscular", never "front_double_biceps", even if the biceps are flexed
- "relaxed": standing relaxed side-on, or relaxed in any other way not listed above
- "": none of these (another flexing pose such as side chest, or you can't tell)

Reply with only {"pose": "front" | "back" | "left" | "right" | "other", "style": "front_relaxed" | "back_relaxed" | "front_double_biceps" | "back_double_biceps" | "most_muscular" | "relaxed" | ""}.`;
const poseLimit = ai.limiter(200, 'That’s a lot of photos for the AI – wait a while and try again.');
router.post('/:id/ai-pose', poseLimit, async (req, res) => {
  try {
    const id = idOf(req.params.id), row = q.files.get(req.user.id, id), was = q.get.get(req.user.id, id);
    if (!row || !was) throw fail('No such photo', 404);
    if (!row.thumb) throw fail('That photo has no small version yet – open it and try again', 409);
    const want = (req.body || {}).if, from = want && typeof want === 'object' ? { pose: String(want.pose ?? ''), style: String(want.style ?? '') } : { pose: was.pose, style: was.style || '' };
    let buf;
    try { buf = await fs.promises.readFile(fileAt(row.thumb)); } catch { throw fail('That photo’s file is missing', 404); }
    const { reply, model } = await ai.ask(POSE_PROMPT, buf, sniff(buf) || row.type, 'progress photo', { maxTokens: 200, timeout: 60000, task: 'pose' });
    const pose = PICK.includes(reply && reply.pose) ? reply.pose : 'other';
    const style = STYLES.includes(reply && reply.style) ? reply.style : '';
    const now = q.get.get(req.user.id, id);
    if (!now) throw fail('No such photo', 404);                  /* deleted while the AI was looking */
    const saved = !!(req.body && req.body.save === true) && q.aiPose.run(pose, style, version.stamp(), req.user.id, id, from.pose, from.style).changes > 0;
    res.json({ pose, style, model, saved, photo: view(q.get.get(req.user.id, id)) });
  } catch (e) { send(res, e); }
});

/* The pictures themselves: private, so no shared cache keeps them, and checked with the server on every use, so a
   deleted photo or a signed-out browser can't show one from the cache (an unchanged one comes back as a 304). */
function serve(which) {
  return (req, res) => {
    const row = (req.share ? q.shown : q.files).get(req.user.id, idOf(req.params.id));
    if (!row) return res.status(404).json({ error: 'No such photo' });
    const thumb = which === 'thumb' && row.thumb;
    /* through a coach link (req.share, server/shares.js) nothing is kept, so a switched-off link leaves no pictures behind */
    res.set({ 'Cache-Control': req.share ? 'no-store' : 'private, no-cache', 'Content-Type': thumb ? 'image/jpeg' : row.type });
    res.sendFile(fileAt(thumb || row.file), { cacheControl: false }, err => {
      if (err && !res.headersSent) res.status(404).json({ error: 'That photo’s file is missing' });
    });
  };
}
router.get('/:id/file', serve('file'));
router.get('/:id/thumb', serve('thumb'));

/* v and tv are a piece of each file's random name: the app puts them in the picture URLs, so a replaced
   thumbnail or a reused id is never served from the browser's cache. */
function view(r) {
  return { id: r.id, date: r.date, pose: r.pose, style: r.style || '', poseAi: !!r.pose_ai, aiSaw: r.pose_ai === 2, note: r.note, size: r.size, created: r.created, updated: r.updated,
    v: r.file.slice(0, 8), tv: r.thumb ? r.thumb.slice(0, 8) : null };
}

/* The export lists the photos; the pictures stay on the server (download them one by one from the app). */
const exportFor = user => q.all.all(user.id);
/* When an account is removed its rows go with it (ON DELETE CASCADE); this takes the files too. */
const filesOf = userId => q.allFiles.all(userId);
const removeFiles = rows => rows.forEach(r => { unlink(r.file); unlink(r.thumb); });

module.exports = { router, exportFor, filesOf, removeFiles, view, POSES };

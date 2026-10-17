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
const { writeZip } = require('./zip');

fs.mkdirSync(config.photoDir, { recursive: true, mode: 0o700 });

/* updated: the version a change is checked against (server/version.js) – when it was last changed, or uploaded */
const COLS = 'id, date, pose, style, pose_ai, note, size, created_at AS created, COALESCE(updated_at, created_at) AS updated, file, thumb, mid, width, height';
const q = {
  list: db.prepare(`SELECT ${COLS} FROM photos WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC`),
  get: db.prepare(`SELECT ${COLS} FROM photos WHERE user_id = ? AND id = ?`),
  /* the newest of each pose up to a date (the Dashboard's card) */
  latest: db.prepare(`SELECT ${COLS} FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY pose ORDER BY date DESC, id DESC) AS n
    FROM photos WHERE user_id = ? AND date <= ?) WHERE n = 1 ORDER BY date DESC, id DESC`),
  files: db.prepare('SELECT file, type, thumb, thumb_size, mid, mid_size FROM photos WHERE user_id = ? AND id = ?'),
  /* through a coach link: only a photo some Timeline day card shows – the latest (highest id) of its pose on its date */
  shown: db.prepare(`SELECT file, type, thumb, mid FROM photos p WHERE user_id = ? AND id = ?
    AND NOT EXISTS (SELECT 1 FROM photos o WHERE o.user_id = p.user_id AND o.pose = p.pose AND o.date = p.date AND o.id > p.id)`),
  allFiles: db.prepare('SELECT file, thumb, mid FROM photos WHERE user_id = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM photos WHERE user_id = ?'),
  bytes: db.prepare('SELECT COALESCE(SUM(size + thumb_size + mid_size), 0) AS n FROM photos WHERE user_id = ?'),
  add: db.prepare('INSERT INTO photos (user_id, date, pose, style, pose_ai, note, file, type, size, width, height, ckey) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  /* an upload sent again with the key it went with the first time (its answer was lost): the photo it made */
  byKey: db.prepare(`SELECT ${COLS} FROM photos WHERE user_id = ? AND ckey = ?`),
  put: db.prepare('UPDATE photos SET date = ?, pose = ?, style = ?, pose_ai = ?, note = ?, updated_at = ? WHERE user_id = ? AND id = ?'),
  /* the AI's pose: only while the pose is still the one the request was asked about, or still the AI's – never over a hand edit made meanwhile */
  aiPose: db.prepare('UPDATE photos SET pose = ?, style = ?, pose_ai = 2, updated_at = ? WHERE user_id = ? AND id = ? AND (pose_ai > 0 OR (pose = ? AND style = ?))'),
  /* only while the version is still the one read: of replacements made at the same time one wins, the others delete their own file */
  thumb: db.prepare('UPDATE photos SET thumb = ?, thumb_size = ? WHERE user_id = ? AND id = ? AND thumb IS ?'),
  mid: db.prepare('UPDATE photos SET mid = ?, mid_size = ? WHERE user_id = ? AND id = ? AND mid IS ?'),
  /* photos stored before their size was kept (filled in from their files at start-up; 0 × 0 when a file can't be read) */
  noSize: db.prepare('SELECT id, file FROM photos WHERE width IS NULL AND id > ? ORDER BY id LIMIT 200'),
  size: db.prepare('UPDATE photos SET width = ?, height = ? WHERE id = ?'),
  /* the download: every photo of an account (or those in a date range), oldest first */
  zip: db.prepare('SELECT id, date, pose, file, type FROM photos WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date, id'),
  del: db.prepare('DELETE FROM photos WHERE user_id = ? AND id = ?'),
  delRange: db.prepare('DELETE FROM photos WHERE user_id = ? AND date BETWEEN ? AND ? RETURNING file, thumb, mid'),
  all: db.prepare('SELECT id, date, pose, style, pose_ai, note, size, created_at AS created FROM photos WHERE user_id = ? ORDER BY date, id'),
};

const MAX_PHOTOS = 3000, MAX_BYTES = 10 * 1024 * 1024, MAX_THUMB = 512 * 1024, MAX_MID = 2 * 1024 * 1024;
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

/* A picture's width and height from its header (JPEG's frame header, PNG's IHDR, WebP's VP8 / VP8L / VP8X), or null */
function dims(b) {
  const type = sniff(b);
  try {
    if (type === 'image/png') return b.length >= 24 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
    if (type === 'image/webp') {
      const kind = b.toString('latin1', 12, 16);
      if (kind === 'VP8X' && b.length >= 30) return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
      if (kind === 'VP8L' && b.length >= 25) { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 }; }
      if (kind === 'VP8 ' && b.length >= 30) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (type !== 'image/jpeg') return null;
    let i = 2;
    while (i + 9 <= b.length && b[i] === 0xff) {
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }   /* markers without a length */
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      if (m === 0xda || m === 0xd9) return null;
      i += 2 + b.readUInt16BE(i + 2);
    }
  } catch {}
  return null;
}
const sized = d => (d && d.w > 0 && d.h > 0 ? d : null);

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

/* Photos stored before width and height were kept: read from the start of each file, a batch at a time, once (after this every
   row has them – 0 when the file is missing or unreadable, which the app treats as unknown). */
async function fillSizes() {
  for (let after = 0; ;) {
    const rows = q.noSize.all(after);
    if (!rows.length) return;
    for (const r of rows) {
      let d = null;
      try {
        const fh = await fs.promises.open(fileAt(r.file));
        try { const buf = Buffer.alloc(256 * 1024); const { bytesRead } = await fh.read(buf, 0, buf.length, 0); d = sized(dims(buf.subarray(0, bytesRead))); }
        finally { await fh.close(); }
      } catch {}
      q.size.run(d ? d.w : 0, d ? d.h : 0, r.id);
      after = r.id;
    }
    await new Promise(r => setImmediate(r));
  }
}
setImmediate(() => fillSizes().catch(e => console.error('Reading the sizes of older photos failed:', e.message)));

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
/* x-photo-key: the app's own key for this upload (one per file picked, kept while it retries): a photo already stored under it
   comes back as it is (again: true) instead of going in twice – the first try went in but its answer never arrived (p5-photos-01). */
const keyOf = req => { const k = req.get('x-photo-key'); if (k == null || k === '') return null; if (!/^[A-Za-z0-9_-]{8,64}$/.test(k)) throw fail('Bad upload key'); return k; };
router.post('/', uploadLimit, rawImage(MAX_BYTES), async (req, res) => {
  try {
    const key = keyOf(req), had = key && q.byKey.get(req.user.id, key);
    if (had) return res.json({ ...view(had), again: true });
    const m = meta({ ...req.query, note: noteOf(req) });
    const type = sniff(req.body);
    if (!type) throw fail('That isn’t a JPEG, PNG or WebP picture');
    const file = newName(EXT[type]), bytes = clean(req.body, type), d = sized(dims(bytes));
    const release = reserve(req.user.id, 1, bytes.length);
    try {
      await fs.promises.writeFile(fileAt(file), bytes, { flag: 'wx', mode: 0o600 });
      let id;
      try {
        id = Number(q.add.run(req.user.id, m.date, m.pose, m.style, req.query.ai === '1' ? 1 : 0, m.note, file, type, bytes.length, d ? d.w : 0, d ? d.h : 0, key).lastInsertRowid);
      } catch (e) {
        unlink(file);
        const again = key && q.byKey.get(req.user.id, key);   /* the same upload twice at once: the other one went in */
        if (again) return res.json({ ...view(again), again: true });
        throw e;
      }
      release();
      res.json(view(q.get.get(req.user.id, id)));
    } finally { release(); }
  } catch (e) { send(res, e); }
});

/* The smaller versions, made in the browser from the picture picked; JPEGs. thumb: the catalog's tile (480 px). mid: the photo and
   Compare pages and the coach's day card (1000 px) – the full file only when zoomed in or opened. Both count toward the account's room. */
function smaller(which) {
  return async (req, res) => {
    try {
      const id = idOf(req.params.id), row = q.files.get(req.user.id, id);
      if (!row) throw fail('No such photo', 404);
      if (sniff(req.body) !== 'image/jpeg') throw fail(`The ${which === 'mid' ? 'middle size' : 'thumbnail'} must be a JPEG`);
      const file = newName('.jpg'), bytes = cleanJpeg(req.body);
      /* the old file stays on disk until the swap, so the new one counts in full while it is written */
      const release = reserve(req.user.id, 0, bytes.length);
      let swapped = false;
      try {
        await fs.promises.writeFile(fileAt(file), bytes, { flag: 'wx', mode: 0o600 });
        swapped = q[which].run(file, bytes.length, req.user.id, id, row[which]).changes > 0;
      } catch (e) { unlink(file); throw e; } finally { release(); }
      unlink(swapped ? row[which] : file);      /* whichever lost */
      const now = q.get.get(req.user.id, id);
      if (!now) throw fail('No such photo', 404);   /* deleted meanwhile */
      res.json(view(now));                        /* not swapped: another replacement got there first, and its version stands */
    } catch (e) { send(res, e); }
  };
}
router.put('/:id/thumb', uploadLimit, rawImage(MAX_THUMB), smaller('thumb'));
router.put('/:id/mid', uploadLimit, rawImage(MAX_MID), smaller('mid'));

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
  if (row && q.del.run(req.user.id, id).changes) {
    unlink(row.file); unlink(row.thumb); unlink(row.mid);
    audit.log(req, 'photo.deleted', { id });
  }
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
    const small = which !== 'file' && row[which];   /* a version not made yet: the full picture */
    /* through a coach link (req.share, server/shares.js) nothing is kept, so a switched-off link leaves no pictures behind */
    res.set({ 'Cache-Control': req.share ? 'no-store' : 'private, no-cache', 'Content-Type': small ? 'image/jpeg' : row.type });
    res.sendFile(fileAt(small || row.file), { cacheControl: false }, err => {
      if (err && !res.headersSent) res.status(404).json({ error: 'That photo’s file is missing' });
    });
  };
}
/* GET /api/photos/zip(?from=…&to=…): the account's own pictures as they were uploaded (camera data already taken out), named by
   date (2026-09-01-front-12.jpg), in a ZIP streamed a file at a time. Limited like the data export, and logged. Never through
   a coach link. */
const zipLimit = rateLimit({
  windowMs: 60 * 60 * 1000, limit: config.exportRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => 'u' + req.user.id, message: { error: 'You’ve downloaded your photos a lot this hour – wait a while and try again.' },
});
router.get('/zip', (req, res, next) => (req.share ? res.status(404).json({ error: 'Not found' }) : next()), zipLimit, async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : '0000-01-01', to = isDate(req.query.to) ? req.query.to : '9999-12-31';
  const rows = q.zip.all(req.user.id, from, to);
  audit.log(req, 'photos.downloaded', { n: rows.length, ...(req.query.from || req.query.to ? { from, to } : {}) });
  res.attachment(`logbook-monster-photos-${(req.today || new Date().toISOString().slice(0, 10))}.zip`);
  res.type('application/zip');
  const write = b => (res.destroyed ? Promise.reject(new Error('gone')) : res.write(b) ? null : new Promise(r => {
    const go = () => { res.off('drain', go); res.off('close', go); r(); };
    res.on('drain', go); res.on('close', go);
  }));
  const entries = rows.map(r => ({
    name: `${r.date}-${r.pose}-${r.id}${EXT[r.type] || '.jpg'}`, when: new Date(`${r.date}T12:00:00`),
    read: () => fs.promises.readFile(fileAt(r.file)).catch(e => { console.error(`Photo file ${path.basename(r.file)} left out of a download:`, e.code || e.message); return null; }),
  }));
  try { await writeZip(entries, write); res.end(); }
  catch (e) { if (e.message !== 'gone') console.error(e); res.destroy(); }
});
router.get('/:id/file', serve('file'));
router.get('/:id/thumb', serve('thumb'));
router.get('/:id/mid', serve('mid'));

/* v, tv and mv are a piece of each file's random name: the app puts them in the picture URLs, so a replaced
   version or a reused id is never served from the browser's cache. w, h: the stored picture's size (null: not known). */
function view(r) {
  return { id: r.id, date: r.date, pose: r.pose, style: r.style || '', poseAi: !!r.pose_ai, aiSaw: r.pose_ai === 2, note: r.note, size: r.size, created: r.created, updated: r.updated,
    v: r.file.slice(0, 8), tv: r.thumb ? r.thumb.slice(0, 8) : null, mv: r.mid ? r.mid.slice(0, 8) : null, w: r.width || null, h: r.height || null };
}

/* The export lists the photos; the pictures themselves come as a ZIP from GET /api/photos/zip. */
const exportFor = user => q.all.all(user.id);
/* When an account is removed its rows go with it (ON DELETE CASCADE); this takes the files too. */
const filesOf = userId => q.allFiles.all(userId);
const removeFiles = rows => rows.forEach(r => { unlink(r.file); unlink(r.thumb); unlink(r.mid); });

module.exports = { router, exportFor, filesOf, removeFiles, view, POSES };

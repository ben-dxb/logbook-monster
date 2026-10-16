'use strict';
/* Progress photos: each account uploads its own pictures, dated and tagged with a pose (front, side,
   back, other), and only ever sees its own. The browser shrinks a picture to a JPEG before upload (which
   also drops its EXIF data, location included) and sends a small thumbnail after it; the server only
   checks the bytes really are a JPEG, PNG or WebP and stores them on disk under random names. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const config = require('./config');
const ai = require('./ai');

fs.mkdirSync(config.photoDir, { recursive: true });

const COLS = 'id, date, pose, pose_ai, note, size, created_at AS created, file, thumb';
const q = {
  list: db.prepare(`SELECT ${COLS} FROM photos WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC`),
  get: db.prepare(`SELECT ${COLS} FROM photos WHERE user_id = ? AND id = ?`),
  files: db.prepare('SELECT file, type, thumb FROM photos WHERE user_id = ? AND id = ?'),
  allFiles: db.prepare('SELECT file, thumb FROM photos WHERE user_id = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM photos WHERE user_id = ?'),
  add: db.prepare('INSERT INTO photos (user_id, date, pose, pose_ai, note, file, type, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  put: db.prepare('UPDATE photos SET date = ?, pose = ?, pose_ai = ?, note = ? WHERE user_id = ? AND id = ?'),
  thumb: db.prepare('UPDATE photos SET thumb = ? WHERE user_id = ? AND id = ?'),
  del: db.prepare('DELETE FROM photos WHERE user_id = ? AND id = ?'),
  delRange: db.prepare('DELETE FROM photos WHERE user_id = ? AND date BETWEEN ? AND ? RETURNING file, thumb'),
  all: db.prepare('SELECT id, date, pose, pose_ai, note, size, created_at AS created FROM photos WHERE user_id = ? ORDER BY date, id'),
};

const MAX_PHOTOS = 3000, MAX_BYTES = 10 * 1024 * 1024, MAX_THUMB = 512 * 1024;
const POSES = ['front', 'side', 'back', 'other'];
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isDate = s => typeof s === 'string' && DATE_RE.test(s) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
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
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

function meta(b) {
  const o = b || {};
  if (!isDate(o.date)) throw fail('Pick the date the photo was taken');
  const pose = o.pose == null || o.pose === '' ? 'front' : o.pose;
  if (!POSES.includes(pose)) throw fail(`Pick a pose: ${POSES.join(', ')}`);
  const note = String(o.note == null ? '' : o.note).replace(/\s+/g, ' ').trim();
  if (note.length > 200) throw fail('Note is too long (200 characters at most)');
  return { date: o.date, pose, note };
}

/* File names are random and never come from the request, so they can't point outside the folder. */
const newName = ext => crypto.randomBytes(16).toString('hex') + ext;
const fileAt = name => path.join(config.photoDir, path.basename(name));
const unlink = name => { if (name) fs.promises.unlink(fileAt(name)).catch(() => {}); };

const router = express.Router();
const send = (res, e) => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); };
const rawImage = limit => express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit });

router.get('/', (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : '0000-01-01', to = isDate(req.query.to) ? req.query.to : '9999-12-31';
  res.json({ photos: q.list.all(req.user.id, from, to).map(view), poses: POSES, ai: ai.status().configured });
});

/* POST /api/photos?date=…&pose=…&note=… with the image itself as the body; ai=1 when the AI is to pick the pose
   (the pose sent is a stand-in until it does, and counts as not set by hand) */
router.post('/', rawImage(MAX_BYTES), (req, res) => {
  try {
    const m = meta(req.query);
    const type = sniff(req.body);
    if (!type) throw fail('That isn’t a JPEG, PNG or WebP picture');
    if (q.count.get(req.user.id).n >= MAX_PHOTOS) throw fail(`You have the most photos an account can keep (${MAX_PHOTOS})`);
    const file = newName(EXT[type]);
    fs.writeFileSync(fileAt(file), req.body, { flag: 'wx' });
    try {
      const { lastInsertRowid } = q.add.run(req.user.id, m.date, m.pose, req.query.ai === '1' ? 1 : 0, m.note, file, type, req.body.length);
      res.json(view(q.get.get(req.user.id, Number(lastInsertRowid))));
    } catch (e) { unlink(file); throw e; }
  } catch (e) { send(res, e); }
});

/* the small version for the catalog, made in the browser; a JPEG */
router.put('/:id/thumb', rawImage(MAX_THUMB), (req, res) => {
  try {
    const id = idOf(req.params.id), row = q.files.get(req.user.id, id);
    if (!row) throw fail('No such photo', 404);
    if (sniff(req.body) !== 'image/jpeg') throw fail('The thumbnail must be a JPEG');
    const file = newName('.jpg');
    fs.writeFileSync(fileAt(file), req.body, { flag: 'wx' });
    q.thumb.run(file, req.user.id, id);
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
    /* a pose the person changes is theirs; keeping the AI's (e.g. only the note changed) leaves it the AI's */
    q.put.run(m.date, m.pose, m.pose === old.pose ? old.pose_ai : 0, m.note, req.user.id, id);
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
    res.json({ deleted: rows.length });
  } catch (e) { send(res, e); }
});

router.delete('/:id', (req, res) => {
  const id = idOf(req.params.id), row = q.files.get(req.user.id, id);
  if (row) { q.del.run(req.user.id, id); unlink(row.file); unlink(row.thumb); }
  res.json({ ok: true });
});

/* Ask the AI which pose a photo shows. It is sent the thumbnail (the full picture if there is none yet), and
   only when the person asks: on upload with "Let AI tell", "Tag with AI" in the catalog or "Ask AI" on one photo.
   POST /api/photos/12/ai-pose {save: true} also stores the answer (marked as the AI's); without it the answer is only returned. */
const POSE_PROMPT = `You sort fitness progress photos by pose. Look at the picture and say which way the person's body faces the camera:
- "front": the chest and face (or front of the body) toward the camera, including front double biceps and front relaxed poses
- "back": the back toward the camera, including back double biceps and rear relaxed poses
- "side": side-on to the camera, either side, including side chest and side triceps poses
- "other": anything else – no person, only part of the body (e.g. just arms or legs), a face close-up, a pose in between, or you can't tell
Reply with only {"pose": "front" | "back" | "side" | "other"}.`;
const poseLimit = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 200, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => 'u' + req.user.id,
  message: { error: 'That’s a lot of photos for the AI – wait a while and try again.' },
});
router.post('/:id/ai-pose', poseLimit, async (req, res) => {
  try {
    const id = idOf(req.params.id), row = q.files.get(req.user.id, id);
    if (!row) throw fail('No such photo', 404);
    let buf;
    try { buf = await fs.promises.readFile(fileAt(row.thumb || row.file)); } catch { throw fail('That photo’s file is missing', 404); }
    const { reply, model } = await ai.ask(POSE_PROMPT, buf, sniff(buf) || row.type, 'progress photo', { maxTokens: 200, timeout: 60000, task: 'pose' });
    const pose = POSES.includes(reply && reply.pose) ? reply.pose : 'other';
    const now = q.get.get(req.user.id, id);
    if (!now) throw fail('No such photo', 404);                  /* deleted while the AI was looking */
    if (req.body && req.body.save === true) q.put.run(now.date, pose, 1, now.note, req.user.id, id);
    res.json({ pose, model, photo: view(q.get.get(req.user.id, id)) });
  } catch (e) { send(res, e); }
});

/* The pictures themselves. Names never change, so the browser can keep them; private, so no shared cache does. */
function serve(which) {
  return (req, res) => {
    const row = q.files.get(req.user.id, idOf(req.params.id));
    if (!row) return res.status(404).json({ error: 'No such photo' });
    const thumb = which === 'thumb' && row.thumb;
    res.set({ 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Type': thumb ? 'image/jpeg' : row.type });
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
  return { id: r.id, date: r.date, pose: r.pose, poseAi: !!r.pose_ai, note: r.note, size: r.size, created: r.created,
    v: r.file.slice(0, 8), tv: r.thumb ? r.thumb.slice(0, 8) : null };
}

/* The export lists the photos; the pictures stay on the server (download them one by one from the app). */
const exportFor = user => q.all.all(user.id);
/* When an account is removed its rows go with it (ON DELETE CASCADE); this takes the files too. */
const filesOf = userId => q.allFiles.all(userId);
const removeFiles = rows => rows.forEach(r => { unlink(r.file); unlink(r.thumb); });

module.exports = { router, exportFor, filesOf, removeFiles, view, POSES, sniff };

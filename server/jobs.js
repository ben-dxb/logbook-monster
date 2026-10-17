'use strict';
/* AI reads that can take minutes (a meal plan, workout plan or supplement regime file) run in the background:
   with ?bg=1 the route answers {job} straight away and the server carries on, so the person can leave the page.
   The app asks GET /api/jobs every few seconds while one runs and shows the result when it's ready; whoever has
   stopped asking (the app closed) gets an email instead, if email is set up. Results wait here until opened. */
const express = require('express');
const db = require('./db');
const config = require('./config');
const mail = require('./mail');
const trendCache = require('./trendcache');

/* kind -> what it is and where its result is opened in the app */
const KINDS = {
  plan: { name: 'meal plan', page: '#account' },
  workout: { name: 'workout plan', page: '#gym' },
  supps: { name: 'supplement regime', page: '#supps/lib' },
};
const KEEP_DAYS = 7;       /* opened or dropped ones */
const UNSEEN_DAYS = 30;   /* finished ones nobody has opened yet */
/* No GET /api/jobs for this long = the app isn't open, so a finished read is emailed. A hidden tab polls every 10 s, but browsers
   throttle hidden tabs' timers to about once a minute (Chrome's intensive throttling), so the window is 3 minutes; a page that is
   closed says so (POST /away on pagehide), so closing the app right after starting a read still gets the email. */
const AWAY_MS = 3 * 60 * 1000;

const q = {
  add: db.prepare('INSERT INTO ai_jobs (user_id, kind, label) VALUES (?, ?, ?)'),
  done: db.prepare("UPDATE ai_jobs SET status = 'done', result = ?, finished_at = datetime('now') WHERE id = ?"),
  failed: db.prepare("UPDATE ai_jobs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?"),
  get: db.prepare('SELECT * FROM ai_jobs WHERE user_id = ? AND id = ?'),
  list: db.prepare(`SELECT id, kind, label, status, error, seen, created_at, finished_at,
    date(COALESCE(finished_at, created_at), '+${UNSEEN_DAYS} days') AS expires FROM ai_jobs
    WHERE user_id = ? AND (status = 'running' OR seen = 0) ORDER BY id DESC LIMIT 20`),
  running: db.prepare("SELECT id, kind FROM ai_jobs WHERE user_id = ? AND status = 'running'"),
  seen: db.prepare('UPDATE ai_jobs SET seen = 1 WHERE user_id = ? AND id = ?'),
  old: db.prepare(`DELETE FROM ai_jobs WHERE status <> 'running' AND (seen = 1 AND created_at < datetime('now', '-${KEEP_DAYS} days')
    OR COALESCE(finished_at, created_at) < datetime('now', '-${UNSEEN_DAYS} days'))`),
};
/* A restart drops whatever was running. */
db.prepare("UPDATE ai_jobs SET status = 'failed', error = 'The server restarted while the AI was reading it – try again', finished_at = datetime('now') WHERE status = 'running'").run();

const lastAsked = new Map();   /* user id -> when the app last asked for its jobs */
const reading = new Map();     /* user id -> kind of the read running without ?bg=1 */
const lost = new Map();        /* job id -> why it failed, for one whose end couldn't be written to the database */

/* One file read at a time per account, in the background or not. */
function idle(user) {
  const kind = reading.get(user.id) || (q.running.all(user.id).find(r => !lost.has(r.id)) || {}).kind;
  if (kind) throw Object.assign(new Error(`The AI is still reading your ${KINDS[kind] ? KINDS[kind].name : 'last file'} – wait for that one first`), { status: 409 });
}

const view = r => (lost.has(r.id) && r.status === 'running' ? { id: r.id, kind: r.kind, label: r.label, status: 'failed', error: lost.get(r.id), seen: !!r.seen }
  : { id: r.id, kind: r.kind, label: r.label, status: r.status, error: r.error || null, seen: !!r.seen,
    ...(r.status !== 'running' && !r.seen ? { expires: r.expires || null } : {}) });
/* a file name cut to its first n characters as people see them (an emoji or accented letter is never split) */
const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function cut(s, n) {
  let out = '', i = 0;
  for (const { segment } of seg.segment(String(s || ''))) { if (i++ >= n || out.length + segment.length > 2 * n) break; out += segment; }
  return out.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
}

function tell(user, kind, label, error) {
  if (Date.now() - (lastAsked.get(user.id) || 0) < AWAY_MS) return;   /* the app is open and will show it */
  const k = KINDS[kind], what = label ? `${k.name} (${label})` : k.name;
  mail.notify({
    to: user.email,
    subject: error ? `The AI couldn’t read your ${k.name}` : `Your ${k.name} is ready to check`,
    text: error
      ? `The AI couldn’t read your ${what}: ${error}\n\nTry again in Logbook Monster: ${config.baseUrl}/${k.page}\n`
      : `The AI has finished reading your ${what}.\n\nOpen Logbook Monster to check it and add it: ${config.baseUrl}/${k.page}\n\nNothing is saved until you do. It waits there for ${UNSEEN_DAYS} days.\n`,
  });
}

/* Start work() as a job for this person; returns the job. One read at a time. */
function start(user, kind, label, work) {
  if (!KINDS[kind]) throw new Error('Unknown job kind ' + kind);
  idle(user);
  q.old.run();
  label = cut(label, 120);
  const id = Number(q.add.run(user.id, kind, label).lastInsertRowid);
  /* Nothing after the answer has gone may throw out of here: an error with no one to catch it would stop the whole server. */
  const failed = (e, plain = 'Something went wrong') => {
    if (!e.status) console.error(`AI ${kind} read ${id}:`, e);
    const msg = e.status ? String(e.message).slice(0, 500) : plain;
    try { q.failed.run(msg, id); } catch (e2) { console.error(`AI ${kind} read ${id}: couldn’t record that it failed:`, e2); lost.set(id, msg); }
    try { tell(user, kind, label, msg); } catch (e2) { console.error(e2); }
  };
  Promise.resolve().then(work).then(result => {
    trendCache.bump(user.id);   /* it ran after the request's answer went: whatever it wrote, kept trends go stale */
    try { q.done.run(JSON.stringify(result), id); } catch (e) { return failed(e, 'The AI read it, but the app couldn’t keep the result – try again'); }
    try { tell(user, kind, label); } catch (e) { console.error(e); }
  }, e => { trendCache.bump(user.id); failed(e); }).catch(e => console.error(`AI ${kind} read ${id}:`, e));
  return view(q.get.get(user.id, id));
}

/* For a route: with ?bg=1 run as a job (checks that can fail at once run first), otherwise answer with the result as before.
   The file's name, if the app sends it (x-file-name, URI-encoded), labels the job. */
async function respond(req, res, kind, precheck, work) {
  try {
    if (precheck) precheck();
    if (req.query.bg === '1') {
      let label = '';
      try { label = decodeURIComponent(String(req.get('x-file-name') || '')).replace(/[\x00-\x1f]/g, ''); } catch {}
      return res.status(202).json({ job: start(req.user, kind, label, work) });
    }
    idle(req.user);
    reading.set(req.user.id, kind);
    try { res.json(await work()); } finally { reading.delete(req.user.id); }
  } catch (e) { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); }
}

const router = express.Router();
/* The ones still running or not opened yet (newest first) – no results here, they can be big. */
router.get('/', (req, res) => { lastAsked.set(req.user.id, Date.now()); res.json({ jobs: q.list.all(req.user.id).filter(r => !(lost.has(r.id) && r.seen)).map(view) }); });
/* The app was closed (pagehide): email the next finished read rather than wait out AWAY_MS. Another open tab's next poll marks it open again. */
router.post('/away', (req, res) => { lastAsked.delete(req.user.id); res.json({ ok: true }); });
router.get('/:id', (req, res) => {
  const r = q.get.get(req.user.id, +req.params.id || 0);
  if (!r) return res.status(404).json({ error: 'That AI read is gone' });
  const v = view(r);
  let result = null;
  try { result = v.status === 'done' && r.result ? JSON.parse(r.result) : null; } catch { return res.json({ ...v, status: 'failed', error: 'That AI read couldn’t be opened – try reading the file again', result: null }); }
  res.json({ ...v, result });
});
/* Opened or dismissed: off the list. */
router.post('/:id/seen', (req, res) => {
  const r = q.get.get(req.user.id, +req.params.id || 0);
  if (!r) return res.status(404).json({ error: 'That AI read is gone' });
  q.seen.run(req.user.id, r.id);
  res.json({ ok: true });
});

module.exports = { router, respond, start, AWAY_MS };

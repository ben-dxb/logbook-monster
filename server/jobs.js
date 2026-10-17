'use strict';
/* AI reads that can take minutes (a meal plan, workout plan or supplement regime file) run in the background:
   with ?bg=1 the route answers {job} straight away and the server carries on, so the person can leave the page.
   The app asks GET /api/jobs every few seconds while one runs and shows the result when it's ready; whoever has
   stopped asking (the app closed) gets an email instead, if email is set up. Results wait here until opened. */
const express = require('express');
const db = require('./db');
const config = require('./config');
const mail = require('./mail');

/* kind -> what it is and where its result is opened in the app */
const KINDS = {
  plan: { name: 'meal plan', page: '#account' },
  workout: { name: 'workout plan', page: '#gym' },
  supps: { name: 'supplement regime', page: '#supps/lib' },
};
const KEEP_DAYS = 7;
const AWAY_MS = 30000;   /* no GET /api/jobs for this long = the app isn't open */

const q = {
  add: db.prepare('INSERT INTO ai_jobs (user_id, kind, label) VALUES (?, ?, ?)'),
  done: db.prepare("UPDATE ai_jobs SET status = 'done', result = ?, finished_at = datetime('now') WHERE id = ?"),
  failed: db.prepare("UPDATE ai_jobs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?"),
  get: db.prepare('SELECT * FROM ai_jobs WHERE user_id = ? AND id = ?'),
  list: db.prepare(`SELECT id, kind, label, status, error, seen, created_at, finished_at FROM ai_jobs
    WHERE user_id = ? AND (status = 'running' OR seen = 0) ORDER BY id DESC LIMIT 20`),
  running: db.prepare("SELECT id FROM ai_jobs WHERE user_id = ? AND kind = ? AND status = 'running'"),
  seen: db.prepare('UPDATE ai_jobs SET seen = 1 WHERE user_id = ? AND id = ?'),
  old: db.prepare(`DELETE FROM ai_jobs WHERE status <> 'running' AND created_at < datetime('now', '-${KEEP_DAYS} days')`),
};
/* A restart drops whatever was running. */
db.prepare("UPDATE ai_jobs SET status = 'failed', error = 'The server restarted while the AI was reading it – try again', finished_at = datetime('now') WHERE status = 'running'").run();

const lastAsked = new Map();   /* user id -> when the app last asked for its jobs */

const view = r => ({ id: r.id, kind: r.kind, label: r.label, status: r.status, error: r.error || null, seen: !!r.seen,
  created: r.created_at, finished: r.finished_at || null });

function tell(user, kind, label, error) {
  if (Date.now() - (lastAsked.get(user.id) || 0) < AWAY_MS) return;   /* the app is open and will show it */
  const k = KINDS[kind], what = label ? `${k.name} (${label})` : k.name;
  mail.notify({
    to: user.email,
    subject: error ? `The AI couldn’t read your ${k.name}` : `Your ${k.name} is ready to check`,
    text: error
      ? `The AI couldn’t read your ${what}: ${error}\n\nTry again in Logbook Monster: ${config.baseUrl}/${k.page}\n`
      : `The AI has finished reading your ${what}.\n\nOpen Logbook Monster to check it and add it: ${config.baseUrl}/${k.page}\n\nNothing is saved until you do.\n`,
  });
}

/* Start work() as a job for this person; returns the job. One of each kind at a time. */
function start(user, kind, label, work) {
  if (!KINDS[kind]) throw new Error('Unknown job kind ' + kind);
  if (q.running.get(user.id, kind)) throw Object.assign(new Error(`The AI is still reading your last ${KINDS[kind].name} – wait for that one first`), { status: 409 });
  q.old.run();
  const id = Number(q.add.run(user.id, kind, String(label || '').slice(0, 120)).lastInsertRowid);
  Promise.resolve().then(work).then(
    result => { q.done.run(JSON.stringify(result), id); tell(user, kind, label); },
    e => {
      if (!e.status) console.error(e);
      const msg = e.status ? String(e.message).slice(0, 500) : 'Something went wrong';
      q.failed.run(msg, id); tell(user, kind, label, msg);
    });
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
    res.json(await work());
  } catch (e) { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); }
}

const router = express.Router();
/* The ones still running or not opened yet (newest first) – no results here, they can be big. */
router.get('/', (req, res) => { lastAsked.set(req.user.id, Date.now()); res.json({ jobs: q.list.all(req.user.id).map(view) }); });
router.get('/:id', (req, res) => {
  const r = q.get.get(req.user.id, +req.params.id || 0);
  if (!r) return res.status(404).json({ error: 'That AI read is gone' });
  res.json({ ...view(r), result: r.result ? JSON.parse(r.result) : null });
});
/* Opened or dismissed: off the list. */
router.post('/:id/seen', (req, res) => {
  const r = q.get.get(req.user.id, +req.params.id || 0);
  if (!r) return res.status(404).json({ error: 'That AI read is gone' });
  q.seen.run(req.user.id, r.id);
  res.json({ ok: true });
});

module.exports = { router, start, respond, KINDS };

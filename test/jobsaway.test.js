'use strict';
/* PR-PL-057: a hidden tab whose polling the browser throttles to about once a minute still counts as the app being open, so a
   finished AI read isn't emailed to someone looking at it; a page that says it closed (POST /api/jobs/away) gets the email at once. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const [PORT] = require('./_ports').freePorts(1);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-jobsaway-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 't.db'), SESSION_SECRET: 'x'.repeat(40) });
const db = require('../server/db');
const mail = require('../server/mail');
const jobs = require('../server/jobs');
const sent = [];
mail.notify = m => sent.push(m);

const uid = Number(db.prepare("INSERT INTO users (email) VALUES ('ann@example.com')").run().lastInsertRowid);
const user = { id: uid, email: 'ann@example.com' };
const app = express();
app.use((req, res, next) => { req.user = user; next(); });
app.use('/api/jobs', jobs.router);
let srv;
test.before(() => new Promise(r => { srv = app.listen(PORT, '127.0.0.1', r); }));
test.after(() => { srv.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = (method, url) => fetch(`http://127.0.0.1:${PORT}${url}`, { method }).then(r => r.json());
const realNow = Date.now;
/* a read that finishes `later` ms after the app last asked for its jobs */
async function read(later) {
  await call('GET', '/api/jobs');
  Date.now = () => realNow() + later;
  try {
    let done;
    const finished = new Promise(r => { done = r; });
    jobs.start(user, 'workout', 'plan.pdf', async () => { setImmediate(done); return { workouts: [] }; });
    await finished; await new Promise(r => setImmediate(r));
  } finally { Date.now = realNow; }
}

test('a hidden tab polling once a minute still counts as open: no email', async () => {
  assert.ok(jobs.AWAY_MS >= 2 * 60 * 1000, 'longer than a throttled hidden tab’s polling');
  sent.length = 0;
  await read(70 * 1000);
  assert.strictEqual(sent.length, 0);
});

test('no poll for longer than the window, or the page said it closed: the email goes', async () => {
  sent.length = 0;
  await read(jobs.AWAY_MS + 1000);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].subject, /workout plan is ready/);
  await call('GET', '/api/jobs');
  assert.deepStrictEqual(await call('POST', '/api/jobs/away'), { ok: true });
  sent.length = 0;
  let done;
  const finished = new Promise(r => { done = r; });
  jobs.start(user, 'workout', 'plan.pdf', async () => { setImmediate(done); return { workouts: [] }; });
  await finished; await new Promise(r => setImmediate(r));
  assert.strictEqual(sent.length, 1, 'closed right after asking: emailed straight away');
});

'use strict';
/* Background AI reads and plan saves (phase 2C, plan group): a failed write after a read never stops the server, unopened
   results are kept, labels are cut on whole characters, the AI's pudding and 13th template, the workout read in the
   background, "today" in the person's time zone, contradictory food limits and a damaged saved plan. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { todayIn } = require('../server/dates');

const [PORT, AI_PORT] = require('./_ports').freePorts(2);
/* Stands in for OpenRouter: a workout plan, a food's values, or a meal plan (13 templates and rice pudding for a file saying MANY) */
const reply = (res, obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: JSON.stringify(obj) } }] })); };
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const b = JSON.parse(body), sys = b.messages[0].content, file = b.messages[1].content[1];
    if (/workout tracking app/.test(sys)) return reply(res, { workouts: [{ name: 'Upper A', exercises: [{ name: 'Bench press', target: '3 × 8' }] }], notes: [] });
    if (/estimate nutrition values/.test(sys)) return reply(res, { k: 120, p: 22, c: 0, f: 3, source: 'USDA', basis: [], confidence: 'high', at: '1999-01-01' });
    const text = file && file.file ? Buffer.from(file.file.file_data.split(',')[1], 'base64').toString() : '';
    const meal = f => [{ id: '1', name: 'Meal', p: [], c: [{ f, g: 150 }], x: [] }];
    if (/MANY/.test(text)) {
      const ids = Array.from({ length: 13 }, (_, i) => 'A' + (i + 1));
      return reply(res, { templates: ids.map(id => ({ id, name: 'Day ' + id })), plan: Object.fromEntries(ids.map(id => [id, meal('pudding')])),
        foods: { pudding: { n: 'Hijacked pudding', k: 1, p: 1, c: 1, f: 1, step: 5 } } });
    }
    reply(res, { templates: [{ id: 'T', name: 'Training' }], plan: { T: meal('oats') }, foods: { oats: { n: 'Oats', k: 380, p: 13, c: 60, f: 7, step: 5, group: 'c' } } });
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-planreads-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: 'sk-test-key-1234', OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}` };
let srv, db;

before(async () => {
  await new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r));
  for (const who of ['admin', 'ann', 'bob', 'cara', 'dan']) {
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', `${who}@example.com`],
      { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  }
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  db = new DatabaseSync(env.DB_PATH);
});
after(() => { db.close(); srv.kill(); fakeAi.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function signIn(email) {
  let cookie = '', csrf = '';
  const req = async (method, url, body, headers = {}) => {
    const file = Buffer.isBuffer(body);
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': file ? 'application/pdf' : 'application/json' } : {}), 'x-csrf-token': csrf, ...headers },
      body: file ? body : body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j, headers: r.headers };
  };
  await req('GET', '/auth/config');
  assert.strictEqual((await req('POST', '/auth/login', { email, password: 'long-password-1' })).status, 200);
  await req('GET', '/api/me');
  return req;
}
const pdf = s => Buffer.from('%PDF-1.4 ' + s);
const read = (c, url, name, text = 'plan') => c('POST', url + '?bg=1', pdf(text), { 'x-file-name': encodeURIComponent(name) });
async function waitJob(c, id) {
  for (let i = 0; i < 100; i++) {
    const r = await c('GET', '/api/jobs/' + id);
    if (r.body.status !== 'running') return r.body;
    await new Promise(ok => setTimeout(ok, 50));
  }
  throw new Error('job never finished');
}
const alive = async () => { try { return (await fetch(BASE + '/healthz')).ok; } catch { return false; } };

test('PR-PL-055: a failed write after a background read fails the job – the server keeps running', async () => {
  const ann = await signIn('ann@example.com');
  db.exec(`CREATE TRIGGER fail_done BEFORE UPDATE OF status ON ai_jobs WHEN NEW.label = 'FAILDONE' AND NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    CREATE TRIGGER fail_both BEFORE UPDATE OF status ON ai_jobs WHEN NEW.label = 'FAILBOTH' AND NEW.status <> 'running' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
  let r = await read(ann, '/api/my/ai-import', 'FAILDONE');
  assert.strictEqual(r.status, 202, JSON.stringify(r.body));
  let job = await waitJob(ann, r.body.job.id);
  assert.deepStrictEqual([job.status, job.error], ['failed', 'The AI read it, but the app couldn’t keep the result – try again']);
  assert.ok(await alive(), 'the server is still up');
  /* not even the failure can be written: it shows as failed and doesn't block the next read */
  r = await read(ann, '/api/my/ai-import', 'FAILBOTH');
  job = await waitJob(ann, r.body.job.id);
  assert.strictEqual(job.status, 'failed');
  assert.ok(await alive(), 'the server is still up');
  assert.deepStrictEqual((await ann('GET', '/api/jobs')).body.jobs.map(j => j.status), ['failed', 'failed']);
  r = await read(ann, '/api/my/ai-import', 'next.pdf');
  assert.strictEqual(r.status, 202, 'a read whose end couldn’t be written doesn’t hold up the next');
  assert.strictEqual((await waitJob(ann, r.body.job.id)).status, 'done');
  for (const j of (await ann('GET', '/api/jobs')).body.jobs) await ann('POST', `/api/jobs/${j.id}/seen`, {});
  assert.deepStrictEqual((await ann('GET', '/api/jobs')).body.jobs, []);
  db.exec('DROP TRIGGER fail_done; DROP TRIGGER fail_both;');
});

test('PR-PL-058: an unopened result is kept 30 days and says until when; opened ones go after 7', async () => {
  const bob = await signIn('bob@example.com');
  const ids = [];
  for (const name of ['unseen8', 'seen8', 'unseen31']) {
    const r = await read(bob, '/api/my/ai-import', name);
    ids.push(r.body.job.id);
    await waitJob(bob, r.body.job.id);
  }
  await bob('POST', `/api/jobs/${ids[1]}/seen`, {});
  const back = (id, days) => db.prepare(`UPDATE ai_jobs SET created_at = datetime('now', '-${days} days'), finished_at = datetime('now', '-${days} days') WHERE id = ?`).run(id);
  back(ids[0], 8); back(ids[1], 8); back(ids[2], 31);
  const cara = await signIn('cara@example.com');
  await waitJob(cara, (await read(cara, '/api/my/ai-import', 'tidy.pdf')).body.job.id);   /* any new read tidies old ones */
  const list = (await bob('GET', '/api/jobs')).body.jobs;
  assert.deepStrictEqual(list.map(j => j.label), ['unseen8']);
  const exp = new Date(Date.now() + 22 * 86400000).toISOString().slice(0, 10);
  assert.ok(list[0].expires === exp || list[0].expires === new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10), list[0].expires);
  assert.strictEqual((await bob('GET', '/api/jobs/' + ids[0])).body.status, 'done');
  assert.strictEqual((await bob('GET', '/api/jobs/' + ids[1])).status, 404);
  assert.strictEqual((await bob('GET', '/api/jobs/' + ids[2])).status, 404);
  await bob('POST', `/api/jobs/${ids[0]}/seen`, {});
});

test('NEW-plan-02: a job label is cut on whole characters', async () => {
  const dan = await signIn('dan@example.com');
  for (const [name, want] of [['a'.repeat(119) + '😀', 'a'.repeat(119) + '😀'], ['a'.repeat(118) + '👨‍👩‍👧b', 'a'.repeat(118) + '👨‍👩‍👧b'],
    ['a'.repeat(120) + '😀', 'a'.repeat(120)], ['b'.repeat(119) + '👨‍👩‍👧' + 'c', 'b'.repeat(119) + '👨‍👩‍👧']]) {
    const r = await read(dan, '/api/my/ai-import', name);
    assert.strictEqual(r.body.job.label, want);
    await waitJob(dan, r.body.job.id);
    await dan('POST', `/api/jobs/${r.body.job.id}/seen`, {});
  }
});

test('PR-PL-056 / 061: rice pudding stays in an AI plan read; a 13th day template is left out with a note', async () => {
  const dan = await signIn('dan@example.com');
  const job = await waitJob(dan, (await read(dan, '/api/my/ai-import', 'many.pdf', 'MANY')).body.job.id);
  assert.strictEqual(job.status, 'done', JSON.stringify(job));
  assert.strictEqual(job.result.templates.length, 12);
  assert.deepStrictEqual(job.result.plan.A1[0].c, [{ f: 'pudding', g: 150, lock: false }]);
  assert.ok(!job.result.foods.pudding, 'the batch’s pudding isn’t redefined by the AI');
  assert.ok(job.result.notes.some(n => /Left out the day template Day A13 – a plan can have 12 at most/.test(n)), JSON.stringify(job.result.notes));
  assert.ok(!job.result.notes.some(n => /pudding/.test(n)), JSON.stringify(job.result.notes));
  await dan('POST', `/api/jobs/${job.id}/seen`, {});
});

test('PR-PL-062: the workout plan read works in the background', async () => {
  const dan = await signIn('dan@example.com');
  const r = await read(dan, '/api/gym/ai-import', 'workout.pdf');
  assert.strictEqual(r.status, 202, JSON.stringify(r.body));
  assert.strictEqual(r.body.job.kind, 'workout');
  const job = await waitJob(dan, r.body.job.id);
  assert.strictEqual(job.status, 'done', JSON.stringify(job));
  assert.strictEqual(job.result.workouts[0].name, 'Upper A');
  await dan('POST', `/api/jobs/${job.id}/seen`, {});
});

test('PR-PL-030 / PR-FS-032: "today" is the person’s date from the time zone the app sends', async () => {
  const ann = await signIn('ann@example.com');
  /* Kiritimati (UTC+14) is always a day or two ahead of UTC−12 */
  const ahead = 'Pacific/Kiritimati', behind = 'Etc/GMT+12', aheadDay = todayIn(ahead);
  assert.notStrictEqual(aheadDay, todayIn(behind));
  /* (the plan in effect is picked in the browser, from its own date: GET /api/defaults sends every change, no "today" there) */
  /* the AI fill date stamp and the export's file name */
  const r = await ann('POST', '/api/foods/ai-fill', { name: 'Chicken breast', unit: 'g', kind: 'ingredient', k: '', p: '', c: '', f: '' }, { 'x-time-zone': ahead });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.ai.at, aheadDay);
  const ex = await ann('GET', '/api/export?tz=' + encodeURIComponent(behind));
  assert.match(ex.headers.get('content-disposition'), new RegExp(`logbook-monster-${todayIn(behind)}\\.json`));
});

test('PR-PL-042: contradictory food limits are refused', async () => {
  const ann = await signIn('ann@example.com');
  const save = f => ann('PUT', '/api/my/defaults', { foods: { x: { n: 'X', k: 100, p: 10, c: 5, f: 2, step: 5, ...f } } });
  let r = await save({ min: 300, max: 100 });
  assert.deepStrictEqual([r.status, r.body.error], [400, 'X: the min serving (300) is more than the max serving (100)']);
  r = await save({ d: 50 });
  assert.deepStrictEqual([r.status, r.body.error], [400, 'X: direct protein (50) is more than its protein (10)']);
  assert.strictEqual((await save({ min: 100, max: 100, d: 10 })).status, 200);
  await ann('DELETE', '/api/my/defaults');
});

test('PR-PL-029: a plan change with no templates and no foods is no plan, whatever free foods say', async () => {
  const ann = await signIn('ann@example.com');
  const r = await ann('PUT', '/api/my/defaults', { free: { sauce: false, veg: false } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { myVersions: [] });
});

test('PR-PL-043: a damaged saved plan gets a plain message, never the parser’s', async () => {
  const cara = await signIn('cara@example.com');
  assert.strictEqual((await cara('PUT', '/api/my/defaults', { foods: { oats: { n: 'Oats', k: 380, p: 13, c: 60, f: 7, step: 5 } } })).status, 200);
  db.prepare("UPDATE user_defaults SET data = 'not json' WHERE user_id = (SELECT id FROM users WHERE email = 'cara@example.com')").run();
  for (const [m, u, b] of [['GET', '/api/defaults'], ['PUT', '/api/my/defaults', { from: '2026-12-01' }], ['DELETE', '/api/my/defaults/2026-12-01']]) {
    const r = await cara(m, u, b);
    assert.strictEqual(r.status, 500, `${m} ${u}`);
    assert.strictEqual(r.body.error, 'Your saved meal plan couldn’t be read – ask the person who runs this app to look at it', `${m} ${u}`);
  }
  assert.strictEqual((await cara('DELETE', '/api/my/defaults')).status, 200, 'deleting the whole plan still works');
  assert.deepStrictEqual((await cara('GET', '/api/defaults')).body, { mine: null, myVersions: [] });
});

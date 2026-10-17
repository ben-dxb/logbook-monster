'use strict';
/* Phase 8: a slow, failing or misbehaving AI service can't tie up the server. A fake OpenRouter that hangs, is slow, answers 500,
   429 or 401, drops the connection mid-reply or sends a huge reply; the AI calls go through an in-process Express app with the
   real scope and hourly limiter, so what counts against the limits is checked too. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const [AI_PORT, APP_PORT] = require('./_ports').freePorts(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-breakers-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 't.db'), SESSION_SECRET: 'x'.repeat(40), OPENROUTER_API_KEY: 'sk-test-key-1234',
  OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}`, ADMIN_EMAILS: '' });

let mode = 'ok', hits = 0, open = 0, most = 0, retryAfter = '1', delay = 400;
const OK = JSON.stringify({ model: 'fake/model', choices: [{ message: { content: '{"ok": true}' }, finish_reason: 'stop' }] });
const fake = http.createServer((req, res) => {
  hits++; open++; most = Math.max(most, open);
  res.on('close', () => open--);
  req.resume();
  req.on('end', () => {
    if (mode === 'hang') return;
    if (mode === 'slow') return setTimeout(() => res.end(OK), delay);
    if (mode === 'ok') return res.end(OK);
    if (mode === '500') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"upstream down","code":500}}'); }
    if (mode === '429') { res.writeHead(429, { 'retry-after': retryAfter }); return res.end('{"error":{"message":"slow down","code":429}}'); }
    if (mode === '401') { res.writeHead(401); return res.end('{"error":{"message":"bad key","code":401}}'); }
    if (mode === 'drop') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"choices":[{"mess'); return setTimeout(() => res.destroy(), 20); }
    if (mode === 'short') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"choices":[{"mess'); }
    if (mode === 'declared') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(100 * 1024 * 1024) }); return res.write('{'); }
    if (mode === 'huge') {   /* chunked, no length: 5 MB of padding */
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(64 * 1024, 32);
      let n = 0;
      const more = () => { while (n < 80) { n++; if (!res.write(chunk)) return res.once('drain', more); } res.end(OK); };
      return more();
    }
  });
});

const ai = require('../server/ai');
const jobs = require('../server/jobs');
const db = require('../server/db');
const express = require('express');
const UID = Number(db.prepare("INSERT INTO users (email) VALUES ('ann@example.com')").run().lastInsertRowid);
const app = express();
app.use((req, res, next) => { req.user = { id: +req.get('x-user') || UID, email: 'ann@example.com' }; next(); });
app.use(ai.scope);
const send = (res, e) => res.status(e.status || 500).json({ error: e.message });
app.post('/fill', ai.limiter(3, 'That’s a lot of AI estimates'), async (req, res) => {
  try { res.json(await ai.askText('system', 'text', { task: 'food' })); } catch (e) { send(res, e); }
});
app.post('/read', ai.limiter(2, 'That’s a lot of AI reads'), (req, res) => jobs.respond(req, res, 'plan', null, () => ai.askText('system', 'text', { task: 'food', timeout: 2000 })));
let srv;
const base = `http://127.0.0.1:${APP_PORT}`;
const post = (p, user) => fetch(base + p, { method: 'POST', headers: user ? { 'x-user': String(user) } : {} });
const usage = () => db.prepare('SELECT COALESCE(SUM(calls), 0) AS n FROM ai_usage').get().n;
const L = { ...ai.LIMITS };

test.before(async () => {
  await new Promise(r => fake.listen(AI_PORT, '127.0.0.1', r));
  await new Promise(r => { srv = app.listen(APP_PORT, '127.0.0.1', r); });
});
test.beforeEach(() => { Object.assign(ai.LIMITS, L); ai.breaker.reset('test'); mode = 'ok'; hits = 0; most = 0; });
test.after(() => { fake.closeAllConnections(); fake.close(); srv.closeAllConnections(); srv.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const text = (opts = {}) => ai.askText('system', 'text', { task: 'food', ...opts });

test('a huge reply is refused without reading it all, whether its length is declared or not', async () => {
  ai.LIMITS.maxReply = 1024 * 1024;
  for (const m of ['huge', 'declared']) {
    mode = m;
    const t = Date.now(), before = process.memoryUsage().rss;
    await assert.rejects(text(), e => e.status === 502 && e.message === 'The AI reply was too large', m);
    assert.ok(Date.now() - t < 3000, m);
    assert.ok(process.memoryUsage().rss - before < 50 * 1024 * 1024, m);
  }
  mode = 'ok';
  assert.deepStrictEqual((await text()).reply, { ok: true }, 'a normal reply still reads');
});

test('a reply cut off mid-body is "cut off", not "empty"', async () => {
  for (const m of ['drop', 'short']) {
    mode = m;
    await assert.rejects(text(), e => e.status === 502 && e.message === 'The AI reply was cut off – try again', m);
  }
});

test('timeouts are worded by task: only the file reads say to use a smaller file', async () => {
  mode = 'hang';
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  await assert.rejects(ai.ask('system', jpeg, 'image/jpeg', 'progress photo', { task: 'pose', timeout: 200 }),
    e => e.message === 'The AI took too long – try again in a minute');
  for (const task of ['plan', 'workout', 'supps']) {
    await assert.rejects(ai.ask('system', Buffer.from('%PDF-1.4 x'), 'application/pdf', 'plan', { task, timeout: 200 }),
      e => e.message === 'The AI took too long – try again or use a smaller file', task);
  }
});

test('a text task gets 45 s (here 200 ms) for its first byte, not its whole wait', async () => {
  mode = 'hang';
  ai.LIMITS.firstByte = 200;
  const t = Date.now();
  await assert.rejects(text(), e => e.status === 502 && e.message === 'The AI took too long – try again in a minute');
  assert.ok(Date.now() - t < 2000, `${Date.now() - t} ms`);
});

test('failed upstream calls use none of the hourly limit or the daily count; answered ones do', async () => {
  ai.LIMITS.fails = 100;   /* this test is about counting, not the breaker */
  const was = usage();
  for (const m of ['500', 'hang', 'drop']) {
    mode = m;
    ai.LIMITS.firstByte = 150;
    for (let i = 0; i < 4; i++) { const r = await post('/fill'); assert.strictEqual(r.status, 502, `${m} ${i}`); }
  }
  assert.strictEqual(usage(), was, 'nothing counted in ai_usage');
  mode = 'ok';
  for (let i = 0; i < 3; i++) assert.strictEqual((await post('/fill')).status, 200, `answered ${i}`);
  assert.strictEqual(usage(), was + 3);
  assert.strictEqual((await post('/fill')).status, 429, 'the hourly limit counts answered calls');
});

test('a background read whose AI call failed gives its count back', async () => {
  ai.LIMITS.fails = 100;
  mode = '500';
  for (let i = 0; i < 4; i++) {
    const r = await post('/read?bg=1');
    assert.strictEqual(r.status, 202, `read ${i}`);
    for (let k = 0; k < 100 && db.prepare("SELECT 1 FROM ai_jobs WHERE status = 'running'").get(); k++) await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE status = 'failed'").get().n >= 4);
});

test('at most 3 calls at once per account and 16 app-wide; past 10 s (here 300 ms) in the queue it is 503 busy', async () => {
  mode = 'slow'; delay = 600; ai.LIMITS.queueWait = 300;
  const one = await Promise.allSettled([1, 2, 3, 4, 5].map(() => text()));
  assert.strictEqual(most, 3, 'one account: 3 sockets at most');
  assert.strictEqual(one.filter(r => r.status === 'fulfilled').length, 3);
  for (const r of one.filter(r => r.status === 'rejected')) assert.deepStrictEqual([r.reason.status, r.reason.message], [503, 'The AI is busy – try again in a minute']);
  /* a call that waits its turn gets it */
  ai.LIMITS.queueWait = 2000; most = 0; delay = 150;
  const waited = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(() => text()));
  assert.ok(waited.every(r => r.status === 'fulfilled'), 'all six run, three at a time');
  assert.strictEqual(most, 3);
  /* app-wide: 4 accounts × 3, cap 5 here */
  ai.LIMITS.all = 5; most = 0; delay = 300; ai.LIMITS.queueWait = 5000;
  const all = await Promise.all([1, 2, 3, 4].flatMap(u => [1, 2, 3].map(() => post('/fill', 1000 + u).then(r => r.status))));
  assert.ok(all.every(s => s === 200), String(all));
  assert.strictEqual(most, 5, 'app-wide: 5 sockets at most');
  assert.strictEqual(ai.seats.all, 0, 'every slot given back');
});

test('the breaker opens after 5 failures, fails at once with Retry-After, half-opens and closes on an answer', async () => {
  mode = '500'; ai.LIMITS.openFirst = 300;
  for (let i = 0; i < 5; i++) await assert.rejects(text(), e => e.status === 502);
  assert.strictEqual(ai.breaker.state, 'open');
  const n = hits, t = Date.now();
  const r = await post('/fill', 77);
  assert.strictEqual(r.status, 503);
  assert.strictEqual((await r.json()).error, 'The AI service isn’t answering right now – try again in a few minutes');
  assert.ok(+r.headers.get('retry-after') >= 1);
  await assert.rejects(text(), e => e.status === 503);
  assert.ok(Date.now() - t < 200, 'fails at once');
  assert.strictEqual(hits, n, 'nothing sent while open');
  /* half-open: one call through; a failure doubles the wait */
  await new Promise(r => setTimeout(r, 350));
  await assert.rejects(text(), e => e.status === 502);
  assert.deepStrictEqual([ai.breaker.state, ai.breaker.wait], ['open', 600]);
  await new Promise(r => setTimeout(r, 650));
  mode = 'slow'; delay = 200;
  const probe = text(), other = text();
  await assert.rejects(other, e => e.status === 503, 'only one call while half-open');
  assert.deepStrictEqual((await probe).reply, { ok: true });
  assert.strictEqual(ai.breaker.state, 'closed');
  const log = db.prepare("SELECT detail FROM audit WHERE event = 'ai.breaker' ORDER BY id").all().map(x => JSON.parse(x.detail).id);
  assert.deepStrictEqual(log, ['open', 'close'], 'opening and closing logged (once a day)');
});

test('half or more of the last 20 calls failing opens it too', async () => {
  for (let i = 0; i < 20; i++) {
    mode = i % 2 ? '500' : 'ok';
    ai.LIMITS.failWindow = 1;   /* so the 5-in-a-minute rule doesn't fire first */
    await text().catch(() => {});
    await new Promise(r => setTimeout(r, 2));
  }
  assert.strictEqual(ai.breaker.state, 'open');
});

test('a 429 opens it at once for its Retry-After (2 minutes at most); a refused key for 10 minutes until a new key is saved', async () => {
  mode = '429'; retryAfter = '1';
  await assert.rejects(text(), e => e.status === 502 && /busy/.test(e.message));
  assert.strictEqual(ai.breaker.state, 'open');
  assert.ok(Math.abs(ai.breaker.until - Date.now() - 1000) < 200);
  ai.breaker.reset('test'); retryAfter = '3600';
  await assert.rejects(text());
  assert.ok(ai.breaker.until - Date.now() <= 120000 && ai.breaker.until - Date.now() > 110000, 'capped at 2 minutes');

  ai.breaker.reset('test'); mode = '401';
  await assert.rejects(text(), e => /didn’t accept the app’s key/.test(e.message));
  assert.ok(ai.breaker.until - Date.now() > 9 * 60000);
  await assert.rejects(text(), e => e.status === 503 && /didn’t accept the app’s key/.test(e.message), 'fails at once, saying why');
  ai.save({ key: 'sk-test-key-5678' });
  assert.strictEqual(ai.breaker.state, 'closed', 'a new key closes it');
  mode = 'ok';
  assert.deepStrictEqual((await text()).reply, { ok: true });
});

test('a waited-for file read gets 3 minutes, one in the background 5', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'ai.js'), 'utf8');
  assert.match(src, /FILE_WAIT = 3 \* MIN, BG_WAIT = 5 \* MIN/);
  assert.match(src, /s && s\.bg \? BG_WAIT : FILE_WAIT/);
});

test('file reads running out of time never open the breaker for the other tasks; text-task timeouts do', async () => {
  mode = 'hang';
  for (let i = 0; i < 8; i++) {
    await assert.rejects(ai.ask('system', Buffer.from('%PDF-1.4 x'), 'application/pdf', 'plan', { task: 'plan', timeout: 100 }), e => e.status === 502);
  }
  assert.strictEqual(ai.breaker.state, 'closed', 'eight slow file reads: still closed');
  mode = 'ok';
  assert.deepStrictEqual((await text()).reply, { ok: true }, 'a food fill still goes through');
  mode = 'hang';
  for (let i = 0; i < 5; i++) await assert.rejects(text({ timeout: 100 }), e => e.status === 502);
  assert.strictEqual(ai.breaker.state, 'open', 'five text-task timeouts open it');
});

test('checking a key (Keys tab: Test active / next / old) never feeds the breaker, even a revoked one’s 401', async () => {
  mode = '401';
  for (let i = 0; i < 6; i++) assert.strictEqual((await ai.verify('active')).dead, true);
  assert.strictEqual(ai.breaker.state, 'closed');
  mode = 'ok';
});

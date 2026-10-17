'use strict';
/* Phase 2C last leftovers, server side: an AI workout read says which workouts it left out (PR-GY-034); an AI food fill leaves a
   value the AI didn't estimate blank and unflagged (PR-FS-031); a supplement line in an unknown unit keeps its amount as text, and
   nameless lines and lines past 60 are noted (PR-FS-047, PR-FS-056). The job email window is tested in jobsaway.test.js. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const [PORT, AI_PORT] = require('./_ports').freePorts(2);
let next = {};   /* what the fake OpenRouter answers next */
const fakeAi = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: JSON.stringify(next) } }] }));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-fixes2c-last-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'), PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: 'sk-test-key-1234', OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}` };
let srv, ann;

async function signIn(email) {
  let cookie = '', csrf = '';
  const req = async (method, url, body) => {
    const file = Buffer.isBuffer(body);
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': file ? 'application/pdf' : 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body ? (file ? body : JSON.stringify(body)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j };
  };
  await req('GET', '/auth/config');
  assert.strictEqual((await req('POST', '/auth/login', { email, password: 'long-password-1' })).status, 200);
  await req('GET', '/api/me');
  return req;
}

before(async () => {
  await new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r));
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'ann@example.com'],
    { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) { ann = await signIn('ann@example.com'); return; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { srv.kill(); fakeAi.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const PDF = Buffer.from('%PDF-1.4 plan');

test('an AI workout read of 16 workouts takes 14 and says which 2 were left out (PR-GY-034)', async () => {
  next = { workouts: Array.from({ length: 16 }, (_, i) => ({ name: `Day ${i + 1}`, exercises: [{ name: 'Squat', target: '3 × 5' }] })),
    notes: ['Guessed the rest times'] };
  const r = await ann('POST', '/api/gym/ai-import', PDF);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.workouts.length, 14);
  const n = r.body.notes.find(t => /16 workouts/.test(t));
  assert.ok(n && /2 were left out/.test(n) && /Day 15, Day 16/.test(n), JSON.stringify(r.body.notes));
  assert.ok(r.body.notes.includes('Guessed the rest times'));
  /* one with too many exercises, one with none */
  next = { workouts: [{ name: 'Big', exercises: Array.from({ length: 45 }, (_, i) => ({ name: 'Move ' + i })) }, { name: 'Empty', exercises: [] }] };
  const b = await ann('POST', '/api/gym/ai-import', PDF);
  assert.strictEqual(b.body.workouts.length, 1);
  assert.ok(b.body.notes.some(t => /^Big: .*last 5 were left out/.test(t)) && b.body.notes.some(t => /^Empty: no exercises/.test(t)), JSON.stringify(b.body.notes));
});

test('an AI food fill leaves values the AI gave no number for blank and not flagged (PR-FS-031)', async () => {
  const food = { name: 'Odd cheese', unit: 'g', kind: 'ingredient', k: '', p: '', c: '', f: '' };
  next = { k: 350, p: null, c: null, f: null, source: 'Label', confidence: 'low' };
  const r = await ann('POST', '/api/foods/ai-fill', food);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.values, { k: 350 });
  assert.deepStrictEqual(r.body.ai.fields, ['k']);
  assert.deepStrictEqual(r.body.unsure, ['p', 'c', 'f']);
  next = { k: null, p: null, c: null, f: null };
  const n = await ann('POST', '/api/foods/ai-fill', food);
  assert.strictEqual(n.status, 502);
  assert.match(n.body.error, /couldn’t estimate any/);
});

test('a supplement read keeps an unknown unit’s amount as text and notes nameless lines and lines past 60 (PR-FS-047, PR-FS-056)', async () => {
  next = { items: [{ name: 'Zinc', amount: 2, unit: 'tsp', notes: 'With dinner' }, { name: '  ', amount: 1, unit: 'g' },
    ...Array.from({ length: 60 }, (_, i) => ({ name: `Item ${i + 1}`, amount: 1, unit: 'g' }))] };
  const r = await ann('POST', '/api/supps/ai-import', PDF);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const zinc = r.body.items.find(x => x.name === 'Zinc');
  assert.strictEqual(zinc.amount, null);
  assert.strictEqual(zinc.notes, 'Amount: 2 tsp – With dinner');
  assert.ok(r.body.notes.some(t => /^Zinc: “2 tsp” isn’t in a unit the app knows – kept in its notes/.test(t)), JSON.stringify(r.body.notes));
  assert.ok(r.body.notes.includes('1 line with no name was left out.'), JSON.stringify(r.body.notes));
  assert.strictEqual(r.body.items.length, 59);
  assert.ok(r.body.notes.some(t => /^The regime has 62 lines; .*2 were left out: Item 59, Item 60\.$/.test(t)), JSON.stringify(r.body.notes));
});

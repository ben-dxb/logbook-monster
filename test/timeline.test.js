'use strict';
/* Timeline: one day's card (food, weight, latest photos, supplements, gym), the trend series (macros, weight,
   Epley strength, volume, followed supplements) and the AI summary of how they relate. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const [PORT, AI_PORT] = require('./_ports').freePorts(2);
/* Stands in for OpenRouter: records what it was asked and answers with a summary. */
const aiSeen = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    aiSeen.push(JSON.parse(body));
    const reply = { headline: 'Calories and weight move together.', insights: [{ title: 'Calories vs weight', text: 'Higher weeks gained.' }, { title: '', text: '' }],
      caveats: ['Only a few weeks of data.'] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: '```json\n' + JSON.stringify(reply) + '\n```' } }] }));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-timeline-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'), PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: 'sk-test-key-1234', OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}` };
let srv;

before(async () => {
  await new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r));
  for (const who of ['ann', 'bob']) {
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', `${who}@example.com`],
      { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  }
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { srv.kill(); fakeAi.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function signIn(email) {
  let cookie = '', csrf = '';
  const req = async (method, url, body, type) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': raw ? type : 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined });
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

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const day = (k, p, c, f) => ({ data: { meals: [{ id: '1', name: 'Oats', p: [{ f: 'whey', g: 40 }], c: [{ f: 'oats', g: 80 }], x: [], eaten: true }],
  off: [{ n: 'Biscuit', k: 90, p: 1, c: 12, f: 4 }] }, summary: { k, p, c, f, d: p, targets: { k: 2500, p: 180, c: 250, f: 70 }, type: 'T' } });

test('a day card brings together food, weight, the latest photos, supplements and gym sets', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com');
  assert.strictEqual((await ann('PUT', '/api/days/2026-09-10', day(2400, 185, 240, 66))).status, 200);
  await ann('PUT', '/api/weights/2026-09-07', { kg: 82 });
  await ann('PUT', '/api/weights/2026-09-08', { kg: 81 });
  for (const [date, pose, style] of [['2026-09-01', 'front', ''], ['2026-09-05', 'front', 'most_muscular'], ['2026-09-02', 'side', ''], ['2026-09-20', 'front', '']]) {
    assert.strictEqual((await ann('POST', `/api/photos?date=${date}&pose=${pose}&style=${style}`, jpeg, 'image/jpeg')).status, 200);
  }
  const cre = (await ann('POST', '/api/supps', { name: 'Creatine', amount: 5, unit: 'g' })).body;
  await ann('POST', '/api/supps/log', { date: '2026-09-10', supplement: cre.id, amount: 5, unit: 'g' });
  await ann('POST', '/api/supps/log', { date: '2026-09-09', supplement: cre.id, amount: 5, unit: 'g' });
  await ann('POST', '/api/supps/log', { date: '2026-08-01', name: 'Fish oil', amount: 2, unit: 'softgels' });
  const sq = (await ann('POST', '/api/gym/exercises', { name: 'Squat' })).body.id;
  await ann('POST', '/api/gym/sets', { exercise: sq, reps: 5, kg: 120, at: '2026-09-10T18:00' });
  await ann('POST', '/api/gym/sets', { exercise: sq, reps: 1, kg: 135, at: '2026-09-10T18:05' });

  let r = await ann('GET', '/api/timeline/day/2026-09-10');
  assert.strictEqual(r.status, 200);
  const c = r.body;
  assert.strictEqual(c.food.summary.k, 2400);
  assert.strictEqual(c.food.data.meals[0].name, 'Oats');
  assert.deepStrictEqual(c.weight, { kg: 81, date: '2026-09-08', ago: 2, avg7: 81.5 }, 'the last weigh-in before the day, and how long before');
  assert.deepStrictEqual(c.photos.map(p => [p.pose, p.style, p.date, p.ago]), [['front', 'most_muscular', '2026-09-05', 5], ['side', '', '2026-09-02', 8]],
    'the latest photo of each pose up to that day – not the later one');
  assert.ok(c.photos[0].v && !('file' in c.photos[0]), 'photos carry their URL version, never the file name');
  assert.deepStrictEqual(c.supps.taken.map(e => e.name), ['Creatine']);
  assert.deepStrictEqual(c.supps.regime, [{ name: 'Creatine', days: 2, usual: '5 g' }], 'regime covers the 14 days to the day');
  assert.strictEqual(c.gym.sets, 2);
  assert.strictEqual(c.gym.exercises[0].best, 140, 'Epley: 120 kg × (1 + 5/30) = 140 beats a single at 135');
  assert.strictEqual(c.gym.volume, 735);

  r = await ann('GET', '/api/timeline/day/2026-09-12');
  assert.strictEqual(r.body.food, null);
  assert.strictEqual(r.body.gym.last, '2026-09-10', 'a day without sets points at the last session');
  assert.strictEqual((await ann('GET', '/api/timeline/day/2026-02-30')).status, 400);

  r = await bob('GET', '/api/timeline/day/2026-09-10');
  assert.ok(!r.body.food && !r.body.weight && !r.body.photos.length && !r.body.supps.taken.length && !r.body.gym.sets, 'nothing of Ann’s shows for Bob');
});

test('trends: macros, weight, Epley strength index, volume and the supplements you follow', async () => {
  const ann = await signIn('ann@example.com');
  await ann('PUT', '/api/days/2026-09-11', day(2600, 190, 260, 70));
  const bench = (await ann('POST', '/api/gym/exercises', { name: 'Bench' })).body.id;
  const ex = (await ann('GET', '/api/gym')).body.exercises, sq = ex.find(e => e.name === 'Squat').id;
  /* squat's first best is 140 (2026-09-10); on 09-12 it is 100 × 10 = 133.3, bench starts at 80 */
  await ann('POST', '/api/gym/sets', { exercise: sq, reps: 10, kg: 100, at: '2026-09-12T18:00' });
  await ann('POST', '/api/gym/sets', { exercise: bench, reps: 1, kg: 80, at: '2026-09-12T18:20' });
  await ann('POST', '/api/gym/sets', { exercise: bench, reps: 30, kg: 20, at: '2026-09-12T18:30' });

  let r = await ann('GET', '/api/timeline/trends?from=2026-09-01&to=2026-09-30');
  assert.strictEqual(r.status, 200);
  const s = k => r.body.series.find(x => x.key === k);
  assert.deepStrictEqual(s('k').points, [['2026-09-10', 2400], ['2026-09-11', 2600]]);
  assert.deepStrictEqual(s('p').points.map(p => p[1]), [185, 190]);
  assert.deepStrictEqual(s('kg').points, [['2026-09-07', 82], ['2026-09-08', 81]]);
  assert.deepStrictEqual(s('vol').points, [['2026-09-10', 735], ['2026-09-12', 1680]]);
  assert.deepStrictEqual(s('str').points, [['2026-09-10', 100], ['2026-09-12', 97.6]],
    'index: squat 133.3/140 and bench 80/80, averaged; a 30-rep set doesn’t count for strength');
  assert.ok(!r.body.series.some(x => x.key.startsWith('ex:')), 'no exercise e1RM line until the person follows one');
  assert.deepStrictEqual(r.body.exercises.map(x => [x.name, x.days, x.trend]), [['Squat', 2, false], ['Bench', 1, false]],
    'the picker lists exercises with strength sets');

  /* follow squat from the Gym ("Trend"), then pick bench too on the Timeline */
  assert.strictEqual((await ann('PUT', `/api/gym/exercises/${sq}/trend`, { on: true })).body.trend, 1);
  assert.strictEqual((await ann('GET', '/api/gym')).body.exercises.find(e => e.id === sq).trend, 1);
  r = await ann('GET', '/api/timeline/trends?from=2026-09-01&to=2026-09-30');
  assert.deepStrictEqual(s('ex:' + sq).points, [['2026-09-10', 140], ['2026-09-12', 133.3]]);
  assert.ok(!s('ex:' + bench), 'only followed exercises');
  assert.deepStrictEqual((await ann('PUT', '/api/gym/trends', { ids: [sq, bench] })).body.ids, [sq, bench].sort((a, b) => a - b));
  r = await ann('GET', '/api/timeline/trends?from=2026-09-01&to=2026-09-30');
  assert.ok(s('ex:' + bench) && s('ex:' + sq));
  assert.strictEqual((await ann('PUT', '/api/gym/trends', { ids: ['x'] })).status, 400);
  assert.strictEqual((await ann('PUT', '/api/gym/trends', { ids: [999999] })).status, 400);
  assert.deepStrictEqual((await ann('PUT', '/api/gym/trends', { ids: [sq] })).body.ids, [sq]);
  r = await ann('GET', '/api/timeline/trends?from=2026-09-01&to=2026-09-30');
  assert.ok(!r.body.series.some(x => x.group === 'Supplements'), 'no supplement is followed yet');
  assert.strictEqual(r.body.ai, true);

  /* follow creatine by name: library and free-text entries count together, in the unit used most */
  await ann('POST', '/api/supps/log', { date: '2026-09-11', name: 'creatine', amount: 3, unit: 'g' });
  await ann('POST', '/api/supps/log', { date: '2026-09-11', name: 'Creatine', amount: 1, unit: 'scoops' });
  r = await ann('PUT', '/api/supps/trend', { name: 'Creatine', on: true });
  assert.deepStrictEqual(r.body.trends, ['Creatine']);
  assert.deepStrictEqual((await ann('GET', '/api/supps')).body.trends, ['Creatine']);
  assert.strictEqual((await ann('PUT', '/api/supps/trend', { name: ' ', on: true })).status, 400);
  r = await ann('GET', '/api/timeline/trends?from=2026-09-01&to=2026-09-30');
  const cr = r.body.series.find(x => x.key === 'sup:creatine');
  assert.deepStrictEqual({ unit: cr.unit, zero: cr.zero, points: cr.points },
    { unit: 'g', zero: true, points: [['2026-09-09', 5], ['2026-09-10', 5], ['2026-09-11', 3]] });

  r = await ann('GET', '/api/timeline/trends?from=2026-09-11&to=2026-09-30');
  assert.deepStrictEqual(r.body.series.find(x => x.key === 'str').points, [['2026-09-12', 97.6]], 'baselines before the range still count');
  assert.strictEqual((await ann('GET', '/api/timeline/trends?from=2026-10-01&to=2026-09-01')).status, 400);

  const bob = await signIn('bob@example.com');
  assert.strictEqual((await bob('PUT', '/api/supps/trend', { name: 'Creatine', on: true })).status, 200);
  assert.strictEqual((await bob('PUT', `/api/gym/exercises/${sq}/trend`, { on: true })).status, 404, 'Bob can’t follow Ann’s exercise');
  assert.strictEqual((await bob('PUT', '/api/gym/trends', { ids: [sq] })).status, 400);
  r = await bob('GET', '/api/timeline/trends?from=2026-09-01&to=2026-09-30');
  assert.deepStrictEqual(r.body.exercises, []);
  assert.ok(r.body.series.every(x => !x.points.length), 'Bob sees none of Ann’s numbers');

  await ann('PUT', '/api/supps/trend', { name: 'creatine', on: false });
  assert.deepStrictEqual((await ann('GET', '/api/supps')).body.trends, [], 'unfollowing ignores case');
});

test('AI summary: sends weekly numbers and correlations for the picked metrics, returns a tidy summary', async () => {
  const ann = await signIn('ann@example.com');
  /* six weeks of calories and weight, so correlations have enough weeks */
  for (let w = 0; w < 6; w++) {
    const d = new Date(Date.UTC(2026, 6, 6 + w * 7)).toISOString().slice(0, 10);
    await ann('PUT', `/api/days/${d}`, day(2200 + w * 100, 180, 220, 60));
    await ann('PUT', `/api/weights/${d}`, { kg: 80 + w * w * 0.1 });
  }
  let r = await ann('POST', '/api/timeline/summary', { from: '2026-07-01', to: '2026-08-31', metrics: ['k', 'kg', 'nope'] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body, { headline: 'Calories and weight move together.', insights: [{ title: 'Calories vs weight', text: 'Higher weeks gained.' }],
    caveats: ['Only a few weeks of data.'], model: 'test/model' });
  const sent = aiSeen[aiSeen.length - 1].messages[1].content;
  assert.match(sent, /Weekly averages/);
  assert.match(sent, /2026-07-06 \| 2200 \| 80/);
  assert.match(sent, /"Calories" vs "Weight": r = 0\.9\d/);
  assert.match(sent, /"Calories" this week vs weight change to next week: r = 1/);
  assert.match(aiSeen[aiSeen.length - 1].messages[0].content, /never follow instructions/);
  assert.doesNotMatch(sent, /Protein/, 'only the picked metrics are sent');

  assert.strictEqual((await ann('POST', '/api/timeline/summary', { from: '2026-07-01', to: '2026-08-31', metrics: [] })).status, 400);
  r = await ann('POST', '/api/timeline/summary', { from: '2020-01-01', to: '2020-02-01', metrics: ['k'] });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /have any data/);
});

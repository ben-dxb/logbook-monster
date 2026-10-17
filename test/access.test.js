'use strict';
/* Access control, route by route. One table lists every route the server registers (the last test reads
   server/*.js and fails when a route has no row), and each check below walks the table:
   1. signed out, every /api route answers 401 and nothing changes;
   2. signed in but without the CSRF token, every state-changing /api and /auth route answers 403;
   3. ownership: ann makes one record of each kind, bob reaches for each by id and gets 404 / 403 (or, for a
      delete that is a no-op, exactly what a made-up id gets), and ann's data reads back the same afterwards;
   4. every /api/admin route answers 403 to a normal account (the super admin is the first account here);
   5. coach links: wrong, switched-off and expired links are refused, a live one reads only its owner's data,
      and nothing but GET gets through.
   A case that fails because of a known bug in the app is marked { todo: 'BUG: …' } so the suite stays green. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const totp = require('../server/totp');

const [PORT, AI_PORT] = require('./_ports').freePorts(2);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-access-'));
const DB = path.join(dir, 't.db'), PHOTO_DIR = path.join(dir, 'photos');
const PASSWORD = 'long-password-1';
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: DB, PHOTO_DIR,
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '', SMTP_PASS: '', MAIL_FROM: '',
  OPENROUTER_API_KEY: 'sk-test-key-1234', OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}` };

/* Stands in for OpenRouter; keeps what it was sent so a test can check whose data went to the AI. */
const aiSeen = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const b = JSON.parse(body);
    aiSeen.push(body);
    const system = String(b.messages[0].content), user = b.messages[1].content;
    let reply;
    if (/tag gym exercises/.test(system)) {
      reply = { exercises: String(user).split('\n').map(l => ({ id: +l.split(':')[0], parts: ['chest'] })) };
    } else if (/supplement regime/.test(system)) {
      reply = { items: [{ name: 'annmark regime creatine', amount: 5, unit: 'g', notes: '' }], notes: [] };
    } else if (/sort fitness progress photos/.test(system)) {
      reply = { pose: 'back', style: '' };
    } else reply = { headline: 'Steady week', insights: ['ok'], caveats: [] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }] }));
  });
});

let srv;
before(async () => {
  await new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r));
  /* adm first: with ADMIN_EMAILS empty the first account is the super admin */
  for (const who of ['adm', 'ann', 'bob', 'cat', 'dee']) {
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', `${who}@example.com`],
      { cwd: root, env: { ...env, NEW_PASSWORD: PASSWORD }, stdio: 'ignore' });
  }
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!(await fetch(BASE + '/healthz').catch(() => null))) throw new Error('server did not start');
  await seed();
});
after(() => { if (srv) srv.kill(); fakeAi.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/* ---------- HTTP helpers ---------- */
/* body: a plain object (sent as JSON) or { raw: Buffer, type } */
async function call(method, url, { cookie, csrf, body } = {}) {
  const raw = body && Buffer.isBuffer(body.raw);
  const headers = { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) };
  if (body) headers['content-type'] = raw ? body.type : 'application/json';
  const r = await fetch(url.startsWith('http') ? url : BASE + url, { method, redirect: 'manual', headers,
    body: body ? (raw ? body.raw : JSON.stringify(body)) : undefined });
  const type = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  if (/json/.test(type)) { try { json = JSON.parse(buf.toString('utf8')); } catch {} }
  return { status: r.status, body: json, text: buf.toString('latin1'), bytes: buf, headers: r.headers };
}
/* A signed-in browser: keeps its cookie and CSRF token. c(method, url, body, { csrf: false }) leaves the token out. */
async function signIn(email, password = PASSWORD) {
  let cookie = '', csrf = '';
  const c = async (method, url, body, o = {}) => {
    const r = await call(method, url, { cookie, csrf: o.csrf === false ? '' : csrf, body });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    if (r.body && r.body.csrf) csrf = r.body.csrf;
    return r;
  };
  await c('GET', '/auth/config');
  const r = await c('POST', '/auth/login', { email, password });
  assert.strictEqual(r.status, 200, `sign in ${email}`);
  await c('GET', '/api/me');
  c.cookie = () => cookie;
  return c;
}

/* Every row of the database except sessions (and the sign-in time) and the security log (which records reads like an export
   or a coach link's use), plus the photo files: "nothing changed" means this is the same. */
function snapshot(onlyUser) {
  const db = new DatabaseSync(DB, { readOnly: true });
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    if (name === 'sessions' || name === 'audit') continue;
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all().map(c => c.name);
    let rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    if (onlyUser != null) {
      if (cols.includes('user_id')) rows = rows.filter(r => r.user_id === onlyUser);
      else if (name === 'users') rows = rows.filter(r => r.id === onlyUser);
      else continue;
    }
    out[name] = rows.map(r => { const { last_login_at, used_at, ...rest } = r; return rest; });
  }
  db.close();
  out.files = fs.readdirSync(PHOTO_DIR).sort();
  return JSON.stringify(out, (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v));
}
const userId = email => { const db = new DatabaseSync(DB, { readOnly: true }); const id = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id; db.close(); return id; };

/* ---------- test data ---------- */
const jpeg = tag => ({ raw: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('access-jpeg-' + tag + '-'.repeat(40)), Buffer.from([0xff, 0xd9])]), type: 'image/jpeg' });
const pdf = { raw: Buffer.from('%PDF-1.4 access test'), type: 'application/pdf' };
const DATE = '2026-09-10', FROM = '2026-01-05';
const OATS = { n: 'annmark oats', k: 380, p: 13, c: 60, f: 7, d: 0, step: 5, group: 'c' };
const plan = (name, from, oats = OATS) => ({ foods: { oats }, templates: [{ id: 'R', name: 'Rest' }],
  plan: { R: [{ id: '1', name, p: [], c: [{ f: 'oats', g: 100 }], x: [] }] }, ...(from ? { from } : {}) });
const day = (tname, k) => ({ data: { meals: [{ id: '1', name: tname + ' meal', p: [], c: [], x: [] }], off: [] },
  summary: { k, p: 180, c: 250, f: 70, d: 180, targets: { k: 2500, p: 180, c: 250, f: 70 }, type: 'R', tname } });
const inDays = n => new Date(Date.now() + n * 86400000).toISOString();

/* ann's records (ids), bob's, and signed-in clients */
const c = { date: DATE, from: FROM };
let adm, ann, bob, A_ID, B_ID, aiMark = 0;

async function seed() {
  adm = await signIn('adm@example.com'); ann = await signIn('ann@example.com'); bob = await signIn('bob@example.com');
  A_ID = userId('ann@example.com'); B_ID = userId('bob@example.com');
  /* dee has the second sign-in step on */
  const dee = await signIn('dee@example.com');
  const key = (await dee('POST', '/api/totp/setup', {})).body.secret;
  assert.strictEqual((await dee('POST', '/api/totp/enable', { code: totp.totp(totp.fromBase32(key)) })).status, 200);
  const ok = async (p, what) => { const r = await p; assert.ok(r.status === 200 || r.status === 202, `${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  await ok(ann('PUT', '/api/settings', { snackOv: { annmark: { k: 1 } } }), 'settings');
  await ok(ann('PUT', '/api/my/defaults', plan('annmark bowl')), 'plan');
  await ok(ann('PUT', '/api/my/defaults', plan('annmark later bowl', FROM)), 'dated plan');
  await ok(ann('PUT', `/api/days/${DATE}`, day('annmark day', 2417)), 'day');
  await ok(ann('PUT', `/api/weights/${DATE}`, { kg: 81.37 }), 'weight');
  await ok(ann('PUT', '/api/checklist', { items: [{ id: 'annmark', label: 'annmark item', show: 'all', auto: '' }] }), 'checklist');
  await ok(ann('PUT', `/api/checklist/days/${DATE}`, { item: 'annmark', done: true }), 'tick');
  c.ex1 = (await ok(ann('POST', '/api/gym/exercises', { name: 'annmark squat', notes: 'annmark' }), 'exercise')).id;
  c.ex2 = (await ok(ann('POST', '/api/gym/exercises', { name: 'annmark row' }), 'exercise 2')).id;
  await ok(ann('PUT', `/api/gym/exercises/${c.ex1}/trend`, { on: true }), 'trend');
  c.w1 = (await ok(ann('POST', '/api/gym/workouts', { name: 'annmark legs', items: [{ e: c.ex1 }] }), 'workout')).id;
  c.w2 = (await ok(ann('POST', '/api/gym/workouts', { name: 'annmark back', items: [{ e: c.ex2 }] }), 'workout 2')).id;
  c.set = (await ok(ann('POST', '/api/gym/sets', { exercise: c.ex1, reps: 5, kg: 100, note: 'annmark', at: `${DATE}T08:00` }), 'set')).id;
  const food = { unit: 'g', k: 100, p: 10, c: 5, f: 2 };
  c.foodPriv = (await ok(ann('POST', '/api/foods', { ...food, name: 'annmark private food' }), 'food')).id;
  c.foodPub = (await ok(ann('POST', '/api/foods', { ...food, name: 'annmark shared food', public: true }), 'shared food')).id;
  c.suppPriv = (await ok(ann('POST', '/api/supps', { name: 'annmark private supp', amount: 5, unit: 'g' }), 'supp')).id;
  c.suppPub = (await ok(ann('POST', '/api/supps', { name: 'annmark shared supp', amount: 1, unit: 'g', public: true }), 'shared supp')).id;
  await ok(ann('PUT', '/api/supps/trend', { name: 'annmark private supp', on: true }), 'supp trend');
  c.log = (await ok(ann('POST', '/api/supps/log', { date: DATE, supplement: c.suppPriv, amount: 5, unit: 'g', note: 'annmark' }), 'supp log')).id;
  /* two front photos on one day: the later one is the one the Timeline shows, so p1 is never on it */
  c.p1 = (await ok(ann('POST', `/api/photos?date=${DATE}&pose=front&note=annmark%20p1`, jpeg('p1')), 'photo 1')).id;
  c.p2 = (await ok(ann('POST', `/api/photos?date=${DATE}&pose=front&note=annmark%20p2`, jpeg('p2')), 'photo 2')).id;
  for (const [id, n] of [[c.p1, 'p1'], [c.p2, 'p2']]) await ok(ann('PUT', `/api/photos/${id}`, { date: DATE, pose: 'front', note: 'annmark ' + n }), 'photo note');
  await ok(ann('PUT', `/api/photos/${c.p2}/thumb`, jpeg('p2thumb')), 'thumb');
  c.share = (await ok(ann('POST', '/api/shares', { label: 'annmark link', expires: inDays(30) }), 'share')).id;
  /* an AI job, through the supplement regime reader and the fake AI */
  c.job = (await ok(ann('POST', '/api/supps/ai-import?bg=1', pdf), 'job')).job.id;
  for (let i = 0; i < 100; i++) {
    if ((await ann('GET', '/api/jobs/' + c.job)).body.status !== 'running') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.strictEqual((await ann('GET', '/api/jobs/' + c.job)).body.status, 'done');

  /* bob's own data, which must never show through ann's coach link */
  /* (on other days than ann's, so bob's own probes below don't touch them) */
  await ok(bob('PUT', '/api/days/2026-09-11', day('bobmark day', 3111)), 'bob day');
  await ok(bob('PUT', '/api/weights/2026-09-11', { kg: 99.9 }), 'bob weight');
  c.bobPhoto = (await ok(bob('POST', '/api/photos?date=2026-09-12&pose=front&note=bobmark', jpeg('bob')), 'bob photo')).id;
  await ok(bob('PUT', `/api/photos/${c.bobPhoto}`, { date: '2026-09-12', pose: 'front', note: 'bobmark' }), 'bob photo note');
}

/* ---------- the route table ----------
   key: 'METHOD /path' exactly as registered. u: a URL to call (default: the path with :date, :from, :token filled in).
   body: what to send on a write (realistic, so a missing check would really change something).
   scope: 'public' (no sign-in by design), 'page', 'auth' (/auth), 'api', 'admin', 'coach'.
   own (api rows): bob's probes against ann's records, or why the route has no record of anyone else's to reach. */
const SELF = 'only ever reads or writes the caller’s own data (no id of anyone else’s in the request)';
const NOOP = 'noop';   /* a delete of someone else's id: must answer exactly what a made-up id gets, and change nothing */
const ROUTES = [
  /* pages and public endpoints (server/index.js) */
  { key: 'GET /healthz', scope: 'public' },
  { key: 'GET /login', scope: 'public' },
  { key: 'GET /invite', scope: 'public' },
  { key: 'GET /coach/:token', scope: 'public' },
  { key: 'GET /', scope: 'page' },
  { key: 'GET /index.html', scope: 'page' },
  /* server/auth.js */
  { key: 'GET /auth/config', scope: 'public' },
  { key: 'GET /auth/google', scope: 'public' },
  { key: 'GET /auth/google/callback', scope: 'public' },
  { key: 'POST /auth/login', scope: 'auth', body: () => ({ email: 'ann@example.com', password: PASSWORD }) },
  { key: 'POST /auth/register', scope: 'auth', body: () => ({ email: 'new@example.com', password: PASSWORD }) },
  { key: 'POST /auth/invite/check', scope: 'auth', body: () => ({ token: 'x'.repeat(43) }) },
  { key: 'POST /auth/invite/accept', scope: 'auth', body: () => ({ token: 'x'.repeat(43), password: PASSWORD }) },
  { key: 'POST /auth/logout', scope: 'auth' },
  { key: 'POST /auth/password', scope: 'auth', body: () => ({ current: PASSWORD, next: 'another-password-2' }) },
  { key: 'POST /auth/second', scope: 'auth', body: () => ({ code: '123456' }) },
  /* server/api.js */
  { key: 'GET /api/me', own: [{ check: r => assert.strictEqual(r.body.email, 'bob@example.com') }] },
  { key: 'GET /api/defaults', own: [{ check: noAnn }] },
  { key: 'PUT /api/my/defaults', body: () => plan('hijack'), own: [{ body: () => plan('bob bowl', null, { ...OATS, n: 'bob oats' }) }] },
  { key: 'DELETE /api/my/defaults', own: SELF },
  { key: 'DELETE /api/my/defaults/:from', own: [{ expect: [404] }] },
  { key: 'GET /api/admin/ai', scope: 'admin' },
  { key: 'PUT /api/admin/ai', scope: 'admin', body: () => ({ key: 'sk-hijack-key-0000', model: 'x/y' }) },
  { key: 'POST /api/my/ai-import', body: () => pdf, own: 'reads the file in the request; a background job belongs to the caller (jobs rows check those)' },
  { key: 'GET /api/admin/users', scope: 'admin' },
  { key: 'POST /api/admin/users', scope: 'admin', body: () => ({ email: 'invited@example.com' }) },
  { key: 'POST /api/admin/users/:id/invite', scope: 'admin', u: () => `/api/admin/users/${A_ID}/invite` },
  { key: 'DELETE /api/admin/users/:id', scope: 'admin', u: () => `/api/admin/users/${A_ID}` },
  { key: 'GET /api/admin/log', scope: 'admin' },
  { key: 'GET /api/my/log', own: [{ check: r => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const annRows = new Set(db.prepare('SELECT id FROM audit WHERE user_id = ?').all(A_ID).map(x => x.id));
    db.close();
    assert.ok(annRows.size > 0 && r.body.rows.length > 0);
    assert.ok(r.body.rows.every(x => !annRows.has(x.id)), 'none of ann’s security log');
  } }] },
  { key: 'GET /api/admin/options', scope: 'admin' },
  { key: 'PUT /api/admin/options', scope: 'admin', body: () => ({ planFiles: false }) },
  { key: 'GET /api/admin/email', scope: 'admin' },
  { key: 'PUT /api/admin/email', scope: 'admin', body: () => ({ host: 'smtp.example.com', user: 'x', pass: 'y', from: 'x@example.com' }) },
  { key: 'POST /api/admin/email/test', scope: 'admin', body: () => ({ to: 'x@example.com' }) },
  { key: 'GET /api/settings', own: [{ check: noAnn }] },
  { key: 'PUT /api/settings', body: () => ({ snackOv: { hijack: { k: 1 } } }), own: [{ body: () => ({ snackOv: { bob: { k: 1 } } }) }] },
  { key: 'GET /api/days', own: [{ check: noAnn }] },
  { key: 'GET /api/days/:date', own: [{ expect: [404] }] },
  { key: 'PUT /api/days/:date', body: () => day('hijack', 1), own: [{ body: () => day('bob day', 1999) }] },
  { key: 'DELETE /api/days/:date', own: [{ u: () => `/api/days/${FROM}` }] },
  { key: 'GET /api/weights', own: [{ check: r => { noAnn(r); assert.ok(!r.text.includes('81.37')); } }] },
  { key: 'PUT /api/weights/:date', body: () => ({ kg: 55 }), own: [{ body: () => ({ kg: 70 }) }] },
  { key: 'DELETE /api/weights/:date', own: [{}] },
  { key: 'POST /api/recheck', body: () => ({ password: PASSWORD }), own: SELF },
  /* server/twostep.js */
  { key: 'GET /api/totp', own: [{ check: r => assert.deepStrictEqual(r.body, { on: false, recoveryLeft: 0, readable: true }) }] },
  { key: 'POST /api/totp/setup', own: SELF },
  { key: 'POST /api/totp/enable', body: () => ({ code: '123456' }), own: SELF },
  { key: 'POST /api/totp/disable', body: () => ({ password: PASSWORD }), own: SELF },
  { key: 'GET /api/export', own: [{ check: r => { noAnn(r); assert.ok(!r.text.includes('81.37')); } }] },
  /* server/gym.js */
  { key: 'GET /api/gym', own: [{ check: noAnn }] },
  { key: 'POST /api/gym/exercises', body: () => ({ name: 'hijack' }), own: [{ body: () => ({ name: 'annmark squat', notes: 'bob' }) }] },
  { key: 'POST /api/gym/exercises/ai-parts', body: () => ({ ids: [c.ex1, c.ex2] }), own: [{ expect: [400, 404] }] },
  { key: 'PUT /api/gym/exercises/:id', u: () => `/api/gym/exercises/${c.ex1}`, body: () => ({ name: 'hijack', parts: ['calves'] }), own: [{ expect: [404, 403] }] },
  { key: 'PUT /api/gym/exercises/:id/trend', u: () => `/api/gym/exercises/${c.ex1}/trend`, body: () => ({ on: false }), own: [{ expect: [404, 403] }] },
  { key: 'PUT /api/gym/trends', body: () => ({ ids: [] }), own: [{ body: () => ({ ids: [c.ex1, c.ex2] }), expect: [400, 404, 403] }] },
  { key: 'DELETE /api/gym/exercises/:id', u: () => `/api/gym/exercises/${c.ex1}`, own: NOOP },
  { key: 'POST /api/gym/workouts', body: () => ({ name: 'hijack', items: [] }), own: [{ body: () => ({ name: 'bob', items: [{ e: c.ex1 }] }), expect: [400, 404] }] },
  { key: 'PUT /api/gym/workouts/:id', u: () => `/api/gym/workouts/${c.w1}`, body: () => ({ name: 'hijack', items: [] }), own: [{ expect: [404, 403] }] },
  { key: 'DELETE /api/gym/workouts/:id', u: () => `/api/gym/workouts/${c.w1}`, own: NOOP },
  { key: 'PUT /api/gym/order', body: () => ({ ids: [c.w2, c.w1] }), made: () => ({ ids: [999998, 999999] }), own: NOOP },
  { key: 'GET /api/gym/sets', u: () => `/api/gym/sets?exercise=${c.ex1}`, own: [{ check: r => assert.deepStrictEqual(r.body, []) },
    { u: () => `/api/gym/sets?date=${DATE}`, check: r => assert.deepStrictEqual(r.body, []) }] },
  { key: 'GET /api/gym/sets/:id', u: () => `/api/gym/sets/${c.set}`, own: [{ expect: [404] }] },
  { key: 'POST /api/gym/sets', body: () => ({ exercise: c.ex1, reps: 1, kg: 1, at: `${DATE}T09:00` }), own: [{ expect: [400, 404] }] },
  { key: 'PUT /api/gym/sets/:id', u: () => `/api/gym/sets/${c.set}`, body: () => ({ exercise: c.ex1, reps: 99, kg: 1, at: `${DATE}T09:00` }), own: [{ expect: [404, 403] }] },
  { key: 'DELETE /api/gym/sets/:id', u: () => `/api/gym/sets/${c.set}`, own: NOOP },
  { key: 'GET /api/gym/sessions', own: [{ check: r => assert.deepStrictEqual(r.body, []) }] },
  { key: 'POST /api/gym/ai-import', body: () => pdf, own: 'reads the file in the request; a background job belongs to the caller' },
  { key: 'POST /api/gym/import', body: () => ({ workouts: [{ name: 'hijack', exercises: ['hijack'] }] }),
    own: [{ body: () => ({ workouts: [{ name: 'bob import', exercises: ['annmark squat'] }] }) }] },
  { key: 'POST /api/gym/import-sets', body: () => ({ sets: [{ name: 'hijack', reps: 1, kg: 1, at: `${DATE}T10:00` }] }),
    own: [{ body: () => ({ sets: [{ name: 'annmark squat', reps: 1, kg: 1, at: `${DATE}T10:00` }] }) }] },
  /* server/foods.js */
  { key: 'GET /api/foods', own: [{ check: r => {
    const names = r.body.foods.map(f => f.name);
    assert.ok(names.includes('annmark shared food'), 'a shared food is listed');
    assert.ok(!names.includes('annmark private food'), 'a private food is not');
  } }] },
  { key: 'POST /api/foods/ai-fill', body: () => ({ name: 'x', unit: 'g', k: 100 }), own: 'estimates the values sent; stores nothing' },
  { key: 'POST /api/foods', body: () => ({ name: 'hijack', unit: 'g', k: 1 }), own: SELF },
  { key: 'PUT /api/foods/:id', u: () => `/api/foods/${c.foodPriv}`, body: () => ({ name: 'hijack', unit: 'g', k: 1 }),
    own: [{ expect: [404] }, { u: () => `/api/foods/${c.foodPub}`, expect: [403] }] },
  { key: 'DELETE /api/foods/:id', u: () => `/api/foods/${c.foodPriv}`, own: [{ expect: [404] }, { u: () => `/api/foods/${c.foodPub}`, expect: [403] }] },
  /* server/supps.js */
  { key: 'GET /api/supps', own: [{ check: r => {
    const names = r.body.supplements.map(s => s.name);
    assert.ok(names.includes('annmark shared supp'), 'a shared supplement is listed');
    assert.ok(!names.includes('annmark private supp'), 'a private one is not');
    assert.ok(!JSON.stringify(r.body.trends).includes('annmark'), 'nor ann’s trends');
  } }] },
  { key: 'POST /api/supps/ai-import', body: () => pdf, own: 'reads the file in the request; a background job belongs to the caller' },
  { key: 'POST /api/supps/import', body: () => ({ items: [{ name: 'hijack', amount: 1, unit: 'g' }] }),
    own: [{ body: () => ({ items: [{ name: 'annmark private supp', amount: 9, unit: 'mg' }] }) }] },
  { key: 'PUT /api/supps/trend', body: () => ({ name: 'annmark private supp', on: false }), own: [{}] },
  { key: 'POST /api/supps', body: () => ({ name: 'hijack', amount: 1, unit: 'g' }), own: SELF },
  { key: 'GET /api/supps/log', own: [{ check: noAnn }, { u: () => `/api/supps/log?date=${DATE}`, check: noAnn }] },
  { key: 'POST /api/supps/log', body: () => ({ date: DATE, supplement: c.suppPriv, amount: 1, unit: 'g' }),
    own: [{ expect: [404] }, { body: () => ({ date: DATE, supplement: c.suppPub, amount: 1, unit: 'g' }), expect: [200] }] },
  { key: 'PUT /api/supps/log/:id', u: () => `/api/supps/log/${c.log}`, body: () => ({ date: DATE, name: 'hijack', amount: 1, unit: 'g' }), own: [{ expect: [404] }] },
  { key: 'DELETE /api/supps/log/:id', u: () => `/api/supps/log/${c.log}`, own: NOOP },
  { key: 'PUT /api/supps/:id', u: () => `/api/supps/${c.suppPriv}`, body: () => ({ name: 'hijack', amount: 1, unit: 'g' }),
    own: [{ expect: [404] }, { u: () => `/api/supps/${c.suppPub}`, expect: [403] }] },
  { key: 'DELETE /api/supps/:id', u: () => `/api/supps/${c.suppPriv}`, own: [{ expect: [404] }, { u: () => `/api/supps/${c.suppPub}`, expect: [403] }] },
  /* server/checklist.js */
  { key: 'GET /api/checklist', own: [{ check: noAnn }] },
  { key: 'PUT /api/checklist', body: () => ({ items: [{ id: 'hijack', label: 'hijack' }] }), own: SELF },
  { key: 'DELETE /api/checklist', own: SELF },
  { key: 'GET /api/checklist/days', u: () => `/api/checklist/days?from=2026-09-01&to=2026-09-30`, own: [{ check: r => assert.deepStrictEqual(r.body.days, {}) }] },
  { key: 'PUT /api/checklist/days/:date', body: () => ({ item: 'annmark', done: false }),
    own: [{ expect: [200, 400] }, { body: () => ({ item: 'annmark', done: true }), expect: [400] }] },
  /* server/photos.js */
  { key: 'GET /api/photos', own: [{ check: r => { noAnn(r); assert.deepStrictEqual(r.body.photos.map(p => p.id), [c.bobPhoto]); } },
    /* the Dashboard's ask: the newest of each pose, and the count – of the caller's own only */
    { u: () => '/api/photos?latest=1&to=2100-01-01', check: r => { noAnn(r); assert.deepStrictEqual([r.body.photos.map(p => p.id), r.body.count], [[c.bobPhoto], 1]); } }] },
  { key: 'POST /api/photos', u: () => `/api/photos?date=${DATE}&pose=back`, body: () => jpeg('hijack'), own: SELF },
  { key: 'PUT /api/photos/:id/thumb', u: () => `/api/photos/${c.p2}/thumb`, body: () => jpeg('hijackthumb'), own: [{ expect: [404] }] },
  { key: 'PUT /api/photos/:id', u: () => `/api/photos/${c.p1}`, body: () => ({ date: DATE, pose: 'back', note: 'hijack' }), own: [{ expect: [404] }] },
  { key: 'DELETE /api/photos', u: () => '/api/photos?from=2000-01-01&to=2100-01-01',
    own: [{ u: () => `/api/photos?from=2000-01-01&to=${DATE}`, check: r => assert.strictEqual(r.body.deleted, 0) }] },
  { key: 'DELETE /api/photos/:id', u: () => `/api/photos/${c.p1}`, own: NOOP },
  { key: 'POST /api/photos/:id/ai-pose', u: () => `/api/photos/${c.p1}/ai-pose`, body: () => ({ save: true }), own: [{ expect: [404] }] },
  { key: 'GET /api/photos/:id/file', u: () => `/api/photos/${c.p1}/file`, own: [{ expect: [404] }] },
  { key: 'GET /api/photos/:id/thumb', u: () => `/api/photos/${c.p2}/thumb`, own: [{ expect: [404] }] },
  /* server/timeline.js */
  /* (bob has by now made his own exercise and supplement log entry under ann's names, so these look for ann's own values) */
  { key: 'GET /api/timeline/day/:date', own: [{ check: r => {
    for (const s of ['annmark day', '81.37', '"annmark"', 'annmark p']) assert.ok(!r.text.includes(s), s);
    assert.deepStrictEqual(r.body.photos, []);
  } }] },
  { key: 'GET /api/timeline/trends', u: () => '/api/timeline/trends?from=2026-09-01&to=2026-09-30',
    own: [{ check: r => { for (const s of ['annmark day', '81.37', '2417']) assert.ok(!r.text.includes(s), s); } }] },
  { key: 'POST /api/timeline/summary', body: () => ({ from: '2026-09-01', to: '2026-09-30', metrics: ['k', 'kg'] }),
    own: [{ check: () => {
      const sent = aiSeen.slice(aiMark).join('\n');
      assert.ok(sent, 'the AI was asked');
      for (const s of ['annmark day', '81.37', '2417']) assert.ok(!sent.includes(s), 'only bob’s numbers go to the AI: ' + s);
    } }] },
  /* server/shares.js – the account's own links */
  { key: 'GET /api/shares', own: [{ check: r => assert.deepStrictEqual(r.body.shares, []) }] },
  { key: 'POST /api/shares', body: () => ({ label: 'hijack', expires: inDays(3) }), own: SELF },
  { key: 'DELETE /api/shares/:id', u: () => `/api/shares/${c.share}`, own: NOOP },
  /* server/jobs.js */
  { key: 'GET /api/jobs', own: [{ check: r => assert.deepStrictEqual(r.body.jobs, []) }] },
  { key: 'GET /api/jobs/:id', u: () => `/api/jobs/${c.job}`, own: [{ expect: [404] }] },
  { key: 'POST /api/jobs/:id/seen', u: () => `/api/jobs/${c.job}/seen`, own: [{ expect: [404] }] },
  { key: 'POST /api/jobs/away', own: SELF },
  /* server/shares.js – the coach's side, and the timeline and photo routers mounted under it */
  { key: 'GET /coach/:token/api/info', scope: 'coach', check: r => assert.strictEqual(r.body.name, 'ann') },
  { key: 'GET /coach/:token/api/defaults', scope: 'coach', check: r => assert.strictEqual(r.body.mine.plan.R[0].name, 'annmark later bowl') },
  { key: 'GET /coach/:token/api/days', scope: 'coach', check: r => assert.deepStrictEqual(r.body.map(d => d.tname), ['annmark day']) },
  { key: 'GET /coach/:token/api/weights', scope: 'coach', check: r => assert.deepStrictEqual(r.body, [{ date: DATE, kg: 81.37 }]) },
  { key: 'GET /coach/:token/api/timeline/day/:date', scope: 'coach', check: r => {
    assert.strictEqual(r.body.food.summary.tname, 'annmark day');
    assert.deepStrictEqual(r.body.photos.map(p => p.id), [c.p2]);
    assert.ok(!r.text.includes('annmark p2'), 'no photo notes through a coach link');
  } },
  { key: 'GET /coach/:token/api/timeline/trends', scope: 'coach', u: () => `/coach/${c.token}/api/timeline/trends?from=2026-09-01&to=2026-09-30`,
    check: r => assert.ok(r.text.includes('81.37')) },
  { key: 'POST /coach/:token/api/timeline/summary', scope: 'coach', body: () => ({ metrics: ['k'] }) },
  { key: 'GET /coach/:token/api/photos', scope: 'coach', expect: 404,
    extra: [{ name: 'the latest of each pose', u: () => `/coach/${c.token}/api/photos?latest=1`, expect: 404 }] },
  { key: 'POST /coach/:token/api/photos', scope: 'coach', u: () => `/coach/${c.token}/api/photos?date=${DATE}&pose=back`, body: () => jpeg('coach') },
  { key: 'PUT /coach/:token/api/photos/:id/thumb', scope: 'coach', u: () => `/coach/${c.token}/api/photos/${c.p2}/thumb`, body: () => jpeg('coachthumb') },
  { key: 'PUT /coach/:token/api/photos/:id', scope: 'coach', u: () => `/coach/${c.token}/api/photos/${c.p1}`, body: () => ({ date: DATE, pose: 'back', note: 'coach' }) },
  { key: 'DELETE /coach/:token/api/photos', scope: 'coach', u: () => `/coach/${c.token}/api/photos?from=2000-01-01&to=2100-01-01` },
  { key: 'DELETE /coach/:token/api/photos/:id', scope: 'coach', u: () => `/coach/${c.token}/api/photos/${c.p1}` },
  { key: 'POST /coach/:token/api/photos/:id/ai-pose', scope: 'coach', u: () => `/coach/${c.token}/api/photos/${c.p2}/ai-pose`, body: () => ({ save: true }) },
  { key: 'GET /coach/:token/api/photos/:id/file', scope: 'coach', u: () => `/coach/${c.token}/api/photos/${c.p2}/file`,
    check: r => assert.strictEqual(r.headers.get('content-type'), 'image/jpeg'),
    extra: [
      { name: 'another account’s photo', u: () => `/coach/${c.token}/api/photos/${c.bobPhoto}/file`, expect: 404 },
      { name: 'a photo the Timeline never shows', u: () => `/coach/${c.token}/api/photos/${c.p1}/file`, expect: 404 },
    ] },
  { key: 'GET /coach/:token/api/photos/:id/thumb', scope: 'coach', u: () => `/coach/${c.token}/api/photos/${c.p2}/thumb`,
    extra: [
      { name: 'another account’s photo', u: () => `/coach/${c.token}/api/photos/${c.bobPhoto}/thumb`, expect: 404 },
      { name: 'a photo the Timeline never shows', u: () => `/coach/${c.token}/api/photos/${c.p1}/thumb`, expect: 404 },
    ] },
];
for (const r of ROUTES) {
  [r.method, r.path] = r.key.split(' ');
  if (!r.scope) r.scope = r.path.startsWith('/api/admin/') ? 'admin' : r.path.startsWith('/api/') || r.path === '/api' ? 'api' : null;
  assert.ok(r.scope, r.key);
}
const fill = p => p.replace(':date', DATE).replace(':from', FROM).replace(':token', c.token || 'none');
const urlOf = r => (r.u ? r.u() : fill(r.path));
const bodyOf = r => (r.body ? r.body() : r.method === 'GET' ? undefined : {});
function noAnn(r) { assert.ok(!r.text.includes('annmark'), 'nothing of ann’s: ' + r.text.slice(0, 300)); }
const statusIn = (r, list, what) => assert.ok(list.includes(r.status), `${what}: got ${r.status} ${r.text.slice(0, 200)}, expected ${list.join(' or ')}`);

/* ann's data as ann reads it back, plus her rows and files */
async function annState() {
  const exp = (await ann('GET', '/api/export')).body;
  delete exp.exported;
  const files = await Promise.all([c.p1, c.p2].map(async id => (await ann('GET', `/api/photos/${id}/file`)).bytes.toString('hex')));
  return JSON.stringify({ exp, shares: (await ann('GET', '/api/shares')).body, job: (await ann('GET', '/api/jobs/' + c.job)).body,
    jobs: (await ann('GET', '/api/jobs')).body, gym: (await ann('GET', '/api/gym')).body, files, rows: snapshot(A_ID) });
}

/* ---------- 1. signed out ---------- */
test('signed out: every /api route answers 401 and changes nothing', async t => {
  const before = snapshot();
  for (const r of ROUTES.filter(r => r.scope === 'api' || r.scope === 'admin')) {
    await t.test(r.key, async () => {
      const res = await call(r.method, urlOf(r), { body: bodyOf(r) });
      assert.strictEqual(res.status, 401, res.text.slice(0, 200));
    });
  }
  await t.test('a CSRF token alone (no account) is not a sign-in', async () => {
    const cfg = await call('GET', '/auth/config');
    const cookie = cfg.headers.get('set-cookie').split(';')[0];
    for (const r of ROUTES.filter(r => r.method !== 'GET' && (r.scope === 'api' || r.scope === 'admin'))) {
      assert.strictEqual((await call(r.method, urlOf(r), { cookie, csrf: cfg.body.csrf, body: bodyOf(r) })).status, 401, r.key);
    }
    assert.strictEqual((await call('POST', '/auth/password', { cookie, csrf: cfg.body.csrf, body: { current: PASSWORD, next: 'another-password-2' } })).status, 401);
  });
  await t.test('a half-signed-in session (password right, second step not done) is not a sign-in', async () => {
    const cfg = await call('GET', '/auth/config');
    const r = await call('POST', '/auth/login', { cookie: cfg.headers.get('set-cookie').split(';')[0], csrf: cfg.body.csrf,
      body: { email: 'dee@example.com', password: PASSWORD } });
    assert.strictEqual(r.body.second, true);
    const cookie = r.headers.get('set-cookie').split(';')[0], csrf = r.body.csrf;
    for (const x of ROUTES.filter(x => x.scope === 'api' || x.scope === 'admin')) {
      assert.strictEqual((await call(x.method, urlOf(x), { cookie, csrf, body: bodyOf(x) })).status, 401, x.key);
    }
    assert.strictEqual((await call('POST', '/auth/password', { cookie, csrf, body: { current: PASSWORD, next: 'another-password-2' } })).status, 401);
    assert.strictEqual((await call('GET', '/', { cookie })).status, 302);
  });
  await t.test('the app page sends you to sign in', async () => {
    for (const p of ['/', '/index.html']) {
      const res = await call('GET', p);
      assert.strictEqual(res.status, 302, p);
      assert.strictEqual(res.headers.get('location'), '/login');
    }
  });
  await t.test('nothing changed', () => assert.strictEqual(snapshot(), before));
});

/* ---------- 2. CSRF ---------- */
test('missing CSRF token: every state-changing /api and /auth route answers 403', async t => {
  const before = snapshot();
  const writes = ROUTES.filter(r => r.method !== 'GET' && ['api', 'admin', 'auth'].includes(r.scope));
  for (const r of writes) {
    await t.test(r.key, async () => {
      const who = r.scope === 'admin' ? adm : ann;   /* the admin's own session, so it isn't the admin check refusing */
      const res = await who(r.method, urlOf(r), bodyOf(r), { csrf: false });
      assert.strictEqual(res.status, 403, res.text.slice(0, 200));
      assert.match(res.body.error, /session expired/i);
      const wrong = await call(r.method, urlOf(r), { cookie: who.cookie(), csrf: 'x'.repeat(43), body: bodyOf(r) });
      assert.strictEqual(wrong.status, 403, 'a wrong token too');
    });
  }
  await t.test('nothing changed, and both sessions still work', async () => {
    assert.strictEqual(snapshot(), before);
    assert.strictEqual((await ann('GET', '/api/me')).body.email, 'ann@example.com');
    assert.strictEqual((await adm('GET', '/api/me')).body.email, 'adm@example.com');
  });
});

/* ---------- 3. ownership ---------- */
test('ownership: bob cannot read, change or delete any of ann’s records', async t => {
  const before = await annState();
  for (const r of ROUTES.filter(r => r.scope === 'api')) {
    assert.ok(r.own, `${r.key} has no ownership row`);
    if (typeof r.own === 'string' && r.own !== NOOP) continue;
    if (r.own === NOOP) {
      await t.test(`${r.key} (someone else’s id = a made-up id)`, async () => {
        const made = await bob(r.method, urlOf(r).replace(/\/\d+(?=\/|$|\?)/, '/999999'), r.made ? r.made() : bodyOf(r));
        const res = await bob(r.method, urlOf(r), bodyOf(r));
        assert.ok([200, 403, 404].includes(res.status), String(res.status));
        assert.deepStrictEqual([res.status, res.body], [made.status, made.body], 'answers as for an id that does not exist');
      });
      continue;
    }
    for (const [i, p] of r.own.entries()) {
      await t.test(r.own.length > 1 ? `${r.key} #${i + 1}` : r.key, async () => {
        aiMark = aiSeen.length;
        const res = await bob(r.method, p.u ? p.u() : urlOf(r), p.body ? p.body() : bodyOf(r));
        statusIn(res, p.expect || [200], r.key);
        if (p.check) p.check(res);
      });
    }
  }
  await t.test('ann’s data reads back the same', async () => assert.strictEqual(await annState(), before));
});

/* ---------- 4. super admin ---------- */
test('super admin: every /api/admin route answers 403 to a normal account', async t => {
  await t.test('the first account is the super admin (ADMIN_EMAILS is empty)', async () => {
    assert.strictEqual(env.ADMIN_EMAILS, '');
    const db = new DatabaseSync(DB, { readOnly: true });
    assert.strictEqual(db.prepare('SELECT email FROM users ORDER BY id LIMIT 1').get().email, 'adm@example.com');
    db.close();
    assert.strictEqual((await adm('GET', '/api/me')).body.admin, true);
    assert.strictEqual((await adm('GET', '/api/admin/users')).status, 200);
    for (const who of [ann, bob]) assert.strictEqual((await who('GET', '/api/me')).body.admin, false);
  });
  const before = snapshot();
  for (const r of ROUTES.filter(r => r.scope === 'admin')) {
    await t.test(r.key, async () => {
      for (const who of [ann, bob]) {
        const res = await who(r.method, urlOf(r), bodyOf(r));
        assert.strictEqual(res.status, 403, res.text.slice(0, 200));
        assert.ok(!/sk-test|smtp|invited@/i.test(res.text), 'no admin details in the refusal');
      }
    });
  }
  await t.test('nothing changed', () => assert.strictEqual(snapshot(), before));
});

/* ---------- 5. coach links ---------- */
test('coach links: refused when wrong, off or expired; a live one reads only its owner’s data and only reads', async t => {
  const make = async label => { const r = await ann('POST', '/api/shares', { label, expires: inDays(7) }); assert.strictEqual(r.status, 200); return r.body; };
  const live = await make('live');
  c.token = live.url.split('/').pop();
  const off = await make('off');
  assert.strictEqual((await ann('DELETE', '/api/shares/' + off.id)).status, 200);
  const old = await make('expired');
  const w = new DatabaseSync(DB);
  w.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), old.id);
  w.close();
  const bad = { 'a made-up secret': 'A'.repeat(43), 'a malformed secret': 'nope', 'a switched-off link': off.url.split('/').pop(),
    'an expired link': old.url.split('/').pop() };
  const coachRows = ROUTES.filter(r => r.scope === 'coach');

  for (const [why, token] of Object.entries(bad)) {
    await t.test(`refused: ${why}`, async () => {
      for (const r of coachRows) {
        const res = await call(r.method, urlOf(r).replace(c.token, token), { body: bodyOf(r) });
        assert.strictEqual(res.status, 404, `${r.key}: ${res.status}`);
        assert.strictEqual(res.body.gone, true, r.key);
      }
    });
  }

  const before = snapshot();
  for (const r of coachRows.filter(r => r.method === 'GET')) {
    await t.test(`live link: ${r.key}`, r.todo ? { todo: r.todo } : {}, async () => {
      const res = await call('GET', urlOf(r));
      assert.strictEqual(res.status, r.expect || 200, res.text.slice(0, 200));
      assert.strictEqual(res.headers.get('cache-control'), 'no-store');
      assert.ok(!res.text.includes('bobmark') && !res.text.includes('99.9') && !res.text.includes('3111'), 'nothing of bob’s');
      if (r.check) r.check(res);
    });
    for (const x of r.extra || []) {
      await t.test(`live link: ${r.key} – ${x.name}`, x.todo ? { todo: x.todo } : {}, async () => {
        assert.strictEqual((await call('GET', x.u())).status, x.expect);
      });
    }
  }
  for (const r of coachRows.filter(r => r.method !== 'GET')) {
    await t.test(`live link refuses ${r.key}`, async () => {
      const res = await call(r.method, urlOf(r), { body: bodyOf(r) });
      assert.strictEqual(res.status, 405, res.text.slice(0, 200));
    });
  }
  await t.test('live link: nothing else is reachable through it', async () => {
    for (const p of ['/me', '/export', '/settings', '/shares', '/gym', '/supps', '/foods', '/checklist', '/jobs', '/admin/users', `/days/${DATE}`]) {
      assert.strictEqual((await call('GET', `/coach/${c.token}/api${p}`)).status, 404, p);
    }
    for (const m of ['PUT', 'PATCH', 'DELETE', 'POST']) {
      assert.strictEqual((await call(m, `/coach/${c.token}/api/weights`, { body: { kg: 50 } })).status, 405, m);
    }
  });
  await t.test('nothing changed through the coach link', () => assert.strictEqual(snapshot(), before));
});

/* ---------- sessions and links after a password change ---------- */
test('a password change ends the account’s other sessions and (unless unticked) its coach links', async t => {
  const s1 = await signIn('cat@example.com'), s2 = await signIn('cat@example.com');
  const link = (await s1('POST', '/api/shares', { label: 'cat', expires: inDays(7) })).body.url;
  assert.strictEqual((await call('GET', link + '/api/info')).status, 200);
  await t.test('an empty current password is asked for, not called wrong (Phase 5)', async () => {
    const r = await s1('POST', '/auth/password', { current: '', next: 'brand-new-password-3' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'Enter your current password.');
  });
  assert.strictEqual((await s1('POST', '/auth/password', { current: PASSWORD, next: 'brand-new-password-3' })).status, 200);
  await t.test('the old password no longer signs in', async () => {
    const cfg = await call('GET', '/auth/config');
    const r = await call('POST', '/auth/login', { cookie: cfg.headers.get('set-cookie').split(';')[0], csrf: cfg.body.csrf,
      body: { email: 'cat@example.com', password: PASSWORD } });
    assert.strictEqual(r.status, 401);
  });
  await t.test('another session of the account is signed out, this one stays signed in', async () => {
    assert.strictEqual((await s2('GET', '/api/me')).status, 401);
    assert.strictEqual((await s1('GET', '/api/me')).status, 200);
  });
  await t.test('the account’s coach links stop working ("Also switch off my coach links" is ticked by default)', async () => {
    assert.strictEqual((await call('GET', link + '/api/info')).status, 404);
  });
  await t.test('with the box unticked, coach links keep working', async () => {
    const l2 = (await s1('POST', '/api/shares', { label: 'cat 2', expires: inDays(7) })).body.url;
    const r = await s1('POST', '/auth/password', { current: 'brand-new-password-3', next: 'brand-new-password-4', endLinks: false });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.linksOff, 0);
    assert.strictEqual((await call('GET', l2 + '/api/info')).status, 200);
    assert.strictEqual((await s1('GET', '/api/me')).status, 200);
  });
  await t.test('signing out ends the session', async () => {
    assert.strictEqual((await s1('POST', '/auth/logout', {})).status, 200);
    assert.strictEqual((await s1('GET', '/api/me')).status, 401);
  });
});

/* ---------- 6. the table covers every route ---------- */
/* Reads server/*.js: each express.Router() (and the app in index.js), its routes, and where it is mounted
   (x.use('/path', module.router)), starting from index.js. A route with no row, or a row with no route, fails. */
function registeredRoutes() {
  const SRV = path.join(root, 'server');
  const files = {};
  for (const f of fs.readdirSync(SRV).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(SRV, f), 'utf8'), mod = f.slice(0, -3);
    const requires = Object.fromEntries([...src.matchAll(/const (\w+) = require\('\.\/(\w+)'\)/g)].map(m => [m[1], m[2]]));
    const routers = new Set([...src.matchAll(/const (\w+) = express\.Router\(/g)].map(m => m[1]));
    if (mod === 'index') routers.add('app');
    const def = /module\.exports = (\w+);/.exec(src);
    const routes = [], mounts = [];
    for (const m of src.matchAll(/\b(\w+)\.(get|post|put|delete|patch|all|use)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/g)) {
      const [, rv, verb, arg] = m;
      if (!routers.has(rv)) continue;
      const paths = [...arg.matchAll(/['"`]([^'"`]*)['"`]/g)].map(x => x[1]);
      if (verb === 'use') {
        const line = src.slice(m.index + m[0].length, src.indexOf('\n', m.index));
        const t = /^\s*,\s*(\w+)(?:\.(\w+))?\s*\)/.exec(line);
        if (!t || !requires[t[1]]) throw new Error(`can’t read this mount in server/${f}: ${src.slice(m.index, src.indexOf('\n', m.index))}`);
        for (const p of paths) mounts.push({ rv, p, mod: requires[t[1]], exp: t[2] || null });
      } else for (const p of paths) routes.push({ rv, method: verb.toUpperCase(), p });
    }
    files[mod] = { routes, mounts, def: def && def[1], routers };
  }
  const join = (a, b) => { const s = (a + '/' + b).replace(/\/+/g, '/'); return s.length > 1 ? s.replace(/\/$/, '') : s; };
  const out = new Set(), seen = new Set();
  const walk = (mod, rv, prefix) => {
    const f = files[mod];
    rv = rv || f.def;
    assert.ok(f && f.routers.has(rv), `server/${mod}.js has no router ${rv}`);
    seen.add(mod + '.' + rv);
    for (const r of f.routes.filter(r => r.rv === rv)) out.add(`${r.method} ${join(prefix, r.p)}`);
    for (const m of f.mounts.filter(m => m.rv === rv)) walk(m.mod, m.exp, join(prefix, m.p));
  };
  walk('index', 'app', '');
  for (const [mod, f] of Object.entries(files)) {
    for (const r of f.routes) assert.ok(seen.has(mod + '.' + r.rv), `server/${mod}.js: ${r.method} ${r.p} is on a router this test can’t find mounted`);
  }
  return out;
}

test('the table has a row for every registered route, and only those', () => {
  const registered = registeredRoutes();
  const table = new Set(ROUTES.map(r => r.key));
  assert.strictEqual(table.size, ROUTES.length, 'no route listed twice');
  assert.deepStrictEqual([...registered].filter(k => !table.has(k)).sort(), [], 'routes with no row in ROUTES');
  assert.deepStrictEqual([...table].filter(k => !registered.has(k)).sort(), [], 'rows for routes that no longer exist');
  for (const r of ROUTES.filter(r => r.scope === 'api')) assert.ok(r.own, `${r.key}: say how bob is kept from ann’s records`);
});

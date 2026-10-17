'use strict';
/* Render caching: versioned scripts and styles (server/assets.js) with pages that are checked on every load, the kept
   Timeline trends (server/trendcache.js) and the Dashboard's photo ask (GET /api/photos?latest=1). */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assets = require('../server/assets');
const trendCache = require('../server/trendcache');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-caching-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'), PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
let srv;

before(async () => {
  for (const who of ['ann', 'bob', 'cat', 'admin']) {
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
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

async function signIn(email) {
  let cookie = '', csrf = '';
  const req = async (method, url, body, type) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': raw ? type : 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j, text, headers: r.headers };
  };
  await req('GET', '/auth/config');
  assert.strictEqual((await req('POST', '/auth/login', { email, password: 'long-password-1' })).status, 200);
  await req('GET', '/api/me');
  req.cookie = () => cookie;
  return req;
}
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const refs = html => [...html.matchAll(/\b(?:src|href)="(\/[^"#]*)"/g)].map(m => m[1]).filter(u => /^\/[^/]+\.[a-z]+(\?|$)/.test(u));   /* files, not routes (/auth/google, /login) */

/* ---------- versioned assets ---------- */
test('a changed file gets a new URL; pages point only at the URLs of the files as they are now', () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-assets-'));
  try {
    fs.writeFileSync(path.join(pub, 'a.js'), 'let a=1;');
    fs.writeFileSync(path.join(pub, 'b.css'), 'p{}');
    fs.writeFileSync(path.join(pub, 'p.html'), '<link href="/b.css"><a href="#x">x</a><img src="/nope.png"><script src="/a.js"></script><a href="https://example.com/a.js">e</a>');
    const one = assets.create(pub), u1 = one.url('a.js');
    assert.match(u1, /^\/a\.js\?v=[0-9a-f]{10}$/);
    assert.strictEqual(one.page('p.html').html, `<link href="${one.url('b.css')}"><a href="#x">x</a><img src="/nope.png"><script src="${u1}"></script><a href="https://example.com/a.js">e</a>`);
    assert.strictEqual(assets.create(pub).url('a.js'), u1, 'the same content, the same URL');

    fs.writeFileSync(path.join(pub, 'a.js'), 'let a=2;');
    const two = assets.create(pub);
    assert.notStrictEqual(two.url('a.js'), u1, 'new content, new URL (at the next start-up)');
    assert.strictEqual(two.url('b.css'), one.url('b.css'), 'an unchanged file keeps its URL');
    assert.notStrictEqual(two.page('p.html').etag, one.page('p.html').etag, 'and the page that points at it has a new ETag');
    assert.match(one.page('p.html').etag, /^"[0-9a-f]+"$/, 'a strong ETag');
    assert.strictEqual(one.page('p.html').html.includes(u1), true, 'without live, the hashes are the ones from start-up');

    /* live (npm run dev): an edited file shows at the next page load, without a restart */
    const live = assets.create(pub, { live: true }), before = live.page('p.html');
    fs.writeFileSync(path.join(pub, 'a.js'), 'let a=33;');
    const now = live.page('p.html');
    assert.notStrictEqual(now.etag, before.etag);
    assert.ok(now.html.includes(live.url('a.js')) && !now.html.includes(two.url('a.js')));
  } finally { fs.rmSync(pub, { recursive: true, force: true }); }
});

test('pages: no-cache with a strong ETag, 304 only after the route has run; assets: immutable under their hash', async () => {
  const ann = await signIn('ann@example.com');
  const pages = { '/login': null, '/invite': null, ['/coach/' + 'A'.repeat(43)]: null };
  for (const p of Object.keys(pages)) pages[p] = await fetch(BASE + p);
  pages['/'] = await fetch(BASE + '/', { headers: { cookie: ann.cookie() } });
  const seen = new Set();
  for (const [p, r] of Object.entries(pages)) {
    assert.strictEqual(r.status, 200, p);
    assert.strictEqual(r.headers.get('cache-control'), 'no-cache', p);
    assert.match(r.headers.get('etag'), /^"[0-9a-f]{20,}"$/, p + ': a strong ETag');
    const html = await r.text(), list = refs(html);
    assert.ok(list.some(u => /\.js\?/.test(u)) && list.some(u => /\.css\?/.test(u)), p);
    for (const u of list) { assert.match(u, /^\/[a-z0-9-]+\.(js|css|svg|png)\?v=[0-9a-f]{10}$/, `${p}: ${u}`); seen.add(u); }
    const again = await fetch(BASE + p, { headers: { 'if-none-match': r.headers.get('etag'), 'cache-control': 'max-age=0',   /* as a browser revalidates (fetch would add no-cache) */
       ...(p === '/' ? { cookie: ann.cookie() } : {}) } });
    assert.strictEqual(again.status, 304, p + ' revalidates');
  }
  /* the route runs before any 304: signed out, / still sends you to sign in whatever ETag the browser holds */
  const out = await fetch(BASE + '/', { redirect: 'manual', headers: { 'if-none-match': pages['/'].headers.get('etag'), 'cache-control': 'max-age=0' } });
  assert.deepStrictEqual([out.status, out.headers.get('location')], [302, '/login']);

  for (const u of seen) {
    const r = await fetch(BASE + u);
    assert.strictEqual(r.status, 200, u);
    assert.strictEqual(r.headers.get('cache-control'), assets.IMMUTABLE, u);
  }
  /* an old tab: the plain name and an old hash still load, but are checked every time, never kept under that name */
  for (const u of ['/app.js', '/app.js?v=0123456789', '/icon.svg']) {
    const r = await fetch(BASE + u);
    assert.deepStrictEqual([r.status, r.headers.get('cache-control')], [200, 'no-cache'], u);
  }
  /* the self-hosted font: its version is in its name, so it is kept for a year */
  const font = await fetch(BASE + '/fonts/archivo-latin-v5.woff2');
  assert.deepStrictEqual([font.status, font.headers.get('cache-control'), font.headers.get('content-type')], [200, assets.IMMUTABLE, 'font/woff2']);
  assert.strictEqual((await fetch(BASE + '/api/me', { headers: { cookie: ann.cookie() } })).headers.get('cache-control'), 'no-store', 'API answers are untouched');
});

/* ---------- kept trends ---------- */
const kgOf = r => r.body.series.find(s => s.key === 'kg').points;
const T = '/api/timeline/trends?from=2026-09-01&to=2026-09-30';

test('kept trends: a write shows at once, another account never gets them, and the same answer comes back byte for byte', async () => {
  const ann = await signIn('ann@example.com'), bob = await signIn('bob@example.com');
  await ann('PUT', '/api/weights/2026-09-10', { kg: 81.5 });
  const first = await ann('GET', T);
  assert.deepStrictEqual(kgOf(first), [['2026-09-10', 81.5]]);
  assert.strictEqual((await ann('GET', T)).text, first.text, 'a repeat read is the same JSON');
  assert.match(first.headers.get('content-type'), /^application\/json/);
  assert.deepStrictEqual(kgOf(await bob('GET', T)), [], 'bob, same range: nothing of ann’s');

  await ann('PUT', '/api/weights/2026-09-11', { kg: 82 });
  assert.deepStrictEqual(kgOf(await ann('GET', T)), [['2026-09-10', 81.5], ['2026-09-11', 82]], 'a write is seen by the next read');
  const sq = (await ann('POST', '/api/gym/exercises', { name: 'Squat' })).body.id;
  await ann('POST', '/api/gym/sets', { exercise: sq, reps: 5, kg: 100, at: '2026-09-12T18:00' });
  const t2 = await ann('GET', T);
  assert.deepStrictEqual(t2.body.series.find(s => s.key === 'vol').points, [['2026-09-12', 500]]);
  assert.deepStrictEqual(t2.body.exercises.map(x => [x.name, x.days]), [['Squat', 1]], 'the exercise list reads the same sets');
  await ann('DELETE', '/api/weights/2026-09-11');
  assert.deepStrictEqual(kgOf(await ann('GET', T)), [['2026-09-10', 81.5]], 'a delete too');
  /* a write that fails still makes the next read fresh, harmlessly */
  assert.strictEqual((await ann('PUT', '/api/weights/2026-09-12', { kg: 'heavy' })).status, 400);
  assert.deepStrictEqual(kgOf(await ann('GET', T)), [['2026-09-10', 81.5]]);
});

test('kept trends and coach links: a switched-off link gets 404 with the answer still kept, an owner’s write shows to the coach', async () => {
  const cat = await signIn('cat@example.com');
  await cat('PUT', '/api/weights/2026-09-10', { kg: 70 });
  const link = (await cat('POST', '/api/shares', { label: 'Coach', expires: new Date(Date.now() + 86400000).toISOString() })).body;
  const api = link.url.replace(/^https?:\/\/[^/]+/, '') + '/api/timeline/trends?from=2026-09-01&to=2026-09-30';
  const coach = async () => { const r = await fetch(BASE + api); return { status: r.status, body: await r.json() }; };
  const own = await cat('GET', T);
  assert.deepStrictEqual(kgOf(await coach()), kgOf(own), 'the coach reads the owner’s answer');
  await cat('PUT', '/api/weights/2026-09-11', { kg: 71 });
  assert.deepStrictEqual(kgOf(await coach()), [['2026-09-10', 70], ['2026-09-11', 71]]);

  assert.strictEqual((await cat('DELETE', '/api/shares/' + link.id)).status, 200);
  assert.strictEqual((await cat('GET', T)).status, 200);   /* the owner's answer is warm */
  const off = await coach();
  assert.deepStrictEqual([off.status, off.body.gone], [404, true], 'checked before the kept answer is reached');
  /* a made-up secret never reaches it either */
  assert.strictEqual((await fetch(BASE + '/coach/' + 'B'.repeat(43) + '/api/timeline/trends')).status, 404);
});

test('kept trends: removing an account ends its coach links and its kept answers', async () => {
  const bob = await signIn('bob@example.com'), admin = await signIn('admin@example.com');
  await bob('PUT', '/api/weights/2026-09-10', { kg: 90 });
  const link = (await bob('POST', '/api/shares', { expires: new Date(Date.now() + 86400000).toISOString() })).body;
  const api = link.url.replace(/^https?:\/\/[^/]+/, '') + '/api/timeline/trends?from=2026-09-01&to=2026-09-30';
  assert.strictEqual((await fetch(BASE + api)).status, 200);
  const id = (await admin('GET', '/api/admin/users')).body.users.find(u => u.email === 'bob@example.com').id;
  assert.strictEqual((await admin('DELETE', '/api/admin/users/' + id)).status, 200);
  assert.strictEqual((await fetch(BASE + api)).status, 404);
});

test('the trend memo: generations, LRU and the size cap', () => {
  let made = 0;
  const make = s => () => { made++; return s; };
  assert.strictEqual(trendCache.get(1, 'r', make('a')), 'a');
  assert.strictEqual(trendCache.get(1, 'r', make('b')), 'a', 'kept');
  assert.strictEqual(trendCache.get(2, 'r', make('other')), 'other', 'keyed by account');
  trendCache.bump(1);
  assert.strictEqual(trendCache.get(1, 'r', make('c')), 'c', 'the account wrote');
  assert.strictEqual(trendCache.get(2, 'r', make('x')), 'other', 'another account’s write leaves it');
  trendCache.bumpAll();
  assert.strictEqual(trendCache.get(2, 'r', make('y')), 'y', 'the AI settings or options changed');
  trendCache.drop(2);
  assert.ok(trendCache.stats().entries >= 1);
  assert.strictEqual(trendCache.get(2, 'r', make('z')), 'z', 'removed account');
  for (let i = 0; i < 250; i++) trendCache.get(3, 'k' + i, make('v'));
  assert.ok(trendCache.stats().entries <= 200, 'at most 200 kept');
  const big = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 30; i++) trendCache.get(4, 'b' + i, make(big));
  assert.ok(trendCache.stats().bytes <= 16 * 1024 * 1024, 'capped by size');
  made = 0;
  trendCache.get(4, 'b29', make(big));
  assert.strictEqual(made, 0, 'the newest stay');
});

/* ---------- the Dashboard's photo card ---------- */
test('GET /api/photos?latest=1: the newest of each pose up to a date, and the count', async () => {
  const ann = await signIn('ann@example.com');
  const up = async (date, pose) => (await ann('POST', `/api/photos?date=${date}&pose=${pose}`, jpeg, 'image/jpeg')).body.id;
  const f1 = await up('2026-09-01', 'front'), f2 = await up('2026-09-05', 'front'), b1 = await up('2026-09-03', 'back');
  await up('2026-09-20', 'front');
  const r = (await ann('GET', '/api/photos?latest=1&to=2026-09-10')).body;
  assert.deepStrictEqual([r.photos.map(p => p.id), r.count], [[f2, b1], 4]);
  assert.deepStrictEqual((await ann('GET', '/api/photos?latest=1&to=2026-08-01')).body.photos.map(p => p.date), ['2026-09-20', '2026-09-03'],
    'all dated after: the newest of each overall');
  assert.ok(!(await ann('GET', '/api/photos?latest=1&to=2026-09-10')).body.photos.some(p => p.id === f1));
  assert.deepStrictEqual((await (await signIn('cat@example.com'))('GET', '/api/photos?latest=1')).body, { photos: [], count: 0 });
});

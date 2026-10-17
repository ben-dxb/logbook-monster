'use strict';
/* The app shell (Phase 5): branded HTML error pages for a browser outside /api and /auth (JSON everywhere else), the icons
   browsers ask for, no third-party font host in the pages or the CSP, and the landmarks every page has. The browser side
   (titles, focus, unknown #pages, the account menu, the jobs bar) is checked in scripts/smoke.js. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-shell-'));
const root = path.join(__dirname, '..'), pub = path.join(root, 'public');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'), PHOTO_DIR: path.join(dir, 'photos'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
let srv;

before(async () => {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const HTML = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

test('a browser gets a branded page for an address that is not one; fetch, /api and /auth keep JSON', async () => {
  for (const [u, status] of [['/nonexistent', 404], ['/some/deep/path', 404], ['/foo.html', 404], ['/404.html', 404], ['/%E0%A4%A', 400]]) {
    const r = await fetch(BASE + u, { headers: HTML });
    assert.strictEqual(r.status, status, u);
    assert.match(r.headers.get('content-type'), /^text\/html/, u);
    const html = await r.text();
    assert.match(html, /<title>Page not found – Logbook Monster<\/title>/, u);
    assert.match(html, /<main[ >]/, u);
    assert.match(html, /href="\/"/, u + ': a link home');
    assert.doesNotMatch(html, /Cannot GET|"error"/, u);
    const plain = await fetch(BASE + u);   // fetch's own Accept (any type): what a script asked for stays JSON
    assert.strictEqual(plain.status, status, u);
    assert.match(plain.headers.get('content-type'), /json/, u);
  }
  for (const u of ['/api/nope', '/auth/nope', '/coach/' + 'A'.repeat(43) + '/api/nope']) {
    const r = await fetch(BASE + u, { headers: HTML });
    assert.match(r.headers.get('content-type'), /json/, u + ': the API never answers with a page');
  }
});

test('the 500 page is plain, branded and has a way home', () => {
  const html = fs.readFileSync(path.join(pub, '500.html'), 'utf8');
  assert.match(html, /<title>Something went wrong – Logbook Monster<\/title>/);
  assert.match(html, /href="\/"/);
  assert.doesNotMatch(html, /<script|style=/);
});

test('favicon.ico and apple-touch-icon load; no unrecognised Permissions-Policy features; no Google in the CSP', async () => {
  for (const [u, type] of [['/favicon.ico', /icon/], ['/apple-touch-icon.png', /image\/png/]]) {
    const r = await fetch(BASE + u);
    assert.strictEqual(r.status, 200, u);
    assert.match(r.headers.get('content-type'), type, u);
  }
  const r = await fetch(BASE + '/login');
  assert.doesNotMatch(r.headers.get('permissions-policy'), /bluetooth/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /google/);
});

test('every page: fonts from this site only (preloaded before the app), a <main>, deferred scripts in the app', () => {
  for (const f of ['index.html', 'login.html', 'invite.html', 'coach.html', '404.html', '500.html']) {
    const html = fs.readFileSync(path.join(pub, f), 'utf8');
    assert.doesNotMatch(html, /googleapis|gstatic/, f);
    /* the sign-in, invite and error pages fetch the font early, so the app (always reached through one) finds it cached;
       the app pages don't, where it would hold up their scripts on a slow line */
    const preload = /<link rel="preload" href="\/fonts\/archivo-latin-v5\.woff2" as="font" type="font\/woff2" crossorigin>/.test(html);
    assert.strictEqual(preload, !['index.html', 'coach.html'].includes(f), f + ': font preload');
    assert.match(html, /<main[ >]/, f);
    assert.doesNotMatch(html, /\sstyle=|<script>/, f + ': strict CSP');
  }
  for (const f of ['index.html', 'coach.html']) {
    const html = fs.readFileSync(path.join(pub, f), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]*>/g)].map(m => m[0]);
    assert.ok(scripts.length && scripts.every(s => /\sdefer\s/.test(s)), f + ': every script deferred');
    assert.match(html, /<a class="skip" href="#main">/, f + ': a skip link');
  }
  const idx = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const order = [...idx.matchAll(/<script defer src="\/([a-z]+)\.js">/g)].map(m => m[1]);
  assert.deepStrictEqual(order.slice(0, 3), ['engine', 'app', 'jobs'], 'jobs.js right after app.js');
  for (const f of ['archivo-latin-v5.woff2', 'archivo-latin-ext-v5.woff2', 'OFL.txt']) assert.ok(fs.existsSync(path.join(pub, 'fonts', f)), f);
  for (const f of ['login.html', 'invite.html']) {
    const html = fs.readFileSync(path.join(pub, f), 'utf8');
    assert.match(html, /<meta name="description" content="[^"]{40,}">/, f);
    assert.match(html, /<meta property="og:title" content="Logbook Monster/, f);
  }
});

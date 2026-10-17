'use strict';
/* Phase 6: compression is left to the reverse proxy. Caddy's `encode` (minimum_length 512) decides from the first chunk of a
   chunked answer, so the streamed export's first chunk must be 512+ bytes; and res.json answers carry no ETag (no-store, never
   revalidated) while static files keep theirs. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-compression-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
let srv;

before(async () => {
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'ann@example.com'],
    { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

let cookie = '', csrf = '';
async function req(method, url, body) {
  const r = await fetch(BASE + url, { method, redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf },
    body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (j && j.csrf) csrf = j.csrf;
  return { status: r.status, body: j, headers: r.headers };
}

/* The answer as it comes off the socket: headers, and the body's chunks as the server framed them. */
function raw(url) {
  return new Promise((resolve, reject) => {
    const s = net.connect(PORT, '127.0.0.1', () => s.write(`GET ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`));
    const parts = [];
    s.on('data', d => parts.push(d)); s.on('error', reject);
    s.on('end', () => {
      const all = Buffer.concat(parts), at = all.indexOf('\r\n\r\n');
      const head = all.subarray(0, at).toString('latin1');
      let rest = all.subarray(at + 4);
      const chunks = [];
      if (/^transfer-encoding:\s*chunked/im.test(head)) {
        for (;;) {
          const eol = rest.indexOf('\r\n'), n = parseInt(rest.subarray(0, eol).toString(), 16);
          if (!n) break;
          chunks.push(rest.subarray(eol + 2, eol + 2 + n));
          rest = rest.subarray(eol + 2 + n + 2);
        }
      } else chunks.push(rest);
      resolve({ head, chunks, body: Buffer.concat(chunks).toString() });
    });
  });
}

const KEYS = ['exported', 'email', 'settings', 'defaults', 'planChanges', 'days', 'weights', 'gym', 'foods', 'supplements', 'checklist', 'photos'];

test('the export starts with one chunk of 512+ bytes, so a proxy compresses it; the body is unchanged', async () => {
  await req('GET', '/auth/config');
  assert.strictEqual((await req('POST', '/auth/login', { email: 'ann@example.com', password: 'long-password-1' })).status, 200);
  await req('GET', '/api/me');

  /* a new account: everything still arrives, framed either way */
  let r = await raw('/api/export');
  assert.match(r.head, /^HTTP\/1\.1 200/);
  assert.deepStrictEqual(Object.keys(JSON.parse(r.body)), KEYS);
  if (r.chunks.length > 1) assert.ok(r.chunks[0].length >= 512, `first chunk ${r.chunks[0].length} bytes`);

  /* with days: chunked (streamed in batches), first chunk 512+ bytes */
  const d0 = new Date(Date.now() - 400 * 86400000);
  for (let i = 0; i < 250; i++) {
    const date = new Date(d0.getTime() + i * 86400000).toISOString().slice(0, 10);
    assert.strictEqual((await req('PUT', `/api/days/${date}`, { data: { meals: [], n: i }, summary: { k: i } })).status, 200);
  }
  r = await raw('/api/export');
  assert.match(r.head, /^transfer-encoding:\s*chunked/im);
  assert.ok(r.chunks.length > 2, 'still streamed');
  assert.ok(r.chunks[0].length >= 512, `first chunk ${r.chunks[0].length} bytes`);
  const exp = JSON.parse(r.body);
  assert.deepStrictEqual(Object.keys(exp), KEYS);
  assert.strictEqual(exp.email, 'ann@example.com');
  assert.strictEqual(exp.days.length, 250);
  assert.strictEqual(exp.days[249].data.n, 249);
  assert.ok(r.body.startsWith('{"exported":'));
});

test('no ETag on API and auth answers; static files and pages keep theirs', async () => {
  for (const u of ['/api/me', '/api/settings', '/auth/config']) {
    const r = await req('GET', u);
    assert.strictEqual(r.status, 200, u);
    assert.strictEqual(r.headers.get('etag'), null, u);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store', u);
  }
  for (const u of ['/app.js', '/app.css', '/']) {
    const r = await req('GET', u);
    assert.strictEqual(r.status, 200, u);
    assert.ok(r.headers.get('etag'), u);
  }
});

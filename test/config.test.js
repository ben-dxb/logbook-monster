'use strict';
/* Start-up guards and path handling in server/config.js. */
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-config-')));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const base = { PATH: process.env.PATH, SESSION_SECRET: 'x'.repeat(40), DB_PATH: 'data/t.db' };
/* run with cwd in the temp dir so no .env is picked up */
const run = (args, env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: dir, env: { ...base, ...env }, encoding: 'utf8', timeout: 20000 });
const cfg = env => JSON.parse(run(['-e', `const c=require(${JSON.stringify(path.join(__dirname, '..', 'server', 'config.js'))});
  console.log(JSON.stringify({dbPath:c.dbPath,photoDir:c.photoDir,trustProxy:c.trustProxy}))`], env).stdout);

test('production refuses to start without ADMIN_EMAILS', () => {
  const r = run([path.join(__dirname, '..', 'server', 'index.js')], { NODE_ENV: 'production', ADMIN_EMAILS: '', PORT: '0' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /ADMIN_EMAILS must be set in production/);
});

test('production without BASE_URL warns at start (invite links and emails would point at localhost)', () => {
  const cfgPath = JSON.stringify(path.join(__dirname, '..', 'server', 'config.js'));
  const r = run(['-e', `require(${cfgPath})`], { NODE_ENV: 'production', ADMIN_EMAILS: 'a@example.com' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /BASE_URL isn’t set/);
  assert.doesNotMatch(run(['-e', `require(${cfgPath})`], { NODE_ENV: 'production', ADMIN_EMAILS: 'a@example.com', BASE_URL: 'https://x.example' }).stderr, /BASE_URL/);
});

test('a relative DB_PATH and PHOTO_DIR become absolute', () => {
  assert.deepStrictEqual(cfg({}), { dbPath: path.join(dir, 'data', 't.db'), photoDir: path.join(dir, 'data', 'photos'), trustProxy: '' });
  assert.strictEqual(cfg({ PHOTO_DIR: 'pics' }).photoDir, path.join(dir, 'pics'));
});

test('trust proxy stays off in production unless TRUST_PROXY is set', () => {
  assert.strictEqual(cfg({ NODE_ENV: 'production', ADMIN_EMAILS: 'a@example.com' }).trustProxy, '');
  assert.strictEqual(cfg({ NODE_ENV: 'production', ADMIN_EMAILS: 'a@example.com', TRUST_PROXY: '1' }).trustProxy, '1');
});

test('behind https: HSTS for two years with subdomains (not preloaded)', async () => {
  const { spawn } = require('node:child_process');
  const [PORT] = require('./_ports').freePorts(1);
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')],
    { cwd: dir, env: { ...base, DB_PATH: 'data/h.db', PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: 'https://logbook.example' }, stdio: 'ignore' });
  try {
    let r;
    for (let i = 0; i < 50 && !r; i++) { try { r = await fetch(`http://127.0.0.1:${PORT}/login`); } catch { await new Promise(x => setTimeout(x, 100)); } }
    assert.strictEqual(r.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
    assert.strictEqual(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  } finally { srv.kill(); }
});

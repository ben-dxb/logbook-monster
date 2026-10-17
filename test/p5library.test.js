'use strict';
/* Phase 5, library: things shared by people with no name can be told apart ("another person (#2)") without showing an email. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-p5lib-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
let srv;

before(async () => {
  for (const who of ['admin', 'ann', 'nn1', 'nn2', 'viewer']) {
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', `${who}@example.com`],
      { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  }
  const db = new DatabaseSync(env.DB_PATH);
  db.prepare("UPDATE users SET name = 'Ann' WHERE email = 'ann@example.com'").run();
  db.close();
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
  const req = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j, text: JSON.stringify(j) };
  };
  await req('GET', '/auth/config');
  assert.strictEqual((await req('POST', '/auth/login', { email, password: 'long-password-1' })).status, 200);
  await req('GET', '/api/me');
  return req;
}

test('shared foods and supplements from people with no name are numbered per person, never shown by email', async () => {
  const people = { ann: await signIn('ann@example.com'), nn1: await signIn('nn1@example.com'), nn2: await signIn('nn2@example.com') };
  for (const [who, req] of Object.entries(people)) {
    assert.strictEqual((await req('POST', '/api/supps', { name: 'Creatine monohydrate', amount: 5, unit: 'g', notes: '', public: true })).status, 200, who);
    assert.strictEqual((await req('POST', '/api/foods', { name: 'Protein oats', unit: 'each', kind: 'meal', k: 420, p: 35, c: 50, f: 9, recipe: '', public: true })).status, 200, who);
  }
  await people.nn2('POST', '/api/supps', { name: 'Zinc', amount: 15, unit: 'mg', notes: '', public: true });
  const viewer = await signIn('viewer@example.com');
  const s = await viewer('GET', '/api/supps'), f = await viewer('GET', '/api/foods');
  for (const [list, r] of [['supplements', s], ['foods', f]]) {
    assert.ok(!/nn1@|nn2@|ann@|example\.com/.test(r.text), `no email in the ${list} list`);
    const rows = r.body[list].filter(x => !x.mine);
    const named = rows.filter(x => x.by === 'Ann');
    assert.ok(named.length >= 1 && named.every(x => x.anon === undefined), `a named owner keeps their name, no number (${list})`);
    const anon = rows.filter(x => !x.by).map(x => x.anon);
    assert.ok(anon.every(n => n === 1 || n === 2), `people with no name are numbered 1 and 2 (${list}): ${anon}`);
    assert.ok(anon.includes(1) && anon.includes(2), `both are told apart (${list})`);
  }
  /* the same person carries the same number on everything of theirs */
  const z = s.body.supplements.find(x => x.name === 'Zinc'), cr = s.body.supplements.filter(x => x.name === 'Creatine monohydrate' && !x.by);
  assert.ok(cr.some(x => x.anon === z.anon), 'one person, one number');
  /* your own items never carry one */
  const own = await people.nn1('GET', '/api/supps');
  assert.ok(own.body.supplements.filter(x => x.mine).every(x => x.anon === undefined && x.by === null), 'your own have no by or number');
  assert.ok(own.body.supplements.filter(x => !x.mine && !x.by).every(x => x.anon === 1), 'numbers are counted without you: the one other nameless person is #1');
});

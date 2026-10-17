'use strict';
/* Phase 4 – credentials on a 30-day cycle (docs/rotation.md):
   1. SESSION_SECRETS: a full forced cycle – provision a new first secret, verify old cookies / CSRF pre-tokens / AI-fill
      signatures / sealed secrets still work, shorten the overlap (drop the old one), prove the old one dead;
   2. AUDIT_HASH_KEY keeps the security log's email hash the same across that rotation;
   3. the OpenRouter key and the SMTP password: next slot, test, promote, old kept an hour, revoke, test old fails (recorded),
      and the single-field save still works; the app works with only NEXT saved and with ACTIVE+OLD;
   4. the age backstop: day 25 an email, day 30 a 'secret.stale' row and the banner count, day 35 an error on start, an unknown
      age counts as stale;
   5. coach links: 90 days by default, a reminder email a week before one runs out, Renew, unused-for-30-days flag. */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');

const [PORT, AI_PORT, SMTP_PORT] = require('./_ports').freePorts(3);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-rotation-'));
const S1 = '1'.repeat(40), S2 = '2'.repeat(40), PASSWORD = 'long-password-1';
const base = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, PHOTO_DIR: path.join(dir, 'photos'),
  AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: '', ALLOW_REGISTRATION: 'false', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
  SMTP_HOST: '', SMTP_PASS: '', SMTP_USER: '', MAIL_FROM: '', SMTP_ALLOW_HOSTS: '127.0.0.1', OPENROUTER_API_KEY: '', OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}`,
  SEAL_KEY: '', SEAL_KEY_OLD: '', SESSION_SECRET: '', SESSION_SECRET_OLD: '', SESSION_SECRETS: '', SESSION_SECRETS_SET: '', AUDIT_HASH_KEY: '' };
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/* OpenRouter stand-in: GET /key answers 200 for a live key and 401 for any other; completions name the key they got */
const live = new Set(), aiSaw = [];
const fakeAi = http.createServer((req, res) => {
  const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (!live.has(key)) { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } })); }
    if (req.url === '/key') return res.end(JSON.stringify({ data: { label: 'test' } }));
    aiSaw.push(key);
    res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: '{"headline":"ok","insights":[],"caveats":[]}' }, finish_reason: 'stop' }] }));
  });
});
/* a mail server with AUTH PLAIN: signs in only with a password in `good`; keeps what it's sent */
const good = new Set(), mails = [];
const fakeSmtp = net.createServer(sock => {
  let data = null, msg = {}, buf = '';
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', chunk => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data !== null) { if (line === '.') { msg.data = data.join('\n'); mails.push(msg); msg = {}; data = null; sock.write('250 queued\r\n'); } else data.push(line); continue; }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
      else if (cmd === 'AUTH') {
        const pass = Buffer.from(line.split(' ')[2] || '', 'base64').toString().split('\0')[2];
        sock.write(good.has(pass) ? '235 ok\r\n' : '535 5.7.8 bad credentials\r\n');
      } else if (cmd === 'RCPT') { msg.to = line; sock.write('250 ok\r\n'); }
      else if (cmd === 'DATA') { data = []; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') sock.end('221 bye\r\n');
      else sock.write('250 ok\r\n');
    }
  });
  sock.on('error', () => {});
});
const ready = Promise.all([new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r)), new Promise(r => fakeSmtp.listen(SMTP_PORT, '127.0.0.1', r))]);
const MAIL_ENV = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_SECURE: 'false', MAIL_FROM: 'app@example.com' };
after(() => { fakeAi.close(); fakeSmtp.close(); fs.rmSync(dir, { recursive: true, force: true }); });
async function mailTo(email, re, ms = 3000) {
  for (let i = 0; i < ms / 50; i++) { const m = mails.find(x => x.to.includes(email) && re.test(x.data)); if (m) return m; await new Promise(r => setTimeout(r, 50)); }
  return null;
}

/* ---------- servers ---------- */
let out = '';
async function serve(env) {
  await ready;
  out = '';
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { out += d; }); srv.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return srv; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  srv.kill();
  throw new Error('server did not start: ' + out);
}
const stop = srv => { const gone = new Promise(r => srv.once('exit', r)); srv.kill(); return gone; };
const mkUser = (email, env) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', email],
  { cwd: root, env: { ...base, ...env, NEW_PASSWORD: PASSWORD }, stdio: 'ignore' });
function client() {
  let cookie = '', csrf = '';
  const req = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc && !/^logbookmonster\.pre=;/.test(sc)) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j };
  };
  req.signIn = async email => {
    await req('GET', '/auth/config');
    assert.strictEqual((await req('POST', '/auth/login', { email, password: PASSWORD })).status, 200);
    await req('GET', '/api/me');
    return req;
  };
  req.state = () => ({ cookie, csrf });
  req.set = s => { ({ cookie, csrf } = s); };
  return req;
}
const sqlOn = db => (s, ...a) => { const d = new DatabaseSync(db); try { return d.prepare(s).all(...a); } finally { d.close(); } };

/* ---------- 1. SESSION_SECRETS ---------- */
test('SESSION_SECRETS cycle: provision → verify → promote → overlap shortened → old secret dead', async () => {
  const DB = path.join(dir, 'session.db'), sql = sqlOn(DB);
  const env = { DB_PATH: DB };
  mkUser('adm@example.com', { ...env, SESSION_SECRETS: S1 });
  live.add('sk-or-v1-session-cycle-key');

  /* the first secret alone: sign in, save an AI key (sealed – the session secret is the KEK, no SEAL_KEY), and a pre-token */
  let srv = await serve({ ...env, SESSION_SECRETS: S1 });
  const adm = client(), anon = client();
  let preState;
  try {
    await adm.signIn('adm@example.com');
    assert.strictEqual((await adm('PUT', '/api/admin/ai', { key: 'sk-or-v1-session-cycle-key' })).status, 200);
    await anon('GET', '/auth/config');
    preState = anon.state();
  } finally { await stop(srv); }
  const oldCookie = adm.state();

  /* provision: the new secret first, the old one second – everything signed with the old one still works */
  srv = await serve({ ...env, SESSION_SECRETS: `${S2},${S1}` });
  const adm2 = client();
  try {
    assert.match(out, /sealed keys: rewrapped 1,/, 'the data keys follow the first session secret');
    assert.strictEqual((await adm('GET', '/api/me')).status, 200, 'a cookie signed with the old secret');
    assert.strictEqual((await adm('GET', '/api/admin/ai')).body.configured, true, 'the sealed key still opens');
    anon.set(preState);
    assert.strictEqual((await anon('POST', '/auth/login', { email: 'adm@example.com', password: 'wrong-password-1' })).status, 401, 'a CSRF pre-token from the old secret is taken');
    await adm2.signIn('adm@example.com');   /* signed with the new one */
    const keys = (await adm2('GET', '/api/admin/keys')).body.credentials.find(c => c.name === 'SESSION_SECRETS');
    assert.match(keys.slots, /^2 in use/);
    assert.match(keys.next, /secret 2 can be removed after /, 'the overlap rule: SESSION_DAYS + 1 h after it stopped being first');
  } finally { await stop(srv); }

  /* overlap shortened: the old secret dropped at once (everyone signed in before is signed out) */
  const s = JSON.parse(sql("SELECT data FROM app_config WHERE key = 'secrets'")[0].data);
  assert.ok(Object.values(s.SESSION_SECRETS.retired).length === 1, 'when it stopped being first is recorded');
  srv = await serve({ ...env, SESSION_SECRETS: S2 });
  try {
    adm.set(oldCookie);
    assert.strictEqual((await adm('GET', '/api/me')).status, 401, 'the old secret is dead: its cookie no longer signs in');
    anon.set(preState);
    assert.strictEqual((await anon('POST', '/auth/login', { email: 'adm@example.com', password: 'wrong-password-1' })).status, 403, 'nor its CSRF pre-token');
    assert.strictEqual((await adm2('GET', '/api/me')).status, 200, 'the new one carries on');
    assert.strictEqual((await adm2('GET', '/api/admin/ai')).body.configured, true, 'sealed secrets rewrapped under it');
  } finally { await stop(srv); }
});

test('AI-fill signatures: one made under the old first secret checks out while it is in SESSION_SECRETS, not after', () => {
  const run = (secrets, code) => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], { cwd: root, encoding: 'utf8',
      env: { ...base, DB_PATH: path.join(dir, 'sig.db'), SESSION_SECRETS: secrets } });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const a = { fields: ['k'], of: ['k'], source: 'AI estimate', basis: [], url: '', confidence: 'high', model: 'm', at: '2026-10-01' };
  const sig = run(S1, `console.log(require('./server/foods').aiSig(${JSON.stringify(a)}, 7))`);
  const check = secrets => run(secrets, `console.log(!!require('./server/foods').trustedAi(${JSON.stringify({ ...a, sig })}, { id: 7 }))`);
  assert.strictEqual(check(S1), 'true');
  assert.strictEqual(check(`${S2},${S1}`), 'true');
  assert.strictEqual(check(S2), 'false');
});

test('AUDIT_HASH_KEY: the email hash in the security log stays the same when the session secrets rotate', () => {
  const hash = (secrets, key) => {
    const DB = path.join(dir, `hash-${secrets.length}-${key ? 1 : 0}.db`);
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e',
      `const a=require('./server/audit');a.log(null,'export',{email:'x@example.com'},null);
       console.log(JSON.parse(require('./server/db').prepare('SELECT detail FROM audit ORDER BY id DESC LIMIT 1').get().detail).eh)`],
    { cwd: root, encoding: 'utf8', env: { ...base, DB_PATH: DB, SESSION_SECRETS: secrets, AUDIT_HASH_KEY: key || '' } });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const H = 'h'.repeat(40);
  assert.strictEqual(hash(S1, H), hash(`${S2},${S1}`, H));
  assert.notStrictEqual(hash(S1), hash(`${S2},${S1}`), 'without it the hash follows the first session secret');
});

/* ---------- 3. two slots ---------- */
test('OpenRouter key: save as next, test, promote, old kept an hour, revoke, test old fails – recorded; single-field save still works', async () => {
  const DB = path.join(dir, 'slots.db'), sql = sqlOn(DB);
  mkUser('adm@example.com', { DB_PATH: DB, SESSION_SECRETS: S1 });
  const K1 = 'sk-or-v1-first-key-000000', K2 = 'sk-or-v1-second-key-11111', K3 = 'sk-or-v1-third-key-22222';
  live.add(K1); live.add(K2);
  const srv = await serve({ DB_PATH: DB, SESSION_SECRETS: S1, SEAL_KEY: 'k'.repeat(40) });
  try {
    const adm = await client().signIn('adm@example.com');
    /* only NEXT: no active key, AI off, the next one can be tested and promoted */
    let r = await adm('POST', '/api/admin/ai/next', { key: K1 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.configured, false);
    assert.deepStrictEqual(r.body.slots, { source: null, next: true, old: false, oldUntil: null });
    assert.ok(!JSON.stringify(sql("SELECT data FROM app_config WHERE key = 'openrouter'")).includes(K1), 'sealed at rest');
    assert.deepStrictEqual((await adm('POST', '/api/admin/ai/verify', { slot: 'next' })).body, { slot: 'next', ok: true, status: 200, dead: false });
    assert.strictEqual((await adm('POST', '/api/admin/ai/promote')).body.configured, true);
    const age1 = JSON.parse(sql("SELECT data FROM app_config WHERE key = 'secrets'")[0].data).OPENROUTER;
    assert.ok(age1 && age1.kid && Date.now() - Date.parse(age1.set_at) < 60000, 'its age starts now');

    /* a model change doesn't restart the age */
    await adm('PUT', '/api/admin/ai', { model: 'x/y' });
    assert.deepStrictEqual(JSON.parse(sql("SELECT data FROM app_config WHERE key = 'secrets'")[0].data).OPENROUTER, age1);

    /* the cycle: next → test → promote → ACTIVE + OLD (the new one is used) */
    await adm('POST', '/api/admin/ai/next', { key: K2 });
    assert.strictEqual((await adm('POST', '/api/admin/ai/verify', { slot: 'next' })).body.ok, true);
    r = await adm('POST', '/api/admin/ai/promote');
    assert.strictEqual(r.body.hint, '…' + K2.slice(-4));
    assert.strictEqual(r.body.slots.old, true);
    assert.ok(Math.abs(r.body.slots.oldUntil - Date.now() - 3600000) < 60000, 'old kept an hour');
    assert.notStrictEqual(JSON.parse(sql("SELECT data FROM app_config WHERE key = 'secrets'")[0].data).OPENROUTER.kid, age1.kid);
    aiSaw.length = 0;
    await adm('PUT', `/api/weights/${daysAgo(1)}`, { kg: 80 });
    const sum = await adm('POST', '/api/timeline/summary', { from: daysAgo(30), to: daysAgo(0), metrics: ['kg'] });
    assert.strictEqual(sum.status, 200, JSON.stringify(sum.body));
    assert.deepStrictEqual(aiSaw, [K2], 'calls use the active key while the old one is kept');
    /* still live at the provider: Test old says so; revoked: it fails, and that is recorded */
    assert.strictEqual((await adm('POST', '/api/admin/ai/verify', { slot: 'old' })).body.ok, true);
    live.delete(K1);
    assert.deepStrictEqual((await adm('POST', '/api/admin/ai/verify', { slot: 'old' })).body, { slot: 'old', ok: false, status: 401, dead: true });
    const log = (await adm('GET', '/api/admin/log?event=secret.tested')).body.rows;
    assert.deepStrictEqual(log[0].detail, { name: 'OPENROUTER', slot: 'old', ok: false, dead: true });
    assert.ok(JSON.parse(sql("SELECT data FROM app_config WHERE key = 'secrets'")[0].data).OPENROUTER.old_dead_at);
    assert.ok(!JSON.stringify((await adm('GET', '/api/admin/log')).body).includes('sk-or-v1-'), 'no key in the log');
    /* the hour is up: old dropped for good */
    const row = sql("SELECT data FROM app_config WHERE key = 'openrouter'")[0].data, d = JSON.parse(row);
    d.oldUntil = Date.now() - 1;
    sql("UPDATE app_config SET data = ? WHERE key = 'openrouter'", JSON.stringify(d));
    assert.strictEqual((await adm('GET', '/api/admin/ai')).body.slots.old, false);
    assert.ok(!JSON.parse(sql("SELECT data FROM app_config WHERE key = 'openrouter'")[0].data).oldSealed);
    assert.strictEqual((await adm('POST', '/api/admin/ai/verify', { slot: 'old' })).status, 404);
    assert.strictEqual((await adm('POST', '/api/admin/ai/promote')).status, 409, 'nothing to promote');

    /* the single-field save still works (and keeps the one it replaces as old) */
    r = await adm('PUT', '/api/admin/ai', { key: K3 });
    assert.strictEqual(r.body.hint, '…' + K3.slice(-4));
    assert.strictEqual(r.body.slots.old, true);
    assert.strictEqual((await adm('POST', '/api/admin/ai/verify', { slot: 'active' })).body.dead, true, 'K3 was never live at the fake');
    assert.strictEqual((await adm('POST', '/api/admin/ai/verify', { slot: 'nope' })).status, 400);
  } finally { await stop(srv); }
});

test('SMTP password: next, a real sign-in test (no email sent), promote, revoke, old refused', async () => {
  const DB = path.join(dir, 'smtp.db');
  mkUser('adm@example.com', { DB_PATH: DB, SESSION_SECRETS: S1 });
  const P1 = 'first-smtp-pass', P2 = 'second-smtp-pass';
  good.add(P1); good.add(P2);
  const srv = await serve({ DB_PATH: DB, SESSION_SECRETS: S1, ...MAIL_ENV, SMTP_USER: 'app@example.com' });
  try {
    const adm = await client().signIn('adm@example.com');
    assert.strictEqual((await adm('PUT', '/api/admin/email', { pass: P1 })).status, 200);
    assert.strictEqual((await adm('POST', '/api/admin/email/next', { pass: P2 })).body.slots.next, true);
    const sent = mails.length;
    assert.deepStrictEqual((await adm('POST', '/api/admin/email/verify', { slot: 'next' })).body, { slot: 'next', ok: true, dead: false });
    assert.strictEqual(mails.length, sent, 'a sign-in, no email');
    const r = await adm('POST', '/api/admin/email/promote');
    assert.deepStrictEqual([r.body.slots.next, r.body.slots.old], [false, true]);
    assert.strictEqual((await adm('POST', '/api/admin/email/verify', { slot: 'active' })).body.ok, true);
    good.delete(P1);   /* revoked at the provider */
    const old = (await adm('POST', '/api/admin/email/verify', { slot: 'old' })).body;
    assert.deepStrictEqual([old.ok, old.dead], [false, true]);
    assert.strictEqual((await adm('GET', '/api/admin/log?event=secret.tested')).body.rows[0].detail.dead, true);
    assert.strictEqual((await adm('POST', '/api/admin/email/test', { to: 'x@example.com' })).status, 200, 'mail goes out with the promoted one');
    const keys = (await adm('GET', '/api/admin/keys')).body;
    const smtp = keys.credentials.find(c => c.name === 'SMTP');
    assert.match(smtp.slots, /^active \+ old \(until /);
    assert.ok(!JSON.stringify(keys).includes(P1) && !JSON.stringify(keys).includes(P2), 'never a value');
  } finally { await stop(srv); }
});

/* ---------- 4. the backstop ---------- */
test('backstop: day 25 an email, day 30 a stale row and the banner count, day 35 an error on start; unknown age is stale', async () => {
  const DB = path.join(dir, 'backstop.db'), sql = sqlOn(DB);
  mkUser('adm@example.com', { DB_PATH: DB, SESSION_SECRETS: S1 });
  const env = { DB_PATH: DB, ...MAIL_ENV, ADMIN_EMAILS: 'adm@example.com', SEAL_KEY: `${daysAgo(3)}:${'k'.repeat(40)}` };
  const stale = () => sql("SELECT detail FROM audit WHERE event = 'secret.stale'").map(r => JSON.parse(r.detail));
  const due = async () => { const adm = await client().signIn('adm@example.com'); return (await adm('GET', '/api/admin/keys')).body; };

  /* 26 days: an email listing it, nothing stale */
  let srv = await serve({ ...env, SESSION_SECRETS: `${daysAgo(26)}:${S1}` });
  try {
    const m = await mailTo('adm@example.com', /due for rotation/);
    assert.ok(m, 'emailed: ' + out);
    assert.match(m.data, /Session secret \(SESSION_SECRETS\): 26 days old/);
    assert.deepStrictEqual(stale(), []);
    const k = await due();
    assert.deepStrictEqual([k.due, k.stale], [1, 0]);
    assert.strictEqual(k.credentials.find(c => c.name === 'SEAL_KEY').tier, 'ok', 'SEAL_KEY 3 days old');
  } finally { await stop(srv); }

  /* 31 days: a secret.stale row (once a day), the banner count; the email went today already */
  mails.length = 0;
  srv = await serve({ ...env, SESSION_SECRETS: `${daysAgo(31)}:${S1}` });
  try {
    for (let i = 0; i < 40 && !stale().length; i++) await new Promise(r => setTimeout(r, 50));
    assert.deepStrictEqual(stale(), [{ id: 'SESSION_SECRETS', name: 'SESSION_SECRETS', days: 31 }]);
    const k = await due();
    assert.strictEqual(k.stale, 1);
    assert.strictEqual(k.credentials.find(c => c.name === 'SESSION_SECRETS').tier, 'stale');
    assert.doesNotMatch(out, /rotate it now/);
  } finally { await stop(srv); }
  assert.strictEqual(stale().length, 1, 'once a day');

  /* 36 days: an error on every start; the companion variable gives the date as well as the prefix */
  srv = await serve({ ...env, SESSION_SECRETS: S1, SESSION_SECRETS_SET: daysAgo(36) });
  try {
    for (let i = 0; i < 40 && !/rotate it now/.test(out); i++) await new Promise(r => setTimeout(r, 50));
    assert.match(out, /Session secret \(SESSION_SECRETS\) is 36 days old – rotate it now/);
    assert.strictEqual((await due()).credentials.find(c => c.name === 'SESSION_SECRETS').tier, 'overdue');
  } finally { await stop(srv); }

  /* no date at all: stale, with how to set it */
  srv = await serve({ ...env, SESSION_SECRETS: S1 });
  try {
    const c = (await due()).credentials.find(x => x.name === 'SESSION_SECRETS');
    assert.deepStrictEqual([c.tier, c.days], ['unknown', null]);
    assert.match(c.next, /SESSION_SECRETS=YYYY-MM-DD:<value>/);
    assert.match(out, /has no recorded age/);
  } finally { await stop(srv); }
});

/* an unknown age: one sentence on the start-up log, and the step for where the key is held */
test('unknown age: the log line says so once, then the step for a key in .env or one saved on Super admin', async () => {
  const DB = path.join(dir, 'unknown.db'), sql = sqlOn(DB);
  mkUser('adm@example.com', { DB_PATH: DB, SESSION_SECRETS: S1 });
  const env = { DB_PATH: DB, SESSION_SECRETS: `${daysAgo(1)}:${S1}`, ADMIN_EMAILS: 'adm@example.com', SEAL_KEY: `${daysAgo(1)}:${'k'.repeat(40)}` };
  const keys = async () => { const adm = await client().signIn('adm@example.com'); return (await adm('GET', '/api/admin/keys')).body.credentials; };

  /* in .env with no date: the date prefix or OPENROUTER_API_KEY_SET – never "save it again" */
  let srv = await serve({ ...env, OPENROUTER_API_KEY: 'sk-or-v1-env-key-0000000' });
  try {
    const c = (await keys()).find(x => x.name === 'OPENROUTER');
    assert.match(c.next, /^To record its age, add the date it was set in \.env – OPENROUTER_API_KEY=YYYY-MM-DD:<value> or OPENROUTER_API_KEY_SET=YYYY-MM-DD – and restart\. Or save one on Super admin/);
    assert.doesNotMatch(c.next, /save it again|isn’t known/);
    assert.match(out, /OpenRouter API key \(OPENROUTER\) has no recorded age\. To record its age, add the date/);
    assert.doesNotMatch(out, /recorded age – |age isn’t known/);
  } finally { await stop(srv); }

  /* saved on Super admin, its record lost: save it again or promote a new one */
  live.add('sk-or-v1-db-key-00000000');
  srv = await serve(env);
  try {
    const adm = await client().signIn('adm@example.com');
    assert.strictEqual((await adm('PUT', '/api/admin/ai', { key: 'sk-or-v1-db-key-00000000' })).status, 200);
  } finally { await stop(srv); }
  const s = JSON.parse(sql("SELECT data FROM app_config WHERE key = 'secrets'")[0].data);
  delete s.OPENROUTER;
  sql("UPDATE app_config SET data = ? WHERE key = 'secrets'", JSON.stringify(s));
  srv = await serve(env);
  try {
    const c = (await keys()).find(x => x.name === 'OPENROUTER');
    assert.match(c.next, /^To record its age, save it again on Super admin › AI or promote a new one\./);
    assert.match(out, /OpenRouter API key \(OPENROUTER\) has no recorded age\. To record its age, save it again on Super admin › AI/);
    assert.doesNotMatch(out, /recorded age – |age isn’t known/);
  } finally { await stop(srv); }
});

/* ---------- 5. coach links ---------- */
test('coach links: a reminder a week before one runs out, Renew swaps the secret, and unused links are flagged', async () => {
  const DB = path.join(dir, 'coach.db'), sql = sqlOn(DB);
  mkUser('ann@example.com', { DB_PATH: DB, SESSION_SECRETS: S1 });
  const env = { DB_PATH: DB, SESSION_SECRETS: S1, ...MAIL_ENV };
  let srv = await serve(env), made, short;
  try {
    const ann = await client().signIn('ann@example.com');
    made = (await ann('POST', '/api/shares', { label: 'Coach Sam' })).body;
    assert.ok(Math.abs(Date.parse(made.expires) - Date.now() - 90 * 86400000) < 60000, '90 days by default');
    short = (await ann('POST', '/api/shares', { label: 'Two days', expires: new Date(Date.now() + 2 * 86400000).toISOString() })).body;
  } finally { await stop(srv); }
  /* it now runs out in 5 days; the 2-day link was never meant to last a week, so no reminder for it; one link idle 31 days */
  sql('UPDATE shares SET expires_at = ? WHERE id = ?', new Date(Date.now() + 5 * 86400000).toISOString(), made.id);
  sql("UPDATE shares SET created_at = datetime('now', '-31 days') WHERE id = ?", made.id);
  mails.length = 0;
  srv = await serve(env);
  try {
    const m = await mailTo('ann@example.com', /stops working on/);
    assert.ok(m, out);
    const text = m.data.replace(/=\n/g, '');   /* quoted-printable soft line breaks */
    assert.match(text, /press Renew/);
    assert.ok(!text.includes('/coach/'), 'no link secret in the email');
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(mails.filter(x => /stops working on/.test(x.data)).length, 1, 'one reminder: none for the 2-day link');
    const ann = await client().signIn('ann@example.com');
    let list = (await ann('GET', '/api/shares')).body.shares;
    assert.deepStrictEqual(list.map(x => [x.label, x.idle]).sort(), [['Coach Sam', true], ['Two days', false]]);
    assert.strictEqual((await fetch(made.url + '/api/info')).status, 200);
    /* Renew: a new secret, same name, 90 days; the old link is off at once */
    const key = list.find(x => x.id === made.id).key;
    assert.strictEqual((await ann('POST', `/api/shares/${made.id}/renew`, { key: 'wrong' })).status, 404);
    const r = await ann('POST', `/api/shares/${made.id}/renew`, { key });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.label, 'Coach Sam');
    assert.notStrictEqual(r.body.url, made.url);
    assert.ok(Math.abs(Date.parse(r.body.expires) - Date.now() - 90 * 86400000) < 60000);
    assert.strictEqual((await fetch(made.url + '/api/info')).status, 404, 'the old secret is dead');
    assert.strictEqual((await fetch(r.body.url + '/api/info')).status, 200);
    list = (await ann('GET', '/api/shares')).body.shares;
    assert.deepStrictEqual(list.map(x => x.label).sort(), ['Coach Sam', 'Two days']);
    assert.strictEqual((await ann('POST', `/api/shares/${made.id}/renew`, {})).status, 404, 'renewed once');
    const log = (await ann('GET', '/api/my/log')).body.rows.map(x => x.event);
    assert.ok(log.includes('coach.renewed') && log.includes('coach.reminded'), log.join());
    void short;
  } finally { await stop(srv); }
});

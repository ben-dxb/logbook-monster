'use strict';
/* Final server round: a key or password of unknown age gets one by saving it again; a plain value written by an older version
   after a rollback wins over a stale sealed one; a timed-out AI probe keeps the breaker open; a mail refusal that won't change
   is dropped and a refused sign-in opens the mail breaker for 30 minutes; an invited admin who never signed in isn't "another
   admin"; passwords count characters, are trimmed for the common check and can't hold the email's name without its dots. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const [AI_PORT, SMTP_PORT] = require('./_ports').freePorts(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-finalserver-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 't.db'), SESSION_SECRET: 'x'.repeat(40), OPENROUTER_API_KEY: '',
  OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}`, ADMIN_EMAILS: 'boss@example.com,new@example.com',
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_USER: 'app', SMTP_PASS: '', SMTP_SECURE: 'false', MAIL_FROM: 'app@example.com', SMTP_ALLOW_HOSTS: '127.0.0.1' });

let aiMode = 'ok';
const OK = JSON.stringify({ model: 'fake/model', choices: [{ message: { content: '{"ok": true}' }, finish_reason: 'stop' }] });
const fakeAi = http.createServer((req, res) => { req.resume(); req.on('end', () => { if (aiMode !== 'hang') res.end(OK); }); });

/* a fake SMTP server: smtpMode 'ok', 'auth' (535 to AUTH) or 'rcpt' (550 to RCPT TO) */
let smtpMode = 'ok', auths = 0;
const mails = [], socks = new Set();
const smtp = net.createServer(sock => {
  socks.add(sock); sock.on('close', () => socks.delete(sock)); sock.on('error', () => {});
  let data = null, buf = '';
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', chunk => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data !== null) { if (line === '.') { mails.push(data.join('\n')); data = null; sock.write('250 queued\r\n'); } else data.push(line); continue; }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (cmd === 'AUTH') { auths++; sock.write(smtpMode === 'auth' ? '535 5.7.8 bad credentials\r\n' : '235 ok\r\n'); }
      else if (cmd === 'RCPT') sock.write(smtpMode === 'rcpt' ? '550 5.1.1 no such user\r\n' : '250 ok\r\n');
      else if (cmd === 'DATA') { data = []; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') sock.end('221 bye\r\n');
      else sock.write('250 ok\r\n');
    }
  });
});

const ai = require('../server/ai');
const mail = require('../server/mail');
const creds = require('../server/credentials');
const users = require('../server/users');
const db = require('../server/db');
const { passwordProblem } = require('../server/passwords');
const until = async (fn, ms = 5000) => { for (const t = Date.now(); Date.now() - t < ms;) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };
const row = key => JSON.parse(db.prepare('SELECT data FROM app_config WHERE key = ?').get(key).data);
const putRow = (key, data) => db.prepare('UPDATE app_config SET data = ? WHERE key = ?').run(JSON.stringify(data), key);

test.before(async () => {
  await new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r));
  await new Promise(r => smtp.listen(SMTP_PORT, '127.0.0.1', r));
});
test.after(() => {
  fakeAi.closeAllConnections(); fakeAi.close(); smtp.close(); for (const s of socks) s.destroy();
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('the same OpenRouter key or SMTP password saved again gets an age when it had none; one with an age keeps it', async () => {
  ai.save({ key: 'sk-test-key-aaaa' });
  creds.forget('OPENROUTER');   /* as a key moved over from before the ages were kept */
  ai.save({ key: 'sk-test-key-aaaa' });
  const r = creds.recorded('OPENROUTER');
  assert.ok(r && r.set_at, 'age recorded');
  assert.strictEqual(r.kid, row('openrouter').keyId);
  await new Promise(res => setTimeout(res, 5));
  ai.save({ key: 'sk-test-key-aaaa' });
  assert.strictEqual(creds.recorded('OPENROUTER').set_at, r.set_at, 'saving it once more doesn’t restart a known age');

  await mail.save({ pass: 'smtp-pass-one' });
  creds.forget('SMTP');
  await mail.save({ pass: 'smtp-pass-one' });
  const m = creds.recorded('SMTP');
  assert.ok(m && m.set_at && m.kid === row('email').passId);
  assert.ok(creds.list().find(c => c.name === 'SMTP').set, 'the Keys tab shows its age');
});

test('a plain key or password written by an older version (a rollback) wins over a stale sealed one and is sealed', async () => {
  ai.save({ key: 'sk-test-key-aaaa' });
  const kid = row('openrouter').keyId;
  putRow('openrouter', { ...row('openrouter'), key: 'sk-test-key-bbbb' });   /* keySealed (aaaa) still there */
  assert.strictEqual(ai.status().hint, '…bbbb');
  const a = row('openrouter');
  assert.ok(!a.key && a.keySealed, 'sealed, plain one dropped');
  assert.notStrictEqual(a.keyId, kid, 'a different key gets its own id');
  assert.strictEqual(creds.recorded('OPENROUTER').kid, a.keyId, 'and its age starts');
  assert.strictEqual(ai.status().hint, '…bbbb', 'still the plain one once sealed');

  await mail.save({ pass: 'smtp-pass-one' });
  putRow('email', { ...row('email'), pass: 'smtp-pass-two' });
  assert.strictEqual(mail.current().pass, 'smtp-pass-two');
  const e = row('email');
  assert.ok(!e.pass && e.passSealed);
  assert.strictEqual(mail.current().pass, 'smtp-pass-two');
});

test('a file read that is the half-open probe and times out keeps the breaker open; ordinary file-read timeouts still don’t open it', async () => {
  ai.save({ key: 'sk-test-key-aaaa' });
  ai.breaker.reset('test');
  aiMode = 'hang';
  const pdf = Buffer.from('%PDF-1.4 x');
  for (let i = 0; i < 6; i++) await assert.rejects(ai.ask('s', pdf, 'application/pdf', 'plan', { task: 'plan', timeout: 80 }), e => e.status === 502);
  assert.strictEqual(ai.breaker.state, 'closed');
  ai.breaker.open('fail', 30, 'test');
  await new Promise(r => setTimeout(r, 50));
  await assert.rejects(ai.ask('s', pdf, 'application/pdf', 'plan', { task: 'plan', timeout: 80 }), e => e.status === 502);
  assert.strictEqual(ai.breaker.state, 'open', 'not closed without an answer');
  assert.strictEqual(ai.breaker.wait, ai.LIMITS.openFirst * 2, 'the wait doubles as for any failed probe');
  ai.breaker.reset('test'); aiMode = 'ok';
});

test('a recipient the mail server refuses for good is dropped from the outbox at once', async () => {
  await mail.save({ pass: 'smtp-pass-one' });
  db.exec('DELETE FROM outbox');
  smtpMode = 'rcpt';
  mail.notify({ to: 'gone@example.com', subject: 's', text: 't' });
  assert.ok(await until(() => mail.outbox.rows().length === 0), 'dropped, not kept for a retry');
  assert.strictEqual(mail.breaker.auth, false);
  smtpMode = 'ok';
  mail.notify({ to: 'ann@example.com', subject: 's', text: 't' });
  assert.ok(await until(() => mails.length === 1 && mail.outbox.rows().length === 0), 'a good one still goes');
});

test('a refused username or password opens the mail breaker for 30 minutes, keeping the queue, until the settings are saved', async () => {
  db.exec('DELETE FROM outbox'); mail.breaker.reset();
  for (const s of socks) s.destroy();   /* the pooled connection signed in before */
  await mail.save({ pass: 'smtp-pass-wrong' });
  smtpMode = 'auth'; auths = 0;
  mail.notify({ to: 'ann@example.com', subject: 'one', text: 't' });
  assert.ok(await until(() => mail.breaker.auth));
  assert.ok(Math.abs(mail.breaker.until - Date.now() - 30 * 60000) < 5000, 'left alone 30 minutes');
  mail.notify({ to: 'ann@example.com', subject: 'two', text: 't' });
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(auths, 1, 'not tried again meanwhile');
  assert.strictEqual(mail.outbox.rows().length, 2, 'both kept');
  await assert.rejects(mail.send({ to: 'ann@example.com', subject: 's', text: 't' }), e => e.status === 503 && /username or password/.test(e.message));
  smtpMode = 'ok';
  await mail.save({ pass: 'smtp-pass-two' });
  assert.strictEqual(mail.breaker.auth, false);
  await mail.send({ to: 'ann@example.com', subject: 's', text: 't' });
});

test('an invited super admin who never signed in doesn’t let the last real one delete their account', () => {
  const add = (email, hash) => Number(db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash).lastInsertRowid);
  const boss = { id: add('boss@example.com', 'x'), email: 'boss@example.com' };
  const fresh = add('new@example.com', null);
  const isAdmin = u => ['boss@example.com', 'new@example.com'].includes(u.email);
  assert.throws(() => users.removeOwn(boss, isAdmin), e => e.status === 409 && /only super admin/.test(e.message));
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(fresh);
  assert.deepStrictEqual(users.removeOwn(boss, isAdmin), { ok: true });
});

test('passwords: characters not UTF-16 units, trimmed for the common check, the email’s name found without its dots', () => {
  assert.match(passwordProblem('😀😁😂🤣😃'), /at least 10 characters/);
  assert.strictEqual(passwordProblem('😀😁😂🤣😃😄😅😆😉😊'), null, '10 emoji are 10 characters');
  assert.match(passwordProblem('  1234567890  '), /most used/);
  assert.match(passwordProblem('johnsmith-rocks!', 'john.smith@example.com'), /email/);
  assert.match(passwordProblem('jo.hn_smith-rocks', 'john-smith@example.com'), /email/);
  assert.strictEqual(passwordProblem('quiet harbour lamp', 'john.smith@example.com'), null);
});

test('Keys tab wording: the session secret under the name .env uses, no "Move to", "1 in use", no "Test old" once it tested dead', () => {
  const list = () => creds.list();
  const ss = list().find(c => c.label === 'Session secret');
  assert.strictEqual(ss.name, 'SESSION_SECRET', 'named as the owner’s .env names it');
  assert.doesNotMatch(ss.next, /Move to/);
  assert.match(ss.next, /To rotate:/);
  assert.strictEqual(list().find(c => c.name === 'AUDIT_HASH_KEY').slots, '1 in use');
  ai.saveNext('sk-test-key-next1');
  ai.promote();
  assert.match(list().find(c => c.name === 'OPENROUTER').next, /Test old – it must fail/);
  creds.mark('OPENROUTER', { old_dead_at: new Date().toISOString() });
  const or = list().find(c => c.name === 'OPENROUTER');
  assert.match(or.slots, /old \(until/);
  assert.doesNotMatch(or.next, /Revoke the old one at the provider, then Test old/, 'already tested dead');
  ai.saveNext('sk-test-key-next2');
  ai.promote();
  assert.ok(!creds.recorded('OPENROUTER').old_dead_at, 'a new key: the old one has not been tested yet');
  assert.match(list().find(c => c.name === 'OPENROUTER').next, /Test old – it must fail/);
});

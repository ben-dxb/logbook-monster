'use strict';
/* Phase 8: a slow or dead mail server can't hold a request for minutes, and notifications sent while it's down go out once it
   is back (the outbox). A fake SMTP server that can be down, stall mid-message, or work. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');

const [SMTP_PORT, DEAD_PORT, DNS_PORT] = require('./_ports').freePorts(3);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-outbox-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 'm.db'), SESSION_SECRET: 'x'.repeat(40), SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT),
  SMTP_USER: '', SMTP_PASS: '', SMTP_SECURE: 'false', MAIL_FROM: 'app@example.com', SMTP_ALLOW_HOSTS: '127.0.0.1' });

let stall = false;
const mails = [];
const smtp = net.createServer(sock => {
  let data = null, msg = {}, buf = '';
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', chunk => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data !== null) {
        if (line !== '.') { data.push(line); continue; }
        if (stall) { data = null; continue; }   /* takes the message and never answers */
        msg.data = data.join('\n'); mails.push(msg); msg = {}; data = null; sock.write('250 queued\r\n'); continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') sock.write('250 fake\r\n');
      else if (cmd === 'RCPT') { msg.to = line; sock.write('250 ok\r\n'); }
      else if (cmd === 'DATA') { data = []; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') sock.end('221 bye\r\n');
      else sock.write('250 ok\r\n');
    }
  });
  sock.on('error', () => {});
});
const up = () => new Promise(r => smtp.listen(SMTP_PORT, '127.0.0.1', r));
const down = () => new Promise(r => { smtp.close(r); for (const s of socks) s.destroy(); });
const socks = new Set();
smtp.on('connection', s => { socks.add(s); s.on('close', () => socks.delete(s)); });

const mail = require('../server/mail');
const db = require('../server/db');
const L = { ...mail.LIMITS };
const until = async (fn, ms = 5000) => { for (const t = Date.now(); Date.now() - t < ms;) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };
const setPort = port => { process.env.SMTP_PORT = String(port); };

test.before(up);
test.beforeEach(() => { Object.assign(mail.LIMITS, L); mail.breaker.reset(); stall = false; setPort(SMTP_PORT); db.exec('DELETE FROM outbox'); });
test.after(() => { smtp.close(); for (const s of socks) s.destroy(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a mail server that takes the message and never answers is given up on after 30 s (here 600 ms)', async () => {
  stall = true; mail.LIMITS.send = 600;
  const t = Date.now();
  await assert.rejects(mail.send({ to: 'ann@example.com', subject: 's', text: 't' }), e => e.status === 502 && /couldn’t connect/.test(e.message));
  assert.ok(Date.now() - t < 2000, `${Date.now() - t} ms`);
  stall = false;
  await mail.send({ to: 'ann@example.com', subject: 'after', text: 't' });   /* a fresh connection, not the stuck one */
  assert.ok(mails.some(m => /Subject: after/.test(m.data)));
});

test('3 sends in a row that can’t connect open the SMTP breaker: the next fails at once, a half-open probe closes it', async () => {
  setPort(DEAD_PORT);
  for (let i = 0; i < 3; i++) await assert.rejects(mail.send({ to: 'ann@example.com', subject: 's', text: 't' }), e => e.status === 502);
  const t = Date.now();
  await assert.rejects(mail.send({ to: 'ann@example.com', subject: 's', text: 't' }), e => e.status === 503 && /isn’t answering/.test(e.message));
  assert.ok(Date.now() - t < 50, 'at once');
  assert.ok(mail.breaker.until - Date.now() > 100000, 'for 2 minutes');
  /* the probe after it fails: 4 minutes */
  mail.breaker.until = Date.now() - 1;
  await assert.rejects(mail.send({ to: 'ann@example.com', subject: 's', text: 't' }), e => e.status === 502);
  assert.strictEqual(mail.breaker.wait, 4 * 60000);
  mail.breaker.until = Date.now() - 1;
  setPort(SMTP_PORT);
  await mail.send({ to: 'ann@example.com', subject: 'probe', text: 't' });
  assert.deepStrictEqual([mail.breaker.fails, mail.breaker.until], [0, 0], 'closed again');
});

test('a notification sent while the mail server is down waits in the outbox and goes once it’s back', async () => {
  await down();
  mail.notify({ to: 'bob@example.com', subject: 'Two-step sign-in switched on', text: 'hello' });
  assert.ok(await until(() => mail.outbox.rows()[0] && mail.outbox.rows()[0].tries === 1), 'one try, failed');
  const [row] = mail.outbox.rows();
  assert.ok(Math.abs(row.next_at - Date.now() - 60000) < 2000, 'next try in a minute');
  assert.ok(Math.abs(row.expires_at - Date.now() - 24 * 3600000) < 5000, 'a security notice is kept 24 h');
  await up();
  db.exec('UPDATE outbox SET next_at = 0');   /* the minute has passed */
  mail.outbox.drain();
  assert.ok(await until(() => mails.some(m => m.to.includes('bob@example.com'))), 'sent');
  assert.ok(await until(() => !mail.outbox.rows().length), 'and gone from the outbox');
});

test('job emails are kept 6 h; what is left from before a restart goes out; old ones are dropped', async () => {
  const now = Date.now();
  db.prepare('INSERT INTO outbox (msg, next_at, expires_at) VALUES (?, ?, ?)').run(JSON.stringify({ to: 'cat@example.com', subject: 'left over', text: 't' }), now - 1000, now + 3600000);
  db.prepare('INSERT INTO outbox (msg, next_at, expires_at) VALUES (?, ?, ?)').run(JSON.stringify({ to: 'old@example.com', subject: 'stale', text: 't' }), now - 1000, now - 1);
  mail.outbox.drain();
  assert.ok(await until(() => mails.some(m => m.to.includes('cat@example.com'))));
  assert.ok(!mails.some(m => m.to.includes('old@example.com')), 'an expired one is dropped, not sent');
  await down();
  mail.notify({ to: 'dan@example.com', subject: 'Your meal plan is ready', text: 't' }, { keep: mail.JOB_KEEP });
  assert.ok(await until(() => mail.outbox.rows().some(r => r.tries === 1)));
  assert.ok(Math.abs(mail.outbox.rows()[0].expires_at - Date.now() - 6 * 3600000) < 5000);
  assert.deepStrictEqual(mail.RETRY, [60000, 300000, 900000, 3600000]);
  await up();
});

test('a DNS server that never answers fails the lookup in 5 s, and counts towards the breaker', async () => {
  const silent = dgram.createSocket('udp4');
  await new Promise(r => silent.bind(DNS_PORT, '127.0.0.1', r));
  mail._test.resolver.setServers([`127.0.0.1:${DNS_PORT}`]);
  db.prepare("INSERT INTO app_config (key, data) VALUES ('email', ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(JSON.stringify({ host: 'smtp.nowhere.test' }));
  try {
    const t = Date.now();
    await assert.rejects(mail.send({ to: 'ann@example.com', subject: 's', text: 't' }), e => e.status === 502 && /Couldn’t find that mail server/.test(e.message));
    assert.ok(Date.now() - t < 6500, `${Date.now() - t} ms`);
    assert.strictEqual(mail.breaker.fails, 1);
  } finally { silent.close(); db.exec("DELETE FROM app_config WHERE key = 'email'"); }
});

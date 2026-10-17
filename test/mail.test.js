'use strict';
/* The mail server must be on the internet, and STARTTLS is required unless the connection is implicit TLS or a loopback relay. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-mail-'));
process.env.DB_PATH = path.join(dir, 'm.db');
process.env.SMTP_ALLOW_HOSTS = '';
process.env.SMTP_HOST = '';
const mail = require('../server/mail');
const db = require('../server/db');
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('internal addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '127.9.9.9', '10.1.2.3', '172.17.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', 'not-an-ip']) assert.ok(mail.internal(ip), ip);
  for (const ip of ['142.250.27.108', '172.32.0.1', '8.8.8.8', '2a00:1450:4009:81f::201b']) assert.ok(!mail.internal(ip), ip);
});

test('STARTTLS is required on a plain connection, except to a loopback relay', () => {
  const c = { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p' };
  const o = mail.transportOptions(c, { addr: '93.184.215.14', loopback: false });
  assert.deepStrictEqual([o.host, o.servername, o.requireTLS, o.tls.minVersion], ['93.184.215.14', 'smtp.example.com', true, 'TLSv1.2']);
  assert.strictEqual(mail.transportOptions({ ...c, port: 465, secure: true }, { addr: '93.184.215.14' }).requireTLS, false);
  assert.strictEqual(mail.transportOptions({ ...c, host: '127.0.0.1' }, { addr: '127.0.0.1', loopback: true }).requireTLS, false);
});

test('saving refuses internal hosts, by address or by a name that resolves to one', async () => {
  const user = { email: 'admin@example.com' };
  for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '172.17.0.1', 'localhost']) {
    await assert.rejects(mail.save({ host, from: 'a@example.com' }, user), e => e.status === 400 && /private or internal/.test(e.message), host);
  }
  assert.strictEqual(mail.status().host, '');
});

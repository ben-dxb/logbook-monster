'use strict';
/* The OpenRouter key and the SMTP password are sealed in app_config, ones saved before are sealed on start, deleted rows are
   overwritten and the database file is only the app's own (all-config-015, admin-code-007). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-secrets-'));
process.env.DB_PATH = path.join(dir, 's.db');
process.env.SMTP_ALLOW_HOSTS = '127.0.0.1';
process.env.SMTP_HOST = ''; process.env.SMTP_PASS = ''; process.env.OPENROUTER_API_KEY = '';
const db = require('../server/db');
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const KEY = 'sk-or-v1-plainkey-0123456789abcdef', PASS = 'old smtp password 42';
const raw = k => (db.prepare('SELECT data FROM app_config WHERE key = ?').get(k) || {}).data || '';
/* as an older version left them: in plain text */
db.prepare("INSERT INTO app_config (key, data, updated_by) VALUES ('openrouter', ?, 'adm@example.com')").run(JSON.stringify({ key: KEY, model: 'a/b' }));
db.prepare("INSERT INTO app_config (key, data, updated_by) VALUES ('email', ?, 'adm@example.com')").run(JSON.stringify({ host: '127.0.0.1', from: 'a@example.com', pass: PASS }));
const ai = require('../server/ai');
const mail = require('../server/mail');
const admin = { email: 'adm@example.com' };

test('plain secrets from before are sealed on start and still work', () => {
  assert.ok(!raw('openrouter').includes(KEY) && raw('openrouter').includes('keySealed'), raw('openrouter'));
  assert.ok(!raw('email').includes(PASS) && raw('email').includes('passSealed'), raw('email'));
  assert.strictEqual(ai.status().configured, true);
  assert.strictEqual(ai.status().hint, '…' + KEY.slice(-4));
  assert.strictEqual(JSON.parse(raw('openrouter')).model, 'a/b');
  assert.strictEqual(mail.status().hasPassword, true);
  assert.strictEqual(mail.current().pass, PASS);
});

test('a key or password saved now is stored sealed; clearing it removes it', async () => {
  const k2 = 'sk-or-v1-newkey-zyxwvutsrq9876';
  ai.save({ key: k2 }, admin);
  assert.ok(!raw('openrouter').includes(k2));
  assert.strictEqual(ai.status().hint, '…' + k2.slice(-4));
  ai.save({ model: 'c/d' }, admin);   /* other changes keep it */
  assert.strictEqual(ai.status().hint, '…' + k2.slice(-4));
  await mail.save({ pass: 'new-pass-123' }, admin);
  assert.ok(!raw('email').includes('new-pass-123'));
  assert.strictEqual(mail.current().pass, 'new-pass-123');
  ai.save({ key: '' }, admin);
  await mail.save({ pass: '' }, admin);
  assert.strictEqual(ai.status().configured, false);
  assert.strictEqual(mail.status().hasPassword, false);
  assert.ok(!raw('openrouter').includes('keySealed') && !raw('email').includes('passSealed'));
});

test('secure_delete is on and the database file is readable by its owner only', () => {
  assert.strictEqual(db.prepare('PRAGMA secure_delete').get().secure_delete, 1);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(process.env.DB_PATH).mode & 0o777, 0o600);
});

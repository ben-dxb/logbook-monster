'use strict';
/* PR-PL-054: an AI reply that runs out of time – before or after its headers – is reported as too slow, not as empty, in words
   that fit the task: a file read can be tried with a smaller file, a text task (food fill, summary) just again. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const [AI_PORT] = require('./_ports').freePorts(1);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-aitimeout-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 't.db'), SESSION_SECRET: 'x'.repeat(40), OPENROUTER_API_KEY: 'sk-test-key-1234',
  OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}` });
const fake = http.createServer((req, res) => {
  req.resume();
  if (process.env.STALL === 'headers') return;                                                    /* never answers */
  res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"choices":');            /* starts, never ends */
});
const ai = require('../server/ai');
test.before(() => new Promise(r => fake.listen(AI_PORT, '127.0.0.1', r)));
test.after(() => { fake.closeAllConnections(); fake.close(); require('../server/db').close(); fs.rmSync(dir, { recursive: true, force: true }); });

for (const stall of ['headers', 'body']) {
  test(`a reply that stalls ${stall === 'headers' ? 'before' : 'after'} its headers is "took too long"`, async () => {
    process.env.STALL = stall;
    const t = Date.now();
    await assert.rejects(ai.askText('system', 'text', { task: 'food', timeout: 300 }),
      e => e.status === 502 && e.message === 'The AI took too long – try again in a minute');   /* a text task: no file to make smaller */
    await assert.rejects(ai.ask('system', Buffer.from('%PDF-1.4 plan'), 'application/pdf', 'plan', { task: 'plan', timeout: 300 }),
      e => e.status === 502 && e.message === 'The AI took too long – try again or use a smaller file');
    assert.ok(Date.now() - t < 5000);
  });
}

'use strict';
/* The Google token request gives up after its time limit and refuses an oversized answer (auth-code-010). */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { fetchJson } = require('../server/fetchjson');

const [PORT] = require('./_ports').freePorts(1);
const fake = http.createServer((req, res) => {
  if (req.url === '/stall') return;                                       /* never answers */
  if (req.url === '/drip') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"a":'); return; }   /* starts, never ends */
  if (req.url === '/big') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ x: 'y'.repeat(200000) })); return; }
  if (req.url === '/chunked') { res.writeHead(200); for (let i = 0; i < 100; i++) res.write('x'.repeat(1000)); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id_token":"a.b.c"}');
});
test.before(() => new Promise(r => fake.listen(PORT, '127.0.0.1', r)));
test.after(() => { fake.closeAllConnections(); fake.close(); });
const url = p => `http://127.0.0.1:${PORT}${p}`;

test('a normal answer is read', async () => {
  assert.deepStrictEqual(await fetchJson(url('/ok')), { ok: true, status: 200, body: { id_token: 'a.b.c' } });
});
test('no answer, or an answer that never ends, times out', async () => {
  for (const p of ['/stall', '/drip']) {
    const t = Date.now();
    await assert.rejects(fetchJson(url(p), {}, { timeout: 300 }), /abort|timeout/i, p);
    assert.ok(Date.now() - t < 3000, p);
  }
});
test('an answer over the size cap is refused', async () => {
  await assert.rejects(fetchJson(url('/big'), {}, { max: 64 * 1024 }), /too large/);
  await assert.rejects(fetchJson(url('/chunked'), {}, { max: 64 * 1024 }), /too large/);
});

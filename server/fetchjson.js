'use strict';
/* A JSON request to another server with a time limit (the whole exchange, body included) and a size cap, so a slow or
   misbehaving upstream can't hold a request open for minutes or fill memory. */
async function fetchJson(url, opts = {}, { timeout = 10000, max = 64 * 1024 } = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
  if (+r.headers.get('content-length') > max) { r.body && r.body.cancel().catch(() => {}); throw new Error('answer too large'); }
  const chunks = [];
  let n = 0;
  if (r.body) {
    for await (const c of r.body) {
      n += c.length;
      if (n > max) throw new Error('answer too large');
      chunks.push(c);
    }
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('answer isn’t JSON'); }
  return { ok: r.ok, status: r.status, body };
}
module.exports = { fetchJson };

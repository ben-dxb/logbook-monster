'use strict';
/* Versioned static files. Each script, stylesheet and icon (svg, png, ico) in public/ gets a short hash of its content; the HTML pages
   are served with their references rewritten to /app.js?v=<hash>. A query string rather than a renamed file keeps the
   file server, the CSP ('self') and every old reference working as they are: the name on disk never changes.
   - /app.js?v=<its current hash>: cached for a year, immutable – a new deploy changes the hash, so the page asks for a new URL.
   - /app.js, or ?v= an older hash (a tab opened before a deploy): the current file, revalidated every time (no-cache),
     so it is never kept under a name that doesn't match it.
   - The HTML pages: no-cache with a strong ETag of the rewritten page – the route (sign-in check, redirects) runs on every
     load and answers 304 only after it has.
   In production the hashes are taken once, at start-up (a deploy restarts the server). Elsewhere a page load re-checks each
   file's size and time, so `npm run dev` picks up an edited file without a restart. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IMMUTABLE = 'public, max-age=31536000, immutable';
const ASSET = /\.(js|css|svg|png|ico)$/;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

/* fill: { 'page.html': html => html } – a page's own last step (the privacy page puts in who runs the app) */
function create(dir, { live = false, fill = {} } = {}) {
  let files = new Map();   /* name → { hash, size, mtime } */
  const pages = new Map();   /* name → { html, etag, from } */
  function scan() {
    const next = new Map();
    for (const name of fs.readdirSync(dir)) {
      if (!ASSET.test(name)) continue;
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      const old = files.get(name);
      next.set(name, old && old.size === st.size && old.mtime === st.mtimeMs ? old
        : { hash: sha(fs.readFileSync(path.join(dir, name))).slice(0, 10), size: st.size, mtime: st.mtimeMs });
    }
    const changed = next.size !== files.size || [...next].some(([n, f]) => files.get(n) !== f);
    files = next;
    return changed;
  }
  scan();
  const hashOf = name => (files.get(name) || {}).hash;
  const url = name => (hashOf(name) ? `/${name}?v=${hashOf(name)}` : '/' + name);

  /* the page with every src="/x.js" / href="/x.css" of a file in public/ pointing at its versioned URL */
  function page(name) {
    const stale = live && scan();
    const st = live ? fs.statSync(path.join(dir, name)).mtimeMs : 0;
    let p = pages.get(name);
    if (!p || stale || p.from !== st) {
      let html = fs.readFileSync(path.join(dir, name), 'utf8')
        .replace(/\b(src|href)="\/([A-Za-z0-9._-]+)"/g, (m, attr, file) => (files.has(file) ? `${attr}="${url(file)}"` : m));
      if (fill[name]) html = fill[name](html);
      p = { html, etag: `"${sha(html).slice(0, 27)}"`, from: st };
      pages.set(name, p);
    }
    return p;
  }

  /* before the file server: the Cache-Control a request for a file in public/ gets */
  function headers(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const name = req.path.slice(1), v = req.query.v;
      if (live && typeof v === 'string') scan();
      /* fonts carry their version in the file name (public/fonts/archivo-latin-v5.woff2) – a new font gets a new name */
      res.set('Cache-Control', /^fonts\/[\w.-]+\.woff2$/.test(name) || (typeof v === 'string' && v && v === hashOf(name)) ? IMMUTABLE : 'no-cache');
    }
    next();
  }

  /* send a page (GET/HEAD): Express answers 304 itself when If-None-Match matches the ETag */
  function send(res, name) {
    const p = page(name);
    res.set({ 'Cache-Control': 'no-cache', ETag: p.etag }).type('html').send(p.html);
  }

  return { url, hashOf, page, headers, send, IMMUTABLE };
}

module.exports = { create, IMMUTABLE };

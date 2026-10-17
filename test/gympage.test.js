'use strict';
/* An exercise's sets come a page of whole days at a time (newest first, ~200 sets, a `before` cursor) with Records, the chart and
   the 🏆 marks worked out on the server over every set – the same as the app worked them out from the full list before. And
   npm run backup / restore-check copy a running app's database and photos with Node alone. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [PORT] = require('./_ports').freePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-gympage-'));
const root = path.join(__dirname, '..');
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 't.db'), PHOTO_DIR: '',
  SESSION_SECRET: '', SEAL_KEY: '', AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ADMIN_EMAILS: 'admin@example.com', ALLOW_REGISTRATION: 'false',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '', NODE_ENV: 'development' };
let srv, ann;

before(async () => {
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', 'ann@example.com'],
    { cwd: root, env: { ...env, NEW_PASSWORD: 'long-password-1' }, stdio: 'ignore' });
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  let cookie = '', csrf = '';
  ann = async (method, url, body, raw) => {
    const r = await fetch(BASE + url, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(raw ? { 'content-type': 'image/jpeg' } : body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf },
      body: raw || (body ? JSON.stringify(body) : undefined) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (j && j.csrf) csrf = j.csrf;
    return { status: r.status, body: j, bytes: Buffer.byteLength(text) };
  };
  await ann('GET', '/auth/config');
  assert.strictEqual((await ann('POST', '/auth/login', { email: 'ann@example.com', password: 'long-password-1' })).status, 200);
  await ann('GET', '/api/me');
});
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

/* What public/gym.js worked out from every set before paging (gAnalyse, gRecords, gChart), kept here to compare with. */
const e1rm = s => (s.kg > 0 && s.reps >= 1 && s.reps <= 20 ? (s.reps === 1 ? s.kg : s.kg * (1 + s.reps / 30)) : 0);
const gScore = s => (s.kg > 0 ? (e1rm(s) || null) : s.reps >= 1 && s.reps <= 20 ? s.kg / (1 + s.reps / 30) : null);
function oldWay(sets) {
  const days = new Map(), pr = new Set(), volPr = new Set(); let best = null, bestVol = -1;
  sets.forEach(s => { const d = s.at.slice(0, 10); if (!days.has(d)) days.set(d, []); days.get(d).push(s);
    const v = gScore(s); if (v != null) { if (best != null && v > best + 1e-9) pr.add(s.id); best = best == null ? v : Math.max(best, v); } });
  for (const [d, ss] of days) { const v = ss.reduce((a, s) => a + s.reps * s.kg, 0); if (bestVol >= 0 && v > bestVol + 1e-9) volPr.add(d); bestVol = Math.max(bestVol, v); }
  const max = (f, l = sets) => l.reduce((b, s) => (f(s) > f(b) ? s : b), l[0]);
  const heavy = sets.filter(s => s.kg > 0);
  let bd = null, bdv = 0; for (const [d, ss] of days) { const v = ss.reduce((a, s) => a + (s.kg > 0 ? s.reps * s.kg : 0), 0); if (v > bdv) { bdv = v; bd = d; } }
  const reps = []; for (let r = 1; r <= 15; r++) { const ok = sets.filter(s => s.reps >= r); if (ok.length) reps.push([r, ok.reduce((b, s) => (s.kg > b.kg ? s : b), ok[0])]); }
  const slim = s => s && { reps: s.reps, kg: s.kg, at: s.at };
  const chart = [...days].map(([d, ss]) => ({ d, e: Math.round(Math.max(0, ...ss.map(e1rm)) * 100) / 100, k: Math.max(...ss.map(s => s.kg)) }));
  return { pr: [...pr].sort((a, b) => a - b), volPr: [...volPr], n: sets.length, nd: days.size, chart,
    records: { b1: slim(max(e1rm)), bk: slim(max(s => s.kg * 10000 + s.reps)), br: slim(max(s => s.reps * 10000 + s.kg)),
      bv: heavy.length ? slim(max(s => s.reps * s.kg, heavy)) : null, bd, bdv, reps: reps.map(([r, s]) => [r, slim(s)]) } };
}

test('2,000 sets of one exercise: pages of whole days, newest first, every set once; Records, chart and 🏆 as before', async t => {
  /* 400 days × 5 sets, with notes; some assisted, some bodyweight and some over 20 reps to exercise every rule */
  const sets = [], start = Date.parse('2025-01-01T00:00:00Z');
  for (let d = 0; d < 400; d++) {
    const day = new Date(start + d * 86400000).toISOString().slice(0, 10);
    for (let i = 0; i < 5; i++) {
      const kg = d % 37 === 0 ? -20 + (d % 7) : d % 41 === 0 ? 0 : 40 + ((d * 7 + i * 3) % 60) + (d % 5) / 2;
      sets.push({ name: 'Paged press', reps: d % 53 === 0 ? 25 : 1 + ((d + i * 4) % 15), kg, note: `set ${i + 1} felt fine, slept ${6 + (d % 3)} h`, at: `${day}T10:0${i}:00` });
    }
  }
  assert.deepStrictEqual((await ann('POST', '/api/gym/import-sets', { sets })).body, { added: 2000, skipped: 0, newExercises: 1 });
  const ex = (await ann('GET', '/api/gym')).body.exercises.find(e => e.name === 'Paged press').id;

  const pages = [];
  let r = await ann('GET', '/api/gym/sets?exercise=' + ex);
  assert.strictEqual(r.status, 200);
  const first = r;
  pages.push(r.body);
  while (r.body.more) {
    assert.match(r.body.before, /^\d{4}-\d\d-\d\d$/);
    r = await ann('GET', `/api/gym/sets?exercise=${ex}&before=${r.body.before}`);
    assert.strictEqual(r.status, 200);
    assert.ok(!('stats' in r.body), 'the stats come with the first page only');
    pages.push(r.body);
  }
  assert.strictEqual(r.body.before, null);
  const got = pages.flatMap(p => p.sets);
  assert.strictEqual(got.length, 2000);
  assert.strictEqual(new Set(got.map(s => s.id)).size, 2000, 'no set twice');
  for (let i = 1; i < got.length; i++) assert.ok(got[i - 1].at > got[i].at || (got[i - 1].at === got[i].at && got[i - 1].id > got[i].id), 'newest first');
  for (const p of pages.slice(0, -1)) assert.ok(p.sets.length >= 200 && p.sets.length < 205, `a page of ~200 sets (${p.sets.length})`);
  for (let i = 1; i < pages.length; i++) assert.ok(pages[i - 1].sets.at(-1).at.slice(0, 10) > pages[i].sets[0].at.slice(0, 10), 'a day is never split over two pages');
  assert.strictEqual(got[0].note, 'set 5 felt fine, slept 6 h', 'notes still come with the sets');

  const all = got.slice().reverse(), want = oldWay(all), S = pages[0].stats;
  assert.deepStrictEqual(S.pr.slice().sort((a, b) => a - b), want.pr, '🏆 on the same sets');
  assert.deepStrictEqual(S.days.filter(p => p.vp).map(p => p.d), want.volPr, '🏆 Volume on the same days');
  assert.deepStrictEqual(S.days.map(({ d, e, k }) => ({ d, e, k })), want.chart, 'chart points');
  assert.deepStrictEqual([S.n, S.nd, S.assisted], [2000, 400, true]);
  assert.deepStrictEqual(S.records, want.records, 'Records');
  const { pr, ...rest } = S;
  assert.deepStrictEqual(Object.keys(rest).sort(), ['assisted', 'days', 'n', 'nd', 'records']);

  /* after a set is logged, edited or deleted the app reads the stats alone (&stats=1), not the pages: they match the change */
  const st = async () => { const r = await ann('GET', `/api/gym/sets?exercise=${ex}&stats=1`); assert.deepStrictEqual(Object.keys(r.body), ['stats']); return r.body.stats; };
  assert.deepStrictEqual(await st(), S);
  const big = (await ann('POST', '/api/gym/sets', { exercise: ex, reps: 3, kg: 200, note: '', at: '2026-02-10T10:00:00' })).body;
  let T = await st();
  assert.deepStrictEqual([T.n, T.pr.includes(big.id), T.records.b1.kg], [2001, true, 200]);
  const later = (await ann('POST', '/api/gym/sets', { exercise: ex, reps: 3, kg: 199, note: '', at: '2026-02-11T10:00:00' })).body;
  assert.ok(!(await st()).pr.includes(later.id), 'not a 🏆 after a heavier set');
  assert.strictEqual((await ann('PUT', `/api/gym/sets/${big.id}`, { exercise: ex, reps: 3, kg: 60, note: '', at: big.at }, )).status, 200);
  T = await st();
  assert.deepStrictEqual([T.pr.includes(big.id), T.pr.includes(later.id), T.records.b1.kg], [false, true, 199], 'an edit moves the 🏆 to the next best set');
  await ann('DELETE', `/api/gym/sets/${big.id}`); await ann('DELETE', `/api/gym/sets/${later.id}`);
  assert.deepStrictEqual(await st(), S, 'back as it was');

  /* a bad cursor is refused; another account sees none of it */
  assert.strictEqual((await ann('GET', `/api/gym/sets?exercise=${ex}&before=soon`)).status, 400);
  const old = Buffer.byteLength(JSON.stringify(all.map(({ pr, ...s }) => s)));
  t.diagnostic(`GET /api/gym/sets?exercise= with 2,000 sets: ${old} bytes before (every set) → ${first.bytes} bytes first page (${got.length / pages.length | 0} sets a page, ${pages.length} pages)`);
  assert.ok(first.bytes < old / 3, `${first.bytes} vs ${old}`);
});

test('npm run backup copies the database and photos of a running app; restore-check finds every file', async () => {
  const jpeg = s => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('smoke-jpeg-' + s), Buffer.from([0xff, 0xd9])]);
  const p = (await ann('POST', '/api/photos?date=2026-10-10&pose=front', null, jpeg('backup'))).body;
  assert.strictEqual((await ann('PUT', `/api/photos/${p.id}/thumb`, null, jpeg('backup-thumb'))).status, 200);
  assert.strictEqual((await ann('PUT', `/api/photos/${p.id}/mid`, null, jpeg('backup-mid'))).status, 200);
  const out = path.join(dir, 'backups');
  const run = (script, arg) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', `scripts/${script}.js`, arg], { cwd: root, env, encoding: 'utf8' });
  const said = run('backup', out);
  const [made] = fs.readdirSync(out);
  assert.match(made, /^logbook-monster-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d$/);
  const b = path.join(out, made);
  assert.deepStrictEqual(fs.readdirSync(b).sort(), ['.session-secret', 'photos', 't.db']);
  assert.match(said, /photos\s+3 files/);
  assert.match(said, /\.session-secret was copied/);
  if (process.platform !== 'win32') {
    const mode = f => fs.statSync(f).mode & 0o777;
    assert.deepStrictEqual([mode(b), mode(path.join(b, 'photos')), mode(path.join(b, 't.db')), mode(path.join(b, '.session-secret'))], [0o700, 0o700, 0o600, 0o600]);
    for (const f of fs.readdirSync(path.join(b, 'photos'))) assert.strictEqual(mode(path.join(b, 'photos', f)), 0o600);
  }
  const copy = new DatabaseSync(path.join(b, 't.db'), { readOnly: true });
  assert.strictEqual(copy.prepare('SELECT COUNT(*) AS n FROM sets').get().n, 2000);
  copy.close();
  const checked = run('restore-check', out);                        /* the folder the backups are in: checks the newest */
  assert.match(checked, /check: ok/);
  assert.match(checked, /photos\s+1 rows, 3 files .*: 0 missing, 0 with no row/);   /* the middle size counts as the photo's */

  /* a middle size gone by the time the photos are copied (replaced meanwhile): the copy drops it – the full file is served – rather
     than list a file it hasn't got */
  const live = new DatabaseSync(path.join(dir, 't.db'), { readOnly: true });
  const liveMid = live.prepare('SELECT mid FROM photos WHERE id = ?').get(p.id).mid;
  live.close();
  fs.renameSync(path.join(dir, 'photos', liveMid), path.join(dir, 'mid.keep'));
  await new Promise(r => setTimeout(r, 1100));                       /* a new folder name (to the second) */
  run('backup', out);
  const newest = path.join(out, fs.readdirSync(out).sort().at(-1));
  const c2 = new DatabaseSync(path.join(newest, 't.db'), { readOnly: true });
  assert.deepStrictEqual({ ...c2.prepare('SELECT mid, mid_size FROM photos WHERE id = ?').get(p.id) }, { mid: null, mid_size: 0 });
  c2.close();
  assert.match(run('restore-check', newest), /photos\s+1 rows, 2 files .*: 0 missing, 0 with no row/);
  fs.renameSync(path.join(dir, 'mid.keep'), path.join(dir, 'photos', liveMid));
  assert.strictEqual((await ann('GET', `/api/photos/${p.id}/mid`)).status, 200);

  /* a photo file gone from the copy (as when it is deleted while the backup runs): restore-check says so and fails */
  fs.unlinkSync(path.join(b, 'photos', fs.readdirSync(path.join(b, 'photos'))[0]));
  assert.throws(() => run('restore-check', b), e => e.status === 1 && /1 missing/.test(e.stdout));
});

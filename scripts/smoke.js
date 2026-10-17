'use strict';
/* Browser smoke test: starts a throwaway server, signs in, weighs a meal-prep pack, edits and saves a day, logs a weight,
   opens History and Weight, logs gym sets, adds a shared food to the library, filters it by food group and adds one to a day, logs supplements, uploads, filters and compares progress photos, charts trends and opens day cards on the Timeline, checks that pages load only versioned scripts and styles and that the Dashboard and Timeline keep what they read until a write, shares a read-only coach link and opens it signed out, sets up two-step sign-in and signs in with a code and a recovery code, confirms a sensitive admin change on an old sign-in, uploads a plan and adds a day template on Account admin, sets up AI models and invites someone on the Super admin tabs, builds a plan from nothing as the new account, switches a day to another template, edits one day in two tabs, at desktop and phone widths. Fails on any page error.
   Needs Playwright and its Chromium (README, Run it locally); without them it fails, so `npm run check` never passes untested. */
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch {
  try { ({ chromium } = require(path.join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright'))); } catch {}
}
const HOWTO = `
  Install it once, then run npm run check again (Windows: in PowerShell or cmd, the same commands):
    npm install -g playwright
    playwright install chromium
  To run only the API tests meanwhile: npm test`;
const noBrowser = why => {
  console.error(`\n**************************************************************\n  smoke FAILED: the browser test could not run – ${why}.${HOWTO}\n**************************************************************\n`);
  process.exit(1);
};
if (!chromium) noBrowser('Playwright is not installed');

const [PORT, AI_PORT] = require('../test/_ports').freePorts(2), BASE = `http://127.0.0.1:${PORT}`;
/* Stands in for OpenRouter where a read isn't faked in the browser (the workout plan read, end to end through the background job) */
const fakeAi = require('node:http').createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const program = { workouts: [{ name: 'Smoke AI upper', description: '', exercises: [{ name: 'Smoke AI press', target: '3 × 8' }] }], notes: [] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/model', choices: [{ message: { content: JSON.stringify(program) } }] }));
  });
}).listen(AI_PORT, '127.0.0.1');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-smoke-'));
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 's.db'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ALLOW_REGISTRATION: 'false', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '', OPENROUTER_BASE_URL: `http://127.0.0.1:${AI_PORT}` };
const node = [process.execPath, '--disable-warning=ExperimentalWarning'];
const root = path.join(__dirname, '..');
/* future days nobody has saved, inside the dates the app stores (up to a year ahead): two Mondays a week apart, and the
   Thursday between them for a plan change */
const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monAt = new Date(); monAt.setDate(monAt.getDate() + 60); monAt.setDate(monAt.getDate() + (8 - monAt.getDay()) % 7);
const later = n => { const d = new Date(monAt); d.setDate(d.getDate() + n); return localDay(d); };
const MON = later(0), FROM = later(3), MON2 = later(7);

execSync(`"${node[0]}" ${node[1]} scripts/create-user.js smoke@example.com`, { cwd: root, env: { ...env, NEW_PASSWORD: 'smoke-password-1' }, stdio: 'ignore' });
for (const w of [1100, 390]) execSync(`"${node[0]}" ${node[1]} scripts/create-user.js smoke2fa${w}@example.com`, { cwd: root, env: { ...env, NEW_PASSWORD: 'smoke-password-1' }, stdio: 'ignore' });
const srv = spawn(node[0], [node[1], 'server/index.js'], { cwd: root, env, stdio: 'ignore' });

const fail = msg => { console.error('smoke FAILED:', msg); cleanup(); process.exit(1); };
function cleanup() { srv.kill(); fakeAi.close(); fs.rmSync(dir, { recursive: true, force: true }); }
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const signIn = async p => { await p.fill('#email', 'smoke@example.com'); await p.fill('#password', 'smoke-password-1'); await p.click('#submit'); };
/* the photo list as the Dashboard asks for it (?latest=1…) or as the photos page does – not a photo's own file or thumb */
const PHOTO_LIST = /\/api\/photos(\?[^/]*)?$/;
const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (await fn()) return true; return !!(await fn()); };

/* The app shell: each page has its own title and moves focus to its heading, an unknown #page says so, the skip link and the
   account menu work from the keyboard, several AI-read notes fold into one bar that the page keeps room for, nothing sticks
   on a very short screen (400 % zoom), and a start-up without a connection says so with a Retry button. */
async function appShell(browser, pg, w, h) {
  const active = () => pg.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className));
  await pg.click('a[data-view=gym]'); await pg.waitForSelector('#v-gym:not([hidden])');
  expect(await pg.title() === 'Gym – Logbook Monster', 'the Gym title: ' + await pg.title());
  expect(await active() === 'vh' && await pg.textContent('#vh') === 'Gym', 'focus should move to the Gym heading, not ' + await active());
  await pg.evaluate(() => { location.hash = '#day/' + addDays(todayStr(), -1); }); await pg.waitForSelector('#v-day:not([hidden])');
  expect(await pg.title() === `Daily Tracker – ${await pg.evaluate(() => fmtLong(addDays(todayStr(), -1)))} – Logbook Monster`, 'the Daily Tracker title names the day: ' + await pg.title());
  await pg.click('#v-day [data-act=next]');   /* another day on the same page: focus stays on the button you pressed */
  await pg.waitForFunction(() => document.title.includes(fmtLong(todayStr())));
  expect(await pg.evaluate(() => document.activeElement.dataset.act) === 'next', 'next day should keep focus on its button');
  for (const [hsh, t] of [['dash', 'Dashboard'], ['history', 'History'], ['history/timeline', 'Timeline'], ['foods', 'Food Library'], ['supps', 'Supplements'],
    ['photos', 'Progress photos'], ['account', 'Account admin'], ['admin/people', 'Super admin – People'], ['admin/log', 'Super admin – Security log']]) {
    await pg.evaluate(x => { location.hash = '#' + x; }, hsh);
    await pg.waitForFunction(t => document.title === t + ' – Logbook Monster' && document.activeElement.id === 'vh', t, { timeout: 5000 })
      .catch(() => { throw new Error(`#${hsh}: title should be “${t} – Logbook Monster” with focus on its heading`); });
  }
  await pg.evaluate(() => { location.hash = '#nowhere'; }); await pg.waitForSelector('#v-none:not([hidden])');
  expect(/There’s no page like that/.test(await pg.textContent('#none-h')) && await pg.isHidden('#v-day'), 'an unknown page should say so');
  expect(await pg.title() === 'Page not found – Logbook Monster', 'its title');
  await pg.click('#v-none a.btn'); await pg.waitForSelector('#v-dash:not([hidden])');
  /* skip link: first in the tab order, shown when focused, takes you to <main> without touching the address */
  await pg.evaluate(() => document.activeElement.blur()); await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); });
  await pg.keyboard.press('Tab');
  expect(await active() === 'skip' && (await pg.locator('.skip').boundingBox()).y >= 0, 'the skip link should be first and visible when focused');
  await pg.keyboard.press('Enter');
  expect(await active() === 'main' && await pg.evaluate(() => location.hash) === '#dash', 'skip link should focus <main> and keep the address');
  /* account menu: Escape closes it, back on its button; tabbing out of it closes it */
  expect(/^Account menu – smoke@example\.com$/.test(await pg.getAttribute('#acct>summary', 'aria-label')), 'account menu label');
  await pg.click('#acct>summary'); expect(await pg.evaluate(() => $('#acct').open), 'account menu opens');
  await pg.focus('#accountlink'); await pg.keyboard.press('Escape');
  expect(await pg.evaluate(() => !$('#acct').open && document.activeElement === $('#acct>summary')), 'Escape should close the account menu');
  await pg.click('#acct>summary'); await pg.focus('#logout'); await pg.keyboard.press('Tab');
  expect(await pg.evaluate(() => !$('#acct').open), 'tabbing past Sign out should close the account menu');
  /* three AI-read notes: one compact bar with a count, its list folded away, big enough buttons, room kept for it */
  await pg.evaluate(() => { JOBS = [{ id: 9001, kind: 'plan', status: 'done', label: 'a.pdf' }, { id: 9002, kind: 'workout', status: 'running' }, { id: 9003, kind: 'supps', status: 'error', error: 'x' }]; jRender(); });
  const bar = await pg.evaluate(() => { const b = $('#jobs').getBoundingClientRect(), t = $('#jobs [data-job=more]').getBoundingClientRect(), x = $('#jobs [data-job=dropall]').getBoundingClientRect();
    return { h: b.height, t: [t.width, t.height], x: [x.width, x.height], room: parseFloat(getComputedStyle(document.body).paddingBottom), folded: $('#jlist').hidden, text: $('.jhead').textContent }; });
  expect(bar.h <= 64 && bar.folded && /3 AI reads: 1 ready, 1 running, 1 failed/.test(bar.text), 'the jobs bar should be one compact line: ' + JSON.stringify(bar));
  expect(bar.t.concat(bar.x).every(n => n >= 24), 'jobs bar buttons at least 24 × 24: ' + JSON.stringify(bar));
  expect(bar.room >= bar.h, 'the page keeps room below for the jobs bar');
  await pg.click('#jobs [data-job=more]');
  expect(await pg.evaluate(() => !$('#jlist').hidden && $('#jobs [data-job=more]').getAttribute('aria-expanded') === 'true'), 'Show opens the list');
  expect(await pg.locator('#jobs .job').count() === 3, 'all three in the list');
  await pg.evaluate(() => { JOBS = []; jRender(); });
  expect(await pg.evaluate(() => $('#jobs').hidden && !document.body.classList.contains('hasjobs')), 'no bar, no room kept');
  /* 400 % zoom (a viewport 200 px tall): the Daily Tracker summary and Account admin's bar don't stick */
  await pg.setViewportSize({ width: Math.round(w / 4), height: 200 });
  await pg.evaluate(() => { location.hash = '#day'; }); await pg.waitForSelector('#v-day:not([hidden]) .sticky');
  expect(await pg.evaluate(() => getComputedStyle($('#v-day .sticky')).position) === 'static', 'nothing sticks at 400% zoom');
  await pg.setViewportSize({ width: w, height: h });
  /* start-up offline: the alert says so, with Retry */
  const octx = await browser.newContext({ viewport: { width: w, height: h }, storageState: await pg.context().storageState() });
  const op = await octx.newPage(); const oerrs = []; op.on('pageerror', e => oerrs.push(e.message));
  await op.route('**/api/me', r => r.abort('internetdisconnected'));
  await op.goto(BASE + '/'); await op.waitForSelector('#bootnote:not([hidden])', { timeout: 5000 });
  expect(/You seem to be offline – your changes aren’t lost/.test(await op.textContent('#bootmsg')) && await op.isVisible('#bootretry') && await op.isHidden('#loading'), 'offline start-up note with Retry');
  await op.unroute('**/api/me'); await op.click('#bootretry'); await op.waitForSelector('#v-dash:not([hidden])', { timeout: 5000 });
  expect(await op.isHidden('#bootnote') && !oerrs.length, 'Retry loads the app: ' + oerrs.join('; '));
  await octx.close();
}

/* Logged food is never lost: Timeline controls and the protein buttons on Account admin leave an unloaded day alone, changes kept
   from a sign-out are saved wherever you sign in (but never over a newer copy, nor into another account), and a tab left open
   past midnight uses the new date. */
async function trackerKeepsFood(browser, pg, ctx) {
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  const server = d => pg.evaluate(async d => { const r = await fetch('/api/days/' + d); return r.ok ? (await r.json()).data : null; }, d);
  const offOf = async d => ((await server(d)) || { off: [] }).off.map(o => o.n).join();
  const today = await pg.evaluate(async () => { const d = todayStr(), D = (await api('GET', '/api/days/' + d)).data;   /* today as saved so far */
    D.off.push({ n: 'Smoke shortbread', k: 100, p: 1, c: 12, f: 5 });
    await api('PUT', '/api/days/' + d, { data: D, summary: { k: 0, p: 0, c: 0, f: 0, targets: D.targets } }); return d; });
  /* the Timeline's own controls (ids t-…) are not the Daily Tracker's target boxes */
  await pg.goto(BASE + '/#history/timeline'); await pg.reload(); await pg.waitForSelector('#v-timeline:not([hidden]) #t-smooth');
  await pg.click('#t-smooth'); await pg.click('#t-smooth');
  await pg.evaluate(() => { const el = document.querySelector('#t-date'); el.value = addDays(todayStr(), -3); el.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(await pg.evaluate(d => !S.days[d], today), 'Timeline controls should not touch the Daily Tracker day');
  /* the protein buttons on Account admin don't rebuild today from the plan before it has loaded */
  await pg.evaluate(() => { location.hash = '#account'; }); await pg.waitForSelector('#v-admin.mine:not([hidden]) #ad-pbasis');
  await pg.click('#ad-pbasis [data-v=direct]');
  expect(await until(() => pg.evaluate(() => !pending.size && !inFlight && S.pBasis === 'direct')), 'protein basis should save from Account admin');
  expect(await pg.evaluate(d => !S.days[d], today), 'the protein buttons should not build an unloaded day');
  await pg.evaluate(() => { location.hash = '#day'; });
  await pg.waitForFunction(() => /Smoke shortbread/.test(document.querySelector('#offlist').textContent), null, { timeout: 5000 });
  await pg.click('#v-day [data-act=pbasis][data-v=total]');
  await pg.waitForFunction(() => /Saved/.test(document.querySelector('#status').textContent) && !pending.size, null, { timeout: 5000 });
  const td = await server(today);
  expect(td.off.some(o => o.n === 'Smoke shortbread') && !('smooth' in td.targets) && !('date' in td.targets), 'logged food should survive the Timeline and Account admin');
  /* signed out with a change waiting, then signed in from a freshly opened /login: it is saved, and the stash goes */
  const [d3, d4, d6] = await pg.evaluate(() => [40, 47, 54].map(n => addDays(todayStr(), n)));   /* days nobody has saved */
  await pg.goto(BASE + '/#day/' + d3); await pg.waitForFunction(d => document.querySelector('#datepick').value === d && document.querySelector('#meals .meal'), d3);
  await ctx.clearCookies();
  await pg.selectOption('#sn', 'reese'); await pg.click('#snackform button'); await pg.waitForURL(/\/login/, { timeout: 5000 });
  await pg.goto(BASE + '/login'); await signIn(pg); await pg.waitForSelector('#v-dash:not([hidden])');
  expect(await until(async () => /Reese/.test(await offOf(d3))), 'a change stashed at sign-out should be saved after signing in from /login');
  expect(await until(() => pg.evaluate(() => localStorage.getItem('logbook-monster-unsaved:' + UID) === null)), 'the stash should go once it is saved');
  /* … but not over a copy changed on another device since */
  await pg.goto(BASE + '/#day/' + d4); await pg.waitForFunction(d => document.querySelector('#datepick').value === d && document.querySelector('#meals .meal'), d4);
  await pg.selectOption('#sn', 'reese'); await pg.click('#snackform button');
  await pg.waitForFunction(() => /Saved/.test(document.querySelector('#status').textContent) && !pending.size, null, { timeout: 5000 });
  await ctx.clearCookies();
  await pg.selectOption('#sn', 'skittles'); await pg.click('#snackform button'); await pg.waitForURL(/\/login/, { timeout: 5000 });
  const c2 = await browser.newContext(), p2 = await c2.newPage();
  await p2.goto(BASE + '/login'); await signIn(p2); await p2.waitForSelector('#v-dash:not([hidden])');
  await p2.evaluate(async d => { const r = await api('GET', '/api/days/' + d); r.data.off.push({ n: 'Phone yoghurt', k: 100, p: 10, c: 5, f: 2 });
    await api('PUT', '/api/days/' + d, { data: r.data, summary: { k: 0, p: 0, c: 0, f: 0, targets: r.data.targets } }); }, d4);
  await c2.close();
  let said = ''; pg.once('dialog', dl => { said = dl.message(); dl.accept(); });
  await signIn(pg); await pg.waitForSelector('#v-day:not([hidden]) #meals .meal');
  expect(await until(() => said), 'signing in should say a stashed change was not put back');
  await pg.waitForTimeout(800);
  const off4 = await offOf(d4);
  expect(/Phone yoghurt/.test(off4) && !/Skittles/.test(off4) && /Phone yoghurt/.test(await pg.textContent('#offlist')), 'a stash should not overwrite a newer copy: ' + off4);
  /* a broken stash doesn't stop the app; another account's is never applied (kept for it), an expired one goes */
  const other = JSON.stringify({ at: Date.now(), jobs: [[d6, JSON.stringify({ meals: [], off: [{ n: 'Other person snack', k: 1, p: 0, c: 0, f: 0 }] })]] });
  await pg.evaluate(o => { localStorage.setItem('logbook-monster-unsaved:' + UID, JSON.stringify({ at: Date.now(), jobs: [['2026-10-17', '{}'], 'x'] }));
    localStorage.setItem('logbook-monster-unsaved:' + (UID + 1000), o); localStorage.setItem('logbook-monster-unsaved:' + (UID + 1001), JSON.stringify({ at: 1, jobs: [] })); }, other);
  await pg.reload(); await pg.waitForSelector('#v-day:not([hidden]) #meals .meal');
  expect(await server(d6) === null, 'another account’s stash must not be applied');
  expect(await pg.evaluate(o => localStorage.getItem('logbook-monster-unsaved:' + (UID + 1000)) === o && localStorage.getItem('logbook-monster-unsaved:' + (UID + 1001)) === null
    && localStorage.getItem('logbook-monster-unsaved:' + UID) === null, other), 'another account’s stash should be kept, an expired or broken one dropped');
  await pg.evaluate(() => localStorage.removeItem('logbook-monster-unsaved:' + (UID + 1000)));
  /* a tab left open past midnight: the Timeline's Today, a plan change and the Daily Tracker use the new date */
  const c3 = await browser.newContext({ viewport: { width: 1100, height: 900 } }), p3 = await c3.newPage();
  p3.on('pageerror', e => errs.push(e.message)); p3.on('dialog', d => d.accept());
  const eve = new Date(); eve.setDate(eve.getDate() + 30); eve.setHours(23, 58, 0, 0);
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day1 = ymd(eve), day2 = ymd(new Date(eve.getFullYear(), eve.getMonth(), eve.getDate() + 1));
  await p3.clock.install({ time: eve });
  await p3.goto(BASE + '/login'); await signIn(p3); await p3.waitForSelector('#v-dash:not([hidden])');
  await p3.evaluate(() => { location.hash = '#account'; }); await p3.waitForSelector('#v-admin.mine:not([hidden]) #ad-meals .admeal');
  await p3.evaluate(() => { location.hash = '#history/timeline'; }); await p3.waitForSelector('#v-timeline:not([hidden]) #t-pick');
  await p3.clock.fastForward('05:00');
  await p3.click('#t-pick [data-ta=go] >> nth=0');
  expect(await until(() => p3.evaluate(d => location.hash === '#history/timeline/' + d, day2)), 'the Timeline’s Today should be the new day');
  await p3.keyboard.press('Escape');
  await p3.evaluate(() => { location.hash = '#account'; }); await p3.waitForSelector('#v-admin.mine:not([hidden]) #ad-meals .admeal');
  const froms = await p3.evaluate(async ds => { await adSave(); const f = DEFS.myVersions.map(v => v.from);
    for (const d of ds) if (f.includes(d)) await api('DELETE', '/api/my/defaults/' + d); return f; }, [day1, day2]);
  expect(froms.includes(day2) && !froms.includes(day1), 'a plan change saved after midnight should start on the new day: ' + froms);
  await p3.evaluate(() => { location.hash = '#dash'; }); await p3.waitForSelector('#v-dash:not([hidden])');
  await p3.evaluate(() => { location.hash = '#day'; });
  await p3.waitForFunction(d => document.querySelector('#datepick').value === d && document.querySelector('#dtitle').textContent === 'Today', day2, { timeout: 5000 });
  await c3.close();
  expect(errs.length === 0, 'page errors: ' + errs.join(' | '));
}

/* Two tabs on the same day: the second tab's change, made on the copy it loaded before the first tab saved, isn't saved over
   the first tab's – it says the day changed elsewhere and keeps the change on screen until a reload. */
async function twoTabsOneDay(ctx) {
  const errs = [], A = await ctx.newPage(), B = await ctx.newPage();
  for (const p of [A, B]) p.on('pageerror', e => errs.push(e.message));
  const open = async (p, d) => { await p.goto(BASE + '/#day/' + d); await p.waitForFunction(d => document.querySelector('#datepick').value === d && document.querySelector('#meals .meal'), d); };
  const saved = p => p.waitForFunction(() => /Saved/.test(document.querySelector('#status').textContent) && !pending.size && !inFlight, null, { timeout: 5000 });
  const d = localDay(new Date(Date.now() + 61 * 864e5));                    /* a day nobody has saved */
  await open(A, d); await A.click('[data-act=savenow]'); await saved(A);
  await open(B, d);                                                         /* B has the copy A saved */
  await A.selectOption('#sn', 'skittles'); await A.click('#snackform button'); await saved(A);
  await B.selectOption('#sn', 'reese'); await B.click('#snackform button');
  await B.waitForFunction(() => /changed in another tab or device/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
  expect(/Reese/.test(await B.textContent('#offlist')), 'the stale tab should keep its change on screen');
  const off = await B.evaluate(async d => (await (await fetch('/api/days/' + d)).json()).data.off.map(o => o.n).join(), d);
  expect(/Skittles/.test(off) && !/Reese/.test(off), 'the stale tab must not save over the newer day: ' + off);
  await B.click('#status [data-act=reload]'); await B.waitForSelector('#v-day:not([hidden]) #meals .meal');
  await B.waitForFunction(() => /Skittles/.test(document.querySelector('#offlist').textContent) && /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
  await A.evaluate(async d => api('DELETE', '/api/days/' + d), d);
  await A.close(); await B.close();
  expect(errs.length === 0, 'page errors: ' + errs.join(' | '));
}

/* Two-step sign-in from the account menu: the key and otpauth link, one code to turn it on, ten recovery codes; then a
   sign-in asks for a code after the password, and a recovery code works too. */
async function twoStep(browser, w, h) {
  const totp = require('../server/totp'), email = `smoke2fa${w}@example.com`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h } }), pg = await ctx.newPage(), errs = [];
  pg.on('pageerror', e => errs.push(e.message));   /* (wrong codes are refused on purpose, so no console-error check here) */
  const overflow = async what => { const x = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); expect(x <= 1, `horizontal overflow of ${x}px ${what} at ${w}px wide`); };
  const login = async () => { await pg.goto(BASE + '/login'); await pg.fill('#email', email); await pg.fill('#password', 'smoke-password-1'); await pg.click('#submit'); };
  await login(); await pg.waitForSelector('#v-dash:not([hidden])');
  await pg.click('#acct>summary'); await pg.click('#tfbox>summary');
  await pg.click('#tfbody [data-tf=start]'); await pg.waitForSelector('#tf-secret');
  const secret = (await pg.textContent('#tf-secret')).replace(/\s/g, '');
  expect(/^[A-Z2-7]{32}$/.test(secret) && await pg.locator(`#tfbody a[href^="otpauth://totp/"][href*="secret=${secret}"]`).count() === 1, 'the key should show as text and as an otpauth link');
  await overflow('with the two-step set-up open');
  const code = n => totp.totp(totp.fromBase32(secret), Date.now() + n * 30000);
  await pg.fill('#tf-code', '000000' === code(0) ? '111111' : '000000'); await pg.click('#tfbody [data-tf=on] button');
  await pg.waitForFunction(() => /didn’t match/.test(document.querySelector('#tfmsg').textContent), null, { timeout: 5000 });
  await pg.fill('#tf-code', code(0)); await pg.click('#tfbody [data-tf=on] button');
  await pg.waitForFunction(() => document.querySelectorAll('#tf-codes li').length === 10, null, { timeout: 5000 });
  const recovery = await pg.textContent('#tf-codes li >> nth=0');
  await overflow('with the recovery codes shown');
  await pg.click('#tfbody [data-tf=done]');
  await pg.waitForFunction(() => /10 recovery codes left/.test(document.querySelector('#tfbody').textContent), null, { timeout: 5000 });
  await pg.click('#logout'); await pg.waitForURL(/\/login/);
  /* the password alone isn't enough now */
  await login(); await pg.waitForSelector('#second:not([hidden]) #code');
  expect(await pg.isHidden('#form'), 'the password form should give way to the code');
  expect((await pg.evaluate(async () => (await fetch('/api/me')).status)) === 401, 'half signed in reaches no /api route');
  await overflow('on the code step');
  await pg.fill('#code', '12345'); await pg.click('#codebtn');
  await pg.waitForFunction(() => !document.querySelector('#err').hidden, null, { timeout: 5000 });
  await pg.fill('#code', code(1)); await pg.click('#codebtn');
  await pg.waitForSelector('#v-dash:not([hidden])');
  await pg.click('#acct>summary'); await pg.click('#logout'); await pg.waitForURL(/\/login/);
  let said = ''; pg.once('dialog', d => { said = d.message(); d.accept(); });
  await login(); await pg.waitForSelector('#second:not([hidden]) #code');
  await pg.fill('#code', recovery); await pg.click('#codebtn');
  await pg.waitForSelector('#v-dash:not([hidden])');
  expect(/recovery code/.test(said), 'using a recovery code should say it won’t work again');
  await pg.click('#acct>summary'); await pg.click('#tfbox>summary');
  await pg.waitForFunction(() => /9 recovery codes left/.test(document.querySelector('#tfbody').textContent), null, { timeout: 5000 });
  expect(errs.length === 0, 'page errors: ' + errs.join(' | '));
  await ctx.close();
}

/* A sensitive admin change on a sign-in over 15 minutes old asks for the password again, then goes through. */
/* Phase 1C bugs: sign-in lands on /#dash, one failed feed leaves the rest of the Dashboard and the super admin pages working,
   entries kept when a library copy fails, a quick Undo is saved, old days keep their foods' names, one e1RM rule. */
async function phase1c(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }), pg = await ctx.newPage(), errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(BASE + '/login'); await signIn(pg); await pg.waitForSelector('#v-dash:not([hidden])');
  expect(/\/#dash$/.test(pg.url()), 'after sign-in the address should be /#dash, not ' + pg.url());
  /* the photo feed fails: the checklist and the other cards still show, the photo card says why */
  await pg.route(PHOTO_LIST, r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
  await pg.reload(); await pg.waitForSelector('#v-dash:not([hidden]) .dcheck .dlist', { timeout: 5000 });
  expect(/Couldn’t load your photos: boom/.test(await pg.textContent('#d-body')) && await pg.locator('#d-body .dcard').count() === 5, 'only the photo card should show the failure');
  await pg.unroute(PHOTO_LIST);
  /* super admin: a failed accounts load says so, and loads again when the tab is opened again */
  await pg.route('**/api/admin/users', r => r.abort());
  await pg.evaluate(() => { location.hash = '#admin/people'; });
  await pg.waitForFunction(() => /Couldn’t load the accounts/.test(document.querySelector('#ad-users').textContent), null, { timeout: 5000 });
  await pg.unroute('**/api/admin/users');
  await pg.evaluate(() => { location.hash = '#admin/email'; }); await pg.evaluate(() => { location.hash = '#admin/people'; });
  await pg.waitForSelector('#ad-users .aduser', { timeout: 5000 });
  expect(await pg.evaluate(() => /progress photos/.test(auRemoveText({ email: 'x@y', photos: 2, shared: 1 })) && /every other account/.test(auRemoveText({ email: 'x@y', photos: 2, shared: 1 }))),
    'the remove confirm should name photos and shared foods');
  /* off plan: the name box has the library's limit, and the entry is kept when the library copy fails */
  const d = later(30);
  await pg.goto(BASE + '/#day/' + d); await pg.waitForFunction(d => document.querySelector('#datepick').value === d && document.querySelector('#meals .meal'), d);
  expect(await pg.evaluate(() => document.querySelector('#o-n').maxLength) === 80, 'the off-plan name box should stop at 80');
  expect(await pg.evaluate(() => libSync && Object.keys(day().lib || {}).length > 0), 'a day keeps a copy of its plan foods');
  await pg.route('**/api/foods', r => r.request().method() === 'POST' ? r.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Name is too long"}' }) : r.continue());
  pg.once('dialog', dg => dg.accept());
  await pg.fill('#o-n', 'Smoke long off-plan'); await pg.fill('#o-k', '120'); await pg.check('#o-save'); await pg.click('#offform button[type=submit]');
  await pg.waitForFunction(() => /Smoke long off-plan/.test(document.querySelector('#offlist').textContent), null, { timeout: 5000 });
  await pg.unroute('**/api/foods');
  /* a meal edit undone while its save is on the way: the undo is saved too */
  const d2 = later(31);
  await pg.goto(BASE + '/#day/' + d2); await pg.waitForFunction(d => document.querySelector('#datepick').value === d && document.querySelector('#meals .meal'), d2);
  await pg.route('**/api/days/*', async r => { if (r.request().method() === 'PUT') await new Promise(x => setTimeout(x, 800)); return r.continue(); });
  await pg.evaluate(() => editMeal(0, 'p', (D, m) => { m.p[0].g += 50; }));
  await pg.waitForFunction(() => inFlight, null, { timeout: 5000 });
  await pg.evaluate(() => undoMeal(0));
  await pg.waitForFunction(() => !pending.size && !inFlight && /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 8000 });
  await pg.unroute('**/api/days/*');
  const sv = await pg.evaluate(d => api('GET', '/api/days/' + d), d2);
  expect(sv && !sv.data.meals[0].dirty, 'a quick Undo should be saved');
  /* the Timeline names a food from the day's own copy when the plan no longer has it; Gym and Timeline share one e1RM rule */
  expect(await pg.evaluate(() => tFoodName({ lib: { gonefood: { n: 'Copy name' } } }, 'gonefood', todayStr()) === 'Copy name'), 'old days should keep their food names');
  expect(await pg.evaluate(() => e1rm({ kg: 40, reps: 30 }) === 0 && e1rm({ kg: 60, reps: 5 }) === 70), 'Gym e1RM should ignore sets over 20 reps, as the Timeline does');
  /* a new supplement's optional amount starts empty */
  await pg.evaluate(() => { location.hash = '#supps/lib/new'; }); await pg.waitForSelector('#s-lamt');
  expect(await pg.inputValue('#s-lamt') === '', 'the new supplement amount should start empty');
  /* Photos use the app's weigh-ins: one cleared on the Daily Tracker is gone there too */
  await pg.evaluate(() => { location.hash = '#photos'; }); await pg.waitForSelector('#p-form');
  const wd = await pg.evaluate(async () => { const d = addDays(todayStr(), -3); await api('PUT', '/api/weights/' + d, { kg: 91 }); WEIGHTS[d] = 91; return d; });
  await pg.evaluate(async d => { await api('DELETE', '/api/weights/' + d); delete WEIGHTS[d]; }, wd);
  expect(await pg.evaluate(d => !pWeights().some(w => w.date === d), wd), 'a deleted weigh-in should not drive the photo filters');
  expect(errs.length === 0, 'page errors: ' + errs.join(' | '));
  await ctx.close();
}

/* Phase 2C tracker leftovers: a far "Takes effect from" date is refused (never read as "from the start"), an impossible month
   isn't rolled into another, Food Library's "Where" lists a saved day's own meals, a save for a day under another plan doesn't
   take that plan's foods away from the day on screen, the export is named by the browser's date, a tab left open past midnight
   moves on at midnight, a garbled coach link shows the "doesn't work" panel, and a day stored under an impossible date can be
   deleted from History. */
async function phase2c(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } }), pg = await ctx.newPage(), errs = [];
  pg.on('pageerror', e => errs.push(e.message)); pg.on('dialog', d => d.accept());
  await pg.goto(BASE + '/login'); await signIn(pg); await pg.waitForSelector('#v-dash:not([hidden])');
  /* REG-1: a date past the window keeps the box as typed, says why and can't be saved; clearing it means from the start */
  await pg.evaluate(() => { location.hash = '#account'; }); await pg.waitForSelector('#v-admin.mine:not([hidden]) #ad-meals .admeal');
  const from0 = await pg.evaluate(() => adFrom), far = await pg.evaluate(() => addDays(lastDate(), 30));
  await pg.evaluate(() => { AD.targets[adType].k += 1; adStatus(); });
  await pg.fill('#ad-from', far); await pg.press('#ad-from', 'Tab');
  expect(await pg.evaluate(() => adFrom) === from0 && await pg.inputValue('#ad-from') === far && await pg.isDisabled('#ad-save')
    && /Pick a date from 2000 to a year from today/.test(await pg.textContent('#ad-fromhint')), 'a far "Takes effect from" date should be refused, not read as from the start');
  await pg.fill('#ad-from', from0); await pg.press('#ad-from', 'Tab');
  expect(!(await pg.isDisabled('#ad-save')), 'a good date again should let the plan be saved');
  await pg.click('#ad-discard');
  /* PR-TR-037: no month 13 */
  await pg.evaluate(() => { location.hash = '#history/2026-13'; });
  await pg.waitForFunction(() => location.hash === '#history' && /no such month/.test(document.querySelector('#numnote').textContent), null, { timeout: 5000 });
  expect(await pg.textContent('#mtitle') === await pg.evaluate(() => fmtMonth(todayStr().slice(0, 7) + '-01')), '#history/2026-13 should show this month');
  /* PR-TR-053 / PR-FS-026: a saved day's own meals in the Food Library's "Where", loaded first after a reload */
  const saved = await pg.evaluate(async () => {
    const d = addDays(todayStr(), -9), D = freshOn(d);
    D.meals = [{ ...D.meals[0], id: 'Z', name: 'Smoke saved meal' }];
    await api('PUT', '/api/days/' + d, { data: D, summary: { k: 0, p: 0, c: 0, f: 0, targets: D.targets } }); return d; });
  await pg.evaluate(() => { location.hash = '#dash'; }); await pg.reload(); await pg.waitForSelector('#v-dash:not([hidden])');
  await pg.evaluate(() => { location.hash = '#foods'; }); await pg.waitForSelector('#v-foods:not([hidden]) [data-fa=add]');
  await pg.click('#v-foods [data-fa=add] >> nth=0');
  await pg.fill('#f-adate', saved); await pg.dispatchEvent('#f-adate', 'change');
  await pg.waitForFunction(() => [...document.querySelectorAll('#f-awhere option')].map(o => o.textContent).join('|') === 'Off plan|Meal Z – Smoke saved meal', null, { timeout: 5000 });
  await pg.click('#v-foods [data-fa=cancel]');
  /* PR-TR-048: a save for an older day under a plan without bananas, landing while a newer day (with them) is on screen */
  const full = require('../server/legacy').effective({}, {}), lean = JSON.parse(JSON.stringify(full));
  delete lean.foods.banana;
  for (const t in lean.plan) for (const m of lean.plan[t]) for (const b of ['p', 'c', 'x']) m[b] = (m[b] || []).filter(i => i.f !== 'banana');
  const [older, newer, at, orig] = await pg.evaluate(async ([lean, full]) => {
    const cur = (await api('GET', '/api/defaults')).myVersions.find(v => !v.from);
    await api('PUT', '/api/my/defaults', { ...lean, from: null }, cur && cur.updatedAt);
    const orig = cur && Object.fromEntries(['foods', 'templates', 'schedule', 'targets', 'plan', 'free'].filter(k => k in cur).map(k => [k, cur[k]]));
    const at = addDays(todayStr(), -13); setDefaults(await api('PUT', '/api/my/defaults', { ...full, from: at }));
    return [addDays(todayStr(), -16), addDays(todayStr(), -11), at, orig]; }, [lean, full]);
  await pg.goto(BASE + '/#day/' + older); await pg.reload();
  await pg.waitForFunction(d => document.querySelector('#datepick').value === d && document.querySelector('#meals .meal'), older);
  await pg.fill('#o-n', 'Smoke older bar'); await pg.fill('#o-k', '150'); await pg.click('#offform button[type=submit]');
  await pg.evaluate(d => { location.hash = '#day/' + d; }, newer);
  await pg.waitForFunction(d => document.querySelector('#datepick').value === d && document.querySelector('#meals .meal'), newer);
  await pg.waitForFunction(() => !pending.size && !inFlight, null, { timeout: 5000 });
  const bananas = () => pg.evaluate(() => S.days[S.cur].meals.flatMap(m => m.c).filter(i => i.f === 'banana').length);
  const b0 = await bananas();
  await pg.locator('#meals select[data-add=c]').first().selectOption('banana');
  expect(await until(async () => await bananas() === b0 + 1), 'picking a food of the day’s plan should add it after an older day’s save');
  await pg.evaluate(async ([orig, at]) => { const cur = (await api('GET', '/api/defaults')).myVersions.find(v => !v.from);   /* the plan as it was */
    if (orig) await api('PUT', '/api/my/defaults', { ...orig, from: null }, cur.updatedAt); setDefaults(await api('DELETE', '/api/my/defaults/' + at)); }, [orig, at]);
  /* NEW-02: a day stored under a date that doesn't exist is listed on History and can be deleted there */
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(env.DB_PATH);
  db.prepare("INSERT INTO days (user_id, date, data, summary) SELECT id, '2026-02-31', '{\"meals\":[],\"off\":[]}', '{\"k\":900,\"p\":1,\"c\":1,\"f\":1,\"targets\":{}}' FROM users WHERE email = 'smoke@example.com'").run();
  db.close();
  await pg.goto(BASE + '/#history'); await pg.reload(); await pg.waitForSelector('#hbad:not([hidden]) [data-act=baddel]');
  expect(/2026-02-31: a day of 900 kcal/.test(await pg.textContent('#hbad')), 'the impossible date should be listed');
  await pg.click('#hbad [data-act=baddel]'); await pg.waitForSelector('#hbad', { state: 'hidden' });
  expect(!(await pg.evaluate(() => fetch('/api/days').then(r => r.json()))).some(d => d.date === '2026-02-31'), 'the impossible date should be deleted');
  /* PR-TL-029: a garbled coach link */
  await pg.goto(BASE + '/coach/abc%E0%A4'); await pg.waitForSelector('#c-gone:not([hidden])', { timeout: 5000 });
  expect(errs.length === 0, 'page errors: ' + errs.join(' | '));
  await ctx.close();
  /* PR-TR-047: far east of the server, the export is named by the browser's date (its zone goes with the link, #80) */
  const c2 = await browser.newContext({ timezoneId: 'Pacific/Kiritimati', acceptDownloads: true }), p2 = await c2.newPage();
  await p2.goto(BASE + '/login'); await signIn(p2); await p2.waitForSelector('#v-dash:not([hidden])');
  await p2.click('#acct summary');
  const [dl] = await Promise.all([p2.waitForEvent('download'), p2.click('#exportlink')]);
  const local = await p2.evaluate(() => todayStr());
  expect(dl.suggestedFilename() === `logbook-monster-${local}.json`, `the export should be named by the browser’s date ${local}: ${dl.suggestedFilename()}`);
  await c2.close();
  /* NEW-03: a Daily Tracker left on Today past midnight moves on at the next tap, so food goes to the new day */
  const c3 = await browser.newContext({ viewport: { width: 1100, height: 900 } }), p3 = await c3.newPage();
  p3.on('pageerror', e => errs.push(e.message)); p3.on('dialog', d => d.accept());
  const eve = new Date(); eve.setDate(eve.getDate() + 20); eve.setHours(23, 57, 0, 0);
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day1 = ymd(eve), day2 = ymd(new Date(eve.getFullYear(), eve.getMonth(), eve.getDate() + 1));
  await p3.clock.install({ time: eve });
  await p3.goto(BASE + '/login'); await signIn(p3); await p3.waitForSelector('#v-dash:not([hidden])');
  await p3.evaluate(() => { location.hash = '#day'; });
  await p3.waitForFunction(d => document.querySelector('#datepick').value === d && document.querySelector('#meals .meal'), day1, { timeout: 5000 });
  await p3.clock.fastForward('05:00');
  await p3.waitForFunction(d => document.querySelector('#datepick').value === d && /showing the new day/.test(document.querySelector('#numnote').textContent), day2, { timeout: 5000 });
  await p3.fill('#o-n', 'Smoke midnight snack'); await p3.fill('#o-k', '120'); await p3.click('#offform button[type=submit]');
  await p3.waitForFunction(d => document.querySelector('#datepick').value === d && document.querySelector('#dtitle').textContent === 'Today'
    && /Smoke midnight snack/.test(document.querySelector('#offlist').textContent), day2, { timeout: 5000 });
  await p3.waitForFunction(() => !pending.size && !inFlight, null, { timeout: 5000 });
  const offs = await p3.evaluate(async ds => Promise.all(ds.map(d => fetch('/api/days/' + d).then(r => r.ok ? r.json() : null)
    .then(j => (j ? j.data.off.map(o => o.n).join() : '')))), [day1, day2]);
  expect(!/midnight/.test(offs[0]) && /midnight/.test(offs[1]), 'food added after midnight should go to the new day: ' + offs);
  await p3.evaluate(async d => api('DELETE', '/api/days/' + d), day2);
  await c3.close();
  expect(errs.length === 0, 'page errors: ' + errs.join(' | '));
}

/* Phase 2C, gym / foods / supplements / photos: lists read again when the tab comes back and before saying a deep link's item isn't
   there, set edits checked against the version loaded, 🏆 for less assistance and a Records tab that loads with only assisted sets,
   Raw/Cooked closes your own food's Add form, an impossible #supps day says so, the photo form's date stops at today, an AI pose
   saved from the form stays the AI's, and one punctuation mark at the end of the Dashboard's photo error. */
async function phase2cLibrary(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }), pg = await ctx.newPage(), errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  const hash = async (h, sel) => { await pg.evaluate(h => { location.hash = h; }, h); if (sel) await pg.waitForSelector(sel, { timeout: 5000 }); };
  const back = () => pg.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   /* the tab shown again */
  await pg.goto(BASE + '/login'); await signIn(pg); await pg.waitForSelector('#v-dash:not([hidden])');
  /* the Dashboard's photo card: "…try again. Reload…", not "try again.. Reload" */
  await pg.route(PHOTO_LIST, r => r.abort());
  await pg.reload(); await pg.waitForFunction(() => /Couldn’t load your photos/.test(document.querySelector('#d-body').textContent), null, { timeout: 5000 });
  const dt = await pg.textContent('#d-body');
  expect(/check your connection and try again\. Reload/.test(dt) && !/[?.]\./.test(dt), 'the photo card error should end one sentence once: ' + dt.slice(0, 200));
  await pg.unroute(PHOTO_LIST);

  /* gym: assisted sets, less assistance is a 🏆; Records loads */
  const ex = await pg.evaluate(async () => {
    const e = await api('POST', '/api/gym/exercises', { name: 'Smoke assisted pull-up' });
    await api('POST', '/api/gym/sets', { exercise: e.id, reps: 8, kg: -30, at: addDays(todayStr(), -2) + 'T10:00' });
    await api('POST', '/api/gym/sets', { exercise: e.id, reps: 8, kg: -20, at: addDays(todayStr(), -1) + 'T10:00' });
    return e.id;
  });
  await hash('#gym/e/' + ex, '#g-quick');
  expect(await pg.locator('#g-body .gtro').count() === 1, 'less assistance should get a 🏆');
  await pg.click('[data-g=tab][data-t=records]'); await pg.waitForSelector('#g-body .wstats', { timeout: 5000 });
  expect(!/Couldn’t load/.test(await pg.textContent('#g-body')), 'Records should load with only assisted sets');
  await pg.click('[data-g=tab][data-t=sets]'); await pg.waitForSelector('#g-body .gday');
  /* a set logged in another tab shows when this one is shown again; a workout made elsewhere opens */
  await pg.evaluate(ex => api('POST', '/api/gym/sets', { exercise: ex, reps: 8, kg: -10, at: todayStr() + 'T09:00' }), ex);
  await back();
  await pg.waitForFunction(() => document.querySelectorAll('#g-body .gset').length === 3, null, { timeout: 5000 });
  const w = await pg.evaluate(ex => api('POST', '/api/gym/workouts', { name: 'Smoke other tab workout', items: [{ e: ex }] }), ex);
  await hash('#gym/w/' + w.id); await pg.waitForFunction(() => /Smoke other tab workout/.test(document.querySelector('#g-body h2').textContent), null, { timeout: 5000 });
  /* a set changed in another tab since this one loaded it: the save is refused and says why */
  const sid = await pg.evaluate(ex => api('GET', '/api/gym/sets?exercise=' + ex).then(l => l[0].id), ex);
  await hash('#gym/s/' + sid, '#g-setform');
  await pg.evaluate(async ([id, ex]) => api('PUT', '/api/gym/sets/' + id, { exercise: ex, reps: 6, kg: -30, note: 'other tab', at: addDays(todayStr(), -2) + 'T10:00' }), [sid, ex]);
  await pg.fill('#g-sr', '9'); await pg.click('#g-setform button[type=submit]');
  await pg.waitForFunction(() => /another tab or device/.test(document.querySelector('#g-smsg').textContent), null, { timeout: 5000 });
  expect(await pg.evaluate(id => api('GET', '/api/gym/sets/' + id).then(s => s.reps === 6 && s.note === 'other tab'), sid), 'the other tab’s edit should stay');

  /* foods: Raw/Cooked on your own food closes its Add form; a food made in another tab opens by its link */
  const f = await pg.evaluate(() => api('POST', '/api/foods', { name: 'Smoke thigh (raw)', unit: 'g', kind: 'ingredient', k: 180, p: 20, c: 0, f: 10, state: 'raw', yield: 75 }));
  await hash('#foods', '#f-list');
  const card = `.fcard[data-id="${f.id}"]`;
  await pg.waitForSelector(card, { timeout: 5000 });
  await pg.click(card + ' [data-fa=add]'); await pg.waitForSelector('#f-addform');
  await pg.click(card + ' [data-fa=wt][data-v=cooked]');
  await pg.waitForFunction(() => !document.querySelector('#f-addform'), null, { timeout: 5000 });
  const f2 = await pg.evaluate(() => api('POST', '/api/foods', { name: 'Smoke other tab food', unit: 'g', kind: 'ingredient', k: 100 }));
  await hash('#foods/' + f2.id, '#f-form');
  expect(await pg.inputValue('#f-name') === 'Smoke other tab food', 'a food made in another tab should open by its link');

  /* supplements: the same for the library, an impossible day says so, another tab's entry shows when this tab is shown again */
  await hash('#supps/lib', '#s-list');
  const s2 = await pg.evaluate(() => api('POST', '/api/supps', { name: 'Smoke other tab supp', amount: 1, unit: 'g' }));
  await hash('#supps/lib/' + s2.id, '#s-lform');
  await hash('#supps/2026-02-31'); await pg.waitForFunction(() => /no such day/.test(document.querySelector('#s-body').textContent), null, { timeout: 5000 });
  await hash('#supps', '#s-log .empty, #s-log .orow');
  await pg.evaluate(() => api('POST', '/api/supps/log', { date: todayStr(), name: 'Smoke other tab entry', amount: 2, unit: 'g' }));
  await back();
  await pg.waitForFunction(() => /Smoke other tab entry/.test(document.querySelector('#s-log').textContent), null, { timeout: 5000 });

  /* photos: one uploaded in another tab shows when this one is shown again and opens by its link; the form's date stops at today */
  await hash('#photos', '#p-list');
  const up = () => pg.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const b = await new Promise(r => c.toBlob(r, 'image/jpeg'));
    return pSend('POST', '/api/photos?date=' + todayStr() + '&pose=front', b);
  });
  const ph = await up();
  await back();
  await pg.waitForSelector(`#p-list [data-pid="${ph.id}"]`, { timeout: 5000 });
  const ph2 = await up();
  await hash('#photos/' + ph2.id, '#p-eform');
  expect(await pg.getAttribute('#p-edate', 'max') === await pg.evaluate(() => todayStr()), 'the photo date should stop at today');
  /* the AI's answer saved from the form is sent as the AI's */
  await pg.evaluate(() => { document.querySelector('#p-eform').dataset.ai = JSON.stringify({ pose: 'back', style: '' }); });
  await pg.selectOption('#p-epose', 'back'); await pg.selectOption('#p-estyle', '');
  const put = pg.waitForRequest(r => r.method() === 'PUT' && /\/api\/photos\/\d+$/.test(r.url()));
  await pg.click('#p-eform button[type=submit]');
  expect((await put).postDataJSON().ai === true, 'saving the AI’s answer should say so');
  expect(await pg.evaluate(() => !pUntagged({ poseAi: true, aiSaw: true, pose: 'other', style: '' }) && pUntagged({ poseAi: true, aiSaw: false, pose: 'other', style: '' })),
    'a photo the AI already called Other is not untagged');
  expect(errs.length === 0, 'page errors: ' + errs.join(' | '));
  await ctx.close();
}

/* Phase 2C last leftovers: a list read more than 10 s ago is read again when its section opens inside an open page (Gym Records → Sets,
   Supplements Library → Log and ‹ ›, Dashboard → Photos), Records shows assisted-only work as assistance with no negative volume, the
   account menu says "Change password" once a first one is set, and an impossible #day says so. */
async function phase2cLast(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }), pg = await ctx.newPage(), errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  const hash = async (h, sel) => { await pg.evaluate(h => { location.hash = h; }, h); if (sel) await pg.waitForSelector(sel, { timeout: 5000 }); };
  const later = () => pg.evaluate(() => { const n = Date.now; Date.now = () => n() + 11000; });   /* 11 s on, without waiting for it */
  await pg.route('**/api/me', async r => { const res = await r.fetch(), j = await res.json(); r.fulfill({ response: res, json: { ...j, hasPassword: false } }); });
  await pg.goto(BASE + '/login'); await signIn(pg); await pg.waitForSelector('#v-dash:not([hidden])');

  /* a Google-only account sets its first password: the menu says Change password after */
  expect(await pg.textContent('#pwbox summary') === 'Set a password', 'a Google-only account is offered to set a password');
  await pg.route('**/auth/password', r => r.fulfill({ json: { ok: true } }));
  await pg.click('#acct summary'); await pg.click('#pwbox summary');
  await pg.fill('#pw-new', 'smoke-password-1'); await pg.click('#pwform button[type=submit]');
  await pg.waitForFunction(() => /Password updated/.test(document.querySelector('#pwmsg').textContent), null, { timeout: 5000 });
  expect(await pg.textContent('#pwbox summary') === 'Change password', 'after setting one the menu should say Change password');
  await pg.unroute('**/auth/password'); await pg.unroute('**/api/me');
  await pg.click('#acct summary');

  /* #day with an impossible date says so */
  await hash('#day/2026-13-01');
  await pg.waitForFunction(() => /no such day as 2026-13-01/.test((document.querySelector('#numnote') || {}).textContent || ''), null, { timeout: 5000 });
  expect(await pg.evaluate(() => location.hash) === '#day', 'the bad day should leave the address');

  /* gym: assisted-only Records, and a set logged elsewhere shows on Records → Sets */
  const ex = await pg.evaluate(async () => {
    const e = await api('POST', '/api/gym/exercises', { name: 'Smoke last assisted dip' });
    await api('POST', '/api/gym/sets', { exercise: e.id, reps: 8, kg: -30, at: addDays(todayStr(), -2) + 'T10:00' });
    await api('POST', '/api/gym/sets', { exercise: e.id, reps: 8, kg: -20, at: addDays(todayStr(), -1) + 'T10:00' });
    return e.id;
  });
  await hash('#gym/e/' + ex, '#g-body .gday');
  await pg.click('[data-g=tab][data-t=records]'); await pg.waitForSelector('#g-body .wstats', { timeout: 5000 });
  const rec = await pg.textContent('#g-body');
  expect(!/-\d/.test(rec) && /Least assistance/.test(rec) && /assisted 20 kg/.test(rec), 'assisted-only Records: no negative numbers, assistance named: ' + rec.slice(0, 300));
  await pg.evaluate(ex => api('POST', '/api/gym/sets', { exercise: ex, reps: 8, kg: -10, at: todayStr() + 'T09:00' }), ex);
  await later();
  await pg.click('[data-g=tab][data-t=sets]');
  await pg.waitForFunction(() => document.querySelectorAll('#g-body .gset').length === 3, null, { timeout: 5000 });

  /* supplements: an entry made elsewhere shows on Library → Log and on ‹ then › */
  await hash('#supps', '#s-log .empty, #s-log .orow');
  await hash('#supps/lib', '#s-list');
  await pg.evaluate(() => api('POST', '/api/supps/log', { date: todayStr(), name: 'Smoke last entry one', amount: 1, unit: 'g' }));
  await later();
  await hash('#supps');
  await pg.waitForFunction(() => /Smoke last entry one/.test((document.querySelector('#s-log') || {}).textContent || ''), null, { timeout: 5000 });
  await pg.click('[data-sa=prev]'); await pg.waitForFunction(() => !/Smoke last entry one/.test((document.querySelector('#s-log') || {}).textContent || 'x'), null, { timeout: 5000 });
  await pg.evaluate(() => api('POST', '/api/supps/log', { date: todayStr(), name: 'Smoke last entry two', amount: 1, unit: 'g' }));
  await later();
  await pg.click('[data-sa=next]');
  await pg.waitForFunction(() => /Smoke last entry two/.test((document.querySelector('#s-log') || {}).textContent || ''), null, { timeout: 5000 });

  /* photos: one uploaded elsewhere shows on Dashboard → Photos */
  await hash('#photos', '#p-list');
  await hash('#dash', '#d-body .dcard');
  const ph = await pg.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const b = await new Promise(r => c.toBlob(r, 'image/jpeg'));
    return pSend('POST', '/api/photos?date=' + todayStr() + '&pose=front', b);
  });
  await later();
  await hash('#photos'); await pg.waitForSelector(`#p-list [data-pid="${ph.id}"]`, { timeout: 5000 });
  expect(errs.length === 0, 'page errors: ' + errs.join(' | '));
  await ctx.close();
}

/* Phase 10: the pages point only at versioned scripts and styles, cached for good, and are themselves checked on every load;
   the Dashboard asks only for the newest photo of each pose and keeps its feeds and the Timeline its trends until a write or the
   tab is shown again. */
async function versionedAssets(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }), pg = await ctx.newPage(), errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  const asked = [];
  pg.on('request', r => { if (r.url().startsWith(BASE + '/api/')) asked.push(r.url().slice(BASE.length)); });
  await pg.goto(BASE + '/login'); await signIn(pg); await pg.waitForSelector('#v-dash:not([hidden]) #d-body .dcard');
  for (const p of ['/', '/login', '/invite', '/coach/' + 'A'.repeat(43)]) {
    const r = await pg.evaluate(async p => { const r = await fetch(p, { redirect: 'manual' }); return { cc: r.headers.get('cache-control'), etag: r.headers.get('etag'), html: await r.text() }; }, p);
    if (p === '/login') continue;   /* signed in: a redirect to / */
    expect(r.cc === 'no-cache' && /^"[0-9a-f]+"$/.test(r.etag || ''), `${p} should be no-cache with a strong ETag: ${r.cc} ${r.etag}`);
    const refs = [...r.html.matchAll(/\b(?:src|href)="(\/[^"#]*)"/g)].map(m => m[1]).filter(u => /^\/[^/]+\.[a-z]+(\?|$)/.test(u));
    expect(refs.length >= 3, `${p} should load scripts and styles`);
    for (const u of refs) {
      expect(/\?v=[0-9a-f]{10}$/.test(u), `${p} points at an unversioned ${u}`);
      const cc = await pg.evaluate(async u => (await fetch(u)).headers.get('cache-control'), u);
      expect(cc === 'public, max-age=31536000, immutable', `${u} should be immutable, not ${cc}`);
    }
  }
  const loaded = await pg.evaluate(() => performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.(js|css)(\?|$)/.test(n) && n.startsWith(location.origin)));
  expect(loaded.length >= 10 && loaded.every(n => /\?v=[0-9a-f]{10}$/.test(n)), 'the app loaded only versioned files: ' + loaded.filter(n => !/\?v=/.test(n)).join());
  expect(asked.some(u => /^\/api\/photos\?latest=1&to=/.test(u)) && !asked.includes('/api/photos'), 'the Dashboard asks only for the latest photos: ' + asked.join());
  /* back to the Dashboard and the Timeline: nothing read again until a write or the tab is shown again */
  const hash = async (h, sel) => { await pg.evaluate(h => { location.hash = h; }, h); await pg.waitForSelector(sel, { timeout: 5000 }); };
  await hash('#history/timeline', '#v-timeline:not([hidden]) #t-chart svg, #v-timeline:not([hidden]) #t-chart .emptyc:not(:empty)');
  await until(() => asked.some(u => u.startsWith('/api/timeline/trends')));
  await hash('#dash', '#v-dash:not([hidden]) #d-body .dcard');
  asked.length = 0;
  await hash('#history/timeline', '#v-timeline:not([hidden])'); await hash('#dash', '#v-dash:not([hidden]) #d-body .dcard');
  await new Promise(r => setTimeout(r, 300));
  expect(!asked.some(u => /^\/api\/(timeline\/trends|photos|checklist\/days|supps\/log|gym\/sessions)/.test(u)), 'nothing changed, so nothing read again: ' + asked.join());
  await pg.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await hash('#history/timeline', '#v-timeline:not([hidden])');
  expect(await until(() => asked.some(u => u.startsWith('/api/timeline/trends'))), 'the tab shown again reads the trends again');
  asked.length = 0;
  await pg.evaluate(() => api('PUT', '/api/weights/' + todayStr(), { kg: 80.4 }));
  await hash('#dash', '#v-dash:not([hidden]) #d-body .dcard');
  expect(await until(() => asked.some(u => u.startsWith('/api/photos?latest=1'))), 'a write reads the Dashboard again');
  expect(!errs.length, 'page errors: ' + errs.join(' | '));
  await ctx.close();
}

async function recheck(browser) {
  const { DatabaseSync } = require('node:sqlite');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }), pg = await ctx.newPage(), errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(BASE + '/login'); await signIn(pg); await pg.waitForSelector('#v-dash:not([hidden])');
  const sid = require('crypto').createHash('sha256').update(decodeURIComponent((await ctx.cookies()).find(c => c.name === 'logbookmonster.sid').value).replace(/^s:/, '').split('.')[0]).digest('hex');   /* stored hashed */
  const db = new DatabaseSync(env.DB_PATH);
  db.prepare("UPDATE sessions SET sess = json_set(sess, '$.at', ?) WHERE sid = ?").run(Date.now() - 16 * 60 * 1000, sid);
  db.close();
  const change = pg.evaluate(() => api('PUT', '/api/admin/email', { from: '', fromName: '', host: '', port: '', secure: null, user: '', pass: '' }).then(() => 'ok', e => e.message));
  await pg.waitForSelector('#recheck[open] #rc-in');
  const x = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); expect(x <= 1, `horizontal overflow of ${x}px with the re-check open`);
  await pg.fill('#rc-in', 'wrong-password-9'); await pg.click('#rc-form button[type=submit]');
  await pg.waitForFunction(() => /didn’t work/.test(document.querySelector('#rc-msg').textContent), null, { timeout: 5000 });
  await pg.fill('#rc-in', 'smoke-password-1'); await pg.click('#rc-form button[type=submit]');
  expect(await change === 'ok', 'the change should go through after the password: ' + await change);
  expect(!(await pg.evaluate(() => document.querySelector('#recheck').open)), 'the dialog should close');
  expect(errs.length === 0, 'page errors: ' + errs.join(' | '));
  await ctx.close();
}

(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { cleanup(); noBrowser(`Chromium did not start (${String(e.message).split('\n')[0]})`); }
  try {
    for (const [w, h, first] of [[1100, 900, true], [390, 844, false]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const pg = await ctx.newPage(); const errs = [];
      pg.on('pageerror', e => errs.push(e.message));
      pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
      await pg.goto(BASE + '/');
      expect(pg.url().endsWith('/login'), 'signed-out visit should land on /login');
      await pg.fill('#email', 'smoke@example.com'); await pg.fill('#password', 'smoke-password-1'); await pg.click('#submit');
      /* the Dashboard is the landing page: the default checklist (Training done too – no plan, so no rest days yet), a tick that survives a reload */
      await pg.waitForSelector('#v-dash:not([hidden]) .dcheck .dlist', { timeout: 5000 });
      expect(await pg.locator('.dcheck .dweek .dday').count() === 7, 'the checklist should show the last 7 days');
      if (first) {
        expect(await pg.locator('.dcheck input[data-dk]').count() === 7 && /Training done/.test(await pg.textContent('.dcheck')), 'the default checklist has 7 items');
        await pg.check('.dcheck input[data-dk=water]');
        await pg.waitForFunction(() => /1 of 7 done/.test(document.querySelector('.dcheck').textContent), null, { timeout: 5000 });
        await pg.reload(); await pg.waitForSelector('#v-dash:not([hidden]) .dcheck .dlist');
        expect(await pg.isChecked('.dcheck input[data-dk=water]'), 'a tick should survive reload');
        expect(await pg.locator('#d-body .dcard').count() === 5, 'one card each for food, weight, gym, supplements and photos');
      }
      const dashScroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(dashScroll <= 1, `horizontal overflow of ${dashScroll}px on the dashboard at ${w}px wide`);
      await appShell(browser, pg, w, h);
      await pg.click('a[data-view=day]');
      if (first) {   /* no app defaults: a new account has no plan until it makes one; this one takes the old built-in plan */
        await pg.waitForSelector('#v-day:not([hidden]) #meals .noplan', { timeout: 5000 });
        expect(await pg.evaluate(() => !snacksShown().some(x => x.old) && !/Health Road/.test(document.querySelector('#v-day').textContent)), 'a new account should not get the first user’s snacks or Health Road copy');
        await pg.evaluate(plan => api('PUT', '/api/my/defaults', plan), require('../server/legacy').effective({}, {}));
        await pg.reload();
      }
      await pg.waitForSelector('#v-day:not([hidden]) #meals .meal', { timeout: 5000 });
      if (first) expect(/Plan only/.test(await pg.textContent('#status')), 'fresh day should be "Plan only"');
      if (first) { /* weigh a Health Road pack: the portion follows the plan's share of the meat */
        const pw = pg.locator('#meals input[data-act=pack][data-k=w]').first();
        await pw.fill('320');
        await pg.waitForFunction(() => /Weigh out \d+g/.test(document.querySelector('#meals .pout').textContent));
      }
      await pg.selectOption('#sn', 'reese'); await pg.fill('#sq', '2'); await pg.click('#snackform button');
      await pg.waitForFunction(() => /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
      await pg.fill('#wt', '80.5'); await pg.press('#wt', 'Tab'); await pg.waitForTimeout(300);
      await pg.reload(); await pg.waitForSelector('#v-day:not([hidden]) #meals .meal');
      expect(/Reese/.test(await pg.textContent('#offlist')), 'snack should survive reload');
      expect(await pg.inputValue('#meals input[data-act=pack][data-k=w] >> nth=0') === '320', 'pack weight should survive reload');
      expect(await pg.inputValue('#wt') === '80.5', 'weight should survive reload');
      if (first) {   /* a typo over a saved weight keeps it (it used to delete it); one double-click adds a snack once */
        await pg.locator('#wt').selectText(); await pg.keyboard.type('80e'); await pg.keyboard.press('Tab');
        await pg.waitForSelector('#numnote:not([hidden])', { timeout: 5000 });
        expect(await pg.inputValue('#wt') === '80.5' && /isn’t a number – kept 80\.5/.test(await pg.textContent('#numnote')), 'a typo should keep the weight and say so');
        /* letters typed over a saved value: Chromium wipes the selection and drops them, leaving a really empty box – refused too */
        await pg.evaluate(() => { document.querySelector('#numnote').hidden = true; });
        await pg.locator('#wt').selectText(); await pg.keyboard.type('abc'); await pg.keyboard.press('Tab');
        await pg.waitForSelector('#numnote:not([hidden])', { timeout: 5000 });
        expect(await pg.inputValue('#wt') === '80.5' && /isn’t a number – kept 80\.5/.test(await pg.textContent('#numnote')), '"abc" over the weight should keep it and say so');
        const tk0 = await pg.inputValue('#t-k');
        if (!(await pg.isVisible('#t-k'))) await pg.evaluate(() => { const d = document.querySelector('#t-k').closest('details'); if (d) d.open = true; });
        await pg.locator('#t-k').selectText(); await pg.keyboard.type('abc'); await pg.keyboard.press('Tab'); await pg.waitForTimeout(300);
        expect(tk0 !== '' && await pg.inputValue('#t-k') === tk0 && await pg.evaluate(k => day().targets.k === +k, tk0), '"abc" over the kcal target should keep it, not set 0');
        expect(JSON.stringify(await pg.evaluate(d => fetch('/api/weights').then(r => r.json()).then(w => w.filter(x => x.date === d).map(x => x.kg)), await pg.evaluate(() => S.cur))) === '[80.5]',
          'the server should still have the weight');
        const qty = () => pg.evaluate(() => (day().off.find(o => o.snack === 'skittles') || { qty: 0 }).qty);
        const q0 = await qty();
        await pg.selectOption('#sn', 'skittles'); await pg.fill('#sq', '1'); await pg.dblclick('#snackform button');
        await pg.waitForFunction(() => /Saved/.test(document.querySelector('#status').textContent) && !pending.size, null, { timeout: 5000 });
        expect(await qty() === q0 + 1, 'a double-click on Add should add the snack once');
        /* the same for an off-plan food saved to the library: one request, one library food */
        const posts = []; const seen = r => { if (r.method() === 'POST' && r.url().endsWith('/api/foods')) posts.push(r); };
        pg.on('request', seen);
        await pg.fill('#o-n', 'Smoke dbl bar'); await pg.fill('#o-k', '150'); await pg.check('#o-save'); await pg.dblclick('#offform button[type=submit]');
        await pg.waitForFunction(() => /Smoke dbl bar/.test(document.querySelector('#offlist').textContent) && !pending.size, null, { timeout: 5000 });
        await pg.waitForTimeout(500); pg.off('request', seen);
        expect(posts.length === 1 && (await pg.evaluate(() => LIB.filter(f => f.name === 'Smoke dbl bar').length)) === 1, `a double-click should save one library food (${posts.length} POSTs)`);
        await pg.evaluate(async () => { for (const f of LIB.filter(x => x.name === 'Smoke dbl bar')) await api('DELETE', '/api/foods/' + f.id); LIB = LIB.filter(x => x.name !== 'Smoke dbl bar'); libRegister(); });
      }
      if (first) { /* a saved day using a food its date's plan no longer has still opens (it used to do nothing) */
        const old = await pg.evaluate(async () => {
          const d = addDays(todayStr(), -2), D = freshOn(d);
          D.meals[0].p.push({ f: 'gone_food', g: 100, a: 100, lock: true });
          await api('PUT', '/api/days/' + d, { data: D, summary: { k: 0, p: 0, c: 0, f: 0, targets: D.targets } });
          return d;
        });
        await pg.reload(); await pg.waitForSelector('#v-day:not([hidden]) #meals .meal');
        await pg.goto(BASE + '/#day/' + old);
        await pg.waitForFunction(d => document.querySelector('#datepick').value === d && /Unknown food \(gone_food\)/.test(document.querySelector('#meals').textContent), old, { timeout: 5000 });
        /* markup stored in one's own day (food ids, a library copy's step and unit, pack weights, an off-plan unit) stays text (tracker-code-002) */
        const probeDay = await pg.evaluate(async () => {
          const d = addDays(todayStr(), -4), D = freshOn(d), t = n => `"><b id="PR-PROBE-${n}">x</b>`;
          const lf = 'L:9:' + t('lfid');
          D.lib = { [lf]: { n: 'Probe lib', k: 100, p: 20, c: 1, f: 1, d: 0, order: 200, step: '5' + t('step'), unit: 'g' + t('unit') } };
          D.meals[0].p.push({ f: lf, g: 100, a: 100, lock: true }, { f: 'x' + t('fid'), g: 50, a: 50, lock: true });
          D.packs = { [lf]: { w: '300' + t('pw'), m: '150' + t('pm') } };
          D.off.push({ n: 'Probe bar', k: 1, p: 0, c: 0, f: 0, qty: 1, lib: 9, u: 'g' + t('ou') });
          await api('PUT', '/api/days/' + d, { data: D, summary: { k: 0, p: 0, c: 0, f: 0, targets: D.targets } });
          return d;
        });
        await pg.goto(BASE + '/#day/' + probeDay); await pg.reload();   /* the server's copy, not one this page loaded before */
        await pg.waitForFunction(() => /Probe lib/.test(document.querySelector('#meals').textContent) && /Probe bar/.test(document.querySelector('#offlist').textContent), null, { timeout: 5000 });
        expect(await pg.locator('[id^="PR-PROBE"]').count() === 0, 'markup stored in a day must not become page elements on the Daily Tracker');
        await pg.waitForFunction(() => !pending.size, null, { timeout: 5000 });
        await pg.evaluate(d => api('DELETE', '/api/days/' + d), probeDay);
        await pg.goto(BASE + '/#day/' + await pg.evaluate(() => todayStr())); await pg.reload();
        await pg.waitForFunction(() => document.querySelector('#datepick').value === todayStr() && document.querySelector('#v-day:not([hidden]) #meals .meal'), null, { timeout: 5000 });
      }
      /* protein driver: switch auto-balance to direct protein, it sticks across a reload, then back to total */
      if (first) {
        await pg.click('[data-act=pbasis][data-v=direct]');
        await pg.waitForFunction(() => /Direct protein min/.test(document.querySelector('#sum').textContent) && /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
        await pg.reload(); await pg.waitForSelector('#v-day:not([hidden]) #meals .meal');
        expect(await pg.getAttribute('[data-act=pbasis][data-v=direct]', 'aria-pressed') === 'true', 'direct protein setting should survive reload');
        await pg.click('[data-act=pbasis][data-v=total]');
        await pg.waitForFunction(() => /Protein min/.test(document.querySelector('#sum').textContent) && !/Direct protein min/.test(document.querySelector('#sum').textContent), null, { timeout: 5000 });
        /* eaten: marking a meal eaten locks all of it, survives a reload, and undoing needs a confirmation */
        const m2 = '#meals .meal >> nth=1';
        const amts = () => pg.evaluate(() => [...document.querySelectorAll('#meals .meal')[1].querySelectorAll('input[data-act=amt]')].map(x => x.value + (x.disabled ? 'd' : '')).join());
        await pg.click(`${m2} >> [data-act=eat]`);
        await pg.waitForFunction(() => /Saved/.test(document.querySelector('#status').textContent) && document.querySelectorAll('#meals .meal.eaten').length === 1, null, { timeout: 5000 });
        const eatenAmts = await amts();
        expect(/d$/.test(eatenAmts) && !(await pg.locator(`${m2} >> [data-act=del]`).count()) && !(await pg.locator(`${m2} >> select[data-add]`).count()), 'an eaten meal should be locked');
        await pg.fill('#t-k', '2500'); await pg.press('#t-k', 'Tab');
        await pg.waitForFunction(() => /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
        expect(await amts() === eatenAmts, 'rebalancing the day should not move an eaten meal');
        await pg.reload(); await pg.waitForSelector('#v-day:not([hidden]) #meals .meal.eaten');
        pg.once('dialog', d => d.dismiss()); await pg.click(`${m2} >> [data-act=uneat]`);
        expect(await pg.locator('#meals .meal.eaten').count() === 1, 'cancelling the confirmation should keep the meal eaten');
        pg.once('dialog', d => d.accept()); await pg.click(`${m2} >> [data-act=uneat]`);
        await pg.waitForFunction(() => !document.querySelector('#meals .meal.eaten') && /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
        await pg.click('#coach');
        await pg.waitForFunction(() => /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
      }
      /* balance inside a meal: off while editing by default; ticked on the meal, more protein moves its carbs before saving */
      if (first) {
        const mi = await pg.evaluate(() => [...document.querySelectorAll('#meals .meal')].findIndex(m =>
          m.querySelector('input[data-act=amt][data-b=p]') && m.querySelector('.row:not(.locked) input[data-act=amt][data-b=c]')));
        expect(mi >= 0, 'a meal with protein and unlocked carbs');
        const meal = pg.locator('#meals .meal').nth(mi), calc = meal.locator('[data-act=mcalc]');
        const carb = async () => meal.locator('.row:not(.locked) input[data-act=amt][data-b=c]').first().inputValue();
        const c0 = await carb(), prot = meal.locator('input[data-act=amt][data-b=p]').first();
        await prot.fill(String(+(await prot.inputValue()) + 60)); await prot.press('Tab');
        await meal.locator('.savebar').waitFor();
        expect(!(await calc.isChecked()) && await carb() === c0, 'nothing else in the meal should move by default');
        await calc.check();
        expect(await carb() !== c0, 'carbs should move once balancing the meal is ticked');
        await calc.uncheck();
        expect(await carb() === c0, 'unticking should put the carbs back');
        await calc.check();
        await meal.locator('[data-act=undo]').click();
        expect(await carb() === c0 && !(await meal.locator('.savebar').count()), 'undo should put the meal back');
      }
      await pg.click('a[data-view=history]'); await pg.waitForSelector('#v-history:not([hidden]) .cell.logged');
      expect(await pg.getAttribute('#v-history .htabs [data-h=cal]', 'aria-current') === 'page', 'History should open on the Calendar tab');
      expect(!(await pg.locator('a[data-view=weight]').count()), 'the Weight view should be gone');
      await pg.evaluate(() => { location.hash = '#weight'; }); await pg.waitForSelector('#v-timeline:not([hidden])');
      expect(await pg.evaluate(() => location.hash) === '#history/timeline', 'old #weight links should open the Timeline');
      await pg.click('a[data-view=history]'); await pg.waitForSelector('#v-history:not([hidden])');
      /* gym: make a workout, log two sets, edit one, look at chart, records and sessions */
      await pg.click('a[data-view=gym]'); await pg.waitForSelector('#v-gym:not([hidden]) #g-body .glist');
      await pg.click('a[href="#gym/new"]'); await pg.fill('#g-wname', 'Saturday — Lower');
      await pg.fill('#g-exname', 'Atlantis hack squat'); await pg.press('#g-exname', 'Enter');
      await pg.waitForSelector('#g-wt-0'); await pg.fill('#g-wt-0', '1 × 5–8 heavy');
      await pg.click('[data-g=wsave]');
      await pg.waitForFunction(() => /Saturday — Lower/.test(document.querySelector('#g-body .gbar h2').textContent), null, { timeout: 5000 });
      await pg.click('#g-body a.grow[href^="#gym/e/"]'); await pg.waitForSelector('#g-quick');
      /* Trend: off until picked (the first run picks it on the Timeline); the second run switches it off and on again here */
      expect(await pg.isChecked('[data-g=trend]') === !first, 'an exercise should only be on the Timeline once picked');
      if (!first) for (const on of [false, true]) {
        await pg.setChecked('[data-g=trend]', on); await pg.waitForFunction(() => !document.querySelector('[data-g=trend]').disabled);
        expect(await pg.isChecked('[data-g=trend]') === on, 'the Trend box should stay as set');
      }
      const before = await pg.locator('.gset').count();
      await pg.fill('#g-reps', '12'); await pg.fill('#g-kg', '160'); await pg.click('#g-quick .gok');
      await pg.waitForFunction(n => document.querySelectorAll('.gset').length === n + 1, before, { timeout: 5000 });
      await pg.click('[data-g=adj][data-f=reps][data-d="-1"]'); await pg.click('[data-g=adj][data-f=kg][data-d="5"]');
      expect(await pg.inputValue('#g-reps') === '11' && await pg.inputValue('#g-kg') === '165', 'steppers should change reps and weight');
      await pg.click('#g-quick .gok');
      await pg.waitForFunction(n => document.querySelectorAll('.gset').length === n + 2, before, { timeout: 5000 });
      expect(/\+0:0/.test(await pg.textContent('.gday')), 'second set should show the rest time');
      await pg.click('.gday .gset >> nth=0'); await pg.waitForSelector('#g-setform');
      await pg.fill('#g-sr', '10'); await pg.click('#g-setform button[type=submit]');
      await pg.waitForFunction(() => /10rep/.test(document.querySelector('.gday') && document.querySelector('.gday').textContent), null, { timeout: 5000 });
      await pg.click('[data-g=tab][data-t=records]'); await pg.waitForSelector('.greps');
      await pg.click('[data-g=tab][data-t=chart]'); await pg.waitForSelector('#g-chart');
      await pg.click('[data-g=tab][data-t=sets]'); await pg.waitForSelector('#g-quick');
      const gscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(gscroll <= 1, `horizontal overflow of ${gscroll}px on the gym exercise page at ${w}px wide`);
      await pg.click('#g-tabs a[data-g=sessions]'); await pg.waitForSelector('#g-body a.grow[href^="#gym/d/"]');
      await pg.click('#g-body a.grow[href^="#gym/d/"]'); await pg.waitForSelector('#g-body .gday');
      await pg.click('#g-tabs a[data-g=x]'); await pg.waitForSelector('#g-exlist a.grow');
      /* history CSV: preview, import, then the same file again only skips */
      const csv = Buffer.from('Exercise,Date,Time,Reps,Weight,Unit,Notes\nAtlantis hack squat,01/02/2025,17:43:38,10,140,kg,"deep, slow"\nCable row,01/02/2025,18:00:00,12,60,kg,\nPlank,01/02/2025,18:10:00,,,kg,\n');
      await pg.setInputFiles('#g-csvfile', { name: 'setgraph.csv', mimeType: 'text/csv', buffer: csv });
      await pg.waitForSelector('#g-csvorder');
      expect(/2 sets/.test(await pg.textContent('.gai')) && /1 row left out/.test(await pg.textContent('.gai')), 'CSV preview should count sets and skipped rows');
      await pg.selectOption('#g-csvorder', 'mdy'); await pg.waitForFunction(() => /Jan/.test(document.querySelector('.gcsvtab').textContent));
      await pg.click('[data-g=csvgo]'); await pg.waitForFunction(() => /^Added /.test((document.querySelector('.gai .admsg') || {}).textContent || ''), null, { timeout: 5000 });
      expect(/Cable row/.test(await pg.textContent('#g-exlist')), 'imported exercise should be listed');
      await pg.setInputFiles('#g-csvfile', { name: 'setgraph.csv', mimeType: 'text/csv', buffer: csv });
      await pg.waitForSelector('#g-csvorder'); await pg.selectOption('#g-csvorder', 'mdy'); await pg.waitForFunction(() => /Jan/.test(document.querySelector('.gcsvtab').textContent));
      await pg.click('[data-g=csvgo]'); await pg.waitForFunction(() => /Added 0 sets \(2 you already had/.test((document.querySelector('.gai .admsg') || {}).textContent || ''), null, { timeout: 5000 });
      const cscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(cscroll <= 1, `horizontal overflow of ${cscroll}px on the exercises page at ${w}px wide`);
      await pg.click('[data-g=csvdrop]');
      if (first) {   /* numbers as other apps write them: "1,025" lb in a comma file is 1025 lb; letters for reps are left out, not 0;
                        a lone "1,025" in a semicolon file could be either, so it is reported */
        await pg.setInputFiles('#g-csvfile', { name: 'thousands.csv', mimeType: 'text/csv', buffer: Buffer.from('Exercise,Date,Reps,Weight (lbs)\nSmoke leg press,2026-10-01 10:00,10,"1,025"\nSmoke leg press,2026-10-01 10:05,abc,20\n') });
        await pg.waitForFunction(() => /From thousands\.csv/.test((document.querySelector('.gai') || {}).textContent || ''), null, { timeout: 5000 });
        const t = await pg.textContent('.gai');
        expect(/10 × 464\.93 kg/.test(t) && /1 row left out/.test(t) && /reps “abc” isn’t a number/.test(t), 'a thousands separator should be read and a bad reps row left out: ' + t);
        await pg.setInputFiles('#g-csvfile', { name: 'semi.csv', mimeType: 'text/csv', buffer: Buffer.from('Exercise;Date;Reps;Weight\nSmoke leg press;2026-10-01 10:00;10;1,025\nSmoke curl;2026-10-01 10:05;8;12,5\n') });
        await pg.waitForFunction(() => /From semi\.csv/.test((document.querySelector('.gai') || {}).textContent || ''), null, { timeout: 5000 });
        expect(/10 × 1\.02 kg/.test(await pg.textContent('.gai')) && /8 × 12\.5 kg/.test(await pg.textContent('.gai')), 'decimal commas in a ; file');
        await pg.setInputFiles('#g-csvfile', { name: 'amb.csv', mimeType: 'text/csv', buffer: Buffer.from('Exercise;Date;Reps;Weight\nSmoke leg press;2026-10-01 10:00;10;1,025\n') });
        await pg.waitForFunction(() => /From amb\.csv/.test((document.querySelector('.gai') || {}).textContent || ''), null, { timeout: 5000 });
        expect(/could be 1025 or 1\.025/.test(await pg.textContent('.gai')) && await pg.isDisabled('[data-g=csvgo]'), 'an ambiguous number should be reported, not guessed');
        await pg.click('[data-g=csvdrop]');
      }
      /* body parts: tick them in the exercise's settings, filter My exercises by one, then use the workout builder's picker */
      await pg.click('#g-exlist a.grow:has-text("Atlantis hack squat")'); await pg.waitForSelector('#g-quick');
      await pg.click('.gexset > summary'); await pg.setChecked('input[name=g-part][value=quads]', true); await pg.setChecked('input[name=g-part][value=glutes]', true);
      await pg.click('#g-exform button[type=submit]'); await pg.waitForFunction(() => /Quads/.test((document.querySelector('#g-body .gpts') || {}).textContent || ''), null, { timeout: 5000 });
      await pg.click('#g-tabs a[data-g=x]'); await pg.waitForSelector('#g-exlist a.grow');
      await pg.click('[data-g=part][data-p=quads]'); await pg.waitForSelector('[data-g=part][data-p=quads][aria-pressed=true]');
      let exl = await pg.textContent('#g-exlist');
      expect(/Atlantis hack squat/.test(exl) && !/Cable row/.test(exl), 'the Quads filter should list only quad exercises');
      await pg.evaluate(() => { location.hash = '#gym/new'; }); await pg.waitForSelector('#g-picklist');
      exl = await pg.textContent('#g-picklist');
      expect(/Atlantis hack squat/.test(exl) && !/Cable row/.test(exl), 'the picker should keep the body-part filter');
      await pg.click('[data-g=part][data-p=""]'); await pg.fill('#g-exname', 'cable');
      await pg.waitForFunction(() => document.querySelectorAll('#g-picklist [data-g=pick]').length === 1);
      await pg.click('#g-picklist [data-g=pick]'); await pg.waitForFunction(() => /Cable row/.test(document.querySelector('#g-body .gedit').textContent));
      expect(/✓/.test(await pg.textContent('#g-picklist')), 'a picked exercise should be marked in the picker');
      const bscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(bscroll <= 1, `horizontal overflow of ${bscroll}px in the workout builder at ${w}px wide`);
      await pg.click('#g-tabs a[data-g=""]'); await pg.waitForSelector('#g-body a[href="#gym/new"]');
      /* food library: add a shared meal with a recipe, filter meals and ingredients, open an AI flag's source,
         find the meal, add it to today's plan, then add it again from the Day page */
      if (first) {   /* only the server marks AI estimates (a hand-made ai record is dropped), so the flag is set in the database */
        const id = (await pg.evaluate(() => api('POST', '/api/foods', { name: 'Smoke chicken', unit: 'g', kind: 'ingredient', k: 165, p: 31, c: 0, f: 3.6 }))).id;
        const db = new (require('node:sqlite').DatabaseSync)(env.DB_PATH);
        db.prepare('UPDATE foods SET ai = ? WHERE id = ?').run(JSON.stringify({ fields: ['k', 'f'], source: 'Smoke source – USDA', basis: ['100 g raw breast'], confidence: 'high', at: '2026-01-01' }), id);
        db.close();
      }
      await pg.click('a[data-view=foods]'); await pg.waitForSelector('#v-foods:not([hidden]) #f-list');
      if (first) {
        await pg.click('#f-body a[href="#foods/new"]'); await pg.waitForSelector('#f-form');
        await pg.fill('#f-name', 'Smoke pancakes'); await pg.click('[data-fa=fkind][data-v=meal]');
        expect(await pg.inputValue('#f-unit') === 'each', 'a new meal should default to per item');
        await pg.fill('#f-k', '420'); await pg.fill('#f-p', '38'); await pg.fill('#f-c', '45'); await pg.fill('#f-f', '9');
        await pg.fill('#f-recipe', '60g oats\n30g whey\n2 eggs'); await pg.check('#f-public');
        await pg.click('#f-form button[type=submit]');
        await pg.waitForFunction(() => /Added “Smoke pancakes”/.test((document.querySelector('#f-list') || {}).textContent), null, { timeout: 5000 });
      }
      await pg.selectOption('#f-who', 'mine');
      await pg.click('[data-fa=kind][data-v=meal]'); await pg.waitForFunction(() => document.querySelectorAll('#f-list .fcard').length === 1);
      expect(/Smoke pancakes/.test(await pg.textContent('#f-list')) && /Meals 1/.test(await pg.textContent('#f-kinds')), 'Meals should show only the meal');
      await pg.click('[data-fa=kind][data-v=ingredient]'); await pg.waitForFunction(() => /Smoke chicken/.test(document.querySelector('#f-list').textContent));
      await pg.click('[data-fa=tag][data-v=hp]'); await pg.click('[data-fa=tag][data-v=ai]');
      expect(await pg.locator('#f-list .fcard').count() === 1, 'high-protein AI-estimated ingredient should stay listed');
      expect(await pg.locator('#f-list .aiv').count() === 2, 'calories and fat should be flagged');
      await pg.click('#f-list .aiv >> nth=0'); await pg.waitForSelector('#f-list .aisrc');
      expect(/Smoke source/.test(await pg.textContent('#f-list .aisrc')) && /calories and fat/.test(await pg.textContent('#f-list .aisrc')), 'flag should show the AI source');
      const ascroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(ascroll <= 1, `horizontal overflow of ${ascroll}px on the food filters at ${w}px wide`);
      /* the meal plan is in the library without entering anything: its meals and the foods they use */
      await pg.click('#f-clear'); await pg.waitForFunction(() => document.querySelectorAll('#f-list .fcard').length > 10);
      await pg.selectOption('#f-who', 'plan');
      await pg.waitForFunction(() => /Cream of rice bowl/.test(document.querySelector('#f-list').textContent) && !/Smoke pancakes/.test(document.querySelector('#f-list').textContent));
      expect(/Cream of rice \(dry\)/.test(await pg.textContent('#f-list')), 'plan ingredients should be in the library');
      await pg.click('#f-list .fcard:has-text("Cream of rice bowl") [data-fa=add]'); await pg.waitForSelector('#f-addform');
      expect(/kcal/.test(await pg.textContent('#f-aprev')) && !/^0 kcal/.test(await pg.textContent('#f-aprev')), 'a plan meal should add with its values');
      await pg.click('#f-addform [data-fa=cancel]');
      /* starter foods, shown raw or cooked: one card, then the whole list */
      await pg.selectOption('#f-who', 'starter');
      const chick = '#f-list .fcard[data-id="std:chicken-breast"]';
      await pg.waitForSelector(chick);
      expect(/120 kcal/.test(await pg.textContent(chick + ' .ml')) && /\(raw\)/.test(await pg.textContent(chick + ' h3')), 'starter chicken should show raw values');
      await pg.click(chick + ' [data-fa=wt][data-v=cooked]');
      await pg.waitForFunction(() => /160 kcal/.test(document.querySelector('#f-list .fcard[data-id="std:chicken-breast"] .ml').textContent));
      await pg.click('#f-wt [data-v=cooked]');
      await pg.waitForFunction(() => /130 kcal/.test(document.querySelector('#f-list .fcard[data-id="std:white-rice"] .ml').textContent));
      expect(/\(cooked\)/.test(await pg.textContent('#f-list .fcard[data-id="std:white-rice"] h3')), 'whole list should switch to cooked');
      const wscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(wscroll <= 1, `horizontal overflow of ${wscroll}px on the starter foods at ${w}px wide`);
      /* food groups: Fats keeps only the fats; tapping it again shows every group */
      await pg.click('#f-groups [data-v=Fats]');
      await pg.waitForFunction(() => document.querySelectorAll('#f-list .fcard').length === 4);
      expect(/Olive oil/.test(await pg.textContent('#f-list')) && !/Chicken/.test(await pg.textContent('#f-list')), 'Fats should show only the fats');
      const fgscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(fgscroll <= 1, `horizontal overflow of ${fgscroll}px on the food groups at ${w}px wide`);
      await pg.click('#f-groups [data-v=Fats]'); await pg.waitForFunction(() => document.querySelectorAll('#f-list .fcard').length > 20);
      await pg.click('#f-wt [data-v=raw]'); await pg.selectOption('#f-who', 'mine');
      await pg.fill('#f-q', 'oats'); await pg.waitForFunction(() => document.querySelectorAll('#f-list .fcard').length === 1);
      expect(/Shared/.test(await pg.textContent('#f-list .fcard')), 'shared food should be marked Shared');
      await pg.click('#f-list .fcard details summary'); expect(/30g whey/.test(await pg.textContent('#f-list .frecipe')), 'recipe should show');
      await pg.click('#f-list [data-fa=add]'); await pg.waitForSelector('#f-addform');
      await pg.fill('#f-aqty', '2'); expect(/840/.test(await pg.textContent('#f-aprev')), 'preview should scale to 2 items');
      const fscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(fscroll <= 1, `horizontal overflow of ${fscroll}px on the food library at ${w}px wide`);
      await pg.dblclick('#f-addform button[type=submit]');   /* added once (a double-click used to add it twice) */
      await pg.waitForSelector('#v-day:not([hidden]) #offlist', { timeout: 5000 });
      await pg.waitForFunction(() => /Smoke pancakes/.test(document.querySelector('#offlist').textContent) && /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
      await pg.selectOption('#ln', { label: 'Smoke pancakes (per item)' }); await pg.fill('#lq', '1'); await pg.click('#libform button');
      await pg.waitForFunction(n => [...document.querySelectorAll('#offlist input[data-act=oqty]')].some(i => i.value === n), first ? '3' : '6', { timeout: 5000 });
      /* inside meals: from the Foods page into meal 1, then from a meal's "+ Add a food…" on the Day page */
      const inMeals = () => pg.evaluate(() => [...document.querySelectorAll('#meals select[data-act=swap]')].filter(x => (x.selectedOptions[0] || {}).textContent === 'Smoke pancakes').length);
      const mBefore = await inMeals();
      await pg.click('a[data-view=foods]'); await pg.waitForSelector('#f-list .fcard');
      await pg.click('#f-list .fcard:has-text("Smoke pancakes") [data-fa=add]'); await pg.waitForSelector('#f-awhere');
      await pg.selectOption('#f-awhere', '0'); await pg.click('#f-addform button[type=submit]');
      await pg.waitForSelector('#v-day:not([hidden]) #meals .meal');
      await pg.waitForFunction(() => /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
      expect(await inMeals() === mBefore + 1, 'food added from the Foods page should be in meal 1');
      await pg.selectOption('select[data-add=c][data-m="1"]', { label: 'Smoke pancakes' }); await pg.click('[data-act=save][data-m="1"]');
      await pg.waitForFunction(n => [...document.querySelectorAll('#meals select[data-act=swap]')].filter(x => (x.selectedOptions[0] || {}).textContent === 'Smoke pancakes').length === n, mBefore + 2, { timeout: 5000 });
      await pg.waitForFunction(() => /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
      if (!first) {
        /* change the food's values: the saved day keeps the old ones and still loads */
        await pg.evaluate(async () => { const f = LIB.find(x => x.name === 'Smoke pancakes'); await api('PUT', '/api/foods/' + f.id, { ...f, k: 500 }); });
        await pg.reload(); await pg.waitForSelector('#v-day:not([hidden]) #meals .meal');
        expect(await inMeals() === mBefore + 2, 'meal items should survive the food being edited');
      }
      /* supplements: a library entry with a usual amount, a free-text entry with its own unit, quick add, remove */
      await pg.click('a[data-view=supps]'); await pg.waitForSelector('#v-supps:not([hidden]) #s-form');
      if (first) {
        await pg.click('#s-body a[href="#supps/lib"]'); await pg.click('#s-body a[href="#supps/lib/new"]'); await pg.waitForSelector('#s-lform');
        await pg.fill('#s-name', 'Smoke creatine'); await pg.fill('#s-lamt', '5'); await pg.selectOption('#s-lunit', 'g'); await pg.check('#s-public');
        await pg.click('#s-lform button[type=submit]');
        await pg.waitForFunction(() => /Added “Smoke creatine”/.test((document.querySelector('#s-list') || {}).textContent), null, { timeout: 5000 });
        await pg.click('#s-list [data-sa=log]'); await pg.waitForSelector('#s-form');
        expect(await pg.inputValue('#s-amt') === '5' && await pg.inputValue('#s-unit') === 'g', '"Log it" should fill in the usual amount');
        await pg.fill('#s-amt', '3'); await pg.click('#s-form button[type=submit]');
        await pg.waitForFunction(() => /Smoke creatine\s*3 g/.test(document.querySelector('#s-log').textContent), null, { timeout: 5000 });
        /* follow it on the Timeline's trend chart */
        await pg.check('#s-log .orow:has-text("Smoke creatine") input[data-st]');
        await pg.waitForFunction(() => STREND.has('smoke creatine'), null, { timeout: 5000 });
      }
      await pg.selectOption('#s-pick', ''); await pg.fill('#s-desc', 'Smoke vitamin D3'); await pg.fill('#s-amt', '2000'); await pg.selectOption('#s-unit', 'IU');
      await pg.click('#s-form button[type=submit]');
      await pg.waitForFunction(() => /Smoke vitamin D3\s*2000 IU/.test(document.querySelector('#s-log').textContent), null, { timeout: 5000 });
      await pg.click('[data-sa=quick]'); await pg.waitForFunction(() => /Smoke creatine\s*5 g/.test(document.querySelector('#s-log').textContent), null, { timeout: 5000 });
      const sRows = await pg.locator('#s-log .orow').count();
      await pg.reload(); await pg.waitForSelector('#s-log .orow');
      expect(await pg.locator('#s-log .orow').count() === sRows, 'supplement log should survive reload');
      expect(await pg.isChecked('#s-log .orow:has-text("Smoke creatine") input[data-st] >> nth=0'), 'Trend should stay ticked');
      const sscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(sscroll <= 1, `horizontal overflow of ${sscroll}px on the supplements page at ${w}px wide`);
      await pg.click('#s-log .orow:last-child [data-sa=del]'); await pg.waitForFunction(n => document.querySelectorAll('#s-log .orow').length === n, sRows - 1, { timeout: 5000 });
      if (!first) {
        /* a supplement regime read with AI (faked answer) in the background: leave for the Dashboard while it reads,
           open it from the note when it's ready, then edit a line, untick one, add the rest and log them today */
        const job = { id: 901, kind: 'supps', label: 'regime.pdf', status: 'running', error: null, seen: false };
        await pg.route(/\/api\/supps\/ai-import\?bg=1$/, r => r.fulfill({ status: 202, json: { job } }));
        await pg.route(/\/api\/jobs(\/.*)?$/, r => {
          const u = new URL(r.request().url()).pathname;
          if (u === '/api/jobs') return r.fulfill({ json: { jobs: job.seen ? [] : [job] } });
          if (u.endsWith('/seen')) { job.seen = true; return r.fulfill({ json: { ok: true } }); }
          r.fulfill({ json: { ...job, result: { model: 'test/model', notes: ['Guessed the strength'], items: [
            { name: 'Smoke magnesium', amount: 400, unit: 'mg', notes: 'Evening', existing: null },
            { name: 'Smoke zinc', amount: 15, unit: 'mg', notes: '', existing: null },
            { name: 'Smoke fish oil', amount: 2, unit: 'capsules', notes: 'With lunch', existing: null }] } } });
        });
        await pg.click('#s-body a[href="#supps/lib"]'); await pg.waitForSelector('#s-aifile', { state: 'attached' });
        await pg.setInputFiles('#s-aifile', { name: 'regime.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
        await pg.waitForFunction(() => /Reading your supplement regime \(regime\.pdf\)/.test(document.querySelector('#jobs').textContent), null, { timeout: 5000 });
        expect(await pg.isDisabled('#s-aifile'), 'only one regime is read at a time');
        await pg.click('a[data-view=dash]'); await pg.waitForSelector('#v-dash:not([hidden])');
        job.status = 'done';
        await pg.waitForSelector('#jobs .job.ok [data-job=open]', { timeout: 10000 });
        expect(await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'the AI note should fit the screen');
        await pg.click('#jobs [data-job=open]');
        await pg.waitForSelector('.sai .sairow');
        expect(await pg.evaluate(() => location.hash) === '#supps/lib' && await pg.isHidden('#jobs'), 'Open should go to the regime and clear the note');
        expect(!job.seen, 'an opened regime stays unseen until it is added or dropped, so a reload can reopen it');
        expect(await pg.locator('.sai .sairow').count() === 3 && /Guessed the strength/.test(await pg.textContent('.sai')), 'the AI’s line items and notes should be shown');
        await pg.fill('.sai [data-sai=amount][data-i="0"]', '300');
        await pg.uncheck('.sai [data-sai=on][data-i="1"]');
        await pg.waitForFunction(() => /Add 2 supplements/.test(document.querySelector('[data-sa=aiadd]').textContent), null, { timeout: 5000 });
        await pg.check('#s-ailog');
        const aiscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(aiscroll <= 1, `horizontal overflow of ${aiscroll}px on the supplement regime preview at ${w}px wide`);
        await pg.click('[data-sa=aiadd]');
        await pg.waitForFunction(() => /Added 2 to your library\. Logged 2/.test((document.querySelector('#s-list') || {}).textContent), null, { timeout: 5000 });
        expect(job.seen, 'adding the regime marks the read seen');
        await pg.unroute(/\/api\/jobs(\/.*)?$/);
        expect(await pg.evaluate(() => SUPPS.some(s => s.name === 'Smoke magnesium' && s.amount === 300) && !SUPPS.some(s => s.name === 'Smoke zinc')), 'edited lines should be added, unticked ones left out');
        await pg.unroute('**/api/supps/ai-import');
        await pg.click('#s-body a[href="#supps"]'); await pg.waitForFunction(() => /Smoke magnesium\s*300 mg/.test((document.querySelector('#s-log') || {}).textContent), null, { timeout: 5000 });
      }
      /* progress photos: upload two days of pictures (shrunk in the browser, with thumbnails), edit one, filter by bodyweight,
         jump to a date, pick two to compare, match a weight */
      if (first) await pg.evaluate(async () => { await api('PUT', '/api/weights/2026-09-01', { kg: 85 }); await api('PUT', '/api/weights/2026-10-01', { kg: 80.4 }); });
      await pg.click('a[data-view=photos]'); await pg.waitForSelector('#v-photos:not([hidden]) #p-form');
      if (first) {
        const pic = async (w, h, colour) => Buffer.from(await pg.evaluate(([w, h, colour]) => {
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const g = c.getContext('2d'); g.fillStyle = colour; g.fillRect(0, 0, w, h);
          return c.toDataURL('image/png').split(',')[1];
        }, [w, h, colour]), 'base64');
        await pg.setInputFiles('#p-file', [{ name: 'front.png', mimeType: 'image/png', buffer: await pic(3000, 4000, '#c33') },
          { name: 'side.png', mimeType: 'image/png', buffer: await pic(600, 800, '#3c3') }]);
        await pg.fill('#p-date', '2026-09-01'); await pg.fill('#p-note', 'smoke start'); await pg.click('#p-form button[type=submit]');
        await pg.waitForFunction(() => /Added 2 photos/.test(document.querySelector('#p-list').textContent), null, { timeout: 10000 });
        /* a camera JPEG: its EXIF DateTimeOriginal (1 October) beats the date in the form, which is only for photos without one */
        const jpg = Buffer.from(await pg.evaluate(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 800;
          const g = c.getContext('2d'); g.fillStyle = '#33c'; g.fillRect(0, 0, 600, 800); return c.toDataURL('image/jpeg').split(',')[1]; }), 'base64');
        const when = Buffer.from('2026:10:01 07:45:00\0', 'latin1');                 /* TIFF, little-endian: IFD0 → Exif IFD → DateTimeOriginal */
        const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x69, 0x87, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0,
          1, 0, 0x03, 0x90, 2, 0, when.length, 0, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0]), when]);
        const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, tiff.length + 8]), Buffer.from('Exif\0\0', 'latin1'), tiff]);
        await pg.uncheck('#p-exif'); await pg.check('#p-exif');
        await pg.setInputFiles('#p-file', { name: 'later.jpg', mimeType: 'image/jpeg', buffer: Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]) });
        await pg.waitForFunction(() => /Taken on (1 Oct|Oct 1)\b/.test(document.querySelector('#p-pick').textContent), null, { timeout: 5000 });
        await pg.fill('#p-date', '2026-09-20'); await pg.click('#p-form button[type=submit]');
        await pg.waitForFunction(() => /Added 1 photo /.test(document.querySelector('#p-list').textContent), null, { timeout: 10000 });
        const big = await pg.evaluate(async () => (await api('GET', '/api/photos')).photos.find(p => p.note === 'smoke start'));
        expect(big && big.tv && big.size < 1500000, 'uploaded photo should be shrunk and have a thumbnail');
        expect(big.pose === 'other' && !(await pg.locator('#p-pose').count()), 'without AI there is no pose to pick on upload and photos go in as Other');
      }
      expect(await pg.locator('#p-list .pday').count() === 2 && await pg.locator('#p-list .ptile').count() === 3, 'catalog should show 3 photos over 2 days');
      await pg.waitForFunction(() => [...document.querySelectorAll('#p-list .ptile img')].every(i => i.complete && i.naturalWidth > 0), null, { timeout: 5000 });
      expect(/85 kg/.test(await pg.textContent('#p-d-2026-09-01 h3')), 'a day should show its weigh-in');
      const pscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(pscroll <= 1, `horizontal overflow of ${pscroll}px on the photos page at ${w}px wide`);
      await pg.click('#p-d-2026-09-01 .ptile >> nth=0'); await pg.waitForSelector('#p-eform');
      await pg.waitForFunction(() => { const i = document.querySelector('.pbig img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 });
      if (w > 600) {
        /* the mouse wheel zooms in on the photo, dragging moves the zoomed view, a double-click goes back */
        const zb = await pg.locator('.pzoom').boundingBox(), zx = zb.x + zb.width / 2, zy = zb.y + zb.height / 2;
        const zt = () => pg.evaluate(() => document.querySelector('.pzoom img').style.transform);
        const tabs = pg.context().pages().length;
        await pg.mouse.move(zx, zy); await pg.mouse.wheel(0, -400);
        await pg.waitForFunction(() => /scale\((?!1\))/.test(document.querySelector('.pzoom img').style.transform));
        const z1 = await zt();
        await pg.mouse.down(); await pg.mouse.move(zx + 40, zy + 30, { steps: 4 }); await pg.mouse.up();
        const z2 = await zt();
        expect(z2 !== z1 && /scale/.test(z2), `dragging the zoomed photo should move it: ${z1} → ${z2}`);
        expect(pg.context().pages().length === tabs, 'dragging the zoomed photo should not open it in a new tab');
        await pg.mouse.dblclick(zx, zy);
        expect(await zt() === '', 'a double-click should show the whole photo again');
        await pg.mouse.move(0, 0);
      }
      if (!first) {
        /* AI is set up by now (the key saved on the Admin page in the first pass); the AI's answer is faked here */
        await pg.route('**/api/photos/*/ai-pose', r => r.fulfill({ json: { pose: 'left', style: 'relaxed', model: 'test/vision', photo: {} } }));
        expect(await pg.locator('#p-epose').inputValue() !== 'left', 'the photo should not start as left side');
        await pg.click('[data-pa=aione]');
        await pg.waitForFunction(() => document.querySelector('#p-epose').value === 'left' && document.querySelector('#p-estyle').value === 'relaxed' &&
          /AI says Side – Left · Relaxed/.test(document.querySelector('#p-aisay').textContent), null, { timeout: 5000 });
        await pg.selectOption('#p-epose', 'front'); await pg.selectOption('#p-estyle', 'front_double_biceps');
      }
      await pg.fill('#p-enote', 'smoke edited ' + w); await pg.click('#p-eform button[type=submit]');
      await pg.waitForFunction(() => /Saved/.test((document.querySelector('#p-list') || {}).textContent || ''), null, { timeout: 5000 });
      if (!first) expect(/Front · Double biceps/.test(await pg.textContent('#p-list')), 'the catalog should show the pose type picked');
      if (first) {
        /* the pose type drops the way the body faces when the pose says it; an older plain Side counts as untagged */
        const l = await pg.evaluate(() => [pLabel({ pose: 'back', style: 'back_double_biceps' }), pLabel({ pose: 'other', style: 'back_double_biceps' }),
          pLabel({ pose: 'right', style: 'relaxed' }), pUntagged({ pose: 'side', style: 'relaxed', poseAi: false })]);
        expect(l.join('|') === 'Back · Double biceps|Other · Back double biceps|Side – Right · Relaxed|true', `photo labels: ${l.join(' | ')}`);
      }
      /* bodyweight: the latest weigh-in is today's 80.5 kg, so only 1 October (80.4) is within 1 kg; then 85 kg finds 1 September */
      await pg.check('#p-near');
      await pg.waitForFunction(() => document.querySelectorAll('#p-list .pday').length === 1 && document.querySelector('#p-d-2026-10-01'));
      await pg.fill('#p-nearkg', '85');
      await pg.waitForFunction(() => document.querySelectorAll('#p-list .pday').length === 1 && document.querySelector('#p-d-2026-09-01'));
      await pg.fill('#p-nearkg', ''); await pg.uncheck('#p-near');
      await pg.waitForFunction(() => document.querySelectorAll('#p-list .pday').length === 2);
      expect(first === !(await pg.locator('#p-aibtn').count()), '"Tag poses with AI" only once AI is set up');
      if (!first) expect(await pg.locator('#p-pose').inputValue() === 'other' && await pg.locator('#p-pose option[value=ai]').count() === 1,
        'with AI set up, "Let AI tell" is offered on upload but not picked: nothing goes to the AI unless asked');
      if (!first) {
        /* the photos went in with AI off (no pose picked), so they're left for the AI; only the one whose pose was set by
           hand above is asked about – "leave it" tags the rest. The faked AI keeps each pose, so later steps see the same photos. */
        await pg.unroute('**/api/photos/*/ai-pose');
        await pg.route('**/api/photos/*/ai-pose', async r => {
          const id = +r.request().url().match(/photos\/(\d+)\/ai-pose/)[1];
          const ph = await pg.evaluate(id => PHOTOS.find(x => x.id === id), id);
          await r.fulfill({ json: { pose: ph.pose, model: 'test/vision', photo: { ...ph, poseAi: true } } });
        });
        const asked = [], answer = d => { asked.push(d.message()); return asked.length === 1 ? d.dismiss() : d.accept(); };
        pg.on('dialog', answer); await pg.click('#p-aibtn');
        await pg.waitForFunction(() => /The AI looked at \d+ photo/.test(document.querySelector('#p-list').textContent), null, { timeout: 5000 });
        pg.off('dialog', answer);
        expect(/1 of the \d+ photos shown has a pose you set yourself/.test(asked[0]), `"Tag poses with AI" should ask about the one pose set by hand, asked: ${asked[0]}`);
        /* "Tag only untagged" leaves out every photo that has a pose already – here the one set by hand – and doesn't ask about it */
        const untagged = await pg.evaluate(() => PHOTOS.filter(p => pShown().includes(p) && (p.poseAi && p.pose === 'other' && !p.style || p.pose === 'side')).map(p => p.id));
        const sent = [], seen = r => { const m = r.url().match(/photos\/(\d+)\/ai-pose/); if (m) sent.push(+m[1]); };
        const asked2 = [], ok = d => { asked2.push(d.message()); return d.accept(); };
        await pg.evaluate(() => { document.querySelector('#p-list .fmsg')?.remove(); });
        pg.on('request', seen); pg.on('dialog', ok); await pg.click('#p-aiuntag');
        await pg.waitForFunction(() => /The AI looked at \d+ photo/.test(document.querySelector('#p-list').textContent), null, { timeout: 5000 });
        pg.off('dialog', ok); pg.off('request', seen);
        expect(untagged.length > 0 && asked2.length === 1 && new RegExp(`these ${untagged.length} photos|this photo`).test(asked2[0]), `"Tag only untagged" should ask once about the ${untagged.length} untagged photos, asked: ${asked2.join(' | ')}`);
        expect(sent.sort().join() === untagged.sort().join(), `"Tag only untagged" should send only the untagged photos: sent ${sent}, untagged ${untagged}`);
      }
      if (!first) {
        /* "Ask AI for the pose" on one photo, then on to another before the answer comes: it must not land on the other photo */
        await pg.unroute('**/api/photos/*/ai-pose');
        const [pa, pb] = await pg.evaluate(() => { const l = pShown(); return [l[0], l[1]]; });
        await pg.route('**/api/photos/*/ai-pose', async r => { await new Promise(ok => setTimeout(ok, 1200));
          await r.fulfill({ json: { pose: 'other', style: 'most_muscular', model: 'test/vision', photo: pa } }).catch(() => {}); });
        await pg.evaluate(id => { location.hash = '#photos/' + id; }, pa.id); await pg.waitForSelector(`#p-eform[data-id="${pa.id}"] [data-pa=aione]`);
        await pg.click('[data-pa=aione]');
        await pg.evaluate(id => { location.hash = '#photos/' + id; }, pb.id); await pg.waitForSelector(`#p-eform[data-id="${pb.id}"]`);
        await pg.waitForTimeout(1800);
        expect(await pg.inputValue('#p-epose') === pb.pose && await pg.inputValue('#p-estyle') === (pb.style || '') && await pg.textContent('#p-aisay') === '',
          'an AI pose answer for one photo should be dropped once another photo is open');
        await pg.unroute('**/api/photos/*/ai-pose');
        await pg.evaluate(() => { location.hash = '#photos'; }); await pg.waitForSelector('#p-jump');
      }
      await pg.fill('#p-jump', '2026-09-04'); await pg.waitForSelector('#p-d-2026-09-01.hit');
      /* pick two photos in the catalog and compare them, older on the left */
      await pg.click('#p-selbtn'); await pg.waitForSelector('#p-selbar:not([hidden])');
      await pg.click('#p-d-2026-10-01 .ptile'); await pg.click('#p-d-2026-09-01 .ptile >> nth=0');
      expect(await pg.locator('#p-list .ptile.on').count() === 2, 'two photos should be picked');
      await pg.click('[data-pa=cmpgo]'); await pg.waitForSelector('#p-cmp .pside');
      await pg.waitForFunction(() => document.querySelectorAll('#p-cmp .pside img').length === 2 && /30 days apart · -4\.6 kg/.test(document.querySelector('#p-cmpsum').textContent), null, { timeout: 5000 });
      expect(/Sep/.test(await pg.textContent('#p-cmp .pside >> nth=0')), 'the older photo should be on the left');
      const cmpscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(cmpscroll <= 1, `horizontal overflow of ${cmpscroll}px on the photo compare page at ${w}px wide`);
      const cmpUrl = pg.url();
      if (w > 600) {
        /* each side zooms on its own; dragging a zoomed side moves it and doesn't open that photo */
        await pg.waitForFunction(() => [...document.querySelectorAll('#p-cmp .pzoom img')].every(i => i.complete && i.naturalWidth > 0), null, { timeout: 5000 });
        const cb = await pg.locator('#p-cmp .pzoom >> nth=0').boundingBox(), cx = cb.x + cb.width / 2, cy = cb.y + cb.height / 2;
        const ct = () => pg.evaluate(() => [...document.querySelectorAll('#p-cmp .pzoom img')].map(i => i.style.transform));
        await pg.mouse.move(cx, cy); await pg.mouse.wheel(0, -400);
        await pg.waitForFunction(() => /scale/.test(document.querySelector('#p-cmp .pzoom img').style.transform));
        const [c1] = await ct();
        await pg.mouse.down(); await pg.mouse.move(cx - 40, cy - 30, { steps: 4 }); await pg.mouse.up();
        const [c2, r2] = await ct();
        expect(c2 !== c1 && /scale/.test(c2) && r2 === '', `dragging the zoomed left photo should move only it: ${c1} → ${c2}, right ${r2}`);
        expect(pg.url() === cmpUrl, 'dragging a zoomed compare photo should not open it');
        await pg.mouse.dblclick(cx, cy);
        expect((await ct())[0] === '' && pg.url() === cmpUrl, 'a double-click should show the whole photo again and stay on Compare');
        await pg.mouse.move(0, 0);
      }
      await pg.click('#p-cmp .pside >> nth=0 >> [data-pa=match]'); await pg.waitForFunction(() => document.querySelectorAll('#p-cmp .pside img').length === 2);
      const other = await pg.evaluate(() => [...document.querySelectorAll('#p-ca option')].find(o => !o.selected && !/Oct/.test(o.textContent)).value);
      await pg.selectOption('#p-ca', other); await pg.waitForFunction(u => location.href !== u, cmpUrl);
      await pg.waitForFunction(() => document.querySelectorAll('#p-cmp .pside img').length === 2);
      /* timeline: the trend chart, switching metrics on and off, a followed supplement, a day's card from the chart and from a date */
      await pg.click('a[data-view=history]'); await pg.click('#v-history .htabs [data-h=timeline]'); await pg.waitForSelector('#v-timeline:not([hidden]) #t-chart svg', { timeout: 5000 });
      expect(await pg.getAttribute('a[data-view=history]', 'aria-current') === 'page' && await pg.getAttribute('#v-timeline .htabs [data-h=timeline]', 'aria-current') === 'page', 'the Timeline should be a tab of History');
      const marks = () => pg.locator('#t-chart .tl, #t-chart .td').count();
      const sup = '#t-metrics [data-k="sup:smoke creatine"]';
      expect(await pg.locator(sup).count() === 1, 'a supplement with Trend ticked should be a metric');
      const m0 = await marks();
      await pg.click(sup); await pg.waitForFunction(n => document.querySelectorAll('#t-chart .tl, #t-chart .td').length > n, m0);
      expect(await pg.getAttribute(sup, 'aria-pressed') === 'true', 'the metric should show as on');
      /* exercise e1RM lines only when picked: the first run picks one in the exercise picker, the second clears it */
      const exChip = '#t-metrics [data-k^="ex:"]';
      expect(await pg.locator(exChip).count() === (first ? 0 : 1), 'only picked exercises should be metrics');
      await pg.click('#t-expick > summary'); await pg.waitForSelector('#t-exlist label');
      const exScroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(exScroll <= 1, `horizontal overflow of ${exScroll}px with the exercise picker open at ${w}px wide`);
      if (first) await pg.check('#t-exlist label:has-text("Atlantis hack squat") input'); else await pg.click('[data-ta=exnone]');
      await pg.click('[data-ta=exsave]');
      await pg.waitForFunction(n => document.querySelectorAll('#t-metrics [data-k^="ex:"]').length === n, first ? 1 : 0, { timeout: 5000 });
      if (first) expect(await pg.getAttribute(exChip, 'aria-pressed') === 'true', 'a newly picked exercise should be switched on');
      await pg.click('#t-metrics [data-k=vol]'); await pg.uncheck('#t-smooth'); await pg.waitForSelector('#t-chart svg');
      expect(await pg.isDisabled('#t-aibtn') === first, 'AI summary needs an API key (saved on the Admin page in the first run)');
      const tscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(tscroll <= 1, `horizontal overflow of ${tscroll}px on the timeline at ${w}px wide`);
      await pg.hover('#t-hit'); await pg.waitForSelector('#t-tip:not([hidden])');
      await pg.click('#t-hit'); await pg.waitForSelector('#t-card[open] .tcgrid', { timeout: 5000 });
      expect(/^#history\/timeline\/\d{4}-\d\d-\d\d$/.test(await pg.evaluate(() => location.hash)), 'a point on the chart should open its day');
      await pg.click('#t-card [data-ta=close]'); await pg.waitForFunction(() => !document.querySelector('#t-card').open && location.hash === '#history/timeline');
      await pg.click('#t-pick [data-ta=go] >> nth=0'); await pg.waitForSelector('#t-card[open] .tcfood .stat', { timeout: 5000 });
      const card = await pg.textContent('#t-card');
      expect(/Smoke creatine/.test(card) && /Atlantis hack squat/.test(card) && /e1RM/.test(card) && /80\.5/.test(card), 'today’s card should show supplements, gym sets and weight');
      expect(await pg.locator('#t-card .tcphotos .ptile').count() >= 1, 'the card should show the latest photos');
      const dscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(dscroll <= 1, `horizontal overflow of ${dscroll}px with the day card open at ${w}px wide`);
      const t0 = await pg.textContent('#t-ctitle');
      await pg.click('#t-card [data-ta=cmove][data-n="-1"]'); await pg.waitForFunction(t => document.querySelector('#t-ctitle').textContent !== t, t0);
      await pg.keyboard.press('Escape'); await pg.waitForFunction(() => !document.querySelector('#t-card').open && location.hash === '#history/timeline');
      await pg.evaluate(() => { location.hash = '#timeline'; }); await pg.waitForFunction(() => location.hash === '#history/timeline' && !document.querySelector('#v-timeline').hidden);
      /* coach link: made on Account admin, opened with no sign-in (read only: no edit controls, no AI), then switched off */
      await pg.click('#acct>summary'); await pg.click('#accountlink'); await pg.waitForSelector('#v-admin:not([hidden]) #ad-share');
      await pg.fill('#ad-sh-label', 'Smoke coach'); await pg.selectOption('#ad-sh-for', 'date');
      expect(!(await pg.isHidden('#ad-sh-until')), 'picking "Until a date" should show a date field');
      await pg.fill('#ad-sh-until', '2020-01-01');   /* a past date left in the hidden field mustn't hold up "Make link" */
      await pg.selectOption('#ad-sh-for', 'h24'); await pg.click('#ad-sh-btn');
      await pg.waitForSelector('#ad-sh-link', { timeout: 5000 });
      const coachUrl = await pg.inputValue('#ad-sh-link');
      expect(/\/coach\/[A-Za-z0-9_-]{43}$/.test(coachUrl) && /Smoke coach/.test(await pg.textContent('#ad-shares')), 'a coach link should be made and listed');
      const cctx = await browser.newContext({ viewport: { width: w, height: h } }), cp = await cctx.newPage();
      cp.on('pageerror', e => errs.push('coach: ' + e.message));
      let coachOff = false;   /* once switched off, the link's 404 is expected */
      cp.on('console', m => { if (m.type() === 'error' && !coachOff) errs.push('coach: ' + m.text() + ' ' + JSON.stringify(m.location())); });
      await cp.goto(coachUrl); await cp.waitForSelector('#c-main:not([hidden]) #t-chart svg', { timeout: 5000 });
      expect(/smoke’s logbook/.test(await cp.textContent('#c-who')) && /Smoke coach/.test(await cp.textContent('#c-until')), 'the coach page should say whose logbook it is');
      expect(await cp.locator('#c-days .cday').count() === 14 && /80\.5 kg/.test(await cp.textContent('#c-days')), 'the coach page should list recent days with weight');
      expect(!(await cp.locator('#t-aibtn, #t-expick, .tclink, input[type=number]').count()), 'the coach page should have nothing to edit');
      await cp.click('#c-days .cday >> nth=0'); await cp.waitForFunction(() => document.querySelector('#t-card').open && /Atlantis hack squat/.test(document.querySelector('#t-card').textContent), null, { timeout: 5000 });
      expect(await cp.locator('#t-card .tcphotos .ptile img').count() >= 1, 'the coach should see the latest photos');
      await cp.waitForFunction(() => [...document.querySelectorAll('#t-card .tcphotos img')].every(i => i.complete && i.naturalWidth > 0), null, { timeout: 5000 });
      const coachScroll = await cp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(coachScroll <= 1, `horizontal overflow of ${coachScroll}px on the coach page at ${w}px wide`);
      await cp.keyboard.press('Escape');
      pg.once('dialog', d => d.accept()); await pg.click('#ad-shares [data-sh=off]');
      await pg.waitForFunction(() => !document.querySelector('#ad-shares [data-sh=off]'), null, { timeout: 5000 });
      coachOff = true; await cp.reload(); await cp.waitForSelector('#c-gone:not([hidden])', { timeout: 5000 });
      await cctx.close();
      /* account admin: your own plan, changed here */
      await pg.click('#acct>summary'); await pg.click('#accountlink'); await pg.waitForSelector('#v-admin.mine:not([hidden]) #ad-meals .admeal');
      expect(await pg.isHidden('#ad-tabs') && await pg.isHidden('#ad-aipanel') && await pg.isHidden('#ad-uh'), 'account admin has no super admin parts');
      if (first) {
        /* the protein driver can be switched here too: saved straight away, survives a reload, then back to total */
        const pbasis = () => pg.evaluate(() => fetch('/api/settings').then(r => r.json()).then(s => s.pBasis || 'total'));
        await pg.click('#ad-pbasis [data-v=direct]');
        const pbWait = async v => { for (let t = Date.now(); Date.now() - t < 5000 && await pbasis() !== v;) await pg.waitForTimeout(200); };
        await pbWait('direct');
        expect(await pbasis() === 'direct', 'direct protein picked on account admin should be saved');
        expect(await pg.getAttribute('#ad-pbasis [data-v=direct]', 'aria-pressed') === 'true', 'account admin shows direct protein picked');
        await pg.reload(); await pg.waitForSelector('#v-admin.mine:not([hidden]) #ad-meals .admeal');
        expect(await pg.getAttribute('#ad-pbasis [data-v=direct]', 'aria-pressed') === 'true', 'direct protein from account admin should survive reload');
        await pg.click('#ad-pbasis [data-v=total]');
        await pbWait('total');
        expect(await pbasis() === 'total', 'protein basis back to total');
        await pg.setInputFiles('#ad-file', { name: 'plan.csv', mimeType: 'text/csv', buffer: Buffer.from(
          'day_type,meal,meal_name,box,food,grams,locked\nrest,1,Smoke bowl,protein,whey,40,yes\nrest,1,Smoke bowl,carbs,Banana (peeled),150,\n') });
        await pg.waitForFunction(() => /Loaded Rest from plan\.csv/.test(document.querySelector('#ad-upmsg').textContent), null, { timeout: 5000 });
        await pg.selectOption('#ad-wd-0', 'R');
        await pg.click('.adfood[data-id=banana] summary'); await pg.fill('#ad-fd-banana-k', '90');
        /* a new day template without uploading anything: Rest copied as a refeed day, renamed, more carbs, on Sundays */
        await pg.click('#ad-types [data-t=R]'); await pg.click('[data-ad=tdup]');
        await pg.fill('#ad-tn', 'Refeed day'); await pg.press('#ad-tn', 'Tab');
        const rf = await pg.evaluate(() => adType);
        expect(/Refeed day/.test(await pg.textContent('#ad-types')) && await pg.inputValue('#ad-mn-0') === 'Smoke bowl', 'the copy should have the rest day meals');
        await pg.fill(`#ad-tg-${rf}-c`, '420');
        await pg.selectOption('#ad-wd-6', rf);
        await pg.click('#ad-save');
        await pg.waitForFunction(() => /Saved/.test(document.querySelector('#ad-status').textContent), null, { timeout: 5000 });
        expect(/5 day templates/.test(await pg.textContent('#ad-planstate')), 'the new template should be saved with the plan');
        /* a plan file is shown before the server checks it: markup in any value must stay text (RC-09) */
        const tag = n => `"><img id="PR-PROBE-${n}" src="x">`;
        const probe = { templates: [{ id: 'R', name: 'Rest' + tag('tname') }, { id: 'Q' + tag('tid'), name: 'Bad' }],
          foods: { banana: { n: 'Banana' + tag('fname'), k: '90' + tag('k'), unit: 'g' + tag('unit'), group: 'c' + tag('group') }, ['x' + tag('fid')]: { n: 'x', k: 1 } },
          targets: { R: { k: '2500' + tag('target') } },
          plan: { R: [{ id: '1' + tag('mid'), name: 'Probe meal' + tag('mname'), note: tag('note'), p: [], c: [{ f: 'banana' + tag('item'), g: '1' + tag('g') }], x: [] }] } };
        await pg.click('#ad-types [data-t=R]');
        await pg.setInputFiles('#ad-file', { name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(probe)) });
        await pg.waitForFunction(() => /Loaded plan\.json/.test(document.querySelector('#ad-upmsg').textContent), null, { timeout: 5000 });
        await pg.click('.adfood[data-id=banana] summary');
        expect(await pg.inputValue('#ad-mn-0') === 'Probe meal"><img id="PR-PROBE-mname" src="x">', 'the probe plan should be loaded, its markup kept as text');
        expect(await pg.locator('[id^="PR-PROBE"]').count() === 0, 'markup in a plan file must not become page elements');
        await pg.click('#ad-discard');
        await pg.waitForFunction(() => /Saved/.test(document.querySelector('#ad-status').textContent), null, { timeout: 5000 });
        /* a semicolon plan CSV with a decimal comma keeps its columns and its half gram; a lone "1,500" is refused with the line, not guessed */
        const semi = g => Buffer.from(`day_type;meal;meal_name;box;food;grams;locked;note\nrest;1;Smoke bowl;protein;whey;${g};yes;\n`);
        await pg.setInputFiles('#ad-file', { name: 'semi.csv', mimeType: 'text/csv', buffer: semi('40,5') });
        await pg.waitForFunction(() => /Loaded Rest from semi\.csv/.test(document.querySelector('#ad-upmsg').textContent), null, { timeout: 5000 });
        expect(await pg.inputValue('#ad-g-0-p-0') === '40.5' && await pg.isChecked('#ad-l-0-p-0'), 'grams "40,5" should load as 40.5 with the lock kept');
        await pg.setInputFiles('#ad-file', { name: 'amb.csv', mimeType: 'text/csv', buffer: semi('1,500') });
        await pg.waitForFunction(() => /amb\.csv wasn’t loaded/.test(document.querySelector('#ad-upmsg').textContent), null, { timeout: 5000 });
        expect(/Line 2: amount "1,500" could be 1500 or 1\.500/.test(await pg.textContent('#ad-upmsg')), 'an ambiguous amount should be reported');
        await pg.click('#ad-discard');
        await pg.waitForFunction(() => /Saved/.test(document.querySelector('#ad-status').textContent), null, { timeout: 5000 });
        /* a JSON file with only meals (no template list) fills a template's meals and keeps its name (NEW-plan-01) */
        await pg.click('#ad-types [data-t=R]'); await pg.fill('#ad-tn', 'Smoke rest day'); await pg.press('#ad-tn', 'Tab');
        await pg.setInputFiles('#ad-file', { name: 'meals-only.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ plan: { R: [{ id: '1', name: 'Smoke only meals', p: [], c: [], x: [] }] } })) });
        await pg.waitForFunction(() => /Loaded meals-only\.json/.test(document.querySelector('#ad-upmsg').textContent), null, { timeout: 5000 });
        expect(await pg.evaluate(() => adTplName('R') === 'Smoke rest day' && AD.plan.R[0].name === 'Smoke only meals'), 'a meals-only file should keep the template’s name');
        /* contradictory food limits are refused before saving (PR-PL-042) */
        await pg.click('.adfood[data-id=banana] summary');
        await pg.fill('#ad-fd-banana-min', '300'); await pg.fill('#ad-fd-banana-max', '100'); await pg.fill('#ad-fd-banana-d', '50');
        await pg.click('#ad-save');
        await pg.waitForFunction(() => /min serving \(300\) is more than the max serving \(100\)/.test(document.querySelector('#ad-upmsg').textContent)
          && /direct protein \(50\) is more than its protein/.test(document.querySelector('#ad-upmsg').textContent), null, { timeout: 5000 });
        expect(/Unsaved/.test(await pg.textContent('#ad-status')), 'nothing should be saved with contradictory limits');
        await pg.click('#ad-discard');
        await pg.waitForFunction(() => /Saved/.test(document.querySelector('#ad-status').textContent), null, { timeout: 5000 });
        /* the plan CSV download keeps a value that starts like a formula as text */
        expect(JSON.stringify(await pg.evaluate(() => ['=HYPERLINK("x")', '+1', '-1', '@SUM(A1)', 'Oats, 80 g', 'plain'].map(csvCell)))
          === JSON.stringify(['"\'=HYPERLINK(""x"")"', "'+1", "'-1", "'@SUM(A1)", '"Oats, 80 g"', 'plain']), 'CSV cells starting with = + - @ get a leading apostrophe');
        /* the daily checklist: drop Cardio, add an item, save – the Dashboard follows; Weigh in and Supplements taken tick
           themselves from today's weight and supplement log */
        await pg.waitForSelector('#ad-cl .adclrow');
        expect(await pg.locator('#ad-cl .adclrow').count() === 7, 'the checklist editor starts with the default list');
        await pg.click('#ad-cl [data-cl=del][data-i="6"]');
        await pg.click('[data-cl=add]'); await pg.fill('#ad-cl input[data-cl=label][data-i="6"]', 'Smoke stretch');
        await pg.selectOption('#ad-cl select[data-cl=show][data-i="6"]', 'all');
        await pg.click('#ad-clsave'); await pg.waitForFunction(() => /Checklist saved/.test(document.querySelector('#ad-clmsg').textContent), null, { timeout: 5000 });
        const clScroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(clScroll <= 1, `horizontal overflow of ${clScroll}px on Account admin at ${w}px wide`);
        await pg.click('a[data-view=dash]'); await pg.waitForSelector('#v-dash:not([hidden]) .dcheck .dlist');
        const dtxt = await pg.textContent('.dcheck');
        expect(/Smoke stretch/.test(dtxt) && !/Cardio done/.test(dtxt), 'the dashboard should show the saved checklist');
        expect(await pg.isChecked('.dcheck input[data-dk=weigh]') && await pg.isDisabled('.dcheck input[data-dk=weigh]'), 'Weigh in should tick itself from today’s weight');
        expect(await pg.isChecked('.dcheck input[data-dk=supps]'), 'Supplements taken should tick itself from today’s supplement log');
        expect(/Smoke creatine/.test(await pg.textContent('#d-body')), 'the supplement regime card lists the library');
        await pg.click('#acct>summary'); await pg.click('#accountlink'); await pg.waitForSelector('#v-admin.mine:not([hidden]) #ad-meals .admeal');
        expect(/OpenRouter API key/.test(await pg.textContent('#ad-aistate')) && await pg.isDisabled('#ad-aifile'), 'PDF reading should be off without a key');
        /* your own security log: sign-ins and coach links, read only */
        await pg.waitForFunction(() => /Signed in/.test(document.querySelector('#ad-mylog').textContent) && /Coach link opened/.test(document.querySelector('#ad-mylog').textContent), null, { timeout: 5000 });
        /* super admin: no plan editor at all – AI, people and email in tabs */
        await pg.click('#acct>summary'); await pg.click('#adminlink');
        await pg.waitForSelector('#v-admin:not(.mine):not([hidden]) #ad-aipanel:not([hidden])');
        expect(await pg.isHidden('#ad-ph') && await pg.isHidden('.adbar') && await pg.isHidden('#ad-wh') && await pg.isHidden('#ad-fh'), 'super admin should have no plan editor');
        expect(/Not set up/.test(await pg.textContent('#ad-aikeystate')), 'AI should start not set up');
        await pg.fill('#ad-key', 'sk-or-v1-smoke-test-key'); await pg.click('#ad-keyform button[type=submit]');
        await pg.waitForFunction(() => /Set up/.test(document.querySelector('#ad-aikeystate').textContent), null, { timeout: 5000 });
        await pg.fill('#ad-tm-food', 'openai/gpt-4o-mini'); await pg.click('#ad-modelform button[type=submit]');
        await pg.waitForFunction(() => /Models saved/.test(document.querySelector('#ad-keymsg').textContent), null, { timeout: 5000 });
        expect(await pg.inputValue('#ad-tm-food') === 'openai/gpt-4o-mini' && await pg.inputValue('#ad-tm-plan') === '', 'each task keeps its own model');
        /* invite someone: email isn't set up, so the link is shown to pass on; accept it in a fresh phone-sized browser */
        await pg.click('#ad-tabs [data-adt=people]'); await pg.waitForSelector('[data-adtab=people]:not([hidden]) #ad-users .aduser');
        await pg.click('#ad-tabs [data-adt=email]'); await pg.waitForSelector('[data-adtab=email]:not([hidden])');
        expect(/Not set up/.test(await pg.textContent('#ad-mailstate')), 'email should start not set up');
        expect(await pg.inputValue('#ad-m-host') === 'smtp.gmail.com', 'Gmail should be the default email server');
        /* with .env settings, Save sends only what was changed (the rest stays from .env) and says where each value comes from */
        const am = await pg.evaluate(() => {
          const keep = AM;
          AM = { configured: true, source: 'env', host: 'smtp.example.com', port: 587, secure: false, user: '', hasPassword: true, passwordSource: 'env',
            from: 'env@example.com', fromName: 'Logbook Monster', sources: { host: 'env', port: 'env', secure: null, user: null, pass: 'env', from: 'env', fromName: null } };
          amFill(); $('#ad-m-pass').value = 'new-pass';
          const one = amBody(), state = $('#ad-mailstate').textContent, tls = $('#ad-m-tls').value;
          $('#ad-m-port').value = '465'; $('#ad-m-port').dispatchEvent(new Event('input'));
          const two = amBody();
          AM = keep; amFill();
          return { one, two, state, tls };
        });
        expect(JSON.stringify(am.one) === '{"pass":"new-pass"}', 'only the typed password should be sent: ' + JSON.stringify(am.one));
        expect(am.tls === '0' && am.two.port === 465 && am.two.secure === true, 'the TLS choice should follow a changed port: ' + JSON.stringify(am.two));
        expect(/From \.env: server, port, password, send-from address\./.test(am.state), 'the state should say which values come from .env: ' + am.state);
        /* saving email settings updates the note on People without a reload */
        await pg.click('#ad-tabs [data-adt=people]'); await pg.waitForSelector('[data-adtab=people]:not([hidden])');
        expect(/Email isn’t set up yet/.test(await pg.textContent('#ad-ivmsg')), 'People should say email isn’t set up');
        await pg.click('#ad-tabs [data-adt=email]'); await pg.waitForSelector('[data-adtab=email]:not([hidden])');
        await pg.route('**/api/admin/email', r => (r.request().method() === 'PUT' ? r.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ configured: true, source: 'admin', host: 'smtp.gmail.com', port: 465, secure: true, user: '', hasPassword: true, passwordSource: 'admin',
            from: 'smoke@example.com', fromName: 'Logbook Monster', sources: { host: 'admin', port: 'admin', secure: 'admin', user: null, pass: 'admin', from: 'admin', fromName: null } }) }) : r.continue()));
        await pg.fill('#ad-m-from', 'smoke@example.com'); await pg.fill('#ad-m-pass', 'smoke-app-pass'); await pg.click('#ad-mailform button[type=submit]');
        await pg.waitForFunction(() => /Email settings saved/.test(document.querySelector('#ad-mailmsg').textContent), null, { timeout: 5000 });
        await pg.unroute('**/api/admin/email');
        await pg.click('#ad-tabs [data-adt=people]'); await pg.waitForSelector('[data-adtab=people]:not([hidden])');
        expect(!/Email isn’t set up yet/.test(await pg.textContent('#ad-ivmsg')), 'People should drop the email note once email is saved');
        await pg.evaluate(() => amLoad());
        await pg.click('#ad-tabs [data-adt=people]'); await pg.waitForSelector('[data-adtab=people]:not([hidden])');
        await pg.fill('#ad-iv-email', 'guest@example.com'); await pg.click('#ad-iv-btn');
        await pg.waitForSelector('#ad-iv-link', { timeout: 5000 });
        const link = await pg.inputValue('#ad-iv-link');
        expect(/Invite sent/.test(await pg.textContent('#ad-users')), 'invited person should be listed as invited');
        /* Remove refused as gone (removed in another tab): the list is fetched again */
        let reloads = 0; const onReq = r => { if (r.method() === 'GET' && /\/api\/admin\/users$/.test(r.url())) reloads++; };
        const onDlg = dg => dg.accept();
        pg.on('request', onReq); pg.on('dialog', onDlg); const errsAt = errs.length;
        await pg.route('**/api/admin/users/*', r => (r.request().method() === 'DELETE' ? r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"No such account"}' }) : r.continue()));
        await pg.click('#ad-users .aduser:has-text("guest@example.com") [data-au=remove]');
        for (let i = 0; i < 50 && !reloads; i++) await pg.waitForTimeout(100);
        await pg.unroute('**/api/admin/users/*'); pg.off('request', onReq); pg.off('dialog', onDlg);
        expect(reloads > 0, 'a refused Remove (404) should reload the accounts');
        errs.push(...errs.splice(errsAt).filter(m => !/status of 404/.test(m)));   /* the browser logs the 404 asked for */
        /* the security log tab: newest first, filtered by event */
        await pg.click('#ad-tabs [data-adt=log]'); await pg.waitForSelector('[data-adtab=log]:not([hidden]) #ad-log .aduser', { timeout: 5000 });
        expect(/Invite made/.test(await pg.textContent('#ad-log .aduser >> nth=0')) && /AI settings changed/.test(await pg.textContent('#ad-log')), 'the security log should list the invite and the AI key change');
        await pg.selectOption('#ad-lg-ev', 'ai.settings');
        await pg.waitForFunction(() => [...document.querySelectorAll('#ad-log .aduser b')].every(b => b.textContent === 'AI settings changed'), null, { timeout: 5000 });
        expect(!/sk-or-v1-smoke/.test(await pg.textContent('#ad-log')), 'the key is never in the log');
        await pg.selectOption('#ad-lg-ev', '');
        const gctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const gp = await gctx.newPage();
        gp.on('pageerror', e => errs.push('invite page: ' + e.message));
        await gp.goto(link); await gp.waitForSelector('#form:not([hidden])', { timeout: 5000 });
        expect(/guest@example\.com/.test(await gp.textContent('#intro')), 'invite page should name the invited email');
        await gp.fill('#password', 'guest-password-1'); await gp.click('#submit');
        /* the guest starts with no plan – nothing of the super admin's – and the default checklist */
        await gp.waitForSelector('#v-dash:not([hidden]) .dcheck .dlist', { timeout: 5000 });
        expect(/No meal plan yet/.test(await gp.textContent('#d-body')) && await gp.locator('.dcheck input[data-dk]:checked').count() === 0, 'a new account’s dashboard is empty');
        await gp.click('a[data-view=day]');
        await gp.waitForSelector('#v-day:not([hidden]) #meals .noplan', { timeout: 5000 });
        expect(await gp.locator('#meals .meal').count() === 0, 'a new account should have no meals');
        expect(await gp.isHidden('#pudpanel') && await gp.isHidden('#ft-pud'), 'no rice pudding panel or note without pudding in the plan');
        expect(await gp.evaluate(() => pudUsed({ meals: [], off: [{ snack: 'pudding' }] })), 'a day with rice pudding shows the batch panel');
        expect(await gp.isHidden('#adminlink'), 'super admin link should be hidden for other accounts');
        /* Super admin, for someone who isn't one: a page that says so (it used to open the Daily Tracker without a word) */
        await gp.evaluate(() => { location.hash = '#admin'; });
        await gp.waitForSelector('#v-none:not([hidden])', { timeout: 5000 });
        expect(/Super admin is for the app’s admins/.test(await gp.textContent('#none-h')) && await gp.isHidden('#v-admin'), 'Super admin should say it is for admins');
        expect(/^Super admin – not available – Logbook Monster$/.test(await gp.title()), 'the title says so too: ' + await gp.title());
        expect(await gp.getAttribute('#v-none .ghost', 'href') === '#account', 'it points to Account admin');
        await gp.click('a[data-view=day]'); await gp.waitForSelector('#v-day:not([hidden]) #meals .noplan', { timeout: 5000 });
        await gp.click('#meals .noplan a.btn');
        await gp.waitForSelector('#v-admin.mine:not([hidden]) #ad-planstate', { timeout: 5000 });
        expect(/No plan yet/.test(await gp.textContent('#ad-planstate')) && await gp.locator('#ad-foods .adfood').count() === 0, 'the guest should have no plan and no foods');
        expect(await gp.isHidden('#ad-uh') && await gp.isHidden('#ad-eh') && await gp.isHidden('#ad-aipanel') && await gp.isHidden('#ad-tabs'), 'people, email and the AI settings are super admin only');
        /* build a plan by hand: two foods, a training template with a meal, then a rest template */
        for (const [n, g, k, p, c, f] of [['Chicken thigh', 'p', '180', '25', '0', '9'], ['Rice', 'c', '130', '2.7', '28', '0.3'], ['Salsa', 'c', '36', '1.5', '7', '0.2']]) {
          await gp.fill('#ad-nf-n', n); await gp.selectOption('#ad-nf-g', g);
          await gp.fill('#ad-nf-k', k); await gp.fill('#ad-nf-p', p); await gp.fill('#ad-nf-c', c); await gp.fill('#ad-nf-f', f);
          await gp.click('#ad-addfood button[type=submit]');
        }
        await gp.selectOption('#ad-fd-salsa-free', 'sauce');
        await gp.click('[data-ad=tadd]'); await gp.fill('#ad-tn', 'Training'); await gp.press('#ad-tn', 'Tab');
        const tr = await gp.evaluate(() => adType);
        await gp.selectOption('#ad-a-0-p', 'chicken_thigh'); await gp.fill('#ad-g-0-p-0', '200');
        await gp.selectOption('#ad-a-0-c', 'rice'); await gp.selectOption('#ad-a-0-c', 'salsa');
        for (const [m, v] of [['k', '2400'], ['p', '180'], ['c', '250'], ['f', '70']]) await gp.fill(`#ad-tg-${tr}-${m}`, v);
        await gp.click('[data-ad=tadd]'); await gp.fill('#ad-tn', 'Rest'); await gp.press('#ad-tn', 'Tab');
        const rs = await gp.evaluate(() => adType);
        expect(await gp.inputValue('#ad-wd-0') === tr && await gp.inputValue(`#ad-tg-${rs}-k`) === '2400', 'the first template is every day’s, a new one takes its targets');
        await gp.click('#ad-save');
        await gp.waitForFunction(() => /Saved/.test(document.querySelector('#ad-status').textContent), null, { timeout: 5000 });
        /* free foods: tick sauces free, save, and the salsa stops counting */
        expect(!(await gp.isChecked('#ad-free-sauce')) && !(await gp.isChecked('#ad-free-veg')), 'sauces and green veg should count to start with');
        await gp.check('#ad-free-sauce');
        expect(/Unsaved/.test(await gp.textContent('#ad-status')), 'ticking free sauces should be an unsaved change');
        await gp.click('#ad-save');
        await gp.waitForFunction(() => /Saved/.test(document.querySelector('#ad-status').textContent), null, { timeout: 5000 });
        expect(await gp.isChecked('#ad-free-sauce') && await gp.evaluate(() => FREE.sauce && macOf('salsa', 200).k === 0), 'free sauces should be saved and applied');
        /* a change that takes effect later: Mondays are rest days from 2031, days before keep training */
        await gp.selectOption('#ad-wd-0', rs); await gp.fill('#ad-from', FROM); await gp.click('#ad-save');
        await gp.waitForFunction(() => /Scheduled/.test(document.querySelector('#ad-versions').textContent) && /Saved/.test(document.querySelector('#ad-status').textContent), null, { timeout: 5000 });
        /* a plan change emptied of everything asks first, then says "No plan from …" – not "Saved" (PR-PL-029) */
        const NOPLAN = later(21);
        await gp.evaluate(() => { AD.templates = []; AD.plan = {}; AD.targets = {}; AD.foods = {}; renderAdmin(); });
        await gp.fill('#ad-from', NOPLAN); await gp.press('#ad-from', 'Tab');
        let asked = ''; gp.once('dialog', d => { asked = d.message(); d.dismiss(); }); await gp.click('#ad-save');
        expect(/no day templates or foods/.test(asked) && /Unsaved/.test(await gp.textContent('#ad-status')), 'saving an empty plan should ask first; No keeps it unsaved');
        gp.once('dialog', d => d.accept()); await gp.click('#ad-save');
        await gp.waitForFunction(() => /No plan from/.test(document.querySelector('#ad-status').textContent), null, { timeout: 5000 });
        expect(!/Saved/.test(await gp.textContent('#ad-status')) && /No plan/.test(await gp.textContent('#ad-versions')), 'an empty plan change should say "No plan from …"');
        gp.once('dialog', d => d.accept()); await gp.click(`[data-ad=vdel][data-from="${NOPLAN}"]`);
        await gp.waitForFunction(d => !document.querySelector(`[data-ad=vdel][data-from="${d}"]`), NOPLAN, { timeout: 5000 });
        /* delete progress photos between two dates: only those in the range go */
        await gp.evaluate(async () => {
          const jpg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(32), 0xff, 0xd9])], { type: 'image/jpeg' });
          for (const d of ['2026-03-01', '2026-03-20', '2026-05-01']) await pSend('POST', `/api/photos?date=${d}&pose=front`, jpg);
        });
        await gp.fill('#ad-pd-from', '2026-03-01'); await gp.fill('#ad-pd-to', '2026-03-31');
        await gp.waitForFunction(() => /^2 photos/.test(document.querySelector('#ad-pdmsg').textContent) && !document.querySelector('#ad-pd-btn').disabled, null, { timeout: 5000 });
        gp.once('dialog', d => d.accept()); await gp.click('#ad-pd-btn');
        await gp.waitForFunction(() => /Deleted 2 photos/.test(document.querySelector('#ad-pdmsg').textContent), null, { timeout: 5000 });
        expect((await gp.evaluate(async () => (await api('GET', '/api/photos')).photos.map(p => p.date))).join() === '2026-05-01', 'only the photos in the range should be deleted');
        const gscroll = await gp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(gscroll <= 1, `horizontal overflow of ${gscroll}px on the account admin page`);
        await gp.evaluate(d => { location.hash = '#day/' + d; }, MON);
        await gp.waitForFunction(() => /· Training$/.test(document.querySelector('#dsub').textContent) && /Chicken thigh/.test(document.querySelector('#meals').innerHTML), null, { timeout: 5000 });
        await gp.evaluate(d => { location.hash = '#day/' + d; }, MON2);
        await gp.waitForFunction(d => document.querySelector('#datepick').value === d && /· Rest$/.test(document.querySelector('#dsub').textContent), MON2, { timeout: 5000 });
        await gctx.close();
        await pg.click('#acct>summary'); await pg.click('#accountlink'); await pg.waitForSelector('#v-admin.mine:not([hidden]) #ad-meals .admeal');
        expect(/^Using /.test(await pg.textContent('#ad-aistate')) && !(await pg.isDisabled('#ad-aifile')), 'PDF upload should be on once a key is saved');
        /* an AI plan read (faked, in the background) opens as a preview of what it would change: a food edited here keeps its
           value unless its box is ticked, a new food and the template's new meals are taken on "Use ticked" */
        const [fid, tid, tname, pfood] = await pg.evaluate(() => { const id = Object.keys(AD.foods)[0]; return [id, AD.templates[0].id, AD.templates[0].name, AD.foods[id]]; });
        await pg.click(`.adfood[data-id="${fid}"] > summary`);
        await pg.fill(`#ad-fd-${fid}-k`, '389'); await pg.press(`#ad-fd-${fid}-k`, 'Tab');
        const pjob = { id: 902, kind: 'plan', label: 'plan.pdf', status: 'running', error: null, seen: false };
        await pg.route(/\/api\/my\/ai-import\?/, r => r.fulfill({ status: 202, json: { job: pjob } }));
        await pg.route(/\/api\/jobs(\/.*)?$/, r => {
          const u = new URL(r.request().url()).pathname;
          if (u === '/api/jobs') return r.fulfill({ json: { jobs: pjob.seen ? [] : [pjob] } });
          if (u.endsWith('/seen')) { pjob.seen = true; return r.fulfill({ json: { ok: true } }); }
          r.fulfill({ json: { ...pjob, result: { model: 'test/model', notes: [], templates: [{ id: tid, name: tname }], targets: {}, schedule: null,
            plan: { [tid]: [{ id: '1', name: 'Smoke AI breakfast', p: [{ f: fid, g: 100, lock: false }], c: [], x: [] }] },
            foods: { [fid]: { ...pfood, k: 379 }, smoke_ai_seeds: { n: 'Smoke AI seeds', k: 560, p: 20, c: 10, f: 48, group: 'x', unit: 'g', d: 0, step: 1, min: null, max: null, order: null, free: '' } } } } });
        });
        await pg.setInputFiles('#ad-aifile', { name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
        await pg.waitForFunction(() => /Reading your meal plan/.test(document.querySelector('#jobs').textContent), null, { timeout: 5000 });
        pjob.status = 'done';
        await pg.waitForSelector('#ad-aiprev:not([hidden]) [data-ad=aiuse]', { timeout: 10000 });
        expect(!(await pg.isChecked(`#ad-aiprev input[data-key="f:${fid}"]`)) && await pg.isChecked(`#ad-aiprev input[data-key="t:${tid}"]`)
          && /Smoke AI seeds/.test(await pg.textContent('#ad-aiprev')), 'the plan read preview should list the edited food unticked, the template ticked and the new food');
        expect(await pg.evaluate(f => AD.foods[f].k === 389 && !AD.foods.smoke_ai_seeds, fid), 'nothing should change before "Use ticked"');
        expect(!pjob.seen, 'an opened read stays unseen until it is used or dropped, so a reload can reopen it');
        const prscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(prscroll <= 1, `horizontal overflow of ${prscroll}px on the plan read preview at ${w}px wide`);
        await pg.click('#ad-aiprev [data-ad=aiuse]');
        await pg.waitForSelector('#ad-aiprev', { state: 'hidden' });
        expect(await pg.evaluate(([f, t]) => AD.foods[f].k === 389 && !!AD.foods.smoke_ai_seeds && AD.plan[t][0].name === 'Smoke AI breakfast', [fid, tid]),
          'the edited food should keep 389 kcal; the new food and the meals should be taken');
        expect(pjob.seen, 'using the read marks it seen');
        await pg.unroute(/\/api\/jobs(\/.*)?$/); await pg.unroute(/\/api\/my\/ai-import\?/);
        await pg.click('[data-ad=discard]');
        await pg.waitForFunction(f => !AD.foods.smoke_ai_seeds && AD.foods[f].k !== 389, fid, { timeout: 5000 });
        /* a workout plan read with AI, not faked in the browser: the background job runs on the server against a fake OpenRouter (PR-PL-062) */
        await pg.evaluate(() => { location.hash = '#gym'; }); await pg.waitForSelector('#g-aifile', { state: 'attached' });
        await pg.setInputFiles('#g-aifile', { name: 'workout.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 workout') });
        await pg.waitForSelector('.gai', { timeout: 15000 });
        expect(/Smoke AI upper/.test(await pg.textContent('.gai')) && /workout\.pdf/.test(await pg.textContent('.gai')), 'the workout read should open its preview');
        await pg.click('.gai [data-g=aidrop]'); await pg.waitForSelector('.gai', { state: 'detached' });
        await pg.click('#acct>summary'); await pg.click('#accountlink'); await pg.waitForSelector('#v-admin.mine:not([hidden]) #ad-meals .admeal');
        /* Options tab: plan files off hides the CSV / JSON buttons on Account admin, on again brings them back */
        expect(!(await pg.isHidden('[data-ad=csv]')), 'plan file buttons should show by default');
        await pg.click('#acct>summary'); await pg.click('#adminlink');
        await pg.click('#ad-tabs [data-adt=options]'); await pg.waitForSelector('[data-adtab=options]:not([hidden]) #ad-planfiles');
        await pg.uncheck('#ad-planfiles'); await pg.waitForFunction(() => document.querySelector('#v-admin').classList.contains('nofiles') && !document.querySelector('#ad-planfiles').disabled, null, { timeout: 5000 });
        await pg.click('#acct>summary'); await pg.click('#accountlink'); await pg.waitForSelector('#v-admin.mine:not([hidden]) #ad-meals .admeal');
        expect(await pg.isHidden('[data-ad=csv]') && await pg.isHidden('[data-ad=json]') && await pg.isHidden('.adfile.adfiles') && !(await pg.isHidden('#ad-aibtn')), 'plan file buttons should hide when switched off, PDF stays');
        await pg.click('#acct>summary'); await pg.click('#adminlink');
        await pg.click('#ad-tabs [data-adt=options]'); await pg.waitForSelector('[data-adtab=options]:not([hidden]) #ad-planfiles');
        await pg.check('#ad-planfiles'); await pg.waitForFunction(() => !document.querySelector('#v-admin').classList.contains('nofiles') && !document.querySelector('#ad-planfiles').disabled, null, { timeout: 5000 });
        /* daily AI caps and private providers only: filled in from the server, saved with the form */
        await pg.waitForFunction(() => document.querySelector('#ad-capuser').value !== '', null, { timeout: 5000 });
        expect(await pg.inputValue('#ad-capuser') === '100' && await pg.inputValue('#ad-capall') === '1000' && await pg.isChecked('#ad-aiprivate'), 'AI caps should show their defaults');
        for (const v of ['150', '100']) {
          await pg.evaluate(() => { document.querySelector('#ad-capmsg').textContent = ''; });
          await pg.fill('#ad-capuser', v); await pg.click('#ad-capform button[type=submit]');
          await pg.waitForFunction(() => /saved/.test(document.querySelector('#ad-capmsg').textContent), null, { timeout: 5000 });
        }
        expect(await pg.inputValue('#ad-capuser') === '100', 'saved cap should show');
        await pg.click('#acct>summary'); await pg.click('#accountlink'); await pg.waitForSelector('#v-admin.mine:not([hidden]) #ad-meals .admeal');
        expect(!(await pg.isHidden('[data-ad=csv]')), 'plan file buttons should be back when switched on');
      }
      await pg.click('#ad-types [data-t=R]');
      expect(await pg.inputValue('#ad-mn-0') === 'Smoke bowl', 'uploaded plan should be shown');
      expect(await pg.inputValue('#ad-wd-0') === 'R', 'Monday should now be a rest day');
      /* the super admin page: tabs only */
      await pg.click('#acct>summary'); await pg.click('#adminlink');
      await pg.waitForSelector('#v-admin:not(.mine):not([hidden]) #ad-aipanel:not([hidden]) #ad-tm-food');
      const aiscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(aiscroll <= 1, `horizontal overflow of ${aiscroll}px on the AI tab at ${w}px wide`);
      await pg.click('#ad-tabs [data-adt=people]'); await pg.waitForSelector('[data-adtab=people]:not([hidden]) #ad-users .aduser');
      await pg.click('a[data-view=day]'); await pg.click('[data-act=next]'); await pg.waitForTimeout(200);
      await pg.evaluate(d => { location.hash = '#day/' + d; }, MON); /* a Monday nobody has saved */
      await pg.waitForFunction(() => /· Rest$/.test(document.querySelector('#dsub').textContent), null, { timeout: 5000 });
      expect(/Smoke bowl/.test(await pg.textContent('#meals')), 'new rest days should start from the uploaded plan');
      expect(/Refeed day/.test(await pg.textContent('#tabs')), 'Sunday should show the refeed template in the week strip');
      if (first) {   /* one day follows another template: it starts again from that one (and stays so when saved) */
        await pg.evaluate(d => { location.hash = '#day/' + d; }, MON2);
        await pg.waitForFunction(d => document.querySelector('#datepick').value === d && /· Rest$/.test(document.querySelector('#dsub').textContent), MON2, { timeout: 5000 });
        await pg.selectOption('#dtpl', { label: 'Training' });
        await pg.waitForFunction(() => /· Training$/.test(document.querySelector('#dsub').textContent) && /Health Road chicken/.test(document.querySelector('#meals').textContent)
          && /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
        expect(+(await pg.inputValue('#t-c')) === 360, 'the day should take the training targets');
        await pg.reload(); await pg.waitForSelector('#v-day:not([hidden]) #meals .meal');
        expect(/· Training$/.test(await pg.textContent('#dsub')) && /Training/.test(await pg.textContent('#tabs .tab.on')), 'the day should keep its template after a reload');
      }
      expect(errs.length === 0, `page errors at ${w}px: ${errs.join(' | ')}`);
      const scroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(scroll <= 1, `horizontal overflow of ${scroll}px at ${w}px wide`);
      if (first) {
        /* signed out while a change is waiting: it must survive sign-in */
        await ctx.clearCookies();
        await pg.selectOption('#sn', 'skittles'); await pg.click('#snackform button');
        await pg.waitForURL(/\/login/, { timeout: 5000 });
        await pg.fill('#email', 'smoke@example.com'); await pg.fill('#password', 'smoke-password-1'); await pg.click('#submit');
        await pg.waitForSelector('#v-day:not([hidden]) #meals .meal');
        await pg.waitForFunction(() => /Skittles/.test(document.querySelector('#offlist').textContent)
          && /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
        await pg.reload(); await pg.waitForSelector('#v-day:not([hidden]) #meals .meal');
        expect(/Skittles/.test(await pg.textContent('#offlist')), 'change made while signed out should be saved after sign-in');
        await trackerKeepsFood(browser, pg, ctx);
        await twoTabsOneDay(ctx);
      }
      /* sign-out sends Clear-Site-Data: another account's unsaved changes waiting in this browser must survive it */
      const stash = JSON.stringify({ email: 'other@example.com', at: Date.now(), jobs: [] });
      await pg.evaluate(v => localStorage.setItem('logbook-monster-unsaved', v), stash);
      await pg.click('#acct summary'); await pg.click('#logout'); await pg.waitForURL(/\/login/);
      expect(await pg.evaluate(() => localStorage.getItem('logbook-monster-unsaved')) === stash, 'unsaved-changes stash should survive sign-out');
      await ctx.close();
      await twoStep(browser, w, h);
    }
    await versionedAssets(browser);
    await recheck(browser);
    await phase1c(browser);
    await phase2c(browser);
    await phase2cLibrary(browser);
    await phase2cLast(browser);
    console.log('smoke: ok (desktop + phone)');
  } catch (e) { await browser.close(); return fail(e.stack); }
  await browser.close(); cleanup();
})();

'use strict';
/* Browser smoke test: starts a throwaway server, signs in, weighs a meal-prep pack, edits and saves a day, logs a weight,
   opens History and Weight, logs gym sets, adds a shared food to the library and to a day, logs supplements, uploads, filters and compares progress photos, charts trends and opens day cards on the Timeline, uploads a plan and invites someone on the Admin page, at desktop and phone widths. Fails on any page error.
   Needs Playwright (npm i -g playwright, or available in the environment); skips if missing. */
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch {
  try { ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))); } catch {}
}
if (!chromium) { console.log('smoke: Playwright not installed – skipped'); process.exit(0); }

const [PORT] = require('../test/_ports').freePorts(1), BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-monster-smoke-'));
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 's.db'),
  SESSION_SECRET: 'x'.repeat(40), AUTH_RATE_LIMIT: '1000', ALLOWED_EMAILS: '', ALLOW_REGISTRATION: 'false', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
const node = [process.execPath, '--disable-warning=ExperimentalWarning'];
const root = path.join(__dirname, '..');

execSync(`"${node[0]}" ${node[1]} scripts/create-user.js smoke@example.com`, { cwd: root, env: { ...env, NEW_PASSWORD: 'smoke-password-1' }, stdio: 'ignore' });
const srv = spawn(node[0], [node[1], 'server/index.js'], { cwd: root, env, stdio: 'ignore' });

const fail = msg => { console.error('smoke FAILED:', msg); cleanup(); process.exit(1); };
function cleanup() { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch();
  try {
    for (const [w, h, first] of [[1100, 900, true], [390, 844, false]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const pg = await ctx.newPage(); const errs = [];
      pg.on('pageerror', e => errs.push(e.message));
      pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
      await pg.goto(BASE + '/');
      expect(pg.url().endsWith('/login'), 'signed-out visit should land on /login');
      await pg.fill('#email', 'smoke@example.com'); await pg.fill('#password', 'smoke-password-1'); await pg.click('#submit');
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
      /* food library: add a shared meal with a recipe, filter meals and ingredients, open an AI flag's source,
         find the meal, add it to today's plan, then add it again from the Day page */
      if (first) await pg.evaluate(() => api('POST', '/api/foods', { name: 'Smoke chicken', unit: 'g', kind: 'ingredient', k: 165, p: 31, c: 0, f: 3.6,
        ai: { fields: ['k', 'f'], source: 'Smoke source – USDA', basis: ['100 g raw breast'], confidence: 'high' } }));
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
      await pg.click('#f-wt [data-v=raw]'); await pg.selectOption('#f-who', 'mine');
      await pg.fill('#f-q', 'oats'); await pg.waitForFunction(() => document.querySelectorAll('#f-list .fcard').length === 1);
      expect(/Shared/.test(await pg.textContent('#f-list .fcard')), 'shared food should be marked Shared');
      await pg.click('#f-list .fcard details summary'); expect(/30g whey/.test(await pg.textContent('#f-list .frecipe')), 'recipe should show');
      await pg.click('#f-list [data-fa=add]'); await pg.waitForSelector('#f-addform');
      await pg.fill('#f-aqty', '2'); expect(/840/.test(await pg.textContent('#f-aprev')), 'preview should scale to 2 items');
      const fscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(fscroll <= 1, `horizontal overflow of ${fscroll}px on the food library at ${w}px wide`);
      await pg.click('#f-addform button[type=submit]');
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
      }
      expect(await pg.locator('#p-list .pday').count() === 2 && await pg.locator('#p-list .ptile').count() === 3, 'catalog should show 3 photos over 2 days');
      await pg.waitForFunction(() => [...document.querySelectorAll('#p-list .ptile img')].every(i => i.complete && i.naturalWidth > 0), null, { timeout: 5000 });
      expect(/85 kg/.test(await pg.textContent('#p-d-2026-09-01 h3')), 'a day should show its weigh-in');
      const pscroll = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(pscroll <= 1, `horizontal overflow of ${pscroll}px on the photos page at ${w}px wide`);
      await pg.click('#p-d-2026-09-01 .ptile >> nth=0'); await pg.waitForSelector('#p-eform');
      await pg.waitForFunction(() => { const i = document.querySelector('.pbig img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 });
      if (!first) {
        /* AI is set up by now (the key saved on the Admin page in the first pass); the AI's answer is faked here */
        await pg.route('**/api/photos/*/ai-pose', r => r.fulfill({ json: { pose: 'side', model: 'test/vision', photo: {} } }));
        expect(await pg.locator('#p-epose').inputValue() !== 'side', 'the photo should not start as side');
        await pg.click('[data-pa=aione]');
        await pg.waitForFunction(() => document.querySelector('#p-epose').value === 'side' && /AI says Side/.test(document.querySelector('#p-aisay').textContent), null, { timeout: 5000 });
        await pg.selectOption('#p-epose', 'front');
      }
      await pg.fill('#p-enote', 'smoke edited ' + w); await pg.click('#p-eform button[type=submit]');
      await pg.waitForFunction(() => /Saved/.test((document.querySelector('#p-list') || {}).textContent || ''), null, { timeout: 5000 });
      /* bodyweight: the latest weigh-in is today's 80.5 kg, so only 1 October (80.4) is within 1 kg; then 85 kg finds 1 September */
      await pg.check('#p-near');
      await pg.waitForFunction(() => document.querySelectorAll('#p-list .pday').length === 1 && document.querySelector('#p-d-2026-10-01'));
      await pg.fill('#p-nearkg', '85');
      await pg.waitForFunction(() => document.querySelectorAll('#p-list .pday').length === 1 && document.querySelector('#p-d-2026-09-01'));
      await pg.fill('#p-nearkg', ''); await pg.uncheck('#p-near');
      await pg.waitForFunction(() => document.querySelectorAll('#p-list .pday').length === 2);
      expect(first === !(await pg.locator('#p-aibtn').count()), '"Tag poses with AI" only once AI is set up');
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
      /* admin (the only account is the first one, so it is the admin) */
      await pg.click('#acct>summary'); await pg.click('#adminlink'); await pg.waitForSelector('#v-admin:not([hidden]) #ad-meals .admeal');
      if (first) {
        await pg.setInputFiles('#ad-file', { name: 'plan.csv', mimeType: 'text/csv', buffer: Buffer.from(
          'day_type,meal,meal_name,box,food,grams,locked\nrest,1,Smoke bowl,protein,whey,40,yes\nrest,1,Smoke bowl,carbs,Banana (peeled),150,\n') });
        await pg.waitForFunction(() => /Loaded rest plan/.test(document.querySelector('#ad-upmsg').textContent), null, { timeout: 5000 });
        await pg.selectOption('#ad-wd-0', 'R');
        await pg.click('.adfood[data-id=banana] summary'); await pg.fill('#ad-fd-banana-k', '90');
        await pg.click('#ad-save');
        /* AI import needs a key: the key box starts open, saving it turns the PDF button on */
        await pg.waitForFunction(() => /OpenRouter API key/.test(document.querySelector('#ad-aistate').textContent));
        await pg.fill('#ad-key', 'sk-or-v1-smoke-test-key'); await pg.click('#ad-keyform button[type=submit]');
        await pg.waitForFunction(() => /^Using /.test(document.querySelector('#ad-aistate').textContent), null, { timeout: 5000 });
        expect(!(await pg.isDisabled('#ad-aifile')), 'PDF upload should be on once a key is saved');
        await pg.waitForFunction(() => /Saved/.test(document.querySelector('#ad-status').textContent), null, { timeout: 5000 });
        /* invite someone: email isn't set up, so the link is shown to pass on; accept it in a fresh phone-sized browser */
        await pg.waitForSelector('#ad-users .aduser');
        expect(/Not set up/.test(await pg.textContent('#ad-mailstate')), 'email should start not set up');
        expect(await pg.inputValue('#ad-m-host') === 'smtp.gmail.com', 'Gmail should be the default email server');
        await pg.fill('#ad-iv-email', 'guest@example.com'); await pg.click('#ad-iv-btn');
        await pg.waitForSelector('#ad-iv-link', { timeout: 5000 });
        const link = await pg.inputValue('#ad-iv-link');
        expect(/Invite sent/.test(await pg.textContent('#ad-users')), 'invited person should be listed as invited');
        const gctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const gp = await gctx.newPage();
        gp.on('pageerror', e => errs.push('invite page: ' + e.message));
        await gp.goto(link); await gp.waitForSelector('#form:not([hidden])', { timeout: 5000 });
        expect(/guest@example\.com/.test(await gp.textContent('#intro')), 'invite page should name the invited email');
        await gp.fill('#password', 'guest-password-1'); await gp.click('#submit');
        await gp.waitForSelector('#v-day:not([hidden]) #meals .meal', { timeout: 5000 });
        /* account admin: the guest has their own plan page but no super admin page */
        expect(await gp.isHidden('#adminlink'), 'super admin link should be hidden for other accounts');
        await gp.evaluate(() => { location.hash = '#admin'; });
        await gp.waitForSelector('#v-day:not([hidden])', { timeout: 5000 });
        await gp.click('#acct>summary'); await gp.click('#accountlink');
        await gp.waitForSelector('#v-admin.mine:not([hidden]) #ad-meals .admeal', { timeout: 5000 });
        expect(await gp.isHidden('#ad-uh') && await gp.isHidden('#ad-eh') && await gp.isHidden('#ad-keybox'), 'people, email and the AI key are super admin only');
        expect(await gp.inputValue('#ad-wd-0') === 'R', 'the guest should start from the app defaults');
        await gp.selectOption('#ad-wd-0', 'T'); await gp.click('#ad-save');
        await gp.waitForFunction(() => /Saved/.test(document.querySelector('#ad-status').textContent) && !document.querySelector('#ad-reset').hidden, null, { timeout: 5000 });
        /* free foods: tick sauces free, save, and passata stops counting */
        expect(!(await gp.isChecked('#ad-free-sauce')) && !(await gp.isChecked('#ad-free-veg')), 'sauces and green veg should count by default');
        await gp.check('#ad-free-sauce');
        expect(/Unsaved/.test(await gp.textContent('#ad-status')), 'ticking free sauces should be an unsaved change');
        await gp.click('#ad-save');
        await gp.waitForFunction(() => /Saved/.test(document.querySelector('#ad-status').textContent), null, { timeout: 5000 });
        expect(await gp.isChecked('#ad-free-sauce') && await gp.evaluate(() => FREE.sauce && macOf('passata', 200).k === 0), 'free sauces should be saved and applied');
        /* a change that takes effect later: Mondays are rest days again from 2031, days before keep training */
        await gp.selectOption('#ad-wd-0', 'R'); await gp.fill('#ad-from', '2031-01-01'); await gp.click('#ad-save');
        await gp.waitForFunction(() => /Scheduled/.test(document.querySelector('#ad-versions').textContent) && /Saved/.test(document.querySelector('#ad-status').textContent), null, { timeout: 5000 });
        const gscroll = await gp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(gscroll <= 1, `horizontal overflow of ${gscroll}px on the account admin page`);
        await gp.evaluate(() => { location.hash = '#day/2030-01-07'; });
        await gp.waitForFunction(() => /Training day/.test(document.querySelector('#dsub').textContent), null, { timeout: 5000 });
        await gp.evaluate(() => { location.hash = '#day/2031-01-06'; });
        await gp.waitForFunction(() => document.querySelector('#datepick').value === '2031-01-06' && /Rest day/.test(document.querySelector('#dsub').textContent), null, { timeout: 5000 });
        await gctx.close();
      }
      await pg.click('#ad-types [data-t=R]');
      expect(await pg.inputValue('#ad-mn-0') === 'Smoke bowl', 'uploaded plan should be shown');
      expect(await pg.inputValue('#ad-wd-0') === 'R', 'Monday should now be a rest day');
      /* the super admin's own account admin page follows the app defaults until they change something */
      await pg.click('#acct>summary'); await pg.click('#accountlink');
      await pg.waitForSelector('#v-admin.mine:not([hidden]) #ad-meals .admeal');
      expect(await pg.isHidden('#ad-uh') && /App plan/.test(await pg.textContent('#ad-planstate')), 'account admin should show the app plan and no people');
      await pg.click('#acct>summary'); await pg.click('#adminlink');
      await pg.waitForSelector('#v-admin:not(.mine):not([hidden]) #ad-users .aduser');
      await pg.click('a[data-view=day]'); await pg.click('[data-act=next]'); await pg.waitForTimeout(200);
      await pg.evaluate(() => { location.hash = '#day/2030-01-07'; }); /* a Monday nobody has saved */
      await pg.waitForFunction(() => /Rest day/.test(document.querySelector('#dsub').textContent), null, { timeout: 5000 });
      expect(/Smoke bowl/.test(await pg.textContent('#meals')), 'new rest days should start from the uploaded plan');
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
      }
      await pg.click('#acct summary'); await pg.click('#logout'); await pg.waitForURL(/\/login/);
      await ctx.close();
    }
    console.log('smoke: ok (desktop + phone)');
  } catch (e) { await browser.close(); return fail(e.message); }
  await browser.close(); cleanup();
})();

'use strict';
/* Browser smoke test: starts a throwaway server, signs in, edits and saves a day, logs a weight,
   opens History and Weight, uploads a plan on the Admin page, at desktop and phone widths. Fails on any page error.
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

const PORT = 3800 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mealswap-smoke-'));
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DB_PATH: path.join(dir, 's.db'),
  SESSION_SECRET: 'x'.repeat(40), ALLOWED_EMAILS: '', ALLOW_REGISTRATION: 'false', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OPENROUTER_API_KEY: '' };
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
      await pg.selectOption('#sn', 'reese'); await pg.fill('#sq', '2'); await pg.click('#snackform button');
      await pg.waitForFunction(() => /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
      await pg.fill('#wt', '80.5'); await pg.press('#wt', 'Tab'); await pg.waitForTimeout(300);
      await pg.reload(); await pg.waitForSelector('#v-day:not([hidden]) #meals .meal');
      expect(/Reese/.test(await pg.textContent('#offlist')), 'snack should survive reload');
      expect(await pg.inputValue('#wt') === '80.5', 'weight should survive reload');
      await pg.click('a[data-view=history]'); await pg.waitForSelector('#v-history:not([hidden]) .cell.logged');
      await pg.click('a[data-view=weight]'); await pg.waitForSelector('#v-weight:not([hidden]) #chart svg');
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
      }
      await pg.click('#ad-types [data-t=R]');
      expect(await pg.inputValue('#ad-mn-0') === 'Smoke bowl', 'uploaded plan should be shown');
      expect(await pg.inputValue('#ad-wd-0') === 'R', 'Monday should now be a rest day');
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

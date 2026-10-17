'use strict';
/* Reads a meal plan PDF (or photo) with a model on OpenRouter and turns it into an account's plan
   format: day templates with their meals, new foods, targets and the week. Nothing is saved here – the
   Account admin page loads the result into its draft so it can be checked before saving. */
const { AsyncLocalStorage } = require('node:async_hooks');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const db = require('./db');
const defaults = require('./defaults');
const audit = require('./audit');

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';
const BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const TYPES_IN = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
/* Each kind of AI task can use its own OpenRouter model; one left blank uses the default model.
   max: the output cap (tokens) sent when the caller gives none; wait: how long to wait for the reply (ms). */
const MIN = 60000;
/* A file read (file: true) waits 3 minutes for its answer, or 5 when it runs in the background (jobs.js): a long plan reply
   (12,000 tokens at 40–60 a second) can take 200–300 s, and the request isn't streamed, so nothing arrives before the end.
   Every other task has to get its answer's first byte within FIRST_BYTE as well as the whole of it within wait. */
const FILE_WAIT = 3 * MIN, BG_WAIT = 5 * MIN, FIRST_BYTE = 45000;
const TASKS = {
  plan: { name: 'Meal plan import', hint: 'Reads a coach’s PDF or photo – needs a model that reads PDFs', max: 12000, wait: FILE_WAIT, file: true },
  workout: { name: 'Workout plan import', hint: 'Reads a PDF or photo of a training plan – needs a model that reads PDFs', max: 8000, wait: FILE_WAIT, file: true },
  supps: { name: 'Supplement regime import', hint: 'Reads a PDF or photo of a supplement regime – needs a model that reads PDFs', max: 4000, wait: FILE_WAIT, file: true },
  food: { name: 'Food values', hint: 'Fills in blank calories and macros in the food library (text only)', max: 800, wait: MIN },
  pose: { name: 'Photo poses', hint: 'Tells front / side / back from a progress photo – needs a model that sees images', max: 300, wait: MIN },
  exercise: { name: 'Exercise body parts', hint: 'Tags exercises with the body parts they train (text only)', max: 3000, wait: MIN },
  summary: { name: 'Timeline summary', hint: 'Writes the summary of trends on the Timeline (text only)', max: 2000, wait: MIN },
};
const MAGIC = {
  'application/pdf': b => b.subarray(0, 1024).includes('%PDF-'),
  'image/png': b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': b => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};
const MODEL_RE = /^[\w.\-/:]{3,100}$/;

const q = {
  get: db.prepare("SELECT data FROM app_config WHERE key = 'openrouter'"),
  put: db.prepare(`INSERT INTO app_config (key, data) VALUES ('openrouter', ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`),
  reseal: db.prepare("UPDATE app_config SET data = ? WHERE key = 'openrouter'"),
  used: db.prepare('SELECT calls FROM ai_usage WHERE user_id = ? AND day = ?'),
  usedAll: db.prepare('SELECT COALESCE(SUM(calls), 0) AS n FROM ai_usage WHERE day = ?'),
  use: db.prepare('INSERT INTO ai_usage (user_id, day, calls) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1'),
  old: db.prepare('DELETE FROM ai_usage WHERE day < ?'),
};

/* Daily caps on AI calls (Super admin › Options, 0 = no limit), counted per UTC day in ai_usage. Every call goes
   through call(), so every route is covered. Whose call it is comes from the request (scope() below). */
const als = new AsyncLocalStorage();
function scope(req, res, next) { req.ai = req.ai || { user: req.user, calls: 0, res }; als.run(req.ai, next); }
const appOptions = () => require('./api').appOptions();
const capped = msg => Object.assign(new Error(msg), { status: 429 });
function allow() {
  const o = appOptions(), s = als.getStore(), user = s && s.user, day = new Date().toISOString().slice(0, 10);
  if (o.aiDailyAll && q.usedAll.get(day).n >= o.aiDailyAll) {
    audit.once(null, 'ai.cap', { cap: 'app' }, user ? user.id : null);
    throw capped('The app has used all of today’s AI – try again tomorrow');
  }
  if (user && !require('./api').superAdmin(user) && o.aiDailyUser && ((q.used.get(user.id, day) || {}).calls || 0) >= o.aiDailyUser) {
    audit.once(null, 'ai.cap', { cap: 'account' }, user.id);
    throw capped('You’ve used today’s AI allowance – try again tomorrow');
  }
  return o;
}
/* Only a call the AI answered counts – against the daily caps (checked up front by allow()) and the route's hourly limit
   (req.ai.calls): one that timed out, failed or was refused here costs nothing, so an outage doesn't use up anyone's allowance. */
function used() {
  const s = als.getStore(), user = s && s.user;
  try { q.use.run(user ? user.id : 0, new Date().toISOString().slice(0, 10)); } catch (e) { console.error('AI usage count failed:', e.message); }
  if (s) s.calls++;
}
/* Counts older than 30 days are dropped on start and once a day, not on every call. */
function pruneUsage() { try { q.old.run(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)); } catch (e) { console.error('AI usage prune failed:', e.message); } }
pruneUsage();
setInterval(pruneUsage, 24 * 60 * 60 * 1000).unref();
/* An hourly limit per account on a route that calls the AI. A request refused before any AI call (bad file, bad input,
   cap reached, a read already running) doesn't count, nor one whose AI calls all failed (timeout, outage, busy). A read in the
   background has answered 202 before the AI does: req.ai.refund() gives its count back if it fails (jobs.js). */
function limiter(limit, message, more = {}) {
  const store = new rateLimit.MemoryStore();
  const mw = rateLimit({
    windowMs: 60 * 60 * 1000, limit, standardHeaders: 'draft-7', legacyHeaders: false, store,
    keyGenerator: req => 'u' + req.user.id, message: { error: message },
    skipFailedRequests: true, requestWasSuccessful: (req, res) => res.statusCode === 202 || (req.ai && req.ai.calls > 0) || (res.statusCode < 400 && !(req.ai && req.ai.failed)), ...more,
  });
  const refund = (req, res, next) => {
    const key = req.rateLimit && req.rateLimit.key;
    if (key && req.ai) { let done = false; req.ai.refund = () => { if (!done) { done = true; store.decrement(key).catch(() => {}); } }; }
    next();
  };
  return [mw, refund];
}

/* The key is kept sealed (keySealed, server/seal.js); stored() hands it back opened as key. Two more slots for rotating it
   (docs/rotation.md): next (saved and tested before it takes over) and old (the one promote() replaced, kept OVERLAP for
   "Test old" after revoking it at OpenRouter, then dropped). keyId / nextId / oldId: random ids for credentials.js, whose age
   restarts only when the key itself changes. One kept in plain text from before is sealed on start. */
const box = require('./seal')('openrouter-key-v1');
const creds = require('./credentials');
const OVERLAP = 60 * 60 * 1000;
const SLOTS = [['key', 'keySealed'], ['next', 'nextSealed'], ['old', 'oldSealed']];
function stored() {
  const r = q.get.get(), s = r ? JSON.parse(r.data) : {};
  for (const [k, f] of SLOTS) if (s[f]) { const v = box.unsealText(s[f]); if (v) { s[k] = v; delete s[f]; } }
  if (s.oldUntil && Date.now() > s.oldUntil) {   /* its hour is up: dropped for good */
    for (const k of ['old', 'oldSealed', 'oldId', 'oldUntil']) delete s[k];
    q.put.run(sealed(s));
  }
  return s;
}
function sealed(s) {
  const out = { ...s };
  for (const [k, f] of SLOTS) { delete out[k]; if (s[k]) out[f] = box.sealText(s[k]); }
  return JSON.stringify(out);
}
{ const r = q.get.get(), s = r && JSON.parse(r.data); if (s && SLOTS.some(([k]) => s[k])) q.reseal.run(sealed(stored())); }   /* plain from before */
const envKey = () => config.envSecret('OPENROUTER_API_KEY').value;
/* A key saved on the Admin page wins over OPENROUTER_API_KEY in .env. */
function current(task) {
  const s = stored();
  const key = s.key || envKey() || '';
  const model = s.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  return { key, source: s.key ? 'admin' : key ? 'env' : null, model: (task && s.models && s.models[task]) || model };
}
/* which slots hold a key (never the keys), for the Keys panel */
function slots() {
  const s = stored(), c = current();
  return { source: c.source, next: !!s.next, old: !!s.old, oldUntil: s.old ? s.oldUntil : null };
}
const KEY_RE = /^[\x21-\x7e]{10,300}$/;
const keyOf = v => { const key = String(v || '').trim(); if (key && !KEY_RE.test(key)) throw new Error('That doesn’t look like an API key'); return key; };
/* the active key changes: the one it replaces stays as old for OVERLAP */
function setActive(s, key, id) {
  if (s.key && s.key !== key) Object.assign(s, { old: s.key, oldId: s.keyId, oldUntil: Date.now() + OVERLAP });
  s.key = key; s.keyId = id || creds.newKid();
  creds.record('OPENROUTER', s.keyId);
}
function saveNext(v) {
  const key = keyOf(v), s = stored();
  if (!key) { delete s.next; delete s.nextId; } else { s.next = key; s.nextId = creds.newKid(); }
  q.put.run(sealed(s));
  return status();
}
function promote() {
  const s = stored();
  if (!s.next) throw Object.assign(new Error('Save a next key first'), { status: 409 });
  setActive(s, s.next, s.nextId);
  delete s.next; delete s.nextId;
  q.put.run(sealed(s));
  breaker.reset('key');
  return status();
}
/* One real, free call with a slot's key: OpenRouter's GET /key answers 200 for a live key, 401 for a revoked one. Not through
   call(), so it never feeds the breaker (a revoked old key's 401 is expected) and needs no seat. */
async function verify(slot) {
  const s = stored(), key = slot === 'active' ? current().key : s[slot];
  if (!key) throw Object.assign(new Error(slot === 'old' ? 'There’s no old key any more – it was dropped an hour after the promote' : `There’s no ${slot} key`), { status: 404 });
  try {
    const r = await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    return { slot, ok: r.ok, status: r.status, dead: r.status === 401 || r.status === 403 };
  } catch { return { slot, ok: false, status: 0, dead: false, error: 'Couldn’t reach OpenRouter' }; }
}
/* What the browser may see: never the key itself. Only the super admin gets this (GET /api/admin/ai). */
function status() {
  const c = current(), own = stored().models || {};
  return { configured: !!c.key, source: c.source, hint: c.key ? '…' + c.key.slice(-4) : '', model: c.model, defaultModel: DEFAULT_MODEL, slots: slots(),
    tasks: Object.entries(TASKS).map(([id, t]) => ({ id, name: t.name, hint: t.hint, model: own[id] || '', uses: own[id] || c.model })) };
}
function save(body) {
  const s = stored();
  if (body.key !== undefined) {
    const key = keyOf(body.key);
    if (key) { if (key !== s.key) { setActive(s, key); breaker.reset('key'); } }   /* a new key gets a fresh chance (an open breaker may be the old key refused) */
    else { for (const k of ['key', 'keyId', 'old', 'oldId', 'oldUntil']) delete s[k]; creds.forget('OPENROUTER'); }
  }
  if (body.model !== undefined) {
    const model = String(body.model || '').trim();
    if (model && !MODEL_RE.test(model)) throw new Error('Model should look like provider/model-name');
    if (model) s.model = model; else delete s.model;
  }
  if (body.models !== undefined) {
    if (!body.models || typeof body.models !== 'object' || Array.isArray(body.models)) throw new Error('Task models must be an object');
    const models = { ...(s.models || {}) };
    for (const [id, v] of Object.entries(body.models)) {
      if (!Object.prototype.hasOwnProperty.call(TASKS, id)) throw new Error(`Unknown AI task: ${String(id).slice(0, 40)}`);
      const model = String(v || '').trim();
      if (model && !MODEL_RE.test(model)) throw new Error(`${TASKS[id].name}: model should look like provider/model-name`);
      if (model) models[id] = model; else delete models[id];
    }
    if (Object.keys(models).length) s.models = models; else delete s.models;
  }
  q.put.run(sealed(s));
  return status();
}

/* The foods the model can pick from: the account's own plan foods (the ones in its plan today). */
function foodList(user, date) {
  const saved = defaults.effective(user, date).foods || {};
  const out = {};
  for (const [id, r] of Object.entries(saved)) if (id !== 'pudding') out[id] = { n: r.n, k: r.k, p: r.p, c: r.c, f: r.f, unit: r.unit || 'g' };
  return out;
}
/* rice pudding is always there: its values come from the person's own batch on the Daily Tracker */
const PUDDING = 'pudding | Rice pudding (the person’s own batch – the app knows its values) | per 100g: from the batch';

function prompt(foods) {
  const list = [...Object.entries(foods).map(([id, F]) => `${id} | ${F.n} | per 100${F.unit}: ${F.k} kcal, P ${F.p}, C ${F.c}, F ${F.f}`), PUDDING].join('\n');
  return `You turn a nutrition coach's meal plan document into JSON for a meal planning app.

The app keeps a plan as day templates: one for each kind of day the document gives its own meals or targets for (e.g. training day, rest day, high carb day, refeed). List them in "templates" as {"id": short id, "name": short name}. Use id "T" for a training day and "R" for a rest day; any other template gets an id of capital letters and digits starting with a letter, e.g. "HC". If the document has one plan for every day, make one template.

"plan" has a list of meals for each template id. Each meal has:
- "id": the meal number as a string ("1", "2", ...)
- "name": a short name, e.g. "Breakfast – eggs on sourdough"
- "note": optional short note from the document (e.g. cooking or swap instructions)
- "p": protein sources, "c": carb sources, vegetables, fruit, sauces, milk, "x": added fats and spreads (butter, oil, nut butter, avocado, chocolate spread)
Each item is {"f": food id, "g": amount, "lock": false}. Amounts are grams (millilitres for foods measured in ml). Convert units: 1 egg = 50g, use label weights for items such as slices or scoops if the document gives them, otherwise give your best estimate and mention it in "notes". Use lock true only for fixed recipe ingredients that must not be scaled.

Existing foods (id | name | values). Use one of these ids whenever the document's food is the same thing – check raw vs cooked weight matches:
${list}

For any other food, add it to "foods" with a new id (lowercase letters, digits and _ only, not an existing id):
{"n": name, "k": kcal per 100g, "p": protein, "c": carbs, "f": fat, "d": direct protein (= p for meat, fish, eggs, dairy and protein powder, otherwise 0), "step": rounding step in grams (1 for spreads and powders, 5 otherwise), "unit": "g" or "ml", "group": "p", "c" or "x" (the box it belongs in)}
Use values from the document if given, otherwise standard nutrition values.

If the document states daily targets, add "targets": {"T": {"k": kcal, "p": protein g, "c": carbs g, "f": fat g}, "R": {...}} – one per template id.
If it says which weekdays get which template, add "schedule": an array of 7 template ids for Monday to Sunday, e.g. ["T","T","R","T","R","T","R"].
Add "notes": an array of short strings listing anything you estimated, converted or could not read.

Reply with only the JSON object: {"templates": [{"id": "T", "name": "Training"}, ...], "plan": {"T": [...], ...}, "foods": {...}, "targets": {...}, "schedule": [...], "notes": [...]}`;
}

/* A problem with what the AI sent back: shown to the person as it is (not "Something went wrong"). */
const unusable = msg => Object.assign(new Error(msg), { status: 502 });

/* Pull the JSON object out of the reply, even if it is wrapped in a code fence or prose. */
function parseReply(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw unusable('The AI reply had nothing the app could use in it – try again');
  try { return JSON.parse(s.slice(a, b + 1)); } catch { throw unusable('The AI reply wasn’t valid JSON – try again'); }
}

/* Keep everything that passes the same checks as a save; list what was dropped. */
const TEMPLATE_ID = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
const OLD_NAMES = { T: 'Training', R: 'Rest', S: 'Saturday training' };
function tidy(raw, foods) {
  const notes = Array.isArray(raw.notes) ? raw.notes.filter(n => typeof n === 'string').map(n => n.slice(0, 300)).slice(0, 30) : [];
  const out = { templates: [], foods: {}, plan: null, targets: {}, schedule: null };
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(raw.foods)) {
    for (const [id, r] of Object.entries(raw.foods).slice(0, 100)) {
      if (Object.hasOwn(foods, id) || id === 'pudding') continue;   /* never overwrite an existing food, nor the batch's rice pudding */
      try { Object.assign(out.foods, defaults.clean({ foods: { [id]: r } }).foods); }
      catch (e) { notes.push(`Left out new food ${String(id).slice(0, 40)}: ${e.message}`); }
    }
  }
  /* day templates: as listed, plus any the plan uses without listing */
  const over = new Set();
  const addTemplate = (id, name) => {
    if (typeof id !== 'string' || !TEMPLATE_ID.test(id) || id in Object.prototype || out.templates.some(t => t.id === id)) return;
    if (out.templates.length >= 12) {
      if (!over.has(id)) notes.push(`Left out the day template ${String(name || id).trim().slice(0, 40) || id} – a plan can have 12 at most`);
      return over.add(id);
    }
    out.templates.push({ id, name: String(name || OLD_NAMES[id] || id).trim().slice(0, 40) || id });
  };
  for (const t of Array.isArray(raw.templates) ? raw.templates : []) if (isObj(t)) addTemplate(t.id, t.name);
  if (isObj(raw.plan)) for (const id of Object.keys(raw.plan)) addTemplate(id);
  const tname = id => out.templates.find(t => t.id === id).name;
  const known = id => typeof id === 'string' && (id === 'pudding' || Object.prototype.hasOwnProperty.call(foods, id) || Object.prototype.hasOwnProperty.call(out.foods, id));
  if (isObj(raw.plan)) {
    out.plan = {};
    for (const { id: t } of out.templates) {
      if (!Array.isArray(raw.plan[t]) || !raw.plan[t].length) continue;
      if (raw.plan[t].length > 12) notes.push(`Left out ${tname(t)} meals after the 12th – a day template can have 12 at most`);
      out.plan[t] = raw.plan[t].slice(0, 12).filter(isObj).map((m, mi) => {
        const meal = { id: String(m.id == null ? mi + 1 : m.id).slice(0, 8), name: String(m.name || `Meal ${mi + 1}`).slice(0, 100), p: [], c: [], x: [] };
        if (m.note) meal.note = String(m.note).slice(0, 200);
        for (const b of ['p', 'c', 'x']) {
          if (Array.isArray(m[b]) && m[b].length > 20) notes.push(`Left out items after the 20th in a box of ${tname(t)} meal ${meal.id}`);
          for (const i of (Array.isArray(m[b]) ? m[b] : []).slice(0, 20)) {
            const g = isObj(i) ? Math.round(+i.g) : NaN;
            if (!isObj(i) || !known(i.f)) { notes.push(`Left out "${String(isObj(i) ? i.f : i).slice(0, 40)}" in ${tname(t)} meal ${meal.id} – unknown food`); continue; }
            if (!Number.isFinite(g) || g < 0 || g > 5000) { notes.push(`Left out ${i.f} in ${tname(t)} meal ${meal.id} – amount isn't a number of grams`); continue; }
            meal[b].push({ f: i.f, g, lock: !!i.lock });
          }
        }
        return meal;
      });
    }
    if (!Object.keys(out.plan).length) out.plan = null;
  }
  if (!out.plan) throw Object.assign(new Error('The AI couldn’t find a meal plan in that file'), { status: 422 });
  out.templates = out.templates.filter(t => out.plan[t.id] || (isObj(raw.targets) && raw.targets[t.id]));
  for (const [t, v] of Object.entries(isObj(raw.targets) ? raw.targets : {})) {
    if (!out.templates.some(x => x.id === t)) continue;
    try { out.targets[t] = defaults.clean({ templates: out.templates, targets: { [t]: v } }).targets[t]; }
    catch { notes.push(`Left out the ${tname(t)} targets – they weren’t complete numbers`); }
  }
  try { out.schedule = defaults.clean({ templates: out.templates, schedule: raw.schedule }).schedule; }
  catch { if (raw.schedule) notes.push('Left out the week – it needs 7 days, each one of the day templates'); }
  return { ...out, notes };
}

/* One file plus instructions to the model; returns the JSON object in its reply. opts.task picks the task's model and,
   unless opts.maxTokens / opts.timeout say otherwise, its output cap and how long to wait. */
async function ask(system, buf, type, what, opts = {}) {
  check(buf, type);
  const data = `data:${type};base64,${buf.toString('base64')}`;
  const part = type === 'application/pdf'
    ? { type: 'file', file: { filename: `${what.replace(/\W+/g, '-')}.pdf`, file_data: data } }
    : { type: 'image_url', image_url: { url: data } };
  return call(system, [{ type: 'text', text: `Here is the ${what}. Reply with the JSON only.` }, part], opts.maxTokens, opts.timeout, opts.task);
}

/* What ask() needs before it can send a file – also checked up front when a read runs in the background. */
function check(buf, type) {
  if (!current().key) throw Object.assign(new Error('Add an OpenRouter API key first'), { status: 400 });
  if (!TYPES_IN.includes(type)) throw Object.assign(new Error('Upload a PDF or a PNG, JPEG or WebP image'), { status: 400 });
  if (!buf || !buf.length) throw Object.assign(new Error('The file is empty'), { status: 400 });
  if (!MAGIC[type](buf)) throw Object.assign(new Error('That file isn’t a readable PDF or PNG, JPEG or WebP image'), { status: 400 });
  allow();
}

/* Instructions plus text only (no file). */
function askText(system, text, opts = {}) {
  if (!current().key) throw Object.assign(new Error('AI isn’t set up in this app yet'), { status: 400 });
  return call(system, String(text), opts.maxTokens, opts.timeout, opts.task);
}

/* Keeping a slow or failing AI service from tying up the server (numbers in LIMITS):
   - seats: at most 3 calls at once for one account and 16 in the whole app; a call waits up to 10 s for one, then is turned
     away (503, not counted);
   - breaker: after 5 failures (timeout, connection, 5xx) within a minute, or half or more of the last 20 calls, it opens and
     every call fails at once (503 + Retry-After) for 30 s, doubling to 5 minutes while the one test call let through after
     it (half-open) fails too; a 429 opens it at once for its Retry-After (2 minutes at most), a refused key or no credit
     (401/402) for 10 minutes – a new key saved on the Admin page closes it. Opening and closing go to the security log. */
const LIMITS = {
  perUser: 3, all: 16, queueWait: 10000,
  fails: 5, failWindow: 60000, recent: 20, openFirst: 30000, openMax: 5 * MIN, rateMax: 2 * MIN, authOpen: 10 * MIN,
  firstByte: FIRST_BYTE,
  maxReply: 2 * 1024 * 1024,   /* far above the biggest answer max_tokens allows (12,000 tokens ≈ 50 KB) */
};
const busyErr = () => Object.assign(new Error('The AI is busy – try again in a minute'), { status: 503 });

const seats = {
  all: 0, users: new Map(), queue: [],
  fits(uid) { return this.all < LIMITS.all && (this.users.get(uid) || 0) < LIMITS.perUser; },
  take(uid) { this.all++; this.users.set(uid, (this.users.get(uid) || 0) + 1); },
  give(uid) {
    this.all--;
    const n = this.users.get(uid) - 1;
    if (n > 0) this.users.set(uid, n); else this.users.delete(uid);
    for (let i = 0; i < this.queue.length && this.all < LIMITS.all; i++) {
      const w = this.queue[i];
      if (!this.fits(w.uid)) continue;
      this.queue.splice(i--, 1); clearTimeout(w.timer); this.take(w.uid); w.go();
    }
  },
  /* resolves with the function that gives the slot back */
  async get(uid) {
    if (!this.fits(uid)) {
      await new Promise((go, no) => {
        const w = { uid, go, timer: setTimeout(() => { this.queue.splice(this.queue.indexOf(w), 1); no(busyErr()); }, LIMITS.queueWait) };
        this.queue.push(w);
      });
    } else this.take(uid);
    let given = false;
    return () => { if (!given) { given = true; this.give(uid); } };
  },
};

const breaker = {
  state: 'closed', until: 0, wait: LIMITS.openFirst, why: '', probing: false, fails: [], recent: [],
  /* throws while open; half-open lets one call through (probe: true) */
  check() {
    if (this.state === 'closed') return false;
    const left = this.until - Date.now();
    if (left > 0 || this.probing) throw this.refusal(Math.max(1, Math.ceil(left / 1000)));
    return true;
  },
  refusal(secs) {
    const msg = this.why === 'auth' ? this.authMsg : 'The AI service isn’t answering right now – try again in a few minutes';
    const s = als.getStore();
    if (s && s.res && typeof s.res.set === 'function' && !s.res.headersSent) s.res.set('Retry-After', String(secs));
    return Object.assign(new Error(msg), { status: 503, retryAfter: secs });
  },
  open(why, ms, detail) {
    const was = this.state;
    this.state = 'open'; this.why = why; this.until = Date.now() + ms; this.probing = false; this.fails = []; this.recent = [];
    if (was === 'closed') {
      console.error(`AI breaker open for ${Math.round(ms / 1000)} s: ${detail}`);
      audit.once(null, 'ai.breaker', { id: 'open', why }, null);
    }
  },
  /* outcome of one call: 'ok', 'fail' (timeout, connection, 5xx), 'rate' (429), 'auth' (401/402) or 'other' (not the service's fault) */
  record(outcome, probe, { retryAfter, msg, detail } = {}) {
    const now = Date.now();
    if (probe) this.probing = false;
    if (outcome === 'ok') { if (this.state !== 'closed' && probe) this.reset('answered'); else this.note(true); return; }
    if (outcome === 'other') { if (probe) this.reset('answered'); return; }
    if (outcome === 'auth') { this.authMsg = msg; return this.open('auth', LIMITS.authOpen, detail); }
    if (outcome === 'rate') return this.open('rate', Math.min(retryAfter > 0 ? retryAfter * 1000 : LIMITS.openFirst, LIMITS.rateMax), detail);
    if (probe) { this.wait = Math.min(this.wait * 2, LIMITS.openMax); return this.open('fail', this.wait, detail); }
    if (this.state !== 'closed') return;   /* a call from before it opened */
    this.fails = this.fails.filter(t => now - t < LIMITS.failWindow).concat(now);
    this.note(false);
    const bad = this.recent.filter(x => !x).length;
    if (this.fails.length >= LIMITS.fails || (this.recent.length >= LIMITS.recent && bad * 2 >= LIMITS.recent)) { this.wait = LIMITS.openFirst; this.open('fail', this.wait, detail); }
  },
  note(ok) { this.recent.push(ok); if (this.recent.length > LIMITS.recent) this.recent.shift(); },
  reset(why) {
    const was = this.state;
    Object.assign(this, { state: 'closed', until: 0, wait: LIMITS.openFirst, why: '', probing: false, fails: [], recent: [] });
    if (was !== 'closed') { console.log(`AI breaker closed (${why})`); audit.once(null, 'ai.breaker', { id: 'close', why }, null); }
  },
};

/* The reply's body, read with a cap; a body that stops early is "cut off" (not "empty") */
async function body(r) {
  if (+r.headers.get('content-length') > LIMITS.maxReply) { r.body && r.body.cancel().catch(() => {}); throw Object.assign(new Error('too large'), { big: true }); }
  const chunks = [];
  let n = 0;
  if (r.body) {
    for await (const c of r.body) {
      n += c.length;
      if (n > LIMITS.maxReply) throw Object.assign(new Error('too large'), { big: true });
      chunks.push(c);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function call(system, content, maxTokens, timeout, task) {
  const c = current(task), t = TASKS[task] || {}, s = als.getStore();
  const o = allow();
  breaker.check();   /* fail fast before queueing */
  const release = await seats.get(s && s.user ? s.user.id : 0);
  try { return await send(c, t, o, system, content, maxTokens, timeout || (t.file ? (s && s.bg ? BG_WAIT : FILE_WAIT) : t.wait) || 3 * MIN, task); }
  finally { release(); }
}

async function send(c, t, o, system, content, maxTokens, wait, task) {
  const s = als.getStore(), probe = breaker.check();   /* again: it may have opened while this call waited for a slot */
  if (probe) breaker.probing = true;
  const fail = (outcome, msg, status, more = {}) => {
    breaker.record(outcome, probe, { ...more, msg, detail: more.detail || msg });
    if (s) s.failed = true;
    return Object.assign(new Error(msg), { status });
  };
  const slow = t.file ? 'The AI took too long – try again or use a smaller file' : 'The AI took too long – try again in a minute';
  const ctl = new AbortController(), total = AbortSignal.timeout(wait);
  const signal = AbortSignal.any([ctl.signal, total]);
  /* not a file read: the first byte must come within FIRST_BYTE (headers) */
  const first = !t.file && wait > LIMITS.firstByte ? setTimeout(() => ctl.abort(Object.assign(new Error('first byte'), { name: 'TimeoutError' })), LIMITS.firstByte) : null;
  let r, raw;
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${c.key}`, 'content-type': 'application/json', 'HTTP-Referer': config.baseUrl, 'X-Title': 'Logbook Monster' },
      body: JSON.stringify({
        model: c.model, temperature: 0, max_tokens: maxTokens || t.max || 2000,
        ...(o.aiPrivate ? { provider: { data_collection: 'deny' } } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content }],
      }),
    });
    clearTimeout(first);
    raw = await body(r);
    if (signal.aborted) throw signal.reason;   /* the time ran out while the reply was coming in */
  } catch (e) {
    clearTimeout(first);
    if (r && r.body) r.body.cancel().catch(() => {});
    const timedOut = signal.aborted && (signal.reason || {}).name === 'TimeoutError';
    if (timedOut) console.error(`AI request timed out (${c.model}, ${task || 'no task'})`);
    if (e.big) { console.error(`AI reply over ${LIMITS.maxReply} bytes (${c.model}, ${task || 'no task'})`); throw fail('other', 'The AI reply was too large', 502); }
    if (timedOut) throw fail(t.file ? 'other' : 'fail', slow, 502);   /* a long file read running out of time isn't an outage */
    throw fail('fail', r ? 'The AI reply was cut off – try again' : 'Couldn’t reach OpenRouter', 502, { detail: `${r ? 'reply cut off' : 'no connection'}: ${e.message}` });
  }
  let j;
  try { j = JSON.parse(raw); } catch { j = null; }
  if (!r.ok || !j || j.error) {
    if (r.ok && !j) throw fail(raw.trim() ? 'fail' : 'other', raw.trim() ? 'The AI reply was cut off – try again' : 'The AI sent back an empty reply – try again in a minute', 502);
    j = j || {};
    /* a plain sentence for whoever asked (often not the super admin); the provider's own words go to the log */
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`, code = (j.error && +j.error.code) || r.status;
    console.error(`AI request failed (${c.model}, ${code}): ${String(msg).slice(0, 300)}`);
    const detail = `HTTP ${code}`;
    if (code === 401 || code === 402) {
      throw fail('auth', code === 401 ? 'The AI service didn’t accept the app’s key – ask the person who runs this app to check it'
        : 'The AI service account has run out of credit – ask the person who runs this app to top it up', 502, { detail });
    }
    if (code === 403) throw fail('other', 'The AI service didn’t accept the app’s key – ask the person who runs this app to check it', 502);
    if (code === 429) throw fail('rate', 'The AI service is busy – try again in a minute', 502, { retryAfter: +r.headers.get('retry-after') || 0, detail });
    throw fail(code >= 500 || code === 408 ? 'fail' : 'other', 'The AI service couldn’t answer just now – try again later', 502, { detail });
  }
  breaker.record('ok', probe);
  used();
  const choice = (j.choices && j.choices[0]) || {};
  const text = choice.message && choice.message.content;
  const parts = Array.isArray(text) ? text.map(x => x.text || '').join('') : text;
  const model = j.model || c.model;
  try { return { reply: parseReply(parts), model }; }
  catch (e) {
    console.error(`AI reply unusable (${model}, finish_reason ${choice.finish_reason}, ${String(parts || '').length} chars): ${e.message}`);
    if (choice.finish_reason === 'length') throw unusable(`The AI reply was longer than the app allows and got cut off – ${t.file ? 'try a shorter file' : 'try again'}`);
    if (!String(parts || '').trim()) throw unusable('The AI sent back an empty reply – try again in a minute');
    throw e;
  }
}

async function importPlan(buf, type, user, date) {
  const foods = foodList(user, date);
  const { reply, model } = await ask(prompt(foods), buf, type, 'meal plan', { task: 'plan' });
  return { ...tidy(reply, foods), model };
}

module.exports = { status, save, saveNext, promote, verify, slots, importPlan, ask, askText, check, scope, limiter, TYPES_IN, breaker, seats, LIMITS };

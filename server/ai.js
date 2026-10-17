'use strict';
/* Reads a meal plan PDF (or photo) with a model on OpenRouter and turns it into an account's plan
   format: day templates with their meals, new foods, targets and the week. Nothing is saved here – the
   Account admin page loads the result into its draft so it can be checked before saving. */
const config = require('./config');
const db = require('./db');
const defaults = require('./defaults');

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';
const BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const TYPES_IN = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
/* Each kind of AI task can use its own OpenRouter model; one left blank uses the default model. */
const TASKS = {
  plan: { name: 'Meal plan import', hint: 'Reads a coach’s PDF or photo – needs a model that reads PDFs' },
  workout: { name: 'Workout plan import', hint: 'Reads a PDF or photo of a training plan – needs a model that reads PDFs' },
  supps: { name: 'Supplement regime import', hint: 'Reads a PDF or photo of a supplement regime – needs a model that reads PDFs' },
  food: { name: 'Food values', hint: 'Fills in blank calories and macros in the food library (text only)' },
  pose: { name: 'Photo poses', hint: 'Tells front / side / back from a progress photo – needs a model that sees images' },
  exercise: { name: 'Exercise body parts', hint: 'Tags exercises with the body parts they train (text only)' },
  summary: { name: 'Timeline summary', hint: 'Writes the summary of trends on the Timeline (text only)' },
};
const MODEL_RE = /^[\w.\-/:]{3,100}$/;

const q = {
  get: db.prepare("SELECT data FROM app_config WHERE key = 'openrouter'"),
  put: db.prepare(`INSERT INTO app_config (key, data, updated_by) VALUES ('openrouter', ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = datetime('now')`),
};

function stored() { const r = q.get.get(); return r ? JSON.parse(r.data) : {}; }
/* A key saved on the Admin page wins over OPENROUTER_API_KEY in .env. */
function current(task) {
  const s = stored();
  const key = s.key || process.env.OPENROUTER_API_KEY || '';
  const model = s.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  return { key, source: s.key ? 'admin' : key ? 'env' : null, model: (task && s.models && s.models[task]) || model };
}
/* What the browser may see: never the key itself. Only the super admin gets this (GET /api/admin/ai). */
function status() {
  const c = current(), own = stored().models || {};
  return { configured: !!c.key, source: c.source, hint: c.key ? '…' + c.key.slice(-4) : '', model: c.model, defaultModel: DEFAULT_MODEL,
    tasks: Object.entries(TASKS).map(([id, t]) => ({ id, name: t.name, hint: t.hint, model: own[id] || '', uses: own[id] || c.model })) };
}
function save(body, user) {
  const s = stored();
  if (body.key !== undefined) {
    const key = String(body.key || '').trim();
    if (key && !/^[\x21-\x7e]{10,300}$/.test(key)) throw new Error('That doesn’t look like an API key');
    if (key) s.key = key; else delete s.key;
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
  q.put.run(JSON.stringify(s), user.email);
  return status();
}

/* The foods the model can pick from: the account's own plan foods (the ones in its plan today). */
function foodList(user) {
  const saved = defaults.effective(user).foods || {};
  const out = {};
  for (const [id, r] of Object.entries(saved)) if (id !== 'pudding') out[id] = { n: r.n, k: r.k, p: r.p, c: r.c, f: r.f, unit: r.unit || 'g' };
  return out;
}

function prompt(foods) {
  const list = Object.entries(foods).map(([id, F]) => `${id} | ${F.n} | per 100${F.unit}: ${F.k} kcal, P ${F.p}, C ${F.c}, F ${F.f}`).join('\n');
  return `You turn a nutrition coach's meal plan document into JSON for a meal planning app.

The app keeps a plan as day templates: one for each kind of day the document gives its own meals or targets for (e.g. training day, rest day, high carb day, refeed). List them in "templates" as {"id": short id, "name": short name}. Use id "T" for a training day and "R" for a rest day; any other template gets an id of capital letters and digits starting with a letter, e.g. "HC". If the document has one plan for every day, make one template.

"plan" has a list of meals for each template id. Each meal has:
- "id": the meal number as a string ("1", "2", ...)
- "name": a short name, e.g. "Breakfast – eggs on sourdough"
- "note": optional short note from the document (e.g. cooking or swap instructions)
- "p": protein sources, "c": carb sources, vegetables, fruit, sauces, milk, "x": added fats and spreads (butter, oil, nut butter, avocado, chocolate spread)
Each item is {"f": food id, "g": amount, "lock": false}. Amounts are grams (millilitres for foods measured in ml). Convert units: 1 egg = 50g, use label weights for items such as slices or scoops if the document gives them, otherwise give your best estimate and mention it in "notes". Use lock true only for fixed recipe ingredients that must not be scaled.

Existing foods (id | name | values). Use one of these ids whenever the document's food is the same thing – check raw vs cooked weight matches:
${list || '(none yet)'}

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
      if (foods[id]) continue;                                   /* never overwrite an existing food */
      try { Object.assign(out.foods, defaults.clean({ foods: { [id]: r } }).foods); }
      catch (e) { notes.push(`Left out new food ${String(id).slice(0, 40)}: ${e.message}`); }
    }
  }
  /* day templates: as listed, plus any the plan uses without listing */
  const addTemplate = (id, name) => {
    if (typeof id !== 'string' || !TEMPLATE_ID.test(id) || out.templates.some(t => t.id === id) || out.templates.length >= 12) return;
    out.templates.push({ id, name: String(name || OLD_NAMES[id] || id).trim().slice(0, 40) || id });
  };
  for (const t of Array.isArray(raw.templates) ? raw.templates : []) if (isObj(t)) addTemplate(t.id, t.name);
  if (isObj(raw.plan)) for (const id of Object.keys(raw.plan)) addTemplate(id);
  const tname = id => out.templates.find(t => t.id === id).name;
  const known = id => typeof id === 'string' && (Object.prototype.hasOwnProperty.call(foods, id) || Object.prototype.hasOwnProperty.call(out.foods, id));
  if (isObj(raw.plan)) {
    out.plan = {};
    for (const { id: t } of out.templates) {
      if (!Array.isArray(raw.plan[t]) || !raw.plan[t].length) continue;
      out.plan[t] = raw.plan[t].slice(0, 12).filter(isObj).map((m, mi) => {
        const meal = { id: String(m.id == null ? mi + 1 : m.id).slice(0, 8), name: String(m.name || `Meal ${mi + 1}`).slice(0, 100), p: [], c: [], x: [] };
        if (m.note) meal.note = String(m.note).slice(0, 200);
        for (const b of ['p', 'c', 'x']) {
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

/* One file plus instructions to the model; returns the JSON object in its reply. No output cap by default – a long
   plan can take the model's whole output limit (and up to 10 minutes). A quick question about a picture can ask for a
   shorter reply and wait less (opts.maxTokens, opts.timeout). opts.task picks the task's model. */
async function ask(system, buf, type, what, opts = {}) {
  check(buf, type);
  const data = `data:${type};base64,${buf.toString('base64')}`;
  const part = type === 'application/pdf'
    ? { type: 'file', file: { filename: `${what.replace(/\W+/g, '-')}.pdf`, file_data: data } }
    : { type: 'image_url', image_url: { url: data } };
  return call(system, [{ type: 'text', text: `Here is the ${what}. Reply with the JSON only.` }, part], opts.maxTokens || null, opts.timeout || 600000, opts.task);
}

/* What ask() needs before it can send a file – also checked up front when a read runs in the background. */
function check(buf, type) {
  if (!current().key) throw Object.assign(new Error('Add an OpenRouter API key first'), { status: 400 });
  if (!TYPES_IN.includes(type)) throw Object.assign(new Error('Upload a PDF or a PNG, JPEG or WebP image'), { status: 400 });
  if (!buf || !buf.length) throw Object.assign(new Error('The file is empty'), { status: 400 });
}

/* Instructions plus text only (no file). */
function askText(system, text, opts = {}) {
  if (!current().key) throw Object.assign(new Error('AI isn’t set up – the super admin can add an OpenRouter API key on the Super admin page'), { status: 400 });
  return call(system, String(text), 2000, 60000, opts.task);
}

async function call(system, content, maxTokens, timeout, task) {
  const c = current(task);
  let r, j;
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeout),
      headers: { authorization: `Bearer ${c.key}`, 'content-type': 'application/json', 'HTTP-Referer': config.baseUrl, 'X-Title': 'Logbook Monster' },
      body: JSON.stringify({
        model: c.model, temperature: 0, ...(maxTokens ? { max_tokens: maxTokens } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content }],
      }),
    });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    throw Object.assign(new Error(e.name === 'TimeoutError' ? 'The AI took too long – try again' : 'Couldn’t reach OpenRouter'), { status: 502 });
  }
  if (!r.ok || j.error) {
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
    throw Object.assign(new Error(r.status === 401 ? 'OpenRouter didn’t accept the API key' : `OpenRouter: ${String(msg).slice(0, 200)}`), { status: 502 });
  }
  const choice = (j.choices && j.choices[0]) || {};
  const text = choice.message && choice.message.content;
  const parts = Array.isArray(text) ? text.map(x => x.text || '').join('') : text;
  const model = j.model || c.model;
  try { return { reply: parseReply(parts), model }; }
  catch (e) {
    console.error(`AI reply unusable (${model}, finish_reason ${choice.finish_reason}, ${String(parts || '').length} chars): ${e.message}`);
    if (choice.finish_reason === 'length') throw unusable('The AI reply was longer than this model can write and got cut off – try a shorter file, or a model with a bigger output limit for this task on the Super admin page');
    if (!String(parts || '').trim()) throw unusable(`The AI (${String(model).slice(0, 100)}) sent back an empty reply – try again, or pick another model for this task on the Super admin page`);
    throw e;
  }
}

async function importPlan(buf, type, user) {
  const foods = foodList(user);
  const { reply, model } = await ask(prompt(foods), buf, type, 'meal plan', { task: 'plan' });
  return { ...tidy(reply, foods), model };
}

module.exports = { status, save, importPlan, ask, askText, check, TYPES_IN, TASKS };

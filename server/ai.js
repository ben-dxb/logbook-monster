'use strict';
/* Reads a meal plan PDF (or photo) with a model on OpenRouter and turns it into the admin defaults
   format: plan per day type, new foods, targets and schedule. Nothing is saved here – the admin page
   loads the result into its draft so it can be checked before saving. */
const config = require('./config');
const db = require('./db');
const defaults = require('./defaults');
const { FOODS } = require('../public/engine.js');

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';
const BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const TYPES_IN = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

const q = {
  get: db.prepare("SELECT data FROM app_config WHERE key = 'openrouter'"),
  put: db.prepare(`INSERT INTO app_config (key, data, updated_by) VALUES ('openrouter', ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = datetime('now')`),
};

function stored() { const r = q.get.get(); return r ? JSON.parse(r.data) : {}; }
/* A key saved on the Admin page wins over OPENROUTER_API_KEY in .env. */
function current() {
  const s = stored();
  const key = s.key || process.env.OPENROUTER_API_KEY || '';
  return { key, source: s.key ? 'admin' : key ? 'env' : null, model: s.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL };
}
/* What the browser may see: never the key itself. */
function status() {
  const c = current();
  return { configured: !!c.key, source: c.source, hint: c.key ? '…' + c.key.slice(-4) : '', model: c.model, defaultModel: DEFAULT_MODEL };
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
    if (model && !/^[\w.\-/:]{3,100}$/.test(model)) throw new Error('Model should look like provider/model-name');
    if (model) s.model = model; else delete s.model;
  }
  q.put.run(JSON.stringify(s), user.email);
  return status();
}

/* The foods the model can pick from: built-in plus the admin's own. */
function foodList() {
  const saved = defaults.latest().foods || {};
  const out = {};
  for (const [id, F] of Object.entries(FOODS)) if (id !== 'pudding') out[id] = { n: F.n, k: F.k, p: F.p, c: F.c, f: F.f, unit: F.unit || 'g' };
  for (const [id, r] of Object.entries(saved)) out[id] = { n: r.n, k: r.k, p: r.p, c: r.c, f: r.f, unit: r.unit || 'g' };
  return out;
}

function prompt(foods) {
  const list = Object.entries(foods).map(([id, F]) => `${id} | ${F.n} | per 100${F.unit}: ${F.k} kcal, P ${F.p}, C ${F.c}, F ${F.f}`).join('\n');
  return `You turn a nutrition coach's meal plan document into JSON for a meal planning app.

The app has three day types: "T" = training day, "R" = rest day, "S" = Saturday training (a training day with an optional treat). If the document has only one training plan, use it for both T and S. If it has only one plan for every day, use it for T, R and S.

Each day type is a list of meals. Each meal has:
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

If the document states daily targets, add "targets": {"T": {"k": kcal, "p": protein g, "c": carbs g, "f": fat g}, "R": {...}, "S": {...}}.
If it says which weekdays are training or rest, add "schedule": an array of 7 day types for Monday to Sunday, e.g. ["T","T","R","T","R","S","R"].
Add "notes": an array of short strings listing anything you estimated, converted or could not read.

Reply with only the JSON object: {"plan": {"T": [...], "R": [...], "S": [...]}, "foods": {...}, "targets": {...}, "schedule": [...], "notes": [...]}`;
}

/* Pull the JSON object out of the reply, even if it is wrapped in a code fence or prose. */
function parseReply(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The AI reply had no plan in it');
  try { return JSON.parse(s.slice(a, b + 1)); } catch { throw new Error('The AI reply wasn’t valid JSON – try again'); }
}

/* Keep everything that passes the same checks as a save; list what was dropped. */
function tidy(raw, foods) {
  const notes = Array.isArray(raw.notes) ? raw.notes.filter(n => typeof n === 'string').map(n => n.slice(0, 300)).slice(0, 30) : [];
  const out = { foods: {}, plan: null, targets: {}, schedule: null };
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(raw.foods)) {
    for (const [id, r] of Object.entries(raw.foods).slice(0, 100)) {
      if (foods[id]) continue;                                   /* never overwrite an existing food */
      try { Object.assign(out.foods, defaults.clean({ foods: { [id]: r } }).foods); }
      catch (e) { notes.push(`Left out new food ${String(id).slice(0, 40)}: ${e.message}`); }
    }
  }
  const known = id => typeof id === 'string' && (Object.prototype.hasOwnProperty.call(foods, id) || Object.prototype.hasOwnProperty.call(out.foods, id));
  if (isObj(raw.plan)) {
    out.plan = {};
    for (const t of ['T', 'R', 'S']) {
      if (!Array.isArray(raw.plan[t]) || !raw.plan[t].length) continue;
      out.plan[t] = raw.plan[t].slice(0, 12).filter(isObj).map((m, mi) => {
        const meal = { id: String(m.id == null ? mi + 1 : m.id).slice(0, 8), name: String(m.name || `Meal ${mi + 1}`).slice(0, 100), p: [], c: [], x: [] };
        if (m.note) meal.note = String(m.note).slice(0, 200);
        for (const b of ['p', 'c', 'x']) {
          for (const i of (Array.isArray(m[b]) ? m[b] : []).slice(0, 20)) {
            const g = isObj(i) ? Math.round(+i.g) : NaN;
            if (!isObj(i) || !known(i.f)) { notes.push(`Left out "${String(isObj(i) ? i.f : i).slice(0, 40)}" in ${t} meal ${meal.id} – unknown food`); continue; }
            if (!Number.isFinite(g) || g < 0 || g > 5000) { notes.push(`Left out ${i.f} in ${t} meal ${meal.id} – amount isn't a number of grams`); continue; }
            meal[b].push({ f: i.f, g, lock: !!i.lock });
          }
        }
        return meal;
      });
    }
    if (!Object.keys(out.plan).length) out.plan = null;
  }
  if (!out.plan) throw new Error('The AI couldn’t find a meal plan in that file');
  try { out.targets = defaults.clean({ targets: raw.targets }).targets; } catch { if (raw.targets) notes.push('Left out the targets – they weren’t complete numbers'); }
  try { out.schedule = defaults.clean({ schedule: raw.schedule }).schedule; } catch { if (raw.schedule) notes.push('Left out the week schedule – it needs 7 days'); }
  return { ...out, notes };
}

/* One file plus instructions to the model; returns the JSON object in its reply. */
async function ask(system, buf, type, what) {
  const c = current();
  if (!c.key) throw Object.assign(new Error('Add an OpenRouter API key first'), { status: 400 });
  if (!TYPES_IN.includes(type)) throw Object.assign(new Error('Upload a PDF or a PNG, JPEG or WebP image'), { status: 400 });
  if (!buf || !buf.length) throw Object.assign(new Error('The file is empty'), { status: 400 });
  const data = `data:${type};base64,${buf.toString('base64')}`;
  const part = type === 'application/pdf'
    ? { type: 'file', file: { filename: `${what.replace(/\W+/g, '-')}.pdf`, file_data: data } }
    : { type: 'image_url', image_url: { url: data } };
  let r, j;
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(240000),
      headers: { authorization: `Bearer ${c.key}`, 'content-type': 'application/json', 'HTTP-Referer': config.baseUrl, 'X-Title': 'Logbook Monster' },
      body: JSON.stringify({
        model: c.model, temperature: 0, max_tokens: 16000,
        messages: [{ role: 'system', content: system },
          { role: 'user', content: [{ type: 'text', text: `Here is the ${what}. Reply with the JSON only.` }, part] }],
      }),
    });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    throw Object.assign(new Error(e.name === 'TimeoutError' ? 'The AI took too long – try a smaller file' : 'Couldn’t reach OpenRouter'), { status: 502 });
  }
  if (!r.ok || j.error) {
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
    throw Object.assign(new Error(r.status === 401 ? 'OpenRouter didn’t accept the API key' : `OpenRouter: ${String(msg).slice(0, 200)}`), { status: 502 });
  }
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return { reply: parseReply(Array.isArray(text) ? text.map(x => x.text || '').join('') : text), model: j.model || c.model };
}

async function importPlan(buf, type) {
  const foods = foodList();
  const { reply, model } = await ask(prompt(foods), buf, type, 'meal plan');
  return { ...tidy(reply, foods), model };
}

module.exports = { status, save, importPlan, ask, TYPES_IN };

'use strict';
/* Supplements: a library (yours plus everything someone has shared, like the food library) and a log of
   what you took each day. A log entry is picked from the library or typed in free text, with an amount
   and a unit (g, mg, mcg, IU, capsules…). Only the owner changes a library entry; an admin can also
   remove a shared one. A supplement regime (a coach's PDF or a photo) can be read with AI into line items,
   checked in the browser, then added to the library – and logged for a day – with /import. */
const express = require('express');
const db = require('./db');
const { isDate, writeError } = require('./dates');
const { isNum } = require('./num');
const ai = require('./ai');
const jobs = require('./jobs');
const audit = require('./audit');

const COLS = 's.id, s.user_id, s.name, s.amount, s.unit, s.notes, s.public, s.updated_at, u.name AS owner';
const LOG = 'id, date, supplement_id AS sid, name, amount, unit, note, created_at AS created';
const q = {
  list: db.prepare(`SELECT ${COLS} FROM supplements s JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ? OR s.public = 1 ORDER BY s.name COLLATE NOCASE, s.id`),
  get: db.prepare(`SELECT ${COLS} FROM supplements s JOIN users u ON u.id = s.user_id WHERE s.id = ?`),
  count: db.prepare('SELECT COUNT(*) AS n FROM supplements WHERE user_id = ?'),
  add: db.prepare('INSERT INTO supplements (user_id, name, amount, unit, notes, public) VALUES (?, ?, ?, ?, ?, ?)'),
  put: db.prepare(`UPDATE supplements SET name = ?, amount = ?, unit = ?, notes = ?, public = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`),
  del: db.prepare('DELETE FROM supplements WHERE id = ?'),
  mine: db.prepare('SELECT id, name, amount, unit, notes, public FROM supplements WHERE user_id = ? ORDER BY id'),
  mineByName: db.prepare('SELECT id FROM supplements WHERE user_id = ? AND name = ? COLLATE NOCASE ORDER BY id LIMIT 1'),

  logRange: db.prepare(`SELECT ${LOG} FROM supplement_log WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date, id`),
  logGet: db.prepare(`SELECT ${LOG} FROM supplement_log WHERE user_id = ? AND id = ?`),
  logCount: db.prepare('SELECT COUNT(*) AS n FROM supplement_log WHERE user_id = ?'),
  logAdd: db.prepare('INSERT INTO supplement_log (user_id, date, supplement_id, name, amount, unit, note) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  logPut: db.prepare('UPDATE supplement_log SET date = ?, supplement_id = ?, name = ?, amount = ?, unit = ?, note = ? WHERE user_id = ? AND id = ?'),
  logDel: db.prepare('DELETE FROM supplement_log WHERE user_id = ? AND id = ?'),
  logAll: db.prepare(`SELECT ${LOG} FROM supplement_log WHERE user_id = ? ORDER BY date, id`),

  trends: db.prepare('SELECT name FROM supplement_trends WHERE user_id = ? ORDER BY name'),
  trendCount: db.prepare('SELECT COUNT(*) AS n FROM supplement_trends WHERE user_id = ?'),
  trendAdd: db.prepare('INSERT OR IGNORE INTO supplement_trends (user_id, name) VALUES (?, ?)'),
  trendDel: db.prepare('DELETE FROM supplement_trends WHERE user_id = ? AND name = ?'),
};
const trendsOf = user => q.trends.all(user.id).map(r => r.name);

const MAX_SUPPS = 300, MAX_LOG = 50000, MAX_TRENDS = 30;
const UNITS = ['g', 'mg', 'mcg', 'IU', 'ml', 'drops', 'capsules', 'tablets', 'softgels', 'scoops', 'servings'];
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const idOf = v => (/^\d{1,12}$/.test(String(v)) ? +v : 0);
const line = (v, max, what) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (s.length > max) throw fail(`${what} is too long (${max} characters at most)`);
  return s;
};
const unitOf = v => {
  if (!UNITS.includes(v)) throw fail(`Pick a unit: ${UNITS.join(', ')}`);
  return v;
};
/* amounts keep up to three decimals (0.125 mg); blank is allowed only where the amount is optional */
function amountOf(v, optional) {
  if (optional && (v === '' || v == null)) return null;
  const n = +v;
  if (!isNum(v) || n <= 0 || n > 1e6) throw fail('Amount must be a number above 0');
  const r = Math.round(n * 1000) / 1000;
  if (!r) throw fail('That amount is too small to keep – use a smaller unit (mg or mcg)');   /* never stored as 0 */
  return r;
}

function clean(b) {
  if (!isObj(b)) throw fail('Supplement must be an object');
  const name = line(b.name, 80, 'Name');
  if (!name) throw fail('Give the supplement a name');
  const notes = String(b.notes == null ? '' : b.notes).replace(/\r\n?/g, '\n').trim();
  if (notes.length > 2000) throw fail('Notes are too long (2000 characters at most)');
  return { name, amount: amountOf(b.amount, true), unit: unitOf(b.unit), notes, public: b.public ? 1 : 0 };
}

const visible = (row, user) => row && (row.user_id === user.id || row.public);
/* one name per supplement in your library, whatever the case: a second is refused (the app uses the one you have) */
function noTwin(user, name, id) {
  const n = name.toLowerCase(), twin = q.mine.all(user.id).find(r => r.id !== id && r.name.toLowerCase() === n);
  if (twin) throw fail(`You already have a supplement called ${twin.name}`, 409);
}

/* A log entry from the library takes its name from there unless you typed one; a free-text entry needs a
   description. keep is the entry being edited: its own link stays even if that supplement has since gone private. */
function cleanLog(b, user, keep) {
  if (!isObj(b)) throw fail('Entry must be an object');
  const bad = writeError(b.date, 'Pick a day');
  if (bad) throw fail(bad);
  let sid = null, name = line(b.name, 200, 'Description');
  if (b.supplement != null && b.supplement !== '') {
    const id = idOf(b.supplement);
    if (keep && keep.sid && id === keep.sid) { sid = id; if (!name) name = keep.name; }
    else {
      const row = q.get.get(id);
      if (!visible(row, user)) throw fail('That supplement isn’t in the library', 404);
      sid = row.id; if (!name) name = row.name;
    }
  }
  if (!name) throw fail('Pick a supplement or describe it');
  return { date: b.date, sid, name, amount: amountOf(b.amount), unit: unitOf(b.unit), note: line(b.note, 200, 'Note') };
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------- AI: read a supplement regime into line items ---------- */
const MAX_ITEMS = 60;
function prompt(names) {
  return `You turn a supplement regime (a coach's or doctor's PDF, a screenshot or a photo of a list or a pill organiser chart) into JSON line items for a supplement tracking app.

Make one item per supplement and dose. If the same supplement is taken at different times of day with the same amount, make one item and say when in "notes" (e.g. "Morning and evening with food"); if the amounts differ, make one item per time.
Each item is {"name": short product or nutrient name (at most 80 characters, e.g. "Vitamin D3", "Magnesium glycinate", "Omega-3 fish oil"), "amount": the amount taken each time as a number (null if the document gives none), "unit": one of ${UNITS.join(', ')}, "notes": when and how to take it, how often if not daily, strength per capsule or brand, at most 300 characters}.
Pick the unit the document uses for the dose: a count of capsules / tablets / softgels / scoops when it says "2 caps", otherwise the weight or IU. Convert µg to mcg. Put the strength per capsule in notes when the dose is a count.

The person already has these supplements in their library – when the document means the same thing, use exactly that name:
${names.length ? names.map(n => '- ' + n).join('\n') : '(none yet)'}

Add "notes": an array of short strings listing anything you estimated, converted or could not read.

Reply with only the JSON object: {"items": [{"name": "...", "amount": 5, "unit": "g", "notes": "..."}], "notes": [...]}`;
}
/* the model's unit words onto ours: "µg" → mcg, "capsule" → capsules, "iu" → IU */
const UNIT_ALIAS = Object.assign(Object.create(null), { 'µg': 'mcg', 'μg': 'mcg', ug: 'mcg', microgram: 'mcg', micrograms: 'mcg', milligram: 'mg', milligrams: 'mg', gram: 'g', grams: 'g',
  iu: 'IU', caps: 'capsules', cap: 'capsules', capsule: 'capsules', tab: 'tablets', tabs: 'tablets', tablet: 'tablets', softgel: 'softgels',
  scoop: 'scoops', serving: 'servings', drop: 'drops', millilitres: 'ml', milliliters: 'ml', mL: 'ml' });
function aiUnit(v) {
  const s = String(v == null ? '' : v).trim();
  if (UNITS.includes(s)) return s;
  const a = UNIT_ALIAS[s] || UNIT_ALIAS[s.toLowerCase()];
  if (a) return a;
  return UNITS.find(u => u.toLowerCase() === s.toLowerCase()) || null;
}
function tidyItems(raw, user) {
  const notes = Array.isArray(raw.notes) ? raw.notes.filter(n => typeof n === 'string').map(n => n.slice(0, 300)).slice(0, 30) : [];
  const items = [], told = [], all = (Array.isArray(raw.items) ? raw.items : []).filter(isObj);
  let blank = 0;
  for (const r of all.slice(0, MAX_ITEMS)) {
    const name = String(r.name == null ? '' : r.name).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) { blank++; continue; }
    let unit = aiUnit(r.unit), amount = null, said = '';
    if (!unit) {   /* an amount in a unit the app doesn't have: kept as text in the item's notes rather than turned into mg */
      const u = String(r.unit == null ? '' : r.unit).replace(/\s+/g, ' ').trim().slice(0, 20), a = r.amount == null ? '' : String(r.amount).trim().slice(0, 20);
      said = [a, u].filter(Boolean).join(' ');
      told.push(said ? `${name}: “${said}” isn’t in a unit the app knows – kept in its notes; pick an amount and unit before adding` : `${name}: no unit given – pick one before adding`);
      unit = 'mg';
    } else if (r.amount != null && r.amount !== '') {
      try { amount = amountOf(r.amount); } catch { told.push(`${name}: left out the amount – it wasn’t a number`); }
    }
    const row = q.mineByName.get(user.id, name), note = String(r.notes == null ? '' : r.notes).replace(/\s+/g, ' ').trim();
    items.push({ name, amount, unit, notes: (said ? `Amount: ${said}` + (note ? ' – ' + note : '') : note).slice(0, 300), existing: row ? row.id : null });
  }
  if (blank) told.push(`${blank} line${blank === 1 ? '' : 's'} with no name ${blank === 1 ? 'was' : 'were'} left out.`);
  if (all.length > MAX_ITEMS) told.push(`The regime has ${all.length} lines; one read takes the first ${MAX_ITEMS}, so ${all.length - MAX_ITEMS} were left out: ${all.slice(MAX_ITEMS).map(r => String(r.name == null ? '' : r.name).trim().slice(0, 40)).filter(Boolean).join(', ').slice(0, 400) || 'no names'}.`);
  if (!items.length) throw Object.assign(new Error('The AI couldn’t find any supplements in that file'), { status: 422 });
  return { items, notes: [...told, ...notes] };
}

/* The OpenRouter key is the admin's, so each account gets a handful of reads an hour. */
const aiLimit = ai.limiter(12, 'That’s a lot of AI reads – wait a while and try again.');

/* Other people's supplements show their name, never their email. Someone with no name gets a number instead ("another person
   (#2)"), the same on everything of theirs in this list, so two people's items with the same name can be told apart. */
function anonOf(rows, user) {
  const ids = [...new Set(rows.filter(r => r.user_id !== user.id && !r.owner).map(r => r.user_id))].sort((a, b) => a - b);
  return new Map(ids.map((id, i) => [id, i + 1]));
}
function view(r, user, anon) {
  const mine = r.user_id === user.id;
  return { id: r.id, name: r.name, amount: r.amount, unit: r.unit, notes: r.notes,
    public: !!r.public, mine, by: mine ? null : r.owner || null, ...(anon && anon.has(r.user_id) ? { anon: anon.get(r.user_id) } : {}), updated: r.updated_at };
}

const router = express.Router();
const send = (res, e) => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); };

router.get('/', (req, res) => { const rows = q.list.all(req.user.id), anon = anonOf(rows, req.user); res.json({ supplements: rows.map(r => view(r, req.user, anon)), units: UNITS, trends: trendsOf(req.user),
  ai: ai.status().configured }); });

/* AI: read the file and hand back line items to check. Nothing is saved until /import. ?bg=1 runs it in the background (server/jobs.js). */
router.post('/ai-import', aiLimit, express.raw({ type: ai.TYPES_IN, limit: '10mb' }), ai.scope, (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null, type = String(req.get('content-type') || '').split(';')[0].trim();
  return jobs.respond(req, res, 'supps', () => ai.check(buf, type), async () => {
    const names = q.mine.all(req.user.id).map(r => r.name);
    const { reply, model } = await ai.ask(prompt(names), buf, type, 'supplement regime', { task: 'supps' });
    return { ...tidyItems(reply, req.user), model };
  });
});

/* Add checked line items to your library – one you already have by the same name is updated with the new amount,
   unit and notes rather than added twice (a line without an amount keeps the one it had) – and, with a date in "log", log each one that has an amount on that day. */
router.post('/import', (req, res) => {
  try {
    const list = isObj(req.body) && Array.isArray(req.body.items) ? req.body.items : null;
    if (!list || !list.length) throw fail('Nothing to import');
    if (list.length > MAX_ITEMS) throw fail(`Import ${MAX_ITEMS} supplements at most at a time`);
    const day = req.body.log == null || req.body.log === '' ? null : req.body.log;
    if (day !== null && writeError(day)) throw fail(writeError(day, 'Pick a day to log them on'));
    const items = list.map((b, i) => {
      try { return clean({ ...(isObj(b) ? b : {}), public: false }); }
      catch (e) { throw fail(`Item ${i + 1}${isObj(b) && b.name ? ` (${String(b.name).slice(0, 40)})` : ''}: ${e.message}`); }
    });
    const out = tx(() => {
      let added = 0, updated = 0;
      const entries = [];
      for (const d of items) {
        const have = q.mineByName.get(req.user.id, d.name);
        let id;
        if (have) {
          const row = q.get.get(have.id);
          /* a line with no amount keeps the usual amount (and its unit) you already had */
          const keep = d.amount == null;
          q.put.run(d.name, keep ? row.amount : d.amount, keep ? row.unit : d.unit, d.notes || row.notes, row.public, have.id, req.user.id);
          id = have.id; updated++;
        } else {
          if (q.count.get(req.user.id).n >= MAX_SUPPS) throw fail(`Your supplement library is full (${MAX_SUPPS})`);
          id = Number(q.add.run(req.user.id, d.name, d.amount, d.unit, d.notes, 0).lastInsertRowid); added++;
        }
        if (day && d.amount != null) {
          if (q.logCount.get(req.user.id).n >= MAX_LOG) throw fail('Your supplement log is full');
          entries.push(q.logGet.get(req.user.id, Number(q.logAdd.run(req.user.id, day, id, d.name, d.amount, d.unit, '').lastInsertRowid)));
        }
      }
      return { added, updated, entries };
    });
    res.json({ ...out, supplements: q.list.all(req.user.id).map(r => view(r, req.user)) });
  } catch (e) { send(res, e); }
});

/* "Trend" box: follow a supplement (by name) on the Timeline's chart. Declared before /:id. */
router.put('/trend', (req, res) => {
  try {
    if (!isObj(req.body)) throw fail('Send a name');
    const name = line(req.body.name, 200, 'Name');
    if (!name) throw fail('Send a name');
    if (req.body.on) {
      if (q.trendCount.get(req.user.id).n >= MAX_TRENDS) throw fail(`You can follow ${MAX_TRENDS} supplements on the trend chart at most`);
      q.trendAdd.run(req.user.id, name);
    } else q.trendDel.run(req.user.id, name);
    res.json({ trends: trendsOf(req.user) });
  } catch (e) { send(res, e); }
});

router.post('/', (req, res) => {
  try {
    const d = clean(req.body);
    noTwin(req.user, d.name);
    if (q.count.get(req.user.id).n >= MAX_SUPPS) throw fail(`Your supplement library is full (${MAX_SUPPS})`);
    const { lastInsertRowid } = q.add.run(req.user.id, d.name, d.amount, d.unit, d.notes, d.public);
    res.json(view(q.get.get(Number(lastInsertRowid)), req.user));
  } catch (e) { send(res, e); }
});

/* the log: GET /log?date=… for one day, or ?from=…&to=… for a range */
router.get('/log', (req, res) => {
  const { date, from, to } = req.query;
  if (date !== undefined && !isDate(date)) return res.status(400).json({ error: 'Bad date' });
  const a = date || (isDate(from) ? from : '0000-01-01'), z = date || (isDate(to) ? to : '9999-12-31');
  res.json({ entries: q.logRange.all(req.user.id, a, z) });
});
router.post('/log', (req, res) => {
  try {
    const d = cleanLog(req.body, req.user);
    if (q.logCount.get(req.user.id).n >= MAX_LOG) throw fail('Your supplement log is full');
    const { lastInsertRowid } = q.logAdd.run(req.user.id, d.date, d.sid, d.name, d.amount, d.unit, d.note);
    res.json(q.logGet.get(req.user.id, Number(lastInsertRowid)));
  } catch (e) { send(res, e); }
});
router.put('/log/:id', (req, res) => {
  try {
    const row = q.logGet.get(req.user.id, idOf(req.params.id));
    if (!row) throw fail('No such entry', 404);
    const d = cleanLog(req.body, req.user, row);
    q.logPut.run(d.date, d.sid, d.name, d.amount, d.unit, d.note, req.user.id, row.id);
    res.json(q.logGet.get(req.user.id, row.id));
  } catch (e) { send(res, e); }
});
router.delete('/log/:id', (req, res) => {
  q.logDel.run(req.user.id, idOf(req.params.id));
  res.json({ ok: true });
});

router.put('/:id', (req, res) => {
  try {
    const row = q.get.get(idOf(req.params.id));
    if (!visible(row, req.user)) throw fail('No such supplement', 404);
    if (row.user_id !== req.user.id) throw fail('Only the person who added this supplement can change it', 403);
    const d = clean(req.body);
    noTwin(req.user, d.name, row.id);
    q.put.run(d.name, d.amount, d.unit, d.notes, d.public, row.id, req.user.id);
    res.json(view(q.get.get(row.id), req.user));
  } catch (e) { send(res, e); }
});

router.delete('/:id', (req, res) => {
  try {
    const row = q.get.get(idOf(req.params.id));
    if (!visible(row, req.user)) throw fail('No such supplement', 404);
    if (row.user_id !== req.user.id && !require('./api').superAdmin(req.user)) throw fail('Only the person who added this supplement can remove it', 403);
    q.del.run(row.id);
    if (row.user_id !== req.user.id) audit.log(req, 'supp.removed', { id: row.id, name: row.name }, row.user_id);
    res.json({ ok: true });
  } catch (e) { send(res, e); }
});

const exportFor = user => ({
  library: q.mine.all(user.id).map(r => ({ ...r, public: !!r.public })),
  log: q.logAll.all(user.id),
  trends: trendsOf(user),
});

module.exports = { router, exportFor, trendsOf, aiUnit };

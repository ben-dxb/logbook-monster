'use strict';
/* Workout tracking: an exercise library, workouts (named lists of exercises with a target such as
   "2 × 8–15"), and the sets you log against each exercise. Everything belongs to one account.
   Workout plans can be read from a PDF or photo with AI, checked in the browser, then imported. */
const express = require('express');
const db = require('./db');
const { isDate, writeError } = require('./dates');
const ai = require('./ai');
const jobs = require('./jobs');

const q = {
  exercises: db.prepare(`SELECT e.id, e.name, e.notes, e.trend, e.parts, COUNT(s.id) AS sets, MAX(s.at) AS last
    FROM exercises e LEFT JOIN sets s ON s.exercise_id = e.id WHERE e.user_id = ? GROUP BY e.id ORDER BY e.name COLLATE NOCASE`),
  exercise: db.prepare('SELECT id, name, notes, trend, parts FROM exercises WHERE user_id = ? AND id = ?'),
  exerciseByName: db.prepare('SELECT id, name, notes FROM exercises WHERE user_id = ? AND name = ? COLLATE NOCASE'),
  countExercises: db.prepare('SELECT COUNT(*) AS n FROM exercises WHERE user_id = ?'),
  addExercise: db.prepare('INSERT INTO exercises (user_id, name, notes) VALUES (?, ?, ?)'),
  putExercise: db.prepare('UPDATE exercises SET name = ?, notes = ? WHERE user_id = ? AND id = ?'),
  partsExercise: db.prepare('UPDATE exercises SET parts = ? WHERE user_id = ? AND id = ?'),
  trendExercise: db.prepare('UPDATE exercises SET trend = ? WHERE user_id = ? AND id = ?'),
  trendClear: db.prepare('UPDATE exercises SET trend = 0 WHERE user_id = ?'),
  trendCount: db.prepare('SELECT COUNT(*) AS n FROM exercises WHERE user_id = ? AND trend = 1'),
  trendIds: db.prepare('SELECT id FROM exercises WHERE user_id = ? AND trend = 1 ORDER BY id'),
  delExercise: db.prepare('DELETE FROM exercises WHERE user_id = ? AND id = ?'),

  workouts: db.prepare('SELECT id, name, description, items FROM workouts WHERE user_id = ? ORDER BY position, id'),
  workout: db.prepare('SELECT id FROM workouts WHERE user_id = ? AND id = ?'),
  countWorkouts: db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS pos FROM workouts WHERE user_id = ?'),
  addWorkout: db.prepare('INSERT INTO workouts (user_id, name, description, items, position) VALUES (?, ?, ?, ?, ?)'),
  putWorkout: db.prepare(`UPDATE workouts SET name = ?, description = ?, items = ?, updated_at = datetime('now') WHERE user_id = ? AND id = ?`),
  moveWorkout: db.prepare('UPDATE workouts SET position = ? WHERE user_id = ? AND id = ?'),
  delWorkout: db.prepare('DELETE FROM workouts WHERE user_id = ? AND id = ?'),

  setsFor: db.prepare('SELECT id, exercise_id AS e, reps, kg, note, at FROM sets WHERE user_id = ? AND exercise_id = ? ORDER BY at, id'),
  setsOn: db.prepare(`SELECT id, exercise_id AS e, reps, kg, note, at FROM sets WHERE user_id = ? AND at >= ? AND at < ? ORDER BY at, id`),
  set: db.prepare('SELECT id, exercise_id AS e, reps, kg, note, at FROM sets WHERE user_id = ? AND id = ?'),
  addSet: db.prepare('INSERT INTO sets (user_id, exercise_id, reps, kg, note, at) VALUES (?, ?, ?, ?, ?, ?)'),
  putSet: db.prepare('UPDATE sets SET exercise_id = ?, reps = ?, kg = ?, note = ?, at = ? WHERE user_id = ? AND id = ?'),
  delSet: db.prepare('DELETE FROM sets WHERE user_id = ? AND id = ?'),
  countSets: db.prepare('SELECT COUNT(*) AS n FROM sets WHERE user_id = ?'),
  sessions: db.prepare(`SELECT substr(at, 1, 10) AS date, COUNT(*) AS sets, SUM(reps * kg) AS volume,
    MIN(at) AS first, MAX(at) AS last, group_concat(DISTINCT exercise_id) AS ex
    FROM sets WHERE user_id = ? GROUP BY date ORDER BY date DESC LIMIT ?`),
  sameSets: db.prepare('SELECT COUNT(*) AS n FROM sets WHERE user_id = ? AND exercise_id = ? AND at = ? AND reps = ? AND kg = ?'),
  allSets: db.prepare('SELECT id, exercise_id AS e, reps, kg, note, at FROM sets WHERE user_id = ? ORDER BY at, id'),
};

/* Body parts an exercise can be tagged with – the filters on the exercise picker. */
const PARTS = [['chest', 'Chest'], ['back', 'Back'], ['shoulders', 'Shoulders'], ['traps', 'Traps'], ['biceps', 'Biceps'], ['triceps', 'Triceps'],
  ['forearms', 'Forearms'], ['core', 'Core'], ['glutes', 'Glutes'], ['quads', 'Quads'], ['hamstrings', 'Hamstrings'], ['adductors', 'Adductors'],
  ['calves', 'Calves'], ['cardio', 'Cardio']].map(([id, name]) => ({ id, name }));
const PART_IDS = PARTS.map(p => p.id);
/* known ids only, no repeats, main part first as given; null when the list isn't a list */
function cleanParts(v) {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.map(x => String(x).toLowerCase().trim()))].filter(id => PART_IDS.includes(id)).slice(0, 6);
}
const partsOut = r => r && ({ ...r, parts: r.parts ? r.parts.split(',') : [] });

const MAX = { exercises: 500, workouts: 60, items: 40, sets: 100000, trends: 30 };
const AT_RE = /^(\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const fail = msg => Object.assign(new Error(msg), { status: 400 });

function text(v, max, what, required) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (required && !s) throw fail(`${what} is missing`);
  if (s.length > max) throw fail(`${what} is too long (${max} characters at most)`);
  return s;
}
const longText = (v, max, what) => {
  const s = String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
  if (s.length > max) throw fail(`${what} is too long (${max} characters at most)`);
  return s;
};
const idOf = v => (/^\d{1,12}$/.test(String(v)) ? +v : NaN);

function cleanSet(b, user) {
  if (!isObj(b)) throw fail('Set must be an object');
  const e = idOf(b.exercise);
  if (!q.exercise.get(user.id, e)) throw fail('Pick an exercise');
  const reps = +b.reps, kg = +b.kg;
  if (!Number.isInteger(reps) || reps < 0 || reps > 1000) throw fail('Reps must be a whole number from 0 to 1000');
  if (!Number.isFinite(kg) || kg < -500 || kg > 2000) throw fail('Weight must be between -500 and 2000 kg');
  const m = AT_RE.exec(String(b.at || ''));
  if (!m || !isDate(m[1])) throw fail('Date and time look wrong');
  if (writeError(m[1])) throw fail(writeError(m[1]));
  const at = m[5] ? b.at : b.at + ':00';
  return { e, reps, kg: Math.round(kg * 100) / 100, note: text(b.note, 300, 'Note'), at };
}

/* Workout items point at exercises; anything that isn't one of yours is refused. */
function cleanWorkout(b, user) {
  if (!isObj(b)) throw fail('Workout must be an object');
  const name = text(b.name, 80, 'Workout name', true);
  const description = longText(b.description, 1000, 'Description');
  if (!Array.isArray(b.items)) throw fail('Workout needs a list of exercises');
  if (b.items.length > MAX.items) throw fail(`A workout can have ${MAX.items} exercises at most`);
  const items = b.items.map(i => {
    const e = idOf(isObj(i) ? i.e : NaN);
    if (!q.exercise.get(user.id, e)) throw fail('One of the exercises in this workout doesn’t exist');
    const out = { e };
    const target = text(i.target, 200, 'Target');
    if (target) out.target = target;
    return out;
  });
  return { name, description, items: JSON.stringify(items) };
}

function exerciseCreate(user, name, notes) {
  const n = text(name, 80, 'Exercise name', true);
  const found = q.exerciseByName.get(user.id, n);
  if (found) return found.id;
  if (q.countExercises.get(user.id).n >= MAX.exercises) throw fail(`You can have ${MAX.exercises} exercises at most`);
  return Number(q.addExercise.run(user.id, n, longText(notes, 1000, 'Notes')).lastInsertRowid);
}

function overview(user) {
  const exercises = q.exercises.all(user.id).map(partsOut);
  const ids = new Set(exercises.map(e => e.id));
  const workouts = q.workouts.all(user.id).map(w => ({ ...w, items: JSON.parse(w.items).filter(i => ids.has(i.e)) }));
  return { exercises, workouts };
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------- AI: which body parts each exercise trains ---------- */
const PARTS_PROMPT = `You tag gym exercises with the body parts they train, for a workout tracking app.
For each exercise give the muscle groups it trains significantly: the main mover first, then important secondary muscles (at most 4).
Use only these ids: ${PART_IDS.join(', ')}.
"back" covers lats, rhomboids and lower back; "core" covers abs and obliques; "cardio" is for conditioning work such as running, rowing or the bike.
Machine brand names (Panatta, Atlantis, Hammer Strength…) are only equipment – go by the movement.
If a name is too unclear to tell, give an empty list.
Reply with only JSON: {"exercises": [{"id": <the id given>, "parts": ["quads", "glutes"]}]}`;

async function tagParts(user, ids) {
  const list = ids.map(id => q.exercise.get(user.id, id)).filter(Boolean);
  if (!list.length) throw fail('Pick exercises to tag');
  const { reply, model } = await ai.askText(PARTS_PROMPT, list.map(e => `${e.id}: ${e.name}`).join('\n'), { task: 'exercise' });
  const got = new Map((isObj(reply) && Array.isArray(reply.exercises) ? reply.exercises : []).filter(isObj).map(x => [idOf(x.id), cleanParts(x.parts)]));
  let tagged = 0;
  tx(() => list.forEach(e => {
    const parts = got.get(e.id);
    if (parts && parts.length) { q.partsExercise.run(parts.join(','), user.id, e.id); tagged++; }
  }));
  return { tagged, model, exercises: overview(user).exercises };
}

/* ---------- AI: read a workout plan ---------- */
function prompt(names) {
  return `You turn a strength training program (a coach's PDF, a spreadsheet screenshot or a photo of a plan) into JSON for a workout tracking app.

A program is a list of workouts (training days or sessions, e.g. "Monday — Upper", "Push A", "Day 2 – Lower"). Each workout has:
- "name": short name as written in the document, prefixed with the weekday if the document says which day it is done
- "description": one or two sentences summarising the session (number of working sets, the focus, order or rest instructions the document gives)
- "exercises": the exercises in the order they are done, each {"name": exercise name, "target": the prescription in a short form, e.g. "3 × 8–12", "1 × 5–8 heavy, then 1 × 10–15 lighter", "2 × 12–15, 60s rest", "3 × 30s", "parts": the body parts it trains, main mover first, at most 4, from these ids: ${PART_IDS.join(', ')}}
Keep warm-ups, cardio and stretching only if the document lists them as exercises. Keep supersets in order and mention the pairing in the target ("superset with lateral raise").

The person already has these exercises. When the document means the same exercise, use the exact same name so their history carries over:
${names.length ? names.join('\n') : '(none yet)'}
For other exercises use a clear name (equipment + movement, e.g. "Incline dumbbell press"), keeping brand names of machines if the document gives them.

Add "notes": an array of short strings listing anything you were unsure of or could not read.

Reply with only the JSON object: {"workouts": [...], "notes": [...]}`;
}

function tidyWorkouts(raw, user) {
  const notes = Array.isArray(raw.notes) ? raw.notes.filter(n => typeof n === 'string').map(n => n.slice(0, 300)).slice(0, 30) : [];
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const workouts = (Array.isArray(raw.workouts) ? raw.workouts : []).filter(isObj).slice(0, 14).map((w, wi) => {
    const exercises = (Array.isArray(w.exercises) ? w.exercises : []).slice(0, MAX.items).map(x => {
      const name = str(isObj(x) ? x.name : x, 80);
      if (!name) return null;
      const found = q.exerciseByName.get(user.id, name);
      return { name: found ? found.name : name, target: str(isObj(x) ? x.target : '', 200), existing: found ? found.id : null, parts: (isObj(x) && cleanParts(x.parts)) || [] };
    }).filter(Boolean);
    return { name: str(w.name, 80) || `Workout ${wi + 1}`, description: String(w.description == null ? '' : w.description).trim().slice(0, 1000), exercises };
  }).filter(w => w.exercises.length);
  if (!workouts.length) throw Object.assign(new Error('The AI couldn’t find a workout plan in that file'), { status: 400 });
  return { workouts, notes };
}

/* The OpenRouter key is the admin's, so each account gets a handful of reads an hour. */
const partsLimit = ai.limiter(30, 'That’s a lot of AI tagging – wait a while and try again.');
const aiLimit = ai.limiter(12, 'That’s a lot of AI reads – wait a while and try again.');

/* ---------- routes ---------- */
const router = express.Router();
const send = fn => (req, res) => {
  try { res.json(fn(req)); }
  catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); if (!e.status) console.error(e); }
};
const notFound = what => Object.assign(new Error(`No such ${what}`), { status: 404 });

router.get('/', send(req => ({ ...overview(req.user), parts: PARTS, ai: ai.status().configured })));

router.post('/exercises', send(req => {
  const b = isObj(req.body) ? req.body : {};
  return partsOut(q.exercise.get(req.user.id, exerciseCreate(req.user, b.name, b.notes)));
}));
/* AI: tag these exercises (yours, 40 at most a time) with the body parts they train. */
router.post('/exercises/ai-parts', partsLimit, async (req, res) => {
  try {
    const ids = isObj(req.body) && Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(idOf))] : null;
    if (!ids || !ids.length || ids.some(n => !Number.isFinite(n))) throw fail('Send a list of exercise ids');
    if (ids.length > 40) throw fail('Tag 40 exercises at most at a time');
    res.json(await tagParts(req.user, ids));
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); if (!e.status) console.error(e); }
});
router.put('/exercises/:id', send(req => {
  const id = idOf(req.params.id), b = isObj(req.body) ? req.body : {};
  if (!q.exercise.get(req.user.id, id)) throw notFound('exercise');
  const name = text(b.name, 80, 'Exercise name', true);
  const other = q.exerciseByName.get(req.user.id, name);
  if (other && other.id !== id) throw fail(`You already have an exercise called ${other.name}`);
  const parts = b.parts === undefined ? null : cleanParts(b.parts);
  if (b.parts !== undefined && !parts) throw fail('Body parts must be a list');
  tx(() => {
    q.putExercise.run(name, longText(b.notes, 1000, 'Notes'), req.user.id, id);
    if (parts) q.partsExercise.run(parts.join(','), req.user.id, id);
  });
  return partsOut(q.exercise.get(req.user.id, id));
}));
/* "Trend": follow one exercise's estimated one-rep max on the Timeline's chart */
router.put('/exercises/:id/trend', send(req => {
  const id = idOf(req.params.id), on = !!(isObj(req.body) && req.body.on);
  const e = q.exercise.get(req.user.id, id);
  if (!e) throw notFound('exercise');
  if (on && !e.trend && q.trendCount.get(req.user.id).n >= MAX.trends) throw fail(`You can follow ${MAX.trends} exercises on the trend chart at most`);
  q.trendExercise.run(on ? 1 : 0, req.user.id, id);
  return partsOut(q.exercise.get(req.user.id, id));
}));
/* the Timeline's exercise picker: the whole list of followed exercises at once */
router.put('/trends', send(req => {
  const ids = isObj(req.body) && Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(idOf))] : null;
  if (!ids || ids.some(n => !Number.isFinite(n))) throw fail('Send a list of exercise ids');
  if (ids.length > MAX.trends) throw fail(`You can follow ${MAX.trends} exercises on the trend chart at most`);
  if (ids.some(id => !q.exercise.get(req.user.id, id))) throw fail('One of those exercises doesn’t exist');
  db.exec('BEGIN');
  try { q.trendClear.run(req.user.id); ids.forEach(id => q.trendExercise.run(1, req.user.id, id)); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ids: q.trendIds.all(req.user.id).map(r => r.id) };
}));
router.delete('/exercises/:id', send(req => { q.delExercise.run(req.user.id, idOf(req.params.id)); return { ok: true }; }));

router.post('/workouts', send(req => {
  const w = cleanWorkout(req.body, req.user);
  const c = q.countWorkouts.get(req.user.id);
  if (c.n >= MAX.workouts) throw fail(`You can have ${MAX.workouts} workouts at most`);
  const id = Number(q.addWorkout.run(req.user.id, w.name, w.description, w.items, c.pos + 1).lastInsertRowid);
  return { id };
}));
router.put('/workouts/:id', send(req => {
  const id = idOf(req.params.id);
  if (!q.workout.get(req.user.id, id)) throw notFound('workout');
  const w = cleanWorkout(req.body, req.user);
  q.putWorkout.run(w.name, w.description, w.items, req.user.id, id);
  return { id };
}));
router.delete('/workouts/:id', send(req => { q.delWorkout.run(req.user.id, idOf(req.params.id)); return { ok: true }; }));
/* The list order: every workout id, top first. */
router.put('/order', send(req => {
  const ids = isObj(req.body) && Array.isArray(req.body.ids) ? req.body.ids.map(idOf) : [];
  tx(() => ids.forEach((id, i) => q.moveWorkout.run(i + 1, req.user.id, id)));
  return { ok: true };
}));

router.get('/sets', send(req => {
  if (req.query.exercise !== undefined) return q.setsFor.all(req.user.id, idOf(req.query.exercise));
  const d = String(req.query.date || '');
  if (!isDate(d)) throw fail('Give an exercise or a date');
  const next = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  return q.setsOn.all(req.user.id, d, next);
}));
router.get('/sets/:id', send(req => { const s = q.set.get(req.user.id, idOf(req.params.id)); if (!s) throw notFound('set'); return s; }));
router.post('/sets', send(req => {
  const s = cleanSet(req.body, req.user);
  if (q.countSets.get(req.user.id).n >= MAX.sets) throw fail('You’ve logged the most sets this app keeps');
  return q.set.get(req.user.id, Number(q.addSet.run(req.user.id, s.e, s.reps, s.kg, s.note, s.at).lastInsertRowid));
}));
router.put('/sets/:id', send(req => {
  const id = idOf(req.params.id);
  if (!q.set.get(req.user.id, id)) throw notFound('set');
  const s = cleanSet(req.body, req.user);
  q.putSet.run(s.e, s.reps, s.kg, s.note, s.at, req.user.id, id);
  return q.set.get(req.user.id, id);
}));
router.delete('/sets/:id', send(req => { q.delSet.run(req.user.id, idOf(req.params.id)); return { ok: true }; }));

/* One row per day you trained. */
router.get('/sessions', send(req => q.sessions.all(req.user.id, Math.min(1000, +req.query.limit || 400))
  .map(r => ({ ...r, volume: Math.round(r.volume || 0), ex: String(r.ex || '').split(',').filter(Boolean).map(Number) }))));

/* AI: read the file and hand back workouts to check. Nothing is saved until /import. ?bg=1 runs it in the background (server/jobs.js). */
router.post('/ai-import', aiLimit, express.raw({ type: ai.TYPES_IN, limit: '10mb' }), ai.scope, (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null, type = String(req.get('content-type') || '').split(';')[0].trim();
  return jobs.respond(req, res, 'workout', () => ai.check(buf, type), async () => {
    const names = q.exercises.all(req.user.id).map(e => e.name);
    const { reply, model } = await ai.ask(prompt(names), buf, type, 'workout plan', { task: 'workout' });
    return { ...tidyWorkouts(reply, req.user), model };
  });
});

/* Add checked workouts: exercises are matched by name (new ones are created), then each workout is added. */
router.post('/import', send(req => {
  const list = isObj(req.body) && Array.isArray(req.body.workouts) ? req.body.workouts : null;
  if (!list || !list.length) throw fail('Nothing to import');
  if (list.length > 20) throw fail('Import 20 workouts at most at a time');
  tx(() => {
    let pos = q.countWorkouts.get(req.user.id).pos;
    for (const w of list) {
      if (!isObj(w) || !Array.isArray(w.exercises)) throw fail('Each workout needs a list of exercises');
      const items = w.exercises.slice(0, MAX.items).map(x => {
        const e = exerciseCreate(req.user, isObj(x) ? x.name : x), parts = isObj(x) && cleanParts(x.parts);
        if (parts && parts.length && !q.exercise.get(req.user.id, e).parts) q.partsExercise.run(parts.join(','), req.user.id, e);   /* tags only untagged ones */
        return { e, target: isObj(x) ? x.target : '' };
      });
      const c = cleanWorkout({ name: w.name, description: w.description, items }, req.user);
      if (q.countWorkouts.get(req.user.id).n >= MAX.workouts) throw fail(`You can have ${MAX.workouts} workouts at most`);
      q.addWorkout.run(req.user.id, c.name, c.description, c.items, ++pos);
    }
  });
  return overview(req.user);
}));

/* History from another app's CSV (read in the browser): exercises are matched by name, new ones are created.
   Sets already here – same exercise, time, reps and weight – are skipped, so importing a file twice is safe. */
router.post('/import-sets', send(req => {
  const list = isObj(req.body) && Array.isArray(req.body.sets) ? req.body.sets : null;
  if (!list || !list.length) throw fail('Nothing to import');
  if (list.length > 3000) throw fail('Send 3000 sets at most at a time');
  const before = q.countExercises.get(req.user.id).n;
  return tx(() => {
    const ids = new Map(), clean = [];
    list.forEach((b, i) => {
      if (!isObj(b)) throw fail(`Set ${i + 1} isn’t an object`);
      const key = text(b.name, 80, 'Exercise name', true).toLowerCase();
      if (!ids.has(key)) ids.set(key, exerciseCreate(req.user, b.name));
      try { clean.push(cleanSet({ ...b, exercise: ids.get(key) }, req.user)); }
      catch (e) { throw fail(`${String(b.name).slice(0, 40)} on ${String(b.at).slice(0, 19)}: ${e.message}`); }
    });
    if (q.countSets.get(req.user.id).n + clean.length > MAX.sets) throw fail('That would be more sets than this app keeps');
    /* in file order; for each identical set, skip as many as are already stored */
    const have = new Map();
    let added = 0, skipped = 0;
    for (const s of clean) {
      const k = [s.e, s.at, s.reps, s.kg].join('|');
      if (!have.has(k)) have.set(k, q.sameSets.get(req.user.id, s.e, s.at, s.reps, s.kg).n);
      if (have.get(k) > 0) { have.set(k, have.get(k) - 1); skipped++; continue; }
      q.addSet.run(req.user.id, s.e, s.reps, s.kg, s.note, s.at); added++;
    }
    return { added, skipped, newExercises: q.countExercises.get(req.user.id).n - before };
  });
}));

/* For the data export. */
function exportFor(user) { return { ...overview(user), sets: q.allSets.all(user.id) }; }

module.exports = { router, exportFor };

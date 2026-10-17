'use strict';
/* Timeline: everything about one day in one place (what you ate, your weight, the latest photos at the time,
   your supplements and gym sets), and trends over time – macros, weight, strength, volume and the
   supplements you follow ("Trend" ticked in the supplements module) – with an AI read of how they relate.
   Strength comes from the gym sets: each set's estimated one-rep max by the Epley formula,
   kg × (1 + reps / 30); the strength index is how far each exercise's best is above its first, averaged
   over the exercises trained in the 60 days before. */
const express = require('express');
const db = require('./db');
const ai = require('./ai');
const photos = require('./photos');
const supps = require('./supps');

const q = {
  day: db.prepare('SELECT data, summary FROM days WHERE user_id = ? AND date = ?'),
  sums: db.prepare('SELECT date, summary FROM days WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date'),
  weights: db.prepare('SELECT date, kg FROM weights WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date'),
  weightAt: db.prepare('SELECT date, kg FROM weights WHERE user_id = ? AND date <= ? ORDER BY date DESC LIMIT 1'),
  photoAt: db.prepare(`SELECT id, date, pose, style, note, size, created_at AS created, file, thumb FROM photos
    WHERE user_id = ? AND pose = ? AND date <= ? ORDER BY date DESC, id DESC LIMIT 1`),
  suppLog: db.prepare('SELECT date, name, amount, unit, note FROM supplement_log WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date, id'),
  setsOn: db.prepare(`SELECT s.exercise_id AS e, x.name, s.reps, s.kg, s.at FROM sets s JOIN exercises x ON x.id = s.exercise_id
    WHERE s.user_id = ? AND s.at >= ? AND s.at < ? ORDER BY s.at, s.id`),
  lastSession: db.prepare('SELECT substr(at, 1, 10) AS date FROM sets WHERE user_id = ? AND at < ? ORDER BY at DESC LIMIT 1'),
  setsTo: db.prepare('SELECT exercise_id AS e, reps, kg, substr(at, 1, 10) AS d FROM sets WHERE user_id = ? AND at < ? ORDER BY at, id'),
  exercises: db.prepare('SELECT id, name, trend FROM exercises WHERE user_id = ?'),
};

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isDate = s => typeof s === 'string' && DATE_RE.test(s) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const r1 = n => Math.round(n * 10) / 10;

/* Epley: a single rep is the weight itself. Sets above 20 reps say little about a one-rep max. */
const e1rm = (kg, reps) => (reps === 1 ? kg : kg * (1 + reps / 30));
const countsForStrength = s => s.kg > 0 && s.reps >= 1 && s.reps <= 20;

/* ---------- one day ---------- */
function dayCard(user, date) {
  const row = q.day.get(user.id, date);
  const w = q.weightAt.get(user.id, date);
  const week = q.weights.all(user.id, addDays(date, -6), date);
  const pics = photos.POSES.map(p => q.photoAt.get(user.id, p, date)).filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).map(r => ({ ...photos.view(r), ago: daysBetween(r.date, date) }));

  /* supplements: the day's log, and the regime – what was taken over the 14 days to this one */
  const log = q.suppLog.all(user.id, addDays(date, -13), date);
  const regime = new Map();
  for (const e of log) {
    const k = e.name.toLowerCase();
    const r = regime.get(k) || { name: e.name, days: new Set(), doses: new Map() };
    r.days.add(e.date);
    const dk = `${e.amount} ${e.unit}`;
    r.doses.set(dk, (r.doses.get(dk) || 0) + 1);
    regime.set(k, r);
  }

  /* gym: the day's sets by exercise, each with its best estimated one-rep max */
  const sets = q.setsOn.all(user.id, date, addDays(date, 1));
  const ex = new Map();
  for (const s of sets) {
    const x = ex.get(s.e) || { id: s.e, name: s.name, sets: [], best: 0, volume: 0 };
    x.sets.push({ reps: s.reps, kg: s.kg, at: s.at });
    if (countsForStrength(s)) x.best = Math.max(x.best, e1rm(s.kg, s.reps));
    if (s.kg > 0) x.volume += s.reps * s.kg;
    ex.set(s.e, x);
  }
  const exercises = [...ex.values()].map(x => ({ ...x, best: x.best ? r1(x.best) : null, volume: Math.round(x.volume) }));

  return {
    date,
    food: row ? { summary: JSON.parse(row.summary), data: JSON.parse(row.data) } : null,
    weight: w ? { kg: w.kg, date: w.date, ago: daysBetween(w.date, date), avg7: week.length ? r1(week.reduce((a, x) => a + x.kg, 0) / week.length) : null } : null,
    photos: pics,
    supps: {
      taken: log.filter(e => e.date === date).map(({ name, amount, unit, note }) => ({ name, amount, unit, note })),
      regime: [...regime.values()].map(r => ({ name: r.name, days: r.days.size,
        usual: [...r.doses.entries()].sort((a, b) => b[1] - a[1])[0][0] })).sort((a, b) => b.days - a.days || a.name.localeCompare(b.name)),
    },
    gym: { exercises, sets: sets.length, volume: exercises.reduce((a, x) => a + x.volume, 0),
      last: sets.length ? null : ((q.lastSession.get(user.id, date) || {}).date || null) },
  };
}

/* ---------- trends ---------- */
const MACROS = [['k', 'Calories', 'kcal'], ['p', 'Protein', 'g'], ['c', 'Carbs', 'g'], ['f', 'Fat', 'g']];

/* Every series the chart can show over [from, to]: { key, name, unit, group, zero, points: [[date, value]] }.
   zero: a missing day means none (supplements), so averages count it as 0; otherwise it means no data. */
function series(user, from, to) {
  const out = [];
  const sums = q.sums.all(user.id, from, to).map(r => ({ date: r.date, ...JSON.parse(r.summary) }));
  for (const [k, name, unit] of MACROS) {
    out.push({ key: k, name, unit, group: 'Nutrition', points: sums.filter(s => Number.isFinite(s[k])).map(s => [s.date, r1(s[k])]) });
  }
  out.push({ key: 'kg', name: 'Weight', unit: 'kg', group: 'Body', points: q.weights.all(user.id, from, to).map(w => [w.date, w.kg]) });

  /* gym: all sets up to `to`, so every exercise's first best (its baseline) counts even when it is before the range */
  const days = new Map();
  for (const s of q.setsTo.all(user.id, addDays(to, 1))) {
    const o = days.get(s.d) || { vol: 0, ex: new Map() };
    if (s.kg > 0) o.vol += s.reps * s.kg;
    if (countsForStrength(s)) o.ex.set(s.e, Math.max(o.ex.get(s.e) || 0, e1rm(s.kg, s.reps)));
    days.set(s.d, o);
  }
  const state = new Map(), vol = [], str = [], exPts = new Map();
  for (const [d, o] of days) {
    for (const [e, best] of o.ex) {
      const st = state.get(e) || { base: best };
      st.cur = best; st.last = d; state.set(e, st);
      if (d >= from) (exPts.get(e) || exPts.set(e, []).get(e)).push([d, r1(best)]);
    }
    if (d < from) continue;
    if (o.vol > 0) vol.push([d, Math.round(o.vol)]);
    if (!o.ex.size) continue;
    const since = addDays(d, -60);
    let sum = 0, n = 0;
    for (const st of state.values()) if (st.last >= since) { sum += st.cur / st.base; n++; }
    if (n) str.push([d, r1(sum / n * 100)]);
  }
  out.push({ key: 'str', name: 'Strength index', unit: '%', group: 'Gym', points: str });
  out.push({ key: 'vol', name: 'Volume', unit: 'kg', group: 'Gym', points: vol });
  /* one e1RM line per exercise the person follows ("Trend" in the Gym, or the Timeline's exercise picker) */
  for (const x of q.exercises.all(user.id).filter(x => x.trend).sort((a, b) => (exPts.get(b.id) || []).length - (exPts.get(a.id) || []).length)) {
    out.push({ key: 'ex:' + x.id, name: x.name + ' e1RM', unit: 'kg', group: 'Gym', points: exPts.get(x.id) || [] });
  }

  /* supplements followed on the chart: the day's total of the unit they're most often logged in */
  const followed = supps.trendsOf(user);
  if (followed.length) {
    const log = q.suppLog.all(user.id, from, to);
    for (const name of followed) {
      const mine = log.filter(e => e.name.toLowerCase() === name.toLowerCase());
      const units = new Map();
      mine.forEach(e => units.set(e.unit, (units.get(e.unit) || 0) + 1));
      const unit = [...units.entries()].sort((a, b) => b[1] - a[1])[0];
      const byDay = new Map();
      if (unit) mine.filter(e => e.unit === unit[0]).forEach(e => byDay.set(e.date, (byDay.get(e.date) || 0) + e.amount));
      out.push({ key: 'sup:' + name.toLowerCase(), name, unit: unit ? unit[0] : '', group: 'Supplements', zero: true,
        points: [...byDay.entries()].map(([d, v]) => [d, Math.round(v * 1000) / 1000]) });
    }
  }
  return out;
}

/* The Timeline's exercise picker: every exercise with a strength set, how many days of them fall in the range, and whether it is followed. */
function exerciseList(user, from, to) {
  const days = new Map(), seen = new Set();
  for (const s of q.setsTo.all(user.id, addDays(to, 1))) {
    if (!countsForStrength(s)) continue;
    seen.add(s.e);
    if (s.d >= from) (days.get(s.e) || days.set(s.e, new Set()).get(s.e)).add(s.d);
  }
  return q.exercises.all(user.id).filter(x => seen.has(x.id) || x.trend)
    .map(x => ({ id: x.id, name: x.name, trend: !!x.trend, days: days.has(x.id) ? days.get(x.id).size : 0 }))
    .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));
}

/* ---------- AI: how the metrics relate ---------- */
const mondayOf = d => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
function weekly(s, from, to) {
  const w = new Map();
  for (const [d, v] of s.points) { const k = mondayOf(d); const o = w.get(k) || { sum: 0, n: 0 }; o.sum += v; o.n++; w.set(k, o); }
  const out = new Map();
  for (const [k, o] of w) {
    if (s.zero) {   /* a daily average over the days of that week inside the range */
      const a = k < from ? from : k, z = addDays(k, 6) > to ? to : addDays(k, 6);
      out.set(k, o.sum / (daysBetween(a, z) + 1));
    } else out.set(k, o.sum / o.n);
  }
  return out;
}
function pearson(pairs) {
  const n = pairs.length;
  if (n < 4) return null;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n, my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx && syy ? Math.round(sxy / Math.sqrt(sxx * syy) * 100) / 100 : null;
}
const fmt = v => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(r1(v)));

function summaryText(all, keys, from, to) {
  const picked = all.filter(s => keys.includes(s.key) && s.points.length);
  if (!picked.length) throw fail('None of the metrics you picked have any data in this range');
  if (from === '0000-01-01') from = picked.reduce((m, s) => (s.points[0][0] < m ? s.points[0][0] : m), to);
  const wk = new Map(picked.map(s => [s.key, weekly(s, from, to)]));
  let weeks = [...new Set([...wk.values()].flatMap(m => [...m.keys()]))].sort();
  if (weeks.length > 104) weeks = weeks.slice(-104);
  const lines = [`Range: ${from} to ${to} (${daysBetween(from, to) + 1} days).`, '', 'Metrics:'];
  for (const s of picked) {
    const v = s.points.map(p => p[1]);
    lines.push(`- ${s.name} (${s.unit || 'amount'})${s.zero ? ' – daily amount taken, days without it count as 0' : ''}: ${s.points.length} ${s.zero ? 'days taken' : 'data days'}, first ${fmt(v[0])} on ${s.points[0][0]}, last ${fmt(v[v.length - 1])} on ${s.points[s.points.length - 1][0]}, min ${fmt(Math.min(...v))}, max ${fmt(Math.max(...v))}`);
  }
  lines.push('', 'Weekly averages (week starting Monday; blank = no data):', ['week', ...picked.map(s => s.name)].join(' | '));
  for (const w of weeks) lines.push([w, ...picked.map(s => (wk.get(s.key).has(w) ? fmt(wk.get(s.key).get(w)) : ''))].join(' | '));
  const corr = [];
  for (let i = 0; i < picked.length; i++) for (let j = i + 1; j < picked.length; j++) {
    const a = wk.get(picked[i].key), b = wk.get(picked[j].key);
    const r = pearson(weeks.filter(w => a.has(w) && b.has(w)).map(w => [a.get(w), b.get(w)]));
    if (r != null) corr.push(`- ${picked[i].name} vs ${picked[j].name}: r = ${r}`);
  }
  const kg = wk.get('kg');
  if (kg) {   /* this week's average against the change in weight to the next week */
    for (const s of picked.filter(x => x.key !== 'kg')) {
      const m = wk.get(s.key);
      const r = pearson(weeks.filter(w => m.has(w) && kg.has(w) && kg.has(addDays(w, 7))).map(w => [m.get(w), kg.get(addDays(w, 7)) - kg.get(w)]));
      if (r != null) corr.push(`- ${s.name} this week vs weight change to next week: r = ${r}`);
    }
  }
  lines.push('', 'Correlations between weekly averages (only where 4+ weeks overlap):', ...(corr.length ? corr : ['(not enough overlapping weeks)']));
  return lines.join('\n');
}

const PROMPT = `You are a sports nutrition and strength coach reading one person's tracking data from a fitness logbook app.
The data covers what they ate (calories and macros per logged day), bodyweight, gym training (volume = total reps × kg lifted in a day;
strength index = how far each exercise's best estimated one-rep max (Epley formula) is above that exercise's first recorded best, averaged, 100 = where they started;
"<exercise> e1RM" = estimated one-rep max in kg) and supplements they take.

Explain the relationships between the metrics you are given: for example whether calorie intake lines up with weight change, whether protein or calories track strength,
how training volume moves with bodyweight or strength, and whether anything changed around when a supplement was started or stopped.
Use the weekly averages and correlations given. Be concrete with numbers and dates. Say plainly when the data is too thin or too noisy to tell, and do not claim that one thing caused another from a correlation alone.
No medical advice. Write in plain British English, addressing the person as "you".

Reply with only a JSON object:
{"headline": "one sentence overall read",
 "insights": [{"title": "a few words", "text": "one to three sentences"}],
 "caveats": ["short notes on what the data can't show"]}
Give 3 to 6 insights.`;

function tidyReply(r) {
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const insights = (Array.isArray(r.insights) ? r.insights : []).filter(isObj).slice(0, 8)
    .map(i => ({ title: str(i.title, 80), text: str(i.text, 600) })).filter(i => i.text);
  const caveats = (Array.isArray(r.caveats) ? r.caveats : []).map(c => str(c, 300)).filter(Boolean).slice(0, 6);
  const headline = str(r.headline, 300);
  if (!headline && !insights.length) throw fail('The AI didn’t give a summary – try again', 502);
  return { headline, insights, caveats };
}

/* The OpenRouter key is the admin's, so each account gets a handful of summaries an hour. */
const aiLimit = ai.limiter(20, 'That’s a lot of AI summaries – wait a while and try again.');

/* ---------- routes ---------- */
const router = express.Router();
const send = (res, e) => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); };
function rangeOf(o) {
  const to = isDate(o.to) ? o.to : new Date().toISOString().slice(0, 10);
  const from = isDate(o.from) ? o.from : '0000-01-01';
  if (from > to) throw fail('The range starts after it ends');
  return [from, to];
}

router.get('/day/:date', (req, res) => {
  try {
    if (!isDate(req.params.date)) throw fail('Bad date');
    const card = dayCard(req.user, req.params.date);
    if (req.share) card.photos.forEach(p => { delete p.note; });   /* a coach link: the card shows no photo notes */
    res.json(card);
  } catch (e) { send(res, e); }
});

router.get('/trends', (req, res) => {
  try {
    const [from, to] = rangeOf(req.query);
    res.json({ from, to, series: series(req.user, from, to), exercises: exerciseList(req.user, from, to), ai: ai.status().configured });
  } catch (e) { send(res, e); }
});

/* POST { from, to, metrics: [keys] } – an AI read of how the picked metrics relate. Nothing is stored. */
router.post('/summary', aiLimit, async (req, res) => {
  try {
    const b = isObj(req.body) ? req.body : {};
    const [from, to] = rangeOf(b);
    const keys = Array.isArray(b.metrics) ? b.metrics.filter(k => typeof k === 'string').slice(0, 40) : [];
    if (!keys.length) throw fail('Pick at least one metric');
    const text = summaryText(series(req.user, from, to), keys, from, to);
    const { reply, model } = await ai.askText(PROMPT, text, { task: 'summary' });
    res.json({ ...tidyReply(reply), model });
  } catch (e) { send(res, e); }
});

module.exports = { router, series, dayCard, summaryText, e1rm };

'use strict';
/* Every credential the app holds, how old it is, and the backstop that says when one is due (docs/rotation.md).
   Ages are kept in app_config 'secrets' as {name: {name, kid, set_at}}: for a key held in the database (the OpenRouter key, the
   SMTP password) record() is called when the key itself changes – never on a model or server edit; for one in .env the date
   comes from a "YYYY-MM-DD:" prefix on the value or <NAME>_SET=YYYY-MM-DD (config.envSecret). An unknown age counts as stale.
   check() runs on start and daily: from day WARN an email to the super admins listing what's due, from day ROTATE a
   'secret.stale' row once a day, the Super admin banner and that email daily, from day LOUD an error in the server log on
   every start. Nothing here ever holds or returns a key's value. */
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const WARN = 25, ROTATE = 30, LOUD = 35;
const DAY = 86400000;
const q = {
  get: db.prepare("SELECT data FROM app_config WHERE key = 'secrets'"),
  put: db.prepare(`INSERT INTO app_config (key, data) VALUES ('secrets', ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`),
  users: db.prepare('SELECT id, email FROM users'),
};
const read = () => { try { return JSON.parse((q.get.get() || {}).data || '{}'); } catch { return {}; } };
const write = s => q.put.run(JSON.stringify(s));

/* a short id for a key in .env, so a change of key can be told from the same one (keyed, so it is no help guessing the value) */
const envKid = (name, value) => crypto.createHmac('sha256', 'logbook-monster-kid').update(name + '\0' + value).digest('hex').slice(0, 10);
const newKid = () => crypto.randomBytes(5).toString('hex');
/* the key under this name is now kid: its age restarts unless it is the one already recorded */
function record(name, kid, setAt) {
  const s = read(), had = s[name];
  if (had && had.kid === kid && !setAt) return had;
  const { old_dead_at, ...kept } = had || {};   /* a new key: "old tested dead" was about the key before it */
  s[name] = { ...(had && had.kid === kid ? had : kept), name, kid, set_at: setAt || new Date().toISOString() };
  write(s);
  return s[name];
}
const recorded = name => read()[name] || null;
/* extra facts about a credential (old_dead_at: when "Test old" proved the replaced key revoked) */
function mark(name, fields) { const s = read(); s[name] = { ...(s[name] || { name }), ...fields }; write(s); }
function forget(name) { const s = read(); if (s[name]) { delete s[name]; write(s); } }

/* When each session secret stopped being the first (the one that signs): it may go once SESSION_DAYS + 1 hour have passed. */
function trackSessionSecrets() {
  const s = read(), kids = config.sessionSecrets.map(v => envKid('SESSION_SECRETS', v));
  const r = s.SESSION_SECRETS || { name: 'SESSION_SECRETS', retired: {} };
  const retired = { ...(r.retired || {}) };
  if (r.kid && r.kid !== kids[0] && !retired[r.kid]) retired[r.kid] = new Date().toISOString();
  delete retired[kids[0]];
  for (const k of Object.keys(retired)) if (!kids.includes(k)) delete retired[k];   /* dropped from the list */
  const next = { ...r, name: 'SESSION_SECRETS', kid: kids[0], set_at: config.sessionSecretDates[0] || '', retired };
  if (JSON.stringify(next) !== JSON.stringify(r)) { s.SESSION_SECRETS = next; write(s); }
  return { kids, retired };
}

const daysSince = d => { const t = Date.parse(d && d.length === 10 ? d + 'T00:00:00Z' : d || ''); return Number.isFinite(t) ? Math.floor((Date.now() - t) / DAY) : null; };
const fmt = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const tier = days => (days == null ? 'unknown' : days >= LOUD ? 'overdue' : days >= ROTATE ? 'stale' : days >= WARN ? 'due' : 'ok');
/* the step for a credential of unknown age, one sentence per case (the line that uses it already says the age isn't known) */
const howToDate = n => `To record its age, add the date it was set in .env – ${n}=YYYY-MM-DD:<value> or ${n}_SET=YYYY-MM-DD – and restart.`;

/* Each credential: name, what it is, where it's held, the slots in use, its age, and the next step. rotate: false = no
   30-day rotation (it says why). */
function list() {
  const out = [];
  const add = c => out.push({ rotate: true, ...c, days: c.rotate === false ? null : daysSince(c.set), ...(c.rotate === false ? { tier: 'info' } : { tier: tier(daysSince(c.set)) }) });

  /* the session secrets */
  const { kids, retired } = trackSessionSecrets();
  const src = config.sessionSecretSource, ss = config.sessionSecrets;
  const drops = kids.slice(1).map((k, i) => {
    const at = retired[k] ? Date.parse(retired[k]) + config.sessionDays * DAY + 3600000 : null;
    return at == null ? `secret ${i + 2} can go once ${config.sessionDays} days and an hour have passed since it stopped being first`
      : at <= Date.now() ? `secret ${i + 2} can be removed now` : `secret ${i + 2} can be removed after ${fmt(at)}`;
  });
  /* named as the owner's .env names it (SESSION_SECRET until they move to the list) */
  add({ name: src === 'SESSION_SECRET' ? 'SESSION_SECRET' : 'SESSION_SECRETS', label: 'Session secret', where: src === 'file' ? 'data/.session-secret (local only)' : `.env (${src})`,
    slots: `${ss.length} in use – the first signs`, set: config.sessionSecretDates[0] || '',
    next: [!config.sessionSecretDates[0] ? howToDate(src === 'SESSION_SECRET' ? 'SESSION_SECRET' : 'SESSION_SECRETS') : '',
      'To rotate: put a new random secret first in SESSION_SECRETS and restart.', ...drops].filter(Boolean).join(' ') });

  /* the key-encrypting key */
  const seal = require('./seal').status();
  const sk = config.envSecret('SEAL_KEY');
  if (config.sealKey) {
    add({ name: 'SEAL_KEY', label: 'Seal key (wraps the data keys)', where: '.env', set: sk.set,
      slots: config.sealKeyOld ? 'SEAL_KEY + SEAL_KEY_OLD' : 'SEAL_KEY',
      next: [!sk.set ? howToDate('SEAL_KEY') : '',
        config.sealKeyOld ? (seal.oldNeeded ? 'Restart once more: some data keys still open only with SEAL_KEY_OLD.' : 'Remove SEAL_KEY_OLD – every data key is wrapped by SEAL_KEY now.')
          : 'To rotate: move SEAL_KEY to SEAL_KEY_OLD, set a new SEAL_KEY, restart, then remove SEAL_KEY_OLD.'].filter(Boolean).join(' ') });
  } else {
    add({ name: 'SEAL_KEY', label: 'Seal key (wraps the data keys)', where: 'not set – the first session secret wraps them', rotate: false, slots: 'none',
      next: 'Set SEAL_KEY (and AUDIT_HASH_KEY) in .env so the sealed secrets don’t hang on the session secret.' });
  }
  add({ name: 'DATA_KEYS', label: 'Data keys (seal the AI key, SMTP password, authenticator keys)', where: 'database, wrapped', rotate: false,
    slots: `${seal.dataKeys.filter(k => k.opens).length} in use`,
    next: seal.problems ? 'Some sealed secrets don’t open – see the server log.' : `Replaced automatically every ${seal.rotateDays} days.` });
  add({ name: 'AUDIT_HASH_KEY', label: 'Security log email hash key', where: config.auditHashKey ? '.env' : 'not set – the first session secret', rotate: false, slots: '1 in use',
    next: 'No scheduled rotation: it only links masked emails in the security log, and a new one stops new rows matching older ones. Change it only if it leaked.' });

  /* keys held in the database, two slots each */
  for (const [name, label, mod, envName] of [['OPENROUTER', 'OpenRouter API key', './ai', 'OPENROUTER_API_KEY'], ['SMTP', 'SMTP password', './mail', 'SMTP_PASS']]) {
    const sl = require(mod).slots();
    if (!sl.source) continue;
    const env = sl.source === 'env', r = recorded(name), oldDead = !!(sl.old && r && r.old_dead_at);
    const set = env ? config.envSecret(envName).set : (r && r.set_at) || '';
    const used = ['active', sl.next ? 'next' : '', sl.old ? `old (until ${fmt(sl.oldUntil)})` : ''].filter(Boolean).join(' + ');
    add({ name, label, where: env ? `.env (${envName})` : name === 'SMTP' ? 'database, sealed (Super admin › Email)' : 'database, sealed (Super admin › AI)', set, slots: used,
      next: [env ? (set ? 'Save one on Super admin to rotate it there.' : `${howToDate(envName)} Or save one on Super admin to rotate it there.`)
        : !set ? `To record its age, save it again on Super admin › ${name === 'SMTP' ? 'Email' : 'AI'} or promote a new one.` : '',
        sl.next ? 'Test next, then Promote.' : 'To rotate: make a new one at the provider, Save as next, Test next, Promote, revoke the old one, Test old.',
        sl.old && !oldDead ? 'Revoke the old one at the provider, then Test old – it must fail.' : ''].filter(Boolean).join(' ') });
  }
  if (config.google.enabled) {
    const g = config.envSecret('GOOGLE_CLIENT_SECRET');
    add({ name: 'GOOGLE_CLIENT_SECRET', label: 'Google sign-in client secret', where: '.env', set: g.set, slots: '1',
      next: [!g.set ? howToDate('GOOGLE_CLIENT_SECRET') : '', 'To rotate: add a secret in Google Cloud console, set it, restart, delete the old one there.'].filter(Boolean).join(' ') });
  }
  return out;
}

/* what is due, and the backstop: once on start (start = true) and daily */
let lastMail = '';
function check(start) {
  let items;
  try { items = list(); } catch (e) { console.error('Credential age check failed:', e.message); return []; }
  const audit = require('./audit'), mail = require('./mail'), defaults = require('./defaults');
  const due = items.filter(c => c.rotate && c.tier !== 'ok');
  for (const c of due) {
    if (c.tier === 'due') continue;
    audit.once(null, 'secret.stale', { id: c.name, name: c.name, days: c.days });
    if (start && c.tier === 'overdue') console.error(`${c.label} (${c.name}) is ${c.days} days old – rotate it now (docs/rotation.md). ${c.next}`);
    else if (start) console.warn(`${c.label} (${c.name}) ${c.days == null ? 'has no recorded age. ' : `is ${c.days} days old – `}${c.next}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (due.length && lastMail !== today) {
    const s = read();
    if (s._mailed !== today) {
      lastMail = today;
      write({ ...s, _mailed: today });
      const text = `These Logbook Monster credentials are due for rotation:\n\n${due.map(c => `- ${c.label} (${c.name}): ${c.days == null ? 'age unknown' : `${c.days} days old`}. ${c.next}`).join('\n')}\n\n`
        + `Step by step: docs/rotation.md in the app's repository. The list is on Super admin › Keys:\n${config.baseUrl}/#admin/keys\n`;
      for (const a of q.users.all().filter(defaults.isAdmin)) mail.notify({ to: a.email, subject: `Logbook Monster: ${due.length} credential${due.length > 1 ? 's' : ''} due for rotation`, text });
    }
  }
  return due;
}
function schedule() {
  check(true);
  setInterval(() => check(false), DAY).unref();
}

module.exports = { record, recorded, mark, forget, list, check, schedule, envKid, newKid, WARN, ROTATE, LOUD };

'use strict';
/* The security log: one row per security event (sign-ins, password changes, invites, account removal, admin settings,
   exports, bulk deletes, coach links, AI caps). A row says when, whose account (user_id), who did it (actor_id), from
   where (ip) and a small JSON detail – never a password, key, token, cookie or any health data; emails are masked.
   Rows older than DAYS are pruned on start and daily, and each account keeps at most PER_ACCOUNT. */
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const defaults = require('./defaults');
const mail = require('./mail');

const DAYS = 180;
const PER_ACCOUNT = Math.max(10, +process.env.AUDIT_PER_ACCOUNT || 5000);
const ALERT_FAILS = Math.max(1, +process.env.AUDIT_ALERT_FAILS || 5);
const ALERT_WINDOW = 15 * 60 * 1000;
const FAILS = ['signin.failed', 'signin.locked', 'second.failed', 'second.locked'];
/* the events a person sees for their own account on Account admin */
const OWN = ['signin.ok', 'signin.failed', 'signin.locked', 'second.asked', 'second.failed', 'second.locked', 'recovery.used',
  'twostep.on', 'twostep.off', 'recheck.failed', 'signout', 'password.changed', 'google.linked', 'invite.accepted',
  'export', 'photos.deleted', 'coach.created', 'coach.off', 'coach.used'];
const EVENTS = ['signin.ok', 'signin.failed', 'signin.locked', 'signin.alert', 'second.asked', 'second.failed', 'second.locked',
  'recovery.used', 'twostep.on', 'twostep.off', 'recheck.ok', 'recheck.failed', 'signout', 'password.changed', 'google.linked',
  'invite.created', 'invite.accepted', 'account.removed', 'ai.settings', 'email.settings', 'options.changed', 'export',
  'day.deleted', 'checklist.reset', 'photos.deleted', 'food.removed', 'supp.removed', 'coach.created', 'coach.off', 'coach.used', 'ai.cap'];

const q = {
  add: db.prepare('INSERT INTO audit (at, user_id, actor_id, event, ip, detail) VALUES (?, ?, ?, ?, ?, ?)'),
  cap: db.prepare('DELETE FROM audit WHERE user_id IS ? AND id <= (SELECT id FROM audit WHERE user_id IS ? ORDER BY id DESC LIMIT 1 OFFSET ?)'),
  prune: db.prepare('DELETE FROM audit WHERE at < ?'),
  seen: db.prepare("SELECT 1 FROM audit WHERE event = ? AND user_id IS ? AND at >= ? AND json_extract(detail, '$.id') IS ? LIMIT 1"),
  fails: db.prepare("SELECT COUNT(*) AS n FROM audit WHERE user_id = ? AND event IN ('signin.failed', 'signin.locked', 'second.failed', 'second.locked') AND at >= ?"),
  user: db.prepare('SELECT id, email FROM users WHERE id = ?'),
  users: db.prepare('SELECT id, email FROM users'),
  list: db.prepare(`SELECT a.id, a.at, a.user_id, a.actor_id, a.event, a.ip, a.detail, u.email AS user_email, v.email AS actor_email
    FROM audit a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users v ON v.id = a.actor_id
    WHERE (:ev = '' OR a.event = :ev) AND (:uid = 0 OR a.user_id = :uid OR a.actor_id = :uid) AND a.id < :before
    ORDER BY a.id DESC LIMIT :lim`),
  own: db.prepare(`SELECT id, at, event, ip, detail FROM audit WHERE user_id = :uid AND id < :before
    AND event IN (${OWN.map(e => `'${e}'`).join(', ')}) ORDER BY id DESC LIMIT :lim`),
};

/* A URL as it may be logged: no coach-link secret, no query string (photo notes, dates) or fragment (invite tokens). */
const redact = url => String(url == null ? '' : url).split(/[?#]/)[0].replace(/\/coach\/[^/]+/g, '/coach/REDACTED');
/* a***@example.com, plus a keyed hash so repeated tries on one address can be told apart without storing it */
const mask = e => { const s = String(e || '').toLowerCase(), at = s.lastIndexOf('@'); return at > 0 ? s[0] + '***' + s.slice(at) : '***'; };
const emailHash = e => crypto.createHmac('sha256', config.sessionSecret).update('audit:' + String(e || '').toLowerCase()).digest('hex').slice(0, 12);

/* Only small plain values; key names that could carry a secret are dropped, emails masked, URLs redacted. */
const SECRET_KEY = /pass|secret|token|csrf|cookie|hash/i;
function clean(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail && typeof detail === 'object' ? detail : {})) {
    if (SECRET_KEY.test(k) || v === undefined) continue;
    if (k === 'email') { out.email = mask(v); out.eh = emailHash(v); continue; }
    const one = x => (typeof x === 'string' ? (/^(\/|https?:)/.test(x) ? redact(x) : x).slice(0, 80)
      : typeof x === 'number' || typeof x === 'boolean' || x === null ? x : undefined);
    const val = Array.isArray(v) ? v.slice(0, 20).map(one).filter(x => x !== undefined) : one(v);
    if (val !== undefined) out[k] = val;
  }
  return out;
}

/* log(req, event, detail, userId): userId is the account the event is about (default: whoever is signed in).
   req may be null (no request, e.g. the AI cap reached inside a background job). Never throws. */
function log(req, event, detail, userId) {
  try {
    const actor = req ? (req.session && req.session.userId) || null : userId == null ? null : userId;
    const uid = userId === undefined ? actor : userId == null ? null : userId;
    const ip = req ? String(req.ip || '').slice(0, 64) || null : null;
    const d = clean(detail);
    q.add.run(new Date().toISOString(), uid, actor, String(event), ip, JSON.stringify(d));
    q.cap.run(uid, uid, PER_ACCOUNT);
    if (FAILS.includes(event)) {
      console.warn(`Sign-in ${event.endsWith('locked') ? 'refused (account locked)' : 'failed'}${event.startsWith('second') ? ' at the second step' : ''} for ${d.email || (uid ? 'account #' + uid : 'an unknown address')} from ${ip || '?'}`);
      if (uid) alertCheck(uid);
    }
  } catch (e) { console.error('Security log write failed:', e.message); }
}

/* Logs an event once per UTC day for one account and detail.id (coach link first used today, AI cap reached). */
const onceSeen = new Set();
let onceDay = '';
function once(req, event, detail, userId) {
  const day = new Date().toISOString().slice(0, 10), id = detail && detail.id != null ? detail.id : null;
  if (day !== onceDay) { onceSeen.clear(); onceDay = day; }
  const key = `${event}|${userId}|${id}`;
  if (onceSeen.has(key)) return;
  onceSeen.add(key);
  try { if (q.seen.get(event, userId == null ? null : userId, day, id)) return; } catch {}
  log(req, event, detail, userId);
}

/* ALERT_FAILS failed sign-ins on a super admin account within 15 minutes: one row and one email to the super admins
   (mail.notify does nothing when email isn't set up), at most once per window. */
const alerted = new Map();
function alertCheck(uid) {
  const u = q.user.get(uid);
  if (!u || !defaults.isAdmin(u)) return;
  const now = Date.now();
  if (now - (alerted.get(uid) || 0) < ALERT_WINDOW) return;
  const n = q.fails.get(uid, new Date(now - ALERT_WINDOW).toISOString()).n;
  if (n < ALERT_FAILS) return;
  alerted.set(uid, now);
  log(null, 'signin.alert', { n }, uid);
  for (const a of q.users.all().filter(defaults.isAdmin)) {
    mail.notify({ to: a.email, subject: 'Logbook Monster: failed sign-ins on a super admin account',
      text: `There were ${n} failed sign-ins on the super admin account ${mask(u.email)} in the last 15 minutes.\n\n`
        + `If that wasn’t you, check Super admin › Security log:\n${config.baseUrl}/#admin/log\n` });
  }
}

function prune() { try { q.prune.run(new Date(Date.now() - DAYS * 86400000).toISOString()); } catch (e) { console.error('Security log prune failed:', e.message); } }
prune();
setInterval(prune, 24 * 60 * 60 * 1000).unref();

const PAGE = 50;
const parse = r => { let d = {}; try { d = JSON.parse(r.detail); } catch {} return d; };
const beforeOf = v => (/^\d{1,15}$/.test(String(v || '')) ? +v : Number.MAX_SAFE_INTEGER);
/* Super admin: newest first, by event and/or account (as the account or the one who did it), PAGE at a time. */
function list(query) {
  const o = query || {};
  const ev = EVENTS.includes(o.event) ? o.event : '';
  const uid = /^\d{1,12}$/.test(String(o.user || '')) ? +o.user : 0;
  const rows = q.list.all({ ev, uid, before: beforeOf(o.before), lim: PAGE });
  return { events: EVENTS, next: rows.length === PAGE ? rows[rows.length - 1].id : null, rows: rows.map(r => ({ id: r.id, at: r.at, event: r.event, ip: r.ip,
    user: r.user_id == null ? null : { id: r.user_id, email: r.user_email || null }, actor: r.actor_id == null ? null : { id: r.actor_id, email: r.actor_email || null },
    detail: parse(r) })) };
}
/* Anyone: their own account's sign-ins, password changes, coach link use and the like. */
function mine(user, query) {
  const rows = q.own.all({ uid: user.id, before: beforeOf(query && query.before), lim: PAGE });
  return { next: rows.length === PAGE ? rows[rows.length - 1].id : null, rows: rows.map(r => ({ id: r.id, at: r.at, event: r.event, ip: r.ip, detail: parse(r) })) };
}

module.exports = { log, once, list, mine, redact, mask, prune, EVENTS, OWN, DAYS, PER_ACCOUNT };

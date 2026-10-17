'use strict';
/* Wrong passwords and codes, kept in login_failures so a restart doesn't reset them. key: an email, or '2fa:<id>' for codes.
   The hard lock is per (key, address): ACCOUNT_FAIL_LIMIT failures in 15 minutes from one IP (one /64 for IPv6), and that
   address then waits even with the right password. Across addresses nothing locks – knowing an email isn't enough to keep its
   owner out – but each failure past the limit in the window slows every answer for that key a little more (at most SLOW_MAX). */
const config = require('./config');
const db = require('./db');

const WINDOW = 15 * 60 * 1000, SLOW_STEP = 250, SLOW_MAX = 4000;
const q = {
  fromIp: db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND ip = ? AND at > ?'),
  all: db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?'),
  add: db.prepare('INSERT INTO login_failures (email, ip, at) VALUES (?, ?, ?)'),
  prune: db.prepare('DELETE FROM login_failures WHERE at <= ?'),
  clear: db.prepare('DELETE FROM login_failures WHERE email = ? AND ip = ?'),
};

/* the address a failure counts against: IPv4 as it is, IPv6 by its /64 (one host usually holds the whole /64) */
function addr(ip) {
  let s = String(ip || '').toLowerCase().split('%')[0];
  if (s.startsWith('::ffff:') && s.includes('.')) return s.slice(7);
  if (!s.includes(':')) return s;
  const [a, b] = s.split('::'), head = a ? a.split(':') : [], tail = b ? b.split(':') : [];
  const all = s.includes('::') ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return all.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}

const since = () => Date.now() - WINDOW;
const locked = (key, ip) => q.fromIp.get(key, addr(ip), since()).n >= config.accountFailLimit;
/* ms to wait before answering an attempt for this key */
function slow(key) {
  const extra = q.all.get(key, since()).n - config.accountFailLimit;
  return extra > 0 ? Math.min(SLOW_MAX, extra * SLOW_STEP) : 0;
}
const wait = key => { const ms = slow(key); return ms ? new Promise(r => setTimeout(r, ms)) : Promise.resolve(); };
function note(key, ip) {
  const now = Date.now();
  q.prune.run(now - WINDOW);
  q.add.run(key, addr(ip), now);
}
const clear = (key, ip) => q.clear.run(key, addr(ip));

module.exports = { locked, slow, wait, note, clear, addr, WINDOW, SLOW_MAX };

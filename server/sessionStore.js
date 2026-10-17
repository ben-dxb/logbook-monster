'use strict';
const crypto = require('crypto');
const session = require('express-session');
/* Only a hash of the session id is stored: the cookie holds the id itself. */
const key = sid => crypto.createHash('sha256').update(String(sid)).digest('hex');

/* express-session store backed by the app's SQLite database. A signed-in session lasts maxAge from sign-in
   (sess.at, set in auth.js) however often it is used; one from before sign-in times were kept has none and ends.
   rolling sessions call touch() on every request; it writes the new expiry only once it would move by TOUCH or more
   (kept per session in this.stored, from get/set/touch), so a burst of requests costs no writes. A row may then expire up to
   TOUCH before its cookie – an idle session ends that much early – and the cap from sess.at is checked in get() as before. */
const TOUCH = 60 * 60 * 1000;
class SqliteStore extends session.Store {
  constructor(db, { maxAge = 30 * 24 * 60 * 60 * 1000 } = {}) {
    super();
    this.maxAge = maxAge;
    this.stored = new Map();   /* hashed sid → expires as stored */
    this.q = {
      get: db.prepare('SELECT sess, expires FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare('INSERT INTO sessions (sid, sess, expires, user_id) VALUES (?, ?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires, user_id = excluded.user_id'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    this.timer = setInterval(() => {
      const now = Date.now();
      this.q.prune.run(now);
      for (const [k, e] of this.stored) if (e <= now) this.stored.delete(k);
    }, 60 * 60 * 1000);
    this.timer.unref();
  }
  expiry(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + 24 * 60 * 60 * 1000;
  }
  get(sid, cb) {
    try {
      const k = key(sid), row = this.q.get.get(k, Date.now());
      const sess = row ? JSON.parse(row.sess) : null;
      if (sess && sess.userId && !(Date.now() - sess.at < this.maxAge)) { this.forget(k); return cb(null, null); }
      if (row) this.stored.set(k, row.expires); else this.stored.delete(k);
      cb(null, sess);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const k = key(sid), e = this.expiry(sess);
      this.q.set.run(k, JSON.stringify(sess), e, (sess && sess.userId) || null);
      this.stored.set(k, e);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) {
    try {
      const k = key(sid), e = this.expiry(sess), was = this.stored.get(k);
      if (!(was !== undefined && Math.abs(e - was) < TOUCH)) { this.q.touch.run(e, k); this.stored.set(k, e); }
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  forget(k) { this.q.destroy.run(k); this.stored.delete(k); }
  destroy(sid, cb) {
    try { this.forget(key(sid)); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}

SqliteStore.key = key;
SqliteStore.TOUCH = TOUCH;
module.exports = SqliteStore;

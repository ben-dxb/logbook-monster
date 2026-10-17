'use strict';
const session = require('express-session');

/* express-session store backed by the app's SQLite database. A signed-in session lasts maxAge from sign-in
   (sess.at, set in auth.js) however often it is used; one from before sign-in times were kept has none and ends. */
class SqliteStore extends session.Store {
  constructor(db, { maxAge = 30 * 24 * 60 * 60 * 1000 } = {}) {
    super();
    this.maxAge = maxAge;
    this.q = {
      get: db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare('INSERT INTO sessions (sid, sess, expires, user_id) VALUES (?, ?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires, user_id = excluded.user_id'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    this.timer = setInterval(() => this.q.prune.run(Date.now()), 60 * 60 * 1000);
    this.timer.unref();
  }
  expiry(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + 24 * 60 * 60 * 1000;
  }
  get(sid, cb) {
    try {
      const row = this.q.get.get(sid, Date.now());
      const sess = row ? JSON.parse(row.sess) : null;
      if (sess && sess.userId && !(Date.now() - sess.at < this.maxAge)) { this.q.destroy.run(sid); return cb(null, null); }
      cb(null, sess);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { this.q.set.run(sid, JSON.stringify(sess), this.expiry(sess), (sess && sess.userId) || null); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) {
    try { this.q.touch.run(this.expiry(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { this.q.destroy.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}

module.exports = SqliteStore;

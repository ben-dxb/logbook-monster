'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true, mode: 0o700 });
/* Only the app's own user can read the database (SQLite gives its -wal / -shm files the same permissions). */
try { fs.closeSync(fs.openSync(config.dbPath, 'wx', 0o600)); } catch {}
try { fs.chmodSync(config.dbPath, 0o600); } catch {}
/* Node's built-in SQLite: nothing to compile, works the same on Windows, macOS and Linux.
   secure_delete: deleted rows are overwritten, so a copy of the file doesn't still hold them. */
const db = new DatabaseSync(config.dbPath);
/* incremental: free pages can be handed back to the disk (the daily upkeep, server/upkeep.js). Takes effect on a new database
   here, before any table; an older one switches at its next VACUUM (upkeep.atStart). */
db.exec('PRAGMA auto_vacuum = INCREMENTAL');
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
/* synchronous = NORMAL, chosen on purpose: in WAL mode a commit then writes the WAL without waiting on an fsync (it syncs at
   each checkpoint instead), so a save no longer pays for one or two flushes to disk. The database can't be corrupted this way
   (sqlite.org/pragma.html#pragma_synchronous) and a crash of the app loses nothing; only a power cut or an OS crash can lose
   the last commits before it, which for a logbook is a fair price for not stalling every write. */
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT,
  password_hash TEXT,
  google_sub    TEXT UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS days (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  data       TEXT NOT NULL,
  summary    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS weights (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  kg         REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exercises (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, name COLLATE NOCASE)
);
CREATE TABLE IF NOT EXISTS workouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  items       TEXT NOT NULL DEFAULT '[]',
  position    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
/* at is the local date and time the set was done, YYYY-MM-DDTHH:MM:SS, like the dates of days. */
CREATE TABLE IF NOT EXISTS sets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  reps        INTEGER NOT NULL,
  kg          REAL NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sets_exercise ON sets(user_id, exercise_id, at);
CREATE INDEX IF NOT EXISTS sets_at ON sets(user_id, at);
/* The food library: foods people enter themselves, per 100 g, per 100 ml or per item, with an optional
   recipe. public = 1 shares it with every account (read-only for everyone but its owner). */
CREATE TABLE IF NOT EXISTS foods (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  unit       TEXT NOT NULL DEFAULT 'g',
  k          REAL NOT NULL,
  p          REAL NOT NULL,
  c          REAL NOT NULL,
  f          REAL NOT NULL,
  recipe     TEXT NOT NULL DEFAULT '',
  public     INTEGER NOT NULL DEFAULT 0,
  kind       TEXT NOT NULL DEFAULT 'ingredient',
  ai         TEXT,
  state      TEXT NOT NULL DEFAULT '',
  yield      REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS foods_user ON foods(user_id);
CREATE INDEX IF NOT EXISTS foods_public ON foods(public);
/* An account's own meal plan – foods, day templates, week, targets – as dated changes ({versions:[…]}, see defaults.js). */
CREATE TABLE IF NOT EXISTS user_defaults (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
/* Supplements: a library like the foods (a name, a usual amount and unit, notes, private or shared) and
   the log of what each account took on a day. A log entry keeps its own name, amount and unit, so it
   can be free text, and survives the library entry being changed or deleted. */
CREATE TABLE IF NOT EXISTS supplements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  amount     REAL,
  unit       TEXT NOT NULL DEFAULT 'mg',
  notes      TEXT NOT NULL DEFAULT '',
  public     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS supplements_user ON supplements(user_id);
CREATE TABLE IF NOT EXISTS supplement_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  supplement_id INTEGER REFERENCES supplements(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  amount        REAL NOT NULL,
  unit          TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS supplement_log_day ON supplement_log(user_id, date);
/* Supplements an account follows on the Timeline's trend chart ("Trend" ticked in the supplements module), by
   name, so library and free-text log entries with the same name count together. */
CREATE TABLE IF NOT EXISTS supplement_trends (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (user_id, name)
);
/* Progress photos: the image files live on disk in config.photoDir under random names (file, and a small
   thumb made in the browser); this keeps who owns them, the date taken, the pose and a note. */
CREATE TABLE IF NOT EXISTS photos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  pose       TEXT NOT NULL DEFAULT 'front',
  note       TEXT NOT NULL DEFAULT '',
  file       TEXT NOT NULL,
  type       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  thumb      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS photos_day ON photos(user_id, date);
/* Coach links: someone's data, read only, for anyone holding the link until it runs out. Only a hash of
   the link's secret is kept, so the database alone can't open one. */
CREATE TABLE IF NOT EXISTS shares (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS shares_user ON shares(user_id);
/* The Dashboard's daily checklist: each account's own list of items (JSON; none stored = the default list) and
   which items were ticked on which day. */
CREATE TABLE IF NOT EXISTS checklists (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  items      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ai_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'running',
  result      TEXT,
  error       TEXT,
  seen        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS ai_jobs_user ON ai_jobs(user_id, id);
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id INTEGER NOT NULL,          -- no cascade: a removed account's calls still count towards the app's day
  day     TEXT NOT NULL,             -- UTC date
  calls   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS checklist_log (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  item       TEXT NOT NULL,
  done_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date, item)
);
`);

/* Added after the first release: accounts an admin invited may sign in even when ALLOWED_EMAILS doesn't list them. */
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'invited_by')) {
  db.exec('ALTER TABLE users ADD COLUMN invited_by TEXT');
}

/* Added later: foods are a whole meal or a single ingredient, and ai holds which values AI estimated
   and where it got them from (JSON), so the app can flag them. Older foods with a recipe or per item are meals. */
{
  const cols = db.prepare('PRAGMA table_info(foods)').all().map(c => c.name);
  if (!cols.includes('kind')) {
    db.exec("ALTER TABLE foods ADD COLUMN kind TEXT NOT NULL DEFAULT 'ingredient'");
    db.exec("UPDATE foods SET kind = 'meal' WHERE recipe <> '' OR unit = 'each'");
  }
  if (!cols.includes('ai')) db.exec('ALTER TABLE foods ADD COLUMN ai TEXT');
  /* state: values weighed 'raw' (dry for rice and pasta), 'cooked' or '' (neither); yield: cooked weight as % of raw */
  if (!cols.includes('state')) db.exec("ALTER TABLE foods ADD COLUMN state TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('yield')) db.exec('ALTER TABLE foods ADD COLUMN yield REAL');
  /* free: 'sauce' or 'veg' (green veg) – counts no macros for accounts that set that kind free; '' otherwise */
  if (!cols.includes('free')) db.exec("ALTER TABLE foods ADD COLUMN free TEXT NOT NULL DEFAULT ''");
}

/* Added later: trend = 1 follows the exercise's estimated one-rep max on the Timeline's trend chart
   ("Trend" on the exercise in the Gym, or the exercise picker on the Timeline). Off until the person picks it. */
if (!db.prepare('PRAGMA table_info(exercises)').all().some(c => c.name === 'trend')) {
  db.exec('ALTER TABLE exercises ADD COLUMN trend INTEGER NOT NULL DEFAULT 0');
}

/* Added later: parts are the body parts an exercise trains, as PARTS ids in gym.js joined with commas ('' = not tagged yet).
   Set by hand in the exercise's settings or by "Tag with AI" in the Gym. */
if (!db.prepare('PRAGMA table_info(exercises)').all().some(c => c.name === 'parts')) {
  db.exec("ALTER TABLE exercises ADD COLUMN parts TEXT NOT NULL DEFAULT ''");
}

/* Added later: pose_ai = 1 when a photo's pose came from the AI (or was left for it: "Let AI tell" on upload, the
   AI not answering), so "Tag poses with AI" can leave the poses people set themselves alone. Older photos count as set by hand.
   2: the AI has answered for it (photos.js aiSaw), so "Tag only untagged" doesn't ask again about one it called Other. */
if (!db.prepare('PRAGMA table_info(photos)').all().some(c => c.name === 'pose_ai')) {
  db.exec('ALTER TABLE photos ADD COLUMN pose_ai INTEGER NOT NULL DEFAULT 0');
}

/* Added later: style is the pose type (relaxed, front_double_biceps… – STYLES in photos.js), '' when not set.
   Poses also gained left and right; older 'side' photos keep 'side'. */
if (!db.prepare('PRAGMA table_info(photos)').all().some(c => c.name === 'style')) {
  db.exec("ALTER TABLE photos ADD COLUMN style TEXT NOT NULL DEFAULT ''");
}

/* Added later: sessions carry their account, so a password change or reset can end the account's other sessions. */
if (!db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === 'user_id')) {
  db.exec('BEGIN');   /* both or neither: a crash between them would leave older sessions without their account */
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER');
    db.exec("UPDATE sessions SET user_id = json_extract(sess, '$.userId')");
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
db.exec('CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)');
/* Added later: the store keeps only the SHA-256 of each session id (server/sessionStore.js), so a copy of the database holds
   no usable session. Rows from before are rehashed in place, so nobody is signed out. */
{
  const raw = db.prepare('SELECT sid FROM sessions WHERE length(sid) <> 64').all();
  if (raw.length) {
    const up = db.prepare('UPDATE OR REPLACE sessions SET sid = ? WHERE sid = ?');
    db.exec('BEGIN');
    try { for (const { sid } of raw) up.run(require('crypto').createHash('sha256').update(sid).digest('hex'), sid); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

/* Failed sign-ins per email, kept so a restart doesn't reset the per-account limit (auth.js). */
db.exec(`CREATE TABLE IF NOT EXISTS login_failures (
  email TEXT NOT NULL,
  at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_email ON login_failures(email, at);`);
/* Added later: ip is the address (an IPv6 /64) a failure came from – the hard lock is per (email, ip), see failures.js */
if (!db.prepare('PRAGMA table_info(login_failures)').all().some(c => c.name === 'ip')) {
  db.exec("ALTER TABLE login_failures ADD COLUMN ip TEXT NOT NULL DEFAULT ''");
}

/* Added later: the second sign-in step (authenticator app, twostep.js). secret is sealed with AES-256-GCM under a key from
   SESSION_SECRET; enabled = 0 while it's being set up; last_step: the newest 30-second step a code was taken for, so a code works
   once; recovery: the SHA-256 hashes of the unused recovery codes (JSON). */
db.exec(`CREATE TABLE IF NOT EXISTS totp (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret     TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  last_step  INTEGER NOT NULL DEFAULT 0,
  recovery   TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

/* Added later, for the per-account storage caps: the size of each day's JSON is indexed so the total is cheap to add up,
   and a photo's thumbnail size is kept beside the photo's (older thumbnails count as 0). */
db.exec('CREATE INDEX IF NOT EXISTS days_size ON days(user_id, length(data))');
if (!db.prepare('PRAGMA table_info(photos)').all().some(c => c.name === 'thumb_size')) {
  db.exec('ALTER TABLE photos ADD COLUMN thumb_size INTEGER NOT NULL DEFAULT 0');
}

/* Added later: when a photo's details were last changed (NULL: never since upload), the version a change is checked against. */
if (!db.prepare('PRAGMA table_info(photos)').all().some(c => c.name === 'updated_at')) {
  db.exec('ALTER TABLE photos ADD COLUMN updated_at TEXT');
}

/* Added later (p5-photos): mid – a ~1000 px JPEG made in the browser for the photo and Compare pages and the coach's day card (the
   full file only when zoomed or opened), its size counted with the rest; width/height of the stored file, so the page keeps the photo's
   room before it loads (NULL until known – filled in at start-up from the file); ckey – the upload's own key, sent again when an
   upload is retried, so a photo that went in before its answer was lost isn't stored twice. */
for (const [col, type] of [['mid', 'TEXT'], ['mid_size', 'INTEGER NOT NULL DEFAULT 0'], ['width', 'INTEGER'], ['height', 'INTEGER'], ['ckey', 'TEXT']]) {
  if (!db.prepare('PRAGMA table_info(photos)').all().some(c => c.name === col)) db.exec(`ALTER TABLE photos ADD COLUMN ${col} ${type}`);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS photos_ckey ON photos(user_id, ckey) WHERE ckey IS NOT NULL');

/* Added later: when a gym set was last changed (NULL: never since it was logged), the version an edit is checked against. */
if (!db.prepare('PRAGMA table_info(sets)').all().some(c => c.name === 'updated_at')) {
  db.exec('ALTER TABLE sets ADD COLUMN updated_at TEXT');
}

/* Added later: when the account was emailed that a coach link runs out within a week (server/shares.js), so it's once. */
if (!db.prepare('PRAGMA table_info(shares)').all().some(c => c.name === 'reminded_at')) {
  db.exec('ALTER TABLE shares ADD COLUMN reminded_at TEXT');
}

/* Added later: the security log (server/audit.js). No foreign keys: a removed account's rows stay, to show who removed it. */
/* Emails nobody waits on (mail.notify): kept until sent, or dropped once too old (server/mail.js). Times in ms. */
db.exec(`CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  msg        TEXT NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS outbox_next ON outbox(next_at)');
db.exec(`CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  user_id  INTEGER,
  actor_id INTEGER,
  event    TEXT NOT NULL,
  ip       TEXT,
  detail   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_user ON audit(user_id, id);
CREATE INDEX IF NOT EXISTS audit_actor ON audit(actor_id, id);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
CREATE INDEX IF NOT EXISTS audit_event ON audit(event, id);`);

/* Added later: ids are never handed out twice (AUTOINCREMENT), so a stale tab, or an id kept in a day or a workout, can't reach a
   record made after the one it meant was deleted. SQLite can't add that to a table, so each older table is rebuilt once – rows,
   ids, indexes and the foreign keys pointing at it as they were – in one transaction (sqlite.org/lang_altertable.html#otheralter). */
const SEQ_TABLES = ['users', 'exercises', 'workouts', 'sets', 'foods', 'supplements', 'supplement_log', 'photos', 'shares', 'ai_jobs'];
function seqTables() {
  const sqlOf = t => (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) || {}).sql;
  const todo = SEQ_TABLES.filter(t => sqlOf(t) && !/\bAUTOINCREMENT\b/i.test(sqlOf(t)));
  if (!todo.length) return;
  db.exec('PRAGMA foreign_keys = OFF');   /* only takes effect outside a transaction */
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const broken = () => db.prepare('PRAGMA foreign_key_check').all().length;
      const before = broken();
      for (const t of todo) {
        const create = sqlOf(t).replace(/^CREATE TABLE\s+("?)\w+\1/i, `CREATE TABLE "${t}_seq"`)
          .replace(/(\bid\s+INTEGER\s+PRIMARY\s+KEY)\b/i, '$1 AUTOINCREMENT');
        if (!create.startsWith(`CREATE TABLE "${t}_seq"`) || !/AUTOINCREMENT/.test(create)) throw new Error(`Can’t upgrade the ids of ${t}`);
        const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(t);
        db.exec(create);
        db.exec(`INSERT INTO "${t}_seq" SELECT * FROM "${t}"`);
        db.exec(`DROP TABLE "${t}"`);
        db.exec(`ALTER TABLE "${t}_seq" RENAME TO "${t}"`);
        for (const i of indexes) db.exec(i.sql);
      }
      if (broken() > before) throw new Error('Upgrading the ids broke a foreign key');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
}
seqTables();

/* Added later: an index on every foreign key column no other index starts with, so removing an account, an exercise or a
   supplement finds the rows that point at it (ON DELETE CASCADE / SET NULL) without reading the whole table. The rest are
   covered: each other child column is the first column of its table's primary key or of an index above. */
db.exec(`CREATE INDEX IF NOT EXISTS sets_exercise_id ON sets(exercise_id);
CREATE INDEX IF NOT EXISTS supplement_log_supp ON supplement_log(supplement_id);
CREATE INDEX IF NOT EXISTS workouts_user ON workouts(user_id, position);
CREATE INDEX IF NOT EXISTS invites_user ON invites(user_id);`);

/* Before dates were checked (#69) a few rows were stored under dates that don't exist (2026-02-30), which nothing can open now.
   Each moves to the real date it stood for – the one a browser turned it into (2026-03-02) – unless that would land on a row
   already there: a day or weight is then kept where it is, and stays deletable (DELETE takes a stored key as it is). Every move
   and every row kept is written to the server log, so nothing changes silently. Runs once: a clean run records 'dates_fixed' in
   app_config, in the same transaction as its moves (nothing can store such a date any more), so later starts don't scan the tables. */
function fixImpossibleDates() {
  if (db.prepare("SELECT 1 FROM app_config WHERE key = 'dates_fixed'").get()) return;
  const { isDate } = require('./dates');
  /* SQLite's date() rolls 2026-02-31 over (or gives NULL for month 13), so only impossible dates differ from it */
  const SHAPE = c => `${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND date(substr(${c}, 1, 10)) IS NOT substr(${c}, 1, 10)`;
  const rolled = d => { const [y, m, dd] = d.slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toISOString().slice(0, 10); };
  const bad = d => !isDate(d.slice(0, 10));
  /* [table, date column, the columns that with the date make a row unique (null: any number of rows share a date)] */
  const TABLES = [['days', 'date', ['user_id']], ['weights', 'date', ['user_id']], ['checklist_log', 'date', ['user_id', 'item']],
    ['supplement_log', 'date', null], ['photos', 'date', null], ['sets', 'at', null]];
  const said = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [t, col, key] of TABLES) {
      const cols = ['user_id', ...(key || []).filter(k => k !== 'user_id')];
      const rows = db.prepare(`SELECT rowid AS rid, ${col} AS d, ${cols.join(', ')} FROM ${t} WHERE ${SHAPE(col)}`).all().filter(r => bad(r.d));
      if (!rows.length) continue;
      const taken = key && db.prepare(`SELECT 1 FROM ${t} WHERE ${key.map(k => k + ' = ?').join(' AND ')} AND ${col} = ?`);
      const drop = db.prepare(`DELETE FROM ${t} WHERE rowid = ?`), move = db.prepare(`UPDATE ${t} SET ${col} = ? WHERE rowid = ?`);
      for (const r of rows) {
        const to = rolled(r.d) + r.d.slice(10);
        const there = taken && taken.get(...key.map(k => r[k]), to);
        if (there && t === 'checklist_log') { drop.run(r.rid); said.push(`${t} user ${r.user_id} ${r.d}: the same tick is already on ${to.slice(0, 10)} – dropped`); continue; }
        if (there) { said.push(`${t} user ${r.user_id} ${r.d}: kept – ${to.slice(0, 10)} already has one; delete it from History`); continue; }
        move.run(to, r.rid);
        said.push(`${t} user ${r.user_id} ${r.d.slice(0, 10)} → ${to.slice(0, 10)}`);
      }
    }
    db.prepare("INSERT OR IGNORE INTO app_config (key, data) VALUES ('dates_fixed', '{}')").run();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (said.length) console.log(`Rows stored under dates that don't exist (saved before dates were checked):\n  ${said.join('\n  ')}`);
}
fixImpossibleDates();

module.exports = db;

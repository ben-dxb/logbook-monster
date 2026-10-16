'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
/* Node's built-in SQLite: nothing to compile, works the same on Windows, macOS and Linux. */
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
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
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, name COLLATE NOCASE)
);
CREATE TABLE IF NOT EXISTS workouts (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  items       TEXT NOT NULL DEFAULT '[]',
  position    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
/* at is the local date and time the set was done, YYYY-MM-DDTHH:MM:SS, like the dates of days. */
CREATE TABLE IF NOT EXISTS sets (
  id          INTEGER PRIMARY KEY,
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
  id         INTEGER PRIMARY KEY,
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
/* An account's own plan, week, targets and food values, layered over the app defaults (app_config 'defaults'). */
CREATE TABLE IF NOT EXISTS user_defaults (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
/* Supplements: a library like the foods (a name, a usual amount and unit, notes, private or shared) and
   the log of what each account took on a day. A log entry keeps its own name, amount and unit, so it
   can be free text, and survives the library entry being changed or deleted. */
CREATE TABLE IF NOT EXISTS supplements (
  id         INTEGER PRIMARY KEY,
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
  id            INTEGER PRIMARY KEY,
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
/* Progress photos: the image files live on disk in config.photoDir under random names (file, and a small
   thumb made in the browser); this keeps who owns them, the date taken, the pose and a note. */
CREATE TABLE IF NOT EXISTS photos (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  pose       TEXT NOT NULL DEFAULT 'front',
  note       TEXT NOT NULL DEFAULT '',
  file       TEXT NOT NULL,
  type       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  thumb      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS photos_day ON photos(user_id, date);
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
}

module.exports = db;

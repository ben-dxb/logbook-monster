'use strict';
/* A memo of GET /api/timeline/trends answers (the serialized JSON), so a repeat read – the Timeline opened again, a coach
   link showing the same range – doesn't walk every gym set again. Process-local: one server process, gone on restart.
   An entry is good while its account's generation and the global one are what they were when it was made:
   - an account's generation goes up on every write it makes (the /api middleware in server/api.js, as the answer is
     sent), on a background job finishing (server/jobs.js) and when the account is removed (server/users.js);
   - the global one on the AI settings and the app options (PUT /api/admin/ai, /api/admin/options).
   Keyed by the account id only – a coach link reaches here only after its share has been checked on that request. */
const MAX_ENTRIES = 200, MAX_BYTES = 16 * 1024 * 1024;

const gens = new Map();   /* account id → generation */
const memo = new Map();   /* key → { uid, ug, gg, json }; oldest first (a hit moves it to the end) */
let global = 0, bytes = 0;

const gen = uid => gens.get(uid) || 0;
function del(key) { const e = memo.get(key); if (e) { bytes -= e.json.length; memo.delete(key); } }
function bump(uid) { gens.set(uid, gen(uid) + 1); }
function bumpAll() { global++; }
/* the account is gone: its entries go now, and anything made before stays invalid */
function drop(uid) { bump(uid); for (const [k, e] of memo) if (e.uid === uid) del(k); }

/* the JSON for this account and key, made by make() unless a current one is kept */
function get(uid, key, make) {
  const k = `${uid}|${key}`, e = memo.get(k), ug = gen(uid), gg = global;
  if (e && e.ug === ug && e.gg === gg) { memo.delete(k); memo.set(k, e); return e.json; }
  del(k);
  const json = make();
  if (json.length <= MAX_BYTES / 8) {
    memo.set(k, { uid, ug, gg, json });
    bytes += json.length;
    for (const old of memo.keys()) { if (memo.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break; del(old); }
  }
  return json;
}

const stats = () => ({ entries: memo.size, bytes });

module.exports = { get, bump, bumpAll, drop, stats };

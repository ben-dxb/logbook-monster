'use strict';
/* Secrets kept in the database (the TOTP keys, the OpenRouter key, the SMTP password – each slot of them) are sealed with
   envelope encryption (AES-256-GCM throughout):
   - a random 32-byte data key per purpose seals the values: `v2.<kid>.<iv>.<tag>.<ct>`, the kid naming the data key;
   - the data keys are kept in app_config 'keys' as {kid, purpose, wrapped, created_at}, wrapped (sealed) with the
     key-encrypting key (KEK) derived from SEAL_KEY – or the first session secret while SEAL_KEY isn't set.
   A copy of the database alone gives nothing away. Rotating the KEK only rewraps the data keys (docs/rotation.md):
   on start each data key is unwrapped with SEAL_KEY, else SEAL_KEY_OLD, else – until the flag below is set – any session
   secret, and rewrapped with SEAL_KEY, all in one transaction. Values from before (`v1.`, sealed directly under a key derived
   from SEAL_KEY or a session secret) are resealed as v2 in that transaction. Once everything is v2 and wrapped by SEAL_KEY,
   sealKeyOnly is recorded and the session secrets are never tried again (so rotating those can't open anything).
   A data key older than ROTATE_DAYS is replaced and its values resealed, on start and daily. Then a self-check: every sealed
   value must open under the active KEK, or a loud error (not an exit – the app runs; only those secrets are lost). */
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const ROTATE_DAYS = 30;
const PURPOSES = { totp: 'totp-secret-v1', openrouter: 'openrouter-key-v1', smtp: 'smtp-pass-v1' };

const hk = (secret, info) => Buffer.from(crypto.hkdfSync('sha256', secret, 'logbook-monster', info, 32));
const b64 = b => b.toString('base64url');
function enc(key, buf, aad) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b64).join('.');
}
function dec(key, iv, tag, ct, aad) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    if (aad) d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
  } catch { return null; }
}

const q = {
  get: db.prepare("SELECT data FROM app_config WHERE key = 'keys'"),
  put: db.prepare(`INSERT INTO app_config (key, data) VALUES ('keys', ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`),
  totp: db.prepare('SELECT user_id, secret FROM totp'),
  totpPut: db.prepare('UPDATE totp SET secret = ? WHERE user_id = ? AND secret = ?'),
  cfg: db.prepare('SELECT data FROM app_config WHERE key = ?'),
  cfgPut: db.prepare('UPDATE app_config SET data = ? WHERE key = ? AND data = ?'),
};
/* where sealed values live: app_config rows and the JSON fields in them (active, next and old slots) */
const SPOTS = [['openrouter', 'openrouter', ['keySealed', 'nextSealed', 'oldSealed']], ['smtp', 'email', ['passSealed', 'nextSealed', 'oldSealed']]];

let stored = { keys: [], sealKeyOnly: false };
const ring = new Map();   /* kid → { purpose, created_at, wrapped, key: Buffer | null, by: 'active' | 'old' | 'session' | null } */
let last = { rewrapped: 0, resealed: { totp: 0, openrouter: 0, smtp: 0 }, problems: [], at: null };

const kekSource = () => (config.sealKey ? 'SEAL_KEY' : 'session secret');
function keks() {
  const list = [{ by: 'active', key: hk(config.sealKey || config.sessionSecrets[0], 'kek-v2') }];
  if (config.sealKeyOld) list.push({ by: 'old', key: hk(config.sealKeyOld, 'kek-v2') });
  if (!stored.sealKeyOnly) for (const s of config.sessionSecrets.slice(config.sealKey ? 0 : 1)) list.push({ by: 'session', key: hk(s, 'kek-v2') });
  return list;
}
const aadOf = e => `${e.kid}|${e.purpose}`;
function load() {
  let s = {};
  try { s = JSON.parse((q.get.get() || {}).data || '{}'); } catch {}
  stored = { keys: Array.isArray(s.keys) ? s.keys : [], sealKeyOnly: !!s.sealKeyOnly };
  const K = keks();
  for (const e of stored.keys) {
    const have = ring.get(e.kid);
    if (have && have.key && have.wrapped === e.wrapped) continue;
    const [iv, tag, ct] = String(e.wrapped || '').split('.');
    let key = null, by = null;
    for (const k of K) { const b = dec(k.key, iv, tag, ct, aadOf(e)); if (b && b.length === 32) { key = b; by = k.by; break; } }
    ring.set(e.kid, { purpose: e.purpose, created_at: e.created_at, wrapped: e.wrapped, key, by });
  }
}
/* the data keys back to app_config, merged with what another process (create-user, a second start) wrote meanwhile */
function persist(drop = new Set()) {
  let s = {};
  try { s = JSON.parse((q.get.get() || {}).data || '{}'); } catch {}
  const out = new Map((Array.isArray(s.keys) ? s.keys : []).map(e => [e.kid, e]));
  for (const [kid, r] of ring) out.set(kid, { kid, purpose: r.purpose, wrapped: r.wrapped, created_at: r.created_at });
  for (const kid of drop) { out.delete(kid); ring.delete(kid); }
  stored = { keys: [...out.values()], sealKeyOnly: stored.sealKeyOnly || !!s.sealKeyOnly };
  const json = JSON.stringify(stored);
  if (json !== JSON.stringify({ keys: s.keys || [], sealKeyOnly: !!s.sealKeyOnly })) q.put.run(json);   /* a start with nothing to do writes nothing */
}
let inTx = false;
const tx = fn => {
  if (inTx) return fn();
  db.exec('BEGIN IMMEDIATE'); inTx = true;
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { inTx = false; }
};
const age = r => Date.now() - Date.parse(r.created_at || 0);
/* the newest data key for a purpose that opens; a new one when there's none or it's due (written before anything uses it) */
function activeKid(purpose, { make = true } = {}) {
  let best = null;
  for (const [kid, r] of ring) if (r.purpose === purpose && r.key && (!best || r.created_at > ring.get(best).created_at)) best = kid;
  if ((!best || age(ring.get(best)) >= ROTATE_DAYS * 86400000) && make) {
    const kid = crypto.randomBytes(6).toString('hex'), key = crypto.randomBytes(32), created_at = new Date().toISOString();
    const e = { kid, purpose, created_at };
    ring.set(kid, { purpose, created_at, key, by: 'active', wrapped: enc(keks()[0].key, key, aadOf(e)) });
    tx(() => persist());
    return kid;
  }
  return best;
}

function sealWith(purpose, buf) {
  const kid = activeKid(purpose);
  return `v2.${kid}.` + enc(ring.get(kid).key, buf, `${kid}|${purpose}`);
}
/* v1 (before envelope encryption): a key derived per purpose from SEAL_KEY or a session secret; tried until sealKeyOnly */
function openV1(purpose, s) {
  const [, iv, tag, ct] = String(s).split('.');
  for (const secret of [config.sealKey, config.sealKeyOld, ...(stored.sealKeyOnly ? [] : config.sessionSecrets)].filter(Boolean)) {
    const b = dec(hk(secret, purpose), iv, tag, ct); if (b) return b;
  }
  return null;
}
function openWith(purpose, s) {
  const p = String(s || '').split('.');
  if (p[0] === 'v1' && p.length === 4) return openV1(purpose, s);
  if (p[0] !== 'v2' || p.length !== 5) return null;
  if (!ring.has(p[1])) load();   /* sealed by another process with a key made after this one loaded */
  const r = ring.get(p[1]);
  return r && r.key && r.purpose === purpose ? dec(r.key, p[2], p[3], p[4], `${p[1]}|${purpose}`) : null;
}

/* Start-up and daily: rewrap, reseal (v1 → v2, a replaced data key), drop data keys nothing uses, check every value opens. */
function maintain() {
  return tx(() => {
    load();
    let rewrapped = 0;
    const K0 = keks()[0].key;
    for (const [kid, r] of ring) {
      if (r.key && r.by !== 'active') { r.wrapped = enc(K0, r.key, aadOf({ kid, purpose: r.purpose })); r.by = 'active'; rewrapped++; }
    }
    const resealed = { totp: 0, openrouter: 0, smtp: 0 }, problems = [], used = new Set();
    /* one value: the same string, a resealed one, or null (doesn't open) */
    const fix = (spot, purpose, v) => {
      const p = String(v).split('.');
      const buf = openWith(purpose, v);
      if (!buf) { problems.push(spot); if (p[0] === 'v2') used.add(p[1]); return v; }
      if (p[0] === 'v2' && p[1] === activeKid(purpose)) { used.add(p[1]); return v; }
      const out = sealWith(purpose, buf);
      used.add(out.split('.')[1]);
      return out;
    };
    for (const r of q.totp.all()) {
      const v = fix('totp', PURPOSES.totp, r.secret);
      if (v !== r.secret && q.totpPut.run(v, r.user_id, r.secret).changes) resealed.totp++;
    }
    for (const [name, key, fields] of SPOTS) {
      const row = q.cfg.get(key);
      let d; try { d = row && JSON.parse(row.data); } catch { d = null; }
      if (!d) continue;
      let changed = false;
      for (const f of fields) if (typeof d[f] === 'string' && d[f]) { const v = fix(name, PURPOSES[name], d[f]); if (v !== d[f]) { d[f] = v; changed = true; } }
      if (changed && q.cfgPut.run(JSON.stringify(d), key, row.data).changes) resealed[name] = 1;
    }
    /* active keys stay (the next seal uses them); others only while a value needs them */
    const active = new Set(Object.values(PURPOSES).map(p => activeKid(p, { make: false })).filter(Boolean));
    const drop = new Set([...ring.keys()].filter(kid => !used.has(kid) && !active.has(kid)));
    persist(drop);
    if (config.sealKey && !problems.length && [...ring.values()].every(r => r.key && r.by === 'active') && !stored.sealKeyOnly) {
      stored.sealKeyOnly = true;
      q.put.run(JSON.stringify(stored));
    }
    last = { rewrapped, resealed, problems, at: new Date().toISOString() };
    return last;
  });
}
function report(r) {
  if (r.rewrapped || r.resealed.totp || r.resealed.openrouter || r.resealed.smtp) {
    console.log(`sealed keys: rewrapped ${r.rewrapped}, resealed ${JSON.stringify(r.resealed).replace(/"/g, '').replace(/,/g, ', ').replace(/:/g, ': ')}`);
  }
  if (r.problems.length) {
    const n = {}; for (const p of r.problems) n[p] = (n[p] || 0) + 1;
    console.error(`SEALED SECRETS DON’T OPEN (${Object.entries(n).map(([k, v]) => `${k} ×${v}`).join(', ')}): the ${kekSource()} in use isn’t the key `
      + 'that sealed them. Put the previous SEAL_KEY in SEAL_KEY_OLD and restart (docs/rotation.md); otherwise those secrets have to be set up again.');
  }
}
try { report(maintain()); } catch (e) { console.error('Sealed keys: start-up check failed:', e.message); }
setInterval(() => { try { report(maintain()); } catch (e) { console.error('Sealed keys: daily check failed:', e.message); } }, 24 * 60 * 60 * 1000).unref();

/* For the Keys panel (never a key): the KEK in use, whether SEAL_KEY_OLD is still needed, the data keys and their ages. */
function status() {
  load();
  return {
    kek: kekSource(), sealKeyOld: !!config.sealKeyOld, oldNeeded: [...ring.values()].some(r => r.by === 'old'), sealKeyOnly: stored.sealKeyOnly,
    problems: last.problems.length, rotateDays: ROTATE_DAYS,
    dataKeys: [...ring.entries()].map(([kid, r]) => ({ kid, purpose: r.purpose, created: r.created_at, opens: !!r.key })),
  };
}

function sealer(purpose) {
  const seal = buf => sealWith(purpose, buf);
  /* null when it can't be opened */
  const unseal = s => openWith(purpose, s);
  /* opens, but not as v2 under the active data key: maintain() reseals it */
  const stale = s => !!s && !!unseal(s) && String(s).split('.')[1] !== activeKid(purpose, { make: false });
  const sealText = s => seal(Buffer.from(String(s), 'utf8'));
  const unsealText = s => { const b = unseal(s); return b ? b.toString('utf8') : null; };
  return { seal, unseal, stale, sealText, unsealText };
}
module.exports = sealer;
module.exports.maintain = maintain;
module.exports.status = status;
module.exports.PURPOSES = PURPOSES;

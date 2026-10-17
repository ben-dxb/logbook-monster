'use strict';
/* Accounts an admin manages: the list, invites (an account with no password yet plus a one-time link)
   and removing an account. Accepting an invite is in auth.js. */
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const mail = require('./mail');

const INVITE_DAYS = 7;

const q = {
  list: db.prepare(`SELECT u.id, u.email, u.name, u.created_at, u.last_login_at, u.invited_by,
      u.password_hash IS NOT NULL AS has_password, u.google_sub IS NOT NULL AS has_google,
      (SELECT MAX(expires_at) FROM invites i WHERE i.user_id = u.id) AS invite_expires
    FROM users u ORDER BY u.created_at, u.id`),
  byId: db.prepare('SELECT id, email, name, password_hash, google_sub, invited_by, last_login_at FROM users WHERE id = ?'),
  byEmail: db.prepare('SELECT id, email, name, password_hash, google_sub, invited_by, last_login_at FROM users WHERE email = ?'),
  create: db.prepare('INSERT INTO users (email, name, invited_by) VALUES (?, ?, ?)'),
  setInvitedBy: db.prepare('UPDATE users SET invited_by = COALESCE(invited_by, ?) WHERE id = ?'),
  setName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM users WHERE id = ?'),
  addInvite: db.prepare("INSERT INTO invites (token_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, datetime('now', ?))"),
  clearInvites: db.prepare('DELETE FROM invites WHERE user_id = ?'),
  endSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND sid IS NOT ?'),
  findInvite: db.prepare(`SELECT i.user_id, i.created_by, u.email, u.name FROM invites i JOIN users u ON u.id = i.user_id
    WHERE i.token_hash = ? AND i.expires_at > datetime('now')`),
};

const hash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const pending = u => !u.password_hash && !u.google_sub && !u.last_login_at;

function list(admin, isAdmin) {
  return q.list.all().map(u => ({
    id: u.id, email: u.email, name: u.name, created: u.created_at, lastLogin: u.last_login_at,
    invitedBy: u.invited_by, password: !!u.has_password, google: !!u.has_google,
    admin: isAdmin(u), you: u.id === admin.id,
    status: u.has_password || u.has_google || u.last_login_at ? 'active' : u.invite_expires && u.invite_expires > sqlNow() ? 'invited' : 'expired',
  }));
}
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/* A new link for this account; older links for it stop working. */
function newLink(user, admin) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.clearInvites.run(user.id);
  q.addInvite.run(hash(token), user.id, admin.email, `+${INVITE_DAYS} days`);
  return `${config.baseUrl}/invite#${token}`;
}

async function sendInvite(user, link, admin) {
  const who = admin.name ? `${admin.name} (${admin.email})` : admin.email;
  await mail.send({
    to: user.email, replyTo: admin.email,
    subject: 'You’re invited to Logbook Monster',
    text: `Hi${user.name ? ' ' + user.name : ''},\n\n${who} has invited you to Logbook Monster, for meal plans, weight and gym tracking.\n\n`
      + `Open this link to pick a password and sign in:\n${link}\n\n`
      + `The link works once and runs out in ${INVITE_DAYS} days. If you weren’t expecting this, you can ignore this email.\n`,
  });
}

/* Invite someone new, or send a fresh link to someone who hasn't signed in yet.
   Always returns the link so the admin can pass it on if the email doesn't arrive. */
async function invite({ email, name }, admin) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim().slice(0, 100) || null;
  if (!mail.EMAIL_RE.test(email)) { const e = new Error('Enter a valid email address'); e.status = 400; throw e; }
  let user = q.byEmail.get(email);
  if (user && !pending(user)) { const e = new Error('That person already has an account'); e.status = 409; throw e; }
  if (user) { q.setInvitedBy.run(admin.email, user.id); if (name) q.setName.run(name, user.id); }
  else user = { id: q.create.run(email, name, admin.email).lastInsertRowid };
  return deliver(q.byId.get(user.id), admin);
}
async function resend(id, admin) {
  const user = q.byId.get(id);
  if (!user) { const e = new Error('No such account'); e.status = 404; throw e; }
  if (!pending(user)) { const e = new Error('That person has already signed in'); e.status = 409; throw e; }
  q.setInvitedBy.run(admin.email, user.id);
  return deliver(user, admin);
}
async function deliver(user, admin) {
  const link = newLink(user, admin);
  let emailed = false, emailError = null;
  if (mail.configured()) {
    try { await sendInvite(user, link, admin); emailed = true; } catch (e) { emailError = e.message; }
  } else emailError = 'Email isn’t set up, so nothing was sent.';
  return { id: user.id, email: user.email, link, emailed, emailError };
}

function remove(id, admin, isAdmin) {
  const user = q.byId.get(id);
  if (!user) { const e = new Error('No such account'); e.status = 404; throw e; }
  if (user.id === admin.id) { const e = new Error('You can’t remove your own account'); e.status = 400; throw e; }
  /* ADMIN_EMAILS can't be turned off from here, so an admin account stays; take them out of ADMIN_EMAILS first. */
  if (isAdmin(user)) { const e = new Error('That account is an admin. Take it out of ADMIN_EMAILS first.'); e.status = 400; throw e; }
  q.remove.run(user.id);
  endSessions(user.id);
  return { ok: true };
}

const findInvite = token => (token ? q.findInvite.get(hash(token)) : null);
const clearInvites = userId => q.clearInvites.run(userId);
/* Signs the account out everywhere, except the session keepSid (the browser that asked). */
const endSessions = (userId, keepSid = null) => q.endSessions.run(userId, keepSid).changes;
/* Still waiting on an invite: no password, no Google link, never signed in. */
const isPending = id => { const u = q.byId.get(id); return !!u && pending(u); };

module.exports = { list, invite, resend, remove, findInvite, clearInvites, endSessions, isPending };

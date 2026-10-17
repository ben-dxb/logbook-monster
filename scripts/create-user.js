'use strict';
/* Create an account, or reset its password:  npm run create-user -- you@example.com */
const readline = require('readline');
const { hashPassword, passwordProblem } = require('../server/passwords');
const db = require('../server/db');

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run create-user -- you@example.com');
  process.exit(1);
}

function askHidden(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.startsWith(prompt)) rl.output.write(prompt); };
    rl.question(prompt, a => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const pw = process.env.NEW_PASSWORD || await askHidden('Password (10+ characters): ');
  const problem = passwordProblem(pw);
  if (problem) { console.error(problem); process.exit(1); }
  const hash = await hashPassword(pw);
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
    /* a reset signs the account out everywhere, and an old invite link can't replace the new password */
    const ended = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id).changes;
    db.prepare('DELETE FROM invites WHERE user_id = ?').run(existing.id);
    console.log(`Password updated for ${email}${ended ? ` – signed out of ${ended} session${ended > 1 ? 's' : ''}` : ''}.`);
  } else {
    db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash);
    console.log(`Account created for ${email}.`);
  }
})();

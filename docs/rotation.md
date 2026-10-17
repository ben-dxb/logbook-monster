# Rotating credentials

Every credential Logbook Monster holds should be replaced at least every **30 days**, and each can be replaced without
signing anyone out or losing data. **Super admin › Keys** lists every credential with where it's kept, the slots in
use, its age and the next step (never a value). The app reminds you:

| Age | What happens |
|---|---|
| day 25 | an email to the super admins listing what's due (once a day, while email is set up) |
| day 30 | a `secret.stale` row in the security log (once a day), a banner on every Super admin tab, the daily email |
| day 35 | an error in the server log on every start |
| unknown | counts as stale, with a note saying how to give the date |

**Giving a `.env` secret its date.** Put the day it was set in front of the value – `SEAL_KEY=2026-10-17:3f9c…` – or
beside it as `<NAME>_SET=2026-10-17` (`SESSION_SECRETS_SET` dates the first session secret). The `YYYY-MM-DD:` prefix is
never part of the key. Keys saved on the Super admin page get their date when the key itself changes (not when a model
or a server name changes).

Make a random secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

After every restart, look for the line `sealed keys: rewrapped n, resealed {…}` in the log (only printed when something
changed) and make sure there is **no** `SEALED SECRETS DON’T OPEN` error.

---

## Session secrets – `SESSION_SECRETS`

What it does: signs the session cookie, the CSRF pre-cookie and the AI-fill provenance; while `SEAL_KEY` isn't set it
also wraps the data keys (see below). Blast radius if leaked: anyone can forge a session cookie for any account.

`SESSION_SECRETS=newest,current,previous` – a comma list, each 32+ characters. The **first signs**; all of them are
accepted. (The older `SESSION_SECRET` + `SESSION_SECRET_OLD` pair still works; `SESSION_SECRETS` wins when both are set.)

1. **Provision**: put a new secret first: `SESSION_SECRETS=2026-10-17:<new>,<current>`. Restart.
2. **Verify**: you stay signed in (your cookie was signed with the old one and is still accepted); sign in in a private
   window – that cookie is signed with the new one. Super admin › Keys shows "2 in use – the first signs" and when the
   second can go.
3. **Overlap**: a secret may be dropped once it is older than `SESSION_DAYS` (30) **+ 1 hour** after it stopped being
   first – by then every cookie it signed has run out. Keys says the exact time.
   To shorten the overlap (after a leak) drop it straight away: everyone signed in before is signed out.
4. **Revoke**: remove it from `SESSION_SECRETS` and restart.
5. **Prove it dead**: a cookie from before the rotation answers 401 on `/api/me` (`test/rotation.test.js` does exactly
   this). The security log email hashes don't change if `AUDIT_HASH_KEY` is set – set it once, before the first rotation.

Rotating every 30 days with a 30-day overlap means at most three entries: `newest,current,previous`.

## Seal key – `SEAL_KEY` / `SEAL_KEY_OLD`

What it does: the key-encrypting key (KEK). The OpenRouter key, the SMTP password (each slot) and every authenticator
key are sealed with a random **data key** per purpose (AES-256-GCM, `v2.<kid>.<iv>.<tag>.<ct>`); the data keys are kept
in the database wrapped by the KEK, which is derived from `SEAL_KEY` – or from the first session secret while `SEAL_KEY`
isn't set. Blast radius if leaked **together with a copy of the database**: those three kinds of secret. Alone, it
opens nothing.

Set it once if you haven't: after the first start with it the data keys are rewrapped under it, and from then on the
session secrets are never tried again (so rotating those can't affect sealed secrets).

1. **Provision**: move the current one to `SEAL_KEY_OLD` and set a new `SEAL_KEY` (dated). Restart.
2. **Verify**: the log says `sealed keys: rewrapped 3, …` (one per data key in use) and shows no error. Super admin ›
   Keys says "Remove SEAL_KEY_OLD – every data key is wrapped by SEAL_KEY now". Authenticator codes still work, AI and
   email still work.
3. **Overlap**: one start is enough – everything is rewrapped in one transaction on that start.
4. **Revoke**: remove `SEAL_KEY_OLD` and restart.
5. **Prove it dead**: restart once with the *old* key as `SEAL_KEY` (and no `SEAL_KEY_OLD`) – it must log
   `SEALED SECRETS DON’T OPEN` (and change nothing); then put the new one back. `test/seal.test.js` runs this cycle.

If you change `SEAL_KEY` without `SEAL_KEY_OLD` the app still starts, logs that error, and the sealed secrets are
unusable until you put the old key back in `SEAL_KEY_OLD` and restart; otherwise set the AI key and SMTP password again
and everyone with two-step sign-in uses a recovery code and sets it up again.

Data keys are replaced by themselves every 30 days (their values resealed on start or by the daily check) – nothing to do.
**Backups**: a database backup taken before a KEK rotation still opens with the old `SEAL_KEY`. Keep that key with
those backups (offline), or delete the backups once newer ones exist.

Values sealed by versions before envelope encryption (`v1.`) are resealed as v2 on the first start of this version.

## OpenRouter API key (two slots, semi-manual)

What it does: every AI call. Blast radius: spending on your OpenRouter account. Held sealed in the database (Super
admin › AI) or as `OPENROUTER_API_KEY` in `.env` (move it to the page to rotate it there).

1. **Provision**: at <https://openrouter.ai/keys> create a new key (name it with today's date). On Super admin › AI ›
   *Rotate the key*, paste it and **Save as next**.
2. **Verify**: **Test next** – one free call to OpenRouter's `GET /key` with it. It must say it works.
3. **Promote**: **Promote** – it becomes the active key at once, for every call. The one it replaced is kept as *old* for
   one hour, then dropped.
4. **Revoke**: delete the old key in the OpenRouter dashboard.
5. **Prove it dead**: within that hour press **Test old** – it must say it's refused. That is recorded in the security log
   (`secret.tested`, `dead: true`) and on Keys.

Every step asks for your password or a code again on a sign-in over 15 minutes old. The plain *Save key* still works
(it does steps 1 and 3 at once, without the test).

## Gmail app password (two slots, manual at Google)

What it does: sends invites and notifications. Blast radius: email sent as your account (an app password can't change
the Google account itself). Held sealed in the database (Super admin › Email) or as `SMTP_PASS` in `.env`.

1. **Provision**: at <https://myaccount.google.com/apppasswords> create a new app password (name it with today's date).
   On Super admin › Email › *Rotate the password*, paste it and **Save as next**.
2. **Verify**: **Test next** – a real sign-in to the mail server (connect, TLS, AUTH, quit); no email is sent.
3. **Promote**: **Promote**. Send a test email to be sure.
4. **Revoke**: delete the old app password on the same Google page.
5. **Prove it dead**: **Test old** within the hour – it must be refused (recorded like the AI key).

## GitHub deploy key

The repository is public, so the server needs no key to pull it: use `https://github.com/ben-dxb/logbook-monster.git`
and **remove the deploy key** (GitHub › repository › Settings › Deploy keys, and `~/.ssh` on the server). If one is
needed for pushing: add the new key there first (read-only unless it must push), switch the server's remote to it,
`git fetch` to verify, then delete the old key on GitHub and prove it dead with `ssh -i <old key> -T git@github.com`
(it must be refused). It is held by GitHub, not the app, so it isn't on the Keys list – rotate it on the same 30 days.

## Google client secret (only if Google sign-in is turned on)

At Google Cloud console › APIs & Services › Credentials › the OAuth client: **Add secret**, set the new one as
`GOOGLE_CLIENT_SECRET=YYYY-MM-DD:<secret>`, restart, sign in with Google to verify, then **delete** the old secret
there. A sign-in still using it fails from then on.

## Not rotated on a schedule (and why)

- **`AUDIT_HASH_KEY`** – only links masked emails in the security log; a new one stops new rows matching older ones.
  Change it only if it leaked.
- **Coach links** – the secret is held by the coach. A link lives 90 days unless you pick otherwise (a year at most);
  the account gets an email a week before one runs out, with **Renew** on Account admin (a new link replaces it – you send
  it yourself), and links nobody opened for 30 days are flagged.
- **Authenticator keys and recovery codes** – held by each person; set up again to change them.
- **Invite links** – run out after 7 days by themselves.

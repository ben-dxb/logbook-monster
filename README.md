# Logbook Monster

Logbook Monster (formerly Meal Swap) is a meal-swap calculator as a self-hosted web app. Each date is its own saved day, there's a
calendar of past days, weight logged each day with a trend on the Timeline, a gym log for workouts and sets, and sign-in with email + password
or Google.

- **Dashboard** – the landing page: a daily checklist (yours to edit on Account admin; weight, supplements and gym
  items can tick themselves when you log one) and a card each for food today against your targets, weight, gym,
  your supplement regime and your latest progress photo. Open any of the last 7 days' checklists.
- **Daily Tracker** – the calculator, for any date. Each weekday uses the day template your plan sets for it
  (Account admin); a new account has no plan until it makes one. Every change
  saves to your account automatically; untouched days stay "plan only" until you change
  something or tap **Save day as is**. Log the day's weight at the top.
- **History** – two tabs. **Calendar**: a month of logged days (calories vs target, protein, weight) with a
  month summary; tap a day to open it. **Timeline**: trends you pick (macros, weight, gym volume, a strength index,
  the estimated 1RM of exercises you follow, supplements you follow) and a card per day with its food, weight,
  photos, supplements and gym sets; **AI summary** sends weekly averages of what's shown to the AI.
- **Gym** – workout tracking in the style of Setgraph. **Workouts** are your training days, each
  a list of exercises with a target ("1 × 5–8 heavy, then 1 × 10–15 lighter"). Tap an exercise to
  see every set by day and log new ones from the bar at the bottom (reps and weight start from your
  last set, with −/+ steppers and a rest timer). 🏆 marks a set that beat your best estimated 1RM
  and a day that beat your best volume; green/red shows more or less than the same set last time.
  Tap a set to change its reps, weight, note, date or time, or delete it. **Chart** shows your
  estimated 1RM over time, **Records** your bests and rep maxes. **Sessions** lists every day you
  trained, **Exercises** is your library. **Read a workout plan with AI** sends your coach's PDF
  or a photo/screenshot to OpenRouter (the admin's key) and shows the workouts it found to check
  before adding them; exercises with the same name as yours keep their history. Each account can
  run 12 AI reads an hour, one file read at a time (meal plan, workout plan or supplement regime).
  The super admin sets a daily cap on AI calls per account and for the whole app (Super admin ›
  Options, default 100 and 1000, 0 = no limit); requests refused before reaching the AI don't count.
  **Import history from Setgraph (CSV)** (on Workouts and Exercises) reads a history export from
  Setgraph – or Strong, Hevy and most trackers, as columns are found by their headings – in the
  browser, shows what it found (sets, exercises, date range, rows it couldn't read, and asks
  day/month order or kg/lb when the file doesn't say), then imports it. Exercises are matched to
  yours by name; sets you already have are skipped, so importing a newer export later is safe.
- **Food Library** – your meal plan is always in it, with nothing to enter: every meal of the plan in
  use as a whole meal (amounts as in the plan; listed per day type when they differ) and every food it
  uses or lets you swap in as an ingredient, kept in step with plan changes. Common fitness foods (chicken, fish,
  eggs, dairy, rice, pasta, oats, potatoes, fruit, veg, fats – typical USDA values) are there to start from.
  **Weights** shows foods per 100 g raw/dry or cooked (one card or the whole list), worked out from a typical
  cooked weight; your own foods can say how they're weighed and their cooked weight. Plus whole meals and single ingredients you enter (per 100 g,
  per 100 ml or per item), with a recipe or notes, private or shared with everyone. Tabs split
  meals from ingredients; search, Show (everything, my meal plan, starter foods, foods I added, shared with me),
  food group (meat and fish, fats…), Sort (A–Z, calories, protein, protein per
  calorie) and quick filters (high protein, low calorie, has recipe, AI estimates) find one, and
  your filters are remembered. **Fill blanks with AI** estimates the values you left empty (and re-estimates any it
  filled before) from the name, type and recipe (OpenRouter, the super admin's key, 40 an hour per account); those values
  are flagged ⚑ and tapping a flag shows the source, workings, confidence and model. Typing your
  own number removes its flag.
- **Supplements** – a library (usual amount and unit, private or shared, like foods) and a log per day, picked from
  the library or typed in. **Read a supplement regime with AI** reads a PDF or photo of a supplement regime into items to check,
  add to the library and log for a day.
- **Progress photos** – your pictures by date, with pose and note; filter by pose or by days you weighed about the
  same, and compare two side by side. Bulk uploads date each photo from its own camera data; the AI can tell the
  pose when you ask. Files are shrunk in the browser and kept on the server's disk, not in the database.
- **AI reads run in the background** (meal plan, workout plan, supplement regime): you can leave the page. A
  finished read opens by itself if you're still there; otherwise a note, a browser notification and – if the app
  isn't open – an email say it's ready.
- **Account admin** (everyone) – your own meal plan; nothing in it comes from anyone else's. A new
  account starts with no plan. A plan is a set of **day templates** (training day, rest day, a refeed
  day – up to 12, named as you like), each with its own meals and targets, plus your foods, which
  template each weekday uses, and whether sauces / green veg count. Add, rename, duplicate or delete
  templates and edit everything in place, or upload a plan (CSV or JSON) and download it again (when the super admin
  has **Plan files** on, Super admin › Options). Each change takes effect from a date you pick (today by default; a
  later date schedules it, an earlier one backdates it, a blank date applies it back to the start); days
  before it keep the plan they had, and **Plan changes** lists them to edit or delete. Days already
  saved keep their own amounts. On the Daily Tracker any one day can follow another template (with two or more
  templates, and not once a meal of that day is marked eaten). Also here: whether protein targets count total or
  direct protein, the Dashboard's **Daily checklist**, **Delete progress photos** between two dates, and your own
  recent sign-ins and security events.
  **Read a PDF with AI** sends your coach's plan PDF (or a photo) to a model on OpenRouter and
  loads its day templates, meals, amounts, new foods and targets into the page for you to check and
  save (12 reads an hour per account, the super admin not limited; using the super admin's key).
  **Share with your coach** makes a link your coach opens with no password or account: your
  recent days (calories against target, macros, weight) and the Timeline – trends and each day's
  food, weight, photos, supplements and gym sets – read only. Pick how long it stays live (an hour
  to a year, or until a date; up to 20 live links); it stops at once when it runs out or you **Switch off** it.
- **Super admin** (`ADMIN_EMAILS` only; on a local setup with it empty, the first account created) – settings for
  the whole app, in tabs: **AI** (the OpenRouter API key – kept on the server, only its last 4 characters shown again; or
  set `OPENROUTER_API_KEY` in `.env` – and a model for each kind of AI task), **People**, **Email**, **Options**
  (**Plan files**, private AI providers, daily AI caps, **Super admins must use a second step** – off by default) and
  **Security log**. Changing the AI key or the email settings,
  or removing an account, asks for your password or an authenticator code again if you signed in more than 15 minutes ago.
  There are no app-wide meal plan defaults: when this version first starts, every account that had
  used the app gets the plan it was using (the old built-in plan, the old app defaults and its own
  changes) as its own, so nothing changes for it.
- **Account menu** – download your data as JSON (photo details, not the image files), set/change password, two-step sign-in, sign out.

## Two-step sign-in (authenticator app)

Any account can add a second step: after the password (or Google), a 6-digit code from an authenticator app
(Google Authenticator, Microsoft Authenticator, 1Password, Authy… – standard TOTP, 30 seconds, SHA-1).

1. Account menu › **Two-step sign-in** › **Set up**. Add the key shown to the app as a time-based key, or tap
   **Open in authenticator app** on the phone (an `otpauth://` link). There is no QR code.
2. Type the code the app shows and press **Turn on**. Tick **Also sign out my other sessions** to end them too (off by
   default). Setting up and turning on need a sign-in or a password/code re-check in the last 15 minutes, and the
   account is emailed whenever the step is switched on or off (when email is set up).
3. **Save the 10 recovery codes** it shows (they aren't shown again). Each one signs in once in place of a code.

To switch it off, open the same box and enter your password or a code. Wrong codes count like wrong passwords: 10 in
15 minutes (`ACCOUNT_FAIL_LIMIT`) from one address and even a right code waits there; past 10 from all addresses every
answer is slowed a little more (at most 4 s). A code works once.

Super admins: once your own is on, Super admin › Options › **Super admins must use a second step** sends any super
admin without it to set one up before any Super admin page works.

**Recovering:** lost the phone – sign in with a recovery code, switch the step off and set it up again on the new
phone (that also gives new recovery codes). Lost the phone *and* the codes – someone with shell access on the
server runs `npm run create-user -- you@example.com --no-2fa` (Docker: `docker compose exec logbook-monster node --disable-warning=ExperimentalWarning scripts/create-user.js you@example.com --no-2fa`),
which sets a new password, signs the account out everywhere and switches its second step off. The key is stored
encrypted under a data key wrapped by `SEAL_KEY` (or the session secret without it): if that is lost, authenticator codes
stop working (recovery codes still do) – sign in with a recovery code and set the step up again. To change it safely see
[docs/rotation.md](docs/rotation.md).

## Run it locally

Needs Node.js 22.13 or newer (it uses the SQLite built into Node, so nothing needs compiling).

```bash
npm install
cp .env.example .env          # then edit .env (see below)
npm run create-user -- you@example.com   # asks for a password
npm run dev                   # http://localhost:3000
```

For local testing you can leave `SESSION_SECRETS` empty – a random one is made and kept in
`data/.session-secret`, so restarts don't sign you out. Instead of `create-user`, you can put your email in `ALLOWED_EMAILS` and use
**Create an account** on the sign-in page.

Run all checks with `npm run check` (syntax, API tests, browser smoke test). The smoke test needs Playwright and its
Chromium; without them `npm run check` **fails** with a message saying so (it never passes untested). Install them
once – on Windows the same commands work in PowerShell or cmd:

```bash
npm install -g playwright
playwright install chromium        # on Linux, add --with-deps if Chromium is missing system libraries
```

`npm test` runs the API tests alone, without a browser.

## Settings (`.env`)

Secrets stay on the server – in `.env`, or in the database (sealed, see Security notes) when the AI key or SMTP
password is saved on the Super admin page. Nothing secret is ever sent to the browser.

| Variable | What it does |
|---|---|
| `SESSION_SECRETS` | **Required in production** (or `SESSION_SECRET`). `newest,current,previous`: random strings, 32+ characters each; the first signs the session cookie, all are accepted, so a new one goes in front without signing anyone out ([docs/rotation.md](docs/rotation.md)). `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `SESSION_SECRET` / `SESSION_SECRET_OLD` | The older form of the same: one secret, plus the previous one while rotating. Ignored when `SESSION_SECRETS` is set. |
| `SEAL_KEY` / `SEAL_KEY_OLD` | Recommended, 32+ characters: the key-encrypting key that wraps the data keys the AI key, SMTP password and authenticator keys are sealed with. Without it the first session secret wraps them. `SEAL_KEY_OLD`: the previous one for one start while rotating. |
| `AUDIT_HASH_KEY` | Recommended, 32+ characters: keys the hash of masked emails in the security log, so rotating the session secrets doesn't stop new rows matching old ones. Without it, the first session secret. |
| `<NAME>_SET` | The day a `.env` secret was set (`YYYY-MM-DD`), for its age on Super admin › Keys – or put `YYYY-MM-DD:` in front of the value itself. |
| `BASE_URL` | The address you open in the browser, e.g. `https://meals.example.com`. Used for the Google redirect, invite links and emails, and to turn on secure cookies/HSTS for `https://`. In production the server warns at start when it isn't set. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Turn on "Continue with Google". Leave empty to hide it. |
| `ALLOWED_EMAILS` | Comma-separated. If set, **only** these emails can sign in, and they can create their own account the first time. |
| `ALLOW_REGISTRATION` | `true` lets anyone sign up. Default `false`. |
| `ADMIN_EMAILS` | Comma-separated. Who can open the Super admin page. **Required in production** (the server won't start without it); empty on a local setup = the first account created. |
| `PRIVACY_CONTACT` / `OPERATOR_NAME` / `SHOW_ADMIN_CONTACT` | Who runs the app, for the privacy page (`/privacy`) and the Contact link on the sign-in page and account menu. Without `PRIVACY_CONTACT` the page says to ask the person who runs the app and there is no Contact link, unless `SHOW_ADMIN_CONTACT=true` offers the first `ADMIN_EMAILS` address. |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | Optional. Powers every AI feature (plan, workout and supplement reads, food values, photo poses, exercise body parts, Timeline summary). A key saved on the Super admin page wins over this one. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` / `MAIL_FROM_NAME` / `SMTP_SECURE` | Optional. `SMTP_SECURE` forces TLS from the start on or off (default: on for port 465). The email account invites and notifications are sent from. Easier to fill in on the Super admin page (Email); a value saved there wins over .env field by field – Save stores only the fields you changed, and the page says which values come from .env. The server must be on the internet (no private, loopback or link-local addresses), and on a port other than 465 it must offer STARTTLS. |
| `SMTP_ALLOW_HOSTS` | Comma-separated mail servers allowed on internal addresses anyway, e.g. a relay on `127.0.0.1` (plain SMTP is allowed to a loopback one). |
| `DB_PATH` | SQLite file. Default `./data/logbook-monster.db` (an existing `./data/mealswap.db` from before the rename is used if present). A relative path is taken from the folder the server starts in. |
| `PHOTO_DIR` | Where progress photo files go. Default `photos/` next to the database. |
| `PORT` / `HOST` | Default `3000`; `HOST` defaults to `127.0.0.1`, or `0.0.0.0` when `NODE_ENV=production`. |
| `NODE_ENV` | `production` on a server: needs `SESSION_SECRETS` (or `SESSION_SECRET`) and `ADMIN_EMAILS`, listens on all addresses unless `HOST` says otherwise. |
| `COOKIE_SECURE` / `SESSION_DAYS` | Secure session cookie (default: on when `BASE_URL` is `https://`); days a sign-in lasts (default 30). |
| `AUTH_RATE_LIMIT`, `ACCOUNT_FAIL_LIMIT`, `WRITE_RATE_LIMIT`, `EXPORT_RATE_LIMIT`, `TRENDS_RATE_LIMIT`, `COACH_RATE_LIMIT`, `QUOTA_DAYS_BYTES`, `QUOTA_PLAN_BYTES`, `QUOTA_PHOTO_BYTES`, `AUDIT_PER_ACCOUNT`, `AUDIT_ALERT_FAILS` | Limits, rarely changed (defaults in `server/config.js` and `server/audit.js`; the tests raise or lower some). |
| `OPENROUTER_BASE_URL` | For tests only: points the AI calls at a fake OpenRouter. |
| `TRUST_PROXY` | Set to `1` when running behind nginx/Caddy (docker-compose.yml does), so sign-in limits see the visitor's address. Off by default: without a proxy that overwrites `X-Forwarded-For`, anyone could fake their address. |

## Google sign-in

1. Go to <https://console.cloud.google.com/apis/credentials> → **Create credentials → OAuth client ID**
   (set up the consent screen first if asked; "External", and add yourself as a test user while
   it's in testing).
2. Application type **Web application**.
3. **Authorised redirect URIs** – add one for each place you run it:
   - `http://localhost:3000/auth/google/callback` (local testing)
   - `https://meals.example.com/auth/google/callback` (your server)
4. Copy the client ID and secret into `.env` and restart.

A Google account whose email matches an existing account is linked to it. New Google accounts
are only created for emails allowed by `ALLOWED_EMAILS` / `ALLOW_REGISTRATION`.

## Inviting people and sending email

On the Super admin page:

1. **Email** – the account the app sends from. For Gmail: turn on 2-Step Verification on the
   Google account, create an app password at <https://myaccount.google.com/apppasswords>, then
   enter the Gmail address under *Send from* and the 16-letter app password. Server
   `smtp.gmail.com` and port `465` are filled in already. Save, then **Send test email**.
2. **People** – enter someone's email and **Send invite**. They get a link (valid 7 days, works
   once) to pick a password or use Google with that address. If email isn't set up, or the send
   fails, the link is shown so you can pass it on yourself. You're emailed when they set their
   password from the link (if email is set up; joining with Google sends no email).
   Invited people can sign in even if `ALLOWED_EMAILS` doesn't list them. **Remove** deletes an
   account and all its data, photos included (not your own account or another super admin's).

## Deploying to a server

### Docker (recommended)

```bash
cp .env.example .env    # set SESSION_SECRETS, SEAL_KEY, BASE_URL=https://…, ALLOWED_EMAILS, Google keys
docker compose up -d --build
docker compose exec logbook-monster node --disable-warning=ExperimentalWarning scripts/create-user.js you@example.com   # optional
```

The app listens on `127.0.0.1:3000`; data is kept in the `mealswap_mealswap-data` volume (its pre-rename name, so existing data carries over).
The container runs hardened: read-only image (the app writes only to the data volume, `/tmp` is a 64 MB in-memory scratch space), all Linux
capabilities dropped, `no-new-privileges`, 768 MB of memory and 256 processes at most, logs rotated at 5 × 10 MB. The base image is pinned to an
exact Node release and digest in the Dockerfile – update both together when moving to a newer Node. Put a
reverse proxy with HTTPS in front – for example Caddy:

```
meals.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

or nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
gzip on;
gzip_types application/json text/css application/javascript image/svg+xml;
gzip_min_length 512;
```

Compression belongs at the proxy, as above – the app itself doesn't compress (no Express `compression`). If a server-sent
events or long-poll endpoint is ever added, exclude it from the proxy's compression so its messages aren't held back in a buffer.

### Without Docker

```bash
npm ci --omit=dev
NODE_ENV=production npm start    # keep it running with systemd or pm2
```

With `NODE_ENV=production` the app won’t start without `SESSION_SECRETS` or `SESSION_SECRET` (32+ characters) and `ADMIN_EMAILS`, and
listens on all addresses – set `HOST=127.0.0.1` when a reverse proxy on the same machine is in front.

### Backups

The data is in two places, and a backup needs **both**: the SQLite database (`data/logbook-monster.db`) and the
progress photos folder (`PHOTO_DIR`, default `data/photos/` next to the database – the database only lists the
photos, the pictures are files). Copying the `.db` file alone loses every photo, and copying it while the app runs
can give a broken copy (recent changes sit in the `-wal` file beside it).

`npm run backup` makes a safe copy of both while the app runs, with Node alone – no `sqlite3` tool, and the same on
Windows, macOS and Linux. Run it from the app's folder (it reads `DB_PATH` / `PHOTO_DIR` from `.env` like the app):

```bash
npm run backup -- ../logbook-backups              # Windows: npm run backup -- D:\logbook-backups
npm run restore-check -- ../logbook-backups       # checks the newest backup in that folder
```

Each run makes a new folder, `logbook-monster-<date>T<time>/`, with the database (`VACUUM INTO`: one consistent file,
no `-wal`), the `photos` folder and – when `SESSION_SECRET` isn't set – the `.session-secret` file the app made beside
the database. Only your user can open it (folders 0700, files 0600; on Windows the folder's own permissions apply). It
prints the sizes and how long it took. The photos are copied first, then the database, then any photos added
meanwhile, and the copy is then checked: the app writes a photo's file before its row and deletes the row before the
file, so every photo in the database copy has its file in the backup (a photo deleted while the backup ran is left out).
`npm run restore-check` opens a backup read-only and reports the database's own check, rows per table and photo rows
against files – it exits with an error if a photo's file is missing. Copy the backup off the machine.

**Keep your secrets with it.** The saved AI key, email password and authenticator keys are sealed with `SEAL_KEY` (or
`SESSION_SECRET` while `SEAL_KEY` isn't set). Without the same value a restored database can't open them. When
`SESSION_SECRET` / `SEAL_KEY` are set in `.env` they are not in the backup – keep a copy of `.env` somewhere as safe as
the backup itself.

With Docker, stop the app for a moment and copy the whole volume (database, photos and `.session-secret`):

```bash
docker compose stop
docker run --rm -v mealswap_mealswap-data:/data -v "$PWD":/out alpine tar czf /out/logbook-monster-backup.tgz -C /data .
docker compose start
```

Or, without stopping it: `docker compose exec logbook-monster npm run backup -- /app/data/backups`, then
`docker compose cp logbook-monster:/app/data/backups ./logbook-backups` and delete the folder from the volume
(`docker compose exec logbook-monster rm -rf /app/data/backups`) so it doesn't fill it.

To restore, stop the app and put the backup's database file back as `DB_PATH` (default `data/logbook-monster.db`),
its `photos` folder as `PHOTO_DIR` (default `data/photos`) and, if the backup has one, `.session-secret` beside the
database. Remove any `logbook-monster.db-wal` / `-shm` files left beside the restored database, and start the app.
On Windows (PowerShell, app stopped):

```powershell
$b = "D:\logbook-backups\logbook-monster-2026-10-17T09-30-00"
Remove-Item data\logbook-monster.db-wal, data\logbook-monster.db-shm -ErrorAction SilentlyContinue
Copy-Item "$b\logbook-monster.db" data\ -Force
Remove-Item data\photos -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item "$b\photos" data\photos -Recurse
if (Test-Path "$b\.session-secret") { Copy-Item "$b\.session-secret" data\ -Force }
```

Docker: `docker run --rm -v mealswap_mealswap-data:/data -v "$PWD":/out alpine sh -c "rm -rf /data/* && tar xzf /out/logbook-monster-backup.tgz -C /data"`.
Keep the same `SEAL_KEY` (or session secret without one) in `.env`: the saved AI key, SMTP password and authenticator keys are sealed under it (docs/rotation.md › Backups).

The app looks after the files itself: at start and once a day it hands the database's free pages back to the disk
(the file shrinks after big deletes), deletes photo files no photo refers to once they are an hour old, and makes the
data folder and files readable by its own user only.

Each user can also download their own data from the account menu (photo details only, not the pictures).

## Security notes

- Passwords hashed with scrypt; login and Google sign-in are rate-limited per IP, and 10 wrong
  passwords for one account from one IP (one IPv6 /64) in 15 minutes lock that address out of it for the rest of that
  time (kept in SQLite, so a restart doesn't reset it); unknown email and wrong password get the same response, and a
  locked address is told to wait 15 minutes – the lock counts tries for any email, known or not, so that says nothing
  about the account. From other addresses the account still signs in – someone who knows the email can't lock the owner out – but
  each wrong password past 10 from all addresses in 15 minutes slows every answer for it (250 ms more each, at most 4 s).
  The password and code re-checks count the same way.
- Sessions are server-side (SQLite, only a SHA-256 of each session ID is stored), in an `HttpOnly`, `SameSite=Lax`
  cookie (on HTTPS `Secure` and named `__Host-logbookmonster.sid`); the session ID changes at sign-in and a session ends `SESSION_DAYS` (30) after sign-in
  however often it's used. Visiting signed out stores nothing on the server.
- Changing your password (or resetting it with `create-user`) signs the account out everywhere
  else, and by default switches off its coach links. A Google-only account adding a first
  password must have signed in within the last 10 minutes. Sign-out sends `Clear-Site-Data`.
- Optional second step (TOTP, RFC 6238) for any account: until the code is given the session holds no account, so
  no `/api` route answers it; it runs out after 5 minutes. The secret is stored AES-256-GCM-encrypted (sealed, below),
  recovery codes only as SHA-256 hashes; each code is taken once and wrong codes
  are limited like passwords. Setting the step up, changing the AI key or the email settings, removing an account and
  loosening an Option (a higher or no AI cap, AI privacy or "super admins must use a second step" off) need the password
  or a code again on a sign-in older than 15 minutes; switching the step on doesn't count as that re-check. With that
  Option on, a super admin without the step also loses the other super admin powers (removing others' shared foods and
  supplements, no AI allowance).
- The OpenRouter key and SMTP password saved on Super admin are stored sealed: envelope encryption (AES-256-GCM) – a
  random data key per purpose seals the values, the data keys are kept wrapped by `SEAL_KEY` (or the first session secret
  without it), and data keys are replaced every 30 days. On start every sealed value must open, or the server log says
  loudly which don't. The database runs with `secure_delete` on and its file (and photos) are created readable by the
  app's own user only.
- **Credentials and rotation** ([docs/rotation.md](docs/rotation.md) is the step-by-step runbook). Every credential is
  meant to be replaced every 30 days; Super admin › Keys lists their ages, and the app emails the super admins from day
  25, logs `secret.stale` and shows a banner from day 30, and logs an error on every start from day 35 (an unknown age
  counts as stale).

  | Credential | Type | Where it's held | Blast radius if leaked | Rotation |
  |---|---|---|---|---|
  | `SESSION_SECRETS` | HMAC key | `.env` | forge a session for any account | new one first in the list, old one dropped after 30 days + 1 h |
  | `SEAL_KEY` | key-encrypting key | `.env` | with a database copy: the AI key, SMTP password, authenticator keys | new `SEAL_KEY` + `SEAL_KEY_OLD` for one start, then drop OLD |
  | Data keys | AES-256 keys | database, wrapped by `SEAL_KEY` | with `SEAL_KEY`: as above | automatic, every 30 days |
  | `AUDIT_HASH_KEY` | HMAC key | `.env` | link masked emails in the security log | only if leaked (no schedule – breaks linking) |
  | OpenRouter API key | API key | database, sealed (or `.env`) | spending on the OpenRouter account | Save as next, Test, Promote, revoke at OpenRouter, Test old |
  | SMTP (Gmail app) password | password | database, sealed (or `.env`) | email sent as the app's account | same, revoke at myaccount.google.com/apppasswords |
  | `GOOGLE_CLIENT_SECRET` | OAuth client secret | `.env` (only if Google sign-in is on) | impersonate the app to Google's OAuth | add a secret in Google Cloud console, restart, delete the old |
  | GitHub deploy key | SSH key | the server's `~/.ssh` | push to the repository if write-enabled | remove (the repository is public) or replace on GitHub |
  | Coach links | 256-bit bearer secret | the coach (only a hash stored) | read-only view of one account | 90-day default, reminder a week before, Renew |
  | Authenticator keys | TOTP secrets | each person's app; sealed in the database | the second sign-in step of that account | set up again |
- On HTTPS an old `logbookmonster.sid` cookie (from before the `__Host-` name) still signs in, and is replaced, for 30
  days after the first start of the version that added the limit; after that it is ignored.
- Every write needs a CSRF token header (per session; signed out, an HMAC of a random cookie).
- Google uses the OpenID Connect code flow with PKCE, `state` and `nonce`; the client secret
  stays on the server and the ID token's issuer, audience, expiry, nonce and verified email
  are checked.
- Strict Content-Security-Policy (no inline scripts), plus the usual Helmet headers.
- All data is scoped to the signed-in user; input is validated on the server.
- Storage caps per account, so one account (or a stolen session) can't fill the disk: anything stored under a
  date (days, weights, checklist ticks, supplement log, gym sets, photos, plan changes) must be a real date from
  2000-01-01 to a year after today (`server/dates.js`); saved days up to 50 MB of JSON in all, the plan history up
  to 100 changes and 10 MB, photos up to 3000 and 5 GB including thumbnails (a full one answers 413); food and
  supplement libraries 500 and 300 entries. Saves (any POST/PUT/DELETE under `/api`) are limited to 1000 per
  10 minutes per account – the tracker autosaves a changed day once you pause, far below that – photo uploads to
  6000 an hour, and the data export to 10 an hour; the export is written a section at a time, so a large account
  doesn't hold up everyone else. The disk itself still needs an alert and log rotation on the server.
- Invite links carry a random token (only its SHA-256 is stored), run out after 7 days and are
  void once used or replaced. The SMTP password is kept on the server and never sent back.
- Coach links carry a random 256-bit secret (only its SHA-256 is stored, so the link is shown once),
  answer only reads of that account's day summaries, weights, Timeline, the photos its day cards show, its meal plan
  (every dated change) and display name, are checked on
  every request against their expiry, and send `no-store`, `noindex` and `no-referrer`.
- **Security log** (`audit` table, `server/audit.js`): sign-ins (ok, failed, locked, and alerts), the second step (code
  asked, wrong code, locked, recovery code used, turned on or off, re-check passed or failed), sign-out, password changes
  (with how many sessions and coach links ended), Google links, invites made and accepted, accounts removed (and by whom),
  AI key set or cleared, email settings and Options changed, data exports, day / checklist / bulk photo deletes, shared
  foods and supplements a super admin removed, coach links made, switched off and first opened each day, and AI daily
  limits reached. Each row has the time, the account, who did it and the IP. It never holds a password, key, code, token,
  cookie or health data; emails are masked (`a***@example.com` plus a keyed hash). Rows are kept **180 days** (pruned at
  start and daily); failed sign-ins, codes and re-checks (and their alerts) are also capped at 5000 per account
  (`AUDIT_PER_ACCOUNT`), so they can't push the other rows out, which go only by age. Super admin › Security log shows it all (filter by
  event and account); everyone sees their own sign-ins, second-step events, password changes and coach-link use on
  Account admin. Failed sign-ins and locks also go to the server log (masked email, IP). `AUDIT_ALERT_FAILS` (default 5)
  failed sign-ins on a super admin account within 15 minutes email the super admins (when email is set up).
- Logs: the app never logs a request's query string, headers (`x-csrf-token`, `x-file-name`) or a coach secret – a URL in
  an error line goes through `redact()` (`/coach/REDACTED`, no query). Docker keeps 5 × 10 MB of container logs. If you turn
  on a Caddy access log, filter the same way, e.g. `log { format filter { request>uri regexp ^/coach/[^/?]+ /coach/REDACTED
  request>uri query delete  request>headers>X-Csrf-Token delete  request>headers>X-File-Name delete  request>headers>X-Photo-Note delete
  request>headers>Cookie delete } }`. Photo notes travel only in the `X-Photo-Note` header, never in the URL.

## Working on it

Changes come in as pull requests into `main`. One Claude Code session, the merge master
(`session_01Esfggck8VJzAvQMTdXhUdR`, "Logbook-monster Merge Master – Do Not Archive"), is in charge of
`main`: it checks every PR for conflicts, reviews it, runs `npm run check` on the merged result and merges.
Other sessions send their PRs to it rather than merging themselves – see `CLAUDE.md`.

## Layout

```
server/      Express app: config, auth (password + Google, two-step), API, SQLite, one file per area (gym, foods, supps, photos…)
public/      the sign-in, invite and coach pages and the app: engine.js = balancing maths and the plan in use, app.js = views,
             then a script per page (dash, foods, gym, gymcsv, supps, photos, exifdate, timeline, jobs, admin, coach, starter)
scripts/     create-user.js, smoke.js (browser smoke test)
test/        API and security tests (npm test)
```

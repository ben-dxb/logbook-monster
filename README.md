# Logbook Monster

Logbook Monster (formerly Meal Swap) is a meal-swap calculator as a self-hosted web app. Each date is its own saved day, there's a
calendar of past days, weight logged each day with a trend on the Timeline, a gym log for workouts and sets, and sign-in with email + password
or Google.

- **Daily Tracker** – the calculator, for any date. Training/rest plan follows the weekday. Every change
  saves to your account automatically; untouched days stay "plan only" until you change
  something or tap **Save day as is**. Log the day's weight at the top.
- **History** – a month calendar of logged days (calories vs target, protein, weight) with a
  month summary. Tap a day to open it.
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
  meals from ingredients; search, Show (mine / shared), Sort (A–Z, calories, protein, protein per
  calorie) and quick filters (high protein, low calorie, has recipe, AI estimates) find one, and
  your filters are remembered. **Fill blanks with AI** estimates the values you left empty from
  the name, type and recipe (OpenRouter, the super admin's key, 40 an hour per account); those values
  are flagged ⚑ and tapping a flag shows the source, workings, confidence and model. Typing your
  own number removes its flag.
- **Account admin** (everyone) – your own meal plan; nothing in it comes from anyone else's. A new
  account starts with no plan. A plan is a set of **day templates** (training day, rest day, a refeed
  day – up to 12, named as you like), each with its own meals and targets, plus your foods, which
  template each weekday uses, and whether sauces / green veg count. Add, rename, duplicate or delete
  templates and edit everything in place, or upload a plan (CSV or JSON) and download it again. Each
  change takes effect from a date you pick (today by default, or a later date to schedule it); days
  before it keep the plan they had, and **Plan changes** lists them to edit or delete. Days already
  saved keep their own amounts. On the Daily Tracker any one day can follow another template.
  **Read a PDF with AI** sends your coach's plan PDF (or a photo) to a model on OpenRouter and
  loads its day templates, meals, amounts, new foods and targets into the page for you to check and
  save (12 reads an hour per account, using the super admin's key).
  **Share with your coach** makes a link your coach opens with no password or account: your
  recent days (calories against target, macros, weight) and the Timeline – trends and each day's
  food, weight, photos, supplements and gym sets – read only. Pick how long it stays live (an hour
  to a year, or until a date); it stops at once when it runs out or you **Switch off** it.
- **Super admin** (`ADMIN_EMAILS` only; on a local setup with it empty, the first account created) – settings for
  the whole app, in tabs: **AI** (the OpenRouter API key – kept on the server, never shown again; or
  set `OPENROUTER_API_KEY` in `.env` – and a model for each kind of AI task), **People**, **Email** and **Options**
  (including **Super admins must use a second step**, off by default). Changing the AI key or the email settings,
  or removing an account, asks for your password or an authenticator code again if you signed in more than 15 minutes ago.
  There are no app-wide meal plan defaults: when this version first starts, every account that had
  used the app gets the plan it was using (the old built-in plan, the old app defaults and its own
  changes) as its own, so nothing changes for it.
- **Account menu** – download all your data as JSON, set/change password, two-step sign-in, sign out.

## Two-step sign-in (authenticator app)

Any account can add a second step: after the password (or Google), a 6-digit code from an authenticator app
(Google Authenticator, Microsoft Authenticator, 1Password, Authy… – standard TOTP, 30 seconds, SHA-1).

1. Account menu › **Two-step sign-in** › **Set up**. Add the key shown to the app as a time-based key, or tap
   **Open in authenticator app** on the phone (an `otpauth://` link). There is no QR code.
2. Type the code the app shows and press **Turn on**. Other sessions of the account are signed out.
3. **Save the 10 recovery codes** it shows (they aren't shown again). Each one signs in once in place of a code.

To switch it off, open the same box and enter your password or a code. Wrong codes count per account: 10 in
15 minutes (`ACCOUNT_FAIL_LIMIT`) and even a right code waits; a code works once.

Super admins: once your own is on, Super admin › Options › **Super admins must use a second step** sends any super
admin without it to set one up before any Super admin page works.

**Recovering:** lost the phone – sign in with a recovery code, switch the step off and set it up again on the new
phone (that also gives new recovery codes). Lost the phone *and* the codes – someone with shell access on the
server runs `npm run create-user -- you@example.com --no-2fa` (Docker: `docker compose exec logbook-monster node --disable-warning=ExperimentalWarning scripts/create-user.js you@example.com --no-2fa`),
which sets a new password, signs the account out everywhere and switches its second step off. The key is stored
encrypted with a key derived from `SESSION_SECRET`: if that changes, authenticator codes stop working (recovery codes
still do) – sign in with a recovery code and set the step up again.

## Run it locally

Needs Node.js 22.13 or newer (it uses the SQLite built into Node, so nothing needs compiling).

```bash
npm install
cp .env.example .env          # then edit .env (see below)
npm run create-user -- you@example.com   # asks for a password
npm run dev                   # http://localhost:3000
```

For local testing you can leave `SESSION_SECRET` empty – a random one is made and kept in
`data/.session-secret`, so restarts don't sign you out. Instead of `create-user`, you can put your email in `ALLOWED_EMAILS` and use
**Create an account** on the sign-in page.

Run all checks with `npm run check` (syntax, API tests, browser smoke test – the smoke test needs Playwright and skips if it is not installed).

## Settings (`.env`)

All secrets live only in `.env` on the server – nothing secret is ever sent to the browser.

| Variable | What it does |
|---|---|
| `SESSION_SECRET` | **Required in production.** Random string, 32+ characters, signs the session cookie. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `BASE_URL` | The address you open in the browser, e.g. `https://meals.example.com`. Used for the Google redirect and to turn on secure cookies/HSTS for `https://`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Turn on "Continue with Google". Leave empty to hide it. |
| `ALLOWED_EMAILS` | Comma-separated. If set, **only** these emails can sign in, and they can create their own account the first time. |
| `ALLOW_REGISTRATION` | `true` lets anyone sign up. Default `false`. |
| `ADMIN_EMAILS` | Comma-separated. Who can open the Super admin page. **Required in production** (the server won't start without it); empty on a local setup = the first account created. |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | Optional. AI import of plan PDFs. A key saved on the Super admin page wins over this one. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | Optional. The email account invites and notifications are sent from. Easier to fill in on the Super admin page (Email); settings saved there win. The server must be on the internet (no private, loopback or link-local addresses), and on a port other than 465 it must offer STARTTLS. |
| `SMTP_ALLOW_HOSTS` | Comma-separated mail servers allowed on internal addresses anyway, e.g. a relay on `127.0.0.1` (plain SMTP is allowed to a loopback one). |
| `DB_PATH` | SQLite file. Default `./data/logbook-monster.db` (an existing `./data/mealswap.db` from before the rename is used if present). A relative path is taken from the folder the server starts in. |
| `PHOTO_DIR` | Where progress photo files go. Default `photos/` next to the database. |
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
   fails, the link is shown so you can pass it on yourself. You're emailed when they join.
   Invited people can sign in even if `ALLOWED_EMAILS` doesn't list them. **Remove** deletes an
   account and all its data.

## Deploying to a server

### Docker (recommended)

```bash
cp .env.example .env    # set SESSION_SECRET, BASE_URL=https://…, ALLOWED_EMAILS, Google keys
docker compose up -d --build
docker compose exec logbook-monster node --disable-warning=ExperimentalWarning scripts/create-user.js you@example.com   # optional
```

The app listens on `127.0.0.1:3000`; data is kept in the `mealswap_mealswap-data` volume (its pre-rename name, so existing data carries over). Put a
reverse proxy with HTTPS in front – for example Caddy:

```
meals.example.com {
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
```

### Without Docker

```bash
npm ci --omit=dev
NODE_ENV=production npm start    # keep it running with systemd or pm2
```

### Backups

Everything is in one SQLite file (`data/logbook-monster.db`, or the Docker volume). Copy it while the
app is stopped, or use `sqlite3 logbook-monster.db ".backup backup.db"` while it runs. Each user can
also download their own data from the account menu.

## Security notes

- Passwords hashed with scrypt; login and Google sign-in are rate-limited per IP, and 10 wrong
  passwords for one account in 15 minutes lock it for the rest of that time (kept in SQLite, so a
  restart doesn't reset it); same response for unknown email, wrong password and a locked account.
- Sessions are server-side (SQLite), in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` on
  HTTPS); the session ID changes at sign-in and a session ends `SESSION_DAYS` (30) after sign-in
  however often it's used. Visiting signed out stores nothing on the server.
- Changing your password (or resetting it with `create-user`) signs the account out everywhere
  else, and by default switches off its coach links. A Google-only account adding a first
  password must have signed in within the last 10 minutes. Sign-out sends `Clear-Site-Data`.
- Optional second step (TOTP, RFC 6238) for any account: until the code is given the session holds no account, so
  no `/api` route answers it; it runs out after 5 minutes. The secret is stored AES-256-GCM-encrypted with a key derived
  from `SESSION_SECRET`, recovery codes only as SHA-256 hashes; each code is taken once and wrong codes are limited per
  account. Changing the AI key or the email settings, or removing an account, needs the password or a code again
  on a sign-in older than 15 minutes.
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
  answer only reads of that account's day summaries, weights, Timeline and the photos its day cards show, are checked on
  every request against their expiry, and send `no-store`, `noindex` and `no-referrer`.
- **Security log** (`audit` table, `server/audit.js`): sign-ins (ok, failed, locked, and alerts), the second step (code
  asked, wrong code, locked, recovery code used, turned on or off, re-check passed or failed), sign-out, password changes
  (with how many sessions and coach links ended), Google links, invites made and accepted, accounts removed (and by whom),
  AI key set or cleared, email settings and Options changed, data exports, day / checklist / bulk photo deletes, shared
  foods and supplements a super admin removed, coach links made, switched off and first opened each day, and AI daily
  limits reached. Each row has the time, the account, who did it and the IP. It never holds a password, key, code, token,
  cookie or health data; emails are masked (`a***@example.com` plus a keyed hash). Rows are kept **180 days** (pruned at
  start and daily), at most 5000 per account (`AUDIT_PER_ACCOUNT`). Super admin › Security log shows it all (filter by
  event and account); everyone sees their own sign-ins, second-step events, password changes and coach-link use on
  Account admin. Failed sign-ins and locks also go to the server log (masked email, IP). `AUDIT_ALERT_FAILS` (default 5)
  failed sign-ins on a super admin account within 15 minutes email the super admins (when email is set up).
- Logs: the app never logs a request's query string, headers (`x-csrf-token`, `x-file-name`) or a coach secret – a URL in
  an error line goes through `redact()` (`/coach/REDACTED`, no query). Docker keeps 5 × 10 MB of container logs. If you turn
  on a Caddy access log, filter the same way, e.g. `log { format filter { request>uri regexp ^/coach/[^/?]+ /coach/REDACTED
  request>uri query delete  request>headers>X-Csrf-Token delete  request>headers>X-File-Name delete  request>headers>Cookie delete } }`.

## Working on it

Changes come in as pull requests into `main`. One Claude Code session, the merge master
(`session_01Esfggck8VJzAvQMTdXhUdR`, "Logbook-monster Merge Master – Do Not Archive"), is in charge of
`main`: it checks every PR for conflicts, reviews it, runs `npm run check` on the merged result and merges.
Other sessions send their PRs to it rather than merging themselves – see `CLAUDE.md`.

## Layout

```
server/      Express app: config, auth (password + Google), API, SQLite
public/      login page and the app (engine.js = original calculator maths, app.js = views)
scripts/     create-user.js
test/        API and security tests (npm test)
```

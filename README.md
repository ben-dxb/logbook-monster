# Logbook Monster

Logbook Monster (formerly Meal Swap) is a meal-swap calculator as a self-hosted web app. Each date is its own saved day, there's a
calendar of past days, weight tracking with a trend chart, a gym log for workouts and sets, and sign-in with email + password
or Google.

- **Day** – the calculator, for any date. Training/rest plan follows the weekday. Every change
  saves to your account automatically; untouched days stay "plan only" until you change
  something or tap **Save day as is**. Log the day's weight at the top.
- **History** – a month calendar of logged days (calories vs target, protein, weight) with a
  month summary. Tap a day to open it.
- **Weight** – log weigh-ins, see a chart with a 7-day average, and the full list.
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
  run 12 AI reads an hour.
- **Admin** (admins only) – the baseline every new day starts from: upload a meal plan (CSV or
  JSON) or edit it in place, download it, choose which weekdays are training or rest, set day
  targets, and edit or add foods. Days already saved keep their own amounts. Admins are the
  emails in `ADMIN_EMAILS`; if that's empty, the first account created is the admin.
  **Read a PDF with AI** sends your coach's plan PDF (or a photo) to a model on OpenRouter and
  loads the meals, amounts, new foods and targets into the page for you to check and save. Add
  your OpenRouter API key on the Admin page (kept on the server, never shown again) or set
  `OPENROUTER_API_KEY` in `.env`.
- **Account menu** – download all your data as JSON, set/change password, sign out.

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
| `ADMIN_EMAILS` | Comma-separated. Who can open the Admin page. Empty = the first account created. |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | Optional. AI import of plan PDFs. A key saved on the Admin page wins over this one. |
| `DB_PATH` | SQLite file. Default `./data/logbook-monster.db` (an existing `./data/mealswap.db` from before the rename is used if present). |
| `TRUST_PROXY` | Set to `1` when running behind nginx/Caddy (default in production). |

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

- Passwords hashed with scrypt; login and Google sign-in are rate-limited; same response for
  unknown email and wrong password.
- Sessions are server-side (SQLite), in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` on
  HTTPS), and the session ID changes at sign-in.
- Every write needs a per-session CSRF token header.
- Google uses the OpenID Connect code flow with PKCE, `state` and `nonce`; the client secret
  stays on the server and the ID token's issuer, audience, expiry, nonce and verified email
  are checked.
- Strict Content-Security-Policy (no inline scripts), plus the usual Helmet headers.
- All data is scoped to the signed-in user; input is validated on the server.

## Layout

```
server/      Express app: config, auth (password + Google), API, SQLite
public/      login page and the app (engine.js = original calculator maths, app.js = views)
scripts/     create-user.js
test/        API and security tests (npm test)
```

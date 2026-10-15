# Meal Swap

The Meal Swap Calculator as a self-hosted web app. Each date is its own saved day, there's a
calendar of past days, weight tracking with a trend chart, and sign-in with email + password
or Google.

- **Day** – the calculator, for any date. Training/rest plan follows the weekday. Every change
  saves to your account automatically; untouched days stay "plan only" until you change
  something or tap **Save day as is**. Log the day's weight at the top.
- **History** – a month calendar of logged days (calories vs target, protein, weight) with a
  month summary. Tap a day to open it.
- **Weight** – log weigh-ins, see a chart with a 7-day average, and the full list.
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
| `DB_PATH` | SQLite file. Default `./data/mealswap.db`. |
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
docker compose exec mealswap node --disable-warning=ExperimentalWarning scripts/create-user.js you@example.com   # optional
```

The app listens on `127.0.0.1:3000`; data is kept in the `mealswap-data` volume. Put a
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

Everything is in one SQLite file (`data/mealswap.db`, or the Docker volume). Copy it while the
app is stopped, or use `sqlite3 mealswap.db ".backup backup.db"` while it runs. Each user can
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

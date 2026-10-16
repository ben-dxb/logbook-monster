# Logbook Monster – notes for Claude sessions

## Branches and merging

- `main` is the integration branch. Branch from the latest `main` and open your PR **into `main`**.
- Do **not** merge PRs yourself. One session is the merge master:
  **session `session_01Esfggck8VJzAvQMTdXhUdR`**. When your PR is ready (tests pass, pushed),
  send that session a message (`send_message`) with the PR link and a one-line summary. It checks
  for conflicts with `main` and with other open PRs, runs the tests and merges.
- There is no GitHub CI. `npm run check` **is** the CI: syntax check, API/security tests
  (`npm test`) and a Playwright browser smoke test (`npm run smoke`, desktop + phone, fails on
  any page error or horizontal overflow). Run it before sending your PR and say it passed; the
  merge master runs it again on the merged result before merging.
- New features should come with a test in `test/` or a step in `scripts/smoke.js`.
- Keep PRs focused on one change so they merge cleanly. If the merge master reports a conflict,
  merge `main` into your branch (no rebase/force-push), resolve, re-run tests, push, and tell it again.

## Running and testing

- Node 22.13+ (uses the built-in `node:sqlite` – don't add native modules; they break on the
  owner's Windows laptop, which has no build tools).
- `npm install`, `npm run dev` (http://localhost:3000), `npm test`.
- `npm run create-user -- you@example.com` makes a login.

## Layout

- `server/` – Express app: `config.js` (.env), `auth.js` (password + Google OIDC, CSRF),
  `api.js` (days, weights, settings, admin routes), `gym.js` (exercises, workouts, sets, AI workout import), `db.js` (SQLite schema),
  `users.js` (invites, account list), `mail.js` (SMTP sending – use `mail.notify()` for fire-and-forget notifications).
- `public/engine.js` – the original calculator data and balancing maths. Change food data and plan
  here; keep the solver behaviour unless asked.
- `public/app.js` – views (Day, History calendar, Weight), saving, routing.
- `public/gym.js` – the Gym view (workouts, exercise sets, sessions, AI import preview).
- Secrets live only in `.env` on the server; never send them to the client or commit them.
- Strict CSP: no inline scripts or `style=` attributes in HTML.

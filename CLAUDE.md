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
  Test servers set `AUTH_RATE_LIMIT=1000` so the many sign-ins in the suite don't hit the
  20-per-15-minutes sign-in limit; `test/ratelimit.test.js` checks the real default still applies.
  Test files run in parallel: get ports for test servers (and fakes) from `require('./_ports').freePorts(n)`,
  never a fixed or random range, or they collide now and then.
- Keep PRs focused on one change so they merge cleanly. If the merge master reports a conflict,
  merge `main` into your branch (no rebase/force-push), resolve, re-run tests, push, and tell it again.

## Running and testing

- Node 22.13+ (uses the built-in `node:sqlite` – don't add native modules; they break on the
  owner's Windows laptop, which has no build tools).
- `npm install`, `npm run dev` (http://localhost:3000), `npm test`.
- `npm run create-user -- you@example.com` makes a login.

## Layout

- `server/` – Express app: `config.js` (.env), `auth.js` (password + Google OIDC, CSRF),
  `api.js` (days, weights, settings, `/my/defaults` account admin and `/admin/*` super admin routes), `gym.js` (exercises, workouts, sets, AI workout import), `db.js` (SQLite schema), `defaults.js` (app defaults + each account's own layer, kept as dated changes – each day uses the one in effect on its date; `free` says whether sauces / green veg count – foods tagged `free:'sauce'|'veg'` add no macros and the solver skips them while that kind is free),
  `users.js` (invites, account list), `mail.js` (SMTP sending – use `mail.notify()` for fire-and-forget notifications).
- `public/engine.js` – the original calculator data and balancing maths. Change food data and plan
  here; keep the solver behaviour unless asked.
- `public/app.js` – views (Daily Tracker, History calendar), saving, routing. A meal marked eaten (`m.eaten`) is locked whole – the solver never moves it, its controls
  are disabled – and undoing it asks for confirmation.
- `public/admin.js` – Account admin (`#account`, anyone: own plan/week/targets/foods) and Super admin
  (`#admin`: app defaults, AI key, people, email) – one page, `.admine`/`.adapp`/`.adsuper` parts per scope.
- `public/gym.js` – the Gym view (workouts, exercise sets, sessions, AI import preview).
- `server/foods.js` / `public/foods.js` – the food library: meals and ingredients (`kind`) people enter (per 100 g/ml
  or per item) with an optional recipe, private or shared with everyone. `POST /api/foods/ai-fill` estimates blank
  values; `food.ai` records which values are AI estimates and the source shown behind the ⚑ flag. The meal plan in use is
  always listed too (`fPlanFoods` in `foods.js`, built in the browser, never stored): its meals (`plan:m:…`) and foods (`plan:f:<food id>`). Starter foods (`public/starter.js`, `std:<id>`) are listed
  for everyone the same way. `state` (raw/cooked) + `yield` (cooked weight as % of raw) let `fShown` show a food either way. "Add to plan" puts
  one in a meal or a day's off-plan list. Inside meals a library food is a calculator food with id `L:<id>:<hash of its
  values>`; each day keeps a copy in `D.lib` so old days still load after the food changes (`libRegister`/`libSync` in `app.js`).
- `server/supps.js` / `public/supps.js` – supplements: a library (usual amount + unit, private or shared, like foods) and a
  per-day log (`#supps`), each entry picked from the library or typed as free text, with an amount and a unit (g, mg, mcg, IU…).
- `server/photos.js` / `public/photos.js` – progress photos (`#photos`): each account's own pictures with a date, pose and note,
  shown by date (filter by pose or by bodyweight near a chosen weight, jump to a date) and side by side
  (`#photos/compare/<id>/<id>`, two photos picked in the catalog; "Find one at N kg" swaps in the closest-weight photo). The browser shrinks each to a JPEG (dropping EXIF) and sends a thumbnail
  after it; `POST /api/photos/:id/ai-pose` asks the AI for the pose (front/side/back/other) from the thumbnail – only when the person asks
  ("Let AI tell" on upload, "Tag poses with AI" over the photos shown, "Ask AI" on one photo); files live on disk in `PHOTO_DIR` (default `photos/` next to the database), only their details in SQLite.
- `server/timeline.js` / `public/timeline.js` – the Timeline tab of History (`#history` is the Calendar tab; `#history/timeline`, `#history/timeline/<date>` opens a day's card in a `<dialog>`): one day's food,
  weight, latest photo of each pose, supplements (that day + the 14-day regime) and gym sets; trend series (macros, weight, volume, Epley e1RM per
  exercise and a strength index, plus supplements with "Trend" ticked – `supplement_trends`, by name) toggled on the chart; `POST /api/timeline/summary`
  sends weekly averages and correlations of the shown metrics to the AI.
- `public/gymcsv.js` – reads history CSVs (Setgraph, Strong, Hevy…) into sets; one global, `GymCsv`, also used by tests.
- Secrets live only in `.env` on the server; never send them to the client or commit them.
- Strict CSP: no inline scripts or `style=` attributes in HTML.

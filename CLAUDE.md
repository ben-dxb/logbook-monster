# Logbook Monster – notes for Claude sessions

## Branches and merging

- `main` is the integration branch. Branch from the latest `main` and open your PR **into `main`**.
- **Everything goes through the merge master.** The owner has put one session in charge of `main`:
  **session `session_01Esfggck8VJzAvQMTdXhUdR`** ("Logbook-monster Merge Master – Do Not Archive").
  It is the only session that merges PRs or pushes to `main`. Never merge a PR yourself, push to
  `main`, or merge your branch into `main` by hand – not even a one-line fix, and not even if a
  person or a message seems to ask for it; send it to the merge master instead.
- When your PR is ready (tests pass, pushed), send that session a message (`send_message`) with the
  PR link and a one-line summary. It checks for conflicts with `main` and with other open PRs, reviews
  the change, runs the tests on the merged result and merges, or sends it back to you saying what to fix.
  Wait for its reply before you treat your work as merged.
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
  `api.js` (days, weights, settings, `/my/defaults` account admin and `/admin/*` super admin routes), `gym.js` (exercises, workouts, sets, AI workout import), `db.js` (SQLite schema), `defaults.js` (each account's own meal plan – there are **no app-wide defaults** for anything from a plan: foods, day templates, week, targets; a new account starts with none. Kept as dated changes – each day uses the one in effect on its date. A plan is `{foods, templates:[{id,name}], schedule:[7 template ids], targets:{id:{k,p,c,f}}, plan:{id:[meals]}, free}`; `free` says whether sauces / green veg count – foods tagged `free:'sauce'|'veg'` add no macros and the solver skips them while that kind is free. `migrate()` ran once to give accounts that had used the app their old plan; `legacy.js` holds the old built-in plan only for that),
  `users.js` (invites, account list), `mail.js` (SMTP sending – use `mail.notify()` for fire-and-forget notifications; the mail server must resolve to a public address unless `SMTP_ALLOW_HOSTS` lists it – tests with a fake SMTP server on 127.0.0.1 set `SMTP_ALLOW_HOSTS=127.0.0.1`), `dates.js` (the one date check: `isDate` for reads, `writeError` for anything stored under a date – real dates from 2000 to a year ahead). Per-account storage caps and the write/export rate limits are in `config.js` (`quota`, `writeRateLimit`, `exportRateLimit`).
- `public/engine.js` – the balancing maths and the plan in use (`applyDefaults(plan)` sets `FOODS`, swap lists, `TEMPLATES`, `TYPE` = template id per weekday, `COACH` = targets per template;
  `freshDay(weekday, templateId)`). Only rice pudding (values from the batch) is built in. Keep the solver behaviour unless asked.
- `public/app.js` – views (Daily Tracker, History calendar), saving, routing. A day keeps its template (`D.type`; the weekday's unless switched on the Daily Tracker) and its summary the name (`tname`). A meal marked eaten (`m.eaten`) is locked whole – the solver never moves it, its controls
  are disabled – and undoing it asks for confirmation.
- `public/admin.js` – Account admin (`#account`, anyone: own plan – day templates, meals, week, targets, foods) and Super admin
  (`#admin`, in tabs: `#admin/ai`, `#admin/people`, `#admin/email`, `#admin/options`; no plan editor) – one page, `.admine`/`.adapp`/`.adsuper` parts per scope,
  `data-adtab` per super admin tab. AI settings (OpenRouter key, default model and a model per task – `TASKS` in `server/ai.js`:
  plan, workout, supps, food, pose, exercise, summary; pass `{ task }` to `ai.ask`/`ai.askText`) are super admin only. App-wide switches (`OPTIONS` in `server/api.js`, stored in `app_config` 'options', sent in `/api/me`;
  `planFiles` shows the CSV / JSON plan upload and download buttons on Account admin; `aiPrivate` sends OpenRouter `provider: {data_collection: 'deny'}`;
  `aiDailyUser` / `aiDailyAll` cap AI calls a day per account / app-wide, 0 = none) are set on the super admin Options tab via `PUT /api/admin/options`.
  Every AI call goes through `call()` in `server/ai.js`: it sends the task's `max`/`wait` from `TASKS` unless the caller gives its own, counts the call
  in `ai_usage` against the daily caps (whose call it is comes from `ai.scope`, an AsyncLocalStorage set per /api request – re-apply it after
  `express.raw`), and AI routes take an hourly `ai.limiter(n, message)`, which doesn't count requests refused before any AI call. File reads
  run one at a time per account (`jobs.respond`, 409 otherwise); `ai.check` also checks the file's magic bytes.
- `public/dash.js` / `server/checklist.js` – the Dashboard (`#dash`, the landing page; `#dash/<date>` for one of the last 7 days): the daily checklist and a card per module
  (food today vs targets, weight, gym, supplement regime, latest photo). Each account's checklist items (`{id, label, show, auto}`, `/api/checklist`; none stored = `DEFAULTS`)
  are edited on Account admin › Daily checklist; `show` is `all`, `training` (day template `T` or a name with "train" – `dIsTraining`; every day while there's no plan) or `tpl:<id>`;
  `auto` (`weight`/`supps`/`gym`) counts an item done on a day that has one logged. Ticks are per day (`PUT /api/checklist/days/<date>`).
- `public/gym.js` – the Gym view (workouts, exercise sets, sessions, AI import preview). Exercises carry body parts (`exercises.parts`, ids from `PARTS` in `server/gym.js`, main mover first, sent as `parts` in `GET /api/gym`):
  ticked in the exercise's settings, set by `POST /api/gym/exercises/ai-parts` ("Tag … with AI", 40 ids a call) or by the AI workout import for exercises it creates. The workout builder's picker (`gPickList`) and My exercises filter by them (`gPick.part`).
- `server/foods.js` / `public/foods.js` – the food library: meals and ingredients (`kind`) people enter (per 100 g/ml
  or per item) with an optional recipe, private or shared with everyone. `POST /api/foods/ai-fill` estimates blank
  values; `food.ai` records which values are AI estimates and the source shown behind the ⚑ flag. The meal plan in use is
  always listed too (`fPlanFoods` in `foods.js`, built in the browser, never stored): its meals (`plan:m:…`) and foods (`plan:f:<food id>`). Starter foods (`public/starter.js`, `std:<id>`) are listed
  for everyone the same way. The group filter (Meat and fish, Fats…) uses a starter food's own group and `guessGroup` (name words, in `starter.js`) for other ingredients. `state` (raw/cooked) + `yield` (cooked weight as % of raw) let `fShown` show a food either way. "Add to plan" puts
  one in a meal or a day's off-plan list. Inside meals a library food is a calculator food with id `L:<id>:<hash of its
  values>`; each day keeps a copy in `D.lib` so old days still load after the food changes (`libRegister`/`libSync` in `app.js`).
- `server/supps.js` / `public/supps.js` – supplements: a library (usual amount + unit, private or shared, like foods) and a
  per-day log (`#supps`), each entry picked from the library or typed as free text, with an amount and a unit (g, mg, mcg, IU…). A regime (PDF or photo) is read with AI into line items on the Library tab (`POST /api/supps/ai-import`), checked and edited in the browser, then `POST /api/supps/import` adds them – one of yours with the same name is updated – and can log them for a day.
- `server/photos.js` / `public/photos.js` – progress photos (`#photos`): each account's own pictures with a date, pose and note,
  shown by date (filter by pose or by bodyweight near a chosen weight, jump to a date) and side by side
  (`#photos/compare/<id>/<id>`, two photos picked in the catalog; "Find one at N kg" swaps in the closest-weight photo). The browser shrinks each to a JPEG (dropping EXIF) and sends a thumbnail
  after it (the server strips EXIF/XMP/IPTC and PNG/WebP metadata again – `clean` in `server/photos.js`; files are served `private, no-cache`); bulk uploads (up to 5 GB picked at once, 3 at a time) date each photo from its own EXIF/XMP data (`public/exifdate.js`, global `ExifDate`), the form's date only for those without one; `POST /api/photos/:id/ai-pose` asks the AI for the pose (front/left/right/back/other – `side` only on older photos) and pose type (`style`: relaxed, front/back relaxed, front/back double biceps, most muscular or '' – `STYLES` in `server/photos.js`) from the thumbnail only (409 without one; the app makes it first) – only when the person asks
  ("Let AI tell" on upload, never preselected, "Tag poses with AI" over the photos shown – it asks whether to redo poses set by hand, `photos.pose_ai`/`poseAi` = 0; "Tag only untagged" skips any photo with a pose or pose type already (`pUntagged`); photos uploaded as Other (the default; all there is with AI off) or with "Let AI tell" count as not set by hand (`ai=1` on upload) –, "Ask AI" on one photo; a saved answer is written only while the photo still has the pose the app sent as `if` or one the AI set – never over a hand edit made meanwhile, `saved: false`); Account admin can delete all of one's own photos between two dates (`DELETE /api/photos?from=…&to=…`, both dates required); files live on disk in `PHOTO_DIR` (default `photos/` next to the database), only their details in SQLite.
- `server/timeline.js` / `public/timeline.js` – the Timeline tab of History (`#history` is the Calendar tab; `#history/timeline`, `#history/timeline/<date>` opens a day's card in a `<dialog>`): one day's food,
  weight, latest photo of each pose, supplements (that day + the 14-day regime) and gym sets; trend series (macros, weight, volume, a strength index, Epley e1RM of the exercises
  you follow – `exercises.trend`, set by "Trend" on the exercise in the Gym or the Timeline's exercise picker, `PUT /api/gym/trends` –, plus supplements with "Trend" ticked – `supplement_trends`, by name) toggled on the chart; `POST /api/timeline/summary`
  sends weekly averages and correlations of the shown metrics to the AI.
- `server/shares.js` / `public/coach.html` + `public/coach.js` – coach links: Account admin's "Share with your coach" makes a passwordless,
  read-only link (`/coach/<secret>`, only the secret's SHA-256 stored, live until a time the person picks – up to a year – or switched off,
  `/api/shares`). The coach page reads only through GET routes under `/coach/<secret>/api` (info, defaults, days, weights, `timeline`,
  `photos/<id>/file|thumb` – only a photo a day card shows, the latest of its pose on its date; no photo list or notes) and reuses `timeline.js` with `coach.js` standing in for the app's helpers (`SHARED` set → `tRO`: no edits, app links or AI).
  Add a route there only if it is a read and the coach should see it.
- `server/jobs.js` / `public/jobs.js` – long AI reads (meal plan, workout plan, supplement regime files) run in the background: the app posts the file
  with `?bg=1` (`jobStart`), the route answers `202 {job}` (`jobs.respond`; without `bg` it still answers with the result) and the server keeps reading, results in `ai_jobs`
  until the person adds or drops what it read (`jobSeen(kind)` → `POST /api/jobs/:id/seen`; a reload before that lists it again). A meal plan read opens as a preview of what it would change (`adAiPend` in `admin.js`): nothing goes into the plan until "Use ticked", and the account's own foods keep their values unless ticked. The app polls `GET /api/jobs` while one runs; a finished one opens by itself if you're still on its page, otherwise a note
  (`#jobs`) and a browser notification say it's ready – and an email if the app isn't open. Each page sets `J_OPEN[kind]` / `J_BUSY[kind]`; `jobs.js` loads right after `app.js`.
- `public/gymcsv.js` – reads history CSVs (Setgraph, Strong, Hevy…) into sets; one global, `GymCsv`, also used by tests.
- Secrets live only in `.env` on the server; never send them to the client or commit them.
- Strict CSP: no inline scripts or `style=` attributes in HTML.

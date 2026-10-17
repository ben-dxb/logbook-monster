'use strict';
/* Calendar dates (YYYY-MM-DD) for every route that takes one. isDate is strict: 2026-02-31 and 2026-13-01 are not dates.
   Anything stored under a date (days, weights, checklist ticks, supplement log, gym sets, photos) must also fall in the
   window – 2000-01-01 to a year after today – so one account can't spread rows over millions of dates. Reads and deletes
   take any real date, so rows saved before the window existed can still be opened and removed. Rows saved under impossible
   dates before this check move to their real date at start (db.js); one that can't stays deletable under its stored key. */
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const FIRST = '2000-01-01';
const isDate = s => typeof s === 'string' && DATE_RE.test(s) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
/* a day of slack for time zones ahead of UTC */
const lastDate = () => { const d = new Date(Date.now() + 864e5); d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); };
const inWindow = s => isDate(s) && s >= FIRST && s <= lastDate();
const WINDOW_MSG = 'Pick a date from 2000 to a year from today';
/* '' when a date may be stored, else what to tell the person */
const writeError = (s, bad = 'Bad date') => (inWindow(s) ? '' : isDate(s) ? WINDOW_MSG : bad);

/* "Today" is the person's date, not the server's: the app sends its time zone (x-time-zone, e.g. Asia/Dubai) with each
   request and req.today is that zone's date (server/api.js). Without a usable zone, the server's UTC date. Stored
   timestamps stay UTC. */
const ZONE_RE = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/;
function todayIn(zone, now = new Date()) {
  if (typeof zone === 'string' && zone.length <= 64 && ZONE_RE.test(zone)) {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(now).map(x => [x.type, x.value]));
      const d = `${p.year}-${p.month}-${p.day}`;
      if (isDate(d)) return d;
    } catch {}
  }
  return now.toISOString().slice(0, 10);
}

module.exports = { isDate, inWindow, writeError, lastDate, todayIn, FIRST, WINDOW_MSG };

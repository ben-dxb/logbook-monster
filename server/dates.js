'use strict';
/* Calendar dates (YYYY-MM-DD) for every route that takes one. isDate is strict: 2026-02-31 and 2026-13-01 are not dates.
   Anything stored under a date (days, weights, checklist ticks, supplement log, gym sets, photos) must also fall in the
   window – 2000-01-01 to a year after today – so one account can't spread rows over millions of dates. Reads and deletes
   take any real date, so rows saved before the window existed can still be opened and removed. */
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const FIRST = '2000-01-01';
const isDate = s => typeof s === 'string' && DATE_RE.test(s) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
/* a day of slack for time zones ahead of UTC */
const lastDate = () => { const d = new Date(Date.now() + 864e5); d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); };
const inWindow = s => isDate(s) && s >= FIRST && s <= lastDate();
const WINDOW_MSG = 'Pick a date from 2000 to a year from today';
/* '' when a date may be stored, else what to tell the person */
const writeError = (s, bad = 'Bad date') => (inWindow(s) ? '' : isDate(s) ? WINDOW_MSG : bad);

module.exports = { isDate, inWindow, writeError, lastDate, FIRST, WINDOW_MSG };

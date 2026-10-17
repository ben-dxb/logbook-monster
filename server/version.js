'use strict';
/* Saves from two tabs or devices. A record's version is its updated time (stamp(): UTC to the millisecond, never the same
   twice). The app sends the version it loaded in the x-version header ('none' when it had none – a day not saved yet, the
   default checklist); a save over a different stored version is refused with 409 and nothing changes. A request without the
   header (an older client) isn't checked. */
const MSG = 'This changed in another tab or device – reload to see it';
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
const msOf = s => Date.parse(s.replace(' ', 'T') + 'Z');
let last = '';
function stamp() {
  let s = iso(Date.now());
  if (s <= last) s = iso(msOf(last) + 1);
  return (last = s);
}
const conflict = () => Object.assign(new Error(MSG), { status: 409 });
/* true when the request was made on another version than `current` (null = no record) */
function stale(req, current) {
  const v = req.get('x-version');
  if (v === undefined) return false;
  return (v === 'none' ? null : v) !== (current == null ? null : String(current));
}
function check(req, current) { if (stale(req, current)) throw conflict(); }

module.exports = { MSG, stamp, stale, check, conflict };

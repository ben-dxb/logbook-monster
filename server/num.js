'use strict';
/* A number sent by the app: a JSON number or a numeric string ("82.5"). Anything else – "", "80e", null, true, [82], {} – isn't
   one, so routes refuse it with 400 rather than reading it as 0 (or as a blank that deletes something). */
const isNum = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(+v);

module.exports = { isNum };

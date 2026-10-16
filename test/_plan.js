'use strict';
/* A whole plan for engine tests: the plan the app used to ship with (server/legacy.js), as an account's own plan. */
const legacy = require('../server/legacy');
module.exports = (mine = {}) => legacy.effective({}, mine);

/* /api/v1/snapshot — the entire financial picture in one call (read-only) */
"use strict";
const { makeEndpoint } = require("./_lib");

// Returns the full precomputed snapshot: summary, bills, credit cards, payment
// calendar, goals, debt plan — everything the five focused endpoints slice from.
module.exports = makeEndpoint(s => Object.assign({}, s));

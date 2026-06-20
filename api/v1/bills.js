/* /api/v1/bills — every recurring bill / debt with payoff + due info (read-only) */
"use strict";
const { makeEndpoint } = require("./_lib");

module.exports = makeEndpoint(s => ({
  bills: s.bills || [],
}));

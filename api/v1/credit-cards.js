/* /api/v1/credit-cards — credit cards only, with utilization + report timing (read-only) */
"use strict";
const { makeEndpoint } = require("./_lib");

// Cards are bills typed "Credit Card Debt" in the app.
module.exports = makeEndpoint(s => ({
  overallUtilizationPct: s.overallUtilizationPct,
  reportLeadDays: s.reportLeadDays,
  cards: (s.bills || []).filter(b => b.type === "Credit Card Debt"),
}));

/* /api/v1/payment-calendar — per-payday schedule of bills, extra debt, goals (read-only) */
"use strict";
const { makeEndpoint } = require("./_lib");

module.exports = makeEndpoint(s => ({
  paydays: s.paymentCalendar || [],
}));

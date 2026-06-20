/* /api/v1/debts — balances owed, APRs, payoff timelines + plan (read-only) */
"use strict";
const { makeEndpoint } = require("./_lib");

// Anything carrying a balance is a debt; surface payoff-relevant fields and the
// extra-payment plan that targets credit cards.
module.exports = makeEndpoint(s => ({
  payoffMethod: s.payoffMethod,
  debtPlan: s.debtPlan,
  debts: (s.bills || [])
    .filter(b => Number(b.remainingBalance) > 0)
    .map(b => ({
      name: b.name,
      type: b.type,
      remainingBalance: b.remainingBalance,
      aprPct: b.aprPct,
      monthlyPayment: b.monthlyPayment,
      payoffMonths: b.payoffMonths,
      creditLimit: b.creditLimit,
      utilizationPct: b.utilizationPct,
    })),
}));

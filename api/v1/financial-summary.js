/* /api/v1/financial-summary — top-line money picture (read-only) */
"use strict";
const { makeEndpoint } = require("./_lib");

module.exports = makeEndpoint(s => ({
  plan: s.plan,
  income: s.income,
  monthlyPayments: s.monthlyPayments,
  leftover: s.leftover,
  monthlyLivingExpenses: s.monthlyLivingExpenses,
  monthlySavingsBudget: s.monthlySavingsBudget,
  payoffMethod: s.payoffMethod,
  emergencyFund: s.emergencyFund,
  goals: s.goals,
  debtPlan: s.debtPlan,
  overallUtilizationPct: s.overallUtilizationPct,
}));

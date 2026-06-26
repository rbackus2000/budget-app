/* ------------------------------------------------------------------ *
 *  /api/plaid/refresh — pull fresh balances, liabilities & spending    *
 *                                                                     *
 *  Owner-only. For each connected Item: reads account balances, credit *
 *  liabilities (APR/limit/min/due), and syncs transactions (storing    *
 *  the cursor). Returns normalized data the app maps onto bills + bank *
 *  balance. Access tokens stay server-side; only derived data returns. *
 * ------------------------------------------------------------------ */
"use strict";
const { sendJSON, verifyUser, plaid, listItems, saveCursor, PLAID_ENV } = require("./_plaid");

const num = v => (typeof v === "number" && isFinite(v) ? v : 0);

// Pull the most relevant APR (purchase) for a credit liability.
function purchaseApr(credit) {
  const aprs = (credit && credit.aprs) || [];
  const p = aprs.find(a => a.apr_type === "purchase_apr");
  return p ? num(p.apr_percentage) : (aprs[0] ? num(aprs[0].apr_percentage) : 0);
}

// Sync all transactions for one item, paging until caught up. Returns the
// accumulated added/modified plus the final cursor. Tolerates a not-yet-ready
// product on a freshly linked item.
async function syncTransactions(accessToken, startCursor) {
  let cursor = startCursor || null;
  const added = [];
  try {
    for (let i = 0; i < 20; i++) { // safety cap on pages
      const body = { access_token: accessToken, count: 250 };
      if (cursor) body.cursor = cursor;
      const r = await plaid("/transactions/sync", body);
      (r.added || []).forEach(t => added.push(t));
      (r.modified || []).forEach(t => added.push(t));
      cursor = r.next_cursor;
      if (!r.has_more) break;
    }
  } catch (e) {
    const code = e && e.plaid && e.plaid.error_code;
    if (code !== "PRODUCT_NOT_READY") throw e; // genuinely failed
    // else: transactions still initializing — return what we have, keep cursor
  }
  return { added, cursor };
}

// Convert a recurring stream's amount to a monthly-equivalent figure.
function monthlyize(amount, frequency) {
  const f = String(frequency || "").toUpperCase();
  const mult = f === "WEEKLY" ? 4.333 : f === "BIWEEKLY" ? 2.1667 : f === "SEMI_MONTHLY" ? 2
    : f === "MONTHLY" ? 1 : f === "ANNUALLY" ? 1 / 12 : 1;
  return +(Math.abs(num(amount)) * mult).toFixed(2);
}

// Normalize one recurring stream (inflow = income, outflow = recurring bill).
function normStream(s, institution) {
  const avg = (s.average_amount && s.average_amount.amount) != null ? s.average_amount.amount
    : (s.last_amount && s.last_amount.amount);
  return {
    name: s.merchant_name || s.description || "Recurring",
    monthly: monthlyize(avg, s.frequency),
    lastAmount: s.last_amount ? num(s.last_amount.amount) : null,
    frequency: s.frequency || null,
    lastDate: s.last_date || null,
    nextDate: s.predicted_next_date || null,
    category: (s.personal_finance_category && s.personal_finance_category.primary) || null,
    institution: institution || null,
  };
}

// Detect recurring inflow (paychecks) and outflow (bills) for one item.
// Returns active streams only; tolerates a not-yet-ready transactions product.
async function getRecurring(accessToken) {
  try {
    const r = await plaid("/transactions/recurring/get", { access_token: accessToken });
    const active = arr => (arr || []).filter(s => s.is_active !== false);
    return { inflow: active(r.inflow_streams), outflow: active(r.outflow_streams) };
  } catch (e) {
    const code = e && e.plaid && e.plaid.error_code;
    if (code !== "PRODUCT_NOT_READY") console.error("recurring/get", code || (e && e.message));
    return { inflow: [], outflow: [] };
  }
}

// Build a compact spending summary from positive (outflow) transactions,
// excluding transfers and loan/credit-card payments so it reflects real spend.
function spendingSummary(txns) {
  const SKIP = /^(TRANSFER_IN|TRANSFER_OUT|LOAN_PAYMENTS|BANK_FEES)$/;
  const byCat = {};
  let total = 0, count = 0;
  const months = new Set();
  txns.forEach(t => {
    const amt = num(t.amount); // Plaid: positive = money out
    if (amt <= 0) return;
    const cat = (t.personal_finance_category && t.personal_finance_category.primary) || "OTHER";
    if (SKIP.test(cat)) return;
    byCat[cat] = (byCat[cat] || 0) + amt;
    total += amt; count++;
    if (t.date) months.add(String(t.date).slice(0, 7)); // YYYY-MM
  });
  // Monthly figures use the actual span of data so they're right whether the
  // history window is 90 or 180 days.
  const m = Math.max(1, months.size);
  const byCategory = Object.keys(byCat)
    .map(k => ({ category: k, amount: +byCat[k].toFixed(2), monthly: +(byCat[k] / m).toFixed(2) }))
    .sort((a, b) => b.amount - a.amount);
  return { total: +total.toFixed(2), monthly: +(total / m).toFixed(2), months: m, count, byCategory };
}

// Sum of currently-pending OUTFLOWS per account, from a short recent window via
// /transactions/get (which returns the full window every call, unlike the
// incremental /transactions/sync). Lets us estimate `available` when a bank
// (e.g. Capital One) returns it as null: available ≈ current − pending holds.
async function pendingOutflowByAccount(accessToken) {
  const out = {};
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 14 * 24 * 3600 * 1000);
    const ymd = d => d.toISOString().slice(0, 10);
    const r = await plaid("/transactions/get", {
      access_token: accessToken,
      start_date: ymd(start), end_date: ymd(end),
      options: { count: 500, offset: 0 },
    });
    const txns = r.transactions || [];
    const pend = txns.filter(t => t.pending);
    // Diagnostic: is Capital One sending pending txns, or is this endpoint empty?
    console.log("pending probe: total_transactions=" + (r.total_transactions != null ? r.total_transactions : "?") +
      " returned=" + txns.length + " pending=" + pend.length +
      (pend.length ? " sample=" + JSON.stringify(pend.slice(0, 3).map(t => ({ amt: t.amount, name: t.merchant_name || t.name, date: t.date }))) : ""));
    txns.forEach(t => {
      if (!t.pending) return;
      const amt = num(t.amount); // Plaid: positive = money out (a hold)
      if (amt > 0) out[t.account_id] = (out[t.account_id] || 0) + amt;
    });
  } catch (e) {
    console.error("pending probe failed:", (e && e.plaid && e.plaid.error_code) || (e && e.message));
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET")
    return sendJSON(res, 405, { error: "Method not allowed" });
  const user = await verifyUser(req.headers && req.headers.authorization);
  if (!user) return sendJSON(res, 401, { error: "Sign in to sync your bank." });

  let items;
  try { items = await listItems(user.id); }
  catch (e) { console.error("refresh listItems", e && e.message); return sendJSON(res, 502, { error: "Could not read connected banks." }); }
  if (!items.length) return sendJSON(res, 200, { connected: false, accounts: [], cards: [], spending: null });

  const accounts = [];
  const cards = [];
  let allTxns = [];
  const incomeStreams = [];   // recurring inflow = paychecks / jobs
  const recurringBills = [];  // recurring outflow = AT&T, utilities, subscriptions
  const recurringIds = new Set(); // txn ids belonging to recurring streams (to isolate variable spend)

  const itemErrors = [];
  for (const it of items) {
    try {
      // Balances (+ credit liabilities when that product is enabled). Liabilities
      // supplies APR / limit / min / due / statement day; without it (Transactions
      // only), fall back to /accounts/balance/get so the sync still returns
      // balances. Use /accounts/balance/get (not /accounts/get) because it forces
      // a fresh pull that populates `available` — the spendable balance that
      // already nets out pending transactions. /accounts/get returns cached
      // balances where `available` is often null, which made the bank total fall
      // back to `current` (overstated by pending charges).
      let accountsRaw, creditByAccount = {};
      try {
        const liab = await plaid("/liabilities/get", { access_token: it.accessToken });
        accountsRaw = liab.accounts || [];
        (((liab.liabilities || {}).credit) || []).forEach(c => { creditByAccount[c.account_id] = c; });
      } catch (le) {
        const lc = le && le.plaid && le.plaid.error_code;
        if (["INVALID_PRODUCT", "PRODUCTS_NOT_SUPPORTED", "NO_LIABILITY_ACCOUNTS", "PRODUCT_NOT_READY"].indexOf(lc) >= 0) {
          const acc = await plaid("/accounts/balance/get", { access_token: it.accessToken });
          accountsRaw = acc.accounts || [];
        } else { throw le; }
      }

      // When the bank reports no `available` (Capital One does this), estimate
      // the spendable balance as current minus pending holds.
      const pendingAcct = await pendingOutflowByAccount(it.accessToken);

      accountsRaw.forEach(a => {
        const bal = a.balances || {};
        let available = bal.available == null ? null : num(bal.available);
        let availableEstimated = false;
        if (available == null && a.type === "depository") {
          const pend = pendingAcct[a.account_id];
          if (pend != null && pend >= 0.01) { available = +(num(bal.current) - pend).toFixed(2); availableEstimated = true; }
        }
        accounts.push({
          name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
          balance: num(bal.current), available: available, availableEstimated: availableEstimated,
          limit: bal.limit == null ? null : num(bal.limit),
          institution: it.institutionName || null,
        });
        if (a.type === "credit") {
          const c = creditByAccount[a.account_id] || {};
          // Statement closing day = day-of-month of the last statement issue date.
          const stmtDay = c.last_statement_issue_date
            ? parseInt(String(c.last_statement_issue_date).slice(8, 10), 10) || null
            : null;
          cards.push({
            accountId: a.account_id, name: a.name, mask: a.mask,
            balance: num(bal.current),
            limit: bal.limit == null ? null : num(bal.limit),
            aprPct: purchaseApr(c),
            minPayment: c.minimum_payment_amount == null ? null : num(c.minimum_payment_amount),
            dueDate: c.next_payment_due_date || null,
            statementDay: stmtDay,
            lastStatementBalance: c.last_statement_balance == null ? null : num(c.last_statement_balance),
            isOverdue: !!c.is_overdue,
            institution: it.institutionName || null,
          });
        }
      });

      // Transactions (spending). Persist the new cursor so next sync is incremental.
      const { added, cursor } = await syncTransactions(it.accessToken, it.cursor);
      allTxns = allTxns.concat(added);
      if (cursor && cursor !== it.cursor) { try { await saveCursor(user.id, it.itemId, cursor); } catch (e) {} }

      // Classify recurring streams: inflow = income (jobs), outflow = bills.
      const rec = await getRecurring(it.accessToken);
      rec.inflow.forEach(s => incomeStreams.push(normStream(s, it.institutionName)));
      rec.outflow.forEach(s => {
        recurringBills.push(normStream(s, it.institutionName));
        (s.transaction_ids || []).forEach(id => recurringIds.add(id));
      });
    } catch (e) {
      // One bad item (e.g. a stale sandbox token after switching to production,
      // or a bank needing re-auth) shouldn't sink the whole sync — skip it.
      console.error("refresh item failed", it.itemId, e && e.message, e && e.plaid);
      itemErrors.push({ item: it.itemId, code: (e && e.plaid && e.plaid.error_code) || "error" });
    }
  }

  // Only hard-fail if every item failed and nothing came back.
  if (!accounts.length && itemErrors.length) {
    return sendJSON(res, 502, { error: "Could not refresh bank data.", itemErrors });
  }

  const bankTotal = accounts
    .filter(a => a.type === "depository")
    .reduce((s, a) => s + (a.available != null ? a.available : a.balance), 0);

  const recent = allTxns
    .filter(t => !t.pending)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 50)
    .map(t => ({
      date: t.date, name: t.merchant_name || t.name, amount: num(t.amount),
      category: (t.personal_finance_category && t.personal_finance_category.primary) || null,
    }));

  // "Other spending" = outflow that isn't a recurring bill (Walmart one-offs).
  const variableTxns = allTxns.filter(t => !recurringIds.has(t.transaction_id));
  const sumMonthly = list => +(list.reduce((s, x) => s + num(x.monthly), 0)).toFixed(2);

  return sendJSON(res, 200, {
    connected: true,
    env: PLAID_ENV, // "production" once the env flip is live; "sandbox" otherwise
    bank: +bankTotal.toFixed(2),
    accounts,
    cards,
    // Classified buckets: income (jobs) vs recurring bills (AT&T) vs other spend.
    income: { monthly: sumMonthly(incomeStreams), streams: incomeStreams },
    recurringBills: { monthly: sumMonthly(recurringBills), streams: recurringBills },
    variableSpending: spendingSummary(variableTxns), // Walmart-type one-offs
    spending: spendingSummary(allTxns),              // total outflow (drives living expenses)
    transactions: recent,
    syncedAt: new Date().toISOString(),
    itemErrors: itemErrors.length ? itemErrors : undefined,
  });
};

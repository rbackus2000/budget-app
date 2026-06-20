/* ------------------------------------------------------------------ *
 *  /api/plaid/refresh — pull fresh balances, liabilities & spending    *
 *                                                                     *
 *  Owner-only. For each connected Item: reads account balances, credit *
 *  liabilities (APR/limit/min/due), and syncs transactions (storing    *
 *  the cursor). Returns normalized data the app maps onto bills + bank *
 *  balance. Access tokens stay server-side; only derived data returns. *
 * ------------------------------------------------------------------ */
"use strict";
const { sendJSON, verifyUser, plaid, listItems, saveCursor } = require("./_plaid");

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

// Build a compact spending summary from positive (outflow) transactions,
// excluding transfers and loan/credit-card payments so it reflects real spend.
function spendingSummary(txns) {
  const SKIP = /^(TRANSFER_IN|TRANSFER_OUT|LOAN_PAYMENTS|BANK_FEES)$/;
  const byCat = {};
  let total = 0, count = 0;
  txns.forEach(t => {
    const amt = num(t.amount); // Plaid: positive = money out
    if (amt <= 0) return;
    const cat = (t.personal_finance_category && t.personal_finance_category.primary) || "OTHER";
    if (SKIP.test(cat)) return;
    byCat[cat] = (byCat[cat] || 0) + amt;
    total += amt; count++;
  });
  const byCategory = Object.keys(byCat)
    .map(k => ({ category: k, amount: +byCat[k].toFixed(2) }))
    .sort((a, b) => b.amount - a.amount);
  return { total: +total.toFixed(2), count, byCategory };
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

  try {
    for (const it of items) {
      // Balances + credit liabilities in one /liabilities/get (includes accounts).
      const liab = await plaid("/liabilities/get", { access_token: it.accessToken });
      const creditByAccount = {};
      (((liab.liabilities || {}).credit) || []).forEach(c => { creditByAccount[c.account_id] = c; });

      (liab.accounts || []).forEach(a => {
        const bal = a.balances || {};
        accounts.push({
          name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
          balance: num(bal.current), available: bal.available == null ? null : num(bal.available),
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
    }
  } catch (e) {
    console.error("refresh pull error", e && e.message, e && e.plaid);
    return sendJSON(res, 502, { error: "Could not refresh bank data." });
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

  return sendJSON(res, 200, {
    connected: true,
    bank: +bankTotal.toFixed(2),
    accounts,
    cards,
    spending: spendingSummary(allTxns),
    transactions: recent,
    syncedAt: new Date().toISOString(),
  });
};

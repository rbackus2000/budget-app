/* /api/plaid/create-link-token — start a Plaid Link session (owner-only) */
"use strict";
const { sendJSON, verifyUser, plaid } = require("./_plaid");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJSON(res, 405, { error: "Method not allowed" });
  const user = await verifyUser(req.headers && req.headers.authorization);
  if (!user) return sendJSON(res, 401, { error: "Sign in to connect a bank." });

  try {
    const data = await plaid("/link/token/create", {
      client_name: "Budget Planner",
      language: "en",
      country_codes: ["US"],
      user: { client_user_id: user.id },
      // Phase 1 scope: real balances, credit-card liabilities, and spending.
      products: ["transactions", "liabilities"],
      transactions: { days_requested: 90 },
    });
    return sendJSON(res, 200, { link_token: data.link_token, expiration: data.expiration });
  } catch (e) {
    console.error("create-link-token error", e && e.message, e && e.plaid);
    return sendJSON(res, 502, { error: "Could not start the bank connection." });
  }
};

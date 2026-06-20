/* /api/plaid/create-link-token — start a Plaid Link session (owner-only) */
"use strict";
const { sendJSON, verifyUser, plaid } = require("./_plaid");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJSON(res, 405, { error: "Method not allowed" });
  const user = await verifyUser(req.headers && req.headers.authorization);
  if (!user) return sendJSON(res, 401, { error: "Sign in to connect a bank." });

  try {
    const body = {
      client_name: "Budget Planner",
      language: "en",
      country_codes: ["US"],
      user: { client_user_id: user.id },
      // Phase 1 scope: real balances, credit-card liabilities, and spending.
      products: ["transactions", "liabilities"],
      transactions: { days_requested: 180 }, // 180+ improves recurring stream detection
    };
    // Required for OAuth banks (most major banks in Production). Must be an
    // https URI with no query params, registered in the Plaid dashboard's
    // Allowed redirect URIs. Omitted in sandbox if unset.
    if (process.env.PLAID_REDIRECT_URI) body.redirect_uri = process.env.PLAID_REDIRECT_URI;
    const data = await plaid("/link/token/create", body);
    return sendJSON(res, 200, { link_token: data.link_token, expiration: data.expiration });
  } catch (e) {
    console.error("create-link-token error", e && e.message, e && e.plaid);
    return sendJSON(res, 502, { error: "Could not start the bank connection." });
  }
};

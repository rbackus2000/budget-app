/* /api/plaid/create-link-token — start a Plaid Link session (owner-only) */
"use strict";
const { sendJSON, verifyUser, plaid, PLAID_PRODUCTS } = require("./_plaid");

// Domains we may hand Plaid as the OAuth return URL. Each MUST also be registered
// in the Plaid dashboard's "Allowed redirect URIs" (with the trailing slash).
// Override with env PLAID_REDIRECT_ORIGINS="https://a.com,https://b.com".
const REDIRECT_ORIGINS = (process.env.PLAID_REDIRECT_ORIGINS ||
  "https://www.bulgaai.com,https://bulgaai.com,https://budget-app-zeta-three.vercel.app")
  .split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);

// Send the OAuth redirect for the domain the user is actually on (so connecting
// from www.bulgaai.com returns to www.bulgaai.com, not a different host). Reads
// the request Origin/Referer; falls back to the explicit PLAID_REDIRECT_URI env.
function pickRedirect(req) {
  const h = (req && req.headers) || {};
  let origin = String(h.origin || "").trim();
  if (!origin && h.referer) { try { origin = new URL(h.referer).origin; } catch (e) {} }
  origin = origin.replace(/\/+$/, "");
  if (origin && REDIRECT_ORIGINS.indexOf(origin) >= 0) return origin + "/";
  return process.env.PLAID_REDIRECT_URI || "";
}

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
      // Products are env-driven (PLAID_PRODUCTS) so we only ever request what the
      // account is approved for — asking for an unapproved product (e.g.
      // liabilities) fails the whole Link with INVALID_PRODUCT. Default:
      // transactions (real balances + spending + recurring income/bills).
      products: PLAID_PRODUCTS,
      transactions: { days_requested: 180 }, // 180+ improves recurring stream detection
    };
    // Required for OAuth banks (most major banks in Production). Must be an
    // https URI with no query params, registered in the Plaid dashboard's
    // Allowed redirect URIs. Follows the user's current domain; omitted if none.
    const redirect = pickRedirect(req);
    if (redirect) body.redirect_uri = redirect;
    const data = await plaid("/link/token/create", body);
    return sendJSON(res, 200, { link_token: data.link_token, expiration: data.expiration });
  } catch (e) {
    console.error("create-link-token error", e && e.message, e && e.plaid);
    return sendJSON(res, 502, { error: "Could not start the bank connection." });
  }
};

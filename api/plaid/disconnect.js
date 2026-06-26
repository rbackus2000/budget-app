/* /api/plaid/disconnect — unlink the user's bank(s) (owner-only).
 * Calls /item/remove at Plaid for each connected Item and deletes the rows,
 * so the user can reconnect with a different login. */
"use strict";
const { sendJSON, verifyUser, removeItems } = require("./_plaid");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJSON(res, 405, { error: "Method not allowed" });
  const user = await verifyUser(req.headers && req.headers.authorization);
  if (!user) return sendJSON(res, 401, { error: "Sign in to manage your bank." });
  try {
    const removed = await removeItems(user.id);
    return sendJSON(res, 200, { disconnected: true, removed: removed });
  } catch (e) {
    console.error("disconnect error", e && e.message);
    return sendJSON(res, 502, { error: "Could not disconnect the bank." });
  }
};

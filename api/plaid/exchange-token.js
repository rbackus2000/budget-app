/* /api/plaid/exchange-token — swap Link's public_token for an access_token (owner-only) */
"use strict";
const { sendJSON, verifyUser, plaid, saveItem } = require("./_plaid");

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let d = ""; req.on("data", c => { d += c; if (d.length > 50000) req.destroy(); });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJSON(res, 405, { error: "Method not allowed" });
  const user = await verifyUser(req.headers && req.headers.authorization);
  if (!user) return sendJSON(res, 401, { error: "Sign in to connect a bank." });

  let body;
  try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: "Bad request." }); }
  const publicToken = body && body.public_token;
  if (!publicToken) return sendJSON(res, 400, { error: "Missing public_token." });
  const institutionName =
    body && body.metadata && body.metadata.institution && body.metadata.institution.name;

  try {
    const ex = await plaid("/item/public_token/exchange", { public_token: publicToken });
    // access_token is encrypted inside saveItem before it touches the database.
    await saveItem(user.id, ex.item_id, ex.access_token, institutionName);
    return sendJSON(res, 200, { ok: true, institution: institutionName || null });
  } catch (e) {
    console.error("exchange-token error", e && e.message, e && e.plaid);
    return sendJSON(res, 502, { error: "Could not finish connecting the bank." });
  }
};

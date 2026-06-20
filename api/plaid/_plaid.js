/* ------------------------------------------------------------------ *
 *  /api/plaid/_plaid — shared helpers for the Plaid integration        *
 *                                                                     *
 *  Server-only. Holds the Plaid secret and the AES key used to encrypt *
 *  bank access_tokens at rest. Access tokens NEVER reach the browser   *
 *  and NEVER touch the client-readable `budgets` table — they live in  *
 *  `plaid_items` (RLS deny-all) reached only via the service role.     *
 *                                                                     *
 *  Underscore-prefixed → Vercel does not route this as an endpoint.    *
 *  Zero dependencies — plain fetch + node crypto.                      *
 * ------------------------------------------------------------------ */

"use strict";

const crypto = require("crypto");

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://vqhuudfrtuurxfismbph.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "sb_publishable_IUyRTgtGyYkAebmQIwODmA_gl2noPax";

const ALLOWED_EMAILS = ["rbackus2000@gmail.com", "bridgettehuff282@gmail.com"];

// sandbox | production. Defaults to sandbox so we can't accidentally hit real
// banks until it's deliberately flipped via env.
const PLAID_ENV = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const PLAID_HOST =
  PLAID_ENV === "production"
    ? "https://production.plaid.com"
    : "https://sandbox.plaid.com";

function sendJSON(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

// ---- Auth: confirm a real Supabase session for an allowlisted email -------
// Returns { id, email } or null. Plaid endpoints are owner-only.
async function verifyUser(authHeader) {
  const token = String(authHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: SUPABASE_ANON_KEY },
    });
    if (!r.ok) return null;
    const user = await r.json();
    const email = (user && user.email ? String(user.email) : "").toLowerCase();
    if (!email || ALLOWED_EMAILS.indexOf(email) < 0) return null;
    return { id: user.id, email: email };
  } catch (e) {
    return null;
  }
}

// ---- AES-256-GCM encryption for access tokens -----------------------------
function encKey() {
  const b64 = process.env.PLAID_ENCRYPTION_KEY || "";
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("PLAID_ENCRYPTION_KEY must be 32 bytes (base64)");
  return key;
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), ct.toString("hex")].join(":");
}
function decrypt(blob) {
  const [ivH, tagH, ctH] = String(blob).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(ivH, "hex"));
  decipher.setAuthTag(Buffer.from(tagH, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctH, "hex")), decipher.final()]).toString("utf8");
}

// ---- Plaid REST ------------------------------------------------------------
async function plaid(path, body) {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) throw new Error("PLAID_CLIENT_ID / PLAID_SECRET not set");
  const r = await fetch(PLAID_HOST + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ client_id: clientId, secret: secret }, body)),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error("Plaid " + path + " failed: " + (data.error_code || r.status));
    err.plaid = data; // {error_type, error_code, error_message, ...}
    throw err;
  }
  return data;
}

// ---- Supabase admin (service role) for plaid_items ------------------------
function adminHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
}
async function saveItem(userId, itemId, accessToken, institutionName) {
  const row = {
    user_id: userId,
    item_id: itemId,
    access_token_enc: encrypt(accessToken),
    institution_name: institutionName || null,
    updated_at: new Date().toISOString(),
  };
  const r = await fetch(SUPABASE_URL + "/rest/v1/plaid_items?on_conflict=user_id,item_id", {
    method: "POST",
    headers: Object.assign(adminHeaders(), { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error("saveItem failed " + r.status + " " + (await r.text().catch(() => "")));
}
async function listItems(userId) {
  const url =
    SUPABASE_URL + "/rest/v1/plaid_items?user_id=eq." + encodeURIComponent(userId) +
    "&select=item_id,access_token_enc,institution_name,transactions_cursor";
  const r = await fetch(url, { headers: adminHeaders() });
  if (!r.ok) throw new Error("listItems failed " + r.status);
  return (await r.json()).map(it => ({
    itemId: it.item_id,
    accessToken: decrypt(it.access_token_enc),
    institutionName: it.institution_name,
    cursor: it.transactions_cursor,
  }));
}
async function saveCursor(userId, itemId, cursor) {
  const url =
    SUPABASE_URL + "/rest/v1/plaid_items?user_id=eq." + encodeURIComponent(userId) +
    "&item_id=eq." + encodeURIComponent(itemId);
  await fetch(url, {
    method: "PATCH",
    headers: Object.assign(adminHeaders(), { Prefer: "return=minimal" }),
    body: JSON.stringify({ transactions_cursor: cursor, updated_at: new Date().toISOString() }),
  });
}

module.exports = {
  PLAID_ENV, sendJSON, verifyUser, encrypt, decrypt, plaid,
  saveItem, listItems, saveCursor,
};

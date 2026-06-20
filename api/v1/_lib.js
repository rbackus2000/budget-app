/* ------------------------------------------------------------------ *
 *  /api/v1/_lib — shared helpers for the read-only financial API       *
 *                                                                     *
 *  Consumed by external tools (e.g. a ChatGPT Custom GPT Action).      *
 *  Auth is a single static bearer secret (READ_API_KEY) — NOT a user   *
 *  login, since the GPT can't do Supabase auth. The functions read one *
 *  fixed owner's precomputed `snapshot` (written by the app on save)   *
 *  via the Supabase service role, scoped to OWNER_USER_ID. Read-only:  *
 *  no writes, no other rows, SELECT of a single column.                *
 *                                                                     *
 *  Underscore-prefixed → Vercel does not route this as an endpoint.    *
 *  Zero dependencies — plain fetch + node crypto.                      *
 * ------------------------------------------------------------------ */

"use strict";

const crypto = require("crypto");

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://vqhuudfrtuurxfismbph.supabase.co";

// The single owner whose data this API exposes. Not a secret (it's just a
// user id); overridable via env. Defaults to the app owner.
const OWNER_USER_ID =
  process.env.OWNER_USER_ID || "d5ca0987-95c1-4df9-889c-e23e7167ee41";

function sendJSON(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  // The GPT Action calls server-to-server, but a permissive read-only CORS
  // header keeps browser-based testing simple. No credentials are involved.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

// Constant-time compare of the bearer token against READ_API_KEY.
function checkApiKey(req) {
  const expected = process.env.READ_API_KEY || "";
  if (!expected) return false; // not configured → deny everything
  const got = String((req.headers && req.headers.authorization) || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

// Fetch the owner's precomputed snapshot via the service role (bypasses RLS).
// Returns { snapshot, updatedAt } or throws.
async function fetchSnapshot() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  const url =
    SUPABASE_URL +
    "/rest/v1/budgets?user_id=eq." +
    encodeURIComponent(OWNER_USER_ID) +
    "&select=snapshot,updated_at";

  const r = await fetch(url, {
    headers: {
      apikey: serviceKey,
      Authorization: "Bearer " + serviceKey,
      Accept: "application/json",
    },
  });
  if (!r.ok) {
    let detail = "";
    try { detail = await r.text(); } catch (e) {}
    throw new Error("Supabase read failed " + r.status + " " + detail);
  }
  const rows = await r.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || !row.snapshot || !Object.keys(row.snapshot).length) {
    return { snapshot: null, updatedAt: row ? row.updated_at : null };
  }
  return { snapshot: row.snapshot, updatedAt: row.updated_at };
}

// Wrap a per-endpoint handler with the shared GET-only + auth + fetch flow.
// `pick(snapshot)` returns the slice this endpoint exposes.
function makeEndpoint(pick) {
  return async function handler(req, res) {
    if (req.method === "OPTIONS") { sendJSON(res, 204, {}); return; }
    if (req.method !== "GET") return sendJSON(res, 405, { error: "Method not allowed" });
    if (!checkApiKey(req)) return sendJSON(res, 401, { error: "Invalid or missing API key." });

    try {
      const { snapshot, updatedAt } = await fetchSnapshot();
      if (!snapshot) {
        return sendJSON(res, 503, {
          error: "No data available yet. Open the Budget app once to publish a snapshot.",
        });
      }
      const body = pick(snapshot) || {};
      body.asOf = snapshot.today || null;     // snapshot's own "today"
      body.updatedAt = updatedAt || null;     // when the app last saved
      return sendJSON(res, 200, body);
    } catch (e) {
      console.error("v1 endpoint error", e && e.message);
      return sendJSON(res, 502, { error: "Could not read financial data." });
    }
  };
}

module.exports = { sendJSON, checkApiKey, fetchSnapshot, makeEndpoint };

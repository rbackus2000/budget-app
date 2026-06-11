/* ------------------------------------------------------------------ *
 *  /api/extract-statement — read a PDF statement into bill fields      *
 *                                                                     *
 *  Auth-gated like /api/advisor. Sends the uploaded PDF to Claude      *
 *  (Sonnet 4.6) with a strict JSON schema and returns structured       *
 *  fields the front end uses to pre-fill the Add Item modal for        *
 *  the user to review. The PDF is processed in-memory and discarded.   *
 * ------------------------------------------------------------------ */

"use strict";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://vqhuudfrtuurxfismbph.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "sb_publishable_IUyRTgtGyYkAebmQIwODmA_gl2noPax";
const ALLOWED_EMAILS = ["rbackus2000@gmail.com", "bridgettehuff282@gmail.com"];

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1200;
const MAX_PDF_B64 = 4_600_000; // ~3.4MB decoded — keeps us under Vercel's 4.5MB body limit

// Strict schema matching the app's bill model. Nullable fields come back as
// null when the statement doesn't show them — the model is told not to guess.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: ["string", "null"], description: "Issuer / account name, e.g. 'Chase Sapphire', 'City Electric', 'Toyota Auto Loan'." },
    accountType: { type: "string", enum: ["Bill", "Credit Card Debt", "Other Debt / Loan"], description: "Credit card statement → 'Credit Card Debt'; auto/student/personal loan → 'Other Debt / Loan'; utility/rent/subscription/insurance → 'Bill'." },
    statementBalance: { type: ["number", "null"], description: "The new/current statement balance owed (not the previous balance, not the minimum)." },
    minimumPayment: { type: ["number", "null"], description: "Minimum payment due (for a flat bill, the amount due / monthly payment)." },
    aprPct: { type: ["number", "null"], description: "Purchase/standard APR as a percent number, e.g. 24.99. Null if not shown." },
    paymentDueDay: { type: ["integer", "null"], description: "Day of month (1-31) from the payment due date." },
    creditLimit: { type: ["number", "null"], description: "Total credit limit (credit cards only). Null otherwise." },
    statementClosingDay: { type: ["integer", "null"], description: "Day of month (1-31) from the statement closing / billing cycle end date." },
    notes: { type: "string", description: "One short sentence on anything ambiguous or not found. Empty string if all clear." },
  },
  required: ["name", "accountType", "statementBalance", "minimumPayment", "aprPct", "paymentDueDay", "creditLimit", "statementClosingDay", "notes"],
};

const SYSTEM_PROMPT = `You extract structured data from a single consumer financial statement (credit card, loan, or recurring bill) into a fixed schema.

Rules:
- Use ONLY what's printed on the statement. Never guess or infer a number that isn't shown — return null instead.
- statementBalance = the NEW balance / current balance owed for this cycle, not the previous balance and not the minimum payment.
- minimumPayment = the minimum payment due. For a flat bill with no "minimum", use the total amount due.
- Convert full dates to a day-of-month integer (1-31): "Payment Due 07/15/2026" → 15; "Statement Closing Date 06/28/2026" → 28.
- statementClosingDay is the billing cycle end / closing date — distinct from the payment due date.
- creditLimit applies to credit cards only; null for loans and bills.
- Classify accountType from the document: card statement → "Credit Card Debt", auto/student/personal loan → "Other Debt / Loan", utility/rent/insurance/subscription → "Bill".
- Put any uncertainty (couldn't find a field, two plausible values, etc.) in notes as one short sentence.`;

function sendJSON(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

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
    return email && ALLOWED_EMAILS.indexOf(email) >= 0 ? email : null;
  } catch (e) {
    return null;
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 6 * 1024 * 1024) { reject(new Error("too large")); req.destroy(); return; }
      data += chunk;
    });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJSON(res, 405, { error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return sendJSON(res, 500, { error: "Not configured. Set ANTHROPIC_API_KEY in Vercel." });

  const email = await verifyUser(req.headers && req.headers.authorization);
  if (!email) return sendJSON(res, 401, { error: "Sign in to upload statements." });

  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 413, { error: "That PDF is too large — keep it under ~3 MB." }); }

  const pdf = String((body && body.pdf) || "");
  if (!pdf) return sendJSON(res, 400, { error: "No PDF received." });
  if (pdf.length > MAX_PDF_B64) return sendJSON(res, 413, { error: "That PDF is too large — keep it under ~3 MB." });

  // Confirm it's actually a PDF (magic bytes "%PDF") before spending a token.
  try {
    const head = Buffer.from(pdf.slice(0, 12), "base64").toString("latin1");
    if (head.indexOf("%PDF") !== 0) return sendJSON(res, 400, { error: "That doesn't look like a PDF statement." });
  } catch (e) {
    return sendJSON(res, 400, { error: "Couldn't read that file." });
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } },
            { type: "text", text: "Extract this statement into the schema." },
          ],
        }],
      }),
    });

    if (!r.ok) {
      let detail = "";
      try { detail = JSON.stringify(await r.json()); } catch (e) {}
      console.error("Anthropic extract error", r.status, detail);
      const msg = r.status === 429
        ? "Busy right now — try again in a moment."
        : "Couldn't read that statement. Try a clearer PDF or add it manually.";
      return sendJSON(res, 502, { error: msg });
    }

    const data = await r.json();
    const text = Array.isArray(data.content)
      ? data.content.filter(b => b.type === "text").map(b => b.text).join("").trim()
      : "";

    let fields;
    try { fields = JSON.parse(text); }
    catch (e) { return sendJSON(res, 502, { error: "Couldn't parse the statement details." }); }

    return sendJSON(res, 200, { fields });
  } catch (e) {
    console.error("extract-statement handler error", e && e.message);
    return sendJSON(res, 502, { error: "Couldn't reach the reader. Please try again." });
  }
};

/* ------------------------------------------------------------------ *
 *  /api/credit-report — analyze uploaded credit report PDF(s)          *
 *                                                                     *
 *  Auth-gated. Accepts one or more bureau credit reports (Equifax,     *
 *  Experian, TransUnion) as base64 PDFs, sends them to Claude with a   *
 *  credit-analyst prompt, and returns a prioritized, score-maxing      *
 *  action plan in markdown. Processed in-memory and discarded.         *
 * ------------------------------------------------------------------ */

"use strict";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://vqhuudfrtuurxfismbph.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "sb_publishable_IUyRTgtGyYkAebmQIwODmA_gl2noPax";
const ALLOWED_EMAILS = ["rbackus2000@gmail.com", "bridgettehuff282@gmail.com"];

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4000;
const MAX_TOTAL_B64 = 4_400_000; // ~3.3MB of PDF across all reports — Vercel body cap

const SYSTEM_PROMPT = `You are an expert credit analyst. You read a person's actual credit report(s) — possibly from more than one bureau (Equifax, Experian, TransUnion) — and produce a clear, prioritized action plan to raise their score toward its maximum.

# What to analyze from the report(s)
- **Utilization** — overall and PER CARD (balance ÷ limit). This is the fastest lever.
- **Payment history** — late payments, missed payments, collections, charge-offs, public records. The biggest factor (35%).
- **Derogatory marks** — collections, late marks, charge-offs: note age and whether they're worth disputing or addressing.
- **Credit age** — average age of accounts and oldest account.
- **Credit mix** — revolving vs installment.
- **Hard inquiries & new accounts** — recent inquiries, recently opened accounts.
- **Errors** — anything that looks inaccurate (wrong balances, accounts that aren't theirs, duplicate collections) — flag for dispute.
- If multiple bureaus: note meaningful DIFFERENCES between them (an item on one but not another, different balances).

# The utilization rule you must apply
The score SWEET SPOT is LOW SINGLE-DIGIT utilization (~1-9%), NOT 0%. Under 30% avoids damage; under 10% is excellent; ~1-9% is optimal. 0% across ALL cards gives no extra benefit and can slightly hurt (no recent revolving activity + idle-card closure risk). Best practice is AZEO ("All Zero Except One"): let ONE card report a small balance (1-9%) and the rest report $0. Always pay statements in full by the due date — reporting a small balance is not the same as carrying a balance and paying interest. When you recommend paying cards down, target the per-card and overall balances that land them in the 1-9% range with one small reporting balance.

# Output (markdown)
- Start with a one-line read on where they stand and the single highest-impact move.
- "## Do this first" — the top 2-3 highest-impact actions, specific to their report (name actual accounts, balances, due/closing dynamics).
- "## Utilization plan" — exact paydown targets per card to hit the ~9% sweet spot / AZEO, with dollar amounts where the report shows balances and limits.
- "## Fix & dispute" — derogatory marks, errors, late payments: what to dispute, goodwill-letter candidates, pay-for-delete where relevant.
- "## Protect & build" — keep old cards open and active (use a few times a year), avoid new hard inquiries, don't close your oldest accounts.
- Keep it specific, prioritized by score impact, and skimmable. Use the person's real numbers.
- You are educational guidance, not a credit-repair company; mention this once, lightly. Never tell them to do anything dishonest (no fake disputes of accurate items).`;

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
    req.on("data", chunk => { bytes += chunk.length; if (bytes > 6 * 1024 * 1024) { reject(new Error("too large")); req.destroy(); return; } data += chunk; });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function isPdf(b64) {
  try { return Buffer.from(b64.slice(0, 12), "base64").toString("latin1").indexOf("%PDF") === 0; }
  catch (e) { return false; }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJSON(res, 405, { error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return sendJSON(res, 500, { error: "Not configured. Set ANTHROPIC_API_KEY in Vercel." });

  const email = await verifyUser(req.headers && req.headers.authorization);
  if (!email) return sendJSON(res, 401, { error: "Sign in to analyze a credit report." });

  let body;
  try { body = await readBody(req); } catch (e) { return sendJSON(res, 413, { error: "Reports too large — upload one bureau at a time." }); }

  const reports = Array.isArray(body && body.reports) ? body.reports : [];
  const currentScore = parseInt(body && body.currentScore, 10);
  if (!reports.length) return sendJSON(res, 400, { error: "No report received." });

  let total = 0;
  for (const r of reports) {
    const pdf = String((r && r.pdf) || "");
    if (!pdf || !isPdf(pdf)) return sendJSON(res, 400, { error: "One of the files isn't a PDF credit report." });
    total += pdf.length;
  }
  if (total > MAX_TOTAL_B64) return sendJSON(res, 413, { error: "Reports too large together — upload one bureau at a time." });

  const content = [];
  reports.forEach((r, i) => {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: r.pdf } });
  });
  let instruction = "Analyze the attached credit report" + (reports.length > 1 ? "s (" + reports.length + " bureaus)" : "") + " and give me a prioritized plan to raise my score to its maximum.";
  if (currentScore >= 300 && currentScore <= 850) instruction += " My current score is about " + currentScore + ".";
  content.push({ type: "text", text: instruction });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: content }],
      }),
    });

    if (!r.ok) {
      let detail = ""; try { detail = JSON.stringify(await r.json()); } catch (e) {}
      console.error("credit-report error", r.status, detail);
      return sendJSON(res, 502, { error: r.status === 429 ? "Busy right now — try again in a moment." : "Couldn't analyze the report. Try again or upload one bureau at a time." });
    }

    const data = await r.json();
    const analysis = Array.isArray(data.content) ? data.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim() : "";
    return sendJSON(res, 200, { analysis: analysis || "Couldn't read that report — try a clearer PDF." });
  } catch (e) {
    console.error("credit-report handler error", e && e.message);
    return sendJSON(res, 502, { error: "Couldn't reach the analyzer. Please try again." });
  }
};

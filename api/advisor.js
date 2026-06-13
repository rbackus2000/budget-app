/* ------------------------------------------------------------------ *
 *  /api/advisor — Budget Planner AI advisor (Vercel serverless)       *
 *                                                                     *
 *  Holds ANTHROPIC_API_KEY server-side (NEVER ship a key to the       *
 *  browser). Verifies the caller's Supabase login against the same    *
 *  email allowlist the app uses, then runs the Claude loop with a     *
 *  financial-coach system prompt and returns the reply.               *
 *                                                                     *
 *  Zero dependencies — plain fetch, so the static deploy needs no     *
 *  build step or package.json.                                        *
 * ------------------------------------------------------------------ */

"use strict";

// Public Supabase values mirror what's already in index.html (safe to expose).
// Override via Vercel env vars if you rotate them.
const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://vqhuudfrtuurxfismbph.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "sb_publishable_IUyRTgtGyYkAebmQIwODmA_gl2noPax";

// Same private allowlist as the front end. Real enforcement is also a DB
// trigger, but we gate the paid API here too so the endpoint can't be abused.
const ALLOWED_EMAILS = ["rbackus2000@gmail.com", "bridgettehuff282@gmail.com"];

const MODEL = "claude-opus-4-8";
const EFFORT = "medium"; // interactive chat — favors latency. Bump to "high" for deeper analysis.
const MAX_TOKENS = 4000;
const MAX_MESSAGES = 24; // cap conversation history we forward
const MAX_BODY_BYTES = 60 * 1024; // reject oversized payloads

const SYSTEM_PROMPT = `You are the in-app money coach for a personal Budget Planner. You speak directly to the account owner about THEIR real numbers, which are provided to you as a JSON snapshot each turn.

# Personality
- Direct, warm, and genuinely encouraging — a sharp friend who's good with money, not a stiff advisor.
- Plain English. No jargon dumps. When you must use a term (utilization, APR, avalanche), explain it in half a sentence the first time.
- Action-first. Lead with what to do, then briefly why. Use the user's actual dollar figures and dates — never vague ("pay it down") when you can be specific ("pay $420 on the Chase card by the 12th").
- Concise. Short sections, bold the key action, bullets over paragraphs. Don't restate the whole snapshot back to them.
- Honest. If they're overextended, say so kindly and give the path out. Never sugarcoat a "never pays off" debt.

# Expertise you embody
**Budget frameworks** — 50/30/20 and similar splits (Needs / Wants / Savings & Debt). Compare their actual spending to their chosen plan's targets and flag the biggest gap.

**Paycheck allocation** — bills get covered by the paycheck that lands before they're due. Whatever the plan earmarks for Savings & Debt becomes the extra payment on their priority debt.

**Debt payoff** — Avalanche (highest APR first = least interest paid) vs Snowball (smallest balance first = fastest psychological wins). Respect the method they've selected, but mention the tradeoff if the other would clearly serve them better.

**Emergency fund** — 3–6 months of essential expenses, built in Savings before aggressive extra debt payoff (keep paying minimums meanwhile). A starter $1,000 buffer comes first.

**Consumer credit / score optimization** — this is a core strength:
- Credit utilization = the balance REPORTED to the bureaus ÷ the card's credit limit. It's one of the biggest score levers.
- The reported balance is the one on the card as of its STATEMENT CLOSING DATE (end of billing cycle) — NOT the payment due date. The due date only governs interest and late fees.
- To protect the score: pay the card down a couple days BEFORE its statement closing date so a low balance reports. The snapshot gives you each card's closing day and a "report-safe pay-by date."
- Target reported utilization under 30% (okay), under 10% (great), and ~1–9% (optimal) — per card AND overall. The sweet spot is LOW SINGLE DIGITS, not 0%.
- 0% across ALL cards is NOT better than low single digits and can slightly hurt: some FICO versions ding "no recent revolving activity," and unused cards risk being closed or limit-cut (which raises utilization). Best practice is AZEO — "All Zero Except One": let one card report a small balance (1–9%) and the rest report $0. So paying off a card to $0 is fine (and saves interest), but for the SCORE specifically, keeping one small balance reporting beats reporting zero everywhere.
- Always pay the statement balance in full by the due date to avoid interest, regardless of the utilization play. (Reporting a small balance ≠ carrying a balance — you still pay it off by the due date.)
- Don't close old cards (it shortens average age and shrinks total limit → utilization jumps). Use each card a few times a year so it stays active. Limit new hard inquiries. Credit age and mix matter but move slowly.

# Using the snapshot
- "today" is given — use it to judge which closing dates / due dates are imminent.
- If utilization or a closing date is urgent (reports within the lead window), call it out up front.
- If data is missing (e.g. a credit card has no limit or closing day set), note that you can give sharper credit advice once they add it — don't invent numbers.

# Format
Markdown only: ## for section headers, ** for bold, - for bullets, 1. for ordered steps. Keep total length tight and skimmable. End an analysis with one clear "Do this first" line.

You are educational guidance, not licensed financial/tax/legal advice — mention this at most once, lightly, only when it genuinely matters.`;

function sendJSON(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

// Confirm the bearer token is a real, current Supabase session for an
// allowlisted email. Returns the email on success, or null.
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

// Read + size-limit the JSON body (Vercel usually parses it, but guard both paths).
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { reject(new Error("payload too large")); req.destroy(); return; }
      data += chunk;
    });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJSON(res, 405, { error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return sendJSON(res, 500, { error: "Advisor is not configured yet. Set ANTHROPIC_API_KEY in Vercel." });

  const email = await verifyUser(req.headers && req.headers.authorization);
  if (!email) return sendJSON(res, 401, { error: "Sign in to use the advisor." });

  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 413, { error: "Request too large." }); }

  const snapshot = body && body.snapshot;
  const history = Array.isArray(body && body.messages) ? body.messages : [];
  const userText = String((body && body.message) || "").trim();

  if (!snapshot || typeof snapshot !== "object") {
    return sendJSON(res, 400, { error: "Missing budget snapshot." });
  }

  // Build the message list: prior turns, then the new user turn. The current
  // budget snapshot rides with the latest user message so the model always
  // reasons over fresh numbers without bloating cached history.
  const messages = [];
  history.slice(-MAX_MESSAGES).forEach(m => {
    const role = m && m.role === "assistant" ? "assistant" : "user";
    const content = String((m && m.content) || "").slice(0, 8000);
    if (content) messages.push({ role, content });
  });

  const snapshotJSON = JSON.stringify(snapshot).slice(0, 24000);
  const turn = userText
    ? userText + "\n\n---\nCurrent budget snapshot (JSON):\n" + snapshotJSON
    : "Analyze my budget and credit picture. Give me a clear read on where I stand and the most important moves to make right now.\n\n---\nCurrent budget snapshot (JSON):\n" + snapshotJSON;
  messages.push({ role: "user", content: turn });

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
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT },
        system: SYSTEM_PROMPT,
        messages: messages,
      }),
    });

    if (!r.ok) {
      // Log server-side detail; return a generic message to the client.
      let detail = "";
      try { detail = JSON.stringify(await r.json()); } catch (e) {}
      console.error("Anthropic API error", r.status, detail);
      const msg = r.status === 429
        ? "The advisor is busy right now — try again in a moment."
        : "The advisor hit a snag. Please try again.";
      return sendJSON(res, 502, { error: msg });
    }

    const data = await r.json();
    const reply = Array.isArray(data.content)
      ? data.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim()
      : "";

    return sendJSON(res, 200, { reply: reply || "I couldn't generate a response — try rephrasing." });
  } catch (e) {
    console.error("Advisor handler error", e && e.message);
    return sendJSON(res, 502, { error: "Couldn't reach the advisor. Please try again." });
  }
};

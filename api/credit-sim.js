/* ------------------------------------------------------------------ *
 *  /api/credit-sim — estimate credit-score impact of paying down cards *
 *                                                                     *
 *  Auth-gated like the other endpoints. The app computes the exact     *
 *  utilization for each scenario (deterministic) and sends them with   *
 *  the current score; Claude estimates a realistic score RANGE per     *
 *  scenario via structured output. Estimates only — not a guarantee.   *
 * ------------------------------------------------------------------ */

"use strict";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://vqhuudfrtuurxfismbph.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "sb_publishable_IUyRTgtGyYkAebmQIwODmA_gl2noPax";
const ALLOWED_EMAILS = ["rbackus2000@gmail.com", "bridgettehuff282@gmail.com"];

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    scenarios: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string", description: "Must match the input scenario's key exactly." },
          estimatedScoreLow: { type: "integer", description: "Low end of the estimated score (300-850)." },
          estimatedScoreHigh: { type: "integer", description: "High end of the estimated score (300-850)." },
          pointsChange: { type: "string", description: "Approx change vs current score, e.g. '+20 to +45'." },
          rationale: { type: "string", description: "One short sentence on why." },
        },
        required: ["key", "estimatedScoreLow", "estimatedScoreHigh", "pointsChange", "rationale"],
      },
    },
    disclaimer: { type: "string", description: "One short sentence reminding this is an estimate." },
  },
  required: ["scenarios", "disclaimer"],
};

const SYSTEM_PROMPT = `You estimate the impact of credit-card paydown on a FICO credit score.

Given the person's current score and a set of scenarios (each with the resulting overall card utilization), estimate the likely score for each scenario as a realistic RANGE.

Rules and reasoning (these reflect how FICO actually treats utilization):
- ONLY utilization changes between scenarios. Payment history, credit age, credit mix, and inquiries are held constant.
- Utilization is roughly 30% of a FICO score and is the fastest-moving factor.
- The score SWEET SPOT is LOW SINGLE DIGITS (about 1-9% overall), NOT 0%. Under 30% avoids significant damage; under 10% is where exceptional scores sit; ~1-9% is optimal.
- 0% utilization across ALL cards gives NO extra benefit over low single digits and can be marginally WORSE: some FICO versions apply a small "no recent revolving activity" penalty, and unused cards risk being closed or limit-cut (which RAISES utilization). So estimate a 0% (pay-off-everything) scenario as roughly EQUAL TO, or a few points BELOW, a ~1-9% scenario — never meaningfully higher than the single-digit scenario.
- Best practice is AZEO ("All Zero Except One"): one card reports a small balance (1-9%), the rest report $0.
- Gains are LARGER when current utilization is high and suppressing the score; someone at 70% paying to single digits can jump a lot. A score already near the top (780+) has little room to rise.
- Diminishing returns as you approach the sweet spot. Keep ranges realistic and modest — utilization changes move a suppressed score by tens of points, not hundreds. Never exceed 850 or go below 300.
- Return one entry per input scenario, keyed exactly by its "key". In the rationale, when a scenario is 0% across all cards, briefly note it's no better (and maybe slightly worse) than keeping a small balance.
- These are estimates; real scoring is proprietary and depends on the full credit file.`;

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
    req.on("data", c => { data += c; if (data.length > 200000) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJSON(res, 405, { error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return sendJSON(res, 500, { error: "Not configured. Set ANTHROPIC_API_KEY in Vercel." });

  const email = await verifyUser(req.headers && req.headers.authorization);
  if (!email) return sendJSON(res, 401, { error: "Sign in to use the simulator." });

  let body;
  try { body = await readBody(req); } catch (e) { return sendJSON(res, 413, { error: "Request too large." }); }

  const currentScore = parseInt(body && body.currentScore, 10);
  const currentUtilPct = Number(body && body.currentUtilPct);
  const scenarios = Array.isArray(body && body.scenarios) ? body.scenarios : [];
  if (!(currentScore >= 300 && currentScore <= 850)) return sendJSON(res, 400, { error: "Enter a credit score between 300 and 850." });
  if (!scenarios.length) return sendJSON(res, 400, { error: "No scenarios to simulate — add a credit card with a limit first." });

  const userMsg = "Current credit score: " + currentScore +
    ".\nCurrent overall card utilization: " + Math.round(currentUtilPct) + "%." +
    "\n\nScenarios to estimate (resulting utilization after paying down cards):\n" +
    JSON.stringify(scenarios) +
    "\n\nEstimate the likely score range for each scenario, keyed by its key.";

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: userMsg }],
      }),
    });

    if (!r.ok) {
      let detail = ""; try { detail = JSON.stringify(await r.json()); } catch (e) {}
      console.error("credit-sim error", r.status, detail);
      return sendJSON(res, 502, { error: r.status === 429 ? "Busy right now — try again in a moment." : "Couldn't run the simulation. Try again." });
    }

    const data = await r.json();
    const text = Array.isArray(data.content) ? data.content.filter(b => b.type === "text").map(b => b.text).join("").trim() : "";
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return sendJSON(res, 502, { error: "Couldn't parse the simulation result." }); }
    return sendJSON(res, 200, parsed);
  } catch (e) {
    console.error("credit-sim handler error", e && e.message);
    return sendJSON(res, 502, { error: "Couldn't reach the simulator. Please try again." });
  }
};

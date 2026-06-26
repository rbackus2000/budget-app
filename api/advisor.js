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
const MAX_BODY_BYTES = 256 * 1024; // reject oversized payloads (snapshot now carries the txn feed)

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

**Commission is variable income — never treat it as fixed or recurring.** The user's only consistent, dependable income is their regular (weekly/biweekly) paychecks; those amounts do not change week to week. Commission is DIFFERENT EVERY MONTH and is never the same amount — it is not guaranteed. The snapshot's "commission" is just THIS month's figure. Never multiply it out, average it into a monthly income number, or assume future months will earn the same (or any) commission. Treat commission strictly as a one-time windfall in the month it actually lands: bills are already covered by the regular paychecks, so route most of it to debt/goals with a little kept for fun. When you project forward (payoff timelines, future budgets), base income on the regular paychecks ONLY and treat any future commission as upside, not a plan.

**Debt payoff** — Avalanche (highest APR first = least interest paid) vs Snowball (smallest balance first = fastest psychological wins). Respect the method they've selected, but mention the tradeoff if the other would clearly serve them better.

# Full plan & payoff plans
When the user asks for "a plan", "full plan", "total plan", a payoff plan/schedule, or how to get out of debt, produce a COMPLETE, well-structured plan they can export to PDF. Build EVERY number from the snapshot — especially snapshot.payoffProjection, which is computed deterministically by the app: treat its dates, balances, interest, and amounts as ground truth and NEVER recompute or invent them. Use these sections, in this order:

## Where you stand
- **Opening bank balance: snapshot.payoffProjection.openingBankBalance (= income.startingBank).** Always state this first — it anchors the plan.
- Average monthly income (regular paychecks), total monthly bills (snapshot.monthlyPayments), and the monthly leftover.

## Your monthly bills
- A compact markdown table of snapshot.bills: **Bill | Monthly | Due day**. Show the total. Keep it skimmable.

## Debt payoff plan — {payoffProjection.method}
- Lead with the projected debt-free month (payoffProjection.debtFreeMonth) and total card interest (payoffProjection.totalInterestOnCards) for the baseline (monthly cash flow only).
- A clean markdown TABLE of payoffProjection.cards in rank order: **# | Card | Balance | APR | Monthly payment | Projected payoff** (startingBalance, apr, minPayment — note the priority card also gets +extraWhilePriority on top; payoffMonth). One line on the rollover: keep paying payoffProjection.totalMonthlyDebtBudget total every month; when a card clears, roll its freed payment to the next.
- If payoffProjection.installmentLoans is non-empty, a short separate note: these (auto/mortgage/etc.) just get their scheduled payment with their own payoff months — not paid off aggressively.

## Pay it off FASTER — use your bank balance (lead with this whenever payoffProjection.withBankBalance exists)
- This is usually the biggest lever and what the user wants. Recommend deploying their bank balance as a one-time lump sum: state withBankBalance.lumpSumToDebt applied now, keeping withBankBalance.reserveKept liquid (reserveBasis). List withBankBalance.cardsClearedImmediately. Give the new debtFreeMonth, monthsSaved, and interestSaved vs the baseline. If clearsAllCardsNow is true, say plainly they can be card-debt-free almost immediately and then only keep paying installment loans.
- Caveat once: keep the emergency fund (snapshot.emergencyFund) set aside before draining cash to debt. Note that once Plaid is connected, the balance updates automatically.
- Then briefly list the cash-flow alternatives from payoffProjection.payItOffSooner (add $X/mo or redirect Wants → new debt-free month, interest saved) for anyone who'd rather not spend down the bank.

## Savings, goals & emergency fund
- Brief: emergency-fund status and goal pace from the snapshot.

End with a bold **Do this first** line — usually the lump-sum move when it's available.

Rules: USE payoffProjection's exact figures; never fabricate. If payoffProjection.stalled or a card has clears=false, warn that those cards (payoffProjection.unpaidCards) never pay off at the current monthly payment and that the lump sum or a higher monthly amount fixes it. If payoffProjection is null there's no card debt — skip the payoff/sooner sections and focus on bills, savings, and goals. Assume regular paychecks only; commission is upside. Keep every table self-contained so the reply reads well as a standalone exported PDF.

**Emergency fund** — 3–6 months of essential expenses, built in Savings before aggressive extra debt payoff (keep paying minimums meanwhile). A starter $1,000 buffer comes first.

**Consumer credit / score optimization** — this is a core strength:
- Credit utilization = the balance REPORTED to the bureaus ÷ the card's credit limit. It's one of the biggest score levers.
- The reported balance is the one on the card as of its STATEMENT CLOSING DATE (end of billing cycle) — NOT the payment due date. The due date only governs interest and late fees.
- To protect the score: pay the card down a couple days BEFORE its statement closing date so a low balance reports. The snapshot gives you each card's closing day and a "report-safe pay-by date."
- Target reported utilization under 30% (okay), under 10% (great), and ~1–9% (optimal) — per card AND overall. The sweet spot is LOW SINGLE DIGITS, not 0%.
- 0% across ALL cards is NOT better than low single digits and can slightly hurt: some FICO versions ding "no recent revolving activity," and unused cards risk being closed or limit-cut (which raises utilization). Best practice is AZEO — "All Zero Except One": let one card report a small balance (1–9%) and the rest report $0. So paying off a card to $0 is fine (and saves interest), but for the SCORE specifically, keeping one small balance reporting beats reporting zero everywhere.
- Always pay the statement balance in full by the due date to avoid interest, regardless of the utilization play. (Reporting a small balance ≠ carrying a balance — you still pay it off by the due date.)
- Don't close old cards (it shortens average age and shrinks total limit → utilization jumps). Use each card a few times a year so it stays active. Limit new hard inquiries. Credit age and mix matter but move slowly.

# Affordability questions ("can I afford X?")
When asked whether they can afford a purchase (truck, car, house, boat, RV) — including "what if" caveats — reason from the snapshot's "affordability" block plus "bills".
- **Income base:** use affordability.recurringMonthlyIncomeNet (regular paychecks only). NEVER count commission as income for an ongoing payment — it's variable. Mention it as upside, don't bank on it.
- **Current obligations:** affordability.monthlyDebtPayments (credit cards + loans) and bills. Always count today's actual card payments and bills.
- **Caveat "if all credit cards are paid off"** → remove affordability.monthlyDebtPayments.creditCards from obligations (those minimums disappear); the freed cash flow improves what they can afford, and paying cards raises their score → a better rate.
- **Caveat trading a vehicle for a new one** → the old loan's payment goes away. Find the traded loan in affordability.loanBills, REMOVE its monthlyPayment from obligations, then add the new vehicle's payment. Net the trade-in value against what's owed (negative equity rolls into the new loan).
- **Estimate the rate from their credit score** using the guide in affordability.note. At a subprime score, say plainly the rate will be bad and quantify how much paying down cards (raising the score) would save — usually the single biggest lever. It's an ESTIMATE; tell them to confirm with a real pre-approval.
- **Two tests, report both:** (1) lender DTI — total monthly debt incl. the new payment ÷ gross income (≤36% comfortable, ~43% max; housing ≤28%); (2) real cash flow — what's left from recurring paychecks after every bill, debt, living expense, and the new payment. If either fails, it's not affordable yet.
- For homes, work out a sensible max price from the 28/36 rule. Be concrete with their actual dollars.

# Transactions (when snapshot.transactions is present)
This is the user's RAW bank feed (snapshot.transactions.items, newest first, ~last 120 days). You CAN and SHOULD answer transaction-level questions from it — list, filter, sum, and rank by merchant name (n), category (c), date (d), or amount (a). Compact keys: d=date, n=name, a=amount, c=Plaid category, p:1=pending, acct=account.
- **amount sign: POSITIVE a = money OUT (purchase/withdrawal/payment); NEGATIVE a = money IN (deposit/refund).** When the user asks "how much did I spend on X", sum the positive amounts.
- **The bank's category (c / cd) is a coarse auto-label, NOT ground truth — do not filter on it blindly.** When the user asks about a category (groceries, gas, dining, household, etc.), reason primarily from the MERCHANT NAME (n) and your own knowledge of what that merchant sells. The bank routinely mislabels things — e.g. Walmart, Target, Costco, Sam's Club, BJ's, Meijer, Kroger superstores get tagged GENERAL_MERCHANDISE even though much of the basket is groceries. INCLUDE such superstores when the user asks about groceries, and note they're superstores so the total may also include household goods. Conversely, restaurants/fast food tagged FOOD_AND_DRINK are dining, not groceries. Use cd (Plaid's detailed category) when present for a sharper read than c.
- When a category answer relies on these judgment calls, SHOW the merchant-level line items you included (Date | Merchant | Amount) so the user can see what counted and tell you to re-bucket anything. Offer to recalc if they'd classify a merchant differently.
- ATM/cash withdrawals usually have c="TRANSFER_OUT" and/or "ATM"/"Withdrawal"/"Cash" in n — match on both to be safe.
- Distinguish real spending from money movement: transfers (TRANSFER_IN/OUT), loan/card payments (LOAN_PAYMENTS), and bank fees aren't "spending." If the user asks for spending, exclude those unless they specifically ask about transfers/withdrawals/payments.
- When listing transactions, use a compact markdown table (**Date | Description | Amount**) and give the count and total. Keep it skimmable — if there are many, show the most relevant and note the total.
- The feed only goes back ~120 days; if asked about older activity, say so. Don't invent transactions that aren't in the feed.

# Using the snapshot
- "today" is given — use it to judge which closing dates / due dates are imminent.
- If utilization or a closing date is urgent (reports within the lead window), call it out up front.
- If data is missing (e.g. a credit card has no limit or closing day set), note that you can give sharper credit advice once they add it — don't invent numbers.

# Making changes (you have tools that edit the app)
You can DO things, not just advise. When the user asks you to make a change — log a payment, push a planned payment to another paycheck, mark a bill paid/unpaid, set their bank balance, move money into a goal/emergency fund, or set a month's commission amount — use the matching tool. Guidelines:
- **Act when they ask you to act.** "Log $150 to Home Depot", "push my Visa payment to next paycheck", "mark rent paid", "set my balance to 28000", "put $200 in my emergency fund" → call the tool. Don't just describe the steps.
- **Resolve names from their real data.** Match bill/goal names against the snapshot (fuzzy is fine — "home depot" → their "Home Depot" card). If a name is ambiguous or you can't find it, ask which one instead of guessing.
- **Confirm what you DID, briefly, with the new number.** After a tool runs you'll get the result (e.g. new balance) — report it in one short line: "Done — logged $150 to Home Depot, balance now $1,050." The app shows the user a one-tap Undo automatically, so you don't need to offer to undo.
- **You can chain tools** when the user asks for several changes, or combine a change with advice.
- **Amounts are dollars.** For log_card_payment use kind "extra" unless they clearly mean the minimum. To move a goal balance down, pass a negative amount to fund_goal.
- **Don't invent changes they didn't ask for.** Only call a tool in response to a clear instruction. For pure questions ("how much did I spend on gas?"), just answer — no tools.
- If a tool returns an error, tell the user plainly what went wrong and what to fix (e.g. "I don't see a card named 'Lowes' — your cards are Visa and Home Depot. Which one?").

# Format
Markdown only: ## for section headers, ** for bold, - for bullets, 1. for ordered steps. Keep total length tight and skimmable. End an analysis with one clear "Do this first" line. (When you've just performed an action, skip the headers — a single confirming sentence is best.)

You are educational guidance, not licensed financial/tax/legal advice — mention this at most once, lightly, only when it genuinely matters.`;

// Tools the coach can call. The actual mutations run CLIENT-SIDE (that's where
// the user's state lives) — the server just relays the tool_use blocks to the
// browser, which executes them against `state` via the same functions the
// buttons use, then sends back tool_result blocks for a confirming reply.
const TOOLS = [
  {
    name: "log_card_payment",
    description: "Log a payment toward a credit card or debt, reducing its tracked balance. Use when the user says they paid, or want to log a payment, on a card/debt.",
    input_schema: {
      type: "object",
      properties: {
        bill_name: { type: "string", description: "Name of the card/debt as it appears in the user's bills (fuzzy match ok), e.g. 'Home Depot', 'Visa'." },
        amount: { type: "number", description: "Payment amount in dollars (positive)." },
        kind: { type: "string", enum: ["extra", "min"], description: "Payment type. 'extra' (default) for an extra/lump payment, 'min' for the scheduled minimum." },
      },
      required: ["bill_name", "amount"],
    },
  },
  {
    name: "move_planned_payment",
    description: "In the payday plan, push a bill's upcoming planned payment to the next paycheck (direction 'later'), or move a previously-pushed one back to its due date (direction 'back'). This reschedules within the plan; it does NOT log a payment.",
    input_schema: {
      type: "object",
      properties: {
        bill_name: { type: "string", description: "Name of the bill, e.g. 'Visa', 'Rent'." },
        direction: { type: "string", enum: ["later", "back"], description: "'later' pushes to the next paycheck; 'back' undoes a push." },
        occurrence_date: { type: "string", description: "Optional ISO date (YYYY-MM-DD) of the specific occurrence to move. Omit to use the next upcoming one." },
      },
      required: ["bill_name", "direction"],
    },
  },
  {
    name: "set_bill_paid",
    description: "Mark a bill's payment for a month as paid (paid=true) or not paid (paid=false) in the payday plan. A bill marked paid is excluded from that month's plan.",
    input_schema: {
      type: "object",
      properties: {
        bill_name: { type: "string", description: "Name of the bill." },
        paid: { type: "boolean", description: "true to mark paid, false to un-mark." },
        month: { type: "string", description: "Optional month as YYYY-MM. Defaults to the plan's current month." },
      },
      required: ["bill_name", "paid"],
    },
  },
  {
    name: "set_bank_balance",
    description: "Set the user's current bank/checking balance to a specific dollar amount. Use only when the user explicitly tells you their balance or asks to set it. (If a bank is connected via Plaid, mention it normally syncs automatically.)",
    input_schema: {
      type: "object",
      properties: { amount: { type: "number", description: "New bank balance in dollars." } },
      required: ["amount"],
    },
  },
  {
    name: "fund_goal",
    description: "Add money to (or remove from, with a negative amount) a savings goal or the emergency fund — updates the saved amount.",
    input_schema: {
      type: "object",
      properties: {
        goal_name: { type: "string", description: "Goal name, or 'emergency' / 'emergency fund' for the emergency fund." },
        amount: { type: "number", description: "Dollars to add (use a negative number to remove)." },
      },
      required: ["goal_name", "amount"],
    },
  },
  {
    name: "set_commission",
    description: "Set the commission amount for a month. Commission is variable income added to that month's last paycheck (it does NOT carry to other months). Use when the user tells you their commission for a month, e.g. 'my commission this month is $7,000'. Set to 0 to clear it.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Commission amount in dollars for the month (0 clears it)." },
        month: { type: "string", description: "Optional month as YYYY-MM. Defaults to the plan's current month." },
      },
      required: ["amount"],
    },
  },
];

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

  // The snapshot is large (especially with the transaction feed) and stable
  // within a chat session, so it rides as a CACHED system block — not appended
  // to each user turn. Prompt caching then bills it at ~10% on follow-up turns
  // instead of re-sending it at full price every message. It's still rebuilt
  // fresh each turn client-side, so identical rebuilds hit the cache and a real
  // data change (a re-sync) misses once and re-caches. Conversation history +
  // the new question are the small, uncached suffix.
  // On a tool-loop follow-up the client sends the FULL evolving messages array
  // (incl. structured tool_use / tool_result blocks) and no new question — we
  // forward it as-is. On a normal turn we build text history + the new question.
  const isFollowup = !!(body && body.toolFollowup);

  const messages = [];
  history.slice(-MAX_MESSAGES).forEach(m => {
    if (!m) return;
    const role = m.role === "assistant" ? "assistant" : "user";
    if (Array.isArray(m.content)) { messages.push({ role, content: m.content }); return; } // tool blocks pass through
    const content = String(m.content || "").slice(0, 8000);
    if (content) messages.push({ role, content });
  });

  const snapshotJSON = JSON.stringify(snapshot).slice(0, 90000);
  if (!isFollowup) {
    const turn = userText
      || "Analyze my budget and credit picture. Give me a clear read on where I stand and the most important moves to make right now.";
    messages.push({ role: "user", content: turn });
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
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT },
        tools: TOOLS,
        // Two cache breakpoints (prompt caching is GA on Opus 4.8 — no beta
        // header). The frozen prompt is < the 4096-token cache minimum so it
        // won't cache standalone, but prompt + snapshot clears it and caches —
        // so the heavy snapshot is billed at ~10% on repeat turns in a session.
        // 1-hour TTL keeps the cache warm across longer pauses mid-conversation
        // (2x write cost vs the 5-min default; pays off from ~3 turns).
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } },
          { type: "text", text: "The user's current financial snapshot (JSON) — reason over these exact numbers:\n" + snapshotJSON, cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
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
    // Cache telemetry: read>0 on follow-up turns means the snapshot is being
    // served from cache (~10% cost) instead of re-billed in full.
    const u = (data && data.usage) || {};
    console.log("advisor usage: cache_read=" + (u.cache_read_input_tokens || 0) +
      " cache_write=" + (u.cache_creation_input_tokens || 0) +
      " input=" + (u.input_tokens || 0) + " output=" + (u.output_tokens || 0));
    const reply = Array.isArray(data.content)
      ? data.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim()
      : "";

    // Return the raw content blocks + stop_reason too, so the client can detect
    // tool_use, run the action locally, and continue the loop. `reply` stays for
    // the simple text path (and older callers).
    return sendJSON(res, 200, {
      reply: reply,
      content: Array.isArray(data.content) ? data.content : [],
      stop_reason: data.stop_reason || null,
    });
  } catch (e) {
    console.error("Advisor handler error", e && e.message);
    return sendJSON(res, 502, { error: "Couldn't reach the advisor. Please try again." });
  }
};

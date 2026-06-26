/* /api/household/members — manage household family members (owner-only).
 *   GET    -> list members of the caller's household
 *   POST   -> add a member { name, email, password }  (creates a login)
 *   DELETE -> remove a member { member_id }
 *
 * Creating logins needs the Supabase service role key, which must stay
 * server-side — never shipped to the browser. Zero dependencies. */
"use strict";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://vqhuudfrtuurxfismbph.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_IUyRTgtGyYkAebmQIwODmA_gl2noPax";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_MEMBERS = 6; // owner + up to 5 family

function sendJSON(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}
function svc() {
  if (!SERVICE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" };
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let d = "";
    req.on("data", c => { d += c; if (d.length > 64 * 1024) req.destroy(); });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

// Verify the caller's session and resolve their household + role (service role
// read so we get role/household even though the user only signed a session).
async function verifyCaller(authHeader) {
  const token = String(authHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: SUPABASE_ANON_KEY },
    });
    if (!r.ok) return null;
    const user = await r.json();
    if (!user || !user.id) return null;
    const m = await fetch(
      SUPABASE_URL + "/rest/v1/household_members?member_id=eq." + encodeURIComponent(user.id) + "&select=household_id,role",
      { headers: svc() }
    );
    const rows = m.ok ? await m.json() : [];
    if (!rows.length) return null; // not part of any household
    return { id: user.id, email: (user.email || "").toLowerCase(), householdId: rows[0].household_id, role: rows[0].role };
  } catch (e) { return null; }
}

async function listMembers(householdId) {
  const r = await fetch(
    SUPABASE_URL + "/rest/v1/household_members?household_id=eq." + encodeURIComponent(householdId) +
    "&select=member_id,name,email,role&order=role.desc,name.asc",
    { headers: svc() }
  );
  return r.ok ? await r.json() : [];
}

module.exports = async function handler(req, res) {
  if (!SERVICE_KEY) return sendJSON(res, 500, { error: "Family management isn't configured (missing service key)." });
  const caller = await verifyCaller(req.headers && req.headers.authorization);
  if (!caller) return sendJSON(res, 401, { error: "Sign in to manage your household." });

  // ---- list ----
  if (req.method === "GET") {
    const members = await listMembers(caller.householdId);
    return sendJSON(res, 200, { members: members, role: caller.role, isAdmin: caller.role === "admin", max: MAX_MEMBERS });
  }

  // Mutations are admin-only.
  if (caller.role !== "admin") return sendJSON(res, 403, { error: "Only an admin can manage family members." });

  // ---- add ----
  if (req.method === "POST") {
    const body = await readBody(req);
    const name = String((body && body.name) || "").trim();
    const email = String((body && body.email) || "").trim().toLowerCase();
    const password = String((body && body.password) || "");
    const role = ["editor", "viewer"].indexOf(String((body && body.role) || "")) >= 0 ? body.role : "editor";
    if (!name) return sendJSON(res, 400, { error: "Enter the family member's name." });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJSON(res, 400, { error: "Enter a valid email address." });
    if (password.length < 8) return sendJSON(res, 400, { error: "Password must be at least 8 characters." });

    const existing = await listMembers(caller.householdId);
    if (existing.length >= MAX_MEMBERS) {
      return sendJSON(res, 400, { error: "You've reached the limit of " + (MAX_MEMBERS - 1) + " family members." });
    }
    if (existing.some(m => (m.email || "").toLowerCase() === email)) {
      return sendJSON(res, 400, { error: "That email is already in your household." });
    }

    try {
      // 1) pre-authorize the email so the signup trigger allows the account.
      await fetch(SUPABASE_URL + "/rest/v1/allowed_emails", {
        method: "POST",
        headers: Object.assign(svc(), { Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({ email: email }),
      });
      // 2) create the login (email pre-confirmed so they can sign in immediately).
      const cr = await fetch(SUPABASE_URL + "/auth/v1/admin/users", {
        method: "POST",
        headers: svc(),
        body: JSON.stringify({ email: email, password: password, email_confirm: true, user_metadata: { name: name } }),
      });
      const created = await cr.json().catch(() => ({}));
      if (!cr.ok || !created.id) {
        const msg = (created && (created.msg || created.message || created.error_description)) || "";
        if (/already.*regist|exists/i.test(msg)) return sendJSON(res, 400, { error: "An account with that email already exists." });
        console.error("createUser failed", cr.status, JSON.stringify(created));
        return sendJSON(res, 502, { error: "Couldn't create that login. Check the email and try again." });
      }
      // 3) add them to this household.
      const ins = await fetch(SUPABASE_URL + "/rest/v1/household_members", {
        method: "POST",
        headers: Object.assign(svc(), { Prefer: "return=minimal" }),
        body: JSON.stringify({ member_id: created.id, household_id: caller.householdId, name: name, email: email, role: role }),
      });
      if (!ins.ok) {
        // best-effort rollback of the orphaned auth user
        await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + created.id, { method: "DELETE", headers: svc() }).catch(() => {});
        console.error("membership insert failed", ins.status, await ins.text().catch(() => ""));
        return sendJSON(res, 502, { error: "Couldn't add them to your household. Try again." });
      }
      return sendJSON(res, 200, { ok: true, member: { member_id: created.id, name: name, email: email, role: role } });
    } catch (e) {
      console.error("add member error", e && e.message);
      return sendJSON(res, 502, { error: "Something went wrong adding that member." });
    }
  }

  // ---- change role ----
  if (req.method === "PATCH") {
    const body = await readBody(req);
    const memberId = String((body && body.member_id) || "").trim();
    const role = String((body && body.role) || "");
    if (["editor", "viewer"].indexOf(role) < 0) return sendJSON(res, 400, { error: "Role must be editor or viewer." });
    if (!memberId) return sendJSON(res, 400, { error: "Missing member." });
    if (memberId === caller.householdId) return sendJSON(res, 400, { error: "The admin's role can't be changed." });
    const existing = await listMembers(caller.householdId);
    if (!existing.find(m => m.member_id === memberId)) return sendJSON(res, 404, { error: "That member isn't in your household." });
    const r = await fetch(SUPABASE_URL + "/rest/v1/household_members?member_id=eq." + encodeURIComponent(memberId),
      { method: "PATCH", headers: Object.assign(svc(), { Prefer: "return=minimal" }), body: JSON.stringify({ role: role }) });
    if (!r.ok) return sendJSON(res, 502, { error: "Couldn't update that member's role." });
    return sendJSON(res, 200, { ok: true });
  }

  // ---- remove ----
  if (req.method === "DELETE") {
    const body = await readBody(req);
    const memberId = String((body && body.member_id) || "").trim();
    if (!memberId) return sendJSON(res, 400, { error: "Missing member." });
    if (memberId === caller.householdId) return sendJSON(res, 400, { error: "You can't remove the household owner." });

    const existing = await listMembers(caller.householdId);
    const target = existing.find(m => m.member_id === memberId);
    if (!target) return sendJSON(res, 404, { error: "That member isn't in your household." });

    try {
      // Deleting the auth user cascades their household_members + own rows.
      await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + encodeURIComponent(memberId), { method: "DELETE", headers: svc() });
      if (target.email) {
        await fetch(SUPABASE_URL + "/rest/v1/allowed_emails?email=eq." + encodeURIComponent(target.email),
          { method: "DELETE", headers: Object.assign(svc(), { Prefer: "return=minimal" }) }).catch(() => {});
      }
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      console.error("remove member error", e && e.message);
      return sendJSON(res, 502, { error: "Couldn't remove that member." });
    }
  }

  return sendJSON(res, 405, { error: "Method not allowed" });
};

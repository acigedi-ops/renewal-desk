// Cloudflare Worker in front of the static site. Everything except /api/* is served from dist/ as before.
// POST /api/outbox/send {id}: sends outbox/<id> from Eduard's Gmail when he taps "Approve & send".
// Only a signed-in Supabase user can call it, and it only sends what is already in the outbox table,
// read with that user's own token, so it can't be used as an open mail relay.
// POST /api/chat: one step of the Assistant chat (worker/chat.js). It only looks things up; it can't send or change anything.
import {connect} from "cloudflare:sockets";
import {buildMime, smtpSend} from "./mail.js";
import {bodyHtml} from "./signature.js";
import {chat} from "./chat.js";

const json = (status, body) => new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    if (url.pathname === "/api/outbox/send"){
      if (request.method !== "POST") return json(405, {error: "POST only"});
      try { return await send(request, env); }
      catch (e){ return json(500, {error: String(e?.message || e)}); }
    }
    if (url.pathname === "/api/chat"){
      if (request.method !== "POST") return json(405, {error: "POST only"});
      try { return await chat(request, env, supabase); }
      catch (e){ return json(500, {error: String(e?.message || e)}); }
    }
    if (url.pathname.startsWith("/api/")) return json(404, {error: "not found"});
    return env.ASSETS.fetch(request);
  }
};

async function send(request, env){
  // Same-origin only: the site itself is the only caller.
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json(403, {error: "wrong origin"});
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, {error: "sign in first"});
  const sb = supabase(env, token);
  const who = await sb("GET", "/auth/v1/user");
  if (!who.ok) return json(401, {error: "sign in again"});

  const {id} = await request.json().catch(() => ({}));
  if (!id || typeof id !== "string") return json(400, {error: "missing id"});
  if (!env.GMAIL_APP_PASSWORD) return json(503, {error: "Gmail isn't connected yet: add the GMAIL_APP_PASSWORD secret in Cloudflare."});

  const rows = await (await sb("GET", `/rest/v1/docs?select=data&collection=eq.outbox&id=eq.${encodeURIComponent(id)}`)).json();
  const item = rows?.[0]?.data;
  if (!item) return json(404, {error: "no such email"});
  if (!["pending", "failed"].includes(item.status)) return json(409, {error: `already ${item.status}`});
  const to = list(item.to), cc = list(item.cc);
  if (!to.length) return json(400, {error: "add a recipient"});
  const bad = [...to, ...cc].find(a => !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(a));
  if (bad) return json(400, {error: `not an email address: ${bad}`});

  // Claim it, so a double tap can't send twice: the write only matches while the status is still pending/failed.
  // Only "pending" and "failed" can be sent. "unsure" (it may have gone out) needs Eduard to check his Sent mail first.
  const claim = await sb("PATCH", `/rest/v1/docs?collection=eq.outbox&id=eq.${encodeURIComponent(id)}&data->>status=in.(pending,failed)`,
    {data: {...item, status: "sending", error: "", claimed_at: new Date().toISOString()}, updated_at: new Date().toISOString()}, {Prefer: "return=representation"});
  if (!claim.ok || !(await claim.json()).length) return json(409, {error: "already being sent"});

  // Save the outcome, retrying a few times: once Gmail has the email, losing the "sent" mark would invite a second send.
  const finish = async patch => {
    for (let i = 0; i < 3; i++){
      try {
        const r = await sb("POST", "/rest/v1/rpc/merge_doc", {p_collection: "outbox", p_id: id, p_patch: patch});
        if (r.ok) return true;
      } catch {}
      await new Promise(ok => setTimeout(ok, 500 * (i + 1)));
    }
    return false;
  };
  let sent;
  try {
    const attachments = [];
    for (const a of item.attachments || []){
      const path = String(a.url || "").replace(/^\/coi\//, "");
      if (!path || path === a.url) throw new Error(`attachment ${a.file || ""} has no stored file`);
      const r = await sb("GET", `/storage/v1/object/authenticated/cois/${path.split("/").map(encodeURIComponent).join("/")}`);
      if (!r.ok) throw new Error(`could not load attachment ${a.file || path} (${r.status})`);
      attachments.push({filename: a.file || path.split("/").pop(), contentType: r.headers.get("Content-Type") || "application/pdf", bytes: new Uint8Array(await r.arrayBuffer())});
    }
    const from = env.GMAIL_USER;
    const data = buildMime({from, fromName: env.FROM_NAME, to, cc, subject: item.subject, body: item.body, html: bodyHtml(item.body), attachments});
    const socket = connect({hostname: "smtp.gmail.com", port: 465}, {secureTransport: "on"});
    const result = await smtpSend(socket, {user: from, pass: env.GMAIL_APP_PASSWORD.replace(/\s+/g, ""), from, rcpts: [...to, ...cc], data});
    sent = {status: "sent", sent_at: new Date().toISOString(), sent_by: who.user?.email || "", smtp: result.slice(0, 200), error: ""};
  } catch (e){
    const error = String(e?.message || e).slice(0, 500);
    if (e?.maybeSent){
      // Gmail got the whole email but we never heard back: it may well have gone out, so it must not be sendable again by one tap.
      await finish({status: "unsure", error, unsure_at: new Date().toISOString()});
      return json(502, {error: `It may have gone out (${error}). Check your Sent mail before sending again.`, unsure: true});
    }
    await finish({status: "failed", error, failed_at: new Date().toISOString()});
    return json(502, {error});
  }
  // Sent. If saving that fails even after retries, it stays "sending" and the Outbox shows it as "check your Sent mail".
  if (!(await finish(sent))) return json(200, {...sent, warning: "Sent, but the Outbox couldn't save it as sent."});
  return json(200, sent);
}

const list = v => (Array.isArray(v) ? v : String(v || "").split(/[,;\s]+/)).map(s => String(s).trim()).filter(Boolean);

// Supabase calls made as the signed-in user (publishable key + their access token), so table and bucket rules still apply.
function supabase(env, token){
  return async (method, path, body, headers = {}) => {
    const r = await fetch(env.SUPABASE_URL + path, {method,
      headers: {apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}`, ...(body ? {"Content-Type": "application/json"} : {}), ...headers},
      body: body ? JSON.stringify(body) : undefined});
    if (path === "/auth/v1/user" && r.ok) r.user = await r.clone().json();
    return r;
  };
}

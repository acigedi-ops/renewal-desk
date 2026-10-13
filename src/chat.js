// Assistant: a chat box where Eduard types what he needs ("COI for Proper Foundation", "unpaid invoices", "what expires this month")
// and Claude finds it. The "Ask" button (bottom right) opens it. Answers come with buttons to open the client card, the PDF,
// or copy an invoice link for Eduard to paste himself.
// How it works: /api/chat (worker/chat.js) holds the API key and passes the conversation to Claude. When Claude asks to look
// something up, this file answers from the data the app already has loaded and sends the result back. Every tool here only
// reads: the chat can't send an email, a text or a link, and can't change any data.
// Kept out of src/app.html, which the L&I routine overwrites; build.mjs loads this after the app.
(() => {
  const q = s => document.querySelector(s);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const low = s => String(s ?? "").toLowerCase();
  const dig = s => String(s ?? "").replace(/\D/g, "");
  const money = n => n === "" || n == null || isNaN(n) ? "" : "$" + Number(n).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const day = d => /^\d{4}-\d\d-\d\d/.test(d || "") ? new Date(String(d).slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric"}) : (d || "");
  const today = () => new Date().toLocaleDateString("en-CA");
  const COLS = ["clients", "files", "invoices", "renewals", "tasks", "sos", "qtax", "qtaxq"];
  const data = Object.fromEntries(COLS.map(k => [k, []]));
  const MAX_STEPS = 10, MAX_RESULT = 30000, MAX_HISTORY = 350000;
  const KEY = "rd-chat-v1";
  let messages = [], view = [], busy = false, isOpen = false, loading = null;

  // ---- Data: the same live collections the rest of the app uses ----
  function load(){
    return loading || (loading = (async () => {
      const db = await window.claude?.use?.("db"); if (!db) throw new Error("not connected");
      await Promise.all(COLS.map(k => new Promise(ok => {
        let first = true;
        db.collection(k).onSnapshot(s => { data[k] = s.docs.map(d => ({id: d.id, ...d.data()})); if (first){ first = false; ok(); } }, () => { if (first){ first = false; ok(); } });
      })));
    })());
  }

  // ---- Lookups Claude can ask for (read only) ----
  const STOP = new Set(["llc", "inc", "co", "corp", "the", "for", "and", "of", "coi", "cois", "certificate", "certificates", "cert", "invoice", "invoices", "policy", "policies", "client", "find", "show", "me", "my", "a", "an"]);
  const words = s => low(s).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2 && !STOP.has(w));
  const normName = s => low(s).replace(/\b(llc|inc|corp|co|ltd|dba)\b/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const coiRef = x => x.asset_id || x.file || x.url || "";
  const clientById = id => data.clients.find(c => c.id === id) || data.clients.find(c => low(c.id) === low(id) || low(c.license) === low(id));
  const sameBiz = (a, b) => { const x = normName(a), y = normName(b); return !!x && !!y && (x === y || (x.length > 4 && y.includes(x)) || (y.length > 4 && x.includes(y))); };
  const isDate = s => /^\d{4}-\d\d-\d\d/.test(s || "");
  const latestQuarter = () => { const d = new Date(); let y = d.getFullYear(), n = Math.floor(d.getMonth() / 3); if (!n){ n = 4; y--; } return `${y}-Q${n}`; };
  const cut = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };

  function match(term, fields){
    const ws = words(term), d = dig(term), hay = low(fields.filter(Boolean).join(" | ")), hd = dig(hay);
    if (d.length >= 4 && hd.includes(d)) return 99;
    if (!ws.length) return 0;
    const n = ws.filter(w => hay.includes(w)).length;
    return n === ws.length ? 50 + n : n;
  }

  const tools = {
    search({query}){
      const hits = [];
      const add = (score, hit) => score && hits.push({score, ...hit});
      for (const c of data.clients){
        add(match(query, [c.name, c.license, c.ubi, c.contact?.name, c.contact?.phone, c.contact?.email, c.address, ...(c.policies || []).map(p => p.number), c.lni?.insurance?.number, c.lni?.bond?.number]),
          {type: "client", id: c.id, name: c.name, license: c.license, ubi: c.ubi, phone: c.contact?.phone || undefined});
        for (const x of c.cois || [])
          add(match(query, [x.holder, x.policy, x.file]), {type: "coi", client_id: c.id, client: c.name, ref: coiRef(x), holder: x.holder, policy: x.policy, insurer: x.insurer, expires: x.expiration, issued: x.cert_date || x.email_date});
      }
      for (const f of data.files) if (!f.removed_at){
        const c = clientById(f.client_id);
        add(match(query, [f.name, f.kind, c?.name]), {type: "document", id: f.id, client_id: f.client_id, client: c?.name, name: f.name, kind: f.kind, added: f.at});
      }
      for (const v of data.invoices)
        add(match(query, [v.customer, v.number && "invoice " + v.number, v.description]), {type: "invoice", id: v.id, number: v.number, customer: v.customer, amount: v.amount, balance: v.balance, status: v.status, due: v.due});
      for (const b of data.sos)
        add(match(query, [b.name, b.ubi, b.sos?.name, ...(b.sos?.governors || [])]), {type: "sos", ubi: b.ubi || b.id, name: b.sos?.name || b.name, status: b.sos?.status, ar_due: b.sos?.ar_due});
      for (const p of data.qtax)
        add(match(query, [p.name, p.phone]), {type: "qtax", id: p.id, name: p.name, phone: p.phone, removed: p.active === false || undefined, do_not_text: p.do_not_text || undefined});
      for (const k of data.tasks) if (k.status !== "done")
        add(match(query, [k.who, k.phone, k.title, k.detail]), {type: "todo", who: k.who, title: k.title, at: k.at});
      const best = Math.max(0, ...hits.map(x => x.score));
      // When some hits match every word, drop the ones that only match some.
      const list = hits.filter(x => best >= 50 ? x.score >= 50 : true).sort((a, b) => b.score - a.score).slice(0, 40).map(({score, ...x}) => x);
      return list.length ? {results: list} : {results: [], note: "Nothing matched. Try fewer or different words, or part of the name."};
    },

    get_client({id}){
      const c = clientById(id);
      if (!c) return {error: "No client with that id. Use search first."};
      const name = c.name;
      return {
        id: c.id, name, license: c.license, ubi: c.ubi, address: c.address, contact: c.contact, followup: c.followup?.date ? c.followup : undefined,
        lni: c.lni, notes: (c.notes || []).slice(-10),
        policies: (c.policies || []).map(p => ({type: p.type, number: p.number, carrier: p.carrier, producer: p.producer, status: p.status, effective: p.effective, expiration: p.expiration, premium: p.premium, notes: cut(p.notes, 300)})),
        certificates: (c.cois || []).map(x => ({ref: coiRef(x), holder: x.holder, policy: x.policy, insurer: x.insurer, effective: x.effective, expires: x.expiration, issued: x.cert_date || x.email_date, kind: x.kind === "generated" ? "made in the app" : "from email", each_occurrence: x.each_occurrence, aggregate: x.general_aggregate})),
        documents: data.files.filter(f => f.client_id === c.id && !f.removed_at).map(f => ({id: f.id, name: f.name, kind: f.kind, added: f.at})),
        invoices: data.invoices.filter(v => sameBiz(v.customer, name)).map(v => ({id: v.id, number: v.number, amount: v.amount, balance: v.balance, status: v.status, date: v.date, due: v.due, description: v.description})),
        sos: data.sos.filter(b => c.ubi && dig(b.ubi || b.id) === dig(c.ubi)).map(b => ({status: b.sos?.status, ar_due: b.sos?.ar_due, agent: b.sos?.agent, governors: b.sos?.governors})),
        renewals: data.renewals.filter(r => r.client_id === c.id).map(r => ({label: r.label, number: r.number, ends: r.ends, carrier: r.carrier, steps: r.steps, cancel: r.cancel})),
        open_todos: data.tasks.filter(k => k.status !== "done" && (k.client_id === c.id || sameBiz(k.who, name))).map(k => ({title: k.title, who: k.who, at: k.at}))
      };
    },

    list_invoices({status = "unpaid", customer}){
      const t = today();
      let list = data.invoices.filter(v => status === "all" || (status === "overdue" ? v.status === "unpaid" && v.due && v.due < t : v.status === status));
      if (customer) list = list.filter(v => low(v.customer).includes(low(customer)) || sameBiz(v.customer, customer));
      list.sort((a, b) => String(a.due).localeCompare(String(b.due)));
      const owed = list.filter(v => v.status === "unpaid").reduce((s, v) => s + Number(v.balance || 0), 0);
      return {count: list.length, total_owed: Math.round(owed * 100) / 100, synced_at: data.invoices.map(v => v.synced_at).sort().pop(),
        invoices: list.slice(0, 60).map(v => ({id: v.id, number: v.number, customer: v.customer, amount: v.amount, balance: v.balance, status: v.status, date: v.date, due: v.due, description: v.description || undefined, client_link_saved: /^https:/.test(v.share_link || "")}))};
    },

    expiring({days = 30, past = false}){
      const t = today(), lim = new Date(Date.now() + (past ? -1 : 1) * days * 864e5).toLocaleDateString("en-CA");
      const inRange = d => isDate(d) && (past ? d < t && d >= lim : d >= t && d <= lim);
      const out = [], seen = new Set();
      const add = x => { const k = [x.client_id, x.what, x.number, x.ends].join("|"); if (!seen.has(k)){ seen.add(k); out.push(x); } };
      for (const c of data.clients){
        for (const p of c.policies || []) if (!/cancel/i.test(p.status || "") && inRange(p.expiration))
          add({client_id: c.id, client: c.name, what: p.type || "Policy", number: p.number, carrier: p.carrier, ends: p.expiration});
        const l = c.lni || {};
        if (inRange(l.insurance?.expiration)) add({client_id: c.id, client: c.name, what: "L&I insurance on file", number: l.insurance.number, carrier: l.insurance.carrier, ends: l.insurance.expiration});
        if (inRange(l.bond?.expiration)) add({client_id: c.id, client: c.name, what: "L&I bond", number: l.bond.number, carrier: l.bond.carrier, ends: l.bond.expiration});
        if (inRange(l.registration?.expires)) add({client_id: c.id, client: c.name, what: "L&I contractor registration", number: c.license, ends: l.registration.expires});
      }
      for (const r of data.renewals) if (inRange(r.ends))
        add({client_id: r.client_id, client: r.client, what: r.label || "Renewal", number: r.number, carrier: r.carrier, ends: r.ends, renewal_steps_done: r.steps && Object.keys(r.steps)});
      out.sort((a, b) => a.ends.localeCompare(b.ends));
      return {count: out.length, items: out.slice(0, 80)};
    },

    list_tasks({status = "open", category = "any"}){
      const list = data.tasks.filter(k => (status === "done" ? k.status === "done" : k.status !== "done") && (category === "any" || k.category === category))
        .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || String(b.at).localeCompare(String(a.at)));
      return {count: list.length, tasks: list.slice(0, 50).map(k => ({title: k.title, who: k.who, phone: k.phone, detail: cut(k.detail, 200), category: k.category, urgent: !!k.urgent, at: k.at, source: k.source}))};
    },

    qtax({quarter, name}){
      const k = /^\d{4}-Q[1-4]$/.test(quarter || "") ? quarter : latestQuarter(), key = "q_" + k.replace("-", "");
      let people = data.qtax.filter(p => p.active !== false);
      if (name) people = people.filter(p => match(name, [p.name, p.phone]) > 0);
      const rows = people.map(p => { const a = data.qtaxq.find(x => x.id === `${p.id}_${k}`) || {}, s = p[key] || {};
        return {name: p.name, phone: p.phone, status: s.status || "not asked", income: a.income ?? undefined, tax: a.tax ?? undefined,
          reported_income: a.reported_income || undefined, reply_check: a.reported_status || undefined, do_not_text: p.do_not_text || undefined}; });
      const count = st => rows.filter(r => r.status === st).length;
      return {quarter: k, people: rows.length, sent_income_to_file: count("received"), asked_no_reply: count("asked"), filed: count("filed") + count("paid"), not_asked: count("not asked"), list: name || rows.length <= 80 ? rows : rows.slice(0, 80)};
    },

    sos({query, status}){
      let list = data.sos;
      if (query) list = list.filter(b => match(query, [b.name, b.ubi, b.sos?.name]) > 0);
      if (status === "ar_due_60"){ const lim = new Date(Date.now() + 60 * 864e5).toLocaleDateString("en-CA"); list = list.filter(b => isDate(b.sos?.ar_due) && b.sos.ar_due <= lim); }
      else if (status) list = list.filter(b => low(b.sos?.status).includes(low(status)) || (low(status).includes("not") && b.sos?.found === false));
      return {count: list.length, businesses: list.slice(0, 60).map(b => ({ubi: b.ubi || b.id, name: b.sos?.name || b.name, status: b.sos?.found === false ? "not found" : b.sos?.status, ar_due: b.sos?.ar_due, checked: b.sos?.checked_at}))};
    }
  };

  // The show tool: turns ids into buttons under the answer.
  function card(it){
    if (it.type === "client"){ const c = clientById(it.id); if (!c) return null;
      return {kind: "client", client_id: c.id, title: c.name, sub: [c.license, c.contact?.phone].filter(Boolean).join(" · ")}; }
    if (it.type === "coi"){ const c = clientById(it.client_id); const x = (c?.cois || []).find(x => coiRef(x) === it.ref); if (!x) return null;
      return {kind: "coi", client_id: c.id, title: `Certificate · ${cut(x.holder || c.name, 70)}`, sub: [c.name, x.policy, x.expiration && "ends " + day(x.expiration)].filter(Boolean).join(" · "), url: x.url}; }
    if (it.type === "document"){ const f = data.files.find(f => f.id === it.id && !f.removed_at); if (!f) return null;
      return {kind: "doc", client_id: f.client_id, title: `${f.kind || "Document"} · ${cut(f.name, 70)}`, sub: clientById(f.client_id)?.name || "", url: f.url}; }
    if (it.type === "invoice"){ const v = data.invoices.find(v => v.id === it.id || String(v.number) === String(it.id)); if (!v) return null;
      return {kind: "invoice", title: `Invoice ${v.number} · ${v.customer}`, sub: [v.status === "unpaid" ? money(v.balance) + " due " + day(v.due) : money(v.amount) + " paid", v.description].filter(Boolean).join(" · "),
        share: /^https:\/\//.test(v.share_link || "") ? v.share_link : "", qb: /^https:\/\//.test(v.link || "") ? v.link : ""}; }
    return null;
  }

  function run(name, input, cards){
    try {
      if (name === "show"){
        const made = (input.items || []).map(card).filter(Boolean);
        cards.push(...made);
        return {shown: made.length, missing: (input.items || []).length - made.length || undefined};
      }
      if (!tools[name]) return {error: "unknown tool"};
      let out = JSON.stringify(tools[name](input || {}));
      if (out.length > MAX_RESULT) out = out.slice(0, MAX_RESULT) + ' …(cut: too long. Narrow it down.)';
      return out;
    } catch (e){ return {error: String(e?.message || e)}; }
  }

  // ---- Talking to /api/chat ----
  async function ask(body){
    const {data: s} = await window.rdSupabase.auth.getSession();
    const r = await fetch("/api/chat", {method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token || ""}`}, body: JSON.stringify(body)});
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(out.error || `error ${r.status}`), {setup: out.setup});
    return out;
  }

  // Keep the history small enough to send: drop whole old exchanges (from one typed question to the next).
  function trim(){
    while (JSON.stringify(messages).length > MAX_HISTORY){
      const next = messages.findIndex((m, i) => i > 0 && m.role === "user" && typeof m.content === "string");
      if (next < 0) break;
      messages = messages.slice(next);
    }
  }

  async function send(text){
    if (busy || !text.trim()) return;
    busy = true;
    const before = messages.length;
    view.push({who: "me", text}); const answer = {who: "ai", text: "", cards: [], working: true}; view.push(answer); render();
    try {
      await load();
      messages.push({role: "user", content: text}); trim();
      for (let step = 0; ; step++){
        if (step >= MAX_STEPS) throw new Error("That took too many steps. Try asking in a simpler way.");
        const out = await ask({messages});
        const content = (out.content || []).filter(b => b.type !== "fallback");
        messages.push({role: "assistant", content});
        const said = content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
        if (out.stop_reason === "tool_use"){
          const results = content.filter(b => b.type === "tool_use").map(b => { const r = run(b.name, b.input, answer.cards);
            return {type: "tool_result", tool_use_id: b.id, content: typeof r === "string" ? r : JSON.stringify(r)}; });
          messages.push({role: "user", content: results});
          if (said) answer.text = said;
          render(); continue;
        }
        if (out.stop_reason === "refusal") answer.text = "Sorry, I can't help with that one.";
        else answer.text = said || answer.text || "I didn't find anything to say. Try asking another way.";
        break;
      }
    } catch (e){
      messages = messages.slice(0, before); // a half-finished exchange would break the next question
      answer.error = e.setup ? "The assistant isn't switched on yet. Eduard: add the Claude key in Cloudflare (see the setup note)." : (e.message === "Failed to fetch" ? "No connection. Check your internet and try again." : e.message);
      answer.retry = text;
    }
    answer.working = false; busy = false;
    save(); render();
  }

  // ---- Screen ----
  document.head.insertAdjacentHTML("beforeend", `<style>
.rdc-fab{position:fixed;right:max(16px, env(safe-area-inset-right, 0px));bottom:calc(env(safe-area-inset-bottom, 0px) + 16px);z-index:25;display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:12px 18px 12px 14px;background:var(--accent);color:var(--accent-ink);font:600 15px/1 var(--body, system-ui);box-shadow:0 6px 20px rgb(0 0 0 / .22);cursor:pointer}
.rdc-fab[hidden]{display:none}
.rdc{position:fixed;z-index:30;right:16px;bottom:16px;width:min(440px, calc(100vw - 32px));height:min(680px, calc(100vh - 32px));display:flex;flex-direction:column;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:16px;box-shadow:0 18px 50px rgb(0 0 0 / .28);overflow:hidden;font-family:var(--body, system-ui)}
.rdc-h{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--surface)}
.rdc-h b{flex:1;font:700 16px var(--display, inherit)}
.rdc-log{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}
.rdc-m{max-width:88%;padding:9px 12px;border-radius:14px;line-height:1.45;font-size:14.5px;overflow-wrap:anywhere}
.rdc-m.me{align-self:flex-end;background:var(--accent);color:var(--accent-ink);border-bottom-right-radius:4px;white-space:pre-wrap}
.rdc-m.ai{align-self:flex-start;background:var(--surface);border:1px solid var(--line);border-bottom-left-radius:4px}
.rdc-m.ai p{margin:0 0 6px}.rdc-m.ai p:last-child{margin:0}.rdc-m.ai ul{margin:4px 0;padding-left:18px}
.rdc-m.err{border-color:var(--red);color:var(--red)}
.rdc-cards{display:grid;gap:6px;margin-top:8px}
.rdc-card{display:grid;gap:6px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--bg)}
.rdc-card b{font-size:13.5px}.rdc-card span{font-size:12.5px;color:var(--muted)}
.rdc-card div{display:flex;flex-wrap:wrap;gap:6px}
.rdc-card .btn{font-size:12.5px;padding:5px 10px;text-decoration:none;color:inherit;cursor:pointer}
.rdc-card .btn.primary{color:var(--accent-ink)}
.rdc-dots{display:inline-flex;gap:4px}.rdc-dots i{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:rdc 1s infinite ease-in-out}
.rdc-dots i:nth-child(2){animation-delay:.15s}.rdc-dots i:nth-child(3){animation-delay:.3s}
@keyframes rdc{0%,80%,100%{opacity:.25}40%{opacity:1}}
.rdc-sug{display:flex;flex-wrap:wrap;gap:6px}
.rdc-sug button{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:6px 11px;font-size:13px;cursor:pointer}
.rdc-f{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line);background:var(--surface);padding-bottom:calc(10px + env(safe-area-inset-bottom, 0px))}
.rdc-f textarea{flex:1;resize:none;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font:16px/1.35 var(--body, system-ui);background:var(--bg);color:var(--ink);max-height:120px}
.rdc-f button{border:0;border-radius:12px;padding:0 16px;background:var(--accent);color:var(--accent-ink);font-weight:700;cursor:pointer}
.rdc-f button:disabled{opacity:.5}
@media (max-width:600px){.rdc{inset:0;width:auto;height:auto;border-radius:0;border:0;padding-top:env(safe-area-inset-top, 0px)}}
</style>`);

  const fab = Object.assign(document.createElement("button"), {type: "button", className: "rdc-fab", title: "Ask the assistant",
    innerHTML: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01"/></svg>Ask`});
  const box = Object.assign(document.createElement("section"), {className: "rdc", hidden: true});
  box.setAttribute("aria-label", "Assistant");
  box.innerHTML = `<div class="rdc-h"><b>Assistant</b><button class="btn" type="button" data-new>New chat</button><button class="btn" type="button" data-close aria-label="Close">Close</button></div>
    <div class="rdc-log" aria-live="polite"></div>
    <form class="rdc-f"><textarea rows="1" placeholder="Ask for a COI, invoice, policy…" aria-label="Message"></textarea><button type="submit">Send</button></form>`;
  const log = box.querySelector(".rdc-log"), input = box.querySelector("textarea"), go = box.querySelector(".rdc-f button");

  const SUGGEST = ["Find the COI for …", "Which invoices are unpaid?", "What expires in the next 30 days?", "Who hasn't sent Qtax income yet?", "What's on my to-do list?"];

  // Light formatting for Claude's answers: paragraphs, bullet lists and **bold**. Everything is escaped first.
  function fmt(t){
    const inline = s => h(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    const bullet = /^\s*([-*•]|\d+\.)\s+/;
    return String(t).split(/\n{2,}/).map(par => {
      let out = "", lines = [], items = [];
      const flush = () => { if (lines.length) out += `<p>${lines.map(inline).join("<br>")}</p>`; if (items.length) out += `<ul>${items.map(l => `<li>${inline(l)}</li>`).join("")}</ul>`; lines = []; items = []; };
      for (const l of par.split("\n")){
        if (bullet.test(l)){ if (lines.length){ const keep = items; items = []; flush(); items = keep; } items.push(l.replace(bullet, "")); }
        else { if (items.length) flush(); lines.push(l); }
      }
      flush();
      return out;
    }).join("");
  }
  function cardHtml(c, i){
    const btns = [];
    if (c.url) btns.push(`<a class="btn primary" href="${h(c.url)}" target="_blank" rel="noopener">Open PDF</a>`);
    if (c.client_id) btns.push(`<button class="btn${c.url ? "" : " primary"}" type="button" data-rdc-open="${h(c.client_id)}">Open client</button>`);
    if (c.kind === "invoice"){
      btns.push(c.share ? `<button class="btn primary" type="button" data-copy="${i}">Copy link</button>` : `<span>No client link saved</span>`);
      if (c.qb) btns.push(`<a class="btn" href="${h(c.qb)}" target="_blank" rel="noopener">Open in QuickBooks</a>`);
    }
    return `<div class="rdc-card"><b>${h(c.title)}</b>${c.sub ? `<span>${h(c.sub)}</span>` : ""}<div>${btns.join("")}</div></div>`;
  }
  function render(){
    if (!isOpen) return;
    const cards = [];
    log.innerHTML = (view.length ? "" : `<div class="rdc-m ai"><p>Hi Eduard. Tell me what you need: a certificate, an invoice, a policy, what's expiring, Qtax. I'll find it and give you buttons to open it.</p><p>I only look things up. I never send anything to anyone.</p></div>
      <div class="rdc-sug">${SUGGEST.map(s => `<button type="button">${h(s)}</button>`).join("")}</div>`) +
      view.map(m => {
        if (m.who === "me") return `<div class="rdc-m me">${h(m.text)}</div>`;
        const cs = (m.cards || []).map(c => { cards.push(c); return cardHtml(c, cards.length - 1); }).join("");
        const body = m.error ? `<p>${h(m.error)}</p><div class="rdc-cards"><button class="btn" type="button" data-retry="${h(m.retry)}">Try again</button></div>`
          : (m.text ? fmt(m.text) : "") + (m.working ? `<p><span class="rdc-dots"><i></i><i></i><i></i></span></p>` : "");
        return `<div class="rdc-m ai${m.error ? " err" : ""}">${body}${cs ? `<div class="rdc-cards">${cs}</div>` : ""}</div>`;
      }).join("");
    log._cards = cards;
    go.disabled = busy;
    log.scrollTop = log.scrollHeight;
  }

  log.addEventListener("click", async e => {
    const s = e.target.closest(".rdc-sug button");
    if (s){ const t = s.textContent; if (t.endsWith("…")){ input.value = t.slice(0, -1); input.focus(); } else send(t); return; }
    const o = e.target.closest("[data-rdc-open]");
    if (o){ close(); window.openClient?.(o.dataset.rdcOpen); return; }
    const r = e.target.closest("[data-retry]");
    if (r){ view = view.filter(m => !m.error); view.pop(); send(r.dataset.retry); return; }
    const c = e.target.closest("[data-copy]");
    if (c){ const link = log._cards?.[+c.dataset.copy]?.share; if (!link) return;
      try { await navigator.clipboard.writeText(link); c.textContent = "Copied"; } catch { prompt("Copy this link:", link); }
      setTimeout(() => { c.textContent = "Copy link"; }, 2000); }
  });
  box.querySelector("form").onsubmit = e => { e.preventDefault(); const t = input.value; if (!t.trim() || busy) return; input.value = ""; grow(); send(t.trim()); };
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing){ e.preventDefault(); box.querySelector("form").requestSubmit(); } });
  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; };
  input.addEventListener("input", grow);
  box.querySelector("[data-close]").onclick = close;
  box.querySelector("[data-new]").onclick = () => { if (busy) return; messages = []; view = []; save(); render(); input.focus(); };
  document.addEventListener("keydown", e => { if (e.key === "Escape" && isOpen) close(); });

  function open(){ isOpen = true; box.hidden = false; fab.hidden = true; render(); load().catch(() => {}); if (matchMedia("(min-width:601px)").matches) input.focus(); }
  function close(){ isOpen = false; box.hidden = true; fab.hidden = false; }
  fab.onclick = open;
  window.rdChat = {open};

  // The conversation survives a reload in this tab (not across devices).
  function save(){ try { sessionStorage.setItem(KEY, JSON.stringify({messages, view: view.filter(m => !m.working)})); } catch {} }
  try { const s = JSON.parse(sessionStorage.getItem(KEY) || "null"); if (s){ messages = s.messages || []; view = s.view || []; } } catch {}

  (async () => {
    // Show the button only once signed in (the sign-in screen sits on top until then).
    for (let i = 0; i < 600 && !window.rdSupabase; i++) await new Promise(r => setTimeout(r, 100));
    document.body.append(fab, box);
  })();
})();

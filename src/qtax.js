// Qtax: quarterly-tax texting and tracking. A third mode next to "Policies" and "SOS status".
// Texts go out from Eduard's own number through Messages on his Mac (mac/texter.js). Nothing is sent until he
// taps "Approve & send": this page only writes drafts and approvals, and the Mac only sends texts marked approved.
// Kept out of src/app.html, which the L&I routine overwrites; build.mjs loads this after the app's own scripts.
// Data (docs table):
//   qtax/<id>         client: {name, phone, active, notes, last_reply: {text, at}, q_2026Q3: {status, asked_at, received_at, reply, followups, last_followup_at, filed_at, paid_at}}
//                     status is "asked" | "received" | "filed" | "paid" (missing = not asked yet)
//   texts/<id>        {client_id, name, phone, body, kind: "ask"|"followup", quarter: "2026-Q3", status, created_at, created_by,
//                      approved_at, sent_at, error}; status: "draft" -> "approved" (his tap) -> "sending" -> "sent" | "failed" | "skipped" | "dismissed"
//   qtaxmeta/settings {ask_template, followup_template}   ({name} = first name, {quarter} = quarter in Ukrainian)
//   qtaxmeta/mac      heartbeat from the Mac: {seen_at, version, can_read, error, quiet}
//   qtaxmeta/responders per phone (last 10 digits): {sent, replied, last_in}, counted by the Mac on request
//   qtaxmeta/discovery group texts the Mac found in his Messages: {scanned_at, requested_at, blasts: [{text, at, recipients: [{phone, name}]}]}
(() => {
  const q = s => document.querySelector(s);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const day = t => t ? new Date(t).toLocaleDateString("en-US", {month: "short", day: "numeric"}) : "";
  const ago = t => { const m = Math.round((Date.now() - new Date(t)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

  // ---- Quarters ----
  // The quarter being filed is the one that just ended (in October, Q3).
  const filingQuarter = (d = new Date()) => { let y = d.getFullYear(), n = Math.floor(d.getMonth() / 3); if (!n){ n = 4; y--; } return `${y}-Q${n}`; };
  const prevQuarter = k => { let y = +k.slice(0, 4), n = +k.slice(-1) - 1; if (!n){ n = 4; y--; } return `${y}-Q${n}`; };
  const qKey = k => "q_" + k.replace("-", "");
  const qLabel = k => `Q${k.slice(-1)} ${k.slice(0, 4)}`;
  const MONTHS_UK = ["", "січень–березень", "квітень–червень", "липень–вересень", "жовтень–грудень"];
  const qUk = k => `${k.slice(-1)}-й квартал ${k.slice(0, 4)} (${MONTHS_UK[+k.slice(-1)]})`;

  // ---- Phones ----
  const digits = p => String(p || "").replace(/\D/g, "");
  const e164 = p => { const d = digits(p); return d.length === 10 ? "+1" + d : d.length === 11 && d[0] === "1" ? "+" + d : d ? "+" + d : ""; };
  const idFor = p => "p" + digits(e164(p)).slice(-10);
  const phoneFmt = p => { const d = digits(p); const t = d.length === 11 && d[0] === "1" ? d.slice(1) : d; return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : p; };

  const DEFAULTS = {
    ask_template: "Привіт! Настав час подавати квартальні податки за {quarter}. Надішліть мені, будь ласка, ваш дохід за цей квартал. Дякую!",
    followup_template: "Нагадую: чекаю на ваш дохід за {quarter}, щоб вчасно подати податки. Дякую!"
  };
  const fill = (tpl, c, k) => String(tpl).replaceAll("{name}", String(c.name || "").trim().split(/\s+/)[0] || "").replaceAll("{quarter}", qUk(k)).replace(/\s+([,!.])/g, "$1");

  const STATUS = [["", "Not asked"], ["asked", "Asked"], ["received", "Got income"], ["filed", "Filed"], ["paid", "Paid"]];
  const OPEN = ["draft", "approved", "sending"];

  let db = null, clients = [], texts = [], settings = {}, mac = null, discovery = null, responders = null;
  let quarter = filingQuarter(), filter = null, editing = null, adding = false;

  // ---- Mode switch: a "Qtax" button next to Policies / SOS status ----
  document.head.insertAdjacentHTML("beforeend", `<style>
.modes .tabs{max-width:460px}
.qrow{display:grid;grid-template-columns:1fr auto;gap:6px 12px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:10px 12px}
.qrow .name{font-weight:600;overflow-wrap:anywhere}.qrow .meta{font-size:12.5px;color:var(--muted)}
.qrow .reply{font-size:13px;border-left:2px solid var(--line);padding-left:8px;margin-top:2px;overflow-wrap:anywhere}
.qrow .acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.qrow select{border:1px solid var(--line);background:var(--surface);border-radius:7px;padding:5px 7px;font-size:13px}
.qrow.off{opacity:.55}.qrow .full{grid-column:1/-1}
.qmac{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;margin-top:4px}
.qwho{display:flex;flex-wrap:wrap;gap:4px}.qwho .chip button{border:0;background:none;padding:0 0 0 4px;color:inherit;font-weight:700}
.qmsg{white-space:pre-wrap;font-size:14px;background:var(--sunk);border-radius:8px;padding:8px 10px}
@media (max-width:520px){.qrow{grid-template-columns:1fr}.qrow .acts{justify-content:flex-start}}
</style>`);
  const btn = Object.assign(document.createElement("button"), {type: "button", role: "tab", textContent: "Qtax"});
  btn.dataset.qmode = "1"; btn.setAttribute("aria-selected", "false");
  const root = Object.assign(document.createElement("div"), {id: "qtaxMode", hidden: true});
  function showQtax(){
    try { localStorage.setItem("rhino-mode", "qtax"); } catch {}
    q("#policyMode").hidden = true; q("#sosMode").hidden = true; root.hidden = false;
    document.querySelectorAll(".modes [role=tab]").forEach(b => b.setAttribute("aria-selected", String(b === btn)));
    if (q("#sheet") && !q("#sheet").hidden) q("#close")?.click();
    render();
  }
  function mount(){
    const tabs = q(".modes .tabs"), sos = q("#sosMode");
    if (!tabs || !sos) return false;
    tabs.append(btn); sos.after(root);
    btn.onclick = showQtax;
    // The app's own Policies / SOS buttons don't know about this mode: step aside when they're tapped.
    tabs.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => { root.hidden = true; btn.setAttribute("aria-selected", "false"); }));
    try { if (localStorage.getItem("rhino-mode") === "qtax") showQtax(); } catch {}
    return true;
  }

  // ---- Helpers over the data ----
  const qOf = c => c[qKey(quarter)] || {};
  const openText = (c, kind) => texts.find(t => t.client_id === c.id && t.quarter === quarter && OPEN.includes(t.status) && (!kind || t.kind === kind));
  const tpl = k => settings[k] || DEFAULTS[k];
  async function draft(c, kind){
    const id = `${kind}-${quarter}-${c.id}-${Date.now().toString(36)}`;
    await db.doc("texts/" + id).set({client_id: c.id, name: c.name, phone: c.phone, kind, quarter,
      body: fill(tpl(kind === "ask" ? "ask_template" : "followup_template"), c, quarter),
      status: "draft", created_at: new Date().toISOString(), created_by: "site"});
  }
  async function inChunks(list, fn){ for (let i = 0; i < list.length; i += 10) await Promise.all(list.slice(i, i + 10).map(fn)); }

  // ---- Render ----
  function render(force){
    if (root.hidden || !db) return;
    if (!force && root.contains(document.activeElement) && document.activeElement.matches("input,textarea")) return; // don't wipe typing
    const active = clients.filter(c => c.active !== false);
    const st = c => qOf(c).status || "";
    const n = {none: active.filter(c => !st(c)).length, asked: active.filter(c => st(c) === "asked").length,
      received: active.filter(c => st(c) === "received").length, done: active.filter(c => ["filed", "paid"].includes(st(c))).length};
    const quarters = [filingQuarter(new Date(Date.now() + 40 * 864e5)), filingQuarter()];
    while (quarters.length < 5) quarters.push(prevQuarter(quarters.at(-1)));
    const qs = [...new Set(quarters)];
    const search = (q("#qq")?.value || "").trim().toLowerCase();
    const shown = clients.filter(c => !filter || (filter === "none" ? !st(c) && c.active !== false : filter === "done" ? ["filed", "paid"].includes(st(c)) : st(c) === filter))
      .filter(c => !search || String(c.name || "").toLowerCase().includes(search) || (digits(search) && digits(c.phone).includes(digits(search))))
      .sort((a, b) => (a.active === false) - (b.active === false) || String(a.name).localeCompare(String(b.name)));
    root.innerHTML = `
  <header class="top">
    <div class="brand"><h1>Quarterly taxes</h1><span class="sub"><select id="qQuarter" aria-label="Quarter" class="btn">${qs.map(k => `<option value="${k}" ${k === quarter ? "selected" : ""}>${qLabel(k)}</option>`).join("")}</select></span></div>
    <div class="tiles sos-tiles">
      ${[["none", "plain", n.none, "Not asked"], ["asked", "amber", n.asked, "Waiting"], ["received", "red", n.received, "To file"], ["done", "ok", n.done, "Filed"]]
        .map(([f, cls, v, label]) => `<button class="tile ${cls === "plain" ? "" : cls}" data-qf="${f}" aria-pressed="${filter === f}"><b>${v}</b><span>${label}</span></button>`).join("")}
    </div>
    <div class="bar">
      <input class="search" id="qq" type="search" placeholder="Search name or phone" aria-label="Search clients" value="${h(q("#qq")?.value || "")}">
      <button class="btn primary" id="qAdd" type="button">+ Clients</button>
    </div>
    ${macLine()}
  </header>
  ${adding ? addForm() : ""}
  ${discoveryCard()}
  ${silentCard(active)}
  ${draftCards(active)}
  ${progressCard()}
  <div class="section-h"><h2>Client list · ${qLabel(quarter)}</h2><span class="notice">${active.length} get the quarter text${clients.length > active.length ? ` · ${clients.length - active.length} removed` : ""}</span></div>
  ${clients.length ? `<div class="list">${shown.map(row).join("") || `<div class="empty">No one matches.</div>`}</div>`
    : `<div class="empty">No Qtax clients yet. Your Mac looks for the people you texted last quarter and offers them here, or tap <b>+ Clients</b> to paste a list.</div>`}
  <p class="foot">Texts go out from your own number through Messages on your Mac, only after you tap Approve &amp; send, and only between 8 am and 9 pm. Replies mark the client as "Got income" automatically.</p>`;
  }

  function macLine(){
    if (!mac?.seen_at) return `<div class="qmac"><span class="chip amber">Mac not set up</span><span class="notice">Texts wait here until Renewal Desk Texter is running on your Mac.</span></div>`;
    const fresh = Date.now() - new Date(mac.seen_at) < 5 * 60000;
    return `<div class="qmac">${fresh ? `<span class="chip ok">Mac connected</span>` : `<span class="chip amber">Mac offline</span>`}
      <span class="notice">checked ${ago(mac.seen_at)}${fresh ? "" : ". Texts go out when your Mac is on"}${mac.quiet ? ". Quiet hours now, sending resumes at 8 am" : ""}</span>
      ${mac.can_read === false ? `<span class="chip red">Can't read replies</span><span class="notice">Turn on Full Disk Access for Renewal Desk Texter in System Settings.</span>` : ""}
      ${mac.error ? `<span class="chip red">${h(mac.error)}</span>` : ""}</div>`;
  }

  function addForm(){
    return `<section class="card" id="qAddCard"><h3>Add clients</h3>
      <form class="form" onsubmit="return false">
        <label class="full">One per line: name, then phone<textarea id="qPaste" rows="5" placeholder="Ivan Petrenko, 253-555-0123&#10;Olena Shevchenko (206) 555-0199"></textarea></label>
      </form>
      <div class="actions"><span class="notice" id="qAddMsg"></span><button class="btn" id="qAddCancel" type="button">Cancel</button><button class="btn primary" id="qAddSave" type="button">Add</button></div></section>`;
  }

  function discoveryCard(){
    const have = new Set(clients.map(c => c.id));
    const blasts = (discovery?.blasts || []).map(b => ({...b, fresh: b.recipients.filter(r => !have.has(idFor(r.phone)))})).filter(b => b.fresh.length);
    if (!blasts.length) return discovery?.requested_at && !(discovery.scanned_at > discovery.requested_at) ? `<div class="empty">Your Mac is looking through your texts for last quarter's clients…</div>` : "";
    return `<div class="section-h"><h2>People you texted before</h2><span class="notice">From your past quarter texts, found by your Mac</span></div>
      <div class="list">${blasts.slice(0, 3).map((b, i) => `<section class="card"><h3><span>${b.recipients.length} people · ${day(b.at)}</span>
        <span><button class="btn primary" data-qblast="${i}" type="button">Add these people</button></span></h3>
        <div class="qmsg">${h(b.text)}</div>
        <span class="notice">${b.fresh.length} new: ${h(b.fresh.slice(0, 12).map(r => r.name || phoneFmt(r.phone)).join(", "))}${b.fresh.length > 12 ? "…" : ""}. "Add these people" puts them on your client list and keeps your wording. Each person still gets their own separate text.</span></section>`).join("")}</div>`;
  }

  // People who got the past quarter texts and never wrote back within 3 weeks (counted on the Mac, qtaxmeta/responders).
  const silentOf = c => { const p = responders?.people?.[digits(c.phone).slice(-10)]; return p && p.sent >= 2 && !p.replied ? p : null; };
  function silentCard(active){
    if (responders?.requested_at && !(responders.scanned_at > responders.requested_at)) return `<div class="empty">Your Mac is checking who answered your past quarter texts…</div>`;
    const list = active.filter(silentOf);
    if (!list.length) return "";
    return `<section class="card"><h3><span>Never answer your quarter texts <span class="chip amber">${list.length}</span></span>
        <span><button class="btn" data-qremovesilent type="button">Remove all ${list.length}</button></span></h3>
      <span class="notice">They got your last ${responders.blasts} quarter texts at least twice and never texted back. Remove the ones who aren't your clients anymore.</span>
      <div class="list">${list.map(c => { const p = silentOf(c); return `<div class="qrow" data-qc="${h(c.id)}"><div><span class="name">${h(c.name || phoneFmt(c.phone))}</span>
        <div class="meta">${h(phoneFmt(c.phone))} · no reply to ${p.sent} texts · ${p.last_in ? `last texted you ${day(p.last_in)} ${new Date(p.last_in).getFullYear()}` : "never texted you"}</div></div>
        <div class="acts"><button class="btn ghost" data-qremove type="button">Remove</button></div></div>`; }).join("")}</div></section>`;
  }

  function draftCards(active){
    const drafts = texts.filter(t => t.status === "draft");
    const asks = drafts.filter(t => t.kind === "ask"), fups = drafts.filter(t => t.kind === "followup");
    const notAsked = active.filter(c => !qOf(c).status && !openText(c));
    const waiting = active.filter(c => qOf(c).status === "asked" && !openText(c));
    const group = (kind, list, title, tkey) => !list.length ? "" : `<section class="card" data-qgroup="${kind}">
      <h3><span>${title} <span class="chip info">${list.length} separate texts</span></span><span class="notice">${h(list[0].quarter ? qLabel(list[0].quarter) : "")}</span></h3>
      ${list[0].note ? `<span class="chip amber">${h(list[0].note)}</span>` : ""}
      ${kind === "ask" && !tpl(tkey).includes("{quarter}") ? `<span class="notice">This is your own wording from last time. Check the months and dates before you approve.</span>` : ""}
      <div class="qmsg">${h(list[0].body)}</div>
      <details><summary class="notice">Change the message</summary><form class="form" onsubmit="return false"><label class="full">Message ({name} = first name, {quarter} = the quarter)
        <textarea rows="4" data-qtpl="${tkey}">${h(tpl(tkey))}</textarea></label></form>
        <div class="actions"><button class="btn" data-qsavetpl="${tkey}" type="button">Save message</button></div></details>
      <div class="qwho">${list.map(t => `<span class="chip plain">${h(t.name || phoneFmt(t.phone))}<button type="button" data-qdrop="${h(t.id)}" aria-label="Don't text ${h(t.name)}">×</button></span>`).join("")}</div>
      <div class="actions"><span class="notice" data-msg>One-on-one: each person gets their own text, never a group chat.</span><button class="btn" data-qdiscard="${kind}" type="button">Discard</button>
        <button class="btn primary" data-qapprove="${kind}" type="button">Approve &amp; send ${list.length} separate text${list.length > 1 ? "s" : ""}</button></div></section>`;
    return `<div class="section-h"><h2>Texts waiting for your OK</h2></div>
      ${group("ask", asks, "Quarter text", "ask_template")}${group("followup", fups, "Reminders", "followup_template")}
      ${!drafts.length ? `<div class="empty">Nothing waiting.</div>` : ""}
      <div class="actions" style="margin-top:8px">
        ${notAsked.length ? `<button class="btn primary" id="qDraftAll" type="button">Draft ${qLabel(quarter)} text for ${notAsked.length}</button>` : ""}
        ${waiting.length ? `<button class="btn" id="qDraftFup" type="button">Draft reminders for ${waiting.length} not answered</button>` : ""}</div>`;
  }

  function progressCard(){
    const live = texts.filter(t => ["approved", "sending"].includes(t.status));
    const failed = texts.filter(t => t.status === "failed");
    if (!live.length && !failed.length) return "";
    return `<section class="card"><h3>Sending from your Mac</h3>
      ${live.length ? `<span class="notice">${live.length} text${live.length > 1 ? "s" : ""} still to go. Your Mac sends them one by one.</span>` : ""}
      ${failed.map(t => `<div class="pol"><span>${h(t.name || phoneFmt(t.phone))} <span class="chip red">Not sent: ${h(t.error || "error")}</span></span>
        <span><button class="btn ghost" data-qretry="${h(t.id)}" type="button">Send again</button><button class="btn ghost" data-qdrop="${h(t.id)}" type="button">Dismiss</button></span></div>`).join("")}</section>`;
  }

  function row(c){
    const s = qOf(c), st = s.status || "";
    const pending = openText(c);
    const meta = [phoneFmt(c.phone), s.asked_at && `asked ${day(s.asked_at)}`, s.followups && `${s.followups} reminder${s.followups > 1 ? "s" : ""}`,
      s.received_at && `income ${day(s.received_at)}`, s.filed_at && `filed ${day(s.filed_at)}`, s.paid_at && `paid ${day(s.paid_at)}`,
      pending && (pending.status === "draft" ? "text waiting for your OK" : "text sending"), c.active === false && "not a Qtax client now"].filter(Boolean).join(" · ");
    // The reply that marked them "Got income", or anything they texted since being asked.
    const reply = s.reply || (s.asked_at && c.last_reply?.at > s.asked_at ? c.last_reply.text : "");
    if (editing === c.id) return `<div class="qrow" data-qc="${h(c.id)}"><form class="form full" onsubmit="return false">
        <label>Name<input data-qe="name" value="${h(c.name)}"></label><label>Phone<input data-qe="phone" value="${h(c.phone)}" inputmode="tel"></label>
        <label class="full">Notes<input data-qe="notes" value="${h(c.notes || "")}"></label></form>
      <div class="actions full"><button class="btn ghost" data-qactive type="button">${c.active === false ? "Make active again" : "Stop texting this client"}</button>
        <button class="btn" data-qcancel type="button">Cancel</button><button class="btn primary" data-qsave type="button">Save</button></div></div>`;
    return `<div class="qrow ${c.active === false ? "off" : ""}" data-qc="${h(c.id)}">
      <div><button class="btn ghost name" data-qedit type="button" style="padding:0">${h(c.name || phoneFmt(c.phone))}</button>
        <div class="meta">${h(meta)}</div>${reply ? `<div class="reply">${h(String(reply).slice(0, 240))}</div>` : ""}</div>
      <div class="acts">${st === "asked" && !pending ? `<button class="btn ghost" data-qremind type="button">Remind</button>` : ""}
        ${c.active === false ? `<button class="btn ghost" data-qactive type="button">Add back</button>` : `<button class="btn ghost" data-qremove type="button" aria-label="Remove ${h(c.name)} from the list">Remove</button>`}
        <select data-qst aria-label="Status for ${h(c.name)}">${STATUS.map(([v, l]) => `<option value="${v}" ${v === st ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>`;
  }

  // ---- Actions ----
  root.addEventListener("input", e => { if (e.target.id === "qq"){ const pos = e.target.selectionStart; render(true); const s = q("#qq"); s.focus(); s.setSelectionRange(pos, pos); } });
  root.addEventListener("change", async e => {
    if (e.target.id === "qQuarter"){ quarter = e.target.value; return render(); }
    const sel = e.target.closest("[data-qst]"); if (!sel) return;
    const c = clients.find(x => x.id === sel.closest("[data-qc]").dataset.qc), v = sel.value, now = new Date().toISOString();
    const stamp = {asked: "asked_at", received: "received_at", filed: "filed_at", paid: "paid_at"}[v];
    const next = {...qOf(c), status: v || undefined};
    if (stamp && !next[stamp]) next[stamp] = now;
    try { await db.doc("qtax/" + c.id).update({[qKey(quarter)]: next}); } catch (err){ alert("Could not save: " + (err?.message || err)); }
  });
  root.addEventListener("click", async e => {
    const t = e.target;
    try {
      const tile = t.closest("[data-qf]"); if (tile){ filter = filter === tile.dataset.qf ? null : tile.dataset.qf; return render(); }
      if (t.closest("#qAdd")){ adding = !adding; render(); return q("#qPaste")?.focus(); }
      if (t.closest("#qAddCancel")){ adding = false; return render(); }
      if (t.closest("#qAddSave")) return addPasted();
      const blast = t.closest("[data-qblast]"); if (blast) return useBlast(+blast.dataset.qblast);
      if (t.closest("#qDraftAll")){
        const list = clients.filter(c => c.active !== false && !qOf(c).status && !openText(c));
        t.disabled = true; await inChunks(list, c => draft(c, "ask")); return;
      }
      if (t.closest("#qDraftFup")){
        const list = clients.filter(c => c.active !== false && qOf(c).status === "asked" && !openText(c));
        t.disabled = true; await inChunks(list, c => draft(c, "followup")); return;
      }
      const save = t.closest("[data-qsavetpl]"); if (save){
        const key = save.dataset.qsavetpl, val = root.querySelector(`[data-qtpl="${key}"]`).value.trim(); if (!val) return;
        await db.doc("qtaxmeta/settings").update({[key]: val});
        settings[key] = val;
        const kind = key === "ask_template" ? "ask" : "followup";
        await inChunks(texts.filter(x => x.status === "draft" && x.kind === kind), x => db.doc("texts/" + x.id).update({body: fill(val, clients.find(c => c.id === x.client_id) || x, x.quarter || quarter)}));
        document.activeElement?.blur(); return render();
      }
      if (t.closest("[data-qremovesilent]")){
        const list = clients.filter(c => c.active !== false && silentOf(c));
        if (!confirm(`Remove ${list.length} people who never answered from your Qtax list? You can add any of them back later.`)) return;
        t.disabled = true;
        await inChunks(texts.filter(x => x.status === "draft" && list.some(c => c.id === x.client_id)), x => db.doc("texts/" + x.id).update({status: "dismissed", dismissed_at: new Date().toISOString()}));
        return inChunks(list, c => db.doc("qtax/" + c.id).update({active: false, removed_reason: "never answered"}));
      }
      const drop = t.closest("[data-qdrop]"); if (drop) return db.doc("texts/" + drop.dataset.qdrop).update({status: "dismissed", dismissed_at: new Date().toISOString()});
      const discard = t.closest("[data-qdiscard]"); if (discard){
        const list = texts.filter(x => x.status === "draft" && x.kind === discard.dataset.qdiscard);
        if (!confirm(`Discard ${list.length} unsent text${list.length > 1 ? "s" : ""}?`)) return;
        return inChunks(list, x => db.doc("texts/" + x.id).update({status: "dismissed", dismissed_at: new Date().toISOString()}));
      }
      const approve = t.closest("[data-qapprove]"); if (approve){
        const list = texts.filter(x => x.status === "draft" && x.kind === approve.dataset.qapprove);
        if (!list.length) return;
        const live = Date.now() - new Date(mac?.seen_at || 0) < 5 * 60000;
        if (!confirm(`Send ${list.length} separate text${list.length > 1 ? "s" : ""} from your phone number, one to each person? Nobody sees who else got it.\n\n"${list[0].body}"\n\n` +
          (live ? "Your Mac sends them one by one." : "Your Mac is offline: they go out when it's back on (within 2 days, or they come back here for a new OK).") )) return;
        approve.disabled = true;
        const {data} = await window.rdSupabase.auth.getSession(), now = new Date().toISOString();
        await inChunks(list, x => db.doc("texts/" + x.id).update({status: "approved", approved_at: now, approved_by: data.session?.user?.email || "", note: ""}));
        return;
      }
      const retry = t.closest("[data-qretry]"); if (retry){
        const x = texts.find(i => i.id === retry.dataset.qretry);
        if (!confirm(`Send this text to ${x.name || x.phone} again?`)) return;
        return db.doc("texts/" + x.id).update({status: "approved", approved_at: new Date().toISOString(), error: ""});
      }
      const rowEl = t.closest("[data-qc]"); if (!rowEl) return;
      const c = clients.find(x => x.id === rowEl.dataset.qc);
      if (t.closest("[data-qedit]")){ editing = c.id; return render(); }
      if (t.closest("[data-qcancel]")){ editing = null; return render(); }
      if (t.closest("[data-qactive]")){ await db.doc("qtax/" + c.id).update({active: c.active === false}); editing = null; return render(); }
      if (t.closest("[data-qsave]")){
        const f = Object.fromEntries([...rowEl.querySelectorAll("[data-qe]")].map(i => [i.dataset.qe, i.value.trim()]));
        if (!e164(f.phone)) return alert("Add a phone number.");
        await db.doc("qtax/" + c.id).update({...f, phone: e164(f.phone)}); editing = null; document.activeElement?.blur(); return render();
      }
      if (t.closest("[data-qremove]")){
        if (!confirm(`Remove ${c.name || phoneFmt(c.phone)} from your Qtax list? They won't get quarter texts. You can add them back later.`)) return;
        // Their unsent drafts go too, so they can't be approved by accident.
        await inChunks(texts.filter(x => x.client_id === c.id && x.status === "draft"), x => db.doc("texts/" + x.id).update({status: "dismissed", dismissed_at: new Date().toISOString()}));
        return db.doc("qtax/" + c.id).update({active: false});
      }
      if (t.closest("[data-qremind]")){ t.disabled = true; return draft(c, "followup"); }
    } catch (err){ alert("Something went wrong: " + (err?.message || err)); }
  });

  // "Name, phone" lines (or a phone and a name in any order) -> clients.
  const parseLine = line => {
    const m = line.match(/(\+?\d[\d\s().-]{8,}\d)/); if (!m) return null;
    const phone = e164(m[1]); if (digits(phone).length < 10) return null;
    return {name: line.replace(m[1], "").replace(/[,;\t|]+/g, " ").replace(/\s+/g, " ").trim(), phone};
  };
  async function addPasted(){
    const lines = q("#qPaste").value.split(/\n/).map(s => s.trim()).filter(Boolean);
    const got = lines.map(parseLine).filter(Boolean), bad = lines.length - got.length;
    if (!got.length) return (q("#qAddMsg").textContent = "No phone numbers found.");
    await addClients(got);
    adding = false; render();
    if (bad) alert(`Added ${got.length}. ${bad} line${bad > 1 ? "s" : ""} had no phone number and ${bad > 1 ? "were" : "was"} skipped.`);
  }
  async function addClients(list){
    const now = new Date().toISOString(), seen = new Set();
    await inChunks(list.filter(r => { const id = idFor(r.phone); if (seen.has(id)) return false; seen.add(id); return true; }), r => {
      const id = idFor(r.phone), old = clients.find(c => c.id === id);
      return old ? (r.name && !old.name ? db.doc("qtax/" + id).update({name: r.name}) : null)
        : db.doc("qtax/" + id).set({name: r.name || "", phone: e164(r.phone), active: true, added_at: now});
    });
  }
  async function useBlast(i){
    const have = new Set(clients.map(c => c.id));
    const b = (discovery.blasts || []).filter(x => x.recipients.some(r => !have.has(idFor(r.phone))))[i]; if (!b) return;
    if (!confirm(`Add these ${b.recipients.length} people to your client list and use this wording for the quarterly text?\n\nEach person gets their own separate text. Nobody sees who else got it.`)) return;
    await addClients(b.recipients);
    // Their own words, as last sent; the quarter is whatever they wrote, so keep it unless it names one.
    await db.doc("qtaxmeta/settings").update({ask_template: b.text, ask_template_from: b.at});
    settings.ask_template = b.text;
  }

  // ---- Start ----
  (async () => {
    for (let i = 0; i < 50 && !mount(); i++) await new Promise(r => setTimeout(r, 100));
    db = await window.claude?.use?.("db");
    if (!db) return;
    db.collection("qtax").onSnapshot(s => { clients = s.docs.map(d => ({id: d.id, ...d.data()})); render(); }, () => {});
    db.collection("texts").onSnapshot(s => { texts = s.docs.map(d => ({id: d.id, ...d.data()})); render(); }, () => {});
    db.collection("qtaxmeta").onSnapshot(s => {
      const m = Object.fromEntries(s.docs.map(d => [d.id, d.data()]));
      settings = m.settings || {}; mac = m.mac || null; discovery = m.discovery || null; responders = m.responders || null; render();
    }, () => {});
    // Ask the Mac to look for last quarter's group text the first time there are no clients.
    setTimeout(async () => { if (!clients.length && !discovery) await db.doc("qtaxmeta/discovery").update({requested_at: new Date().toISOString()}).catch(() => {}); }, 4000);
    setInterval(() => { if (!root.hidden && !root.contains(document.activeElement)) render(); }, 60000); // keep "checked x min ago" fresh
  })();
})();

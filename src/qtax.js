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
  const OPEN = ["draft", "approved", "sending", "unsure"];

  let db = null, clients = [], texts = [], amounts = [], settings = {}, mac = null, discovery = null, responders = null;
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
  // Clients who get quarter texts: on the list, and not on the do-not-text list (do_not_text: they asked to stop, or Eduard set it).
  const textable = c => c.active !== false && !c.do_not_text;
  const openText = (c, kind) => texts.find(t => t.client_id === c.id && t.quarter === quarter && OPEN.includes(t.status) && (!kind || t.kind === kind));
  const tpl = k => settings[k] || DEFAULTS[k];
  // Drafts that can be approved right now: this quarter's, for clients still on the list. Bulk Approve and Discard act on exactly these.
  const shownDrafts = kind => texts.filter(t => t.status === "draft" && (!kind || t.kind === kind) && (t.quarter || quarter) === quarter
    && clients.some(c => c.id === t.client_id && textable(c)));
  // Exactly the drafts listed on the card whose button was tapped (not ones that arrived after it was drawn).
  const onCard = el => { const ids = new Set((el.dataset.qids || "").split(",")); return texts.filter(t => ids.has(t.id) && t.status === "draft"); };
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
    const active = clients.filter(textable);
    const st = c => qOf(c).status || "";
    const n = {none: active.filter(c => !st(c)).length, asked: active.filter(c => st(c) === "asked").length,
      received: active.filter(c => st(c) === "received").length, done: active.filter(c => ["filed", "paid"].includes(st(c))).length};
    const quarters = [filingQuarter(new Date(Date.now() + 40 * 864e5)), filingQuarter()];
    while (quarters.length < 5) quarters.push(prevQuarter(quarters.at(-1)));
    const qs = [...new Set(quarters)];
    const search = (q("#qq")?.value || "").trim().toLowerCase();
    const removedOpen = !!q("#qRemoved")?.open, draftsOpen = q("#qDrafts") ? q("#qDrafts").open : true;
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
  ${incomeCard()}
  ${removedCard(removedOpen)}
  ${silentCard(active)}
  ${draftCards(active, draftsOpen)}
  ${progressCard()}
  <div class="section-h"><h2>Client list · ${qLabel(quarter)}</h2><span class="notice">${active.length} get the quarter text${clients.length > active.length ? ` · ${clients.length - active.length} removed` : ""}</span></div>
  ${clients.length ? `<div class="list">${shown.map(row).join("") || `<div class="empty">No one matches.</div>`}</div>`
    : `<div class="empty">No Qtax clients yet. Your Mac looks for the people you texted last quarter and offers them here, or tap <b>+ Clients</b> to paste a list.</div>`}
  <p class="foot">Texts go out from your own number through Messages on your Mac, only after you tap Approve &amp; send, and only between 8 am and 9 pm. Replies mark the client as "Got income" automatically.</p>`;
    showPics();
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

  // Income clients texted back, read by the Mac (qtaxq/<id>_<quarter>: reported_income, reported_text, reported_status).
  // Nothing counts until Eduard checks it; replies the Mac couldn't read (no number, two numbers, a question) wait for him to type the amount.
  const usd = n => "$" + Number(n).toLocaleString("en-US", Number.isInteger(+n) ? {} : {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const toCheck = () => amounts.filter(a => a.quarter === quarter && (a.reported_status === "unconfirmed" || a.reported_status === "unclear"))
    .sort((a, b) => (a.reported_status === "unclear") - (b.reported_status === "unclear") || String(a.name).localeCompare(String(b.name)));
  function incomeCard(){
    const list = toCheck(); if (!list.length) return "";
    const ok = list.filter(a => a.reported_status === "unconfirmed").length;
    return `<section class="card"><h3><span>Income clients texted you <span class="chip info">${list.length} to check</span></span>
        ${ok > 1 ? `<span><button class="btn primary" data-qincall type="button">All ${ok} look right</button></span>` : ""}</h3>
      ${list.some(a => a.reported_early && a.reported_status === "unconfirmed") ? `<span class="notice"><b>Sent before you asked:</b> they won't get the quarter text. If one isn't really their income, tap "Not income, text them".</span>` : ""}
      <span class="notice">Your Mac read these amounts from their replies. Check each against their words, then tap Looks right. Nothing is filed or saved as their income until you do.</span>
      <div class="list">${list.map(a => { const c = clients.find(x => x.id === a.client_id) || {}, sure = a.reported_status === "unconfirmed";
        return `<div class="qrow" data-qinc="${h(a.id)}"><div><span class="name">${h(c.name || a.name || phoneFmt(c.phone))}</span>
          ${sure ? ` <b style="color:var(--ok)">${usd(a.reported_income)}</b>` : ` <span class="chip amber">Couldn't read an amount: ${h(a.reported_why || "check it")}</span>`}
          ${a.reported_early ? ` <span class="chip info">Sent before you asked</span>` : ""}
          <div class="meta">texted ${day(a.reported_at)}</div>${a.reported_text ? `<div class="reply">${h(String(a.reported_text).slice(0, 300))}</div>` : ""}${pics(a)}</div>
          <div class="acts">${sure ? `<button class="btn primary" data-qincok type="button">Looks right</button><button class="btn ghost" data-qincedit type="button">Change</button>`
            : `<button class="btn primary" data-qincedit type="button">Enter amount</button><button class="btn ghost" data-qincskip type="button">Not income</button>`}
            ${sure && a.reported_early ? `<button class="btn ghost" data-qincskip type="button">Not income, text them</button>` : ""}</div></div>`; }).join("")}</div></section>`;
  }
  // Statement screenshots and PDFs they sent (reported_files, uploaded by the Mac). The bucket is private, so images are
  // fetched through the signed-link fetch in shim.js and shown from memory; a tap opens the full file.
  const picUrls = {};
  const pics = a => !(a.reported_files || []).length ? "" : `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">${a.reported_files.map(f =>
    f.missing ? `<span class="chip plain">${f.kind === "pdf" ? "PDF" : "Photo"} still downloading to your Mac</span>`
    : f.kind === "pdf" ? `<a class="btn ghost" href="${h(f.url)}" target="_blank" rel="noopener">📄 ${h(f.name)}</a>`
    : `<a href="${h(f.url)}" target="_blank" rel="noopener" aria-label="Open photo they sent"><img data-qpic="${h(f.url)}" alt="Photo they sent" style="width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid var(--line);background:var(--surface)"></a>`).join("")}</div>`;
  function showPics(){
    root.querySelectorAll("img[data-qpic]").forEach(async img => {
      const u = img.dataset.qpic;
      try { picUrls[u] = picUrls[u] || URL.createObjectURL(await (await fetch(u)).blob()); img.src = picUrls[u]; } catch (e){ img.alt = "Couldn't load the photo"; }
    });
  }
  // Their income for the quarter shown is already in (sent on their own, or entered by Eduard): no quarter text for them.
  // An unclear reply doesn't count until Eduard types the amount.
  const amountOf = c => amounts.find(a => a.id === `${c.id}_${quarter}`);
  const haveIncome = c => { const a = amountOf(c); return !!a && (["unconfirmed", "confirmed"].includes(a.reported_status) || (a.income !== undefined && a.income !== "")); };
  async function confirmIncome(a, n){
    await db.doc("qtaxq/" + a.id).update({income: n, reported_status: "confirmed", confirmed_at: new Date().toISOString()});
    const c = clients.find(x => x.id === a.client_id), st = c && (c[qKey(a.quarter)] || {});
    if (c && (!st.status || st.status === "asked"))
      await db.doc("qtax/" + c.id).update({[qKey(a.quarter)]: {...st, status: "received", received_at: st.received_at || a.reported_at || new Date().toISOString()}});
  }

  // Removed in the last 7 days, so a wrong tap is easy to undo. Older removals stay at the bottom of the client list.
  function removedCard(removedOpen){
    const week = new Date(Date.now() - 7 * 864e5).toISOString();
    const list = clients.filter(c => c.active === false && c.removed_at > week).sort((a, b) => b.removed_at.localeCompare(a.removed_at));
    if (!list.length) return "";
    return `<details class="card" id="qRemoved" ${removedOpen ? "open" : ""}><summary style="cursor:pointer"><b>Recently removed</b> <span class="chip plain">${list.length}</span> <span class="notice">last 7 days · tap to open and add people back</span></summary>
      <div class="list">${list.map(c => `<div class="qrow off" data-qc="${h(c.id)}"><div><span class="name">${h(c.name || phoneFmt(c.phone))}</span>
        <div class="meta">${h(phoneFmt(c.phone))} · removed ${day(c.removed_at)}${c.removed_reason ? ` · ${h(c.removed_reason)}` : ""}</div></div>
        <div class="acts"><button class="btn ghost" data-qactive type="button">Add back</button></div></div>`).join("")}</div></details>`;
  }

  // Drafts: one text per client, each with its own Send, plus Send all. The Mac drafts the quarter text for every client
  // on the first day of each quarter; nothing goes out until Eduard taps Send.
  function draftCards(active, open){
    const drafts = shownDrafts();
    const asks = drafts.filter(t => t.kind === "ask"), fups = drafts.filter(t => t.kind === "followup"), all = asks.concat(fups);
    const notAsked = active.filter(c => !qOf(c).status && !openText(c) && !haveIncome(c));
    const already = active.filter(c => !qOf(c).status && haveIncome(c));
    const waiting = active.filter(c => qOf(c).status === "asked" && !openText(c));
    const editor = (tkey, label) => `<details><summary class="notice" style="cursor:pointer">Change the ${label}</summary><form class="form" onsubmit="return false"><label class="full">Message ({name} = first name, {quarter} = the quarter)
        <textarea rows="5" data-qtpl="${tkey}">${h(tpl(tkey))}</textarea></label></form>
        <div class="actions"><button class="btn" data-qsavetpl="${tkey}" type="button">Save message</button></div></details>`;
    const one = t => `<div class="qrow" data-qd="${h(t.id)}"><div><span class="name">${h(t.name || phoneFmt(t.phone))}</span>
        ${t.kind === "followup" ? ` <span class="chip amber">Reminder</span>` : ""}${t.note ? ` <span class="chip amber">${h(t.note)}</span>` : ""}
        <div class="meta">${h(phoneFmt(t.phone))}</div>
        <details><summary class="notice" style="cursor:pointer">See text</summary><div class="qmsg">${h(t.body)}</div></details></div>
      <div class="acts"><button class="btn ghost" data-qdrop="${h(t.id)}" type="button" aria-label="Don't text ${h(t.name)}">Don't text</button>
        <button class="btn primary" data-qapprove="one" data-qids="${h(t.id)}" type="button">Send</button></div></div>`;
    return `<details class="card" id="qDrafts" ${open ? "open" : ""}><summary style="cursor:pointer"><b>Drafts</b> <span class="chip info">${all.length}</span>
        <span class="notice">${qLabel(quarter)} · each client gets their own separate text</span></summary>
      ${tpl("ask_template").includes("{quarter}") ? "" : `<span class="notice">This is your own wording from last time. Check the months and dates before you send.</span>`}
      ${editor("ask_template", "quarter text")}${fups.length ? editor("followup_template", "reminder text") : ""}
      ${all.length ? `<div class="actions"><span class="notice" data-msg>One-on-one: never a group chat.</span>
          <button class="btn" data-qdiscard="all" data-qids="${h(all.map(t => t.id).join(","))}" type="button">Discard all</button>
          <button class="btn primary" data-qapprove="all" data-qids="${h(all.map(t => t.id).join(","))}" type="button">Send all ${all.length}</button></div>
        <div class="list">${all.map(one).join("")}</div>` : `<div class="empty">No drafts. Your Mac drafts the quarter text for every client on the first day of each quarter.</div>`}
      <div class="actions" style="margin-top:8px">
        ${notAsked.length ? `<button class="btn" id="qDraftAll" type="button">Draft ${qLabel(quarter)} text for ${notAsked.length} more</button>` : ""}
        ${already.length ? `<span class="notice">${already.length} already sent you their income, so they're left out (see "Income clients texted you").</span>` : ""}
        ${waiting.length ? `<button class="btn" id="qDraftFup" type="button">Draft reminders for ${waiting.length} not answered</button>` : ""}</div></details>`;
  }

  function progressCard(){
    const live = texts.filter(t => ["approved", "sending"].includes(t.status));
    const failed = texts.filter(t => t.status === "failed"), unsure = texts.filter(t => t.status === "unsure");
    if (!live.length && !failed.length && !unsure.length) return "";
    return `<section class="card"><h3>Sending from your Mac</h3>
      ${live.length ? `<span class="notice">${live.length} text${live.length > 1 ? "s" : ""} still to go. Your Mac sends them one by one.</span>` : ""}
      ${unsure.map(t => `<div class="pol"><span>${h(t.name || phoneFmt(t.phone))} <span class="chip amber">Not sure it went out</span>
        <span class="notice">Check Messages on your phone, then tap one.</span></span>
        <span><button class="btn ghost" data-qwent="${h(t.id)}" data-yes="1" type="button">It went out</button><button class="btn ghost" data-qwent="${h(t.id)}" data-yes="0" type="button">It didn't go out</button></span></div>`).join("")}
      ${failed.map(t => `<div class="pol"><span>${h(t.name || phoneFmt(t.phone))} <span class="chip red">Not sent: ${h(t.error || "error")}</span></span>
        <span><button class="btn ghost" data-qretry="${h(t.id)}" type="button">Send again</button><button class="btn ghost" data-qdrop="${h(t.id)}" type="button">Dismiss</button></span></div>`).join("")}</section>`;
  }

  function row(c){
    const s = qOf(c), st = s.status || "";
    const pending = openText(c);
    const meta = [phoneFmt(c.phone), s.asked_at && `asked ${day(s.asked_at)}`, s.followups && `${s.followups} reminder${s.followups > 1 ? "s" : ""}`,
      s.received_at && `income ${day(s.received_at)}`, s.filed_at && `filed ${day(s.filed_at)}`, s.paid_at && `paid ${day(s.paid_at)}`,
      pending && (pending.status === "draft" ? "text waiting for your OK" : "text sending"), c.active === false && "not a Qtax client now",
      c.do_not_text && `do not text${c.do_not_text_reason ? `: ${c.do_not_text_reason}` : ""}`].filter(Boolean).join(" · ");
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
      <div class="acts">${c.do_not_text ? `<span class="chip red">Do not text</span>` : ""}${st === "asked" && !pending && !c.do_not_text ? `<button class="btn ghost" data-qremind type="button">Remind</button>` : ""}
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
      const inc = t.closest("[data-qinc]"), a = inc && amounts.find(x => x.id === inc.dataset.qinc);
      if (a && t.closest("[data-qincok]")){ t.disabled = true; return confirmIncome(a, a.reported_income); }
      if (a && t.closest("[data-qincskip]")) return db.doc("qtaxq/" + a.id).update({reported_status: "dismissed"});
      if (a && t.closest("[data-qincedit]")){
        const v = prompt(`Income for ${a.name || "this client"} (${qLabel(quarter)}):`, a.reported_income === "" ? "" : a.reported_income); if (v === null) return;
        const n = +String(v).replace(/[^\d.]/g, ""); if (String(v).trim() === "" || isNaN(n)) return alert("Type a number, for example 15000.");
        return confirmIncome(a, n);
      }
      if (t.closest("[data-qincall]")){
        const list = toCheck().filter(x => x.reported_status === "unconfirmed");
        if (!confirm(`Save ${list.length} amounts as their income for ${qLabel(quarter)}? Check them against their words first.`)) return;
        t.disabled = true; return inChunks(list, x => confirmIncome(x, x.reported_income));
      }
      const tile = t.closest("[data-qf]"); if (tile){ filter = filter === tile.dataset.qf ? null : tile.dataset.qf; return render(); }
      if (t.closest("#qAdd")){ adding = !adding; render(); return q("#qPaste")?.focus(); }
      if (t.closest("#qAddCancel")){ adding = false; return render(); }
      if (t.closest("#qAddSave")) return addPasted();
      if (t.closest("#qDraftAll")){
        const list = clients.filter(c => textable(c) && !qOf(c).status && !openText(c) && !haveIncome(c));
        t.disabled = true; await inChunks(list, c => draft(c, "ask")); return;
      }
      if (t.closest("#qDraftFup")){
        const list = clients.filter(c => textable(c) && qOf(c).status === "asked" && !openText(c));
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
        return inChunks(list, c => db.doc("qtax/" + c.id).update({active: false, removed_reason: "never answered", removed_at: new Date().toISOString()}));
      }
      const drop = t.closest("[data-qdrop]"); if (drop) return db.doc("texts/" + drop.dataset.qdrop).update({status: "dismissed", dismissed_at: new Date().toISOString()});
      const discard = t.closest("[data-qdiscard]"); if (discard){
        const list = onCard(discard);
        if (!confirm(`Discard ${list.length} unsent text${list.length > 1 ? "s" : ""}?`)) return;
        return inChunks(list, x => db.doc("texts/" + x.id).update({status: "dismissed", dismissed_at: new Date().toISOString()}));
      }
      const approve = t.closest("[data-qapprove]"); if (approve){
        const list = onCard(approve);
        if (!list.length) return;
        const live = Date.now() - new Date(mac?.seen_at || 0) < 5 * 60000;
        if (!confirm((list.length === 1 ? `Send this text to ${list[0].name || phoneFmt(list[0].phone)} from your phone number?\n\n"${list[0].body}"\n\n`
          : `Send ${list.length} separate ${qLabel(quarter)} texts from your phone number, one to each of the ${list.length} people in Drafts? Nobody sees who else got it.\n\n"${list[0].body}"\n\n`) +
          (live ? "Your Mac sends them one by one." : "Your Mac is offline: they go out when it's back on (within 2 days, or they come back here for a new OK).") )) return;
        approve.disabled = true;
        // The phone goes along with the approval: the database checks the approval has exactly one number before it merges.
        const {data} = await window.rdSupabase.auth.getSession(), now = new Date().toISOString();
        await inChunks(list, x => db.doc("texts/" + x.id).update({phone: x.phone, status: "approved", approved_at: now, approved_by: data.session?.user?.email || "", note: ""}));
        return;
      }
      const sure = t.closest("[data-qwent]"); if (sure){
        const x = texts.find(i => i.id === sure.dataset.qwent), now = new Date().toISOString();
        if (sure.dataset.yes === "1"){
          await db.doc("texts/" + x.id).update({status: "sent", sent_at: now, error: "", note: "You confirmed it went out"});
          const c = clients.find(i => i.id === x.client_id), k = qKey(x.quarter || quarter);
          if (c){ const q = c[k] || {}; await db.doc("qtax/" + c.id).update({[k]: x.kind === "followup" ? {...q, followups: (q.followups || 0) + 1, last_followup_at: now} : {...q, status: q.status || "asked", asked_at: q.asked_at || now}}); }
        } else await db.doc("texts/" + x.id).update({status: "draft", error: "", note: "Didn't go out. Approve again to send."});
        return;
      }
      const retry = t.closest("[data-qretry]"); if (retry){
        const x = texts.find(i => i.id === retry.dataset.qretry);
        if (!confirm(`Send this text to ${x.name || x.phone} again?`)) return;
        return db.doc("texts/" + x.id).update({phone: x.phone, status: "approved", approved_at: new Date().toISOString(), error: ""});
      }
      const rowEl = t.closest("[data-qc]"); if (!rowEl) return;
      const c = clients.find(x => x.id === rowEl.dataset.qc);
      if (t.closest("[data-qedit]")){ editing = c.id; return render(); }
      if (t.closest("[data-qcancel]")){ editing = null; return render(); }
      if (t.closest("[data-qactive]")){ await db.doc("qtax/" + c.id).update(c.active === false ? {active: true, removed_at: "", removed_reason: ""} : {active: false, removed_at: new Date().toISOString()}); editing = null; return render(); }
      if (t.closest("[data-qsave]")){
        const f = Object.fromEntries([...rowEl.querySelectorAll("[data-qe]")].map(i => [i.dataset.qe, i.value.trim()]));
        if (!e164(f.phone)) return alert("Add a phone number.");
        await db.doc("qtax/" + c.id).update({...f, phone: e164(f.phone)}); editing = null; document.activeElement?.blur(); return render();
      }
      if (t.closest("[data-qremove]")){
        if (!confirm(`Remove ${c.name || phoneFmt(c.phone)} from your Qtax list? They won't get quarter texts. You can add them back later.`)) return;
        // Their unsent drafts go too, so they can't be approved by accident.
        await inChunks(texts.filter(x => x.client_id === c.id && x.status === "draft"), x => db.doc("texts/" + x.id).update({status: "dismissed", dismissed_at: new Date().toISOString()}));
        return db.doc("qtax/" + c.id).update({active: false, removed_at: new Date().toISOString()});
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

  // ---- Start ----
  (async () => {
    for (let i = 0; i < 50 && !mount(); i++) await new Promise(r => setTimeout(r, 100));
    db = await window.claude?.use?.("db");
    if (!db) return;
    db.collection("qtax").onSnapshot(s => { clients = s.docs.map(d => ({id: d.id, ...d.data()})); render(); }, () => {});
    db.collection("texts").onSnapshot(s => { texts = s.docs.map(d => ({id: d.id, ...d.data()})); render(); }, () => {});
    db.collection("qtaxq").onSnapshot(s => { amounts = s.docs.map(d => ({id: d.id, ...d.data()})); render(); }, () => {});
    db.collection("qtaxmeta").onSnapshot(s => {
      const m = Object.fromEntries(s.docs.map(d => [d.id, d.data()]));
      settings = m.settings || {}; mac = m.mac || null; discovery = m.discovery || null; responders = m.responders || null; render();
    }, () => {});
    setInterval(() => { if (!root.hidden && !root.contains(document.activeElement)) render(); }, 60000); // keep "checked x min ago" fresh
  })();
})();

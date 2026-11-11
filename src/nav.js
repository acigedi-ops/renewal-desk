// Getting around (review of 2026-11-11): Today as the home for everything, one Email page (Outbox + Inbox),
// the list filter only where it works, the health line out of the header, and SOS / Qtax / invoices on the client card.
// Only adds UI around the app's own tabs and reads data; the one thing it writes is nothing. Styles are in src/nav.css.
// Kept out of src/app.html, which the L&I routine overwrites; build.mjs loads this last, after src/look.js.
(() => {
  const q = s => document.querySelector(s);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const root = document.documentElement;
  const money = n => "$" + Number(n || 0).toLocaleString("en-US", {maximumFractionDigits: 0});
  const last10 = p => String(p || "").replace(/\D/g, "").slice(-10);
  const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
  const data = {tasks: [], outbox: [], mail: [], qtax: [], qtaxq: [], texts: [], sos: [], invoices: []};

  // ---- Quarterly taxes: the quarter being filed is the one that just ended (same rule as src/qtax.js) ----
  const filingQuarter = (d = new Date()) => { let y = d.getFullYear(), n = Math.floor(d.getMonth() / 3); if (!n){ n = 4; y--; } return `${y}-Q${n}`; };
  const qKey = k => "q_" + k.replace("-", "");
  function qtaxDue(k){
    const d = new Date(+k.slice(0, 4), +k.slice(-1) * 3 + 1, 0);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d;
  }
  function qtaxCounts(){
    const k = filingQuarter(), amt = Object.fromEntries(data.qtaxq.map(a => [a.id, a]));
    const st = p => (p[qKey(k)] || {}).status || "";
    const sent = p => { const a = amt[`${p.id}_${k}`] || {}; return st(p) === "received" || ["unconfirmed", "confirmed", "unclear"].includes(a.reported_status) || (a.income !== undefined && a.income !== ""); };
    const active = data.qtax.filter(p => p.active !== false);
    const textable = new Set(active.filter(p => !p.do_not_text).map(p => p.id));
    return {k, toFile: active.filter(p => !["filed", "paid"].includes(st(p)) && sent(p)).length,
      drafts: data.texts.filter(t => t.status === "draft" && (t.quarter || k) === k && textable.has(t.client_id)).length,
      unsure: data.texts.filter(t => t.status === "unsure").length};
  }
  const sosKind = b => { try { return window.sosAssess ? window.sosAssess(b).k : ""; } catch { return ""; } };

  // ---- Today: "Waiting on you" for the whole desk, at the top ----
  // Each row is one place to go, with its count. Rows with nothing waiting are left out.
  function homeRows(){
    const rows = [];
    const open = data.tasks.filter(t => t.status !== "done");
    const calls = open.filter(t => t.source === "call" || t.source === "callback").length, urgent = open.filter(t => t.urgent).length;
    if (open.length) rows.push({n: open.length, label: "To do", sub: [calls && plural(calls, "call") + " to return", urgent && `${urgent} urgent`].filter(Boolean).join(" · "), red: !!(calls || urgent), go: "#tab-tasks"});
    const approve = data.outbox.filter(o => ["pending", "failed"].includes(o.status)).length, check = data.outbox.filter(o => ["unsure", "sending"].includes(o.status)).length;
    let inbox = 0; try { inbox = window.inboxList ? window.inboxList().length : 0; } catch {}
    if (approve || check || inbox) rows.push({n: approve + check + inbox, label: "Email",
      sub: [approve && `${approve} to approve`, check && `${check} to check`, inbox && `${inbox} new from carriers and L&I`].filter(Boolean).join(" · "), red: !!check, go: "#tab-email"});
    const qt = qtaxCounts();
    if (qt.toFile || qt.drafts || qt.unsure){
      const due = qtaxDue(qt.k), late = due < new Date(new Date().setHours(0, 0, 0, 0));
      rows.push({n: qt.toFile + qt.drafts + qt.unsure, label: `Quarterly taxes Q${qt.k.slice(-1)}`,
        sub: [qt.toFile && `${qt.toFile} to file`, qt.drafts && `${plural(qt.drafts, "text")} to send`, qt.unsure && `${plural(qt.unsure, "text")} to check`,
          qt.toFile && `${late ? "was due" : "due"} ${due.toLocaleDateString("en-US", {month: "short", day: "numeric"})}`].filter(Boolean).join(" · "), red: !!(qt.toFile && late) || !!qt.unsure, go: "[data-qmode]"});
    }
    const mine = data.sos.filter(b => b.followup?.status !== "Not our client anymore");
    const del = mine.filter(b => sosKind(b) === "delinquent").length, rep = mine.filter(b => sosKind(b) === "due").length;
    if (del || rep) rows.push({n: del + rep, label: "SOS status", sub: [del && `${del} delinquent`, rep && plural(rep, "annual report") + " due"].filter(Boolean).join(" · "), red: !!del, go: '[data-mode="sos"]'});
    const unpaid = data.invoices.filter(v => v.status === "unpaid"), over = unpaid.filter(v => v.due && v.due < ymd());
    if (unpaid.length) rows.push({n: unpaid.length, label: "Invoices", sub: [`${money(unpaid.reduce((s, v) => s + Number(v.balance || 0), 0))} not paid`, over.length && `${over.length} overdue`].filter(Boolean).join(" · "), red: !!over.length, go: "#tab-invoices"});
    return rows;
  }
  function homeHtml(){
    const rows = homeRows();
    return `<section class="rd-home" aria-label="Waiting on you"><h2>Waiting on you</h2>${rows.length
      ? rows.map(r => `<button type="button" data-home="${h(r.go)}"><b class="${r.red ? "red" : ""}">${r.n}</b><span><strong>${h(r.label)}</strong>${r.sub ? `<small>${h(r.sub)}</small>` : ""}</span></button>`).join("")
      : `<p>Nothing is waiting in To do, Email, Quarterly taxes, SOS or Invoices.</p>`}</section>`;
  }
  let homeWas = "";
  function home(){
    const t = q("#today"); if (!t || !t.children.length || t.querySelector(":scope > .empty:only-child")) return;
    const html = homeHtml(), el = t.querySelector(":scope > .rd-home");
    if (el && homeWas === html) return;
    homeWas = html;
    if (el) el.outerHTML = html; else t.insertAdjacentHTML("afterbegin", html);
  }
  document.addEventListener("click", e => {
    const b = e.target.closest?.("[data-home]"); if (!b) return;
    q(b.dataset.home)?.click(); scrollTo(0, 0);
  });

  // ---- One Email page: the Outbox (emails waiting for Approve & send) with the Inbox under it ----
  // The app's own Inbox and Outbox tabs stay in the page, hidden; Email opens the Outbox and shows the Inbox below it (src/nav.css).
  const emailTab = Object.assign(document.createElement("button"), {id: "tab-email", type: "button", role: "tab", innerHTML: `Email <span id="emailN"></span>`});
  emailTab.setAttribute("aria-selected", "false");
  emailTab.onclick = () => q("#tab-outbox")?.click();
  const digits = id => +(String(q("#" + id)?.textContent || "").match(/\d+/) || [0])[0];
  let lastTab = "";
  function syncTabs(){
    const tabs = q(".bar .tabs"), out = q("#tab-outbox"), inb = q("#tab-inbox"); if (!tabs || !out || !inb) return;
    if (!emailTab.isConnected){ inb.before(emailTab); q("#inbox")?.before(q("#outbox")); }
    // Anything that still opens the Inbox on its own lands on the Email page.
    if (inb.getAttribute("aria-selected") === "true"){ out.click(); return; }
    const on = out.getAttribute("aria-selected") === "true";
    if (root.classList.contains("rd-email") !== on){ root.classList.toggle("rd-email", on); if (on) try { window.renderInbox?.(); } catch {} }
    if (emailTab.getAttribute("aria-selected") !== String(on)) emailTab.setAttribute("aria-selected", String(on));
    const n = digits("inboxN") + digits("outboxN"), txt = n ? `(${n})` : "", el = q("#emailN");
    if (el && el.textContent !== txt) el.textContent = txt;
    // The filter under the title only narrows Licenses, Renewals and Clients: start each tab with it empty, so a list never looks empty by surprise.
    const cur = (tabs.querySelector('[role=tab][aria-selected="true"]')?.id || "").slice(4);
    if (cur && cur !== lastTab){
      const s = q("#q");
      if (lastTab && s && s.value){ s.value = ""; s.dispatchEvent(new Event("input", {bubbles: true})); }
      lastTab = cur;
    }
  }

  // ---- Health line: at the bottom of every screen while all is well, at the top of every screen when something is late ----
  function placeHealth(){
    const el = q("#health"), modes = q(".modes"), wrap = q(".wrap"); if (!el || !modes || !wrap) return;
    const bad = el.classList.contains("bad");
    if (bad){ if (modes.nextElementSibling !== el) modes.after(el); }
    else if (wrap.lastElementChild !== el) wrap.append(el);
  }

  // ---- Client card: quick links to each part, and what the other parts of the desk know about this client ----
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(llc|inc|corp|co|ltd|dba|the)\b/g, " ").replace(/\s+/g, " ").trim();
  const same = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 6 && (a.includes(b) || b.includes(a)))); };
  const JUMPS = [["L&I", p => p.querySelector("#proofBtn")?.closest("section")?.previousElementSibling], ["COIs", p => p.querySelector("#newCoi")?.closest("section")],
    ["Emails", p => p.querySelector("#obCard")], ["Documents", p => p.querySelector("#clientDocs:not([hidden])")], ["Follow-up", p => p.querySelector("#fuForm")?.closest("section")],
    ["Policies", p => p.querySelector("#pols")?.closest("section")], ["History", p => p.querySelector("#clientHistory")?.closest("section")]];
  function alsoHtml(c){
    const out = [];
    const ubi = String(c.ubi || "").replace(/\D/g, "");
    const biz = data.sos.find(b => (ubi.length === 9 && String(b.ubi || "").replace(/\D/g, "") === ubi) || same(b.name, c.name) || same(b.sos?.name, c.name));
    if (biz){
      let a = {k: "", text: ""}; try { a = window.sosAssess(biz); } catch {}
      const tone = {dead: "red", delinquent: "red", due: "amber", check: "amber", wait: "plain", ok: "ok"}[a.k] || "plain";
      out.push(`<div class="pol"><span><b>Secretary of State</b> <span class="chip ${tone}">${h(a.text)}</span>${biz.sos?.ar_due && window.fd ? `<br><span class="notice">Annual report due ${h(window.fd(biz.sos.ar_due))}</span>` : ""}</span>
        <button class="btn ghost" type="button" data-also-sos="${h(biz.id)}">Open</button></div>`);
    }
    const phone = last10(c.contact?.phone);
    const person = phone.length === 10 && data.qtax.find(p => last10(p.phone) === phone);
    if (person){
      const k = filingQuarter(), s = (person[qKey(k)] || {}).status || "";
      const word = {"": "Not asked yet", asked: "Asked, waiting for income", received: "Sent income, to file", filed: "Filed", paid: "Paid"}[s] || s;
      out.push(`<div class="pol"><span><b>Quarterly taxes</b> <span class="chip ${s === "received" ? "red" : s === "filed" || s === "paid" ? "ok" : "plain"}">Q${k.slice(-1)} ${k.slice(0, 4)}: ${h(word)}</span>${person.active === false ? ` <span class="chip plain">removed from the list</span>` : ""}</span>
        <button class="btn ghost" type="button" data-also-qtax="${h(person.name || phone)}">Open</button></div>`);
    }
    const inv = data.invoices.filter(v => v.status === "unpaid" && (same(v.customer, c.name) || same(v.customer, c.contact?.name)));
    if (inv.length) out.push(`<div class="pol"><span><b>Invoices not paid</b> <span class="chip ${inv.some(v => v.due && v.due < ymd()) ? "red" : "amber"}">${money(inv.reduce((s, v) => s + Number(v.balance || 0), 0))}</span>
        <br><span class="notice">${inv.map(v => `#${h(v.number)}${v.description ? " " + h(v.description) : ""}`).join(" · ")}</span></span>
        <button class="btn ghost" type="button" data-also-inv>Open</button></div>`);
    return out.length ? `<section class="card rd-also"><h3>Also on file</h3>${out.join("")}</section>` : "";
  }
  document.addEventListener("rd:client", e => {
    const c = e.detail, p = q("#panel"), first = p?.querySelector("section.card"); if (!c || !first) return;
    p.querySelectorAll(".rd-jumps,.rd-also").forEach(x => x.remove());
    first.insertAdjacentHTML("beforebegin", `<nav class="rd-jumps" aria-label="Jump to">${JUMPS.map(([label], i) => `<button type="button" data-jump="${i}">${label}</button>`).join("")}</nav>${alsoHtml(c)}`);
  });
  document.addEventListener("click", e => {
    const t = e.target, p = q("#panel"); if (!t.closest || !p) return;
    const j = t.closest("[data-jump]"); if (j){ JUMPS[+j.dataset.jump][1](p)?.scrollIntoView({block: "start", behavior: "smooth"}); return; }
    const s = t.closest("[data-also-sos]"); if (s){ const id = s.dataset.alsoSos; q('[data-mode="sos"]')?.click(); window.sosOpen?.(id); return; }
    const x = t.closest("[data-also-qtax]"); if (x){ const name = x.dataset.alsoQtax; window.closeSheet?.(); q("[data-qmode]")?.click();
      setTimeout(() => { const f = q("#qq"); if (f){ f.value = name; f.dispatchEvent(new Event("input", {bubbles: true})); } }, 80); return; }
    if (t.closest("[data-also-inv]")){ window.closeSheet?.(); q("#tab-invoices")?.click(); scrollTo(0, 0); }
  });

  // ---- Start ----
  const run = () => { syncTabs(); placeHealth(); home(); };
  new MutationObserver(() => { clearTimeout(run.t); run.t = setTimeout(run, 40); })
    .observe(document.body, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-selected", "class"]});
  run();
  const s = q("#q"); if (s){ s.placeholder = "Filter this list"; s.setAttribute("aria-label", "Filter this list"); }
  (async () => {
    const db = await window.claude?.use?.("db"); if (!db) return;
    for (const k of Object.keys(data))
      db.collection(k).onSnapshot(snap => { data[k] = snap.docs.map(d => ({id: d.id, ...d.data()})); run(); }, () => {});
  })();
})();

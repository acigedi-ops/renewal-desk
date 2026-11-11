// All policies: one list of every commercial policy on every client card, with type, carrier, number, effective and expiration dates
// (Eduard, 2026-11-11: "a list of every client, effective date, expiration date, carrier"). An "All policies" tab after Clients.
// Rows come from clients[].policies (carrier portals, emails, added by hand). Liability or bond that only L&I knows about is listed too, marked "from L&I".
// Tap a row to open the client. It only reads. Kept out of src/app.html, which the L&I routine overwrites; build.mjs loads this after the app.
(() => {
  const q = s => document.querySelector(s);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const low = s => String(s ?? "").toLowerCase();
  const DEAD = /cancel|expired|lapsed|non-?renew/i;
  const isGL = t => /general liab/i.test(t || ""), isBond = t => /bond/i.test(t || "");
  const dayN = s => { try { return window.days ? window.days(s) : null; } catch { return null; } };
  const date = s => { try { return s && window.fd ? window.fd(s) : ""; } catch { return String(s || ""); } };
  const num = v => { const n = Number(String(v ?? "").replace(/[^0-9.]/g, "")); return n || 0; };
  const money = n => "$" + Math.round(n).toLocaleString("en-US");
  let clients = [], show = "active", type = "", carrier = "", sort = "exp", term = "";

  document.head.insertAdjacentHTML("beforeend", `<style>
#policies .pl-bar{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center}
#policies .pl-bar input{flex:1 1 180px;min-width:0}
#policies .pl-bar select{flex:0 1 auto;max-width:100%;border:0;background:var(--sunk);border-radius:12px;padding:9px 10px;font-weight:600;font-size:13.5px;color:var(--ink)}
#policies .pl-seg{display:flex;background:var(--sunk);border-radius:12px;padding:2px;margin-top:10px}
#policies .pl-seg button{flex:1;border:0;background:none;border-radius:10px;padding:7px 8px;font-weight:600;font-size:13px;color:var(--muted)}
#policies .pl-seg button[aria-pressed="true"]{background:var(--surface);color:var(--ink);box-shadow:0 1px 3px rgb(0 0 0 / .12)}
#policies table{width:100%;border-collapse:collapse;background:var(--surface);border-radius:var(--r);box-shadow:var(--shadow);overflow:hidden;margin-top:10px;font-size:13.5px}
#policies th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700;padding:10px 12px;white-space:nowrap;cursor:pointer;user-select:none}
#policies td{padding:10px 12px;border-top:1px solid var(--line);vertical-align:top}
#policies tbody tr{cursor:pointer}#policies tbody tr:hover{background:var(--bg)}
#policies td.nm{font-weight:600;text-transform:capitalize}
#policies td.d{white-space:nowrap;font-variant-numeric:tabular-nums}
#policies tr.off td{color:var(--muted)}
#policies .pl-cards{display:none}
@media (max-width:720px){
  #policies table{display:none}
  #policies .pl-cards{display:grid;gap:8px;margin-top:10px}
  #policies .pl-card{display:grid;gap:3px;text-align:left;width:100%;border:0;background:var(--surface);border-radius:var(--r);box-shadow:var(--shadow);padding:11px 14px;font:inherit;color:inherit}
  #policies .pl-card.off{opacity:.6}
  #policies .pl-card b{text-transform:capitalize;overflow-wrap:anywhere}
  #policies .pl-card .l2{display:flex;justify-content:space-between;gap:10px;font-size:13px}
  #policies .pl-card .l3{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
}
</style>`);

  const tab = Object.assign(document.createElement("button"), {id: "tab-policies", type: "button", role: "tab", innerHTML: `All policies <span id="policiesN"></span>`});
  tab.setAttribute("aria-selected", "false");
  const main = Object.assign(document.createElement("main"), {id: "policies", hidden: true});
  const others = ["today", "desk", "todo", "ren", "inbox", "outbox", "tasks", "invoices"];
  function mount(){
    const after = q("#tab-desk"), afterMain = q("#invoices");
    if (!after || !afterMain) return false;
    after.after(tab); afterMain.after(main);
    // Step aside when any other tab is shown.
    const mo = new MutationObserver(() => { if (!main.hidden && others.some(k => q("#" + k) && !q("#" + k).hidden)) hide(); });
    others.forEach(k => q("#" + k) && mo.observe(q("#" + k), {attributes: true, attributeFilter: ["hidden"]}));
    tab.onclick = open;
    return true;
  }
  function open(){
    others.forEach(k => { const m = q("#" + k); if (m) m.hidden = true; q("#tab-" + k)?.setAttribute("aria-selected", "false"); });
    main.hidden = false; tab.setAttribute("aria-selected", "true"); render();
  }
  function hide(){ main.hidden = true; tab.setAttribute("aria-selected", "false"); }

  // One row per policy. "live" = not cancelled or expired, and not past its end date.
  function rows(){
    const out = [];
    for (const c of clients){
      const pols = c.policies || [], l = c.lni || {};
      const add = (p, from) => { const n = dayN(p.expiration);
        out.push({c, type: p.type || "Policy", carrier: p.carrier || "", number: p.number || "", eff: p.effective || "", exp: p.expiration || "", n,
          status: p.status || "", premium: num(p.premium), from, live: !DEAD.test(p.status || "") && (n == null || n >= 0)}); };
      for (const p of pols) add(p, p.source === "portal" ? "Portal" : p.source === "email" ? "Email" : "");
      // Liability or bond that L&I shows and no policy on the card covers.
      const active = l.checked_at && (!l.registration?.status || l.registration.status === "ACTIVE");
      const has = fam => pols.some(p => fam(p.type) && !DEAD.test(p.status || "") && (dayN(p.expiration) ?? 0) >= 0);
      if (active && l.insurance?.number && !has(isGL)) add({type: "General liability", carrier: l.insurance.carrier, number: l.insurance.number, effective: l.insurance.effective, expiration: l.insurance.until}, "L&I");
      if (active && l.bond?.number && !has(isBond)) add({type: "Bond", carrier: l.bond.carrier, number: l.bond.number, effective: l.bond.effective, expiration: l.bond.until}, "L&I");
    }
    return out;
  }
  const SORTS = {exp: (a, b) => (a.n ?? 99999) - (b.n ?? 99999), client: () => 0, carrier: (a, b) => low(a.carrier).localeCompare(low(b.carrier)),
    type: (a, b) => low(a.type).localeCompare(low(b.type)), eff: (a, b) => String(b.eff).localeCompare(String(a.eff))};
  const when = r => r.exp === "until cancelled" ? "Until cancelled" : date(r.exp) || "—";
  const chip = r => !r.live ? `<span class="chip plain">${h(DEAD.test(r.status) ? r.status : "Ended")}</span>`
    : r.n != null && r.n <= 14 ? `<span class="chip red">${r.n === 0 ? "today" : `${r.n}d left`}</span>` : r.n != null && r.n <= 60 ? `<span class="chip amber">${r.n}d left</span>` : "";

  function render(){
    const all = rows(), live = all.filter(r => r.live);
    const n = q("#policiesN"); if (n) n.textContent = live.length ? `(${live.length})` : "";
    if (main.hidden) return;
    const typing = main.contains(document.activeElement) && document.activeElement.id === "plQ", pos = typing ? document.activeElement.selectionStart : 0;
    const base = all.filter(r => show === "all" || (show === "active" ? r.live : !r.live));
    const types = [...new Set(base.map(r => r.type))].sort(), carriers = [...new Set(base.map(r => r.carrier).filter(Boolean))].sort((a, b) => low(a).localeCompare(low(b)));
    if (type && !types.includes(type)) type = ""; if (carrier && !carriers.includes(carrier)) carrier = "";
    const t = low(term).trim();
    const list = base.filter(r => (!type || r.type === type) && (!carrier || r.carrier === carrier) &&
      (!t || [r.c.name, r.c.license, r.c.contact?.name, r.carrier, r.number, r.type].some(v => low(v).includes(t))))
      .sort((a, b) => SORTS[sort](a, b) || low(a.c.name).localeCompare(low(b.c.name)) || (a.n ?? 99999) - (b.n ?? 99999));
    const prem = list.reduce((s, r) => s + r.premium, 0), withPrem = list.filter(r => r.premium).length;
    const opt = (v, label, cur) => `<option value="${h(v)}" ${v === cur ? "selected" : ""}>${h(label)}</option>`;
    const th = (k, label) => `<th data-plsort="${k}">${label}${sort === k ? " ↓" : ""}</th>`;
    main.innerHTML = `
      <div class="pl-seg">${[["active", `Active (${live.length})`], ["ended", `Ended (${all.length - live.length})`], ["all", `All (${all.length})`]].map(([k, label]) => `<button type="button" data-plshow="${k}" aria-pressed="${show === k}">${label}</button>`).join("")}</div>
      <div class="pl-bar"><input class="search" id="plQ" type="search" placeholder="Client, carrier or policy number" aria-label="Search policies" value="${h(term)}">
        <select id="plType" aria-label="Type">${opt("", "All types", type)}${types.map(x => opt(x, x, type)).join("")}</select>
        <select id="plCarrier" aria-label="Carrier">${opt("", "All carriers", carrier)}${carriers.map(x => opt(x, x, carrier)).join("")}</select>
        <select id="plSort" aria-label="Sort">${[["exp", "Expiring soonest"], ["client", "Client A to Z"], ["carrier", "Carrier"], ["type", "Type"], ["eff", "Newest effective"]].map(([k, label]) => opt(k, "Sort: " + label, sort)).join("")}</select></div>
      <p class="notice" style="margin:10px 2px 0">${list.length} ${list.length === 1 ? "policy" : "policies"}${withPrem ? ` · ${money(prem)} premium on ${withPrem} of them` : ""}. Tap one to open the client.</p>
      ${list.length ? `<table><thead><tr>${th("client", "Client")}${th("type", "Type")}${th("carrier", "Carrier")}<th>Policy number</th>${th("eff", "Effective")}${th("exp", "Expires")}<th></th></tr></thead><tbody>
        ${list.map(r => `<tr class="${r.live ? "" : "off"}" data-plc="${h(r.c.id)}"><td class="nm">${h(low(r.c.name))}</td><td>${h(r.type)}</td><td>${h(r.carrier)}${r.from === "L&I" ? ` <span class="notice">from L&amp;I</span>` : ""}</td>
          <td class="mono">${h(r.number)}</td><td class="d">${h(date(r.eff) || "—")}</td><td class="d">${h(when(r))}</td><td>${chip(r)}</td></tr>`).join("")}</tbody></table>
        <div class="pl-cards">${list.map(r => `<button type="button" class="pl-card ${r.live ? "" : "off"}" data-plc="${h(r.c.id)}"><b>${h(low(r.c.name))}</b>
          <span class="l2"><span>${h(r.type)} · ${h(r.carrier || "No carrier")}${r.from === "L&I" ? " (from L&I)" : ""}</span>${chip(r)}</span>
          <span class="l3">${h(date(r.eff) || "—")} to ${h(when(r))}${r.number ? " · " + h(r.number) : ""}</span></button>`).join("")}</div>`
        : `<div class="empty">${all.length ? "No policies match." : "No policies yet. They show up here as they are added to client cards."}</div>`}`;
    if (typing){ const s = q("#plQ"); s.focus(); s.setSelectionRange(pos, pos); }
  }
  let timer = 0;
  main.addEventListener("input", e => { if (e.target.id === "plQ"){ term = e.target.value; clearTimeout(timer); timer = setTimeout(render, 200); } });
  main.addEventListener("change", e => {
    if (e.target.id === "plType") type = e.target.value; else if (e.target.id === "plCarrier") carrier = e.target.value; else if (e.target.id === "plSort") sort = e.target.value; else return;
    render();
  });
  main.addEventListener("click", e => {
    const s = e.target.closest("[data-plshow]"); if (s){ show = s.dataset.plshow; return render(); }
    const o = e.target.closest("[data-plsort]"); if (o){ sort = o.dataset.plsort; return render(); }
    const r = e.target.closest("[data-plc]"); if (r) window.openClient?.(r.dataset.plc);
  });

  (async () => {
    for (let i = 0; i < 120 && !mount(); i++) await new Promise(r => setTimeout(r, 100));
    const db = await window.claude?.use?.("db"); if (!db) return;
    db.collection("clients").onSnapshot(s => { clients = s.docs.map(d => ({id: d.id, ...d.data()})); render(); }, () => {});
  })();
})();

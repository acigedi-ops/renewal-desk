// Premium look (src/look.css): greeting, bottom tab bar icons and badges, and the More sheet. Only adds UI around the app's own tab buttons and clicks them; no app logic here.
(() => {
  const q = s => document.querySelector(s);
  const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const IC = {
    today: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>',
    todo: '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4M14.5 10h4M14.5 13.5h3"/>',
    ren: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20v-4h-4"/>',
    desk: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.6c1.5.6 2.6 2 3 4.4"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    inbox: '<path d="M3 13.5 5.5 5h13l2.5 8.5V19H3z"/><path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5"/>',
    outbox: '<path d="M21 3 10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
    tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17"/>',
    invoices: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    agency: '<path d="M4 20V8l8-4 8 4v12"/><path d="M9 20v-6h6v6"/>'
  };
  const LBL = {today: "Today", todo: "Licenses", ren: "Renewals", desk: "Clients"};
  const num = id => (String(q("#" + id)?.textContent || "").match(/\d+/) || [""])[0];

  const TITLE = {todo: "L&I licenses", ren: "Renewals", desk: "Clients", inbox: "Inbox", outbox: "Outbox", tasks: "To do", invoices: "Invoices"};
  // Large title: a greeting on Today, the tab's name everywhere else.
  function hello(){
    const b = q("#policyMode .brand"); if (!b) return;
    let el = q(".rd-hello");
    if (!el){ el = Object.assign(document.createElement("div"), {className: "rd-hello"}); b.querySelector("h1")?.after(el); }
    const tab = (q(".bar .tabs [role=tab][aria-selected=true]")?.id || "tab-today").slice(4);
    if (document.documentElement.dataset.rdTab !== tab) document.documentElement.dataset.rdTab = tab;
    const h = new Date().getHours();
    const t = TITLE[tab] || `Good ${h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"}, Eduard`;
    if (el.textContent !== t) el.textContent = t;
  }
  function decorate(){
    const tabs = q(".bar .tabs"); if (!tabs) return;
    for (const k of Object.keys(LBL)){
      const b = q("#tab-" + k); if (!b || b.querySelector(".rd-ic")) continue;
      b.insertAdjacentHTML("afterbegin", `<span class="rd-ic">${svg(IC[k])}</span>`);
      b.insertAdjacentHTML("beforeend", `<span class="rd-lbl" hidden>${LBL[k]}</span>`);
    }
    if (!q(".rd-more")){
      const m = Object.assign(document.createElement("button"), {type: "button", className: "rd-more", innerHTML: `<span class="rd-ic">${svg(IC.more)}</span>More`});
      m.onclick = openMore; tabs.append(m);
    }
    badges();
  }
  // Short labels and count bubbles on the phone bar; the app's own "(n)" text stays for desktop.
  function badges(){
    const phone = matchMedia("(max-width:600px)").matches;
    for (const k of Object.keys(LBL)){
      const b = q("#tab-" + k); if (!b) continue;
      [...b.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).forEach(n => { n.rdText ??= n.textContent; const t = phone ? "" : n.rdText; if (n.textContent !== t) n.textContent = t; });
      const l = b.querySelector(".rd-lbl"); if (l && l.hidden !== !phone) l.hidden = !phone;
      const n = k === "today" ? "" : num(k + "N");
      let bd = b.querySelector(".rd-badge");
      if (phone && n && n !== "0"){ if (!bd){ bd = document.createElement("span"); bd.className = "rd-badge"; b.append(bd); } if (bd.textContent !== n) bd.textContent = n; } else bd?.remove();
    }
    const more = q(".rd-more"); if (!more) return;
    const total = ["inboxN", "outboxN", "tasksN"].reduce((s, id) => s + (+num(id) || 0), 0);
    let bd = more.querySelector(".rd-badge");
    if (total){ if (!bd){ bd = document.createElement("span"); bd.className = "rd-badge"; more.append(bd); } if (bd.textContent !== String(total)) bd.textContent = total; } else bd?.remove();
  }
  function openMore(){
    let s = q(".rd-sheet");
    if (!s){
      s = Object.assign(document.createElement("div"), {className: "rd-sheet"});
      s.onclick = e => { const it = e.target.closest("[data-to]"); if (it) q(it.dataset.to)?.click(); if (it || e.target === s) s.hidden = true; };
      document.body.append(s);
    }
    const row = (k, label, to, n) => q(to) ? `<button class="it" data-to="${to}">${svg(IC[k])}${label}${n ? `<span class="n">${n}</span>` : ""}</button>` : "";
    s.innerHTML = `<div><div class="grab"></div><div class="grp">${row("inbox", "Inbox", "#tab-inbox", num("inboxN"))}${row("outbox", "Outbox", "#tab-outbox", num("outboxN"))}${row("tasks", "To do", "#tab-tasks", num("tasksN"))}${row("invoices", "Invoices", "#tab-invoices", num("invoicesN"))}${row("agency", "Agency details", "#agencyBtn", "")}</div></div>`;
    s.hidden = false;
  }
  const run = () => { hello(); decorate(); };
  // Our own changes only write when something differs, so this settles after one pass.
  new MutationObserver(() => { clearTimeout(run.t); run.t = setTimeout(run, 50); }).observe(document.body, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-selected"]});
  addEventListener("resize", badges);
  run();
})();

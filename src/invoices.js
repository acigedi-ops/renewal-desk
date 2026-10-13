// Invoices: QuickBooks invoices that haven't been paid yet, each with a Copy link button.
// An "Invoices" tab after To do. Kept out of src/app.html, which the L&I routine overwrites; build.mjs loads this after the app.
// The site can't reach QuickBooks: a Claude session with the QuickBooks connector copies invoices in with tools/invoices_sync.py.
// Data: collection `invoices/<txn id>` {number, customer, amount, balance, due, date, description, link, status: "unpaid"|"paid", paid_at, synced_at}.
// Nothing here sends anything to a client; the link opens the invoice in Eduard's QuickBooks.
(() => {
  const q = s => document.querySelector(s);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money = n => "$" + Number(n || 0).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const day = d => d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric"}) : "";
  const today = () => new Date().toLocaleDateString("en-CA");
  let db = null, items = [];

  const tab = Object.assign(document.createElement("button"), {id: "tab-invoices", type: "button", role: "tab", innerHTML: `Invoices <span id="invoicesN"></span>`});
  tab.setAttribute("aria-selected", "false");
  const main = Object.assign(document.createElement("main"), {id: "invoices", hidden: true});
  const others = ["today", "desk", "todo", "ren", "inbox", "outbox", "tasks"];
  function mount(){
    const after = q("#tab-tasks"), afterMain = q("#tasks");
    if (!after || !afterMain) return false;
    after.after(tab); afterMain.after(main);
    // Step aside when any other tab is shown.
    const mo = new MutationObserver(() => { if (!main.hidden && others.some(k => q("#" + k) && !q("#" + k).hidden)) hide(); });
    others.forEach(k => q("#" + k) && mo.observe(q("#" + k), {attributes: true, attributeFilter: ["hidden"]}));
    tab.onclick = show;
    return true;
  }
  function show(){
    others.forEach(k => { const m = q("#" + k); if (m) m.hidden = true; q("#tab-" + k)?.setAttribute("aria-selected", "false"); });
    main.hidden = false; tab.setAttribute("aria-selected", "true"); render();
  }
  function hide(){ main.hidden = true; tab.setAttribute("aria-selected", "false"); }

  function card(v){
    const late = v.status === "unpaid" && v.due && v.due < today();
    return `<section class="card" data-inv="${h(v.id)}">
      <h3><span>${late ? `<span class="chip red">Overdue</span> ` : ""}${h(v.customer)}</span><b>${money(v.status === "unpaid" ? v.balance : v.amount)}</b></h3>
      <span class="notice">Invoice ${h(v.number)} · ${day(v.date)}${v.status === "unpaid" ? ` · due ${day(v.due)}` : ` · paid`}${v.status === "unpaid" && v.balance < v.amount ? ` · ${money(v.amount)} total` : ""}</span>
      ${v.description ? `<span>${h(v.description)}</span>` : ""}
      <div class="actions">${/^https:\/\//.test(v.link || "") ? `<button class="btn primary" data-copy type="button">Copy link</button><a class="btn ghost" href="${h(v.link)}" target="_blank" rel="noopener">Open in QuickBooks</a>` : ""}</div></section>`;
  }
  function render(){
    const open = items.filter(v => v.status === "unpaid").sort((a, b) => String(a.due).localeCompare(String(b.due)));
    const paid = items.filter(v => v.status === "paid").sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at))).slice(0, 20);
    const n = q("#invoicesN"); if (n) n.textContent = open.length ? `(${open.length})` : "";
    if (main.hidden) return;
    const total = open.reduce((s, v) => s + Number(v.balance || 0), 0);
    const synced = items.map(v => v.synced_at || "").sort().pop();
    main.innerHTML = `<p class="notice" style="margin:12px 0 0">Invoices from QuickBooks that haven't been paid yet, oldest due first. Copy link copies the invoice's QuickBooks link.${synced ? ` Updated ${new Date(synced).toLocaleString("en-US", {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"})}.` : ""}</p>` +
      (open.length ? `<div class="section-h"><h2>Not paid</h2><span class="notice">${open.length} · ${money(total)}</span></div><div class="list">${open.map(card).join("")}</div>`
        : `<div class="empty">No unpaid invoices.</div>`) +
      (paid.length ? `<details style="margin-top:18px"><summary class="notice" style="cursor:pointer">Recently paid (${paid.length})</summary><div class="list">${paid.map(card).join("")}</div></details>` : "");
  }
  async function copy(text){
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const t = Object.assign(document.createElement("textarea"), {value: text});
    t.style.cssText = "position:fixed;opacity:0"; document.body.append(t); t.select();
    const ok = document.execCommand("copy"); t.remove(); return ok;
  }
  main.addEventListener("click", async e => {
    const b = e.target.closest("[data-copy]"); if (!b) return;
    const v = items.find(x => x.id === b.closest("[data-inv]").dataset.inv); if (!v) return;
    const ok = await copy(v.link);
    b.textContent = ok ? "Copied" : "Couldn't copy";
    setTimeout(() => { b.textContent = "Copy link"; }, 2000);
  });

  (async () => {
    for (let i = 0; i < 100 && !mount(); i++) await new Promise(r => setTimeout(r, 100));
    db = await window.claude?.use?.("db");
    if (!db) return;
    db.collection("invoices").onSnapshot(s => { items = s.docs.map(d => ({id: d.id, ...d.data()})); render(); }, () => {});
  })();
})();

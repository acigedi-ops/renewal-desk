// To do: one shared task list for things Eduard owes people, from texts (the twice-daily Mac scan), calls and email.
// A "To do" tab after the Outbox. Kept out of src/app.html, which the L&I routine overwrites; build.mjs loads this after the app.
// The L&I mismatches stay in their own `todo` collection (the L&I routine resolves anything there it didn't create).
// Data: collection `tasks`, one doc per open item, keyed so the same person/thread updates one task instead of piling up:
//   {source: "text"|"call"|"email"|"callback", who, phone, email, client_id, title, detail, category: "client"|"qtax"|"insurer"|"bills"|"personal",
//    urgent: bool, at (when they asked), status: "open"|"done", done_at, created_at, created_by: "routine"|"mac"|"site"}
(() => {
  const q = s => document.querySelector(s);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const when = t => t ? new Date(t).toLocaleString("en-US", {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) : "";
  const SRC = {text: ["Text", "info"], call: ["Call", "amber"], email: ["Email", "plain"], callback: ["Call back", "red"], qtax: ["Quarterly taxes", "amber"], health: ["Site check", "red"]};
  const CAT = [["client", "Clients"], ["qtax", "Quarterly taxes"], ["insurer", "Insurance companies and partners"], ["bills", "Bills"], ["personal", "Personal"], ["", "Other"]];
  let db = null, items = [];
  // Six tabs no longer fit a phone: let the tab row scroll sideways instead of widening the page.
  document.head.insertAdjacentHTML("beforeend", `<style>header.top{grid-template-columns:minmax(0,1fr)}.bar .tabs{min-width:0;max-width:100%;flex:0 1 auto;overflow-x:auto}</style>`);

  const tab = Object.assign(document.createElement("button"), {id: "tab-tasks", type: "button", role: "tab", innerHTML: `To do <span id="tasksN"></span>`});
  tab.setAttribute("aria-selected", "false");
  const main = Object.assign(document.createElement("main"), {id: "tasks", hidden: true});
  const appTabs = ["today", "desk", "todo", "inbox"];
  function mount(){
    const after = q("#tab-outbox") || q("#tab-inbox"), afterMain = q("#outbox") || q("#inbox");
    if (!after || !afterMain || !q("#tab-outbox")) return false;
    after.after(tab); afterMain.after(main);
    // Step aside when any other tab (the app's or the Outbox) is shown.
    const mo = new MutationObserver(() => { if (!main.hidden && [...appTabs, "outbox"].some(k => q("#" + k) && !q("#" + k).hidden)) hide(); });
    [...appTabs, "outbox"].forEach(k => q("#" + k) && mo.observe(q("#" + k), {attributes: true, attributeFilter: ["hidden"]}));
    tab.onclick = show;
    return true;
  }
  function show(){
    [...appTabs, "outbox"].forEach(k => { const m = q("#" + k); if (m) m.hidden = true; q("#tab-" + k)?.setAttribute("aria-selected", "false"); });
    main.hidden = false; tab.setAttribute("aria-selected", "true"); render();
  }
  function hide(){ main.hidden = true; tab.setAttribute("aria-selected", "false"); }

  function card(t){
    const [label, cls] = SRC[t.source] || [t.source || "Task", "plain"];
    const tel = String(t.phone || "").replace(/[^\d+]/g, "");
    return `<section class="card" data-task="${h(t.id)}">
      <h3><span>${t.urgent && t.status !== "done" ? `<span class="chip red">Urgent</span>` : ""}<span class="chip ${cls}">${label}</span> ${h(t.who || t.phone || "")}</span>
        <span class="notice">${when(t.at || t.created_at)}</span></h3>
      <span><b>${h(t.title || "")}</b></span>
      ${t.detail ? `<span class="notice" style="white-space:pre-wrap">${h(t.detail)}</span>` : ""}
      <div class="actions">${/^https:\/\//.test(t.link || "") ? `<a class="btn ghost" href="${h(t.link)}" target="_blank" rel="noopener">Open email</a>` : ""}${tel ? `<a class="btn ghost" href="sms:${h(tel)}">Text</a><a class="btn ghost" href="tel:${h(tel)}">Call</a>` : ""}
        ${t.status === "done" ? `<span class="notice">Done ${when(t.done_at)}</span><button class="btn" data-undo type="button">Not done</button>`
          : `<button class="btn primary" data-done type="button">Done</button>`}</div></section>`;
  }
  function render(){
    const open = items.filter(t => t.status !== "done").sort((a, b) => String(b.at || b.created_at).localeCompare(String(a.at || a.created_at)));
    const done = items.filter(t => t.status === "done").sort((a, b) => String(b.done_at).localeCompare(String(a.done_at))).slice(0, 30);
    const n = q("#tasksN"); if (n) n.textContent = open.length ? `(${open.length})` : "";
    if (main.hidden) return;
    // Missed calls and promised callbacks stay pinned at the very top until handled.
    const isCall = t => t.source === "call" || t.source === "callback";
    const calls = open.filter(isCall), urgent = open.filter(t => t.urgent && !isCall(t));
    const sec = (title, list) => list.length ? `<div class="section-h"><h2>${title}</h2><span class="notice">${list.length}</span></div><div class="list">${list.map(card).join("")}</div>` : "";
    main.innerHTML = `<p class="notice" style="margin:12px 0 0">People waiting on you: missed calls you haven't returned (they close by themselves once you call back), callbacks you promised, and unanswered texts (checked at 9 am and 6 pm). Tap Done when it's handled.</p>` +
      sec("Call back", calls) + sec("Urgent", urgent) +
      CAT.map(([k, title]) => sec(title, open.filter(t => !t.urgent && !isCall(t) && (t.category || "") === k))).join("") +
      (open.length ? "" : `<div class="empty">Nothing waiting. You're caught up.</div>`) +
      (done.length ? `<details style="margin-top:18px"><summary class="notice" style="cursor:pointer">Done (${done.length})</summary><div class="list">${done.map(card).join("")}</div></details>` : "");
  }
  main.addEventListener("click", async e => {
    const el = e.target.closest("[data-task]"); if (!el) return;
    const ref = db.doc("tasks/" + el.dataset.task);
    try {
      if (e.target.closest("[data-done]")) await ref.update({status: "done", done_at: new Date().toISOString()});
      else if (e.target.closest("[data-undo]")) await ref.update({status: "open", done_at: ""});
    } catch (err){ alert("Could not save: " + (err?.message || err)); }
  });

  (async () => {
    for (let i = 0; i < 80 && !mount(); i++) await new Promise(r => setTimeout(r, 100));
    db = await window.claude?.use?.("db");
    if (!db) return;
    db.collection("tasks").onSnapshot(s => { items = s.docs.map(d => ({id: d.id, ...d.data()})); render(); }, () => {});
  })();
})();

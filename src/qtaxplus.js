// Qtax extras, layered on the Qtax screen (src/qtax.js, owned by the Qtax texting work) without changing it:
//  - the filing deadline for the quarter shown, with how many people are still to file;
//  - per person, per quarter: income they sent, tax filed/paid and a confirmation note (collection qtaxq/<personId>_<quarter>);
//  - a "Do not text" flag on qtax/<id> (do_not_text, do_not_text_at, do_not_text_reason). The Mac texter refuses to text anyone
//    flagged, and a "СТОП"/"stop" reply sets it automatically (both in the Qtax texting work); here you can see and change it.
// The "file by" reminder on the To do tab comes from tools/health_check.py (nightly), not from this page.
// Kept out of src/app.html, which the L&I routine overwrites; build.mjs loads this after src/qtax.js.
(() => {
  const q = s => document.querySelector(s);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money = v => { const n = Number(String(v ?? "").replace(/[^\d.-]/g, "")); return String(v ?? "").trim() === "" || isNaN(n) ? "" : "$" + n.toLocaleString("en-US", Number.isInteger(n) ? {} : {minimumFractionDigits: 2, maximumFractionDigits: 2}); };
  const num = v => { const s = String(v ?? "").replace(/[^\d.-]/g, ""); return s === "" || isNaN(+s) ? "" : +s; };
  let db = null, people = [], texts = [], amounts = {}, editing = null, observer = null;

  // Quarterly excise tax (Dept. of Revenue) and L&I quarterly reports are both due the last day of the month after the quarter,
  // moved to the next business day when that falls on a weekend.
  function dueDate(k){
    const y = +k.slice(0, 4), n = +k.slice(-1);
    const d = new Date(y, n * 3 + 1, 0);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d;
  }
  const daysTo = d => { const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((d - t) / 864e5); };
  const qKey = k => "q_" + k.replace("-", "");
  const shownQuarter = () => q("#qQuarter")?.value || "";

  document.head.insertAdjacentHTML("beforeend", `<style>
.qdue{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;border:1px solid var(--line);border-radius:var(--r);padding:10px 12px;background:var(--surface);margin-top:12px}
.qdue.red{border-color:var(--red)}.qdue b{font-size:15px}
.qplus{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;font-size:13px}
.qplus form{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;width:100%}
.qplus input{border:1px solid var(--line);background:var(--surface);border-radius:7px;padding:6px 8px;font-size:14px;width:100%}
</style>`);

  function banner(k){
    const d = dueDate(k), n = daysTo(d);
    const active = people.filter(p => p.active !== false);
    const st = p => (p[qKey(k)] || {}).status || "";
    // Same people as the "Sent you income · to file" card in qtax.js: replied, or the Mac read income from their texts.
    const sent = p => { const a = amounts[`${p.id}_${k}`] || {}; return st(p) === "received" || ["unconfirmed", "confirmed", "unclear"].includes(a.reported_status) || (a.income !== undefined && a.income !== ""); };
    const toFile = active.filter(p => !["filed", "paid"].includes(st(p)) && sent(p)).length, waiting = active.filter(p => st(p) === "asked" && !sent(p)).length;
    const done = active.filter(p => ["filed", "paid"].includes(st(p))).length;
    const when = d.toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric", year: "numeric"});
    const left = n < 0 ? `${-n} day${n === -1 ? "" : "s"} ago` : n === 0 ? "today" : `in ${n} day${n === 1 ? "" : "s"}`;
    return `<div class="qdue ${n <= 7 && (toFile || waiting) ? "red" : ""}" data-qdue="${h(k)}"><b>Q${k.slice(-1)} ${k.slice(0, 4)} is due ${h(when)}</b><span class="chip ${n < 0 ? "plain" : n <= 7 ? "red" : "amber"}">${left}</span>
      <span class="notice">${toFile} to file · ${waiting} haven't sent income · ${done} filed</span></div>`;
  }

  function plusRow(p, k){
    const a = amounts[`${p.id}_${k}`] || {};
    if (editing === p.id) return `<div class="qplus" data-qplus><form onsubmit="return false">
        <label>Income sent<input data-qpf="income" inputmode="decimal" value="${h(a.income ?? "")}" placeholder="$"></label>
        <label>Tax filed / paid<input data-qpf="tax" inputmode="decimal" value="${h(a.tax ?? "")}" placeholder="$"></label>
        <label style="grid-column:1/-1">Confirmation or note<input data-qpf="note" value="${h(a.note || "")}"></label></form>
        <span style="display:flex;gap:6px;margin-left:auto"><button class="btn" type="button" data-qpcancel>Cancel</button><button class="btn primary" type="button" data-qpsave>Save</button></span></div>`;
    const bits = [a.income !== undefined && a.income !== "" && `Income ${money(a.income)}`, a.tax !== undefined && a.tax !== "" && `Tax ${money(a.tax)}`, a.note].filter(Boolean);
    return `<div class="qplus" data-qplus>${p.do_not_text ? `<span class="chip red" title="${h(p.do_not_text_reason || "")}">Do not text</span>` : ""}
      ${bits.length ? `<span>${h(bits.join(" · "))}</span>` : ""}
      <button class="btn ghost" type="button" data-qpedit style="font-size:12.5px">${bits.length ? "Edit amounts" : "+ Amounts"}</button>
      <button class="btn ghost" type="button" data-qpdnt style="font-size:12.5px">${p.do_not_text ? "Allow texts again" : "Do not text"}</button></div>`;
  }

  function dntCard(){
    const list = people.filter(p => p.do_not_text);
    if (!list.length) return "";
    return `<details class="card" data-qdnt><summary style="cursor:pointer"><b>Do not text</b> <span class="chip red">${list.length}</span> <span class="notice">never texted, even if approved</span></summary>
      <div class="list">${list.map(p => `<div class="qrow" data-qc="${h(p.id)}"><div><span class="name">${h(p.name || p.phone)}</span>
        <div class="meta">${h([p.phone, p.do_not_text_reason, p.do_not_text_at && "since " + new Date(p.do_not_text_at).toLocaleDateString("en-US", {month: "short", day: "numeric"})].filter(Boolean).join(" · "))}</div></div>
        <div class="acts"><button class="btn ghost" type="button" data-qpdnt>Allow texts again</button></div></div>`).join("")}</div></details>`;
  }

  // Add our parts after each redraw of the Qtax screen. Idempotent: the observer also sees our own additions.
  function decorate(){
    const root = q("#qtaxMode"); if (!root || root.hidden) return;
    const k = shownQuarter(); if (!k) return;
    const head = root.querySelector(":scope > header.top");
    if (head && !root.querySelector(":scope > [data-qdue]")) head.insertAdjacentHTML("afterend", banner(k));
    const dueBox = root.querySelector(":scope > [data-qdue]");
    if (dueBox && dueBox.dataset.qdue !== k) dueBox.outerHTML = banner(k);
    if (!root.querySelector(":scope > [data-qdnt]") && people.some(p => p.do_not_text)) root.querySelector(":scope > [data-qdue]")?.insertAdjacentHTML("afterend", dntCard());
    root.querySelectorAll(".list > .qrow[data-qc]").forEach(row => {
      if (row.closest("[data-qdnt]") || row.querySelector("[data-qplus]") || row.querySelector("form [data-qe]")) return;
      const p = people.find(x => x.id === row.dataset.qc); if (!p) return;
      row.insertAdjacentHTML("beforeend", plusRow(p, k));
    });
  }
  // Our own data changed: redraw just our parts.
  function refresh(){
    const root = q("#qtaxMode"); if (!root) return;
    const typing = root.contains(document.activeElement) && document.activeElement.matches("[data-qpf]");
    if (typing) return;
    root.querySelectorAll(":scope > [data-qdue], :scope > [data-qdnt], [data-qplus]").forEach(el => el.remove());
    decorate();
  }

  document.addEventListener("click", async e => {
    const t = e.target, row = t.closest?.("#qtaxMode [data-qc]"); if (!row || !t.closest("[data-qpedit],[data-qpcancel],[data-qpsave],[data-qpdnt]")) return;
    e.stopPropagation();
    const p = people.find(x => x.id === row.dataset.qc), k = shownQuarter(); if (!p || !db) return;
    try {
      if (t.closest("[data-qpedit]")){ editing = p.id; refresh(); row.querySelector("[data-qpf]")?.focus(); return; }
      if (t.closest("[data-qpcancel]")){ editing = null; document.activeElement?.blur(); return refresh(); }
      if (t.closest("[data-qpsave]")){
        const f = Object.fromEntries([...row.querySelectorAll("[data-qpf]")].map(i => [i.dataset.qpf, i.value.trim()]));
        await db.doc(`qtaxq/${p.id}_${k}`).update({client_id: p.id, name: p.name || "", quarter: k, income: num(f.income), tax: num(f.tax), note: f.note || "", updated_at: new Date().toISOString()});
        editing = null; document.activeElement?.blur(); return refresh();
      }
      if (t.closest("[data-qpdnt]")){
        if (p.do_not_text){
          if (!confirm(`Allow texts to ${p.name || p.phone} again?`)) return;
          await db.doc("qtax/" + p.id).update({do_not_text: false, do_not_text_at: "", do_not_text_reason: ""});
        } else {
          if (!confirm(`Never text ${p.name || p.phone}? Their unsent texts are dismissed and they stay on your Do not text list until you allow texts again.`)) return;
          await db.doc("qtax/" + p.id).update({do_not_text: true, do_not_text_at: new Date().toISOString(), do_not_text_reason: "Marked by you on the site"});
          // Unsent drafts for them go too, so they can't be approved by accident.
          for (const x of texts.filter(x => x.client_id === p.id && x.status === "draft"))
            await db.doc("texts/" + x.id).update({status: "dismissed", dismissed_at: new Date().toISOString()});
        }
      }
    } catch (err){ alert("Could not save: " + (err?.message || err)); }
  }, true);

  (async () => {
    for (let i = 0; i < 100 && !q("#qtaxMode"); i++) await new Promise(r => setTimeout(r, 100));
    const root = q("#qtaxMode"); if (!root) return;
    observer = new MutationObserver(decorate);
    observer.observe(root, {childList: true, attributes: true, attributeFilter: ["hidden"]});
    db = await window.claude?.use?.("db"); if (!db) return;
    db.collection("qtax").onSnapshot(s => { people = s.docs.map(d => ({id: d.id, ...d.data()})); refresh(); }, () => {});
    db.collection("texts").onSnapshot(s => { texts = s.docs.map(d => ({id: d.id, ...d.data()})); }, () => {});
    db.collection("qtaxq").onSnapshot(s => { amounts = Object.fromEntries(s.docs.map(d => [d.id, d.data()])); refresh(); }, () => {});
    setInterval(() => { const b = q("#qtaxMode > [data-qdue]"); if (b && !q("#qtaxMode").hidden) b.outerHTML = banner(shownQuarter()); }, 3600e3);
  })();
})();

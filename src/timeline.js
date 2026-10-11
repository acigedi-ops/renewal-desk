// Client timeline: one history per client in the client sheet's "Notes and history" card, newest first.
// Pulls together notes (including calls and status changes the app logs), COIs issued, documents added, emails from the Outbox,
// insurance emails found by the email check, to-dos (texts, calls, carrier emails), L&I problems and renewal steps.
// Kept out of src/app.html, which the L&I routine overwrites; build.mjs loads this after the app. It only reads; it never writes.
(() => {
  const q = s => document.querySelector(s);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const last10 = p => String(p || "").replace(/\D/g, "").slice(-10);
  const when = t => { const d = new Date(t); return isNaN(d) ? "" : /^\d{4}-\d{2}-\d{2}$/.test(t)
    ? new Date(t + "T12:00").toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric"})
    : d.toLocaleString("en-US", {month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric", hour: "numeric", minute: "2-digit"}); };
  const KIND = {note: ["Note", "plain"], call: ["Call", "amber"], status: ["Status", "info"], text: ["Text", "info"], email: ["Email", "plain"],
    coi: ["COI", "ok"], doc: ["Document", "ok"], lni: ["L&I", "red"], fixed: ["L&I", "ok"], renewal: ["Renewal", "ok"], task: ["To do", "amber"], mail: ["Email in", "plain"]};
  const STEP = {quoted: "Renewal quoted / sent to client", issued: "New policy or bond issued", sent: "Sent to L&I", onlni: "Shows on L&I"};
  const data = {outbox: [], tasks: [], todo: [], renewals: [], files: [], texts: [], mail: []};
  const SHOW = 12;
  let current = null, all = false;

  document.head.insertAdjacentHTML("beforeend", `<style>
#clientHistory .tl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:8px 0;border-top:1px solid var(--line)}
#clientHistory .tl:first-child{border-top:0}
#clientHistory .tl time{grid-column:2;font-size:12px;color:var(--muted)}
#clientHistory .tl .chip{grid-row:1/3;align-self:start;min-width:64px;text-align:center}
#clientHistory .tl span.t{overflow-wrap:anywhere;white-space:pre-wrap}
</style>`);

  function entries(c){
    const out = [], add = (at, kind, text, link) => { if (at) out.push({at: String(at), kind, text, link}); };
    const phone = last10(c.contact?.phone), name = String(c.name || "").toLowerCase();
    for (const n of c.notes || []) add(n.at, n.kind || "note", n.text);
    for (const x of c.cois || []) add(x.cert_date || x.email_date, "coi", `COI issued${x.holder ? " for " + x.holder : ""}${x.policy ? ` (${x.policy})` : ""}`, x.url);
    for (const f of data.files) if (f.client_id === c.id){
      add(f.at, "doc", `${f.kind || "Document"} added: ${f.name || ""}`, f.removed_at ? "" : f.url);
      if (f.removed_at) add(f.removed_at, "doc", `${f.kind || "Document"} ${f.replaced_by ? "replaced" : "removed"}: ${f.name || ""}`);
    }
    for (const o of data.outbox) if (o.client_id === c.id){
      if (o.sent_at) add(o.sent_at, "email", `Email sent: ${o.subject || ""}`);
      else if (o.status === "dismissed") add(o.dismissed_at || o.created_at, "email", `Email draft dismissed: ${o.subject || ""}`);
      else add(o.created_at, "email", `Email waiting in the Outbox: ${o.subject || ""}`);
    }
    for (const m of data.mail) if (m.client_id === c.id || (m.client && String(m.client).toLowerCase() === name))
      add(m.date, "mail", `${m.subject || ""}${m.summary ? "\n" + m.summary : ""}`, m.link);
    for (const t of data.tasks) if (t.client_id === c.id || (phone && last10(t.phone) === phone)){
      const k = t.source === "text" ? "text" : t.source === "call" || t.source === "callback" ? "call" : "task";
      add(t.at || t.created_at, k, `${t.title || ""}${t.detail ? "\n" + t.detail : ""}`, t.link);
      if (t.status === "done" && t.done_at) add(t.done_at, "task", `Done: ${t.title || ""}`);
    }
    if (phone) for (const t of data.texts) if (last10(t.phone) === phone && t.sent_at) add(t.sent_at, "text", `Text sent: ${t.body || ""}`);
    for (const t of data.todo) if (t.client_id === c.id){
      add(t.first_seen, "lni", t.title + (t.detail ? "\n" + t.detail : ""));
      if (t.done_at) add(t.done_at, "fixed", `Resolved: ${t.title}`);
    }
    for (const r of data.renewals) if (r.client_id === c.id)
      for (const [k, at] of Object.entries(r.steps || {})) add(at, "renewal", `${r.label || "Policy"} ending ${r.ends || ""}: ${STEP[k] || k}`);
    return out.sort((a, b) => new Date(b.at) - new Date(a.at) || b.at.localeCompare(a.at));
  }

  function render(){
    const box = q("#clientHistory"), c = current;
    if (!box || !c || q("#panel")?.dataset.client !== c.id) return;
    const list = entries(c);
    box.innerHTML = list.length ? list.slice(0, all ? list.length : SHOW).map(e => { const [label, cls] = KIND[e.kind] || KIND.note;
      return `<div class="tl"><span class="chip ${cls}">${label}</span><span class="t">${h(e.text)}${e.link ? ` <a href="${h(e.link)}" target="_blank" rel="noopener">Open</a>` : ""}</span><time>${h(when(e.at))}</time></div>`; }).join("") +
      (list.length > SHOW ? `<button class="btn ghost" type="button" data-tlall>${all ? "Show less" : `Show all ${list.length}`}</button>` : "")
      : `<span class="notice">Nothing yet. Notes, calls, emails, COIs and to-dos for this client show up here.</span>`;
  }

  document.addEventListener("rd:client", e => {
    const c = e.detail; if (!c) return;
    if (current?.id !== c.id) all = false;
    current = c;
    const p = q("#panel"); if (p) p.dataset.client = c.id;
    render();
  });
  document.addEventListener("click", e => { if (e.target.closest("#clientHistory [data-tlall]")){ all = !all; render(); } });

  (async () => {
    const db = await window.claude?.use?.("db"); if (!db) return;
    for (const k of Object.keys(data))
      db.collection(k).onSnapshot(s => { data[k] = s.docs.map(d => ({id: d.id, ...d.data()})); render(); }, () => {});
  })();
  window.rdTimeline = {entries};
})();

// Universal search: one box that finds a client, SOS business, Qtax person, to-do, Outbox email or document
// by name, phone, email, license, UBI, policy number or certificate holder. A magnifier button next to Policies / SOS / Qtax
// (or the "/" key) opens it in the side sheet; tapping a result jumps to it.
// Kept out of src/app.html, which the L&I routine overwrites; build.mjs loads this after the app. It only reads.
(() => {
  const q = s => document.querySelector(s);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const low = s => String(s ?? "").toLowerCase();
  const dig = s => String(s ?? "").replace(/\D/g, "");
  const data = {clients: [], sos: [], qtax: [], tasks: [], outbox: [], files: []};
  const LIMIT = 8;
  let open = false;

  document.head.insertAdjacentHTML("beforeend", `<style>
.modes{gap:8px;align-items:center}
.rd-find{flex:0 0 auto;width:40px;height:36px;border:1px solid var(--line);background:var(--surface);border-radius:8px;display:grid;place-items:center;cursor:pointer;color:var(--ink)}
#rdFindQ{width:100%;padding:11px 12px;font-size:16px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink)}
.rd-hit{display:grid;gap:2px;text-align:left;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:9px 11px;cursor:pointer;color:inherit;font:inherit}
.rd-hit b{overflow-wrap:anywhere}.rd-hit .notice{overflow-wrap:anywhere}
</style>`);
  const btn = Object.assign(document.createElement("button"), {type: "button", className: "rd-find", title: "Search everything (/)",
    innerHTML: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`});
  btn.setAttribute("aria-label", "Search everything");

  // Each source: what to search in, and how one hit is shown.
  function hits(term){
    const t = low(term).trim(), d = dig(term);
    if (t.length < 2) return [];
    const has = vals => vals.some(v => low(v).includes(t)) || (d.length >= 4 && vals.some(v => dig(v).includes(d) && dig(v).length >= 4));
    const out = [];
    for (const c of data.clients){
      const pol = (c.policies || []).map(p => p.number), cois = (c.cois || []).flatMap(x => [x.holder, x.policy]);
      const lni = [c.lni?.insurance?.number, c.lni?.bond?.number];
      if (!has([c.name, c.license, c.ubi, c.contact?.name, c.contact?.phone, c.contact?.email, c.address, ...pol, ...cois, ...lni])) continue;
      const why = [c.license, c.ubi && "UBI " + c.ubi].filter(Boolean).join(" · ");
      const extra = [...pol, ...lni].find(n => n && low(n).includes(t)) ? "policy " + [...pol, ...lni].find(n => n && low(n).includes(t))
        : cois.find(n => n && low(n).includes(t)) ? "COI " + cois.find(n => n && low(n).includes(t)) : "";
      out.push({group: "Clients", title: c.name, sub: [why, extra].filter(Boolean).join(" · "), go: () => window.openClient?.(c.id)});
    }
    for (const f of data.files) if (!f.removed_at && has([f.name, f.kind]))
      out.push({group: "Documents", title: f.name, sub: `${f.kind || "Document"} · ${f.client || ""}`, go: () => window.openClient?.(f.client_id)});
    for (const b of data.sos) if (has([b.name, b.ubi, b.sos?.name]))
      out.push({group: "SOS businesses", title: b.sos?.name || b.name, sub: [b.ubi && "UBI " + b.ubi, b.sos?.status].filter(Boolean).join(" · "),
        go: () => { q('[data-mode="sos"]')?.click(); window.sosOpen?.(b.id); }});
    for (const p of data.qtax) if (has([p.name, p.phone, p.notes]))
      out.push({group: "Qtax", title: p.name || p.phone, sub: [p.phone, p.active === false && "removed from the list", p.do_not_text && "do not text"].filter(Boolean).join(" · "),
        go: () => { q("[data-qmode]")?.click(); setTimeout(() => { const s = q("#qq"); if (s){ s.value = p.name || dig(p.phone).slice(-10); s.dispatchEvent(new Event("input", {bubbles: true})); } }, 50); }});
    for (const k of data.tasks) if (has([k.who, k.phone, k.title, k.detail, k.email]))
      out.push({group: "To do", title: k.title || k.who, sub: [k.who, k.status === "done" ? "done" : "open"].filter(Boolean).join(" · "),
        go: () => { q('[data-mode="policies"]')?.click(); q("#tab-tasks")?.click(); setTimeout(() => q(`[data-task="${CSS.escape(k.id)}"]`)?.scrollIntoView({block: "center"}), 80); }});
    for (const o of data.outbox) if (has([o.subject, o.client_name, ...(o.to || [])]))
      out.push({group: "Outbox", title: o.subject, sub: [o.client_name, o.status].filter(Boolean).join(" · "),
        go: () => { q('[data-mode="policies"]')?.click(); q("#tab-outbox")?.click(); }});
    return out;
  }

  function results(){
    const box = q("#rdFindR"); if (!box) return;
    const term = q("#rdFindQ").value, list = hits(term);
    if (low(term).trim().length < 2){ box.innerHTML = `<span class="notice">Type a name, phone, email, license, UBI, policy number or certificate holder.</span>`; return; }
    if (!list.length){ box.innerHTML = `<div class="empty">Nothing matches "${h(term)}".</div>`; return; }
    const groups = [...new Set(list.map(x => x.group))];
    box.innerHTML = groups.map(g => { const gl = list.filter(x => x.group === g);
      return `<div class="section-h"><h2>${h(g)}</h2><span class="notice">${gl.length}</span></div><div class="list">${gl.slice(0, LIMIT).map(x =>
        `<button class="rd-hit" type="button" data-hit="${list.indexOf(x)}"><b>${h(x.title)}</b>${x.sub ? `<span class="notice">${h(x.sub)}</span>` : ""}</button>`).join("")}
        ${gl.length > LIMIT ? `<span class="notice">${gl.length - LIMIT} more. Type more of the name to narrow it down.</span>` : ""}</div>`; }).join("");
    box.onclick = e => { const b = e.target.closest("[data-hit]"); if (!b) return; const x = list[+b.dataset.hit]; close(); x.go(); };
  }

  function show(){
    const sheet = q("#sheet"), panel = q("#panel"); if (!sheet || !panel) return;
    window.closeSheet?.();
    panel.innerHTML = `<div class="panel-h"><h2>Search everything</h2><button class="btn" type="button" id="rdFindClose">Close</button></div>
      <input id="rdFindQ" type="search" placeholder="Name, phone, email, policy number…" autocomplete="off" aria-label="Search everything">
      <div id="rdFindR" style="display:grid;gap:12px"></div>`;
    delete panel.dataset.client;
    sheet.hidden = false; open = true;
    q("#rdFindClose").onclick = close;
    q("#rdFindQ").addEventListener("input", results);
    results(); q("#rdFindQ").focus();
  }
  function close(){ open = false; window.closeSheet ? window.closeSheet() : (q("#sheet").hidden = true); }
  btn.onclick = show;
  document.addEventListener("keydown", e => {
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.target.closest?.("input,textarea,select,[contenteditable]")){ e.preventDefault(); show(); }
    else if (e.key === "Escape" && open) close();
  });

  (async () => {
    for (let i = 0; i < 80 && !q(".modes"); i++) await new Promise(r => setTimeout(r, 100));
    q(".modes")?.append(btn);
    const db = await window.claude?.use?.("db"); if (!db) return;
    for (const k of Object.keys(data))
      db.collection(k).onSnapshot(s => { data[k] = s.docs.map(d => ({id: d.id, ...d.data()})); if (open) results(); }, () => {});
  })();
})();

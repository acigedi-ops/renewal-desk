// Outbox: every email waits here prefilled; Eduard edits it and taps "Approve & send" (sent by the Worker at /api/outbox/send).
// Kept out of src/app.html, which the L&I routine overwrites; build.mjs loads this after the app's own scripts.
// Data: collection `outbox`, one doc per email:
//   {kind: "lni_bond"|"welcome", client_id, client_name, to: [], cc: [], subject, body,
//    attachments: [{file, url: "/coi/<path>"}], status: "pending"|"sending"|"sent"|"failed"|"dismissed",
//    created_at, created_by: "site"|"routine", source, sent_at, error}
(() => {
  const LNI_TO = "tukwila@lni.wa.gov";
  const SIGNATURE = "--\nEduard Kaplun\nFounder\nKaplun Licensing LLC\n(253)-335-9649\nKaplunlicensing@gmail.com\nKaplunlicensing.com";
  const q = s => document.querySelector(s);
  document.head.insertAdjacentHTML("beforeend", `<style>.bar .tabs{overflow-x:auto;max-width:100%;scrollbar-width:none}.bar .tabs button{white-space:nowrap}</style>`);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const ubiFmt = u => { const d = String(u || "").replace(/\D/g, ""); return d.length === 9 ? `${d.slice(0,3)} ${d.slice(3,6)} ${d.slice(6)}` : String(u || ""); };
  const when = t => t ? new Date(t).toLocaleString("en-US", {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) : "";
  const list = v => (Array.isArray(v) ? v : String(v || "").split(/[,;\s]+/)).map(s => s.trim()).filter(Boolean);
  const appClients = () => { try { return clients; } catch { return []; } };       // the app's own list (global `let`)
  const appOpenId = () => { try { return openId; } catch { return null; } };

  // Templates. The routine's tools/outbox.py uses the same wording.
  const T = {
    lni_bond(c){
      return {to: [LNI_TO], cc: [], subject: `NEW BOND - ${c.name} - ${c.license}`,
        body: `Hello please update the bond for this client. Bond is attached below.\n\nBusiness Name - ${c.name}\nUBI - ${ubiFmt(c.ubi)}\nLNI# - ${c.license}\n\n${SIGNATURE}`};
    },
    welcome(c){
      const first = String(c.contact?.name || "").trim().split(/\s+/)[0];
      return {to: list(c.contact?.email), cc: [], subject: `Welcome to Kaplun Licensing - ${c.name}`,
        body: `Hi ${first || "there"},\n\nWelcome to Kaplun Licensing, and thank you for trusting us with ${c.name}! Your documents are attached:\n\n` +
          `- Certificate of insurance (liability)\n- Contractor bond\n\nPlease keep them for your records. We keep an eye on your L&I registration, insurance and bond, and we will reach out before anything renews. ` +
          `If you need a certificate for a job or have any questions, just reply to this email or call us.\n\nThank you,\n\n${SIGNATURE}`};
    }
  };

  let db = null, assets = null, items = [];

  // ---- Tab ----
  const tabBtn = Object.assign(document.createElement("button"), {id: "tab-outbox", type: "button", role: "tab", innerHTML: `Outbox <span id="outboxN"></span>`});
  tabBtn.setAttribute("aria-selected", "false");
  const main = Object.assign(document.createElement("main"), {id: "outbox", hidden: true});
  const others = ["today", "desk", "todo", "inbox"];
  function mount(){
    const inboxTab = q("#tab-inbox"), inboxMain = q("#inbox");
    if (!inboxTab || !inboxMain) return false;
    inboxTab.after(tabBtn); inboxMain.after(main);
    // When the app switches to any of its own tabs, step aside.
    const mo = new MutationObserver(() => { if (!main.hidden && others.some(k => !q("#" + k).hidden)) hideOutbox(); });
    others.forEach(k => mo.observe(q("#" + k), {attributes: true, attributeFilter: ["hidden"]}));
    tabBtn.onclick = showOutbox;
    return true;
  }
  function showOutbox(){
    others.forEach(k => { q("#" + k).hidden = true; q("#tab-" + k)?.setAttribute("aria-selected", "false"); });
    main.hidden = false; tabBtn.setAttribute("aria-selected", "true"); render();
  }
  function hideOutbox(){ main.hidden = true; tabBtn.setAttribute("aria-selected", "false"); }

  // ---- List ----
  function render(){
    const open = items.filter(x => ["pending", "failed", "sending"].includes(x.status)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const sent = items.filter(x => x.status === "sent").sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at))).slice(0, 25);
    const n = q("#outboxN"); if (n) n.textContent = open.length ? String(open.length) : "";
    if (main.hidden) return;
    if (main.contains(document.activeElement) && document.activeElement.matches("input,textarea")) return; // don't wipe typing
    main.innerHTML = `
      <div class="section-h"><h2>Waiting for you</h2><span class="notice">Edit anything, then tap Approve &amp; send. It goes out from kaplunlicensing@gmail.com.</span></div>
      ${open.length ? `<div class="list">${open.map(card).join("")}</div>` : `<div class="empty">Nothing waiting. New bond emails appear here when you upload a bond on a client card, and welcome emails when a new policy or bond is issued.</div>`}
      ${sent.length ? `<div class="section-h"><h2>Sent</h2></div><div class="list">${sent.map(x => `<div class="mail"><span class="s">${h(x.subject)}</span>
        <span class="notice">To ${h(list(x.to).join(", "))} · sent ${when(x.sent_at)}${(x.attachments || []).length ? ` · ${(x.attachments || []).length} attachment${x.attachments.length > 1 ? "s" : ""}` : ""}</span></div>`).join("")}</div>` : ""}`;
  }
  const kindChip = k => k === "lni_bond" ? `<span class="chip info">L&amp;I bond</span>` : k === "welcome" ? `<span class="chip ok">Welcome</span>` : `<span class="chip plain">${h(k)}</span>`;
  function card(x){
    const st = x.status === "failed" ? `<span class="chip red">Not sent: ${h(x.error || "error")}</span>` : x.status === "sending" ? `<span class="chip amber">Sending…</span>` : "";
    return `<section class="card" data-ob="${h(x.id)}">
      <h3><span>${kindChip(x.kind)} ${h(x.client_name || "")}</span><span class="notice">${x.created_by === "routine" ? "Prefilled from email" : "Prefilled"} ${when(x.created_at)}</span></h3>
      ${x.source ? `<span class="notice">${h(x.source)}</span>` : ""}${st}
      <form class="form" onsubmit="return false">
        <label class="full">To<input data-f="to" value="${h(list(x.to).join(", "))}" placeholder="name@example.com"></label>
        <label class="full">Cc<input data-f="cc" value="${h(list(x.cc).join(", "))}"></label>
        <label class="full">Subject<input data-f="subject" value="${h(x.subject)}"></label>
        <label class="full">Message<textarea data-f="body" rows="11">${h(x.body)}</textarea></label>
      </form>
      <div>${(x.attachments || []).map((a, i) => `<div class="pol"><span><a href="${h(a.url)}" target="_blank" rel="noopener">${h(a.file || "attachment.pdf")}</a></span><button class="btn ghost" data-rm="${i}" type="button">Remove</button></div>`).join("") || `<span class="notice">No attachments.</span>`}
        <label class="btn ghost" style="display:inline-block;margin-top:6px">+ Attach PDF<input type="file" accept="application/pdf" data-add hidden multiple></label></div>
      <div class="actions"><span class="notice" data-msg></span>
        <button class="btn" data-dismiss type="button">Dismiss</button><button class="btn" data-save type="button">Save</button>
        <button class="btn primary" data-send type="button" ${x.status === "sending" ? "disabled" : ""}>Approve &amp; send</button></div>
    </section>`;
  }
  const fields = el => Object.fromEntries([...el.querySelectorAll("[data-f]")].map(i => [i.dataset.f, ["to", "cc"].includes(i.dataset.f) ? list(i.value) : i.value]));

  main.addEventListener("click", async e => {
    const el = e.target.closest("[data-ob]"); if (!el) return;
    const id = el.dataset.ob, x = items.find(i => i.id === id); if (!x) return;
    const msg = el.querySelector("[data-msg]"), ref = db.doc("outbox/" + id);
    const say = t => { msg.textContent = t; };
    try {
      if (e.target.closest("[data-rm]")){
        const atts = (x.attachments || []).filter((_, i) => i !== +e.target.closest("[data-rm]").dataset.rm);
        await ref.update({...fields(el), attachments: atts}); render();
      } else if (e.target.closest("[data-dismiss]")){
        if (!confirm("Dismiss this email without sending it?")) return;
        await ref.update({status: "dismissed", dismissed_at: new Date().toISOString()});
      } else if (e.target.closest("[data-save]")){
        await ref.update(fields(el)); say("Saved.");
      } else if (e.target.closest("[data-send]")){
        const f = fields(el);
        if (!f.to.length) return say("Add who it goes to first.");
        if (!confirm(`Send "${f.subject}" to ${f.to.join(", ")} now?`)) return;
        e.target.disabled = true; say("Sending…");
        await ref.update(f);
        const {data} = await window.rdSupabase.auth.getSession();
        const r = await fetch("/api/outbox/send", {method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token || ""}`}, body: JSON.stringify({id})});
        const out = await r.json().catch(() => ({}));
        if (!r.ok){ e.target.disabled = false; say("Not sent: " + (out.error || r.status)); }
      }
    } catch (err){ say("Could not save: " + (err?.message || err)); }
  });
  main.addEventListener("change", async e => {
    const inp = e.target.closest("[data-add]"); if (!inp) return;
    const el = inp.closest("[data-ob]"), x = items.find(i => i.id === el.dataset.ob);
    const msg = el.querySelector("[data-msg]");
    try { msg.textContent = "Uploading…"; const add = await uploadAll(inp.files);
      await db.doc("outbox/" + x.id).update({...fields(el), attachments: [...(x.attachments || []), ...add]}); }
    catch (err){ msg.textContent = "Upload failed: " + (err?.message || err); }
  });

  async function uploadAll(files){
    const out = [];
    for (const f of files){
      if (!assets) throw new Error("file storage isn't ready yet");
      const up = await assets.upload(f, {filename: f.name});
      out.push({file: f.name, url: up.url, uploaded_at: new Date().toISOString()});
    }
    return out;
  }
  async function addItem(kind, c, attachments, source){
    const id = `${kind}-${String(c.id).replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now()}`;
    await db.doc("outbox/" + id).set({kind, client_id: c.id, client_name: c.name, ...T[kind](c), attachments,
      status: "pending", created_at: new Date().toISOString(), created_by: "site", source: source || ""});
    return id;
  }

  // ---- Client card: "Send bond to L&I" and "Welcome email" ----
  function cardHtml(){
    return `<section class="card" id="obCard"><h3>Emails <span>
        <label class="btn primary">Send bond to L&amp;I<input type="file" accept="application/pdf" id="obBond" hidden multiple></label>
        <button class="btn" id="obWelcome" type="button">Welcome email</button></span></h3>
      <span class="notice" id="obMsg">Pick the bond PDF (and rider, if any). The L&amp;I email is prefilled in the Outbox for you to approve.</span></section>`;
  }
  let flash = null; // {id, until}: the panel re-renders when the client doc changes, so remember the confirmation briefly
  function showFlash(){
    const m = q("#obMsg"); if (!m) return;
    m.innerHTML = `Added to the Outbox. <button class="btn ghost" type="button" id="obGo">Open Outbox</button>`;
    q("#obGo").onclick = () => { flash = null; q("#close")?.click(); showOutbox(); };
  }
  function decoratePanel(){
    const panel = q("#panel"), coi = panel?.querySelector("#newCoi")?.closest("section");
    if (!coi || panel.querySelector("#obCard")) return;
    const c = appClients().find(x => x.id === appOpenId()); if (!c) return;
    coi.insertAdjacentHTML("afterend", cardHtml());
    const msg = panel.querySelector("#obMsg");
    const done = () => { flash = {id: c.id, until: Date.now() + 15000}; showFlash(); };
    if (flash?.id === c.id && flash.until > Date.now()) showFlash();
    panel.querySelector("#obBond").onchange = async e => {
      const files = [...e.target.files]; if (!files.length) return;
      try {
        msg.textContent = "Uploading…";
        const atts = await uploadAll(files);
        // Keep the bond on the client too, so the welcome email can attach it later.
        await db.doc("clients/" + c.id).update({bond_files: [...(c.bond_files || []), ...atts]});
        await addItem("lni_bond", c, atts, "Bond uploaded on the client card");
        done();
      } catch (err){ (q("#obMsg") || msg).textContent = "Could not add it: " + (err?.message || err); }
    };
    panel.querySelector("#obWelcome").onclick = async () => {
      try {
        const live = (c.cois || []).filter(x => x.url && !(x.expiration && new Date(x.expiration) < new Date()))
          .sort((a, b) => String(b.cert_date || b.email_date).localeCompare(String(a.cert_date || a.email_date))).slice(0, 2);
        const bond = (c.bond_files || []).slice(-2);
        await addItem("welcome", c, [...live, ...bond].map(a => ({file: a.file || "document.pdf", url: a.url})), "Started from the client card");
        done();
      } catch (err){ (q("#obMsg") || msg).textContent = "Could not add it: " + (err?.message || err); }
    };
  }

  // ---- Start ----
  (async () => {
    for (let i = 0; i < 50 && !mount(); i++) await new Promise(r => setTimeout(r, 100));
    const panel = q("#panel"); if (panel) new MutationObserver(decoratePanel).observe(panel, {childList: true});
    db = await window.claude?.use?.("db"); assets = await window.claude?.use?.("assets");
    if (!db) return;
    db.collection("outbox").onSnapshot(s => { items = s.docs.map(d => ({id: d.id, ...d.data()})); render(); }, () => {});
  })();
})();

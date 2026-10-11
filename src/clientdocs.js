// Documents on the client card: dec pages, bond PDFs, applications, photos and anything else, next to the COIs.
// Files go in the private `cois` storage bucket (same as COIs, opened through short-lived signed links); the list is the
// `files` collection, one doc per file: {client_id, name, kind, url, type, size, at, removed_at, replaced_by}.
// Remove and Replace hide the old entry (removed_at); the file itself stays in storage and in the nightly backups.
// Kept out of src/app.html, which the L&I routine overwrites; build.mjs loads this after the app.
(() => {
  const q = s => document.querySelector(s);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const KINDS = ["Dec page", "Bond", "Application", "Policy", "Endorsement", "Invoice or receipt", "License or ID", "Photo", "Other"];
  const MAX = 25 * 1024 * 1024;
  const day = t => t ? new Date(t).toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric"}) : "";
  const size = n => n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n ? `${Math.max(1, Math.round(n / 1e3))} KB` : "";
  let db = null, assets = null, files = [], current = null, replacing = null, busy = false;

  function render(){
    const box = q("#clientDocs"), c = current;
    if (!box || !c) return;
    const list = files.filter(f => f.client_id === c.id && !f.removed_at).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const msg = q("#cdMsg")?.textContent || "";
    box.hidden = false;
    box.innerHTML = `<h3>Documents <label class="btn primary" style="cursor:pointer">+ Add file<input id="cdFile" type="file" accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx" multiple hidden></label></h3>
      <label class="notice" style="display:flex;gap:6px;align-items:center">Type of document<select id="cdKind" class="btn" style="padding:4px 6px">${KINDS.map(k => `<option>${k}</option>`).join("")}</select></label>
      ${list.length ? list.map(f => `<div class="pol" data-fid="${h(f.id)}"><span><b>${h(f.kind || "Document")}</b><br><span class="notice">${h(f.name)}${f.size ? " · " + size(f.size) : ""} · added ${h(day(f.at))}</span></span>
        <span style="text-align:right;display:grid;gap:4px;align-content:start"><a href="${h(f.url)}" target="_blank" rel="noopener" style="font-size:12.5px">View</a>
          <button class="btn ghost" type="button" data-cdreplace style="font-size:12px">${replacing === f.id ? "Pick the new file…" : "Replace"}</button>
          <button class="btn ghost" type="button" data-cdremove style="font-size:12px">Remove</button></span></div>`).join("")
        : `<span class="notice">Keep dec pages, bond PDFs, applications and other papers for this client here. COIs stay in their own section above.</span>`}
      <span class="notice" id="cdMsg">${h(msg)}</span>`;
    const k = sessionStorageGet("rd-doc-kind"); if (k) q("#cdKind").value = k;
  }
  const sessionStorageGet = k => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const sessionStorageSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch {} };
  const say = t => { const m = q("#cdMsg"); if (m) m.textContent = t; };

  async function upload(list){
    const c = current; if (!c || busy) return;
    if (!db || !assets){ say("Not connected. Reload the page."); return; }
    const kind = q("#cdKind")?.value || "Other", old = replacing ? files.find(f => f.id === replacing) : null;
    busy = true;
    try {
      for (const file of list){
        if (file.size > MAX){ say(`${file.name} is over 25 MB. Not added.`); continue; }
        say(`Uploading ${file.name}…`);
        const {id, url} = await assets.upload(file, {filename: file.name});
        const now = new Date().toISOString();
        await db.doc("files/" + id).set({client_id: c.id, client: c.name, name: file.name, kind: old?.kind || kind, url, type: file.type || "", size: file.size, at: now, removed_at: ""});
        if (old) await db.doc("files/" + old.id).update({removed_at: now, replaced_by: id});
        say(old ? `Replaced with ${file.name}.` : `Added ${file.name}.`);
        if (old) break; // one file replaces one file
      }
    } catch (e){ say("Could not upload. Check your connection and try again."); }
    busy = false; replacing = null; render();
  }

  document.addEventListener("change", e => {
    if (e.target.id === "cdKind") sessionStorageSet("rd-doc-kind", e.target.value);
    if (e.target.id === "cdFile" && e.target.files?.length) upload([...e.target.files]);
  });
  // Closing the file picker without choosing a file cancels Replace.
  document.addEventListener("cancel", e => { if (e.target.id === "cdFile" && replacing){ replacing = null; render(); } }, true);
  document.addEventListener("click", async e => {
    const row = e.target.closest("#clientDocs [data-fid]"); if (!row) return;
    const f = files.find(x => x.id === row.dataset.fid); if (!f) return;
    if (e.target.closest("[data-cdreplace]")){ replacing = f.id; render(); q("#cdFile")?.click(); return; }
    const b = e.target.closest("[data-cdremove]"); if (!b) return;
    if (b.dataset.confirm !== "1"){ b.dataset.confirm = "1"; b.textContent = "Tap to confirm"; return; }
    b.disabled = true;
    try { await db.doc("files/" + f.id).update({removed_at: new Date().toISOString()}); f.removed_at = new Date().toISOString(); render(); say(`Removed ${f.name}.`); }
    catch { b.disabled = false; b.textContent = "Could not remove"; }
  });

  document.addEventListener("rd:client", e => { if (current?.id !== e.detail?.id) replacing = null; current = e.detail; render(); });

  (async () => {
    db = await window.claude?.use?.("db"); if (!db) return;
    assets = await window.claude?.use?.("assets");
    db.collection("files").onSnapshot(s => {
      files = s.docs.map(d => ({id: d.id, ...d.data()}));
      // Don't redraw under an open file picker or a confirm tap.
      if (!replacing && !q("#clientDocs [data-confirm='1']")) render();
    }, () => {});
  })();
})();

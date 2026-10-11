// Health strip: one line under the tabs that says whether everything that runs on its own is still running.
// Green when all is well; red chips name what's late, so a stopped check or a Mac that went to sleep never goes unnoticed.
// Kept out of src/app.html, which the L&I routine overwrites; build.mjs loads this after the app.
// Reads (never writes): clients[].lni.checked_at (L&I check), meta/status.checked_at (email check), sosmeta/status.checked_at (SOS),
// qtaxmeta/mac.seen_at (Mac texter heartbeat), meta/backup.at (nightly backup), and outbox/texts for sends stuck mid-way.
(() => {
  const q = s => document.querySelector(s);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const HOUR = 3600e3, MIN = 60e3;
  // How old each one may get before it counts as late. The L&I check runs 8:50, 12:50 and 5:50 Pacific, so overnight is the longest gap (15 h).
  const LATE = {lni: 16 * HOUR, mail: 16 * HOUR, sos: 8 * 24 * HOUR, mac: 20 * MIN, backup: 30 * HOUR};
  const STUCK = {outbox: 5 * MIN, texts: 15 * MIN};
  const data = {clients: [], meta: {}, sos: {}, mac: null, backup: null, outbox: [], texts: []};
  let open = false;

  document.head.insertAdjacentHTML("beforeend", `<style>
#health{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12.5px;color:var(--muted);margin:8px 0 0}
#health .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);display:inline-block}
#health.bad .dot{background:var(--red)}
#health button{border:0;background:none;padding:0;color:inherit;text-decoration:underline;font-size:inherit;cursor:pointer}
#health .list{flex-basis:100%;display:grid;gap:2px}
</style>`);
  const strip = Object.assign(document.createElement("div"), {id: "health", role: "status"});

  const ago = t => {
    if (!t) return "never";
    const ms = Date.now() - new Date(t);
    if (ms < 2 * MIN) return "just now";
    if (ms < HOUR) return `${Math.round(ms / MIN)} min ago`;
    if (ms < 36 * HOUR) return `${Math.round(ms / HOUR)} h ago`;
    return `${Math.round(ms / (24 * HOUR))} days ago`;
  };
  const late = (t, k) => !t || Date.now() - new Date(t) > LATE[k];
  const maxIso = list => list.reduce((m, x) => (x && x > m ? x : m), "");

  function checks(){
    const lni = maxIso(data.clients.map(c => c.lni?.checked_at));
    const out = [
      {k: "lni", label: "L&I check", at: lni, fix: "The L&I check hasn't run. Your L&I statuses may be out of date."},
      {k: "mail", label: "Email check", at: data.meta.checked_at, fix: "The email check hasn't run."},
      {k: "sos", label: "SOS check", at: data.sos.checked_at, fix: "The weekly SOS check hasn't run."},
      {k: "mac", label: "Mac texter", at: data.mac?.seen_at, fix: "Your Mac texter isn't checking in. Texts, replies and missed calls wait until the Mac is on and awake."},
      {k: "backup", label: "Backup", at: data.backup?.at, fix: "The nightly backup hasn't run."}
    ].map(x => ({...x, bad: late(x.at, x.k)}));
    if (data.backup?.error) Object.assign(out.find(x => x.k === "backup"), {bad: true, fix: `The last backup failed: ${data.backup.error}`});
    if (data.mac?.error) out.push({k: "macerr", label: "Mac texter error", at: data.mac.seen_at, bad: true, fix: data.mac.error});
    const stuckOut = data.outbox.filter(x => x.status === "unsure" || (x.status === "sending" && Date.now() - new Date(x.claimed_at || x.created_at || 0) > STUCK.outbox));
    const stuckTxt = data.texts.filter(x => x.status === "unsure" || (x.status === "sending" && Date.now() - new Date(x.claimed_at || x.approved_at || 0) > STUCK.texts));
    if (stuckOut.length) out.push({k: "outbox", label: `${stuckOut.length} email${stuckOut.length > 1 ? "s" : ""} to check`, bad: true, fix: "An email may or may not have gone out. Open the Outbox and tell it what your Sent mail shows."});
    if (stuckTxt.length) out.push({k: "texts", label: `${stuckTxt.length} text${stuckTxt.length > 1 ? "s" : ""} to check`, bad: true, fix: "A text may or may not have gone out. Open Qtax to see which."});
    return out;
  }

  function render(){
    const list = checks(), bad = list.filter(x => x.bad);
    strip.className = bad.length ? "bad" : "";
    strip.innerHTML = `<span class="dot" aria-hidden="true"></span>` +
      (bad.length ? bad.map(x => `<span class="chip red">${h(x.label)}${(x.k in LATE) ? `: ${h(ago(x.at))}` : ""}</span>`).join("")
        : `<span>Everything is running</span>`) +
      ` <button type="button" data-hdetails>${open ? "Hide details" : "Details"}</button>` +
      (open ? `<div class="list">${list.map(x => `<span>${x.bad ? "⚠️" : "✓"} ${h(x.label)}${(x.k in LATE) ? ` · ${h(ago(x.at))}` : ""}${x.bad ? ` · ${h(x.fix)}` : ""}</span>`).join("")}</div>` : "");
  }
  strip.addEventListener("click", e => { if (e.target.closest("[data-hdetails]")){ open = !open; render(); } });

  function mount(){
    const bar = q("#policyMode header.top .bar");
    if (!bar) return false;
    bar.after(strip); render();
    return true;
  }
  if (!mount()) document.addEventListener("DOMContentLoaded", mount);
  setInterval(render, MIN);   // "x min ago" and lateness move on even when no data changes

  (async () => {
    const db = await window.claude?.use?.("db"); if (!db) return;
    const list = (col, key) => db.collection(col).onSnapshot(s => { data[key] = s.docs.map(d => ({id: d.id, ...d.data()})); render(); }, () => {});
    const doc = (path, key) => db.doc(path).onSnapshot(s => { data[key] = s.exists ? s.data() : (key === "meta" || key === "sos" ? {} : null); render(); }, () => {});
    list("clients", "clients"); list("outbox", "outbox"); list("texts", "texts");
    doc("meta/status", "meta"); doc("sosmeta/status", "sos"); doc("qtaxmeta/mac", "mac"); doc("meta/backup", "backup");
  })();
})();

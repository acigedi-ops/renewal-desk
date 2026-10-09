// Stands in for the claude.ai artifact runtime (window.claude.use) so app.html runs unchanged on its own site.
// db -> Supabase table `docs`, assets -> private Storage bucket `cois`, downloads -> a normal browser download.
(() => {
  const cfg = window.RD_CONFIG || {};
  const sb = window.supabase.createClient(cfg.url, cfg.key, {
    // Stay signed in: keep the session in localStorage (kept by iOS home-screen apps) and renew it in the background.
    auth: {persistSession: true, autoRefreshToken: true, storage: window.localStorage, storageKey: "rhino-renewal-desk-auth"}
  });
  // Phones pause background timers, so renew the session as soon as the app comes back to the front.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible"){ sb.auth.startAutoRefresh(); sb.auth.getSession(); }
    else sb.auth.stopAutoRefresh();
  });
  window.rdSupabase = sb;

  // ---- Sign in ----
  const css = `#rd-login{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:var(--bg,#EEF0EC);padding:16px}
#rd-login form{width:min(360px,100%);display:grid;gap:10px;background:var(--surface,#fff);border:1px solid var(--line,#D3D9D4);border-radius:10px;padding:20px}
#rd-login h2{font-family:var(--display,sans-serif);font-size:20px;margin:0 0 4px}
#rd-login input{padding:10px;border:1px solid var(--line,#D3D9D4);border-radius:8px;background:transparent;width:100%}
#rd-login button{padding:10px;border:0;border-radius:8px;background:var(--accent,#0E6655);color:var(--accent-ink,#fff);font-weight:600}
#rd-login p{margin:0;min-height:1.2em;font-size:13px;color:var(--red,#B42318)}
#rd-out{display:block;margin:24px auto 0;font-size:12px;background:none;border:0;color:var(--muted,#5B6863);text-decoration:underline}`;
  document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

  let authed;
  const ready = new Promise(r => (authed = r));
  function showLogin(){
    if (document.getElementById("rd-login")) return;
    document.body.insertAdjacentHTML("beforeend", `<div id="rd-login"><form>
      <h2>Rhino Renewal Desk</h2>
      <input id="rd-email" type="email" autocomplete="username" placeholder="Email" required>
      <input id="rd-pass" type="password" autocomplete="current-password" placeholder="Password" required>
      <button type="submit">Sign in</button><p id="rd-msg"></p></form></div>`);
    document.querySelector("#rd-login form").onsubmit = async e => {
      e.preventDefault();
      const msg = document.getElementById("rd-msg"); msg.textContent = "";
      const {error} = await sb.auth.signInWithPassword({email: document.getElementById("rd-email").value.trim(), password: document.getElementById("rd-pass").value});
      if (error) msg.textContent = "Wrong email or password.";
    };
  }
  function signedIn(){
    document.getElementById("rd-login")?.remove();
    if (!document.getElementById("rd-out")){
      document.body.insertAdjacentHTML("beforeend", `<button id="rd-out" type="button">Sign out</button>`);
      document.getElementById("rd-out").onclick = async () => { await sb.auth.signOut(); location.reload(); };
    }
    authed();
  }
  sb.auth.onAuthStateChange((_ev, session) => { if (session) signedIn(); });
  const start = () => sb.auth.getSession().then(({data}) => data.session ? signedIn() : showLogin());
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);

  // ---- Database ----
  // One live cache per collection, fed by an initial load plus realtime changes, so many listeners share one channel.
  const caches = {};
  function cache(col){
    if (caches[col]) return caches[col];
    const c = caches[col] = {docs: new Map(), subs: new Set(), loaded: false};
    const emit = () => c.subs.forEach(f => f());
    c.emit = emit;
    (async () => {
      await ready;
      sb.channel("docs-" + col).on("postgres_changes", {event: "*", schema: "public", table: "docs", filter: `collection=eq.${col}`}, p => {
        if (p.eventType === "DELETE") c.docs.delete(p.old.id); else c.docs.set(p.new.id, p.new.data);
        emit();
      }).subscribe();
      for (let from = 0; ; from += 1000){
        const {data, error} = await sb.from("docs").select("id,data").eq("collection", col).range(from, from + 999);
        if (error){ c.subs.forEach(f => f(error)); return; }
        data.forEach(r => c.docs.set(r.id, r.data));
        if (data.length < 1000) break;
      }
      c.loaded = true; emit();
    })();
    return c;
  }
  const split = path => { const i = path.lastIndexOf("/"); return [path.slice(0, i), path.slice(i + 1)]; };
  const snapDoc = (id, data) => ({id, exists: data !== undefined, data: () => data});
  const local = (col, id, data) => { const c = caches[col]; if (!c) return; if (data === undefined) c.docs.delete(id); else c.docs.set(id, data); c.emit(); };
  const fail = error => { if (error) throw error; };

  const db = {
    collection(col){
      return {onSnapshot(cb, onErr){
        const c = cache(col);
        const f = err => { if (err) return onErr?.(err); if (c.loaded) cb({docs: [...c.docs].map(([id, d]) => snapDoc(id, d))}); };
        c.subs.add(f); f();
        return () => c.subs.delete(f);
      }};
    },
    doc(path){
      const [col, id] = split(path);
      return {
        onSnapshot(cb, onErr){
          const c = cache(col);
          const f = err => { if (err) return onErr?.(err); if (c.loaded) cb(snapDoc(id, c.docs.get(id))); };
          c.subs.add(f); f();
          return () => c.subs.delete(f);
        },
        async get(){ await ready; const {data, error} = await sb.from("docs").select("data").eq("collection", col).eq("id", id).maybeSingle(); fail(error); return snapDoc(id, data?.data); },
        async set(data){ await ready; fail((await sb.from("docs").upsert({collection: col, id, data, updated_at: new Date().toISOString()})).error); local(col, id, data); },
        async update(patch){ await ready; const {data, error} = await sb.rpc("merge_doc", {p_collection: col, p_id: id, p_patch: patch}); fail(error); local(col, id, data); },
        async delete(){ await ready; fail((await sb.from("docs").delete().eq("collection", col).eq("id", id)).error); local(col, id, undefined); }
      };
    }
  };

  // ---- COI files ----
  // Stored as /coi/<path in bucket>. Links and fetches to that path are swapped for a short-lived signed URL.
  const signed = async path => {
    const {data, error} = await sb.storage.from("cois").createSignedUrl(decodeURIComponent(path), 3600);
    fail(error); return data.signedUrl;
  };
  const coiPath = u => { try { const x = new URL(u, location.href); return x.origin === location.origin && x.pathname.startsWith("/coi/") ? x.pathname.slice(5) : null; } catch { return null; } };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const p = typeof input === "string" ? coiPath(input) : null;
    return realFetch(p ? await signed(p) : input, init);
  };
  document.addEventListener("click", async e => {
    const a = e.target.closest?.("a[href]"); const p = a && coiPath(a.getAttribute("href"));
    if (!p) return;
    e.preventDefault();
    const w = window.open("", "_blank");
    try { const u = await signed(p); if (w) w.location = u; else location.href = u; } catch { w?.close(); alert("Could not open that PDF."); }
  }, true);
  const assets = {
    async upload(blob, {filename} = {}){
      await ready;
      const id = crypto.randomUUID(), path = `${id}/${(filename || "file.pdf").replace(/[^A-Za-z0-9._-]+/g, "-")}`;
      fail((await sb.storage.from("cois").upload(path, blob, {contentType: blob.type || "application/pdf"})).error);
      return {id, url: "/coi/" + path};
    }
  };

  // ---- Downloads ----
  const downloads = {
    async save({filename, data}){
      const u = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
      const a = Object.assign(document.createElement("a"), {href: u, download: filename || "download"});
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 10000);
    }
  };

  const caps = {db, assets, downloads};
  window.claude = {use: async name => { await ready; return caps[name] ?? null; }};
})();

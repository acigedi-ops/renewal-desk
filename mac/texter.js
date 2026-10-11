// Renewal Desk Texter: a small background app on Eduard's Mac that sends his approved Qtax texts through Messages,
// from his own number, and reads clients' replies so the Qtax board marks them "Got income".
// Built by "Install Renewal Desk Texter.command" (osacompile -l JavaScript -s: a stay-open JXA applet), kept running by launchd.
//
// Rules it keeps:
// - Sends only texts/<id> whose status is "approved", which only Eduard's "Approve & send" tap sets. It claims each one
//   (approved -> sending) before sending, so nothing goes twice.
// - Never sends between 9 pm and 8 am, and hands back approvals older than 2 days (Mac was off) for a new OK.
// - May write drafts (reminders for clients who haven't answered); drafts never send without his tap.
// - Reads ~/Library/Messages/chat.db read-only (needs Full Disk Access), never changes it.
ObjC.import("Foundation");

const VERSION = 7;
const SB_URL = "https://dapyzgcpzivaiiousifb.supabase.co";
const SB_KEY = "sb_publishable_88FT9yvOdNhsr0TXETg8WQ_PooFMPlp"; // public by design, same as public/config.js
const QUIET_FROM = 21, QUIET_UNTIL = 8;                           // local hours with no sending
const APPROVAL_MAX_H = 48, GAP_S = 4, BATCH = 20;
const FOLLOWUP_DAYS = 3, MAX_FOLLOWUPS = 3;

const me = Application.currentApplication(); me.includeStandardAdditions = true;
const HOME = $.NSHomeDirectory().js;
const DIR = HOME + "/Library/Application Support/Renewal Desk Texter";
const CFG = DIR + "/config.json", STATE = DIR + "/state.json", LOG = DIR + "/texter.log", SEND = DIR + "/send.applescript";
const CHAT_DB = HOME + "/Library/Messages/chat.db";
const APPLE_EPOCH_MS = 978307200000;
const MS = "(m.date/1000000 + " + APPLE_EPOCH_MS + ")"; // chat.db dates are nanoseconds since 2001-01-01

// Sends one text. Prefers the existing conversation (same thread, same iMessage/SMS as always), else the right account.
// Sends one text to ONE person. Group chats are impossible here, checked three times over:
// the target must be a single phone number, a chat is used only if it has exactly one participant whose number matches,
// and otherwise the text goes to that single participant directly (a one-on-one conversation by definition).
const SEND_SCRIPT = `on run argv
  set theText to item 1 of argv
  set theTarget to item 2 of argv
  set theService to item 3 of argv
  set theChat to item 4 of argv
  set theDigits to item 5 of argv
  if theTarget does not start with "+" or (length of theTarget) < 11 or (length of theTarget) > 16 then error "Refused: not a single phone number"
  repeat with ch in characters 2 thru -1 of theTarget
    if "0123456789" does not contain (contents of ch) then error "Refused: not a single phone number"
  end repeat
  tell application "Messages"
    if theChat is not "" and theChat contains ";-;" and theChat ends with theDigits then
      try
        set c to chat id theChat
        set ps to participants of c
        if (count of ps) is 1 then
          set h to handle of item 1 of ps
          if h ends with theDigits then
            send theText to c
            return "chat"
          end if
        end if
      end try
    end if
    if theService is "SMS" or theService is "RCS" then
      try
        send theText to participant theTarget of (1st account whose service type = SMS)
        return "sms"
      end try
    end if
    send theText to participant theTarget of (1st account whose service type = iMessage)
    return "imessage"
  end tell
end run
`;

// ---------- small helpers ----------
const sq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const sh = cmd => me.doShellScript(cmd, {alteringLineEndings: false});
const nowIso = () => new Date().toISOString();
const digits = s => String(s || "").replace(/\D/g, "");
const last10 = s => digits(s).slice(-10);
// Exactly one US phone number as +1XXXXXXXXXX, or null. Anything with a comma, a second number or letters is refused.
function oneNumber(p){
  const raw = String(p || "").trim();
  if (!raw || /[,;&\n]|[A-Za-z@]/.test(raw)) return null;
  const d = digits(raw);
  return d.length === 10 ? "+1" + d : d.length === 11 && d[0] === "1" ? "+" + d : null;
}
function readFile(p){ const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null); return s.isNil() ? null : s.js; }
function writeFile(p, text){ $(String(text)).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null); }
function readJson(p, d){ try { return JSON.parse(readFile(p) || "") || d; } catch (e){ return d; } }
const writeJson = (p, v) => writeFile(p, JSON.stringify(v, null, 1));
function log(msg){
  try {
    sh(`/bin/echo ${sq(nowIso() + " " + msg)} >> ${sq(LOG)}`);
    if (+sh(`/usr/bin/stat -f %z ${sq(LOG)}`) > 1e6) sh(`/usr/bin/tail -n 2000 ${sq(LOG)} > ${sq(LOG + ".tmp")} && /bin/mv ${sq(LOG + ".tmp")} ${sq(LOG)}`);
  } catch (e){}
}

// ---------- Supabase (as Eduard, signed in once on this Mac) ----------
function http(method, path, body, headers, useAuth){
  const hs = {apikey: SB_KEY};
  if (useAuth !== false) hs.Authorization = "Bearer " + accessToken();
  if (body !== undefined) hs["Content-Type"] = "application/json";
  Object.assign(hs, headers || {});
  // Headers and body go through files, so the token never shows in the process list and text needs no shell quoting.
  writeFile(DIR + "/.h", Object.keys(hs).map(k => `${k}: ${hs[k]}`).join("\n") + "\n");
  let cmd = `/usr/bin/curl -sS -m 30 -X ${method} -H @${sq(DIR + "/.h")} -w '\\n%{http_code}'`;
  if (body !== undefined){ writeFile(DIR + "/.b", JSON.stringify(body)); cmd += ` --data-binary @${sq(DIR + "/.b")}`; }
  const out = sh(cmd + " " + sq(SB_URL + path));
  const i = out.lastIndexOf("\n"), status = +out.slice(i + 1), text = out.slice(0, i);
  if (!(status >= 200 && status < 300)) throw new Error(`${method} ${path.split("?")[0]}: ${status} ${text.slice(0, 160)}`);
  try { return text ? JSON.parse(text) : null; } catch (e){ return text; }
}
function saveSession(r){
  const cfg = readJson(CFG, {});
  writeJson(CFG, {...cfg, access_token: r.access_token, refresh_token: r.refresh_token,
    expires_at: r.expires_at || Math.floor(Date.now() / 1000) + (r.expires_in || 3600), email: (r.user && r.user.email) || cfg.email});
}
function accessToken(){
  const cfg = readJson(CFG, {});
  if (cfg.access_token && cfg.expires_at > Date.now() / 1000 + 120) return cfg.access_token;
  if (!cfg.refresh_token) throw new Error("not signed in");
  try { saveSession(http("POST", "/auth/v1/token?grant_type=refresh_token", {refresh_token: cfg.refresh_token}, {}, false)); }
  catch (e){
    if (/: 4\d\d /.test(e.message)) writeJson(CFG, {email: cfg.email}); // refresh token no longer valid: sign in again
    throw e;
  }
  return readJson(CFG, {}).access_token;
}
const signedIn = () => !!readJson(CFG, {}).refresh_token;
function signIn(){
  const cfg = readJson(CFG, {});
  try {
    me.activate();
    const email = me.displayDialog("Renewal Desk Texter sends the Qtax texts you approve from Messages on this Mac, from your own number.\n\nSign in with your Renewal Desk email:",
      {withTitle: "Renewal Desk", defaultAnswer: cfg.email || "", buttons: ["Not now", "Next"], defaultButton: "Next", cancelButton: "Not now"}).textReturned.trim();
    const password = me.displayDialog("Renewal Desk password for " + email + ":",
      {withTitle: "Renewal Desk", defaultAnswer: "", hiddenAnswer: true, buttons: ["Not now", "Sign in"], defaultButton: "Sign in", cancelButton: "Not now"}).textReturned;
    saveSession(http("POST", "/auth/v1/token?grant_type=password", {email, password}, {}, false));
  } catch (e){
    if (e.errorNumber === -128) return false;
    me.displayDialog("Couldn't sign in: wrong email or password.", {withTitle: "Renewal Desk", buttons: ["OK"]});
    return false;
  }
  // Ask for permission to use Messages now, while Eduard is here, rather than at the first send.
  try { sh(`/usr/bin/osascript -e 'tell application "Messages" to count of accounts'`); } catch (e){ log("Messages permission: " + e.message); }
  me.displayNotification("Signed in. Approved Qtax texts will go out from Messages on this Mac.", {withTitle: "Renewal Desk Texter"});
  return true;
}
const enc = encodeURIComponent;
const listDocs = (col, filter) => http("GET", `/rest/v1/docs?select=id,data&collection=eq.${col}${filter || ""}&limit=2000`).map(r => Object.assign({id: r.id}, r.data));
const getDoc = (col, id) => { const r = http("GET", `/rest/v1/docs?select=data&collection=eq.${col}&id=eq.${enc(id)}`); return r[0] ? r[0].data : null; };
const mergeDoc = (col, id, patch) => http("POST", "/rest/v1/rpc/merge_doc", {p_collection: col, p_id: id, p_patch: patch});
const setDoc = (col, id, data) => http("POST", "/rest/v1/docs", [{collection: col, id, data, updated_at: nowIso()}], {Prefer: "resolution=merge-duplicates"});

// ---------- Messages database (read-only) ----------
function sqlite(dbPath, sql){
  const out = sh(`/usr/bin/sqlite3 -readonly -json ${sq(dbPath)} ${sq(sql)}`);
  return out.trim() ? JSON.parse(out) : [];
}
const chat = sql => sqlite(CHAT_DB, sql);
function canRead(){ try { chat("SELECT 1 AS ok"); return true; } catch (e){ return false; } }
const msgCols = `m.ROWID AS id, h.id AS handle, ${MS} AS ms, m.text AS text,
  CASE WHEN m.text IS NULL THEN hex(m.attributedBody) END AS body_hex, m.cache_has_attachments AS att`;

// Newer macOS keeps the text only inside attributedBody (an NSArchiver "typedstream"): the string follows "NSString" ... "+" <length>.
function bodyText(row){
  if (row.text) return row.text;
  const hx = row.body_hex; if (!hx) return "";
  const b = []; for (let i = 0; i < hx.length; i += 2) b.push(parseInt(hx.substr(i, 2), 16));
  const mark = [0x4e, 0x53, 0x53, 0x74, 0x72, 0x69, 0x6e, 0x67];
  let i = -1;
  for (let j = 0; j + mark.length <= b.length && i < 0; j++) if (mark.every((x, k) => b[j + k] === x)) i = j + mark.length;
  if (i < 0) return "";
  while (i < b.length && b[i] !== 0x2b) i++;
  i++;
  let len = b[i++];
  if (len === 0x81){ len = b[i] | (b[i + 1] << 8); i += 2; }
  else if (len === 0x82){ len = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; i += 4; }
  try { return decodeURIComponent(b.slice(i, i + len).map(x => "%" + (x < 16 ? "0" : "") + x.toString(16)).join("")); } catch (e){ return ""; }
}

// The most recent one-to-one conversation with this number: its id and whether it's iMessage, SMS or RCS.
function lastChat(phone){
  const d = last10(phone); if (d.length < 10) return {};
  const rows = chat(`SELECT c.guid AS guid, c.service_name AS svc FROM chat c
    JOIN chat_handle_join j ON j.chat_id = c.ROWID JOIN handle h ON h.ROWID = j.handle_id
    WHERE c.style = 45 AND c.guid LIKE '%;-;%' AND h.id LIKE '%${d}'
      AND (SELECT COUNT(*) FROM chat_handle_join j2 WHERE j2.chat_id = c.ROWID) = 1
    ORDER BY (SELECT MAX(m.date) FROM chat_message_join cm JOIN message m ON m.ROWID = cm.message_id WHERE cm.chat_id = c.ROWID) DESC LIMIT 1`);
  return rows[0] || {};
}

// ---------- Quarters (same as src/qtax.js) ----------
const MONTHS_UK = ["", "січень–березень", "квітень–червень", "липень–вересень", "жовтень–грудень"];
const qUk = k => `${k.slice(-1)}-й квартал ${k.slice(0, 4)} (${MONTHS_UK[+k.slice(-1)]})`;
const qKey = k => "q_" + k.replace("-", "");
function filingQuarter(d){ d = d || new Date(); let y = d.getFullYear(), n = Math.floor(d.getMonth() / 3); if (!n){ n = 4; y--; } return `${y}-Q${n}`; }
const fill = (tpl, c, k) => String(tpl).split("{name}").join(String(c.name || "").trim().split(/\s+/)[0] || "").split("{quarter}").join(qUk(k)).replace(/\s+([,!.])/g, "$1");
const FOLLOWUP_DEFAULT = "Нагадую: чекаю на ваш дохід за {quarter}, щоб вчасно подати податки. Дякую!";

// ---------- 1. Replies -> "Got income" ----------
function scanReplies(clients){
  const st = readJson(STATE, {});
  if (st.cursor == null){
    // First run: look back three weeks, so replies to a text sent just before installing still count.
    const since = Date.now() - 21 * 864e5;
    st.cursor = chat(`SELECT IFNULL((SELECT MIN(ROWID) FROM message m WHERE ${MS} >= ${since}), (SELECT IFNULL(MAX(ROWID), 0) + 1 FROM message)) - 1 AS r`)[0].r;
  }
  const rows = chat(`SELECT ${msgCols} FROM message m JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.is_from_me = 0 AND m.associated_message_type = 0 AND m.ROWID > ${+st.cursor} ORDER BY m.ROWID LIMIT 400`);
  const byPhone = {}; clients.forEach(c => { if (last10(c.phone).length === 10) byPhone[last10(c.phone)] = c; });
  const patches = {};
  for (const r of rows){
    st.cursor = Math.max(st.cursor, r.id);
    const c = byPhone[last10(r.handle)]; if (!c) continue;
    const at = new Date(r.ms).toISOString(), text = (bodyText(r) || (r.att ? "[photo or file]" : "")).slice(0, 500);
    const p = patches[c.id] = patches[c.id] || {};
    p.last_reply = {text, at};
    // Any quarter they were asked about before this message counts as answered.
    Object.keys(c).filter(k => /^q_\d{4}Q\d$/.test(k)).forEach(k => {
      const q = Object.assign({}, c[k], p[k]);
      if (q.status === "asked" && q.asked_at && q.asked_at <= at){ p[k] = Object.assign(q, {status: "received", received_at: at, reply: text}); }
      else if (p[k] && p[k].status === "received" && p[k].reply !== text && text !== "[photo or file]") p[k].reply = (p[k].reply + "\n" + text).slice(0, 500);
    });
  }
  for (const id in patches){ mergeDoc("qtax", id, patches[id]); log(`reply from ${id}`); }
  writeJson(STATE, st);
}

// ---------- 2. Send what Eduard approved ----------
// Did a text to this number go out since sinceMs? (Messages can time out in AppleScript after it has already sent.)
function wentOut(phone, sinceMs){
  try {
    return chat(`SELECT COUNT(*) AS n FROM message m JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.is_from_me = 1 AND m.error = 0 AND h.id LIKE '%${last10(phone)}' AND ${MS} >= ${sinceMs - 5000}`)[0].n > 0;
  } catch (e){ return null; }
}
// Record a text as sent, and the client as asked / reminded for that quarter.
function markSent(t, note){
  mergeDoc("texts", t.id, {status: "sent", sent_at: nowIso(), error: "", via: t.via || "", note: note || ""});
  const c = t.client_id && getDoc("qtax", t.client_id); if (!c) return;
  const k = qKey(t.quarter || filingQuarter()), q = c[k] || {}, nq = Object.assign({}, q), at = nowIso();
  if (t.kind === "followup"){ nq.followups = (q.followups || 0) + 1; nq.last_followup_at = at; }
  else { nq.status = q.status || "asked"; nq.asked_at = q.asked_at || at; }
  mergeDoc("qtax", t.client_id, {[k]: nq});
}
function sendApproved(readable){
  // Sent marks that failed to save last time (network): save them now, never resend.
  const st0 = readJson(STATE, {}), unmarked = st0.unmarked || [];
  if (unmarked.length){
    const left = unmarked.filter(id => {
      try { const t = getDoc("texts", id); if (t && t.status !== "sent") markSent(Object.assign({id}, t), ""); return false; } catch (e){ return true; }
    });
    writeJson(STATE, Object.assign(readJson(STATE, {}), {unmarked: left}));
  }
  // A text left in "sending" (the app quit or the Mac slept mid-send) is never retried by itself: it becomes "sent" if
  // Messages shows it went out, "failed" if Messages shows it didn't, and otherwise "unsure" for Eduard to settle.
  listDocs("texts", "&data->>status=eq.sending").forEach(t => {
    const since = Date.parse(t.claimed_at || 0);
    if (!(Date.now() - since > 10 * 60000)) return;
    const out = readable ? wentOut(t.phone, since) : null;
    if (out) markSent(t, "Confirmed from Messages");
    else mergeDoc("texts", t.id, out === false ? {status: "failed", failed_at: nowIso(), error: "Didn't go out"}
      : {status: "unsure", unsure_at: nowIso(), error: "Your Mac stopped mid-send. Check Messages: did it go out?"});
  });
  const approved = listDocs("texts", "&data->>status=eq.approved").sort((a, b) => String(a.approved_at).localeCompare(String(b.approved_at)));
  let sent = 0;
  for (const t of approved){
    if (sent >= BATCH) break;
    const hr = new Date().getHours();
    if (hr >= QUIET_FROM || hr < QUIET_UNTIL) return;
    if (Date.now() - new Date(t.approved_at) > APPROVAL_MAX_H * 3600e3){
      mergeDoc("texts", t.id, {status: "draft", note: "Approved over 2 days ago while your Mac was off. Approve again to send."});
      continue;
    }
    // Claim it first: the update only matches while it is still "approved", so it can't go out twice.
    const claimed = http("PATCH", `/rest/v1/docs?collection=eq.texts&id=eq.${enc(t.id)}&data->>status=eq.approved`,
      {data: Object.assign({}, t, {id: undefined, status: "sending", claimed_at: nowIso()}), updated_at: nowIso()}, {Prefer: "return=representation"});
    if (!claimed || !claimed.length) continue;
    const done = patch => mergeDoc("texts", t.id, patch);
    const c = t.client_id && getDoc("qtax", t.client_id);
    const k = qKey(t.quarter || filingQuarter()), q = (c && c[k]) || {};
    if (!c || c.active === false){ done({status: "skipped", error: "Not an active Qtax client"}); continue; }
    if (t.kind === "followup" && q.status !== "asked"){ done({status: "skipped", error: "Already answered"}); continue; }
    if (t.kind === "ask" && q.status){ done({status: "skipped", error: q.status === "asked" ? "Already asked this quarter" : "Already answered"}); continue; }
    // Send only to the number Eduard approved (t.phone). If the client's number changed since, don't guess: back to draft for a new OK.
    const phone = t.phone;
    if (last10(phone).length < 10){ done({status: "failed", error: "No phone number"}); continue; }
    if (c.phone && last10(c.phone) !== last10(phone)){
      done({status: "draft", note: "The client's number changed after you approved. Approve again to send to the new number."});
      try { mergeDoc("texts", t.id, {phone: c.phone}); } catch (e){}
      continue;
    }
    const startMs = Date.now();
    let accepted = false, via = "";
    try {
      const one = oneNumber(phone);
      if (!one) throw new Error("Refused: not a single phone number");
      const conv = readable ? lastChat(one) : {};
      const guid = /^[A-Za-z]+;-;\+?\d+$/.test(conv.guid || "") && conv.guid.endsWith(last10(one)) ? conv.guid : "";
      via = sh(`/usr/bin/osascript ${sq(SEND)} ${sq(t.body)} ${sq(one)} ${sq(conv.svc || "iMessage")} ${sq(guid)} ${sq(last10(one))}`).trim();
      delay(GAP_S);
      // Did Messages accept it? (error <> 0 means it shows "Not Delivered" on the Mac)
      if (readable){
        const m = chat(`SELECT m.error AS err FROM message m JOIN handle h ON h.ROWID = m.handle_id
          WHERE m.is_from_me = 1 AND h.id LIKE '%${last10(phone)}' AND ${MS} >= ${startMs - 5000} ORDER BY m.ROWID DESC LIMIT 1`)[0];
        if (m && m.err) throw new Error(`Messages couldn't deliver it (error ${m.err})`);
      }
      accepted = true;
    } catch (e){
      // An error after Messages already sent it (often an AppleScript timeout, -1712) must never become "failed",
      // or "Send again" would double it. Look in Messages first; if it can't tell, ask Eduard ("unsure").
      delay(GAP_S);
      const out = /^Refused|couldn't deliver/.test(e.message || "") ? false : readable ? wentOut(phone, startMs) : null;
      if (out) accepted = true;
      else {
        const msg = String(e.message || e).replace(/^.*execution error: /, "").slice(0, 200);
        try { done(out === null ? {status: "unsure", unsure_at: nowIso(), error: msg + ". Check Messages: did it go out?"} : {status: "failed", error: msg, failed_at: nowIso()}); } catch (e2){}
        log(`not sent ${t.id}: ${e.message}`);
      }
    }
    if (accepted){
      sent++;
      // Saving "sent" is separate from sending: if it fails (network), remember it locally and retry the mark, never the text.
      try { markSent(Object.assign({}, t, {via}), ""); log(`sent ${t.kind} to ${c.id} via ${via}`); }
      catch (e){ writeJson(STATE, Object.assign(readJson(STATE, {}), {unmarked: (readJson(STATE, {}).unmarked || []).concat(t.id)})); log(`sent ${t.id}, mark saved later`); }
    }
  }
}

// ---------- 3. Draft reminders for clients who haven't answered (drafts only; Eduard approves) ----------
function draftReminders(){
  const k = filingQuarter(), key = qKey(k);
  const clients = listDocs("qtax"), texts = listDocs("texts", `&data->>quarter=eq.${k}&data->>kind=eq.followup`);
  const settings = getDoc("qtaxmeta", "settings") || {};
  const cutoff = new Date(Date.now() - FOLLOWUP_DAYS * 864e5).toISOString();
  for (const c of clients){
    const q = c[key];
    if (c.active === false || !q || q.status !== "asked" || (q.followups || 0) >= MAX_FOLLOWUPS) continue;
    if ((q.last_followup_at || q.asked_at || "") > cutoff) continue;
    // One reminder at a time; one Eduard dismissed or sent keeps the next away for a few days.
    if (texts.some(t => t.client_id === c.id && (["draft", "approved", "sending", "unsure"].includes(t.status) || t.created_at > cutoff))) continue;
    setDoc("texts", `followup-${k}-${c.id}-${Date.now().toString(36)}`, {client_id: c.id, name: c.name, phone: c.phone, kind: "followup", quarter: k,
      body: fill(settings.followup_template || FOLLOWUP_DEFAULT, c, k), status: "draft", created_at: nowIso(), created_by: "mac"});
    log(`drafted reminder for ${c.id}`);
  }
}

// ---------- 4. Find past group texts (the Hit Em Up blast) so Eduard doesn't have to type his list ----------
function contacts(){
  const names = {};
  let files = [];
  try { files = sh(`/usr/bin/find ${sq(HOME + "/Library/Application Support/AddressBook")} -name 'AddressBook-v22.abcddb' 2>/dev/null; true`).split("\n").filter(Boolean); } catch (e){}
  for (const f of files){
    try {
      sqlite(f, `SELECT r.ZFIRSTNAME AS f, r.ZLASTNAME AS l, r.ZORGANIZATION AS o, p.ZFULLNUMBER AS n FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER`)
        .forEach(r => { const d = last10(r.n); if (d.length === 10 && !names[d]) names[d] = [r.f, r.l].filter(Boolean).join(" ") || r.o || ""; });
    } catch (e){}
  }
  return names;
}
function discover(){
  const since = Date.now() - 400 * 864e5;
  const hours = chat(`SELECT ${MS} / 3600000 AS hr FROM message m WHERE m.is_from_me = 1 AND m.associated_message_type = 0 AND ${MS} >= ${since}
    GROUP BY hr HAVING COUNT(DISTINCT m.handle_id) >= 8 ORDER BY hr DESC LIMIT 40`);
  const groups = {};
  for (const {hr} of hours){
    chat(`SELECT ${msgCols} FROM message m JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.is_from_me = 1 AND m.associated_message_type = 0 AND ${MS} / 3600000 = ${+hr}`).forEach(r => {
      const text = bodyText(r).trim(), d = last10(r.handle);
      if (text.length < 15 || d.length < 10) return;
      const g = groups[text] = groups[text] || {text, at: 0, phones: {}};
      g.phones[d] = r.handle; g.at = Math.max(g.at, r.ms);
    });
  }
  const names = contacts();
  const blasts = Object.keys(groups).map(t => groups[t]).filter(g => Object.keys(g.phones).length >= 8)
    .sort((a, b) => b.at - a.at).slice(0, 5)
    .map(g => ({text: g.text, at: new Date(g.at).toISOString(),
      recipients: Object.keys(g.phones).map(d => ({phone: "+1" + d, name: names[d] || ""})).sort((a, b) => (a.name || "~").localeCompare(b.name || "~"))}));
  mergeDoc("qtaxmeta", "discovery", {scanned_at: nowIso(), blasts});
  log(`discovery: ${blasts.length} group texts`);
}

// ---------- 5. On request: last week's conversations to a file on Eduard's Desktop (never to the database) ----------
// Asked for by setting qtaxmeta/export {requested_at, days}. Lets Claude check for messages he never answered.
const EXPORT_FILE = HOME + "/Desktop/Renewal Desk Texter/recent-texts.json";
function exportRecent(req){
  const days = Math.min(Math.max(+req.days || 7, 1), 31), since = Date.now() - days * 864e5;
  const rows = chat(`SELECT c.ROWID AS cid, c.guid AS guid, c.display_name AS title, c.style AS style, h.id AS handle,
      m.is_from_me AS me, ${MS} AS ms, m.text AS text, CASE WHEN m.text IS NULL THEN hex(m.attributedBody) END AS body_hex,
      m.cache_has_attachments AS att, m.associated_message_type AS amt
    FROM message m JOIN chat_message_join cm ON cm.message_id = m.ROWID JOIN chat c ON c.ROWID = cm.chat_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE ${MS} >= ${since} ORDER BY m.ROWID`);
  const members = {};
  chat(`SELECT j.chat_id AS cid, h.id AS handle FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id`)
    .forEach(r => { (members[r.cid] = members[r.cid] || []).push(r.handle); });
  const names = contacts(), who = hd => names[last10(hd)] || hd || "?";
  const chats = {};
  for (const r of rows){
    const c = chats[r.cid] = chats[r.cid] || {group: r.style === 43, title: r.title || "",
      people: (members[r.cid] || []).map(hd => ({name: names[last10(hd)] || "", handle: hd})), messages: []};
    const text = r.amt ? "[reaction]" : (bodyText(r) || (r.att ? "[photo or file]" : ""));
    c.messages.push({at: new Date(r.ms).toISOString(), from: r.me ? "Eduard" : who(r.handle), text: text.slice(0, 1500)});
  }
  const list = Object.keys(chats).map(k => chats[k]).sort((a, b) => b.messages[b.messages.length - 1].at.localeCompare(a.messages[a.messages.length - 1].at));
  writeFile(EXPORT_FILE, JSON.stringify({made_at: nowIso(), days, chats: list}, null, 1));
  mergeDoc("qtaxmeta", "export", {done_at: nowIso(), chats: list.length, messages: rows.length});
  log(`exported ${rows.length} messages in ${list.length} chats`);
}

// ---------- 6. Twice a day: chats Eduard hasn't answered, for the To do list (Eduard asked for this on 2026-10-11) ----------
// At 9:00 (all of yesterday) and 18:00 (today so far) it uploads textscan/<slot>: each chat with a message from someone else in
// that window whose latest message is still theirs, with its last few messages. A Claude routine turns these into tasks/<id>
// and then erases the message text from the scan. A missed slot (Mac off) runs as soon as the Mac is back.
function ymd(x){ return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; }
function dueSlot(now){
  const d = new Date(now), at = (day, hr) => { const x = new Date(day); x.setHours(hr, 0, 0, 0); return x; };
  const y = new Date(d); y.setDate(d.getDate() - 1);
  if (d >= at(d, 18)) return {id: ymd(d) + "-18", from: at(d, 0), to: at(d, 18)};
  if (d >= at(d, 9)) return {id: ymd(d) + "-09", from: at(y, 0), to: at(d, 0)};
  return {id: ymd(y) + "-18", from: at(y, 0), to: at(y, 18)};
}
function scanUnanswered(slot){
  const from = slot.from.getTime(), to = slot.to.getTime();
  const chats = chat(`SELECT c.ROWID AS cid, c.style AS style, c.display_name AS title,
      (SELECT m2.is_from_me FROM chat_message_join cm2 JOIN message m2 ON m2.ROWID = cm2.message_id
        WHERE cm2.chat_id = c.ROWID AND m2.associated_message_type = 0 ORDER BY m2.date DESC LIMIT 1) AS last_me
    FROM chat c WHERE EXISTS (SELECT 1 FROM chat_message_join cm JOIN message m ON m.ROWID = cm.message_id
      WHERE cm.chat_id = c.ROWID AND m.is_from_me = 0 AND m.associated_message_type = 0 AND ${MS} >= ${from} AND ${MS} < ${to})`)
    .filter(c => c.last_me === 0);
  const names = contacts(), out = [];
  for (const c of chats){
    const people = chat(`SELECT h.id AS handle FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id WHERE j.chat_id = ${+c.cid}`).map(r => r.handle);
    // Skip short codes (banks, verification codes, ads).
    if (!people.length || people.every(hd => !/@/.test(hd) && digits(hd).length < 10)) continue;
    const msgs = chat(`SELECT h.id AS handle, m.is_from_me AS me, ${MS} AS ms, m.text AS text,
        CASE WHEN m.text IS NULL THEN hex(m.attributedBody) END AS body_hex, m.cache_has_attachments AS att
      FROM chat_message_join cm JOIN message m ON m.ROWID = cm.message_id LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE cm.chat_id = ${+c.cid} AND m.associated_message_type = 0 ORDER BY m.date DESC LIMIT 8`).reverse();
    out.push({group: c.style === 43, title: c.title || "",
      people: people.map(hd => ({handle: hd, name: names[last10(hd)] || ""})),
      messages: msgs.map(m => ({at: new Date(m.ms).toISOString(), from: m.me ? "Eduard" : (names[last10(m.handle)] || m.handle || "?"),
        text: (bodyText(m) || (m.att ? "[photo or file]" : "")).slice(0, 800)}))});
  }
  setDoc("textscan", slot.id, {slot: slot.id, from: slot.from.toISOString(), to: slot.to.toISOString(), made_at: nowIso(), status: "new", chats: out});
  log(`textscan ${slot.id}: ${out.length} unanswered chats`);
}

// ---------- 7. Promised callbacks ("I'll call you back in 25 min") ----------
// Watches Eduard's own texts for a promise to call. If by the promised time (+10 min) there is no call to that number in
// Call History and no newer text from him in that chat, it shows a reminder on this Mac and adds an urgent "callback" task.
// It never contacts the client.
const PROMISE = [/\b(call|ring)\s+(you|u|ya)\s+(back|in|after|soon|shortly)\b/i, /\bcall\s+back\s+in\b/i, /\b(i'?ll|i will|will)\s+call\b/i,
  /передзвоню|перезвоню|подзвоню|позвоню|наберу/i];
const MINUTES = /(\d+)\s*(min|mins|minutes|m\b|хв|хвилин|мин|минут)/i, HOURS = /(\d+(?:[.,]5)?)\s*(h|hr|hrs|hour|hours|год|годин|час|часа|часов)/i;
const CALLS_DB = HOME + "/Library/Application Support/CallHistoryDB/CallHistory.storedata";
function promisedMinutes(text){
  if (!PROMISE.some(r => r.test(text)) || /\?\s*$/.test(text)) return null;
  const m = text.match(MINUTES); if (m) return Math.min(+m[1], 240);
  const h = text.match(HOURS); if (h) return Math.min(parseFloat(h[1].replace(",", ".")) * 60, 240);
  return /later|пізніше|позже|tomorrow|завтра/i.test(text) ? null : 30; // "I'll call you back" with no time: give it 30 min
}
function calledSince(phone, sinceMs){
  try {
    const sec = (sinceMs - APPLE_EPOCH_MS) / 1000;
    return sqlite(CALLS_DB, `SELECT COUNT(*) AS n FROM ZCALLRECORD WHERE ZADDRESS LIKE '%${last10(phone)}' AND ZDATE >= ${sec}
      AND (ZORIGINATED = 1 OR ZANSWERED = 1)`)[0].n > 0;
  } catch (e){ return false; }
}
function checkCallbacks(){
  const st = readJson(STATE, {}), promises = st.promises || {}, now = Date.now();
  // New promises from the last 4 hours, one-on-one chats only.
  chat(`SELECT m.ROWID AS id, c.ROWID AS cid, ${MS} AS ms, m.text AS text, CASE WHEN m.text IS NULL THEN hex(m.attributedBody) END AS body_hex,
      (SELECT h.id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id WHERE j.chat_id = c.ROWID LIMIT 1) AS handle
    FROM message m JOIN chat_message_join cm ON cm.message_id = m.ROWID JOIN chat c ON c.ROWID = cm.chat_id
    WHERE m.is_from_me = 1 AND c.style = 45 AND m.associated_message_type = 0 AND ${MS} >= ${now - 4 * 3600e3}`).forEach(r => {
    if (promises[r.id] || last10(r.handle).length < 10) return;
    const mins = promisedMinutes(bodyText(r)); if (mins == null) return;
    promises[r.id] = {cid: r.cid, handle: r.handle, at: r.ms, due: r.ms + (mins + 10) * 60000, text: bodyText(r).slice(0, 200), state: "waiting"};
  });
  const names = contacts();
  for (const id in promises){
    const p = promises[id];
    if (p.state !== "waiting"){ if (now - p.at > 2 * 864e5) delete promises[id]; continue; }
    if (now < p.due) continue;
    const textedAfter = chat(`SELECT COUNT(*) AS n FROM chat_message_join cm JOIN message m ON m.ROWID = cm.message_id
      WHERE cm.chat_id = ${+p.cid} AND m.is_from_me = 1 AND m.ROWID > ${+id} AND m.associated_message_type = 0`)[0].n > 0;
    if (textedAfter || calledSince(p.handle, p.at)){ p.state = "kept"; continue; }
    p.state = "missed";
    const who = names[last10(p.handle)] || p.handle;
    try { me.displayNotification(`You said you'd call ${who} back. Still waiting.`, {withTitle: "Call back " + who, soundName: "Glass"}); } catch (e){}
    setDoc("tasks", `callback-${last10(p.handle)}-${id}`, {source: "callback", who, phone: "+1" + last10(p.handle), category: "client", urgent: true,
      title: "Call back: you promised a call and haven't called yet", detail: `You texted: "${p.text}"`, at: new Date(p.at).toISOString(),
      status: "open", created_at: nowIso(), created_by: "mac"});
    log(`missed callback ${last10(p.handle)}`);
  }
  st.promises = promises; writeJson(STATE, Object.assign(readJson(STATE, {}), {promises}));
}

// ---------- 9. Missed calls he hasn't returned ----------
// Every 10 minutes: each missed incoming call in the last 3 days becomes one urgent "Call back" item (tasks/missed-<last10>),
// and closes by itself once he calls that number or picks up a call from it. People in Contacts, Qtax clients and anyone
// he has texted with count; an unknown number only after 2 missed calls (spam usually calls once).
function missedCalls(){
  const since = Date.now() - 3 * 864e5, sec = (since - APPLE_EPOCH_MS) / 1000;
  const rows = sqlite(CALLS_DB, `SELECT ZADDRESS AS a, ZDATE AS d, ZORIGINATED AS o, ZANSWERED AS ans FROM ZCALLRECORD WHERE ZDATE >= ${sec} ORDER BY ZDATE`);
  const byNum = {};
  for (const r of rows){
    const d = last10(r.a); if (d.length !== 10) continue;
    const n = byNum[d] = byNum[d] || {missed: [], lastContact: 0};
    const ms = r.d * 1000 + APPLE_EPOCH_MS;
    if (!r.o && !r.ans) n.missed.push(ms); else n.lastContact = Math.max(n.lastContact, ms);
  }
  const names = contacts(), known = {};
  chat("SELECT id FROM handle").forEach(r => { known[last10(r.id)] = 1; });
  listDocs("qtax").forEach(c => { known[last10(c.phone)] = 1; });
  for (const d in byNum){
    const n = byNum[d], open = n.missed.filter(ms => ms > n.lastContact), id = "missed-" + d;
    const old = getDoc("tasks", id);
    if (!open.length){
      if (old && old.status === "open" && old.created_by === "mac") mergeDoc("tasks", id, {status: "done", done_at: nowIso(), detail: (old.detail || "") + " You called back."});
      continue;
    }
    if (!names[d] && !known[d] && open.length < 2) continue;
    const last = Math.max.apply(null, open), at = new Date(last).toISOString();
    if (old && (old.status === "done" ? old.done_at > at : old.at === at && old.count === open.length)) continue;
    const when = new Date(last).toLocaleString("en-US", {weekday: "short", hour: "numeric", minute: "2-digit"});
    setDoc("tasks", id, {source: "call", who: names[d] || "", phone: "+1" + d, category: "client", urgent: true, pinned: true,
      title: open.length > 1 ? `Call back: ${open.length} missed calls` : "Call back: missed call", detail: `Last tried ${when}. Closes by itself when you call them back.`,
      at, count: open.length, status: "open", done_at: "", created_at: (old && old.created_at) || nowIso(), created_by: "mac"});
  }
}

// ---------- 8. On request: who answers the quarter texts ----------
// Asked for by setting qtaxmeta/responders {requested_at}. For each past blast the Mac found (qtaxmeta/discovery), counts
// whether each person texted back within 3 weeks, in any chat. Uploads counts and dates only, never message text.
function responders(){
  const blasts = ((getDoc("qtaxmeta", "discovery") || {}).blasts || []).map(b => ({at: Date.parse(b.at), phones: b.recipients.map(r => last10(r.phone))}));
  if (!blasts.length) return mergeDoc("qtaxmeta", "responders", {scanned_at: nowIso(), people: {}, blasts: 0});
  const since = Math.min.apply(null, blasts.map(b => b.at)), WINDOW = 21 * 864e5;
  const inbound = {};
  chat(`SELECT h.id AS handle, ${MS} AS ms FROM message m JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.is_from_me = 0 AND ${MS} >= ${since}`).forEach(r => { const d = last10(r.handle); if (d.length === 10) (inbound[d] = inbound[d] || []).push(r.ms); });
  const lastEver = {};
  chat(`SELECT h.id AS handle, MAX(${MS}) AS ms FROM message m JOIN handle h ON h.ROWID = m.handle_id WHERE m.is_from_me = 0 GROUP BY h.id`)
    .forEach(r => { const d = last10(r.handle); if (d.length === 10 && !(lastEver[d] > r.ms)) lastEver[d] = r.ms; });
  const people = {};
  for (const b of blasts) for (const d of b.phones){
    const p = people[d] = people[d] || {sent: 0, replied: 0};
    p.sent++;
    if ((inbound[d] || []).some(ms => ms > b.at && ms < b.at + WINDOW)) p.replied++;
  }
  for (const d in people) people[d].last_in = lastEver[d] ? new Date(lastEver[d]).toISOString() : "";
  mergeDoc("qtaxmeta", "responders", {scanned_at: nowIso(), blasts: blasts.length, people});
  log(`responders: ${Object.keys(people).length} people over ${blasts.length} texts`);
}

// ---------- Main loop ----------
let lastSignInAsk = 0;
function tick(){
  if (!signedIn()){
    if (Date.now() - lastSignInAsk > 6 * 3600e3){ lastSignInAsk = Date.now(); signIn(); }
    if (!signedIn()) return;
  }
  const hr = new Date().getHours(), quiet = hr >= QUIET_FROM || hr < QUIET_UNTIL;
  const readable = canRead();
  let error = "";
  try {
    if (readable) scanReplies(listDocs("qtax"));
    sendApproved(readable);
    draftReminders();
    if (readable){
      const d = getDoc("qtaxmeta", "discovery");
      const st = readJson(STATE, {});
      checkCallbacks();
      if (Date.now() - (readJson(STATE, {}).missed_at || 0) > 10 * 60000){
        try { missedCalls(); } catch (e){ log("missed calls: " + e.message); }
        writeJson(STATE, Object.assign(readJson(STATE, {}), {missed_at: Date.now()}));
      }
      const slot = dueSlot(Date.now());
      if (readJson(STATE, {}).last_scan_slot !== slot.id){ scanUnanswered(slot); writeJson(STATE, Object.assign(readJson(STATE, {}), {last_scan_slot: slot.id})); }
      const ex = getDoc("qtaxmeta", "export");
      if (ex && ex.requested_at && ex.requested_at > (ex.done_at || "")) exportRecent(ex);
      const rs = getDoc("qtaxmeta", "responders");
      if (rs && rs.requested_at && rs.requested_at > (rs.scanned_at || "")) responders();
      if (!st.discovered_at || (d && d.requested_at && d.requested_at > (d.scanned_at || ""))){ discover(); writeJson(STATE, Object.assign(readJson(STATE, {}), {discovered_at: nowIso()})); }
    }
  } catch (e){ error = String(e.message || e).slice(0, 200); log("error: " + error); }
  try { mergeDoc("qtaxmeta", "mac", {seen_at: nowIso(), version: VERSION, can_read: readable, quiet, error}); }
  catch (e){ log("heartbeat: " + e.message); }
}

function run(){
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(DIR, true, $(), null);
  writeFile(SEND, SEND_SCRIPT);
  log(`started v${VERSION}`);
  tick();
}
function idle(){
  try { tick(); } catch (e){ log("tick: " + e.message); }
  return 60;
}

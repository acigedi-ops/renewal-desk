// Builds a MIME message with PDF attachments and sends it over SMTP (implicit TLS, AUTH PLAIN).
// The socket comes from the caller, so the Worker passes cloudflare:sockets and tests pass a Node socket.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes){
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const wrap76 = s => s.replace(/.{1,76}/g, "$&\r\n");
const ascii = s => /^[\x20-\x7e]*$/.test(s);
// RFC 2047 encoded-word for non-ASCII header text.
const hdr = s => ascii(s) ? s : `=?UTF-8?B?${b64(enc.encode(s))}?=`;
const addr = a => String(a).trim();
const fname = s => String(s || "file.pdf").replace(/["\\\r\n]/g, "");

const textPart = (type, s) => [`Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "",
  wrap76(b64(enc.encode(String(s || "").replace(/\r?\n/g, "\r\n")))).trimEnd()];
// Plain text only, or plain text + HTML as multipart/alternative when msg.html is given.
function textParts(msg){
  if (!msg.html) return textPart("text/plain", msg.body);
  const alt = "rd-alt-" + crypto.randomUUID();
  return [`Content-Type: multipart/alternative; boundary="${alt}"`, "",
    `--${alt}`, ...textPart("text/plain", msg.body),
    `--${alt}`, ...textPart("text/html", msg.html),
    `--${alt}--`];
}

/** msg: {from, fromName, to[], cc[], subject, body, html?, attachments: [{filename, contentType, bytes}]} -> CRLF string */
export function buildMime(msg){
  const boundary = "rd-" + crypto.randomUUID();
  const domain = msg.from.split("@")[1] || "localhost";
  const lines = [
    `From: ${msg.fromName ? `${hdr(msg.fromName)} ` : ""}<${msg.from}>`,
    `To: ${msg.to.map(addr).join(", ")}`,
    ...(msg.cc?.length ? [`Cc: ${msg.cc.map(addr).join(", ")}`] : []),
    `Subject: ${hdr(msg.subject || "")}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...textParts(msg),
  ];
  for (const a of msg.attachments || []){
    const n = fname(a.filename);
    lines.push(`--${boundary}`,
      `Content-Type: ${a.contentType || "application/pdf"}; name="${hdr(n)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${hdr(n)}"`,
      "", wrap76(b64(a.bytes)).trimEnd());
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

// Minimal SMTP client over an already-open TLS socket: {readable: ReadableStream<Uint8Array>, writable: WritableStream}.
export async function smtpSend(socket, {user, pass, from, rcpts, data, helo = "renewal-desk"}){
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let buf = "";
  const transcript = [];
  async function reply(){
    // A reply is one or more lines "NNN-text" ending with "NNN text".
    for (;;){
      const m = buf.match(/^(?:\d{3}-[^\n]*\n)*(\d{3})(?: [^\n]*)?\n/);
      if (m){ buf = buf.slice(m[0].length); transcript.push(m[0].trim()); return {code: +m[1], text: m[0].trim()}; }
      const {value, done} = await reader.read();
      if (done) throw new Error("SMTP connection closed" + (transcript.length ? `; last reply: ${transcript.at(-1)}` : ""));
      buf += dec.decode(value, {stream: true}).replace(/\r\n/g, "\n");
    }
  }
  const write = s => writer.write(enc.encode(s));
  async function cmd(line, ok, shown = line){
    await write(line + "\r\n");
    const r = await reply();
    if (!ok.includes(r.code)) throw new Error(`SMTP ${shown} -> ${r.text}`);
    return r;
  }
  try {
    const hello = await reply();
    if (hello.code !== 220) throw new Error("SMTP greeting -> " + hello.text);
    await cmd(`EHLO ${helo}`, [250]);
    await cmd("AUTH PLAIN " + b64(enc.encode(`\0${user}\0${pass}`)), [235], "AUTH");
    await cmd(`MAIL FROM:<${from}>`, [250]);
    for (const r of rcpts) await cmd(`RCPT TO:<${r}>`, [250, 251]);
    await cmd("DATA", [354]);
    // Dot-stuff lines that start with "." and end with <CRLF>.<CRLF>.
    const body = data.replace(/\r\n\./g, "\r\n..");
    const done = await cmd((body.startsWith(".") ? "." : "") + body + (body.endsWith("\r\n") ? "" : "\r\n") + ".", [250], "message");
    await write("QUIT\r\n").catch(() => {});
    return done.text;
  } finally {
    try { reader.releaseLock(); writer.releaseLock(); await socket.close?.(); } catch {}
  }
}

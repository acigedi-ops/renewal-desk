// POST /api/chat {messages}: one step of the Assistant chat (src/chat.js). The Worker adds the API key, the instructions and
// the tool list, sends the conversation to Claude and returns Claude's reply. The browser runs the tools itself on the data
// the app already has loaded, then calls this again with the results, so the Worker never reads or stores client data.
// The tools only look things up: nothing in the chat can send an email, a text or a link, or change any data.
// Secret, never in this repo: ANTHROPIC_API_KEY (copied from the Cloudflare BUILD variables by build.mjs on main builds).

const MODEL = "claude-opus-5-5";
const MAX_BODY = 600_000;

const SYSTEM = `You are the assistant inside Eduard Kaplun's Renewal Desk, the app he uses to run Rhino Insurance Group LLC (commercial insurance for Washington contractors: general liability, L&I bonds, certificates of insurance) and his Kaplun Financial side (quarterly taxes, "Qtax", for about 60 clients, and QuickBooks invoices).
Eduard types what he needs: a certificate (COI), an invoice, a client's policy, what is expiring, who still owes Qtax income, what is on his to-do list. Find it with the tools and answer.

How to answer:
- Look things up with the tools before answering; never guess a policy number, date, amount or holder. If the data doesn't have it, say so plainly.
- Keep answers short and plain, like a text from a capable assistant: lead with the answer, then the few details that matter (dates as "Jun 3, 2027", money as "$1,029.00"). No long preambles, no headings.
- Whenever you mention specific clients, certificates, documents or invoices, call the show tool with them, so Eduard gets buttons to open the client card, open the PDF or copy the invoice link. Show the few that answer the question, not everything you looked at.
- Reply in the language Eduard writes in.

What you can't do, and where to send him instead:
- You never send anything to anyone: no emails, texts or links. Eduard sends things himself. If he asks you to send something, show him the item so he can copy or open it, and say he sends it himself.
- You can't create or change data. New invoices are made in QuickBooks: tell him to ask in the "QuickBooks invoices on request" thread of his Rhino Tools project on Claude, with the client, what it's for and the amount. A new certificate is made with "+ Create COI" on the client's card. Emails to L&I and clients go through the Outbox tab, where he taps Approve.
- Invoices here are a copy synced from QuickBooks twice a day, so a very new invoice or payment may not be here yet.`;

// Read-only lookups. The browser (src/chat.js) runs them against the data it already has.
const TOOLS = [
  {name: "search", description: "Search everything in the Renewal Desk by name, phone, email, license number, UBI, policy number, certificate holder, invoice number or words in a description. Returns matching clients, certificates (COIs), documents, invoices, SOS businesses, Qtax people and to-dos, each with an id to look up or show. Pass names or numbers only, not whole sentences.",
    input_schema: {type: "object", properties: {query: {type: "string", description: "A name, number or a few key words, e.g. 'Proper Foundation' or 'TSGL5551271'"}}, required: ["query"], additionalProperties: false}},
  {name: "get_client", description: "Everything about one client: contact, L&I registration with insurance and bond, policies, certificates (COIs, each with its ref), documents, invoices for that business, SOS status, renewals, open to-dos and notes.",
    input_schema: {type: "object", properties: {id: {type: "string", description: "The client id from search (usually the L&I license number)"}}, required: ["id"], additionalProperties: false}},
  {name: "list_invoices", description: "QuickBooks invoices (synced copy). Filter by status and/or customer name.",
    input_schema: {type: "object", properties: {status: {type: "string", enum: ["unpaid", "paid", "overdue", "all"]}, customer: {type: "string", description: "Part of the customer name (optional)"}}, required: ["status"], additionalProperties: false}},
  {name: "expiring", description: "Policies, L&I insurance and bonds, L&I registrations and certificates that end within the next N days (or ended in the last N days when past is true), soonest first.",
    input_schema: {type: "object", properties: {days: {type: "integer", description: "How many days ahead (or back), e.g. 30"}, past: {type: "boolean", description: "true for ones that already ended in the last N days"}}, required: ["days"], additionalProperties: false}},
  {name: "list_tasks", description: "Eduard's to-do list (calls to return, texts to answer, carrier emails, Qtax, bills).",
    input_schema: {type: "object", properties: {status: {type: "string", enum: ["open", "done"]}, category: {type: "string", enum: ["client", "qtax", "insurer", "bills", "personal", "any"]}}, required: ["status"], additionalProperties: false}},
  {name: "qtax", description: "Quarterly tax (Qtax) clients and the income they reported for a quarter: who sent income, who hasn't, unclear replies, do-not-text.",
    input_schema: {type: "object", properties: {quarter: {type: "string", description: "Like 2026-Q3. Leave out for the latest quarter."}, name: {type: "string", description: "Part of a name or phone (optional)"}}, required: [], additionalProperties: false}},
  {name: "sos", description: "Washington Secretary of State status for businesses: active, delinquent, annual report due. Filter by name/UBI or by status.",
    input_schema: {type: "object", properties: {query: {type: "string", description: "Name or UBI (optional)"}, status: {type: "string", description: "e.g. DELINQUENT, ACTIVE, or 'ar_due_60' for annual reports due within 60 days (optional)"}}, required: [], additionalProperties: false}},
  {name: "show", description: "Show items to Eduard as buttons under your answer: a client card, a certificate PDF, a document, or an invoice with Copy link. Use the ids and refs the other tools returned.",
    input_schema: {type: "object", properties: {items: {type: "array", maxItems: 12, items: {type: "object", properties: {
      type: {type: "string", enum: ["client", "coi", "document", "invoice"]},
      id: {type: "string", description: "client id, document id or invoice id"},
      client_id: {type: "string", description: "for a coi: the client id"},
      ref: {type: "string", description: "for a coi: its ref from get_client or search"}},
      required: ["type"], additionalProperties: false}}}, required: ["items"], additionalProperties: false}}
];

const json = (status, body) => new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});

export async function chat(request, env, supabase){
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json(403, {error: "wrong origin"});
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, {error: "Sign in first."});
  const who = await supabase(env, token)("GET", "/auth/v1/user");
  if (!who.ok) return json(401, {error: "Sign in again."});
  if (!env.ANTHROPIC_API_KEY) return json(503, {error: "The assistant isn't connected yet: add the ANTHROPIC_API_KEY build variable in Cloudflare.", setup: true});

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, {error: "This chat got too long. Tap New chat and ask again."});
  let messages;
  try { ({messages} = JSON.parse(raw)); } catch { return json(400, {error: "bad request"}); }
  if (!Array.isArray(messages) || !messages.length || messages[0]?.role !== "user" || messages.some(m => !["user", "assistant"].includes(m?.role)))
    return json(400, {error: "bad request"});

  const today = new Date().toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"});
  const body = {
    model: MODEL, max_tokens: 16000,
    output_config: {effort: "low"},
    // Frozen instructions and tools first (cached); today's date goes last so it doesn't break the cache.
    system: [{type: "text", text: SYSTEM, cache_control: {type: "ephemeral"}}, {type: "text", text: `Today is ${today} (Pacific time).`}],
    tools: TOOLS, messages,
    fallbacks: "default"
  };
  const call = (b, beta) => fetch("https://api.anthropic.com/v1/messages", {method: "POST",
    headers: {"x-api-key": env.ANTHROPIC_API_KEY.trim(), "anthropic-version": "2023-06-01", "content-type": "application/json", ...(beta ? {"anthropic-beta": beta} : {})},
    body: JSON.stringify(b)});
  let r = await call(body, "server-side-fallback-2026-07-01");
  // If the fallback option is ever refused, ask again without it rather than failing the chat.
  if (r.status === 400 && /fallback/i.test(await r.clone().text())){ delete body.fallbacks; r = await call(body); }
  const out = await r.json().catch(() => ({}));
  if (!r.ok){
    const msg = out?.error?.message || `error ${r.status}`;
    if (r.status === 401) return json(502, {error: "Claude didn't accept the API key. Check ANTHROPIC_API_KEY in Cloudflare.", setup: true});
    if (r.status === 429 || r.status === 529) return json(503, {error: "Claude is busy right now. Try again in a minute."});
    return json(502, {error: "Claude couldn't answer: " + String(msg).slice(0, 300)});
  }
  return json(200, {content: out.content, stop_reason: out.stop_reason});
}

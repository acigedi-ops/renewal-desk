#!/usr/bin/env python3
"""Keep the Inbox and turn carrier emails that need action into urgent To do items.

Run right after the email check has written meta/status.inbox (the list of insurance and L&I emails found this run):
  1. Every inbox email is saved to mail/<id>, so the site's Inbox keeps it until Eduard taps Dismiss
     (the email check itself replaces meta.inbox on each run).
  2. Payment-failed, cancellation and non-renewal emails each get one urgent to-do, tasks/email-<id>
     (source "email", category "insurer"), linked to the client when the name or a policy number matches.
     A to-do Eduard marked done is never reopened, and nothing is ever sent.

  python3 tools/carrier_tasks.py [--dry-run]
The same <id> rule is in src/app.html (mailId), so the site and this script agree on which email is which.
"""
import datetime as dt, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rd  # noqa: E402

# What needs action, checked in this order on subject + summary. Bonds "until cancelled" are not a cancellation.
ACTIONS = [
    ("Payment problem", re.compile(r"payment (?:failed|declined|unsuccessful|was not|returned|reversed|problem)|unable to (?:process|collect|charge)|"
                                  r"card (?:was )?declined|insufficient funds|past[- ]due|missed (?:a )?payment|overdue|non-?payment|"
                                  r"(?:failed|declined|returned|missed) payment|payment (?:is )?due (?:now|today)|was due \w+ \d", re.I)),
    ("Non-renewal", re.compile(r"non-?renew|will not (?:be )?renew|not be(?:ing)? renewed|won't renew|decline(?:d)? to renew", re.I)),
    ("Cancellation", re.compile(r"(?<!until )\bcancel(?:l?ation|l?ed|ing|s)?\b|intent to cancel|lapse[ds]?\b|rescind", re.I)),
]
NOT_ACTION = re.compile(r"until cancel|quotes? (?:are )?still available|cancel(?:l?ation)? (?:has been )?(?:withdrawn|rescinded)|reinstat", re.I)


def mail_id(m):
    g = re.search(r"#[a-z]+/([0-9a-f]{10,})", m.get("link") or "", re.I)
    if g:
        return "g" + g.group(1).lower()
    return ("s-" + re.sub(r"[^a-z0-9]+", "-", f"{m.get('date') or ''}-{m.get('subject') or ''}".lower()))[:80]


def action_of(m):
    text = f"{m.get('subject') or ''} {m.get('summary') or ''}"
    if NOT_ACTION.search(text) and not re.search(r"non-?renew|payment (?:failed|declined)", text, re.I):
        return None
    for label, rx in ACTIONS:
        if rx.search(text):
            return label
    return None


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def core(s):
    """A business name without LLC / Inc / punctuation, for matching "Grad Construction" to "GRAD CONSTRUCTION LLC"."""
    return norm(re.sub(r"\b(?:llc|l\.l\.c|inc|corp|corporation|co|company|ltd|pllc|the)\b\.?", " ", str(s or ""), flags=re.I))


def match_client(m, clients):
    name = core(m.get("client"))
    if len(name) >= 4:
        hits = [c for c in clients if core(c["data"].get("name")) == name]
        if len(hits) == 1:
            return hits[0]
    text = norm(f"{m.get('subject') or ''} {m.get('summary') or ''}")
    for c in clients:
        d = c["data"]
        nums = [p.get("number") for p in d.get("policies") or []] + [x.get("policy") for x in d.get("cois") or []]
        nums += [((d.get("lni") or {}).get(k) or {}).get("number") for k in ("insurance", "bond")]
        if any(len(norm(n)) >= 6 and norm(n) in text for n in nums if n):
            return c
    return None


def main(argv):
    dry = "--dry-run" in argv
    status = rd.get_doc("meta", "status") or {}
    inbox = status.get("inbox") or []
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    saved = {r["id"]: r["data"] for r in rd.list_docs("mail")}
    tasks = {r["id"]: r["data"] for r in rd.list_docs("tasks") if r["id"].startswith("email-")}
    clients = rd.list_docs("clients") if inbox else []
    new_mail = new_tasks = 0
    for m in inbox:
        mid, act = mail_id(m), action_of(m)
        c = match_client(m, clients)
        if mid not in saved:
            doc = {**m, "status": "new", "first_seen": now, "action": act or "", "client_id": c["id"] if c else ""}
            new_mail += 1
            print(f"mail {mid}: {m.get('subject')!r}{' -> ' + act if act else ''}")
            if not dry:
                rd.set_doc("mail", mid, doc)
        tid = "email-" + mid
        if act and tid not in tasks:
            who = (c["data"].get("name") if c else None) or m.get("client") or m.get("from") or "Insurance company"
            detail = "\n".join(x for x in [m.get("summary"), f"From {m.get('from')}" if m.get("from") else "",
                                            f"Open in Gmail: {m['link']}" if m.get("link") else ""] if x)
            task = {"source": "email", "who": who, "phone": "", "email": m.get("from") or "", "client_id": c["id"] if c else "",
                    "title": f"{act}: {m.get('subject') or ''}"[:200], "detail": detail, "link": m.get("link") or "",
                    "category": "insurer", "urgent": True, "at": m.get("date") or now, "status": "open", "done_at": "",
                    "created_at": now, "created_by": "carrier_tasks"}
            new_tasks += 1
            print(f"task {tid}: {task['title']} [{task['who']}]")
            if not dry:
                rd.set_doc("tasks", tid, task)
    print(f"carrier emails: {len(inbox)} in inbox, {new_mail} newly saved, {new_tasks} new to-dos{' (dry run)' if dry else ''}")


if __name__ == "__main__":
    main(sys.argv[1:])

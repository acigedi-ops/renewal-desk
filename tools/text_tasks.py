#!/usr/bin/env python3
"""Turn a twice-daily text scan (textscan/<slot>, uploaded by the Mac texter) into To do items (tasks/<id>).

  text_tasks.py pending                 print the unprocessed scans as JSON (slot, chats with their last messages)
  text_tasks.py apply SLOT DECISIONS    write tasks from DECISIONS.json, then erase the message text from textscan/SLOT

DECISIONS.json is a list, one entry per chat in the scan that Eduard still owes a reply or action on (leave out thanks, OKs,
ads, codes and family chats):
  {"chat": <index in the scan's chats>, "title": "what he needs to do", "detail": "their ask in a line, quoting key words",
   "category": "client"|"qtax"|"insurer"|"bills"|"personal", "urgent": true|false}
One task per person (per group chat): an open task gets the newer details, a task marked done reopens only for a message
that came after it was done.
"""
import hashlib, json, re, sys
from datetime import datetime, timezone
from rd import get_doc, list_docs, set_doc, update_doc


def key(c):
    if c.get("group"):
        hs = sorted(p["handle"] for p in c.get("people", []))
        return "text-group-" + hashlib.sha1("|".join(hs).encode()).hexdigest()[:10]
    hd = c["people"][0]["handle"]
    d = re.sub(r"\D", "", hd)
    return "text-" + (d[-10:] if len(d) >= 10 else re.sub(r"[^A-Za-z0-9]", "_", hd))


def pending():
    scans = [s for s in list_docs("textscan") if s["data"].get("status") == "new"]
    print(json.dumps([{"slot": s["id"], "from": s["data"]["from"], "to": s["data"]["to"],
                       "chats": [dict(c, index=i) for i, c in enumerate(s["data"].get("chats", []))]} for s in scans],
                     ensure_ascii=False, indent=1))


def apply(slot, path):
    scan = get_doc("textscan", slot)
    if not scan or scan.get("status") != "new":
        raise SystemExit(f"textscan/{slot} is missing or already processed")
    chats, now = scan.get("chats", []), datetime.now(timezone.utc).isoformat()
    added = updated = 0
    for d in json.load(open(path)):
        c = chats[d["chat"]]
        tid = key(c)
        last_in = max((m["at"] for m in c["messages"] if m["from"] != "Eduard"), default=now)
        p0 = c["people"][0] if c["people"] else {}
        who = c.get("title") or ", ".join(p.get("name") or p["handle"] for p in c["people"])
        phone = "" if c.get("group") or "@" in p0.get("handle", "") else p0.get("handle", "")
        task = {"source": "text", "who": who, "phone": phone, "title": d["title"], "detail": d.get("detail", ""),
                "category": d.get("category", "client"), "urgent": bool(d.get("urgent")), "at": last_in,
                "status": "open", "done_at": "", "created_by": "routine", "slot": slot}
        old = get_doc("tasks", tid)
        if old is None:
            set_doc("tasks", tid, dict(task, created_at=now)); added += 1
        elif old.get("status") != "done" or last_in > (old.get("done_at") or ""):
            update_doc("tasks", tid, task); updated += 1
    # The scan held message text only so it could be read here; keep just the counts.
    set_doc("textscan", slot, {"slot": slot, "from": scan["from"], "to": scan["to"], "status": "processed",
                                "processed_at": now, "chats": len(chats), "tasks_added": added, "tasks_updated": updated})
    print(json.dumps({"slot": slot, "added": added, "updated": updated}))


if __name__ == "__main__":
    if sys.argv[1:2] == ["pending"]:
        pending()
    elif sys.argv[1:2] == ["apply"] and len(sys.argv) == 4:
        apply(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(__doc__)

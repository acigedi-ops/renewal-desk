#!/usr/bin/env python3
"""Queue prefilled emails in the Renewal Desk Outbox (collection `outbox`) from a routine run.

Nothing is sent from here: Eduard reviews each email on the site and taps "Approve & send".
Templates match src/outbox.js. Run in a session on the "lni" environment (needs SUPABASE_SECRET_KEY, see rd.py).

  outbox.py welcome CLIENT_ID --pdf FILE [--pdf FILE ...] [--to EMAIL] [--source TEXT]
      Welcome email to a new client with their documents. If one is still waiting in the Outbox, the new PDFs are
      added to it; if one was already sent or dismissed, nothing happens. --to defaults to the client's contact email.
  outbox.py bond CLIENT_ID --pdf FILE [--pdf FILE ...] [--source TEXT]
      "NEW BOND" email to L&I. Skipped if the same file name was already queued for that client.
  outbox.py list                      show what is waiting
"""
import argparse, datetime, json, pathlib, re, sys, uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from rd import get_doc, list_docs, set_doc, update_doc, upload  # noqa: E402

LNI_TO = "tukwila@lni.wa.gov"
SIGNATURE = "--\nEduard Kaplun\nFounder\nRhino Insurance Group LLC\n(253)-335-9649\nEduard@rhino.insure\nrhinoinsuranceco.com"


def ubi_fmt(u):
    d = re.sub(r"\D", "", str(u or ""))
    return f"{d[:3]} {d[3:6]} {d[6:]}" if len(d) == 9 else str(u or "")


def template(kind, c, to=None):
    if kind == "lni_bond":
        return {"to": [LNI_TO], "cc": [], "subject": f"NEW BOND - {c['name']} - {c['license']}",
                "body": f"Hello please update the bond for this client. Bond is attached below.\n\n"
                        f"Business Name - {c['name']}\nUBI - {ubi_fmt(c.get('ubi'))}\nLNI# - {c['license']}\n\n{SIGNATURE}"}
    first = (str((c.get("contact") or {}).get("name") or "").split() or ["there"])[0]
    email = to or (c.get("contact") or {}).get("email") or ""
    return {"to": [e for e in re.split(r"[,;\s]+", email) if e], "cc": [],
            "subject": f"Welcome to Rhino Insurance Group - {c['name']}",
            "body": f"Hi {first},\n\nWelcome to Rhino Insurance Group, and thank you for trusting us with {c['name']}! Your documents are attached:\n\n"
                    f"- Certificate of insurance (liability)\n- Contractor bond\n\nPlease keep them for your records. We keep an eye on your L&I "
                    f"registration, insurance and bond, and we will reach out before anything renews. If you need a certificate for a job or have "
                    f"any questions, just reply to this email or call us.\n\nThank you,\n\n{SIGNATURE}"}


def store(pdfs):
    out = []
    for p in pdfs:
        p = pathlib.Path(p)
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", p.name)
        out.append({"file": p.name, "url": upload(p, f"{uuid.uuid4()}/{name}"),
                    "uploaded_at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    return out


def queue(kind, client_id, pdfs, to=None, source=""):
    c = get_doc("clients", client_id)
    if not c:
        raise SystemExit(f"no client {client_id}")
    c.setdefault("license", client_id)
    mine = [r["data"] for r in list_docs("outbox") if r["data"].get("client_id") == client_id and r["data"].get("kind") == kind]
    if kind == "welcome" and mine:
        # Insurance and bond often arrive in separate emails: add later documents to a welcome email that's still waiting.
        rows = {r["id"]: r["data"] for r in list_docs("outbox")}
        oid = next((i for i, d in rows.items() if d.get("client_id") == client_id and d.get("kind") == kind and d.get("status") == "pending"), None)
        if not oid:
            print(f"skip: {client_id} already has a welcome email ({mine[0].get('status')})")
            return None
        have = {a.get("file") for a in rows[oid].get("attachments", [])}
        new = [p for p in pdfs if pathlib.Path(p).name not in have]
        if new:
            update_doc("outbox", oid, {"attachments": rows[oid].get("attachments", []) + store(new)})
        print(f"added {len(new)} document(s) to waiting outbox/{oid}")
        return oid
    if kind == "lni_bond":
        names = {pathlib.Path(p).name for p in pdfs}
        if any(names & {a.get("file") for a in m.get("attachments", [])} for m in mine):
            print(f"skip: bond {sorted(names)} already queued for {client_id}")
            return None
    atts = store(pdfs)
    if kind == "lni_bond":
        update_doc("clients", client_id, {"bond_files": (c.get("bond_files") or []) + atts})
    now = datetime.datetime.now(datetime.timezone.utc)
    oid = f"{kind}-{re.sub(r'[^A-Za-z0-9_-]', '_', client_id)}-{int(now.timestamp() * 1000)}"
    set_doc("outbox", oid, {"kind": kind, "client_id": client_id, "client_name": c.get("name", ""), **template(kind, c, to),
                            "attachments": atts, "status": "pending", "created_at": now.isoformat(),
                            "created_by": "routine", "source": source})
    print(f"queued outbox/{oid}")
    return oid


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["welcome", "bond", "list"])
    ap.add_argument("client_id", nargs="?")
    ap.add_argument("--pdf", action="append", default=[])
    ap.add_argument("--to")
    ap.add_argument("--source", default="")
    a = ap.parse_args()
    if a.cmd == "list":
        for r in list_docs("outbox"):
            d = r["data"]
            if d.get("status") in ("pending", "failed", "sending"):
                print(json.dumps({"id": r["id"], "status": d["status"], "subject": d.get("subject"), "to": d.get("to")}))
        return
    if not a.client_id or not a.pdf:
        ap.error("CLIENT_ID and at least one --pdf are required")
    queue("welcome" if a.cmd == "welcome" else "lni_bond", a.client_id, a.pdf, a.to, a.source)


if __name__ == "__main__":
    main()

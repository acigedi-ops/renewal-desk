#!/usr/bin/env python3
"""Copy unpaid QuickBooks invoices into the Renewal Desk's `invoices` collection for the Invoices tab.

The website can't reach QuickBooks, so a Claude session with the Intuit QuickBooks connector fetches invoices
(qbo_sales_get_invoices, order_by "Balance DESC", a wide date range) and saves the JSON result to a file; this script reads it:

  invoices_sync.py RESULT.json          upsert every invoice with a balance; mark ones no longer owed as paid
  invoices_sync.py RESULT.json --dry    print what would change

Doc invoices/<txn id>: {number, customer, customer_id, amount, balance, due, date, description, link, share_link,
status: "unpaid"|"paid", paid_at, synced_at}. `link` opens the invoice in Eduard's QuickBooks; nothing here sends anything.
"""
import json, sys
from datetime import datetime, timezone
from rd import list_docs, set_doc, update_doc


def num(v):
    try:
        return round(float(v or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def doc_of(inv, now):
    lines = [l.get("description", "").strip() for l in inv.get("lines", []) if "id" in l]
    c = inv.get("contact") or {}
    return {
        "number": inv.get("reference_number") or "",
        "customer": c.get("display_name") or "",
        "customer_id": c.get("id") or "",
        "amount": num(inv.get("amount")),
        "balance": num(inv.get("balance_amount")),
        "due": inv.get("due_date") or "",
        "date": inv.get("txn_date") or "",
        "description": "; ".join(d for d in lines if d),
        "link": inv.get("link") or "",
        "share_link": inv.get("share_link") or "",
        "status": "unpaid" if num(inv.get("balance_amount")) > 0 else "paid",
        "synced_at": now,
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry" in sys.argv
    data = json.load(open(args[0]))
    if data.get("status") != "success":
        raise SystemExit(f"QuickBooks result is not a success: {data.get('error')}")
    invs = data.get("data") or []
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    fetched = {str(i["id"]).rsplit(":", 1)[-1]: doc_of(i, now) for i in invs}
    unpaid = {k: d for k, d in fetched.items() if d["status"] == "unpaid"}
    # Only a list that runs past the last unpaid invoice proves the rest are paid.
    complete = any(d["status"] == "paid" for d in fetched.values())
    known = {d["id"]: d["data"] for d in list_docs("invoices")}
    for k, d in unpaid.items():
        print("unpaid", d["number"], d["customer"], d["balance"])
        if not dry:
            set_doc("invoices", k, d)
    for k, old in known.items():
        if old.get("status") != "unpaid" or k in unpaid:
            continue
        if k in fetched or complete:
            print("paid", old.get("number"), old.get("customer"))
            if not dry:
                update_doc("invoices", k, {"status": "paid", "balance": 0, "paid_at": now, "synced_at": now})
        else:
            print("not checked (list too short):", old.get("number"))
    print(f"{len(unpaid)} unpaid; list {'complete' if complete else 'may be incomplete'}")


if __name__ == "__main__":
    main()

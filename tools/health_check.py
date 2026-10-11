#!/usr/bin/env python3
"""Nightly health check: turns anything that stopped running into an urgent item on the To do tab.

Same thresholds as the app's health strip (src/health.js). One task per problem per day (tasks/health-<kind>-<date>),
closed automatically the next time that thing is back on time. Prints one line per problem.

  python3 tools/health_check.py
"""
import datetime as dt, os, sys
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rd  # noqa: E402

H = 3600
LATE = {"lni": 16 * H, "mail": 16 * H, "sos": 8 * 24 * H, "mac": 2 * H, "backup": 30 * H}
WHAT = {"lni": "The L&I check hasn't run. L&I statuses on the site may be out of date.",
        "mail": "The email check hasn't run.",
        "sos": "The weekly SOS check hasn't run.",
        "mac": "Your Mac texter isn't checking in: texts, replies, missed calls and callbacks are on hold until the Mac is on and awake.",
        "backup": "The nightly backup hasn't run."}


def get(col, id_):
    rows = rd._req("GET", f"/rest/v1/docs?select=data&collection=eq.{col}&id=eq.{id_}")
    return (rows[0]["data"] if rows else {}) or {}


def age(iso):
    if not iso:
        return None
    t = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (dt.datetime.now(dt.timezone.utc) - t).total_seconds()


def main():
    lni = max(((r["data"].get("lni") or {}).get("checked_at") or "" for r in rd.list_docs("clients")), default="")
    seen = {"lni": lni, "mail": get("meta", "status").get("checked_at"), "sos": get("sosmeta", "status").get("checked_at"),
            "mac": get("qtaxmeta", "mac").get("seen_at"), "backup": get("meta", "backup").get("at")}
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    day = dt.datetime.now(ZoneInfo("America/Los_Angeles")).date().isoformat()
    open_tasks = {r["id"]: r["data"] for r in rd.list_docs("tasks") if r["id"].startswith("health-") and r["data"].get("status") == "open"}
    for k, at in seen.items():
        a = age(at)
        if a is None or a > LATE[k]:
            tid = f"health-{k}-{day}"
            if tid not in open_tasks:
                rd.set_doc("tasks", tid, {"source": "health", "who": "Renewal Desk", "title": WHAT[k], "detail": f"Last seen: {at or 'never'}",
                                          "category": "personal", "urgent": True, "at": now, "status": "open", "created_at": now, "created_by": "routine"})
            print(f"LATE {k}: last {at or 'never'}")
        else:
            for tid in [t for t in open_tasks if t.startswith(f"health-{k}-")]:
                rd.update_doc("tasks", tid, {"status": "done", "done_at": now})
    print("health check done")


if __name__ == "__main__":
    main()

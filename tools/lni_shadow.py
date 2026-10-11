#!/usr/bin/env python3
"""L&I check as a plain script (no Claude), run in SHADOW mode next to the L&I routine.

It builds the same `lni` field the routine writes for every licensed client, straight from L&I's open data on data.wa.gov,
then compares it with what the routine last saved. It never changes a client: it only writes one report doc,
meta/lni_shadow {at, compared, same, differ: [{id, name, field, saved, script}], ...}. Once that report has matched for
a while, the routine's L&I steps can switch to this script (Eduard decides).

  python3 tools/lni_shadow.py            # fetch, compare, write meta/lni_shadow
  python3 tools/lni_shadow.py --dry-run  # print the summary only

Needs SUPABASE_SECRET_KEY (see rd.py). The L&I logic mirrors /mnt/project-files/lni-renewals/lni_check.py and to_app_docs.py.
"""
import datetime as dt, json, os, sys, urllib.parse, urllib.request
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rd import list_docs, set_doc  # noqa: E402

DATASETS = {"general": "m8qx-ubtq", "insurance": "ciwg-agsx", "bond": "bzff-4fmt"}
FAR_FUTURE = dt.date(2200, 1, 1)


def parse_date(v):
    if not v or not isinstance(v, str):
        return None
    v = v.strip()
    if v.lower().startswith("until"):
        return FAR_FUTURE
    for f in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            d = dt.datetime.strptime(v, f).date()
            return FAR_FUTURE if d.year > 2150 else d   # L&I uses 2723-01-01 as "no cancel"
        except ValueError:
            pass
    return None


def fmt(d):
    return "" if d is None else "until cancelled" if d == FAR_FUTURE else d.isoformat()


def fetch(dataset, licenses):
    rows = []
    for i in range(0, len(licenses), 40):
        where = "contractorlicensenumber in(" + ",".join("'%s'" % l.replace("'", "''") for l in licenses[i:i + 40]) + ")"
        url = "https://data.wa.gov/resource/%s.json?%s" % (DATASETS[dataset], urllib.parse.urlencode({"$where": where, "$limit": 5000}))
        with urllib.request.urlopen(url, timeout=60) as r:
            rows += json.load(r)
    return rows


def coverage(rows, kind, today):
    p = "bond" if kind == "bond" else ""
    items = []
    for r in rows:
        eff = parse_date(r.get(p + "effectivedate"))
        exp = parse_date(r.get(p + "expirationdate")) or FAR_FUTURE
        cancel = parse_date(r.get(p + "canceldate"))
        items.append({"carrier": (r.get("insurancecompany") or r.get("bondfirmname") or "").strip(),
                      "number": (r.get("insurancepolicyno") or r.get("bondaccountid") or "").strip(),
                      "amount": r.get("insuranceamt") or r.get("bondamt") or "",
                      "agency": (r.get("insuranceagencyname") or "").strip(),
                      "effective": eff, "expiration": exp, "cancel": cancel if cancel and cancel < exp else None,
                      "end": min(exp, cancel) if cancel else exp})
    live = [x for x in items if x["end"] > today]
    if not live:
        return None
    cur = max(live, key=lambda x: (x["end"], x["effective"] or dt.date.min))
    out = {"carrier": cur["carrier"], "number": cur["number"], "amount": str(cur["amount"]).split(".")[0],
           "effective": fmt(cur["effective"]), "expiration": fmt(cur["expiration"]), "cancel": fmt(cur["cancel"]) or None,
           "until": fmt(cur["end"])}
    if kind == "insurance":
        out["agency"] = cur["agency"]
    return out


def lni_for(lic, by, today):
    g = (by["general"].get(lic) or [{}])[0]
    return {"registration": {"status": g.get("contractorlicensestatus"), "expires": fmt(parse_date(g.get("licenseexpirationdate"))),
                             "suspended": fmt(parse_date(g.get("contractorlicensesuspenddate"))) or None},
            "insurance": coverage(by["insurance"].get(lic, []), "insurance", today),
            "bond": coverage(by["bond"].get(lic, []), "bond", today)}


def flat(x, pre=""):
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            out.update(flat(v, f"{pre}{k}."))
        return out
    return {pre[:-1]: "" if x is None else str(x)}


def main():
    dry = "--dry-run" in sys.argv
    today = dt.datetime.now(ZoneInfo("America/Los_Angeles")).date()
    clients = [(r["id"], r["data"]) for r in list_docs("clients") if (r["data"].get("license") or "").strip()]
    lics = sorted({c["license"].strip().upper() for _, c in clients})
    by = {}
    for k in DATASETS:
        by[k] = {}
        for r in fetch(k, lics):
            by[k].setdefault(r["contractorlicensenumber"].upper(), []).append(r)
    same, differ = 0, []
    for cid, c in clients:
        saved = {k: v for k, v in (c.get("lni") or {}).items() if k != "checked_at"}
        mine = lni_for(c["license"].strip().upper(), by, today)
        a, b = flat(saved), flat(mine)
        keys = sorted(k for k in set(a) | set(b) if a.get(k, "") != b.get(k, ""))
        if not keys:
            same += 1
        for k in keys:
            differ.append({"id": cid, "name": c.get("name", ""), "field": k, "saved": a.get(k, ""), "script": b.get(k, "")})
    report = {"at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "compared": len(clients), "same": same,
              "clients_differ": len({d["id"] for d in differ}), "differ": differ[:60], "differ_total": len(differ),
              "note": "Shadow L&I check: compares the script's result with what the routine saved. It never changes clients."}
    print(f"shadow L&I: {same}/{len(clients)} clients identical, {report['clients_differ']} differ ({len(differ)} fields)")
    if not dry:
        set_doc("meta", "lni_shadow", report)


if __name__ == "__main__":
    main()
